//! Native process broker.
//!
//! This module is the shell side of the process registration transaction.  A
//! `Child` is stored before [`ProcessBroker::spawn`] returns; registration is a
//! separate acknowledgement step and can therefore be cancelled safely.  The
//! broker never accepts a shell command string and always creates a direct
//! child with `detached: false` semantics.

use super::identity::{
    IdentityBackend, IdentityError, NativeIdentityBackend, ProcessIdentity, TerminateResult,
};
use std::collections::{HashMap, HashSet, VecDeque};
use std::ffi::OsString;
use std::fs::File;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, SystemTime};

#[cfg(unix)]
use command_fds::{CommandFdExt, FdMapping};
#[cfg(any(
    target_os = "android",
    target_os = "freebsd",
    target_os = "haiku",
    target_os = "linux"
))]
use nix::sys::wait::{Id, WaitPidFlag, WaitStatus, waitid};
#[cfg(target_os = "macos")]
use nix::sys::wait::{WaitPidFlag, WaitStatus, waitpid};
#[cfg(unix)]
use nix::unistd::pipe;
#[cfg(unix)]
use nix::{
    sys::signal::{Signal, killpg},
    unistd::{Pid, getpgid},
};
#[cfg(unix)]
use std::os::unix::process::CommandExt;

/// A process output chunk is never larger than this value.
pub const MAX_OUTPUT_CHUNK_BYTES: usize = 64 * 1024;

/// The maximum number of non-stdio descriptors accepted for one child.
///
/// The protocol currently needs only descriptors 3, 4, and 5.  Keeping a
/// small finite bound prevents a hostile request from allocating an
/// unbounded number of native pipes before the child is even created.
pub const MAX_ADDITIONAL_FDS: usize = 16;

/// Logical process categories understood by the shell.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ProcessKind {
    Server,
    Ssh,
    Wsl,
    Other,
}

/// Which native stream produced an output event.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum OutputStream {
    Stdout,
    Stderr,
    Additional(u32),
}

/// Direction of a descriptor requested in [`SpawnRequest::additional_fds`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AdditionalFdDirection {
    Input,
    Output,
}

/// A descriptor inherited by the child and exposed through broker events or
/// `process.input` writes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct AdditionalFdSpec {
    pub fd: u32,
    pub direction: AdditionalFdDirection,
}

/// Opaque token minted by the shell for a pending spawn transaction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct AttemptToken(u128);

impl AttemptToken {
    #[must_use]
    pub fn to_wire(self) -> String {
        format!("attempt-{:032x}", self.0)
    }
}

impl std::fmt::Display for AttemptToken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.to_wire())
    }
}

/// Opaque token minted by the shell after a child has been registered.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct RegistrationToken(u128);

impl RegistrationToken {
    #[must_use]
    pub fn to_wire(self) -> String {
        format!("registration-{:032x}", self.0)
    }
}

impl std::fmt::Display for RegistrationToken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.to_wire())
    }
}

/// Direct-child specification.  There is deliberately no command-string or
/// shell field that can be passed to `Command`.
#[derive(Debug, Clone)]
pub struct SpawnRequest {
    pub executable: PathBuf,
    pub args: Vec<OsString>,
    pub cwd: Option<PathBuf>,
    pub env: Vec<(OsString, OsString)>,
    pub clear_env: bool,
    pub kind: ProcessKind,
    /// Kept as an explicit input so a caller cannot accidentally opt into a
    /// detached child.  `false` is the only accepted value in Phase 0.
    pub detached: bool,
    /// A transport adapter may set this when decoding a hostile request.  It
    /// is rejected before a process is created.
    pub shell: Option<OsString>,
    /// Additional descriptors inherited by the child.  Descriptor numbers
    /// must be >= 3 and unique; stdio is configured separately above.
    pub additional_fds: Vec<AdditionalFdSpec>,
}

impl SpawnRequest {
    #[must_use]
    pub fn new(executable: impl Into<PathBuf>) -> Self {
        Self {
            executable: executable.into(),
            args: Vec::new(),
            cwd: None,
            env: Vec::new(),
            clear_env: false,
            kind: ProcessKind::Other,
            detached: false,
            shell: None,
            additional_fds: Vec::new(),
        }
    }

    #[must_use]
    pub fn with_args<I, T>(mut self, args: I) -> Self
    where
        I: IntoIterator<Item = T>,
        T: Into<OsString>,
    {
        self.args = args.into_iter().map(Into::into).collect();
        self
    }

    #[must_use]
    pub fn with_kind(mut self, kind: ProcessKind) -> Self {
        self.kind = kind;
        self
    }

    #[must_use]
    pub fn with_additional_fds(mut self, additional_fds: Vec<AdditionalFdSpec>) -> Self {
        self.additional_fds = additional_fds;
        self
    }
}

/// Queue and output limits.  A reader blocks while either limit is reached.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BrokerConfig {
    pub max_events: usize,
    pub max_event_bytes: usize,
}

impl Default for BrokerConfig {
    fn default() -> Self {
        Self {
            max_events: 256,
            max_event_bytes: 4 * 1024 * 1024,
        }
    }
}

/// Exit information that can cross the JSON-RPC boundary without carrying an
/// OS-specific `ExitStatus` value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExitStatusInfo {
    pub success: bool,
    pub code: Option<i32>,
    pub signal: Option<i32>,
}

impl ExitStatusInfo {
    fn from_status(status: ExitStatus) -> Self {
        #[cfg(unix)]
        {
            use std::os::unix::process::ExitStatusExt;
            return Self {
                success: status.success(),
                code: status.code(),
                signal: status.signal(),
            };
        }
        #[cfg(not(unix))]
        {
            Self {
                success: status.success(),
                code: status.code(),
                signal: None,
            }
        }
    }
}

/// Events emitted by a managed child.  `sequence` is monotonic across both
/// streams and the exit notification, so the renderer has one total order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BrokerEvent {
    Output {
        attempt_id: AttemptToken,
        registration_id: Option<RegistrationToken>,
        stream: OutputStream,
        sequence: u64,
        bytes: Vec<u8>,
    },
    Exit {
        attempt_id: AttemptToken,
        registration_id: Option<RegistrationToken>,
        sequence: u64,
        status: ExitStatusInfo,
    },
}

impl BrokerEvent {
    fn size(&self) -> usize {
        match self {
            Self::Output { bytes, .. } => bytes.len(),
            Self::Exit { .. } => 64,
        }
    }

    #[cfg(test)]
    fn sequence(&self) -> u64 {
        match self {
            Self::Output { sequence, .. } | Self::Exit { sequence, .. } => *sequence,
        }
    }
}

/// A stream handle for the broker's bounded event queue.
#[derive(Clone)]
pub struct EventStream {
    queue: Arc<EventQueue>,
}

impl EventStream {
    /// Block until an event is available or the queue is closed and drained.
    pub fn next(&self) -> Option<BrokerEvent> {
        self.queue.pop()
    }

    /// Consume an already queued event without waiting.
    pub fn try_next(&self) -> Option<BrokerEvent> {
        self.queue.try_pop()
    }

    /// Close the stream and wake blocked producers/consumers.
    pub fn close(&self) {
        self.queue.close();
    }
}

impl std::fmt::Debug for EventStream {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EventStream").finish_non_exhaustive()
    }
}

/// Returned as soon as the child handle and attempt record are retained.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SpawnedProcess {
    pub attempt_id: AttemptToken,
    pub pid: u32,
    pub kind: ProcessKind,
    pub identity_proven: bool,
}

/// Result of the registration acknowledgement.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RegistrationOutcome {
    pub registration_id: Option<RegistrationToken>,
    pub exited: Option<ExitStatusInfo>,
}

/// Result of release/cancellation.  Releasing the same registration twice is
/// deliberately successful and returns `AlreadyReleased`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReleaseOutcome {
    Terminated,
    AlreadyExited,
    AlreadyReleased,
}

/// Result of an stdin write.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StdinOutcome {
    Written(usize),
    Closed,
}

/// Errors returned by broker operations.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BrokerError {
    Closed,
    InvalidRequest(String),
    Spawn(String),
    StaleAttempt,
    StaleRegistration,
    Identity(IdentityError),
    Io(String),
}

impl std::fmt::Display for BrokerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Closed => f.write_str("process broker is closed"),
            Self::InvalidRequest(message) => write!(f, "invalid process request: {message}"),
            Self::Spawn(message) => write!(f, "process spawn failed: {message}"),
            Self::StaleAttempt => f.write_str("stale process attempt token"),
            Self::StaleRegistration => f.write_str("stale process registration token"),
            Self::Identity(error) => write!(f, "process identity error: {error}"),
            Self::Io(message) => write!(f, "process I/O failed: {message}"),
        }
    }
}

impl std::error::Error for BrokerError {}

struct ProcessRecord {
    attempt_id: AttemptToken,
    identity: ProcessIdentity,
    #[cfg(unix)]
    process_group: ProcessGroup,
    child: Mutex<Child>,
    stdin: Mutex<Option<ChildStdin>>,
    additional_inputs: Mutex<HashMap<u32, File>>,
    state: Mutex<RecordState>,
    /// Serializes non-reaping observation and final cleanup.  The group
    /// leader must remain unreaped until cleanup has sent the group signal;
    /// otherwise a recycled PGID could refer to an unrelated process group.
    reap_gate: Mutex<()>,
    #[cfg(unix)]
    group_cleanup_safe: AtomicBool,
    streams_remaining: AtomicU64,
}

#[derive(Debug, Default)]
struct RecordState {
    registration_id: Option<RegistrationToken>,
    exit: Option<ExitStatusInfo>,
    leader_reaped: bool,
    released: bool,
}

#[derive(Default)]
struct BrokerState {
    attempts: HashMap<AttemptToken, Arc<ProcessRecord>>,
    registrations: HashMap<RegistrationToken, AttemptToken>,
    released_registrations: HashSet<RegistrationToken>,
    cancelled_attempts: HashSet<AttemptToken>,
}

struct BrokerInner {
    state: Mutex<BrokerState>,
    transaction: Mutex<Option<AttemptToken>>,
    transaction_ready: Condvar,
    identity: Arc<dyn IdentityBackend>,
    events: Arc<EventQueue>,
    sequencer: Arc<EventSequencer>,
    next_token: AtomicU64,
    closed: AtomicBool,
    #[cfg(test)]
    registration_barrier: Mutex<Option<Arc<RegistrationBarrier>>>,
    #[cfg(test)]
    close_barrier: Mutex<Option<Arc<RegistrationBarrier>>>,
}

#[cfg(unix)]
#[derive(Debug, Clone, Copy)]
struct ProcessGroup {
    pgid: Pid,
}

#[cfg(unix)]
impl ProcessGroup {
    fn for_child(pid: u32) -> Result<Self, String> {
        let pid =
            i32::try_from(pid).map_err(|_| "child pid is outside the Unix range".to_owned())?;
        if pid <= 1 {
            return Err("refusing to manage a reserved process group".to_owned());
        }
        let pgid = Pid::from_raw(pid);
        let actual = getpgid(Some(pgid)).map_err(|error| error.to_string())?;
        if actual != pgid {
            return Err(format!(
                "child process group mismatch: expected {pgid}, got {actual}"
            ));
        }
        Ok(Self { pgid })
    }

    fn terminate(&self) -> Result<(), nix::errno::Errno> {
        killpg(self.pgid, Signal::SIGKILL)
    }
}

/// Thread-safe native child broker.
#[derive(Clone)]
pub struct ProcessBroker {
    inner: Arc<BrokerInner>,
}

impl std::fmt::Debug for ProcessBroker {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProcessBroker")
            .field("closed", &self.inner.closed.load(Ordering::Acquire))
            .finish_non_exhaustive()
    }
}

impl ProcessBroker {
    #[must_use]
    pub fn new(config: BrokerConfig) -> Self {
        Self::with_identity_backend(config, NativeIdentityBackend)
    }

    #[must_use]
    pub fn with_identity_backend<B>(config: BrokerConfig, identity: B) -> Self
    where
        B: IdentityBackend + 'static,
    {
        let events = Arc::new(EventQueue::new(config));
        Self {
            inner: Arc::new(BrokerInner {
                state: Mutex::new(BrokerState::default()),
                transaction: Mutex::new(None),
                transaction_ready: Condvar::new(),
                identity: Arc::new(identity),
                sequencer: Arc::new(EventSequencer::new(events.clone())),
                events,
                next_token: AtomicU64::new(1),
                closed: AtomicBool::new(false),
                #[cfg(test)]
                registration_barrier: Mutex::new(None),
                #[cfg(test)]
                close_barrier: Mutex::new(None),
            }),
        }
    }

    #[must_use]
    pub fn events(&self) -> EventStream {
        EventStream {
            queue: self.inner.events.clone(),
        }
    }

    /// Spawn a direct child and retain its native handle before returning.
    pub fn spawn(&self, request: SpawnRequest) -> Result<SpawnedProcess, BrokerError> {
        validate_request(&request)?;
        let attempt_id = self.acquire_transaction()?;

        #[cfg(unix)]
        let (additional_mappings, additional_inputs, additional_outputs) =
            match prepare_additional_fds(&request.additional_fds) {
                Ok(prepared) => prepared,
                Err(error) => {
                    self.finish_transaction(attempt_id);
                    return Err(BrokerError::Spawn(error));
                }
            };
        #[cfg(not(unix))]
        let (additional_inputs, additional_outputs) =
            (HashMap::<u32, File>::new(), Vec::<(u32, File)>::new());

        let mut command = Command::new(&request.executable);
        command.args(&request.args);
        if let Some(cwd) = request.cwd.as_ref() {
            command.current_dir(cwd);
        }
        if request.clear_env {
            command.env_clear();
        }
        for (key, value) in &request.env {
            command.env(key, value);
        }
        command.stdin(Stdio::piped());
        command.stdout(Stdio::piped());
        command.stderr(Stdio::piped());

        #[cfg(unix)]
        // Keep every brokered direct child as the leader of its own process
        // group.  Descendants that deliberately call `setsid`/detach are
        // outside this group by design and remain the server's boundary.
        command.process_group(0);

        #[cfg(unix)]
        if let Err(error) = command.fd_mappings(additional_mappings) {
            self.finish_transaction(attempt_id);
            return Err(BrokerError::Spawn(format!(
                "failed to configure additional file descriptors: {error}"
            )));
        }

        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                self.finish_transaction(attempt_id);
                return Err(BrokerError::Spawn(error.to_string()));
            }
        };
        let pid = child.id();
        let spawned_at = SystemTime::now();
        let identity = match self.inner.identity.capture(&child, pid, spawned_at) {
            Ok(identity) => identity,
            Err(error) => {
                // No record or waiter exists yet, so the retained child is
                // still an unreaped process-group leader.  Kill its private
                // group first; if the group operation is unavailable, the
                // retained unreaped Child is still reserved against PID
                // reuse and can be killed safely before being waited.
                #[cfg(unix)]
                if let Ok(process_group) = ProcessGroup::for_child(pid) {
                    let _ = process_group.terminate();
                }
                let _ = child.kill();
                let _ = child.wait();
                self.finish_transaction(attempt_id);
                return Err(BrokerError::Identity(error));
            }
        };
        let identity_proven = !matches!(identity.proof, super::identity::IdentityProof::Unproven);
        #[cfg(unix)]
        let process_group = match ProcessGroup::for_child(pid) {
            Ok(process_group) => process_group,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                self.finish_transaction(attempt_id);
                return Err(BrokerError::Spawn(error));
            }
        };
        let stdin = child.stdin.take();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let additional_output_count = additional_outputs.len();
        let streams_remaining = u64::from(stdout.is_some())
            + u64::from(stderr.is_some())
            + u64::try_from(additional_output_count).unwrap_or(u64::MAX);
        let record = Arc::new(ProcessRecord {
            attempt_id,
            identity,
            #[cfg(unix)]
            process_group,
            child: Mutex::new(child),
            stdin: Mutex::new(stdin),
            additional_inputs: Mutex::new(additional_inputs),
            state: Mutex::new(RecordState::default()),
            reap_gate: Mutex::new(()),
            #[cfg(unix)]
            group_cleanup_safe: AtomicBool::new(true),
            streams_remaining: AtomicU64::new(streams_remaining),
        });

        {
            let mut state = lock(&self.inner.state);
            if self.inner.closed.load(Ordering::Acquire) {
                drop(state);
                // A close can race a spawn after the OS has created the child.
                // Use the same identity gate as ordinary release; never fall
                // back to a raw pid kill.
                let mut child = lock(&record.child);
                let _ = self.inner.identity.terminate(&mut child, &record.identity);
                self.finish_transaction(attempt_id);
                return Err(BrokerError::Closed);
            }
            state.attempts.insert(attempt_id, record.clone());
        }

        if let Some(stdout) = stdout {
            spawn_reader(
                stdout,
                record.clone(),
                OutputStream::Stdout,
                self.inner.sequencer.clone(),
            );
        }
        if let Some(stderr) = stderr {
            spawn_reader(
                stderr,
                record.clone(),
                OutputStream::Stderr,
                self.inner.sequencer.clone(),
            );
        }
        for (fd, reader) in additional_outputs {
            spawn_reader(
                reader,
                record.clone(),
                OutputStream::Additional(fd),
                self.inner.sequencer.clone(),
            );
        }
        spawn_waiter(record, self.inner.clone());

        Ok(SpawnedProcess {
            attempt_id,
            pid,
            kind: request.kind,
            identity_proven,
        })
    }

    /// Acknowledge the retained child.  A child that has already exited gets
    /// the required `{ registrationId: null }` result and still emits output
    /// and an exit event through the ordinary event queue.
    pub fn register(&self, attempt_id: AttemptToken) -> Result<RegistrationOutcome, BrokerError> {
        // Hold the broker registry lock across the entire acknowledgement.
        // `transport_close` marks the broker closed before acquiring this
        // lock, so a close either wins before this block (and no token is
        // minted) or drains the fully inserted registration afterwards.  In
        // particular, do not update `record.state` and `state.registrations`
        // in separate critical sections: doing so permits a late ack to
        // recreate a token after transport cleanup has already drained the
        // registry.
        let outcome: Result<RegistrationOutcome, BrokerError> = {
            let mut state = lock(&self.inner.state);
            if self.inner.closed.load(Ordering::Acquire) {
                Err(BrokerError::Closed)
            } else if let Some(record) = state.attempts.get(&attempt_id).cloned() {
                let _reap_guard = lock(&record.reap_gate);
                let mut child = lock(&record.child);
                match child.try_wait() {
                    Err(error) => Err(BrokerError::Io(error.to_string())),
                    Ok(status) => {
                        let exited = status.map(ExitStatusInfo::from_status);
                        let mut record_state = lock(&record.state);
                        if record_state.released {
                            Err(BrokerError::StaleAttempt)
                        } else if let Some(existing) = record_state.registration_id {
                            Ok(RegistrationOutcome {
                                registration_id: Some(existing),
                                exited: record_state.exit,
                            })
                        } else if let Some(status) = exited {
                            record_state.leader_reaped = true;
                            record_state.exit = Some(status);
                            Ok(RegistrationOutcome {
                                registration_id: None,
                                exited: Some(status),
                            })
                        } else {
                            let registration_id = self.next_registration_token();
                            record_state.registration_id = Some(registration_id);
                            #[cfg(test)]
                            self.pause_registration_for_test();
                            state.registrations.insert(registration_id, attempt_id);
                            Ok(RegistrationOutcome {
                                registration_id: Some(registration_id),
                                exited: None,
                            })
                        }
                    }
                }
            } else {
                Err(BrokerError::StaleAttempt)
            }
        };
        self.finish_transaction(attempt_id);
        outcome
    }

    /// Cancel a pending transaction or a late registration.  The operation is
    /// idempotent for a token that has already been cancelled.
    pub fn cancel(&self, attempt_id: AttemptToken) -> Result<ReleaseOutcome, BrokerError> {
        let record = {
            let mut state = lock(&self.inner.state);
            if let Some(record) = state.attempts.remove(&attempt_id) {
                if let Some(registration_id) = lock(&record.state).registration_id {
                    state.registrations.remove(&registration_id);
                    state.released_registrations.insert(registration_id);
                }
                state.cancelled_attempts.insert(attempt_id);
                record
            } else if state.cancelled_attempts.contains(&attempt_id) {
                return Ok(ReleaseOutcome::AlreadyReleased);
            } else {
                return Err(BrokerError::StaleAttempt);
            }
        };
        self.finish_transaction(attempt_id);
        self.release_record(&record)
    }

    /// Release a registered child.  Repeating the same call is successful and
    /// produces `AlreadyReleased`; stale random tokens are rejected.
    pub fn release(
        &self,
        registration_id: RegistrationToken,
    ) -> Result<ReleaseOutcome, BrokerError> {
        if self.inner.closed.load(Ordering::Acquire) {
            return Err(BrokerError::Closed);
        }
        let record = {
            let mut state = lock(&self.inner.state);
            if state.released_registrations.contains(&registration_id) {
                return Ok(ReleaseOutcome::AlreadyReleased);
            }
            let Some(attempt_id) = state.registrations.remove(&registration_id) else {
                return Err(BrokerError::StaleRegistration);
            };
            state.released_registrations.insert(registration_id);
            state.attempts.remove(&attempt_id)
        };
        let Some(record) = record else {
            return Ok(ReleaseOutcome::AlreadyReleased);
        };
        self.finish_transaction(record.attempt_id);
        self.release_record(&record)
    }

    /// Write bytes to a child's retained stdin.  The token may be either the
    /// pending attempt or its registration token.
    pub fn write_stdin<T: IntoToken>(
        &self,
        token: T,
        bytes: &[u8],
    ) -> Result<StdinOutcome, BrokerError> {
        self.write_input(token, 0, bytes)
    }

    /// Write bytes to stdin or one of the configured additional input
    /// descriptors.  The token may be either the pending attempt or its
    /// registration token.
    pub fn write_input<T: IntoToken>(
        &self,
        token: T,
        fd: u32,
        bytes: &[u8],
    ) -> Result<StdinOutcome, BrokerError> {
        let record = self.find_token(token)?;
        if lock(&record.state).released {
            return Ok(StdinOutcome::Closed);
        }
        if fd == 0 {
            let mut stdin = lock(&record.stdin);
            let Some(stdin) = stdin.as_mut() else {
                return Ok(StdinOutcome::Closed);
            };
            stdin
                .write_all(bytes)
                .map_err(|error| BrokerError::Io(error.to_string()))?;
            stdin
                .flush()
                .map_err(|error| BrokerError::Io(error.to_string()))?;
        } else {
            let mut inputs = lock(&record.additional_inputs);
            let Some(input) = inputs.get_mut(&fd) else {
                return Err(BrokerError::InvalidRequest(format!(
                    "fd {fd} is not configured as an input descriptor"
                )));
            };
            input
                .write_all(bytes)
                .map_err(|error| BrokerError::Io(error.to_string()))?;
            input
                .flush()
                .map_err(|error| BrokerError::Io(error.to_string()))?;
        }
        Ok(StdinOutcome::Written(bytes.len()))
    }

    /// Close stdin without affecting the process lifetime.
    pub fn close_stdin<T: IntoToken>(&self, token: T) -> Result<(), BrokerError> {
        self.close_input(token, 0)
    }

    /// Close stdin or one configured additional input descriptor without
    /// affecting the process lifetime.
    pub fn close_input<T: IntoToken>(&self, token: T, fd: u32) -> Result<(), BrokerError> {
        let record = self.find_token(token)?;
        if fd == 0 {
            lock(&record.stdin).take();
        } else {
            lock(&record.additional_inputs).remove(&fd);
        }
        Ok(())
    }

    /// Close the transport: all pending and registered records leave the
    /// broker registry and are terminated only through their proven identity.
    /// A Unix backend that cannot prove identity reports an error and is never
    /// allowed to fall back to a raw pid signal.
    pub fn transport_close(&self) -> Vec<(AttemptToken, Result<ReleaseOutcome, BrokerError>)> {
        if self.inner.closed.swap(true, Ordering::AcqRel) {
            return Vec::new();
        }
        #[cfg(test)]
        self.pause_close_for_test();
        let records = {
            let mut state = lock(&self.inner.state);
            let records = state.attempts.drain().collect::<Vec<_>>();
            state.registrations.clear();
            state.released_registrations.clear();
            state
                .cancelled_attempts
                .extend(records.iter().map(|(id, _)| *id));
            records
        };
        {
            let mut transaction = lock(&self.inner.transaction);
            *transaction = None;
            self.inner.transaction_ready.notify_all();
        }
        self.inner.events.close();
        records
            .into_iter()
            .map(|(attempt, record)| (attempt, self.release_record(&record)))
            .collect()
    }

    #[must_use]
    pub fn is_closed(&self) -> bool {
        self.inner.closed.load(Ordering::Acquire)
    }

    fn release_record(&self, record: &Arc<ProcessRecord>) -> Result<ReleaseOutcome, BrokerError> {
        let _reap_guard = lock(&record.reap_gate);
        let mut child = lock(&record.child);
        #[cfg(unix)]
        let leader_reaped = lock(&record.state).leader_reaped;
        #[cfg(not(unix))]
        let _leader_reaped = lock(&record.state).leader_reaped;
        #[cfg(unix)]
        let group_cleanup_safe = record.group_cleanup_safe.load(Ordering::Acquire);

        // A non-reaped group leader reserves its PGID.  Signal the group
        // while the reservation is held, then let the identity backend deal
        // with the direct child and reap the leader last.  If observation had
        // to fall back to Child::try_wait, the leader may already have been
        // reaped, so fail closed and never signal that recycled PGID.
        #[cfg(unix)]
        let group_cleanup_attempted = !leader_reaped && group_cleanup_safe;
        #[cfg(unix)]
        let group_result = if group_cleanup_attempted {
            match record.process_group.terminate() {
                Ok(()) | Err(nix::errno::Errno::ESRCH) => Ok(()),
                Err(error) => Err(BrokerError::Io(format!(
                    "process-group cleanup failed: {error}"
                ))),
            }
        } else {
            Ok(())
        };
        #[cfg(not(unix))]
        let group_cleanup_attempted = false;
        #[cfg(not(unix))]
        let group_result: Result<(), BrokerError> = Ok(());

        let identity = record.identity.clone();
        let identity_result = self.inner.identity.terminate(&mut child, &identity);
        let direct_outcome = identity_result.as_ref().map(|result| match result {
            TerminateResult::Terminated => ReleaseOutcome::Terminated,
            TerminateResult::AlreadyExited => ReleaseOutcome::AlreadyExited,
        });

        let mut reap_error = None;
        if matches!(identity_result, Ok(TerminateResult::AlreadyExited)) {
            // The identity backend may have observed and reaped a naturally
            // exited leader while checking its proof.  Do not call wait a
            // second time in that case.
            lock(&record.state).leader_reaped = true;
        } else if group_result.is_ok() && group_cleanup_attempted {
            match child.wait() {
                Ok(status) => {
                    let mut state = lock(&record.state);
                    state.exit = Some(ExitStatusInfo::from_status(status));
                    state.leader_reaped = true;
                }
                Err(error) => {
                    reap_error = Some(BrokerError::Io(error.to_string()));
                }
            }
        }

        let mut state = lock(&record.state);
        state.released = true;
        state.registration_id = None;
        if let Some(error) = reap_error {
            return Err(error);
        }
        group_result?;
        match direct_outcome {
            Ok(outcome) => Ok(outcome),
            Err(error) => {
                // A successful group kill is an identity-safe termination of
                // this retained group leader even when a platform backend
                // reports that its direct-child proof is unavailable.
                #[cfg(unix)]
                if group_cleanup_attempted {
                    return Ok(ReleaseOutcome::Terminated);
                }
                Err(BrokerError::Identity(error.clone()))
            }
        }
    }

    fn find_attempt(&self, attempt_id: AttemptToken) -> Result<Arc<ProcessRecord>, BrokerError> {
        if self.inner.closed.load(Ordering::Acquire) {
            return Err(BrokerError::Closed);
        }
        lock(&self.inner.state)
            .attempts
            .get(&attempt_id)
            .cloned()
            .ok_or(BrokerError::StaleAttempt)
    }

    fn find_token<T: IntoToken>(&self, token: T) -> Result<Arc<ProcessRecord>, BrokerError> {
        match token.into_token() {
            Token::Attempt(attempt) => self.find_attempt(attempt),
            Token::Registration(registration) => {
                let state = lock(&self.inner.state);
                let attempt = state
                    .registrations
                    .get(&registration)
                    .copied()
                    .ok_or(BrokerError::StaleRegistration)?;
                state
                    .attempts
                    .get(&attempt)
                    .cloned()
                    .ok_or(BrokerError::StaleRegistration)
            }
        }
    }

    fn next_token(&self) -> AttemptToken {
        AttemptToken(u128::from(
            self.inner.next_token.fetch_add(1, Ordering::Relaxed),
        ))
    }

    fn acquire_transaction(&self) -> Result<AttemptToken, BrokerError> {
        let mut transaction = lock(&self.inner.transaction);
        while transaction.is_some() && !self.inner.closed.load(Ordering::Acquire) {
            transaction = wait(&self.inner.transaction_ready, transaction);
        }
        if self.inner.closed.load(Ordering::Acquire) {
            return Err(BrokerError::Closed);
        }
        let attempt_id = self.next_token();
        *transaction = Some(attempt_id);
        Ok(attempt_id)
    }

    fn finish_transaction(&self, attempt_id: AttemptToken) {
        let mut transaction = lock(&self.inner.transaction);
        if transaction.as_ref() == Some(&attempt_id) {
            *transaction = None;
            self.inner.transaction_ready.notify_all();
        }
    }

    fn next_registration_token(&self) -> RegistrationToken {
        RegistrationToken(u128::from(
            self.inner.next_token.fetch_add(1, Ordering::Relaxed),
        ))
    }

    #[cfg(test)]
    fn pause_registration_for_test(&self) {
        let barrier = lock(&self.inner.registration_barrier).clone();
        if let Some(barrier) = barrier {
            barrier.pause();
        }
    }

    #[cfg(test)]
    fn pause_close_for_test(&self) {
        let barrier = lock(&self.inner.close_barrier).clone();
        if let Some(barrier) = barrier {
            barrier.pause();
        }
    }
}

#[cfg(test)]
struct RegistrationBarrier {
    reached: Mutex<bool>,
    reached_ready: Condvar,
    released: Mutex<bool>,
    released_ready: Condvar,
}

#[cfg(test)]
impl RegistrationBarrier {
    fn new() -> Self {
        Self {
            reached: Mutex::new(false),
            reached_ready: Condvar::new(),
            released: Mutex::new(false),
            released_ready: Condvar::new(),
        }
    }

    fn pause(&self) {
        {
            let mut reached = lock(&self.reached);
            *reached = true;
            self.reached_ready.notify_all();
        }
        let mut released = lock(&self.released);
        while !*released {
            released = wait(&self.released_ready, released);
        }
    }

    fn wait_until_reached(&self) {
        let mut reached = lock(&self.reached);
        while !*reached {
            reached = wait(&self.reached_ready, reached);
        }
    }

    fn release(&self) {
        let mut released = lock(&self.released);
        *released = true;
        self.released_ready.notify_all();
    }
}

/// A token accepted by `write_stdin` and `close_stdin`.
pub trait IntoToken {
    fn into_token(self) -> Token;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Token {
    Attempt(AttemptToken),
    Registration(RegistrationToken),
}

impl IntoToken for AttemptToken {
    fn into_token(self) -> Token {
        Token::Attempt(self)
    }
}

impl IntoToken for RegistrationToken {
    fn into_token(self) -> Token {
        Token::Registration(self)
    }
}

struct EventQueue {
    state: Mutex<EventQueueState>,
    not_empty: Condvar,
    not_full: Condvar,
    max_events: usize,
    max_bytes: usize,
}

struct EventQueueState {
    events: VecDeque<BrokerEvent>,
    bytes: usize,
    closed: bool,
}

impl EventQueue {
    fn new(config: BrokerConfig) -> Self {
        Self {
            state: Mutex::new(EventQueueState {
                events: VecDeque::with_capacity(config.max_events.max(1)),
                bytes: 0,
                closed: false,
            }),
            not_empty: Condvar::new(),
            not_full: Condvar::new(),
            max_events: config.max_events.max(1),
            max_bytes: config.max_event_bytes.max(MAX_OUTPUT_CHUNK_BYTES),
        }
    }

    fn push(&self, event: BrokerEvent) -> bool {
        let event_size = event.size();
        if event_size > self.max_bytes {
            return false;
        }
        let mut state = lock(&self.state);
        while !state.closed
            && (state.events.len() >= self.max_events
                || state.bytes.saturating_add(event_size) > self.max_bytes)
        {
            state = wait(&self.not_full, state);
        }
        if state.closed {
            return false;
        }
        state.bytes = state.bytes.saturating_add(event_size);
        state.events.push_back(event);
        self.not_empty.notify_one();
        true
    }

    fn pop(&self) -> Option<BrokerEvent> {
        let mut state = lock(&self.state);
        loop {
            if let Some(event) = state.events.pop_front() {
                state.bytes = state.bytes.saturating_sub(event.size());
                self.not_full.notify_one();
                return Some(event);
            }
            if state.closed {
                return None;
            }
            state = wait(&self.not_empty, state);
        }
    }

    fn try_pop(&self) -> Option<BrokerEvent> {
        let mut state = lock(&self.state);
        let event = state.events.pop_front();
        if let Some(event) = &event {
            state.bytes = state.bytes.saturating_sub(event.size());
            self.not_full.notify_one();
        }
        event
    }

    fn close(&self) {
        let mut state = lock(&self.state);
        state.closed = true;
        self.not_empty.notify_all();
        self.not_full.notify_all();
    }
}

struct EventSequencer {
    next_assigned: AtomicU64,
    emit_lock: Mutex<()>,
    events: Arc<EventQueue>,
}

impl EventSequencer {
    fn new(events: Arc<EventQueue>) -> Self {
        Self {
            // The host-side BrokeredChildProcess contract is zero-based.  A
            // one-based first event is treated as a dropped frame and closes
            // the process handle before any output can be consumed.
            next_assigned: AtomicU64::new(0),
            emit_lock: Mutex::new(()),
            events,
        }
    }

    fn emit(&self, event: BrokerEvent) {
        // Keep sequence assignment and queue insertion together.  If this
        // lock were released while a full queue applied backpressure, a later
        // stderr chunk could overtake an earlier stdout chunk.
        let _emit_guard = lock(&self.emit_lock);
        let sequence = self.next_assigned.fetch_add(1, Ordering::Relaxed);
        let event = with_sequence(event, sequence);
        let _ = self.events.push(event);
    }
}

fn with_sequence(event: BrokerEvent, sequence: u64) -> BrokerEvent {
    match event {
        BrokerEvent::Output {
            attempt_id,
            registration_id,
            stream,
            bytes,
            ..
        } => BrokerEvent::Output {
            attempt_id,
            registration_id,
            stream,
            sequence,
            bytes,
        },
        BrokerEvent::Exit {
            attempt_id,
            registration_id,
            status,
            ..
        } => BrokerEvent::Exit {
            attempt_id,
            registration_id,
            sequence,
            status,
        },
    }
}

fn spawn_reader<R: Read + Send + 'static>(
    mut reader: R,
    record: Arc<ProcessRecord>,
    stream: OutputStream,
    sequencer: Arc<EventSequencer>,
) {
    let _ = thread::Builder::new()
        .name(format!("nanoni-process-{stream:?}"))
        .spawn(move || {
            let mut buffer = vec![0_u8; MAX_OUTPUT_CHUNK_BYTES];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(size) => {
                        let bytes = buffer[..size].to_vec();
                        let registration_id = lock(&record.state).registration_id;
                        sequencer.emit(BrokerEvent::Output {
                            attempt_id: record.attempt_id,
                            registration_id,
                            stream,
                            sequence: 0,
                            bytes,
                        });
                    }
                    Err(_) => break,
                }
            }
            record.streams_remaining.fetch_sub(1, Ordering::AcqRel);
        });
}

#[cfg(any(
    target_os = "android",
    target_os = "freebsd",
    target_os = "haiku",
    target_os = "linux"
))]
fn observe_child_exit(pid: u32) -> Result<Option<ExitStatusInfo>, String> {
    let pid = i32::try_from(pid).map_err(|_| "child pid is outside the Unix range".to_owned())?;
    let status = waitid(
        Id::Pid(Pid::from_raw(pid)),
        WaitPidFlag::WEXITED | WaitPidFlag::WNOHANG | WaitPidFlag::WNOWAIT,
    )
    .map_err(|error| error.to_string())?;
    Ok(match status {
        WaitStatus::Exited(_, code) => Some(ExitStatusInfo {
            success: true,
            code: Some(code),
            signal: None,
        }),
        WaitStatus::Signaled(_, signal, _) => Some(ExitStatusInfo {
            success: false,
            code: None,
            signal: Some(signal as i32),
        }),
        _ => None,
    })
}

#[cfg(target_os = "macos")]
fn observe_child_exit(pid: u32) -> Result<Option<ExitStatusInfo>, String> {
    let pid = i32::try_from(pid).map_err(|_| "child pid is outside the Unix range".to_owned())?;
    let status = waitpid(
        Pid::from_raw(pid),
        Some(WaitPidFlag::WNOHANG | WaitPidFlag::WNOWAIT),
    )
    .map_err(|error| error.to_string())?;
    Ok(match status {
        WaitStatus::Exited(_, code) => Some(ExitStatusInfo {
            success: true,
            code: Some(code),
            signal: None,
        }),
        WaitStatus::Signaled(_, signal, _) => Some(ExitStatusInfo {
            success: false,
            code: None,
            signal: Some(signal as i32),
        }),
        _ => None,
    })
}

#[cfg(all(
    unix,
    not(any(
        target_os = "android",
        target_os = "freebsd",
        target_os = "haiku",
        target_os = "linux",
        target_os = "macos"
    ))
))]
fn observe_child_exit(_pid: u32) -> Result<Option<ExitStatusInfo>, String> {
    Err("non-reaping child observation is unsupported on this Unix target".to_owned())
}

fn spawn_waiter(record: Arc<ProcessRecord>, inner: Arc<BrokerInner>) {
    let _ = thread::Builder::new()
        .name("nanoni-process-wait".to_string())
        .spawn(move || {
            let status = loop {
                if let Some(status) = lock(&record.state).exit {
                    break status;
                }

                let _reap_guard = lock(&record.reap_gate);
                if let Some(status) = lock(&record.state).exit {
                    break status;
                }

                #[cfg(unix)]
                let observed = observe_child_exit(record.identity.pid);
                #[cfg(not(unix))]
                let observed = {
                    let mut child = lock(&record.child);
                    child
                        .try_wait()
                        .map(|status| status.map(ExitStatusInfo::from_status))
                        .map_err(|error| error.to_string())
                };

                match observed {
                    Ok(Some(status)) => {
                        lock(&record.state).exit = Some(status);
                        break status;
                    }
                    Ok(None) => {}
                    Err(_) => {
                        // If WNOWAIT/waitid is unavailable, fall back to
                        // std's reaping wait only after disabling group
                        // cleanup.  A reaped leader no longer reserves its
                        // PGID, so release_record will never signal it.
                        #[cfg(unix)]
                        record.group_cleanup_safe.store(false, Ordering::Release);
                        let mut child = lock(&record.child);
                        if let Ok(Some(status)) = child.try_wait() {
                            let status = ExitStatusInfo::from_status(status);
                            let mut state = lock(&record.state);
                            state.leader_reaped = true;
                            state.exit = Some(status);
                            break status;
                        }
                    }
                }
                drop(_reap_guard);
                thread::park_timeout(Duration::from_millis(10));
            };
            while record.streams_remaining.load(Ordering::Acquire) != 0 {
                thread::park_timeout(Duration::from_millis(1));
            }
            let registration_id = {
                let mut state = lock(&record.state);
                state.exit = Some(status);
                state.registration_id
            };
            inner.sequencer.emit(BrokerEvent::Exit {
                attempt_id: record.attempt_id,
                registration_id,
                sequence: 0,
                status,
            });
        });
}

fn validate_request(request: &SpawnRequest) -> Result<(), BrokerError> {
    if request.executable.as_os_str().is_empty() {
        return Err(BrokerError::InvalidRequest(
            "executable path must not be empty".to_string(),
        ));
    }
    if request.detached {
        return Err(BrokerError::InvalidRequest(
            "detached process creation is not allowed".to_string(),
        ));
    }
    if request.shell.is_some() {
        return Err(BrokerError::InvalidRequest(
            "shell execution is not allowed; pass an executable and argv".to_string(),
        ));
    }
    validate_additional_fds(&request.additional_fds)?;
    Ok(())
}

pub(crate) fn validate_additional_fds(
    additional_fds: &[AdditionalFdSpec],
) -> Result<(), BrokerError> {
    #[cfg(not(unix))]
    if !additional_fds.is_empty() {
        return Err(BrokerError::InvalidRequest(
            "additional file descriptors are unsupported on this platform".to_owned(),
        ));
    }
    if additional_fds.len() > MAX_ADDITIONAL_FDS {
        return Err(BrokerError::InvalidRequest(format!(
            "at most {MAX_ADDITIONAL_FDS} additional file descriptors are allowed"
        )));
    }
    let mut seen = HashSet::with_capacity(additional_fds.len());
    for descriptor in additional_fds {
        if descriptor.fd < 3 {
            return Err(BrokerError::InvalidRequest(format!(
                "additional file descriptor {} must be >= 3",
                descriptor.fd
            )));
        }
        if descriptor.fd > i32::MAX as u32 {
            return Err(BrokerError::InvalidRequest(format!(
                "additional file descriptor {} is outside the native fd range",
                descriptor.fd
            )));
        }
        if !seen.insert(descriptor.fd) {
            return Err(BrokerError::InvalidRequest(format!(
                "additional file descriptor {} is configured more than once",
                descriptor.fd
            )));
        }
    }
    Ok(())
}

#[cfg(unix)]
fn prepare_additional_fds(
    additional_fds: &[AdditionalFdSpec],
) -> Result<(Vec<FdMapping>, HashMap<u32, File>, Vec<(u32, File)>), String> {
    let mut mappings = Vec::with_capacity(additional_fds.len());
    let mut inputs = HashMap::new();
    let mut outputs = Vec::new();
    for descriptor in additional_fds {
        let (read_end, write_end) = pipe().map_err(|error| {
            format!(
                "failed to create pipe for additional fd {}: {error}",
                descriptor.fd
            )
        })?;
        let child_fd = i32::try_from(descriptor.fd).map_err(|_| {
            format!(
                "additional file descriptor {} is outside the native fd range",
                descriptor.fd
            )
        })?;
        match descriptor.direction {
            AdditionalFdDirection::Input => {
                mappings.push(FdMapping {
                    parent_fd: read_end,
                    child_fd,
                });
                inputs.insert(descriptor.fd, File::from(write_end));
            }
            AdditionalFdDirection::Output => {
                mappings.push(FdMapping {
                    parent_fd: write_end,
                    child_fd,
                });
                outputs.push((descriptor.fd, File::from(read_end)));
            }
        }
    }
    Ok((mappings, inputs, outputs))
}

#[cfg(test)]
fn millis(time: SystemTime) -> u64 {
    time.duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

fn wait<'a, T>(
    condvar: &Condvar,
    guard: std::sync::MutexGuard<'a, T>,
) -> std::sync::MutexGuard<'a, T> {
    match condvar.wait(guard) {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::identity::{IdentityProof, TerminateResult};
    use std::sync::mpsc;

    #[derive(Debug, Default, Clone, Copy)]
    struct TestIdentityBackend;

    impl IdentityBackend for TestIdentityBackend {
        fn capture(
            &self,
            _child: &Child,
            pid: u32,
            spawned_at: SystemTime,
        ) -> Result<ProcessIdentity, IdentityError> {
            Ok(ProcessIdentity {
                pid,
                spawned_at_ms: millis(spawned_at),
                proof: IdentityProof::UnixStartTime { value: 1 },
            })
        }

        fn terminate(
            &self,
            child: &mut Child,
            _identity: &ProcessIdentity,
        ) -> Result<TerminateResult, IdentityError> {
            if child
                .try_wait()
                .map_err(|error| IdentityError::TerminationFailed(error.to_string()))?
                .is_some()
            {
                return Ok(TerminateResult::AlreadyExited);
            }
            child
                .kill()
                .map(|()| TerminateResult::Terminated)
                .map_err(|error| IdentityError::TerminationFailed(error.to_string()))
        }
    }

    fn request(program: &str, args: &[&str]) -> SpawnRequest {
        SpawnRequest::new(program).with_args(args.iter().copied())
    }

    fn fast_exit() -> SpawnRequest {
        #[cfg(windows)]
        {
            request("cmd", &["/C", "exit", "0"])
        }
        #[cfg(not(windows))]
        {
            request("true", &[])
        }
    }

    fn long_running() -> SpawnRequest {
        #[cfg(windows)]
        {
            request("ping", &["127.0.0.1", "-n", "60"])
        }
        #[cfg(not(windows))]
        {
            request("sleep", &["60"])
        }
    }

    #[test]
    fn shell_and_detached_requests_are_rejected_without_spawning() {
        let broker = ProcessBroker::new(BrokerConfig::default());
        let mut shell = request("echo", &["hello"]);
        shell.shell = Some(OsString::from("sh"));
        assert!(matches!(
            broker.spawn(shell),
            Err(BrokerError::InvalidRequest(_))
        ));
        let mut detached = request("echo", &["hello"]);
        detached.detached = true;
        assert!(matches!(
            broker.spawn(detached),
            Err(BrokerError::InvalidRequest(_))
        ));
    }

    #[test]
    fn fast_exit_returns_null_registration_and_exit_event() {
        let broker =
            ProcessBroker::with_identity_backend(BrokerConfig::default(), TestIdentityBackend);
        let stream = broker.events();
        let spawned = broker.spawn(fast_exit()).expect("fast child should spawn");
        let event = stream.next().expect("fast child should emit exit");
        assert!(matches!(event, BrokerEvent::Exit { .. }));
        let outcome = broker
            .register(spawned.attempt_id)
            .expect("attempt remains registerable");
        assert!(outcome.registration_id.is_none());
        assert!(outcome.exited.is_some());
    }

    #[test]
    fn stale_token_after_cancel_is_rejected_and_release_is_idempotent() {
        let broker =
            ProcessBroker::with_identity_backend(BrokerConfig::default(), TestIdentityBackend);
        let spawned = broker
            .spawn(long_running())
            .expect("long child should spawn");
        let registration = broker.register(spawned.attempt_id).expect("register");
        let registration_id = registration
            .registration_id
            .expect("live child registration");
        assert_eq!(
            broker.release(registration_id),
            Ok(ReleaseOutcome::Terminated)
        );
        assert_eq!(
            broker.release(registration_id),
            Ok(ReleaseOutcome::AlreadyReleased)
        );
        assert!(matches!(
            broker.register(spawned.attempt_id),
            Err(BrokerError::StaleAttempt)
        ));
    }

    #[test]
    fn cancellation_removes_pending_attempt_and_is_idempotent() {
        let broker =
            ProcessBroker::with_identity_backend(BrokerConfig::default(), TestIdentityBackend);
        let spawned = broker
            .spawn(long_running())
            .expect("long child should spawn");
        assert_eq!(
            broker.cancel(spawned.attempt_id),
            Ok(ReleaseOutcome::Terminated)
        );
        assert_eq!(
            broker.cancel(spawned.attempt_id),
            Ok(ReleaseOutcome::AlreadyReleased)
        );
        assert!(matches!(
            broker.register(spawned.attempt_id),
            Err(BrokerError::StaleAttempt)
        ));
    }

    #[test]
    fn transport_close_clears_registered_children_and_stale_tokens() {
        let broker =
            ProcessBroker::with_identity_backend(BrokerConfig::default(), TestIdentityBackend);
        let first = broker.spawn(long_running()).expect("child should spawn");
        let first_registration = broker
            .register(first.attempt_id)
            .expect("register")
            .registration_id
            .expect("live registration");
        let second = broker.spawn(long_running()).expect("child should spawn");
        let report = broker.transport_close();
        assert_eq!(report.len(), 2);
        assert!(broker.is_closed());
        assert!(matches!(
            broker.release(first_registration),
            Err(BrokerError::Closed) | Ok(ReleaseOutcome::AlreadyReleased)
        ));
        assert!(matches!(
            broker.register(second.attempt_id),
            Err(BrokerError::Closed) | Err(BrokerError::StaleAttempt)
        ));
    }

    #[test]
    fn registration_ack_and_transport_close_cannot_leave_a_late_token() {
        let broker =
            ProcessBroker::with_identity_backend(BrokerConfig::default(), TestIdentityBackend);
        let spawned = broker.spawn(long_running()).expect("child should spawn");
        let registration_barrier = Arc::new(RegistrationBarrier::new());
        let close_barrier = Arc::new(RegistrationBarrier::new());
        *lock(&broker.inner.registration_barrier) = Some(registration_barrier.clone());
        *lock(&broker.inner.close_barrier) = Some(close_barrier.clone());

        let (registration_sender, registration_receiver) = mpsc::sync_channel(1);
        let registration_broker = broker.clone();
        let attempt_id = spawned.attempt_id;
        thread::spawn(move || {
            let result = registration_broker.register(attempt_id);
            registration_sender
                .send(result)
                .expect("registration receiver should remain open");
        });
        registration_barrier.wait_until_reached();

        let (close_sender, close_receiver) = mpsc::sync_channel(1);
        let close_broker = broker.clone();
        thread::spawn(move || {
            close_sender
                .send(close_broker.transport_close())
                .expect("close receiver should remain open");
        });
        close_barrier.wait_until_reached();

        // The close has marked the broker closed, but cannot acquire the
        // registry lock while registration is paused.  The ack therefore
        // cannot finish before the registration barrier is released.
        assert!(registration_receiver.try_recv().is_err());
        assert!(close_receiver.try_recv().is_err());

        registration_barrier.release();
        let registration = registration_receiver
            .recv()
            .expect("registration should finish after the barrier")
            .expect("registration should commit before close drains it");
        assert!(registration.registration_id.is_some());
        assert!(close_receiver.try_recv().is_err());

        close_barrier.release();
        let report = close_receiver
            .recv()
            .expect("close should finish after the barrier");
        assert_eq!(report.len(), 1);
        assert!(lock(&broker.inner.state).registrations.is_empty());
    }

    #[test]
    fn ordered_chunks_have_monotonic_sequences_and_are_bounded() {
        let queue = Arc::new(EventQueue::new(BrokerConfig {
            max_events: 16,
            max_event_bytes: 256 * 1024,
        }));
        let sequencer = EventSequencer::new(queue.clone());
        let attempt = AttemptToken(7);
        let mut handles = Vec::new();
        let sequencer = Arc::new(sequencer);
        for stream in [OutputStream::Stdout, OutputStream::Stderr] {
            let sequencer = sequencer.clone();
            handles.push(thread::spawn(move || {
                for _ in 0..4 {
                    sequencer.emit(BrokerEvent::Output {
                        attempt_id: attempt,
                        registration_id: None,
                        stream,
                        sequence: 0,
                        bytes: vec![b'x'; 32],
                    });
                }
            }));
        }
        for handle in handles {
            let _ = handle.join();
        }
        let mut sequences = Vec::new();
        while let Some(event) = queue.try_pop() {
            assert!(event.size() <= MAX_OUTPUT_CHUNK_BYTES);
            sequences.push(event.sequence());
        }
        assert_eq!(sequences, (0..8).collect::<Vec<_>>());
    }
}
