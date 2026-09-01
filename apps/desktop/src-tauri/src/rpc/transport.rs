//! Framed JSON transport used by the shell/host sidecar boundary.
//!
//! The wire format is deliberately small and independent of an async runtime:
//! `0x1e` + decimal UTF-8 byte length + `:` + JSON bytes + `\n`.  A decoder is
//! fed arbitrary byte chunks and emits complete frames, recoverable resync
//! errors, or a terminal close event for a limit violation.

use std::io::{self, Read, Write};

use serde::Serialize;
use thiserror::Error;

use super::protocol::{MAX_FRAME_BYTES, MAX_NESTING_DEPTH};

/// The record separator that starts every frame.
pub const RECORD_SEPARATOR: u8 = 0x1e;
/// The newline that terminates every frame.
pub const FRAME_TERMINATOR: u8 = b'\n';

/// A decoded frame.  `json` is guaranteed to be valid UTF-8; JSON syntax and
/// RPC envelope validation remain the peer's responsibility.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodedFrame {
    /// The JSON text between the length prefix and newline.
    pub json: String,
}

impl DecodedFrame {
    #[must_use]
    pub fn as_bytes(&self) -> &[u8] {
        self.json.as_bytes()
    }
}

/// Recoverable or terminal framing failures.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum TransportError {
    #[error("invalid frame header")]
    InvalidHeader,
    #[error("frame length is not a decimal integer")]
    InvalidLength,
    #[error("frame length {observed} exceeds maximum {maximum}")]
    Oversized { observed: usize, maximum: usize },
    #[error("frame length mismatch: expected {expected} bytes, received {observed}")]
    LengthMismatch { expected: usize, observed: usize },
    #[error("frame is not valid UTF-8")]
    InvalidUtf8,
    #[error("frame is not valid JSON: {message}")]
    MalformedJson { message: String },
    #[error("frame nesting exceeds maximum depth {maximum}")]
    TooDeep { maximum: usize },
    #[error("unframed bytes before record separator")]
    UnframedBytes,
    #[error("transport is closed")]
    Closed,
}

/// Output from [`FrameDecoder::feed`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DecoderEvent {
    /// A complete, UTF-8 and syntactically valid JSON frame.
    Frame(DecodedFrame),
    /// Input was discarded and decoding can continue at the next separator.
    Resynchronized(TransportError),
    /// A protocol limit was exceeded and the decoder must be closed.
    Closed(TransportError),
}

/// Events produced by [`StdioFramePump::read_once`].
///
/// `Frame` and `Resynchronized` preserve the decoder's recoverable events.
/// `Closed` is terminal for a protocol limit violation; `Eof` is terminal for
/// a clean input-side EOF.  A trailing partial frame is reported as a
/// `Resynchronized` event immediately before `Eof`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FramePumpEvent {
    /// A complete, UTF-8 and syntactically valid JSON frame.
    Frame(DecodedFrame),
    /// Input was discarded and decoding can continue at the next separator.
    Resynchronized(TransportError),
    /// The decoder closed the transport after a protocol limit violation.
    Closed(TransportError),
    /// The injected reader reached EOF and no more frames can arrive.
    Eof,
}

/// Errors returned by the blocking frame pump.
#[derive(Debug, Error)]
pub enum FramePumpError {
    /// The injected reader or writer failed.
    #[error("stdio transport I/O failed: {0}")]
    Io(#[from] io::Error),
    /// JSON could not be encoded as a canonical frame.
    #[error("frame encoding failed: {0}")]
    Transport(#[from] TransportError),
    /// The pump has observed EOF or a terminal protocol/I/O failure.
    #[error("stdio transport is closed")]
    Closed,
}

/// A blocking, runtime-agnostic framed stdio pump.
///
/// The reader and writer are injected so the exact same pump can be exercised
/// with chunked/short test doubles or connected to a child process's stdio.
/// The writer is intentionally private: callers can only emit canonical
/// length-prefixed JSON frames through [`Self::send_json`] or [`Self::send`],
/// so unframed stdout bytes cannot take over the RPC stream.
pub struct StdioFramePump<R, W> {
    reader: R,
    writer: W,
    decoder: FrameDecoder,
    read_buffer: [u8; STDIO_READ_BUFFER_BYTES],
    closed: bool,
}

/// Read chunk size used by [`StdioFramePump`].
pub const STDIO_READ_BUFFER_BYTES: usize = 16 * 1024;

impl<R, W> StdioFramePump<R, W>
where
    R: Read,
    W: Write,
{
    /// Creates a pump over an injected blocking reader and writer.
    #[must_use]
    pub fn new(reader: R, writer: W) -> Self {
        Self {
            reader,
            writer,
            decoder: FrameDecoder::new(),
            read_buffer: [0; STDIO_READ_BUFFER_BYTES],
            closed: false,
        }
    }

    /// Returns whether input EOF or a terminal transport error has been seen.
    #[must_use]
    pub const fn is_closed(&self) -> bool {
        self.closed
    }

    /// Reads one blocking chunk and decodes every complete event it contains.
    ///
    /// `Interrupted` reads are retried because they do not indicate a
    /// transport failure.  A zero-byte read emits `Eof` (and any trailing
    /// partial-frame resynchronization event) exactly once.
    pub fn read_once(&mut self) -> Result<Vec<FramePumpEvent>, FramePumpError> {
        if self.closed {
            return Ok(Vec::new());
        }

        let read = loop {
            match self.reader.read(&mut self.read_buffer) {
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                result => break result,
            }
        }?;

        if read == 0 {
            let events = self
                .decoder
                .finish()
                .into_iter()
                .map(Self::map_decoder_event)
                .chain(std::iter::once(FramePumpEvent::Eof))
                .collect();
            self.closed = true;
            return Ok(events);
        }

        let events = self
            .decoder
            .feed(&self.read_buffer[..read])
            .into_iter()
            .map(Self::map_decoder_event)
            .collect::<Vec<_>>();
        if events
            .iter()
            .any(|event| matches!(event, FramePumpEvent::Closed(_)))
        {
            self.closed = true;
        }
        Ok(events)
    }

    /// Sends one JSON text value as an exact canonical frame.
    ///
    /// `write_all` handles short writes and `flush` makes the frame visible to
    /// a child process without relying on a runtime-specific buffering policy.
    pub fn send_json(&mut self, json: &str) -> Result<(), FramePumpError> {
        let frame = encode_json(json)?;
        self.send_encoded(&frame)
    }

    /// Serializes and sends one value as an exact canonical frame.
    pub fn send<T: Serialize>(&mut self, value: &T) -> Result<(), FramePumpError> {
        let frame = encode(value)?;
        self.send_encoded(&frame)
    }

    fn send_encoded(&mut self, frame: &[u8]) -> Result<(), FramePumpError> {
        if self.closed {
            return Err(FramePumpError::Closed);
        }
        if let Err(error) = self
            .writer
            .write_all(frame)
            .and_then(|()| self.writer.flush())
        {
            self.closed = true;
            return Err(FramePumpError::Io(error));
        }
        Ok(())
    }

    fn map_decoder_event(event: DecoderEvent) -> FramePumpEvent {
        match event {
            DecoderEvent::Frame(frame) => FramePumpEvent::Frame(frame),
            DecoderEvent::Resynchronized(error) => FramePumpEvent::Resynchronized(error),
            DecoderEvent::Closed(error) => FramePumpEvent::Closed(error),
        }
    }
}

/// A bounded streaming decoder for the record-separated frame format.
#[derive(Debug, Default)]
pub struct FrameDecoder {
    buffer: Vec<u8>,
    closed: bool,
    close_reason: Option<TransportError>,
}

impl FrameDecoder {
    /// Creates an empty decoder.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Returns whether a terminal transport error has closed this decoder.
    #[must_use]
    pub const fn is_closed(&self) -> bool {
        self.closed
    }

    /// Returns the terminal error, if any.
    #[must_use]
    pub fn close_reason(&self) -> Option<&TransportError> {
        self.close_reason.as_ref()
    }

    /// Feeds an arbitrary byte chunk and returns all complete decoder events.
    ///
    /// A partial frame is retained until a later call.  Recoverable malformed
    /// input is discarded through the next record separator.  Oversized and
    /// over-deep frames close the transport because there is no safe bounded
    /// recovery point for those inputs.
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<DecoderEvent> {
        if self.closed {
            return Vec::new();
        }
        self.buffer.extend_from_slice(bytes);
        let mut events = Vec::new();

        loop {
            if self.buffer.is_empty() {
                break;
            }

            let Some(separator) = self
                .buffer
                .iter()
                .position(|byte| *byte == RECORD_SEPARATOR)
            else {
                // Keep no more than a header-sized tail when no separator is
                // present.  This prevents console/log takeover bytes from
                // growing the decoder without bound while still allowing a
                // separator split across chunks (the separator is one byte,
                // so no tail is required for it).
                events.push(DecoderEvent::Resynchronized(TransportError::UnframedBytes));
                self.buffer.clear();
                break;
            };

            if separator > 0 {
                self.buffer.drain(..separator);
                events.push(DecoderEvent::Resynchronized(TransportError::UnframedBytes));
            }

            // We have a record separator at index zero.  The header is ASCII
            // decimal digits followed by a colon.  Waiting for more bytes is
            // important when a chunk splits the header itself.
            let Some(colon) = self.buffer.iter().position(|byte| *byte == b':') else {
                if self.buffer.len() > MAX_LENGTH_HEADER_BYTES {
                    events.push(self.resync(TransportError::InvalidHeader));
                }
                break;
            };
            if colon == 1 {
                events.push(self.resync(TransportError::InvalidLength));
                continue;
            }
            if colon > MAX_LENGTH_HEADER_BYTES {
                events.push(self.resync(TransportError::InvalidHeader));
                continue;
            }

            let length_bytes = &self.buffer[1..colon];
            if !length_bytes.iter().all(u8::is_ascii_digit) {
                events.push(self.resync(TransportError::InvalidLength));
                continue;
            }
            let length_text = match std::str::from_utf8(length_bytes) {
                Ok(text) => text,
                Err(_) => {
                    events.push(self.resync(TransportError::InvalidLength));
                    continue;
                }
            };
            let expected = match length_text.parse::<usize>() {
                Ok(value) => value,
                Err(_) => {
                    events.push(self.resync(TransportError::InvalidLength));
                    continue;
                }
            };
            let maximum = usize::try_from(MAX_FRAME_BYTES).unwrap_or(usize::MAX);
            if expected > maximum {
                let error = TransportError::Oversized {
                    observed: expected,
                    maximum,
                };
                events.push(self.close(error));
                break;
            }

            let body_start = colon + 1;
            let body_end = match body_start.checked_add(expected) {
                Some(end) => end,
                None => {
                    events.push(self.close(TransportError::Oversized {
                        observed: usize::MAX,
                        maximum,
                    }));
                    break;
                }
            };
            let required = match body_end.checked_add(1) {
                Some(end) => end,
                None => {
                    events.push(self.close(TransportError::Oversized {
                        observed: usize::MAX,
                        maximum,
                    }));
                    break;
                }
            };

            if self.buffer.len() < required {
                // If a newline appeared before the declared body end, the
                // frame is definitely mismatched and can be resynchronized.
                if let Some(newline) = self.buffer[body_start..]
                    .iter()
                    .position(|byte| *byte == FRAME_TERMINATOR)
                {
                    let observed = newline;
                    events.push(self.resync(TransportError::LengthMismatch { expected, observed }));
                    continue;
                }
                break;
            }

            if self.buffer[body_end] != FRAME_TERMINATOR {
                // A body containing a newline cannot be a valid JSON frame in
                // this line-delimited format.  Report the observed bytes up to
                // the first newline and seek the next separator.
                let observed = self.buffer[body_start..]
                    .iter()
                    .position(|byte| *byte == FRAME_TERMINATOR)
                    .unwrap_or(expected);
                events.push(self.resync(TransportError::LengthMismatch { expected, observed }));
                continue;
            }

            let body = &self.buffer[body_start..body_end];
            if let Err(error) = validate_json_bytes(body) {
                match error {
                    TransportError::TooDeep { .. } => {
                        events.push(self.close(error));
                        break;
                    }
                    other => {
                        events.push(self.resync(other));
                        continue;
                    }
                }
            }

            let json = match std::str::from_utf8(body) {
                Ok(json) => json.to_owned(),
                Err(_) => {
                    events.push(self.resync(TransportError::InvalidUtf8));
                    continue;
                }
            };

            if let Err(error) = serde_json::from_str::<serde_json::Value>(&json) {
                events.push(self.resync(TransportError::MalformedJson {
                    message: error.to_string(),
                }));
                continue;
            }

            self.buffer.drain(..required);
            events.push(DecoderEvent::Frame(DecodedFrame { json }));
        }
        events
    }

    /// Marks the input side closed.  A trailing partial frame is reported as a
    /// recoverable resync error; no frame can be emitted after EOF.
    pub fn finish(&mut self) -> Vec<DecoderEvent> {
        if self.closed || self.buffer.is_empty() {
            return Vec::new();
        }
        let has_separator = self.buffer.contains(&RECORD_SEPARATOR);
        self.buffer.clear();
        vec![DecoderEvent::Resynchronized(if has_separator {
            TransportError::LengthMismatch {
                expected: 0,
                observed: 0,
            }
        } else {
            TransportError::UnframedBytes
        })]
    }

    fn resync(&mut self, error: TransportError) -> DecoderEvent {
        // Discard through the current separator.  If the malformed frame is
        // followed by another separator, preserve that separator for the next
        // parse attempt.
        let next = self.buffer[1..]
            .iter()
            .position(|byte| *byte == RECORD_SEPARATOR)
            .map(|offset| offset + 1);
        match next {
            Some(index) => {
                self.buffer.drain(..index);
            }
            None => self.buffer.clear(),
        }
        DecoderEvent::Resynchronized(error)
    }

    fn close(&mut self, error: TransportError) -> DecoderEvent {
        self.closed = true;
        self.close_reason = Some(error.clone());
        self.buffer.clear();
        DecoderEvent::Closed(error)
    }
}

/// Upper bound for the decimal length prefix.  It is intentionally small so
/// malformed input cannot make the decoder scan an unbounded header.
const MAX_LENGTH_HEADER_BYTES: usize = 20;

/// Encodes JSON text into one canonical wire frame.
pub fn encode_json(json: &str) -> Result<Vec<u8>, TransportError> {
    validate_json_bytes(json.as_bytes())?;
    serde_json::from_str::<serde_json::Value>(json).map_err(|error| {
        TransportError::MalformedJson {
            message: error.to_string(),
        }
    })?;
    let bytes = json.as_bytes();
    let maximum = usize::try_from(MAX_FRAME_BYTES).unwrap_or(usize::MAX);
    if bytes.len() > maximum {
        return Err(TransportError::Oversized {
            observed: bytes.len(),
            maximum,
        });
    }
    let mut frame = Vec::with_capacity(bytes.len().saturating_add(32));
    frame.push(RECORD_SEPARATOR);
    frame.extend_from_slice(bytes.len().to_string().as_bytes());
    frame.push(b':');
    frame.extend_from_slice(bytes);
    frame.push(FRAME_TERMINATOR);
    Ok(frame)
}

/// Serializes and frames a JSON value.
pub fn encode<T: Serialize>(value: &T) -> Result<Vec<u8>, TransportError> {
    let json = serde_json::to_string(value).map_err(|error| TransportError::MalformedJson {
        message: error.to_string(),
    })?;
    encode_json(&json)
}

/// Validates UTF-8 and rejects JSON values deeper than the protocol limit.
/// JSON syntax itself is intentionally validated by the decoder after this
/// cheap bounded scan, so malformed input can be resynchronized cleanly.
pub fn validate_json_bytes(bytes: &[u8]) -> Result<(), TransportError> {
    let maximum = usize::try_from(MAX_FRAME_BYTES).unwrap_or(usize::MAX);
    if bytes.len() > maximum {
        return Err(TransportError::Oversized {
            observed: bytes.len(),
            maximum,
        });
    }
    std::str::from_utf8(bytes).map_err(|_| TransportError::InvalidUtf8)?;

    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    for byte in bytes {
        if in_string {
            if escaped {
                escaped = false;
            } else if *byte == b'\\' {
                escaped = true;
            } else if *byte == b'"' {
                in_string = false;
            }
            continue;
        }
        match *byte {
            b'"' => in_string = true,
            b'{' | b'[' => {
                depth = depth.saturating_add(1);
                if u64::try_from(depth).unwrap_or(u64::MAX) > MAX_NESTING_DEPTH {
                    return Err(TransportError::TooDeep {
                        maximum: usize::try_from(MAX_NESTING_DEPTH).unwrap_or(usize::MAX),
                    });
                }
            }
            b'}' | b']' => depth = depth.saturating_sub(1),
            _ => {}
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::io::{self, Read, Write};

    use super::*;
    use crate::rpc::protocol::fixture_document;

    struct ChunkedReader {
        chunks: VecDeque<Vec<u8>>,
    }

    impl ChunkedReader {
        fn new(chunks: impl IntoIterator<Item = Vec<u8>>) -> Self {
            Self {
                chunks: chunks.into_iter().collect(),
            }
        }
    }

    impl Read for ChunkedReader {
        fn read(&mut self, destination: &mut [u8]) -> io::Result<usize> {
            let Some(mut chunk) = self.chunks.pop_front() else {
                return Ok(0);
            };
            if chunk.len() > destination.len() {
                let remainder = chunk.split_off(destination.len());
                self.chunks.push_front(remainder);
            }
            let count = chunk.len();
            destination[..count].copy_from_slice(&chunk);
            Ok(count)
        }
    }

    struct ShortWriter {
        bytes: Vec<u8>,
        max_write: usize,
        flushes: usize,
    }

    impl ShortWriter {
        fn new(max_write: usize) -> Self {
            Self {
                bytes: Vec::new(),
                max_write,
                flushes: 0,
            }
        }
    }

    impl Write for ShortWriter {
        fn write(&mut self, source: &[u8]) -> io::Result<usize> {
            let count = source.len().min(self.max_write);
            if count == 0 {
                return Ok(0);
            }
            self.bytes.extend_from_slice(&source[..count]);
            Ok(count)
        }

        fn flush(&mut self) -> io::Result<()> {
            self.flushes = self.flushes.saturating_add(1);
            Ok(())
        }
    }

    fn fixture_bytes(frame: &crate::rpc::protocol::FrameFixture) -> Vec<u8> {
        if let Some(bytes) = &frame.bytes {
            return bytes.clone();
        }
        if let Some(base64) = &frame.bytes_base64 {
            return decode_base64(base64);
        }
        frame
            .frame
            .as_deref()
            .unwrap_or_default()
            .as_bytes()
            .to_vec()
    }

    fn decode_base64(value: &str) -> Vec<u8> {
        // The fixture currently contains only the two-byte invalid UTF-8
        // sample.  Keeping this tiny decoder local avoids another dependency.
        let mut output = Vec::new();
        let mut accumulator = 0u32;
        let mut bits = 0u8;
        for byte in value.bytes() {
            let six = match byte {
                b'A'..=b'Z' => byte - b'A',
                b'a'..=b'z' => byte - b'a' + 26,
                b'0'..=b'9' => byte - b'0' + 52,
                b'+' => 62,
                b'/' => 63,
                b'=' => continue,
                _ => continue,
            };
            accumulator = (accumulator << 6) | u32::from(six);
            bits = bits.saturating_add(6);
            while bits >= 8 {
                bits -= 8;
                output.push((accumulator >> bits) as u8);
                accumulator &= (1 << bits) - 1;
            }
        }
        output
    }

    #[test]
    fn canonical_frame_fixtures_are_stream_decodable() {
        let document = fixture_document().expect("fixture document is valid");
        let mut decoder = FrameDecoder::new();
        for fixture in document.frames {
            let events = decoder.feed(&fixture_bytes(&fixture));
            match fixture.name.as_str() {
                "ascii-frame"
                | "emoji-byte-length"
                | "cjk-byte-length"
                | "split-utf8-codepoint" => {
                    assert!(
                        events
                            .iter()
                            .any(|event| matches!(event, DecoderEvent::Frame(_))),
                        "{}",
                        fixture.name
                    );
                }
                "unframed-bytes" => {
                    assert!(events.iter().any(|event| matches!(
                        event,
                        DecoderEvent::Resynchronized(TransportError::UnframedBytes)
                    )));
                    assert!(
                        events
                            .iter()
                            .any(|event| matches!(event, DecoderEvent::Frame(_)))
                    );
                }
                "invalid-utf8"
                | "partial-frame"
                | "malformed-json"
                | "length-mismatch"
                | "direct-stdout-after-takeover" => {
                    assert!(
                        !events
                            .iter()
                            .any(|event| matches!(event, DecoderEvent::Frame(_))),
                        "{}",
                        fixture.name
                    );
                }
                other => panic!("unhandled fixture {other}"),
            }
            // Partial and invalid fixtures intentionally leave no useful
            // state for the next case; recreate the decoder at each boundary.
            decoder = FrameDecoder::new();
        }
    }

    #[test]
    fn frame_length_counts_utf8_bytes() {
        let json = r#"{"jsonrpc":"2.0","method":"💡"}"#;
        let frame = encode_json(json).expect("valid frame");
        assert_eq!(
            frame,
            b"\x1e33:{\"jsonrpc\":\"2.0\",\"method\":\"\xF0\x9F\x92\xA1\"}\n"
        );
        let mut decoder = FrameDecoder::new();
        let events = decoder.feed(&frame);
        assert!(matches!(events.as_slice(), [DecoderEvent::Frame(_)]));
    }

    #[test]
    fn split_chunks_inside_codepoint_are_reassembled() {
        let json = r#"{"jsonrpc":"2.0","method":"界"}"#;
        let frame = encode_json(json).expect("valid frame");
        let split = frame
            .iter()
            .position(|byte| *byte == 0xe7)
            .expect("CJK byte present");
        let mut decoder = FrameDecoder::new();
        assert!(decoder.feed(&frame[..split + 1]).is_empty());
        let events = decoder.feed(&frame[split + 1..]);
        assert!(matches!(events.as_slice(), [DecoderEvent::Frame(_)]));
    }

    #[test]
    fn malformed_frame_resynchronizes_at_next_separator() {
        let mut decoder = FrameDecoder::new();
        let bytes = b"\x1e2:{x}\n\x1e17:{\"jsonrpc\":\"2.0\"}\n";
        let events = decoder.feed(bytes);
        assert!(
            events
                .iter()
                .any(|event| matches!(event, DecoderEvent::Resynchronized(_)))
        );
        assert!(
            events
                .iter()
                .any(|event| matches!(event, DecoderEvent::Frame(_)))
        );
    }

    #[test]
    fn oversized_and_deep_frames_close() {
        let mut decoder = FrameDecoder::new();
        let oversized = format!("\x1e{}:{}\n", MAX_FRAME_BYTES + 1, "x");
        assert!(matches!(
            decoder.feed(oversized.as_bytes()).as_slice(),
            [DecoderEvent::Closed(TransportError::Oversized { .. })]
        ));
        assert!(decoder.is_closed());

        let nested = "[".repeat(usize::try_from(MAX_NESTING_DEPTH).unwrap_or(64) + 1)
            + &"]".repeat(usize::try_from(MAX_NESTING_DEPTH).unwrap_or(64) + 1);
        let frame = encode_json(&nested);
        assert!(matches!(frame, Err(TransportError::TooDeep { .. })));
    }

    #[test]
    fn stdio_pump_reassembles_chunked_frames_and_reports_eof() {
        let first = encode_json(r#"{"jsonrpc":"2.0","id":1}"#).expect("first frame");
        let second = encode_json(r#"{"jsonrpc":"2.0","id":2}"#).expect("second frame");
        let split = first.len() / 2;
        let mut pump = StdioFramePump::new(
            ChunkedReader::new([
                first[..split].to_vec(),
                first[split..].to_vec(),
                b"log-before-frame".to_vec(),
                second,
            ]),
            ShortWriter::new(8),
        );

        let mut events = Vec::new();
        while !pump.is_closed() {
            events.extend(pump.read_once().expect("chunk read succeeds"));
        }

        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(event, FramePumpEvent::Frame(_)))
                .count(),
            2
        );
        assert!(events.iter().any(|event| matches!(
            event,
            FramePumpEvent::Resynchronized(TransportError::UnframedBytes)
        )));
        assert!(matches!(events.last(), Some(FramePumpEvent::Eof)));
    }

    #[test]
    fn stdio_pump_writes_exact_frames_through_short_writes() {
        let mut pump =
            StdioFramePump::new(ChunkedReader::new(std::iter::empty()), ShortWriter::new(2));
        pump.send_json(r#"{"jsonrpc":"2.0","method":"ready"}"#)
            .expect("frame writes");
        let expected = encode_json(r#"{"jsonrpc":"2.0","method":"ready"}"#).expect("frame encodes");
        assert_eq!(pump.writer.bytes, expected);
        assert_eq!(pump.writer.flushes, 1);
    }

    #[test]
    fn stdio_pump_rejects_unframed_or_malformed_output() {
        let mut pump =
            StdioFramePump::new(ChunkedReader::new(std::iter::empty()), ShortWriter::new(8));
        let result = pump.send_json("not-json");
        assert!(matches!(
            result,
            Err(FramePumpError::Transport(
                TransportError::MalformedJson { .. }
            ))
        ));
        assert!(pump.writer.bytes.is_empty());
    }

    #[test]
    fn stdio_pump_resynchronizes_malformed_input_before_next_frame() {
        let valid = encode_json(r#"{"jsonrpc":"2.0","id":9}"#).expect("valid frame");
        let mut input = b"\x1e4:{x}\n".to_vec();
        input.extend_from_slice(&valid);
        let mut pump = StdioFramePump::new(ChunkedReader::new([input]), ShortWriter::new(8));
        let events = pump.read_once().expect("input read");
        assert!(events.iter().any(|event| matches!(
            event,
            FramePumpEvent::Resynchronized(TransportError::LengthMismatch { .. })
                | FramePumpEvent::Resynchronized(TransportError::MalformedJson { .. })
        )));
        assert!(events.iter().any(|event| matches!(
            event,
            FramePumpEvent::Frame(DecodedFrame { json }) if json.contains("\"id\":9")
        )));
    }

    #[test]
    fn stdio_pump_reports_partial_frame_then_eof_and_stops() {
        let mut pump = StdioFramePump::new(
            ChunkedReader::new([b"\x1e12:{\"x\":1}".to_vec()]),
            ShortWriter::new(8),
        );
        assert!(pump.read_once().expect("partial read").is_empty());
        let events = pump.read_once().expect("eof read");
        assert!(events.iter().any(|event| matches!(
            event,
            FramePumpEvent::Resynchronized(TransportError::LengthMismatch { .. })
        )));
        assert!(matches!(events.last(), Some(FramePumpEvent::Eof)));
        assert!(pump.read_once().expect("closed read").is_empty());
    }

    #[test]
    fn stdio_pump_surfaces_terminal_decoder_close() {
        let oversized = format!("\x1e{}:x\n", MAX_FRAME_BYTES + 1).into_bytes();
        let mut pump = StdioFramePump::new(ChunkedReader::new([oversized]), ShortWriter::new(8));
        let events = pump.read_once().expect("oversized read");
        assert!(events.iter().any(|event| matches!(
            event,
            FramePumpEvent::Closed(TransportError::Oversized { .. })
        )));
        assert!(pump.is_closed());
        assert!(matches!(
            pump.send_json(r#"{"ok":true}"#),
            Err(FramePumpError::Closed)
        ));
    }
}
