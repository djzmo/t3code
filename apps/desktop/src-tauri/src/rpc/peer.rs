//! Runtime-agnostic JSON-RPC peer state machine.
//!
//! The shell and host use the same peer mechanics.  This module owns request
//! identifiers, pending request limits, hello supervision, cancellation, and
//! the renderer's bounded pre-ready queue.  I/O is intentionally represented
//! as byte vectors so a future Tauri runtime can plug in stdio or an in-memory
//! test transport without changing protocol behaviour.

use std::collections::{HashMap, HashSet, VecDeque};

use serde_json::{Value, json};
use thiserror::Error;

use super::protocol::{
    IpcInvokeParams, JsonRpcVersion, MAX_PENDING_REQUESTS, PRE_READY_RENDERER_QUEUE_LIMIT,
    RequiredNullable, RpcEnvelope, RpcError, RpcErrorData, RpcErrorKind, RpcErrorResponse, RpcId,
    RpcMethod, RpcNotification, RpcParams, RpcRequest, RpcResponse, RpcResult, RpcSuccessResponse,
    ShellHelloParams, ShellHelloResult, decode_envelope,
};
use super::transport::{DecoderEvent, FrameDecoder, TransportError, encode, encode_json};

/// JSON-RPC error code for an invalid request/id.
pub const INVALID_REQUEST_CODE: i64 = -32600;
/// JSON-RPC error code for a server/platform busy condition.
pub const PLATFORM_ERROR_CODE: i64 = -32000;
/// JSON-RPC error code for cancellation.
pub const CANCELLED_ERROR_CODE: i64 = -32002;
/// JSON-RPC error code for hello timeout.
pub const TIMEOUT_ERROR_CODE: i64 = -32003;
/// The renderer queue's sliding time window.
pub const PRE_READY_RENDERER_QUEUE_WINDOW_MS: u64 = 20_000;
/// The hello handshake deadline.
pub const HELLO_TIMEOUT_MS: u64 = 15_000;
/// JavaScript's exact integer range, also enforced by the Rust protocol.
pub const JS_SAFE_INTEGER_MAX: RpcId = 9_007_199_254_740_991;

/// Which side of the boundary a peer represents.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PeerRole {
    /// The host initiates `shell.hello`.
    Host,
    /// The shell answers `shell.hello` and supervises the host's lifetime.
    Shell,
}

/// Peer handshake/lifetime state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PeerState {
    AwaitingHello,
    Ready,
    Closed,
}

/// Why the peer was closed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PeerCloseReason {
    Transport(TransportError),
    HelloTimeout,
    InvalidHello(String),
    Protocol(String),
    Local(String),
    /// A pending request was cancelled because its peer closed.
    Cancelled,
}

/// Failures delivered to pending request owners on peer closure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingFailure {
    pub id: RpcId,
    pub reason: PeerCloseReason,
}

/// Events produced by a peer when bytes arrive or when supervision advances.
#[derive(Debug, Clone, PartialEq)]
pub enum PeerEvent {
    /// A frame to write to the peer's transport.
    Outgoing(Vec<u8>),
    /// A validated Appendix B envelope for the caller to dispatch.
    Incoming(Box<RpcEnvelope>),
    /// A request has been cancelled by its remote owner.
    RequestCancelled(RpcId),
    /// A response id did not match a pending request and was ignored.
    UnknownResponse(RpcId),
    /// Input was malformed but the decoder found a later frame boundary.
    Resynchronized(TransportError),
    /// The hello handshake completed.
    Ready,
    /// One or more queued renderer invokes expired before hello completed.
    PreReadyExpired(usize),
    /// The peer closed and every pending request was failed.
    Closed {
        reason: PeerCloseReason,
        pending: Vec<PendingFailure>,
        unexpected_host_close: bool,
    },
}

/// Errors returned before bytes are emitted.
#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum PeerError {
    #[error("peer is closed")]
    Closed,
    #[error("pending request limit {limit} reached")]
    PendingLimit { limit: usize },
    #[error("renderer pre-ready queue limit {limit} reached")]
    PreReadyQueueLimit { limit: usize },
    #[error("request id {0} is already in flight")]
    DuplicateId(RpcId),
    #[error("request id space exhausted")]
    IdExhausted,
    #[error("hello must be the first host message")]
    HelloMustBeFirst,
    #[error("invalid hello: {0}")]
    InvalidHello(String),
    #[error("peer is not ready")]
    NotReady,
    #[error("transport error: {0}")]
    Transport(#[from] TransportError),
    #[error("protocol error: {0}")]
    Protocol(String),
}

#[derive(Debug, Clone)]
struct PendingRequest {
    method: RpcMethod,
    sent_at_ms: u64,
    hello: bool,
}

#[derive(Debug, Clone)]
struct QueuedInvoke {
    channel: String,
    payload: Value,
    queued_at_ms: u64,
}

/// A bounded, symmetric JSON-RPC peer.
#[derive(Debug)]
pub struct Peer {
    role: PeerRole,
    state: PeerState,
    decoder: FrameDecoder,
    next_id: RpcId,
    pending: HashMap<RpcId, PendingRequest>,
    inbound_ids: HashSet<RpcId>,
    pre_ready: VecDeque<QueuedInvoke>,
    hello_id: Option<RpcId>,
    hello_deadline_ms: Option<u64>,
    shell_hello: Option<ShellHelloResult>,
    host_pid: u64,
    close_reason: Option<PeerCloseReason>,
}

impl Peer {
    /// Creates a host peer or shell peer.  Shell peers need a hello result to
    /// return; host peers may pass `None`.
    #[must_use]
    pub fn new(role: PeerRole, host_pid: u64, shell_hello: Option<ShellHelloResult>) -> Self {
        Self {
            role,
            state: PeerState::AwaitingHello,
            decoder: FrameDecoder::new(),
            next_id: 1,
            pending: HashMap::new(),
            inbound_ids: HashSet::new(),
            pre_ready: VecDeque::new(),
            hello_id: None,
            hello_deadline_ms: None,
            shell_hello,
            host_pid,
            close_reason: None,
        }
    }

    /// Creates the host side of the handshake.
    #[must_use]
    pub fn host(host_pid: u64) -> Self {
        Self::new(PeerRole::Host, host_pid, None)
    }

    /// Creates the shell side of the handshake.
    #[must_use]
    pub fn shell(hello: ShellHelloResult) -> Self {
        Self::new(PeerRole::Shell, 0, Some(hello))
    }

    #[must_use]
    pub const fn role(&self) -> PeerRole {
        self.role
    }

    #[must_use]
    pub const fn state(&self) -> PeerState {
        self.state
    }

    #[must_use]
    pub fn pending_len(&self) -> usize {
        self.pending.len()
    }

    #[must_use]
    pub fn pre_ready_len(&self) -> usize {
        self.pre_ready.len()
    }

    #[must_use]
    pub fn close_reason(&self) -> Option<&PeerCloseReason> {
        self.close_reason.as_ref()
    }

    /// Starts the host handshake.  Calling this twice is idempotent after the
    /// first call and returns no duplicate hello frame.
    pub fn start(&mut self, now_ms: u64) -> Result<Vec<PeerEvent>, PeerError> {
        if self.state == PeerState::Closed {
            return Err(PeerError::Closed);
        }
        if self.role == PeerRole::Shell {
            self.hello_deadline_ms
                .get_or_insert(now_ms.saturating_add(HELLO_TIMEOUT_MS));
            return Ok(Vec::new());
        }
        if self.hello_id.is_some() {
            return Ok(Vec::new());
        }
        let id = self.allocate_id()?;
        let request = RpcEnvelope::Request(RpcRequest {
            jsonrpc: JsonRpcVersion::V2,
            id,
            method: RpcMethod::ShellHello,
            params: Some(RpcParams::ShellHello(ShellHelloParams {
                protocol_version: "2.0".to_owned(),
                host_pid: self.host_pid,
            })),
        });
        let frame = encode(&request).map_err(PeerError::Transport)?;
        self.pending.insert(
            id,
            PendingRequest {
                method: RpcMethod::ShellHello,
                sent_at_ms: now_ms,
                hello: true,
            },
        );
        self.hello_id = Some(id);
        self.hello_deadline_ms = Some(now_ms.saturating_add(HELLO_TIMEOUT_MS));
        Ok(vec![PeerEvent::Outgoing(frame)])
    }

    /// Feeds transport bytes into the peer and returns dispatch/supervision
    /// events.  Recoverable framing errors do not fail this method.
    pub fn receive(&mut self, bytes: &[u8], now_ms: u64) -> Result<Vec<PeerEvent>, PeerError> {
        if self.state == PeerState::Closed {
            return Err(PeerError::Closed);
        }
        let mut events = self.poll(now_ms);
        for event in self.decoder.feed(bytes) {
            match event {
                DecoderEvent::Frame(frame) => {
                    events.extend(self.handle_json(&frame.json, now_ms)?);
                    if self.state == PeerState::Closed {
                        break;
                    }
                }
                DecoderEvent::Resynchronized(error) => {
                    events.push(PeerEvent::Resynchronized(error));
                }
                DecoderEvent::Closed(error) => {
                    events.extend(self.close(PeerCloseReason::Transport(error)));
                    break;
                }
            }
        }
        Ok(events)
    }

    /// Advances hello and pre-ready queue deadlines without requiring a timer
    /// runtime.  Callers can invoke this from their event loop's timer tick.
    pub fn poll(&mut self, now_ms: u64) -> Vec<PeerEvent> {
        if self.state == PeerState::Closed {
            return Vec::new();
        }
        let mut events = Vec::new();
        if self.state == PeerState::AwaitingHello
            && self
                .hello_deadline_ms
                .is_some_and(|deadline| now_ms >= deadline)
        {
            events.extend(self.close(PeerCloseReason::HelloTimeout));
            return events;
        }
        if self.state == PeerState::AwaitingHello {
            let expired = self.expire_pre_ready(now_ms);
            if expired > 0 {
                events.push(PeerEvent::PreReadyExpired(expired));
            }
        }
        events
    }

    /// Sends a typed request and records its pending id.
    pub fn request(
        &mut self,
        method: RpcMethod,
        params: Option<RpcParams>,
        now_ms: u64,
    ) -> Result<(RpcId, PeerEvent), PeerError> {
        self.ensure_open()?;
        if self.state != PeerState::Ready && method != RpcMethod::ShellHello {
            return Err(PeerError::NotReady);
        }
        let id = self.allocate_id()?;
        let frame = encode(&RpcEnvelope::Request(RpcRequest {
            jsonrpc: JsonRpcVersion::V2,
            id,
            method,
            params,
        }))
        .map_err(PeerError::Transport)?;
        self.pending.insert(
            id,
            PendingRequest {
                method,
                sent_at_ms: now_ms,
                hello: false,
            },
        );
        Ok((id, PeerEvent::Outgoing(frame)))
    }

    /// Sends a notification.  Notifications are allowed after hello only;
    /// the handshake itself is emitted by [`Self::start`].
    pub fn notify(
        &mut self,
        method: RpcMethod,
        params: Option<RpcParams>,
    ) -> Result<PeerEvent, PeerError> {
        self.ensure_open()?;
        if self.state != PeerState::Ready {
            return Err(PeerError::NotReady);
        }
        let frame = encode(&RpcEnvelope::Notification(RpcNotification {
            jsonrpc: JsonRpcVersion::V2,
            method,
            params,
        }))
        .map_err(PeerError::Transport)?;
        Ok(PeerEvent::Outgoing(frame))
    }

    /// Queues a renderer IPC invoke until hello completes, or emits it
    /// immediately if the peer is ready.
    pub fn queue_renderer_invoke(
        &mut self,
        channel: impl Into<String>,
        payload: Value,
        now_ms: u64,
    ) -> Result<Option<PeerEvent>, PeerError> {
        self.ensure_open()?;
        if self.state == PeerState::Ready {
            let (_, event) = self.request(
                RpcMethod::IpcInvoke,
                Some(RpcParams::IpcInvoke(IpcInvokeParams {
                    channel: channel.into(),
                    payload,
                })),
                now_ms,
            )?;
            return Ok(Some(event));
        }
        let _ = self.expire_pre_ready(now_ms);
        if self.pre_ready.len() >= usize::try_from(PRE_READY_RENDERER_QUEUE_LIMIT).unwrap_or(256) {
            return Err(PeerError::PreReadyQueueLimit {
                limit: usize::try_from(PRE_READY_RENDERER_QUEUE_LIMIT).unwrap_or(256),
            });
        }
        self.pre_ready.push_back(QueuedInvoke {
            channel: channel.into(),
            payload,
            queued_at_ms: now_ms,
        });
        Ok(None)
    }

    /// Cancels one pending request and emits the Appendix B-compatible
    /// `$/cancel` notification.  Unknown ids are deliberately ignored.
    pub fn cancel_request(&mut self, id: RpcId) -> Result<Vec<PeerEvent>, PeerError> {
        self.ensure_open()?;
        let Some(pending) = self.pending.remove(&id) else {
            return Ok(vec![PeerEvent::UnknownResponse(id)]);
        };
        let _ = pending;
        let frame = encode_json(
            &json!({
                "jsonrpc": "2.0",
                "method": "$/cancel",
                "params": { "id": id }
            })
            .to_string(),
        )
        .map_err(PeerError::Transport)?;
        Ok(vec![
            PeerEvent::Outgoing(frame),
            PeerEvent::RequestCancelled(id),
        ])
    }

    /// Completes an inbound request id so a later reuse is not treated as a
    /// duplicate in-flight request.
    pub fn complete_inbound(&mut self, id: RpcId) {
        self.inbound_ids.remove(&id);
    }

    /// Closes the peer and fails all pending request ids.  The returned event
    /// is the single source of truth for cleanup and unexpected host death.
    pub fn close(&mut self, reason: PeerCloseReason) -> Vec<PeerEvent> {
        if self.state == PeerState::Closed {
            return Vec::new();
        }
        self.state = PeerState::Closed;
        self.close_reason = Some(reason.clone());
        let pending = self
            .pending
            .drain()
            .map(|(id, _)| PendingFailure {
                id,
                reason: PeerCloseReason::Cancelled,
            })
            .collect::<Vec<_>>();
        self.pre_ready.clear();
        let unexpected_host_close = self.role == PeerRole::Shell;
        vec![PeerEvent::Closed {
            reason,
            pending,
            unexpected_host_close,
        }]
    }

    fn handle_json(&mut self, json_text: &str, now_ms: u64) -> Result<Vec<PeerEvent>, PeerError> {
        let raw: Value = serde_json::from_str(json_text)
            .map_err(|error| PeerError::Protocol(error.to_string()))?;
        if raw.get("method").and_then(Value::as_str) == Some("$/cancel") {
            return self.handle_cancel_value(&raw);
        }
        let envelope = match decode_envelope(json_text) {
            Ok(envelope) => envelope,
            Err(error) => {
                let message = error.to_string();
                if self.role == PeerRole::Shell && self.state == PeerState::AwaitingHello {
                    return Ok(self.close(PeerCloseReason::InvalidHello(message)));
                }
                let id = raw
                    .get("id")
                    .and_then(Value::as_i64)
                    .filter(|id| *id >= -JS_SAFE_INTEGER_MAX && *id <= JS_SAFE_INTEGER_MAX);
                return self.invalid_request_response(id, &message);
            }
        };
        match &envelope {
            RpcEnvelope::Response(response) => self.handle_response(response, now_ms),
            RpcEnvelope::Request(request) => self.handle_request(request),
            RpcEnvelope::Notification(notification) => self.handle_notification(notification),
        }
    }

    fn handle_cancel_value(&mut self, raw: &Value) -> Result<Vec<PeerEvent>, PeerError> {
        let id = raw
            .get("params")
            .and_then(|params| params.get("id"))
            .and_then(Value::as_i64)
            .ok_or_else(|| PeerError::Protocol("$/cancel id must be an integer".to_owned()))?;
        if self.pending.remove(&id).is_some() {
            Ok(vec![PeerEvent::RequestCancelled(id)])
        } else {
            Ok(vec![PeerEvent::UnknownResponse(id)])
        }
    }

    fn handle_response(
        &mut self,
        response: &RpcResponse,
        _now_ms: u64,
    ) -> Result<Vec<PeerEvent>, PeerError> {
        let id = match response {
            RpcResponse::Success(success) => success.id,
            RpcResponse::Error(error) => match error.id.0 {
                Some(id) => id,
                None => {
                    return Ok(vec![PeerEvent::Incoming(Box::new(RpcEnvelope::Response(
                        response.clone(),
                    )))]);
                }
            },
        };
        let Some(pending) = self.pending.remove(&id) else {
            return Ok(vec![PeerEvent::UnknownResponse(id)]);
        };
        if pending.hello {
            if self.role != PeerRole::Host {
                return Err(PeerError::InvalidHello(
                    "only the host may await the hello response".to_owned(),
                ));
            }
            match response {
                RpcResponse::Success(success) => {
                    if !matches!(success.result, RpcResult::ShellHello(_)) {
                        return Err(PeerError::InvalidHello(
                            "hello response result has the wrong shape".to_owned(),
                        ));
                    }
                }
                RpcResponse::Error(error) => {
                    return Err(PeerError::InvalidHello(error.error.message.clone()));
                }
            }
            self.state = PeerState::Ready;
            self.hello_deadline_ms = None;
            let mut events = vec![
                PeerEvent::Ready,
                PeerEvent::Incoming(Box::new(RpcEnvelope::Response(response.clone()))),
            ];
            events.extend(self.flush_pre_ready(0)?);
            return Ok(events);
        }
        let _ = pending.method;
        let _ = pending.sent_at_ms;
        Ok(vec![PeerEvent::Incoming(Box::new(RpcEnvelope::Response(
            response.clone(),
        )))])
    }

    fn handle_request(&mut self, request: &RpcRequest) -> Result<Vec<PeerEvent>, PeerError> {
        if self.role == PeerRole::Shell && self.state == PeerState::AwaitingHello {
            if request.method != RpcMethod::ShellHello {
                let events = self.close(PeerCloseReason::InvalidHello(
                    "shell.hello must be the first host message".to_owned(),
                ));
                return Ok(events);
            }
            let Some(RpcParams::ShellHello(params)) = request.params.as_ref() else {
                return Ok(self.close(PeerCloseReason::InvalidHello(
                    "shell.hello params have the wrong shape".to_owned(),
                )));
            };
            if params.protocol_version != "2.0" {
                return Ok(self.close(PeerCloseReason::InvalidHello(
                    "protocolVersion must be JSON-RPC 2.0".to_owned(),
                )));
            }
            let Some(result) = self.shell_hello.clone() else {
                return Ok(self.close(PeerCloseReason::InvalidHello(
                    "shell hello result is not configured".to_owned(),
                )));
            };
            let response =
                RpcEnvelope::Response(RpcResponse::Success(Box::new(RpcSuccessResponse {
                    jsonrpc: JsonRpcVersion::V2,
                    id: request.id,
                    result: RpcResult::ShellHello(Box::new(result)),
                })));
            let frame = encode(&response).map_err(PeerError::Transport)?;
            self.state = PeerState::Ready;
            self.hello_deadline_ms = None;
            return Ok(vec![PeerEvent::Outgoing(frame), PeerEvent::Ready]);
        }
        if self.inbound_ids.contains(&request.id) {
            return self.invalid_request_response(Some(request.id), "duplicate request id");
        }
        self.inbound_ids.insert(request.id);
        Ok(vec![PeerEvent::Incoming(Box::new(RpcEnvelope::Request(
            request.clone(),
        )))])
    }

    fn handle_notification(
        &mut self,
        notification: &RpcNotification,
    ) -> Result<Vec<PeerEvent>, PeerError> {
        if self.state == PeerState::AwaitingHello && self.role == PeerRole::Shell {
            return Ok(self.close(PeerCloseReason::InvalidHello(
                "shell.hello must be the first host message".to_owned(),
            )));
        }
        Ok(vec![PeerEvent::Incoming(Box::new(
            RpcEnvelope::Notification(notification.clone()),
        ))])
    }

    fn invalid_request_response(
        &mut self,
        id: Option<RpcId>,
        message: &str,
    ) -> Result<Vec<PeerEvent>, PeerError> {
        let response = RpcEnvelope::Response(RpcResponse::Error(RpcErrorResponse {
            jsonrpc: JsonRpcVersion::V2,
            id: RequiredNullable(id),
            error: RpcError {
                code: INVALID_REQUEST_CODE,
                message: message.to_owned(),
                data: Some(RpcErrorData {
                    kind: RpcErrorKind::InvalidParams,
                }),
            },
        }));
        let frame = encode(&response).map_err(PeerError::Transport)?;
        Ok(vec![PeerEvent::Outgoing(frame)])
    }

    fn flush_pre_ready(&mut self, now_ms: u64) -> Result<Vec<PeerEvent>, PeerError> {
        let mut events = Vec::new();
        while let Some(item) = self.pre_ready.pop_front() {
            let (_, event) = self.request(
                RpcMethod::IpcInvoke,
                Some(RpcParams::IpcInvoke(IpcInvokeParams {
                    channel: item.channel,
                    payload: item.payload,
                })),
                now_ms.max(item.queued_at_ms),
            )?;
            events.push(event);
        }
        Ok(events)
    }

    fn expire_pre_ready(&mut self, now_ms: u64) -> usize {
        let before = self.pre_ready.len();
        self.pre_ready.retain(|item| {
            now_ms.saturating_sub(item.queued_at_ms) < PRE_READY_RENDERER_QUEUE_WINDOW_MS
        });
        before.saturating_sub(self.pre_ready.len())
    }

    fn ensure_open(&self) -> Result<(), PeerError> {
        if self.state == PeerState::Closed {
            Err(PeerError::Closed)
        } else {
            Ok(())
        }
    }

    fn allocate_id(&mut self) -> Result<RpcId, PeerError> {
        if self.pending.len() >= usize::try_from(MAX_PENDING_REQUESTS).unwrap_or(1024) {
            return Err(PeerError::PendingLimit {
                limit: usize::try_from(MAX_PENDING_REQUESTS).unwrap_or(1024),
            });
        }
        let id = self.next_id;
        if id <= 0 || id > JS_SAFE_INTEGER_MAX {
            return Err(PeerError::IdExhausted);
        }
        self.next_id = id.checked_add(1).ok_or(PeerError::IdExhausted)?;
        if self.pending.contains_key(&id) {
            return Err(PeerError::DuplicateId(id));
        }
        Ok(id)
    }
}

/// A tiny in-memory full-duplex byte boundary used by peer tests and future
/// integration tests.  It deliberately models chunking but does not impose an
/// async runtime or channel dependency.
#[derive(Debug, Default)]
pub struct InMemoryDuplex {
    left_to_right: VecDeque<Vec<u8>>,
    right_to_left: VecDeque<Vec<u8>>,
}

impl InMemoryDuplex {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn send_left(&mut self, bytes: Vec<u8>) {
        self.left_to_right.push_back(bytes);
    }

    pub fn send_right(&mut self, bytes: Vec<u8>) {
        self.right_to_left.push_back(bytes);
    }

    #[must_use]
    pub fn recv_left(&mut self) -> Option<Vec<u8>> {
        self.right_to_left.pop_front()
    }

    #[must_use]
    pub fn recv_right(&mut self) -> Option<Vec<u8>> {
        self.left_to_right.pop_front()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.left_to_right.is_empty() && self.right_to_left.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::protocol::{EmptyParams, RpcEnvelope, RpcMethod, RpcParams, ShellHelloResult};

    fn hello_result() -> ShellHelloResult {
        ShellHelloResult {
            app_name: "Agent Nanoni".to_owned(),
            identifier: "app.nanoni.agent.desktop".to_owned(),
            version: "1.0.0".to_owned(),
            tauri_version: "2.11.5".to_owned(),
            platform: "test".to_owned(),
            arch: "x86_64".to_owned(),
            is_dev: true,
            exec_path: "/tmp/AgentNanoni".to_owned(),
            resource_dir: "/tmp/resources".to_owned(),
            server_root: "/tmp/server".to_owned(),
            app_data_dir: "/tmp/data".to_owned(),
            log_dir: "/tmp/logs".to_owned(),
            system_locale: "en-US".to_owned(),
            deep_link_scheme: "agent-nanoni".to_owned(),
            argv: Vec::new(),
            launch_urls: Vec::new(),
        }
    }

    fn wire(event: PeerEvent) -> Vec<u8> {
        match event {
            PeerEvent::Outgoing(bytes) => bytes,
            other => panic!("expected outgoing event, got {other:?}"),
        }
    }

    #[test]
    fn hello_is_first_and_completes_with_protocol_two() {
        let mut host = Peer::host(4242);
        let mut shell = Peer::shell(hello_result());
        let hello = wire(host.start(100).expect("host starts").remove(0));
        let shell_events = shell.receive(&hello, 101).expect("shell receives hello");
        assert!(
            shell_events
                .iter()
                .any(|event| matches!(event, PeerEvent::Ready))
        );
        let response = shell_events
            .into_iter()
            .find_map(|event| match event {
                PeerEvent::Outgoing(bytes) => Some(bytes),
                _ => None,
            })
            .expect("shell responds");
        let host_events = host
            .receive(&response, 102)
            .expect("host receives response");
        assert_eq!(host.state(), PeerState::Ready);
        assert!(
            host_events
                .iter()
                .any(|event| matches!(event, PeerEvent::Ready))
        );
        let decoded = host_events.into_iter().find_map(|event| match event {
            PeerEvent::Incoming(envelope)
                if matches!(envelope.as_ref(), RpcEnvelope::Response(_)) =>
            {
                Some(PeerEvent::Incoming(envelope))
            }
            _ => None,
        });
        assert!(decoded.is_some());
    }

    #[test]
    fn wrong_first_message_closes_shell_and_marks_unexpected_host_close() {
        let mut shell = Peer::shell(hello_result());
        let request = RpcEnvelope::Notification(crate::rpc::protocol::RpcNotification {
            jsonrpc: JsonRpcVersion::V2,
            method: RpcMethod::AppQuit,
            params: None,
        });
        let bytes = encode(&request).expect("request encodes");
        let events = shell.receive(&bytes, 0).expect("close is an event");
        assert!(events.iter().any(|event| matches!(
            event,
            PeerEvent::Closed {
                unexpected_host_close: true,
                ..
            }
        )));
        assert_eq!(shell.state(), PeerState::Closed);
    }

    #[test]
    fn shell_hello_timeout_is_armed_when_the_peer_starts() {
        let mut shell = Peer::shell(hello_result());
        assert!(
            shell
                .start(50)
                .expect("shell supervision starts")
                .is_empty()
        );
        let events = shell.poll(50 + HELLO_TIMEOUT_MS);
        assert!(events.iter().any(|event| matches!(
            event,
            PeerEvent::Closed {
                reason: PeerCloseReason::HelloTimeout,
                ..
            }
        )));
    }

    #[test]
    fn invalid_hello_closes_the_shell() {
        let mut shell = Peer::shell(hello_result());
        let request = RpcEnvelope::Request(RpcRequest {
            jsonrpc: JsonRpcVersion::V2,
            id: 1,
            method: RpcMethod::ShellHello,
            params: Some(RpcParams::ShellHello(ShellHelloParams {
                protocol_version: "1.0".to_owned(),
                host_pid: 42,
            })),
        });
        let events = shell
            .receive(&encode(&request).expect("hello encodes"), 0)
            .expect("invalid hello closes cleanly");
        assert!(events.iter().any(|event| matches!(
            event,
            PeerEvent::Closed {
                reason: PeerCloseReason::InvalidHello(_),
                ..
            }
        )));
        assert_eq!(shell.state(), PeerState::Closed);
    }

    #[test]
    fn malformed_request_id_receives_invalid_request_response() {
        let mut peer = Peer::host(1);
        peer.state = PeerState::Ready;
        let frame =
            encode_json(r#"{"jsonrpc":"2.0","id":"bad","method":"app.getMetrics","params":{}}"#)
                .expect("raw request frames");
        let events = peer.receive(&frame, 0).expect("peer remains usable");
        let outgoing = events
            .into_iter()
            .find_map(|event| match event {
                PeerEvent::Outgoing(bytes) => Some(bytes),
                _ => None,
            })
            .expect("invalid request response");
        assert!(String::from_utf8_lossy(&outgoing).contains(r#""code":-32600"#));
        assert_eq!(peer.state(), PeerState::Ready);
    }

    #[test]
    fn peer_closure_cancels_pending_requests() {
        let mut peer = Peer::host(1);
        peer.state = PeerState::Ready;
        let _ = peer
            .request(RpcMethod::AppGetMetrics, None, 0)
            .expect("request is pending");
        let events = peer.close(PeerCloseReason::Local("test close".to_owned()));
        assert!(events.iter().any(|event| matches!(
            event,
            PeerEvent::Closed { pending, .. }
                if matches!(pending.as_slice(), [PendingFailure {
                    reason: PeerCloseReason::Cancelled,
                    ..
                }])
        )));
    }

    #[test]
    fn pending_capacity_and_unknown_responses_are_bounded() {
        let mut peer = Peer::host(1);
        peer.state = PeerState::Ready;
        for _ in 0..MAX_PENDING_REQUESTS {
            let result = peer.request(RpcMethod::AppGetMetrics, None, 0);
            assert!(result.is_ok());
        }
        assert!(matches!(
            peer.request(RpcMethod::AppGetMetrics, None, 0),
            Err(PeerError::PendingLimit { .. })
        ));
        let response = RpcEnvelope::Response(RpcResponse::Success(Box::new(RpcSuccessResponse {
            jsonrpc: JsonRpcVersion::V2,
            id: 999_999,
            result: RpcResult::Empty(crate::rpc::protocol::EmptyResult {}),
        })));
        let events = peer
            .receive(&encode(&response).expect("response encodes"), 0)
            .expect("unknown response is ignored");
        assert!(
            events
                .iter()
                .any(|event| matches!(event, PeerEvent::UnknownResponse(999_999)))
        );
    }

    #[test]
    fn pre_ready_renderer_queue_flushes_and_expires() {
        let mut peer = Peer::host(1);
        assert!(
            peer.queue_renderer_invoke("desktop:test", json!({"ok": true}), 0)
                .expect("queue succeeds")
                .is_none()
        );
        assert_eq!(peer.pre_ready_len(), 1);
        let expired = peer.poll(PRE_READY_RENDERER_QUEUE_WINDOW_MS);
        assert!(
            expired
                .iter()
                .any(|event| matches!(event, PeerEvent::PreReadyExpired(1)))
        );
        assert_eq!(peer.pre_ready_len(), 0);
    }

    #[test]
    fn cancellation_emits_json_rpc_cancel_notification() {
        let mut peer = Peer::host(1);
        peer.state = PeerState::Ready;
        let (id, _) = peer
            .request(
                RpcMethod::AppGetMetrics,
                Some(RpcParams::Empty(EmptyParams {})),
                0,
            )
            .expect("request succeeds");
        let events = peer.cancel_request(id).expect("cancel succeeds");
        assert!(events.iter().any(
            |event| matches!(event, PeerEvent::RequestCancelled(cancelled) if *cancelled == id)
        ));
        let frame = events
            .into_iter()
            .find_map(|event| match event {
                PeerEvent::Outgoing(bytes) => Some(bytes),
                _ => None,
            })
            .expect("cancel frame");
        assert!(String::from_utf8_lossy(&frame).contains("$/cancel"));
    }

    #[test]
    fn hello_timeout_closes_and_fails_pending() {
        let mut peer = Peer::host(1);
        let _ = peer.start(10).expect("start succeeds");
        let events = peer.poll(10 + HELLO_TIMEOUT_MS);
        assert!(events.iter().any(|event| matches!(
            event,
            PeerEvent::Closed {
                reason: PeerCloseReason::HelloTimeout,
                pending,
                ..
            } if pending.len() == 1
        )));
    }

    #[test]
    fn in_memory_duplex_preserves_order() {
        let mut duplex = InMemoryDuplex::new();
        duplex.send_left(vec![1, 2]);
        duplex.send_left(vec![3]);
        assert_eq!(duplex.recv_right(), Some(vec![1, 2]));
        assert_eq!(duplex.recv_right(), Some(vec![3]));
        assert!(duplex.is_empty());
    }
}
