//! Adapter between the shell process broker and the JSON-RPC process DTOs.
//!
//! Broker tokens never cross this boundary. The adapter mints stable wire
//! process and registration identifiers and keeps the opaque native tokens in
//! private maps.

use super::broker::{AdditionalFdDirection, AdditionalFdSpec};
use super::{
    BrokerError, BrokerEvent, ProcessBroker, ProcessKind as NativeProcessKind, RegistrationToken,
    ReleaseOutcome, SpawnRequest, StdinOutcome,
};
use crate::rpc::protocol::{
    ProcessExitParams, ProcessFdDirection, ProcessInputParams, ProcessKillParams, ProcessKind,
    ProcessOutputParams, ProcessRegisterParams, ProcessSpawnParams, ProcessSpawnResult,
    ProcessStreamMode, ProcessTokenParams, RegistrationResult, RequiredNullable, RpcMethod,
    RpcNotification, RpcParams,
};
use std::collections::HashMap;
use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use thiserror::Error;

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum RpcAdapterError {
    #[error("invalid process request: {0}")]
    InvalidRequest(String),
    #[error("unknown process attempt: {0}")]
    UnknownAttempt(String),
    #[error("unknown process id: {0}")]
    UnknownProcess(String),
    #[error("unknown process registration: {0}")]
    UnknownRegistration(String),
    #[error("invalid base64 input")]
    InvalidBase64,
    #[error("unsupported process signal: {0}")]
    UnsupportedSignal(String),
    #[error("native process broker failed: {0}")]
    Broker(String),
}

impl From<BrokerError> for RpcAdapterError {
    fn from(error: BrokerError) -> Self {
        Self::Broker(error.to_string())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ProcessRecord {
    attempt_id: String,
    process_id: String,
    registration_id: Option<String>,
    broker_attempt: super::broker::AttemptToken,
    broker_registration: Option<RegistrationToken>,
}

/// Mutable wire-token state shared by the request adapter and event receiver.
///
/// The native broker's event queue already provides the blocking primitive.
/// Keeping only the token maps behind a small mutex lets an event receiver
/// wait on that queue without retaining the shell dispatcher/platform lock.
#[derive(Debug, Default)]
struct ProcessState {
    attempts: HashMap<String, String>,
    processes: HashMap<String, ProcessRecord>,
    registrations: HashMap<String, String>,
    next_process_id: u64,
    next_registration_id: u64,
}

impl ProcessState {
    fn allocate_process_id(&mut self) -> String {
        let id = format!("process-{}", self.next_process_id);
        self.next_process_id = self.next_process_id.saturating_add(1);
        id
    }

    fn allocate_registration_id(&mut self, token: RegistrationToken) -> String {
        let id = format!("registration-{}", self.next_registration_id);
        self.next_registration_id = self.next_registration_id.saturating_add(1);
        let _ = token;
        id
    }
}

/// A blocking, thread-safe view of native broker events.
///
/// The receiver owns a clone of the broker's bounded event stream and shares
/// only the process-token state with [`RpcProcessBroker`]. Calling [`next`]
/// therefore blocks without holding the dispatcher or platform mutex.
#[derive(Debug, Clone)]
pub struct RpcBrokerEventReceiver {
    events: super::broker::EventStream,
    state: Arc<Mutex<ProcessState>>,
}

impl RpcBrokerEventReceiver {
    /// Blocks until an event is available or the broker transport is closed.
    pub fn next(&self) -> Option<Result<RpcNotification, RpcAdapterError>> {
        let event = self.events.next()?;
        Some(self.map_event(event))
    }

    /// Returns one queued event without waiting.
    pub fn try_next(&self) -> Option<Result<RpcNotification, RpcAdapterError>> {
        let event = self.events.try_next()?;
        Some(self.map_event(event))
    }

    /// Closes the shared event stream and wakes blocked receivers/producers.
    pub fn close(&self) {
        self.events.close();
    }

    fn map_event(&self, event: BrokerEvent) -> Result<RpcNotification, RpcAdapterError> {
        let mut state = lock_state(&self.state);
        event_to_notification(&mut state, event)
    }
}

/// Shell-side process DTO adapter.
#[derive(Debug)]
pub struct RpcProcessBroker {
    broker: ProcessBroker,
    state: Arc<Mutex<ProcessState>>,
}

impl RpcProcessBroker {
    #[must_use]
    pub fn new(broker: ProcessBroker) -> Self {
        Self {
            broker,
            state: Arc::new(Mutex::new(ProcessState {
                next_process_id: 1,
                next_registration_id: 1,
                ..ProcessState::default()
            })),
        }
    }

    #[must_use]
    pub fn broker(&self) -> &ProcessBroker {
        &self.broker
    }

    /// Subscribes to the broker's bounded event queue without borrowing the
    /// adapter or its shell/platform dispatcher.
    #[must_use]
    pub fn subscribe_events(&self) -> RpcBrokerEventReceiver {
        RpcBrokerEventReceiver {
            events: self.broker.events(),
            state: Arc::clone(&self.state),
        }
    }

    pub fn spawn(
        &mut self,
        params: ProcessSpawnParams,
    ) -> Result<ProcessSpawnResult, RpcAdapterError> {
        let request = spawn_request(&params)?;
        // Hold the mapping state through broker registration. A fast child can
        // emit its exit event before `spawn` returns; the receiver may pop it
        // immediately, so its mapping must be visible before this lock drops.
        let mut state = lock_state(&self.state);
        if state.attempts.contains_key(&params.attempt_id) {
            return Err(RpcAdapterError::InvalidRequest(
                "attemptId is already in flight".to_owned(),
            ));
        }
        let spawned = self.broker.spawn(request)?;
        let registered = self.broker.register(spawned.attempt_id)?;
        let process_id = state.allocate_process_id();
        let registration_id = registered
            .registration_id
            .map(|token| state.allocate_registration_id(token));
        let record = ProcessRecord {
            attempt_id: params.attempt_id.clone(),
            process_id: process_id.clone(),
            registration_id: registration_id.clone(),
            broker_attempt: spawned.attempt_id,
            broker_registration: registered.registration_id,
        };
        state
            .attempts
            .insert(params.attempt_id.clone(), process_id.clone());
        if let Some(registration_id) = &registration_id {
            state
                .registrations
                .insert(registration_id.clone(), process_id.clone());
        }
        state.processes.insert(process_id.clone(), record);
        Ok(ProcessSpawnResult {
            process_id,
            pid: u64::from(spawned.pid),
            registration_id: RequiredNullable(registration_id),
        })
    }

    pub fn register(
        &mut self,
        params: ProcessRegisterParams,
    ) -> Result<RegistrationResult, RpcAdapterError> {
        let mut state = lock_state(&self.state);
        let process_id = state
            .attempts
            .get(&params.attempt_id)
            .cloned()
            .ok_or_else(|| RpcAdapterError::UnknownAttempt(params.attempt_id.clone()))?;
        let broker_attempt_id = state
            .processes
            .get(&process_id)
            .ok_or_else(|| RpcAdapterError::UnknownProcess(process_id.clone()))?
            .broker_attempt;
        if let Some(registration_id) = state
            .processes
            .get(&process_id)
            .and_then(|record| record.registration_id.as_ref())
        {
            return Ok(RegistrationResult {
                registration_id: RequiredNullable(Some(registration_id.clone())),
            });
        }
        let outcome = self.broker.register(broker_attempt_id)?;
        let registration_id = outcome
            .registration_id
            .map(|token| state.allocate_registration_id(token));
        let record = state
            .processes
            .get_mut(&process_id)
            .ok_or_else(|| RpcAdapterError::UnknownProcess(process_id.clone()))?;
        record.registration_id = registration_id.clone();
        record.broker_registration = outcome.registration_id;
        if let Some(registration_id) = &registration_id {
            state
                .registrations
                .insert(registration_id.clone(), process_id);
        }
        Ok(RegistrationResult {
            registration_id: RequiredNullable(registration_id),
        })
    }

    pub fn input(&self, params: ProcessInputParams) -> Result<StdinOutcome, RpcAdapterError> {
        let record = self.process_record(&params.process_id, &params.registration_id)?;
        let bytes = decode_base64(&params.bytes_base64)?;
        match record.broker_registration {
            Some(registration) => self
                .broker
                .write_input(registration, params.fd, &bytes)
                .map_err(RpcAdapterError::from),
            None => self
                .broker
                .write_input(record.broker_attempt, params.fd, &bytes)
                .map_err(RpcAdapterError::from),
        }
    }

    pub fn kill(&mut self, params: ProcessKillParams) -> Result<ReleaseOutcome, RpcAdapterError> {
        if !matches!(
            params.signal.as_str(),
            "SIGTERM" | "SIGKILL" | "TERM" | "KILL"
        ) {
            return Err(RpcAdapterError::UnsupportedSignal(params.signal));
        }
        let record = self.process_record(&params.process_id, &params.registration_id)?;
        let registration = record
            .broker_registration
            .ok_or_else(|| RpcAdapterError::UnknownRegistration(params.registration_id.clone()))?;
        self.broker
            .release(registration)
            .map_err(RpcAdapterError::from)
    }

    pub fn release(
        &mut self,
        params: ProcessTokenParams,
    ) -> Result<ReleaseOutcome, RpcAdapterError> {
        let record = self.process_record(&params.process_id, &params.registration_id)?;
        let registration = record
            .broker_registration
            .ok_or_else(|| RpcAdapterError::UnknownRegistration(params.registration_id.clone()))?;
        self.broker
            .release(registration)
            .map_err(RpcAdapterError::from)
    }

    pub fn cancel(
        &mut self,
        params: crate::rpc::protocol::ProcessCancelParams,
    ) -> Result<ReleaseOutcome, RpcAdapterError> {
        let state = lock_state(&self.state);
        let process_id = state
            .attempts
            .get(&params.attempt_id)
            .cloned()
            .ok_or_else(|| RpcAdapterError::UnknownAttempt(params.attempt_id.clone()))?;
        let record = state
            .processes
            .get(&process_id)
            .cloned()
            .ok_or_else(|| RpcAdapterError::UnknownProcess(process_id.clone()))?;
        self.broker
            .cancel(record.broker_attempt)
            .map_err(RpcAdapterError::from)
    }

    /// Converts the next native event into a shell-to-host notification.
    pub fn next_event(&mut self) -> Option<Result<RpcNotification, RpcAdapterError>> {
        self.subscribe_events().next()
    }

    /// Converts one already-queued native event without blocking the caller.
    pub fn try_next_event(&mut self) -> Option<Result<RpcNotification, RpcAdapterError>> {
        self.subscribe_events().try_next()
    }

    pub fn transport_close(&mut self) -> Result<(), RpcAdapterError> {
        let cleanup_error = self
            .broker
            .transport_close()
            .into_iter()
            .find_map(|(_, result)| result.err());
        let mut state = lock_state(&self.state);
        state.attempts.clear();
        state.processes.clear();
        state.registrations.clear();
        cleanup_error.map_or(Ok(()), |error| Err(error.into()))
    }

    fn process_record(
        &self,
        process_id: &str,
        registration_id: &str,
    ) -> Result<ProcessRecord, RpcAdapterError> {
        let state = lock_state(&self.state);
        let record = state
            .processes
            .get(process_id)
            .ok_or_else(|| RpcAdapterError::UnknownProcess(process_id.to_owned()))?;
        if record.registration_id.as_deref() != Some(registration_id) {
            return Err(RpcAdapterError::UnknownRegistration(
                registration_id.to_owned(),
            ));
        }
        Ok(record.clone())
    }
}

fn lock_state(state: &Mutex<ProcessState>) -> MutexGuard<'_, ProcessState> {
    match state.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

fn event_to_notification(
    state: &mut ProcessState,
    event: BrokerEvent,
) -> Result<RpcNotification, RpcAdapterError> {
    let (attempt, registration) = match &event {
        BrokerEvent::Output {
            attempt_id,
            registration_id,
            ..
        }
        | BrokerEvent::Exit {
            attempt_id,
            registration_id,
            ..
        } => (*attempt_id, *registration_id),
    };
    let record = state
        .processes
        .values()
        .find(|record| {
            record.broker_attempt == attempt
                && (registration.is_none() || record.broker_registration == registration)
        })
        .cloned()
        .ok_or_else(|| RpcAdapterError::UnknownAttempt(attempt.to_string()))?;
    match event {
        BrokerEvent::Output {
            stream,
            sequence,
            bytes,
            ..
        } => Ok(RpcNotification {
            jsonrpc: crate::rpc::protocol::JsonRpcVersion::V2,
            method: RpcMethod::ProcessOutput,
            params: Some(RpcParams::ProcessOutput(ProcessOutputParams {
                process_id: record.process_id,
                fd: match stream {
                    super::OutputStream::Stdout => 1,
                    super::OutputStream::Stderr => 2,
                    super::OutputStream::Additional(fd) => fd,
                },
                sequence,
                bytes_base64: encode_base64(&bytes),
            })),
        }),
        BrokerEvent::Exit { status, .. } => {
            state.attempts.remove(&record.attempt_id);
            if let Some(registration_id) = &record.registration_id {
                state.registrations.remove(registration_id);
            }
            state.processes.remove(&record.process_id);
            Ok(RpcNotification {
                jsonrpc: crate::rpc::protocol::JsonRpcVersion::V2,
                method: RpcMethod::ProcessExit,
                params: Some(RpcParams::ProcessExit(ProcessExitParams {
                    process_id: record.process_id,
                    code: RequiredNullable(status.code.map(i64::from)),
                    signal: status.signal.map(|signal| signal.to_string()),
                })),
            })
        }
    }
}

fn spawn_request(params: &ProcessSpawnParams) -> Result<SpawnRequest, RpcAdapterError> {
    if params.attempt_id.is_empty() || params.command.is_empty() {
        return Err(RpcAdapterError::InvalidRequest(
            "attemptId and command must be non-empty".to_owned(),
        ));
    }
    for (name, mode) in [
        ("stdin", params.stdin),
        ("stdout", params.stdout),
        ("stderr", params.stderr),
    ] {
        if mode != ProcessStreamMode::Pipe {
            return Err(RpcAdapterError::InvalidRequest(format!(
                "{name} mode null is unsupported by the native broker"
            )));
        }
    }
    let mut additional_fds = Vec::with_capacity(params.additional_fds.len());
    for descriptor in &params.additional_fds {
        let direction = match descriptor.direction {
            ProcessFdDirection::Input => AdditionalFdDirection::Input,
            ProcessFdDirection::Output => AdditionalFdDirection::Output,
        };
        additional_fds.push(AdditionalFdSpec {
            fd: descriptor.fd,
            direction,
        });
    }
    super::broker::validate_additional_fds(&additional_fds).map_err(|error| match error {
        BrokerError::InvalidRequest(message) => RpcAdapterError::InvalidRequest(message),
        other => RpcAdapterError::Broker(other.to_string()),
    })?;
    let kind = match &params.kind {
        ProcessKind::Server => NativeProcessKind::Server,
        ProcessKind::Ssh => NativeProcessKind::Ssh,
        ProcessKind::Wsl => NativeProcessKind::Wsl,
        ProcessKind::Other => NativeProcessKind::Other,
    };
    let mut request = SpawnRequest::new(PathBuf::from(&params.command))
        .with_args(params.args.iter().map(OsString::from))
        .with_kind(kind);
    request.cwd = params.cwd.as_ref().map(PathBuf::from);
    request.clear_env = !params.extend_env;
    request.env = params
        .env
        .iter()
        .map(|(key, value)| (OsString::from(key), OsString::from(value)))
        .collect();
    request.additional_fds = additional_fds;
    Ok(request)
}

fn decode_base64(value: &str) -> Result<Vec<u8>, RpcAdapterError> {
    if value.is_empty() {
        return Ok(Vec::new());
    }
    let bytes = value.as_bytes();
    if bytes.len() % 4 != 0 {
        return Err(RpcAdapterError::InvalidBase64);
    }
    let mut output = Vec::with_capacity(bytes.len() / 4 * 3);
    for chunk in bytes.chunks_exact(4) {
        let a = base64_value(chunk[0])?;
        let b = base64_value(chunk[1])?;
        let c = if chunk[2] == b'=' {
            0
        } else {
            base64_value(chunk[2])?
        };
        let d = if chunk[3] == b'=' {
            0
        } else {
            base64_value(chunk[3])?
        };
        if chunk[2] == b'=' && chunk[3] != b'=' {
            return Err(RpcAdapterError::InvalidBase64);
        }
        output.push((a << 2) | (b >> 4));
        if chunk[2] != b'=' {
            output.push((b << 4) | (c >> 2));
        }
        if chunk[3] != b'=' {
            output.push((c << 6) | d);
        }
    }
    Ok(output)
}

fn base64_value(value: u8) -> Result<u8, RpcAdapterError> {
    match value {
        b'A'..=b'Z' => Ok(value - b'A'),
        b'a'..=b'z' => Ok(value - b'a' + 26),
        b'0'..=b'9' => Ok(value - b'0' + 52),
        b'+' => Ok(62),
        b'/' => Ok(63),
        _ => Err(RpcAdapterError::InvalidBase64),
    }
}

fn encode_base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let a = chunk[0];
        let b = chunk.get(1).copied().unwrap_or(0);
        let c = chunk.get(2).copied().unwrap_or(0);
        output.push(TABLE[(a >> 2) as usize] as char);
        output.push(TABLE[((a << 4 | b >> 4) & 0x3f) as usize] as char);
        output.push(if chunk.len() > 1 {
            TABLE[((b << 2 | c >> 6) & 0x3f) as usize] as char
        } else {
            '='
        });
        output.push(if chunk.len() > 2 {
            TABLE[(c & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::BrokerConfig;
    use crate::rpc::protocol::ProcessAdditionalFd;
    use std::collections::BTreeMap;
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;

    fn params(command: &str, args: &[&str]) -> ProcessSpawnParams {
        ProcessSpawnParams {
            attempt_id: "attempt-test".to_owned(),
            kind: ProcessKind::Other,
            command: command.to_owned(),
            args: args.iter().map(|value| (*value).to_owned()).collect(),
            cwd: None,
            env: BTreeMap::new(),
            extend_env: true,
            stdin: ProcessStreamMode::Pipe,
            stdout: ProcessStreamMode::Pipe,
            stderr: ProcessStreamMode::Pipe,
            additional_fds: Vec::new(),
        }
    }

    fn long_running_params() -> ProcessSpawnParams {
        #[cfg(windows)]
        {
            params("ping", &["127.0.0.1", "-n", "60"])
        }
        #[cfg(not(windows))]
        {
            params("sleep", &["60"])
        }
    }

    #[test]
    fn rejects_stream_shapes_the_native_broker_cannot_preserve() {
        let mut null_stream = params("ignored", &[]);
        null_stream.stdin = ProcessStreamMode::Null;
        assert!(matches!(
            spawn_request(&null_stream),
            Err(RpcAdapterError::InvalidRequest(_))
        ));

        let mut extra_fd = params("ignored", &[]);
        extra_fd.additional_fds.push(ProcessAdditionalFd {
            fd: 3,
            direction: ProcessFdDirection::Output,
        });
        #[cfg(unix)]
        assert!(spawn_request(&extra_fd).is_ok());
        #[cfg(not(unix))]
        assert!(matches!(
            spawn_request(&extra_fd),
            Err(RpcAdapterError::InvalidRequest(_))
        ));
    }

    #[test]
    fn rejects_invalid_additional_fd_shapes_before_spawn() {
        let mut below_stdio = params("ignored", &[]);
        below_stdio.additional_fds.push(ProcessAdditionalFd {
            fd: 2,
            direction: ProcessFdDirection::Output,
        });
        assert!(matches!(
            spawn_request(&below_stdio),
            Err(RpcAdapterError::InvalidRequest(_))
        ));

        let mut duplicate = params("ignored", &[]);
        duplicate.additional_fds.extend([
            ProcessAdditionalFd {
                fd: 3,
                direction: ProcessFdDirection::Input,
            },
            ProcessAdditionalFd {
                fd: 3,
                direction: ProcessFdDirection::Output,
            },
        ]);
        assert!(matches!(
            spawn_request(&duplicate),
            Err(RpcAdapterError::InvalidRequest(_))
        ));
    }

    #[test]
    fn base64_codec_round_trips_binary_chunks_and_rejects_bad_padding() {
        let bytes = [0_u8, 1, 2, 127, 128, 255];
        assert_eq!(decode_base64(&encode_base64(&bytes)), Ok(bytes.to_vec()));
        assert_eq!(decode_base64("a==="), Err(RpcAdapterError::InvalidBase64));
    }

    #[test]
    fn blocked_receiver_does_not_hold_adapter_during_spawn_or_cancel() {
        let mut adapter = RpcProcessBroker::new(ProcessBroker::new(BrokerConfig::default()));
        let receiver = adapter.subscribe_events();
        let (ready_tx, ready_rx) = mpsc::channel();
        let consumer = thread::spawn(move || {
            ready_tx.send(()).expect("consumer starts");
            receiver.next()
        });
        ready_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("consumer reached blocking receive");

        let spawned = adapter
            .spawn(long_running_params())
            .expect("spawn is independent of the blocked receiver");
        let outcome = adapter
            .cancel(crate::rpc::protocol::ProcessCancelParams {
                attempt_id: "attempt-test".to_owned(),
            })
            .expect("control is independent of the blocked receiver");
        assert!(matches!(
            outcome,
            ReleaseOutcome::Terminated | ReleaseOutcome::AlreadyExited
        ));

        let event = consumer
            .join()
            .expect("consumer thread joins")
            .expect("cancellation emits an event")
            .expect("event maps to RPC");
        assert!(matches!(
            event.params,
            Some(RpcParams::ProcessExit(ProcessExitParams { process_id, .. }))
                if process_id == spawned.process_id
        ));
    }

    #[test]
    fn blocked_receiver_wakes_when_transport_closes() {
        let mut adapter = RpcProcessBroker::new(ProcessBroker::new(BrokerConfig::default()));
        let receiver = adapter.subscribe_events();
        let (ready_tx, ready_rx) = mpsc::channel();
        let consumer = thread::spawn(move || {
            ready_tx.send(()).expect("consumer starts");
            receiver.next()
        });
        ready_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("consumer reached blocking receive");

        let _ = adapter.transport_close();
        assert!(consumer.join().expect("consumer thread joins").is_none());
    }

    #[test]
    fn maps_native_output_and_exit_to_shell_minted_process_ids() {
        #[cfg(windows)]
        let request = params("cmd", &["/D", "/C", "<nul set /p =broker-output"]);
        #[cfg(not(windows))]
        let request = params("sh", &["-c", "printf broker-output"]);

        let mut adapter = RpcProcessBroker::new(ProcessBroker::new(BrokerConfig::default()));
        let spawned = adapter.spawn(request).expect("fixture process spawns");
        assert!(spawned.process_id.starts_with("process-"));

        let first = adapter
            .next_event()
            .expect("fixture emits an event")
            .expect("event maps to RPC");
        assert!(matches!(
            first.params,
            Some(RpcParams::ProcessOutput(ProcessOutputParams { ref process_id, .. }))
                if process_id == &spawned.process_id
        ));

        let mut saw_exit = false;
        for _ in 0..3 {
            let event = adapter
                .next_event()
                .expect("fixture emits terminal events")
                .expect("event maps to RPC");
            if matches!(event.params, Some(RpcParams::ProcessExit(_))) {
                saw_exit = true;
                break;
            }
        }
        assert!(saw_exit);
    }

    #[cfg(unix)]
    #[test]
    fn maps_additional_output_fd_to_its_wire_descriptor() {
        let mut request = params("sh", &["-c", "printf extra >&3"]);
        request.additional_fds.push(ProcessAdditionalFd {
            fd: 3,
            direction: ProcessFdDirection::Output,
        });
        let mut adapter = RpcProcessBroker::new(ProcessBroker::new(BrokerConfig::default()));
        let spawned = adapter.spawn(request).expect("fixture process spawns");
        let mut saw_extra = false;
        for _ in 0..4 {
            let event = adapter
                .next_event()
                .expect("fixture emits events")
                .expect("event maps to RPC");
            match event.params {
                Some(RpcParams::ProcessOutput(ProcessOutputParams {
                    process_id,
                    fd,
                    bytes_base64,
                    ..
                })) if process_id == spawned.process_id => {
                    if fd == 3 {
                        saw_extra = true;
                        assert_eq!(decode_base64(&bytes_base64), Ok(b"extra".to_vec()));
                        break;
                    }
                }
                _ => {}
            }
        }
        assert!(saw_extra);
    }

    #[cfg(unix)]
    #[test]
    fn writes_process_input_to_configured_additional_fd() {
        let mut request = params(
            "sh",
            &["-c", "IFS= read -r line <&4; printf '%s' \"$line\""],
        );
        request.additional_fds.push(ProcessAdditionalFd {
            fd: 4,
            direction: ProcessFdDirection::Input,
        });
        let mut adapter = RpcProcessBroker::new(ProcessBroker::new(BrokerConfig::default()));
        let spawned = adapter.spawn(request).expect("fixture process spawns");
        let registration_id = spawned
            .registration_id
            .0
            .expect("fixture remains registered");
        let outcome = adapter
            .input(ProcessInputParams {
                process_id: spawned.process_id.clone(),
                registration_id,
                fd: 4,
                bytes_base64: encode_base64(b"hello\n"),
            })
            .expect("additional input is accepted");
        assert_eq!(outcome, StdinOutcome::Written(6));
        let mut saw_output = false;
        for _ in 0..4 {
            let event = adapter
                .next_event()
                .expect("fixture emits events")
                .expect("event maps to RPC");
            if let Some(RpcParams::ProcessOutput(ProcessOutputParams {
                process_id,
                fd,
                bytes_base64,
                ..
            })) = event.params
            {
                if process_id == spawned.process_id && fd == 1 {
                    saw_output = true;
                    assert_eq!(decode_base64(&bytes_base64), Ok(b"hello".to_vec()));
                    break;
                }
            }
        }
        assert!(saw_output);
    }
}
