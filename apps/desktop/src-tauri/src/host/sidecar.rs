//! Native Node host sidecar supervision.
//!
//! The supervisor owns one concrete [`std::process::Child`] and one framed
//! JSON-RPC peer.  It deliberately uses blocking std I/O so the Tauri shell
//! does not need an async runtime just to supervise its host.

use std::collections::VecDeque;
use std::ffi::OsString;
use std::fmt;
use std::io::{self, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::rpc::peer::{Peer, PeerCloseReason, PeerError, PeerEvent, PeerRole};
use crate::rpc::protocol::{
    IpcInvokeParams, JsonRpcVersion, RpcEnvelope, RpcError, RpcErrorData, RpcErrorKind, RpcId,
    RpcMethod, RpcNotification, RpcParams, RpcRequest, RpcResponse, RpcResult, RpcSuccessResponse,
    ShellHelloResult,
};
use crate::rpc::transport::encode;

const HELLO_TIMEOUT: Duration = Duration::from_secs(15);

/// Configuration for the pinned Node sidecar.
#[derive(Debug, Clone)]
pub struct SidecarSpawnSpec {
    /// Absolute path to the pinned Node executable.
    pub node_executable: PathBuf,
    /// Absolute path to the staged host entrypoint.
    pub host_script: PathBuf,
    /// Optional working directory for the host.
    pub current_dir: Option<PathBuf>,
    /// Additional environment entries. `NODE_OPTIONS` and `NODE_PATH` are
    /// always removed after applying this list.
    pub environment: Vec<(OsString, OsString)>,
}

impl SidecarSpawnSpec {
    #[must_use]
    pub fn command(&self) -> Command {
        let mut command = Command::new(&self.node_executable);
        command
            .arg("--no-global-search-paths")
            .arg(&self.host_script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .env_remove("NODE_OPTIONS")
            .env_remove("NODE_PATH");
        if let Some(current_dir) = &self.current_dir {
            command.current_dir(current_dir);
        }
        for (key, value) in &self.environment {
            if key != "NODE_OPTIONS" && key != "NODE_PATH" {
                command.env(key, value);
            }
        }
        command
    }
}

/// Callbacks for host requests, notifications, and lifecycle.
pub struct SidecarHandlers {
    /// Handles host-originated requests such as `process.spawn`.
    pub request: Arc<dyn Fn(RpcRequest) -> Result<RpcResult, RpcError> + Send + Sync>,
    /// Handles host-originated notifications.
    pub notification: Arc<dyn Fn(RpcNotification) + Send + Sync>,
    /// Receives `ipc.push` notifications.
    pub ipc_push: Arc<dyn Fn(IpcInvokeParams) + Send + Sync>,
    /// Called once when the sidecar closes unexpectedly or is shut down.
    pub unexpected_close: Arc<dyn Fn(PeerCloseReason) + Send + Sync>,
}

impl Default for SidecarHandlers {
    fn default() -> Self {
        Self {
            request: Arc::new(|request| {
                Err(RpcError {
                    code: -32601,
                    message: format!("unsupported host request: {:?}", request.method),
                    data: Some(RpcErrorData {
                        kind: RpcErrorKind::Unsupported,
                    }),
                })
            }),
            notification: Arc::new(|_| {}),
            ipc_push: Arc::new(|_| {}),
            unexpected_close: Arc::new(|_| {}),
        }
    }
}

impl fmt::Debug for SidecarHandlers {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SidecarHandlers(..)")
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SidecarError {
    Spawn(String),
    Io(String),
    Peer(String),
    Closed,
    Timeout,
    QueueFull,
    Response(String),
}

impl fmt::Display for SidecarError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Spawn(message) => write!(formatter, "sidecar spawn failed: {message}"),
            Self::Io(message) => write!(formatter, "sidecar I/O failed: {message}"),
            Self::Peer(message) => write!(formatter, "sidecar RPC failed: {message}"),
            Self::Closed => formatter.write_str("sidecar is closed"),
            Self::Timeout => formatter.write_str("sidecar request timed out"),
            Self::QueueFull => formatter.write_str("sidecar renderer queue is full"),
            Self::Response(message) => write!(formatter, "sidecar response failed: {message}"),
        }
    }
}

impl std::error::Error for SidecarError {}

struct Waiter {
    result: Mutex<Option<Result<RpcEnvelope, SidecarError>>>,
    wake: Condvar,
}

impl Waiter {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            result: Mutex::new(None),
            wake: Condvar::new(),
        })
    }

    fn complete(&self, result: Result<RpcEnvelope, SidecarError>) {
        if let Ok(mut slot) = self.result.lock() {
            *slot = Some(result);
            self.wake.notify_all();
        }
    }

    fn wait(&self, timeout: Duration) -> Result<RpcEnvelope, SidecarError> {
        let deadline = Instant::now() + timeout;
        let mut slot = self.result.lock().map_err(|_| SidecarError::Closed)?;
        loop {
            if let Some(result) = slot.take() {
                return result;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(SidecarError::Timeout);
            }
            let (next, timeout_result) = self
                .wake
                .wait_timeout(slot, remaining)
                .map_err(|_| SidecarError::Closed)?;
            slot = next;
            if timeout_result.timed_out() {
                return Err(SidecarError::Timeout);
            }
        }
    }
}

struct RuntimeState {
    peer: Peer,
    stdin: ChildStdin,
    waiters: std::collections::HashMap<RpcId, Arc<Waiter>>,
    queued_waiters: VecDeque<Arc<Waiter>>,
}

struct Shared {
    state: Mutex<Option<RuntimeState>>,
    child: Mutex<Option<Child>>,
    closed: AtomicBool,
    handlers: SidecarHandlers,
}

/// A thread-safe, synchronous API for the Tauri command layer.
pub struct SidecarSupervisor {
    shared: Arc<Shared>,
}

impl fmt::Debug for SidecarSupervisor {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SidecarSupervisor(..)")
    }
}

impl SidecarSupervisor {
    /// Starts the pinned Node sidecar and its stdout reader.
    pub fn spawn(
        spec: SidecarSpawnSpec,
        hello: ShellHelloResult,
        handlers: SidecarHandlers,
    ) -> Result<Self, SidecarError> {
        let mut child = spec
            .command()
            .spawn()
            .map_err(|error| SidecarError::Spawn(error.to_string()))?;
        let Some(stdin) = child.stdin.take() else {
            terminate_retained_child(&mut child);
            return Err(SidecarError::Spawn(
                "sidecar stdin was not piped".to_owned(),
            ));
        };
        let Some(stdout) = child.stdout.take() else {
            terminate_retained_child(&mut child);
            return Err(SidecarError::Spawn(
                "sidecar stdout was not piped".to_owned(),
            ));
        };
        let shared = Arc::new(Shared {
            state: Mutex::new(Some(RuntimeState {
                peer: Peer::new(PeerRole::Shell, 0, Some(hello)),
                stdin,
                waiters: std::collections::HashMap::new(),
                queued_waiters: VecDeque::new(),
            })),
            child: Mutex::new(Some(child)),
            closed: AtomicBool::new(false),
            handlers,
        });
        spawn_reader(Arc::clone(&shared), stdout);
        spawn_watchdog(Arc::clone(&shared));
        Ok(Self { shared })
    }

    /// Sends a typed request and waits synchronously for its response.
    pub fn request(
        &self,
        method: RpcMethod,
        params: Option<RpcParams>,
        timeout: Duration,
    ) -> Result<RpcEnvelope, SidecarError> {
        let waiter = Waiter::new();
        let id = {
            let mut guard = self.shared.state.lock().map_err(|_| SidecarError::Closed)?;
            let state = guard.as_mut().ok_or(SidecarError::Closed)?;
            let (id, event) = state
                .peer
                .request(method, params, now_ms())
                .map_err(peer_error)?;
            state.waiters.insert(id, Arc::clone(&waiter));
            write_event(state, event).inspect_err(|_error| {
                state.waiters.remove(&id);
            })?;
            id
        };
        let result = waiter.wait(timeout);
        if matches!(result, Err(SidecarError::Timeout)) {
            let _ = self.cancel(id);
        }
        result
    }

    /// Sends a renderer IPC invoke. Before hello it is queued by `Peer`, with
    /// a hard limit of 256 entries and a 20-second expiry window.
    pub fn invoke(
        &self,
        channel: impl Into<String>,
        payload: Value,
        timeout: Duration,
    ) -> Result<RpcEnvelope, SidecarError> {
        let waiter = Waiter::new();
        let bound_id = {
            let mut guard = self.shared.state.lock().map_err(|_| SidecarError::Closed)?;
            let state = guard.as_mut().ok_or(SidecarError::Closed)?;
            let queued_before = state.peer.pre_ready_len();
            let event = state
                .peer
                .queue_renderer_invoke(channel, payload, now_ms())
                .map_err(peer_error)?;
            let queued_after = state.peer.pre_ready_len();
            let expired = queued_before.saturating_sub(queued_after.saturating_sub(1));
            for _ in 0..expired {
                if let Some(expired_waiter) = state.queued_waiters.pop_front() {
                    expired_waiter.complete(Err(SidecarError::Timeout));
                }
            }
            state.queued_waiters.push_back(Arc::clone(&waiter));
            if let Some(event) = event {
                bind_outgoing_waiter(state, event)?
            } else {
                None
            }
        };
        let result = waiter.wait(timeout);
        if matches!(result, Err(SidecarError::Timeout)) {
            let mut guard = self.shared.state.lock().map_err(|_| SidecarError::Closed)?;
            let state = guard.as_mut().ok_or(SidecarError::Closed)?;
            state
                .queued_waiters
                .retain(|queued| !Arc::ptr_eq(queued, &waiter));
            let id = bound_id.or_else(|| {
                state
                    .waiters
                    .iter()
                    .find_map(|(id, pending)| Arc::ptr_eq(pending, &waiter).then_some(*id))
            });
            if let Some(id) = id {
                state.waiters.remove(&id);
                for event in state.peer.cancel_request(id).map_err(peer_error)? {
                    write_event(state, event)?;
                }
            }
        }
        result
    }

    /// Sends a notification.
    pub fn notify(&self, method: RpcMethod, params: Option<RpcParams>) -> Result<(), SidecarError> {
        let mut guard = self.shared.state.lock().map_err(|_| SidecarError::Closed)?;
        let state = guard.as_mut().ok_or(SidecarError::Closed)?;
        let event = state.peer.notify(method, params).map_err(peer_error)?;
        write_event(state, event)
    }

    /// Cancels an in-flight request.
    pub fn cancel(&self, id: RpcId) -> Result<(), SidecarError> {
        let mut guard = self.shared.state.lock().map_err(|_| SidecarError::Closed)?;
        let state = guard.as_mut().ok_or(SidecarError::Closed)?;
        for event in state.peer.cancel_request(id).map_err(peer_error)? {
            if let PeerEvent::RequestCancelled(cancelled) = &event {
                if let Some(waiter) = state.waiters.remove(cancelled) {
                    waiter.complete(Err(SidecarError::Timeout));
                }
            }
            write_event(state, event)?;
        }
        Ok(())
    }

    /// Closes the transport and terminates the retained child handle.
    pub fn shutdown(&self) -> Result<(), SidecarError> {
        close_shared(
            &self.shared,
            PeerCloseReason::Local("sidecar shutdown".to_owned()),
            true,
        )
    }
}

impl Drop for SidecarSupervisor {
    fn drop(&mut self) {
        let _ = self.shutdown();
    }
}

fn spawn_reader(shared: Arc<Shared>, mut stdout: ChildStdout) {
    thread::spawn(move || {
        let mut buffer = [0_u8; 16 * 1024];
        loop {
            match stdout.read(&mut buffer) {
                Ok(0) => {
                    let _ = close_shared(
                        &shared,
                        PeerCloseReason::Transport(crate::rpc::transport::TransportError::Closed),
                        true,
                    );
                    break;
                }
                Ok(size) => {
                    if process_bytes(&shared, &buffer[..size]).is_err() {
                        break;
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                Err(error) => {
                    let _ = close_shared(
                        &shared,
                        PeerCloseReason::Transport(crate::rpc::transport::TransportError::Closed),
                        true,
                    );
                    let _ = error;
                    break;
                }
            }
        }
    });
}

fn spawn_watchdog(shared: Arc<Shared>) {
    thread::spawn(move || {
        thread::sleep(HELLO_TIMEOUT);
        if shared.closed.load(Ordering::Acquire) {
            return;
        }
        let should_close = shared
            .state
            .lock()
            .ok()
            .and_then(|guard| guard.as_ref().map(|state| state.peer.state()))
            .is_some_and(|state| state != crate::rpc::peer::PeerState::Ready);
        if should_close {
            let _ = close_shared(&shared, PeerCloseReason::HelloTimeout, true);
        }
    });
}

fn process_bytes(shared: &Arc<Shared>, bytes: &[u8]) -> Result<(), SidecarError> {
    let events = {
        let mut guard = shared.state.lock().map_err(|_| SidecarError::Closed)?;
        let state = guard.as_mut().ok_or(SidecarError::Closed)?;
        state.peer.receive(bytes, now_ms()).map_err(peer_error)?
    };
    dispatch_events(shared, events)
}

fn dispatch_events(shared: &Arc<Shared>, events: Vec<PeerEvent>) -> Result<(), SidecarError> {
    for event in events {
        match event {
            PeerEvent::Outgoing(frame) => {
                let mut guard = shared.state.lock().map_err(|_| SidecarError::Closed)?;
                let state = guard.as_mut().ok_or(SidecarError::Closed)?;
                bind_outgoing_waiter(state, PeerEvent::Outgoing(frame))?;
            }
            PeerEvent::Incoming(envelope) => dispatch_incoming(shared, *envelope)?,
            PeerEvent::Ready => {
                // Queued renderer invokes follow Ready in the same peer event
                // batch and are bound by the ordinary Outgoing arm.
            }
            PeerEvent::Closed {
                reason,
                pending: _,
                unexpected_host_close: _,
            } => {
                close_shared(shared, reason, true)?;
                return Err(SidecarError::Closed);
            }
            PeerEvent::PreReadyExpired(count) => {
                let mut guard = shared.state.lock().map_err(|_| SidecarError::Closed)?;
                let state = guard.as_mut().ok_or(SidecarError::Closed)?;
                for _ in 0..count {
                    if let Some(waiter) = state.queued_waiters.pop_front() {
                        waiter.complete(Err(SidecarError::Timeout));
                    }
                }
            }
            PeerEvent::RequestCancelled(id) => {
                let mut guard = shared.state.lock().map_err(|_| SidecarError::Closed)?;
                if let Some(state) = guard.as_mut() {
                    if let Some(waiter) = state.waiters.remove(&id) {
                        waiter.complete(Err(SidecarError::Timeout));
                    }
                }
            }
            PeerEvent::UnknownResponse(_) | PeerEvent::Resynchronized(_) => {}
        }
    }
    Ok(())
}

fn dispatch_incoming(shared: &Arc<Shared>, envelope: RpcEnvelope) -> Result<(), SidecarError> {
    match envelope {
        RpcEnvelope::Response(response) => {
            let id = match &response {
                RpcResponse::Success(success) => success.id,
                RpcResponse::Error(error) => error
                    .id
                    .0
                    .ok_or_else(|| SidecarError::Response("response id was null".to_owned()))?,
            };
            let waiter =
                shared.state.lock().ok().and_then(|mut guard| {
                    guard.as_mut().and_then(|state| state.waiters.remove(&id))
                });
            if let Some(waiter) = waiter {
                waiter.complete(Ok(RpcEnvelope::Response(response)));
            }
        }
        RpcEnvelope::Request(request) => {
            let id = request.id;
            let result = (shared.handlers.request)(request);
            let response = match result {
                Ok(result) => {
                    RpcEnvelope::Response(RpcResponse::Success(Box::new(RpcSuccessResponse {
                        jsonrpc: JsonRpcVersion::V2,
                        id,
                        result,
                    })))
                }
                Err(error) => RpcEnvelope::Response(RpcResponse::Error(
                    crate::rpc::protocol::RpcErrorResponse {
                        jsonrpc: JsonRpcVersion::V2,
                        id: crate::rpc::protocol::RequiredNullable(Some(id)),
                        error,
                    },
                )),
            };
            let frame = encode(&response).map_err(|error| SidecarError::Peer(error.to_string()))?;
            let write_result = write_frame(shared, &frame);
            if let Ok(mut guard) = shared.state.lock()
                && let Some(state) = guard.as_mut()
            {
                state.peer.complete_inbound(id);
            }
            write_result?;
        }
        RpcEnvelope::Notification(notification) => {
            if notification.method == RpcMethod::IpcPush {
                if let Some(RpcParams::IpcPush(params)) = notification.params.as_ref() {
                    (shared.handlers.ipc_push)(params.clone());
                }
            }
            (shared.handlers.notification)(notification);
        }
    }
    Ok(())
}

fn bind_outgoing_waiter(
    state: &mut RuntimeState,
    event: PeerEvent,
) -> Result<Option<RpcId>, SidecarError> {
    let PeerEvent::Outgoing(frame) = event else {
        return Ok(None);
    };
    let envelope = decode_frame(&frame)?;
    let RpcEnvelope::Request(request) = envelope else {
        write_event(state, PeerEvent::Outgoing(frame))?;
        return Ok(None);
    };
    if let Some(waiter) = state.queued_waiters.pop_front() {
        state.waiters.insert(request.id, waiter);
    }
    write_event(state, PeerEvent::Outgoing(frame))?;
    Ok(Some(request.id))
}

fn write_event(state: &mut RuntimeState, event: PeerEvent) -> Result<(), SidecarError> {
    if let PeerEvent::Outgoing(frame) = event {
        state
            .stdin
            .write_all(&frame)
            .and_then(|()| state.stdin.flush())
            .map_err(|error| SidecarError::Io(error.to_string()))?;
    }
    Ok(())
}

fn write_frame(shared: &Arc<Shared>, frame: &[u8]) -> Result<(), SidecarError> {
    let mut guard = shared.state.lock().map_err(|_| SidecarError::Closed)?;
    let state = guard.as_mut().ok_or(SidecarError::Closed)?;
    state
        .stdin
        .write_all(frame)
        .and_then(|()| state.stdin.flush())
        .map_err(|error| SidecarError::Io(error.to_string()))
}

fn close_shared(
    shared: &Arc<Shared>,
    reason: PeerCloseReason,
    terminate_child: bool,
) -> Result<(), SidecarError> {
    if shared.closed.swap(true, Ordering::AcqRel) {
        return Ok(());
    }
    let pending = {
        let mut guard = shared.state.lock().map_err(|_| SidecarError::Closed)?;
        let state = guard.as_mut().ok_or(SidecarError::Closed)?;
        state.peer.close(reason.clone());
        state
            .waiters
            .drain()
            .map(|(_, waiter)| waiter)
            .chain(state.queued_waiters.drain(..))
            .collect::<Vec<_>>()
    };
    for waiter in pending {
        waiter.complete(Err(SidecarError::Peer(format!("{reason:?}"))));
    }
    if let Ok(mut child_guard) = shared.child.lock() {
        if let Some(mut child) = child_guard.take() {
            if terminate_child {
                terminate_retained_child(&mut child);
            }
            let _ = child.wait();
        }
    }
    if !matches!(reason, PeerCloseReason::Local(_)) {
        (shared.handlers.unexpected_close)(reason);
    }
    Ok(())
}

fn terminate_retained_child(child: &mut Child) {
    match child.try_wait() {
        Ok(Some(_)) => {}
        Ok(None) | Err(_) => {
            // An unreaped Unix child keeps its pid reserved, so signalling
            // through this retained handle cannot target a recycled pid.
            let _ = child.kill();
        }
    }
    let _ = child.wait();
}

fn decode_frame(frame: &[u8]) -> Result<RpcEnvelope, SidecarError> {
    let mut decoder = crate::rpc::transport::FrameDecoder::new();
    decoder
        .feed(frame)
        .into_iter()
        .find_map(|event| match event {
            crate::rpc::transport::DecoderEvent::Frame(frame) => {
                crate::rpc::protocol::decode_envelope(&frame.json).ok()
            }
            _ => None,
        })
        .ok_or_else(|| SidecarError::Peer("generated frame could not be decoded".to_owned()))
}

fn peer_error(error: PeerError) -> SidecarError {
    match error {
        PeerError::Closed => SidecarError::Closed,
        PeerError::PreReadyQueueLimit { .. } => SidecarError::QueueFull,
        other => SidecarError::Peer(other.to_string()),
    }
}

fn now_ms() -> u64 {
    static START: OnceLock<Instant> = OnceLock::new();
    START
        .get_or_init(Instant::now)
        .elapsed()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::protocol::RpcNotification;

    #[test]
    fn sidecar_command_uses_the_pinned_entry_and_strips_node_injection() {
        let spec = SidecarSpawnSpec {
            node_executable: PathBuf::from("agent-nanoni-node"),
            host_script: PathBuf::from("resources/host/host.cjs"),
            current_dir: Some(PathBuf::from("resources")),
            environment: vec![
                (OsString::from("NODE_OPTIONS"), OsString::from("--inspect")),
                (OsString::from("NODE_PATH"), OsString::from("untrusted")),
                (OsString::from("T3CODE_HOME"), OsString::from("state")),
            ],
        };

        let command = spec.command();
        let args = command
            .get_args()
            .map(|value| value.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert_eq!(
            args,
            vec![
                "--no-global-search-paths".to_owned(),
                "resources/host/host.cjs".to_owned(),
            ]
        );
        let environment = command
            .get_envs()
            .map(|(key, value)| {
                (
                    key.to_string_lossy().into_owned(),
                    value.map(|value| value.to_string_lossy().into_owned()),
                )
            })
            .collect::<std::collections::HashMap<_, _>>();
        assert_eq!(environment.get("NODE_OPTIONS"), Some(&None));
        assert_eq!(environment.get("NODE_PATH"), Some(&None));
        assert_eq!(
            environment.get("T3CODE_HOME"),
            Some(&Some("state".to_owned()))
        );
    }

    #[test]
    fn generated_frames_decode_back_to_the_typed_envelope() {
        let envelope = RpcEnvelope::Notification(RpcNotification {
            jsonrpc: JsonRpcVersion::V2,
            method: RpcMethod::AppQuit,
            params: None,
        });
        let frame = encode(&envelope).expect("fixture envelope encodes");

        assert_eq!(decode_frame(&frame), Ok(envelope));
    }

    #[test]
    fn waiter_delivers_one_completed_response_without_polling() {
        let waiter = Waiter::new();
        let envelope = RpcEnvelope::Notification(RpcNotification {
            jsonrpc: JsonRpcVersion::V2,
            method: RpcMethod::AppQuit,
            params: None,
        });
        waiter.complete(Ok(envelope.clone()));

        assert_eq!(waiter.wait(Duration::from_millis(1)), Ok(envelope));
    }
}
