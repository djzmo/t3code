//! Process identity and termination boundary.
//!
//! The broker must never signal a Unix process through a bare, possibly
//! recycled numeric pid. Linux uses a retained pidfd, while macOS records
//! and checks the kernel's process start time immediately before the final
//! signal (macOS has no pidfd equivalent). Windows keeps using the retained
//! process handle owned by [`std::process::Child`].

use std::process::Child;
use std::time::SystemTime;

#[cfg(target_os = "linux")]
use rustix::fd::OwnedFd;
#[cfg(target_os = "linux")]
use rustix::process::{Pid, PidfdFlags, Signal};
#[cfg(target_os = "linux")]
use std::sync::Arc;

/// Proof attached to a retained child identity.
#[derive(Debug, Clone)]
pub enum IdentityProof {
    /// On Windows, the retained `Child` owns an OS process handle. Calling
    /// `Child::kill` uses that handle rather than looking up a reused pid.
    HandleBacked,
    /// A portable start-time proof retained for test doubles and platforms
    /// without a native identity backend.
    UnixStartTime { value: u64 },
    /// Linux pidfd retained from the child's creation until its record is
    /// released. The descriptor is reference counted because the broker
    /// clones [`ProcessIdentity`] while dispatching release/close paths.
    #[cfg(target_os = "linux")]
    LinuxPidFd { fd: Arc<OwnedFd>, pid: u32 },
    /// macOS process start time returned by `proc_pidinfo`.
    #[cfg(target_os = "macos")]
    MacStartTime { seconds: u64, microseconds: u64 },
    /// Spawn succeeded but this backend could not prove an exact identity.
    Unproven,
}

// A pidfd is an OS object rather than a value whose equality has useful
// semantics. Comparing its raw descriptor keeps this public proof type
// comparable for tests without pretending two independent descriptors prove
// the same process.
impl PartialEq for IdentityProof {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::HandleBacked, Self::HandleBacked) | (Self::Unproven, Self::Unproven) => true,
            (Self::UnixStartTime { value: left }, Self::UnixStartTime { value: right }) => {
                left == right
            }
            #[cfg(target_os = "linux")]
            (
                Self::LinuxPidFd {
                    fd: left,
                    pid: left_pid,
                },
                Self::LinuxPidFd {
                    fd: right,
                    pid: right_pid,
                },
            ) => left_pid == right_pid && std::ptr::eq(left.as_ref(), right.as_ref()),
            #[cfg(target_os = "macos")]
            (
                Self::MacStartTime {
                    seconds: left_seconds,
                    microseconds: left_microseconds,
                },
                Self::MacStartTime {
                    seconds: right_seconds,
                    microseconds: right_microseconds,
                },
            ) => left_seconds == right_seconds && left_microseconds == right_microseconds,
            _ => false,
        }
    }
}

impl Eq for IdentityProof {}

/// Identity captured at spawn time. `pid` is informational unless the proof
/// is one of the exact variants above.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessIdentity {
    pub pid: u32,
    pub spawned_at_ms: u64,
    pub proof: IdentityProof,
}

impl ProcessIdentity {
    #[must_use]
    pub fn unproven(pid: u32, spawned_at_ms: u64) -> Self {
        Self {
            pid,
            spawned_at_ms,
            proof: IdentityProof::Unproven,
        }
    }
}

/// Why an identity operation was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IdentityError {
    Unavailable,
    Unproven,
    Mismatch,
    TerminationFailed(String),
}

impl std::fmt::Display for IdentityError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unavailable => f.write_str("exact process identity is unavailable"),
            Self::Unproven => f.write_str("refusing to signal an unproven process identity"),
            Self::Mismatch => f.write_str("process identity no longer matches"),
            Self::TerminationFailed(message) => write!(f, "process termination failed: {message}"),
        }
    }
}

impl std::error::Error for IdentityError {}

/// Result of a termination request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminateResult {
    Terminated,
    AlreadyExited,
}

/// Platform identity implementation used by the native broker.
///
/// Implementations must prove the identity before invoking a terminating OS
/// operation. The broker passes the retained `Child`, never a raw pid, so a
/// Windows implementation can safely use the process handle.
pub trait IdentityBackend: Send + Sync {
    fn capture(
        &self,
        child: &Child,
        pid: u32,
        spawned_at: SystemTime,
    ) -> Result<ProcessIdentity, IdentityError>;

    fn terminate(
        &self,
        child: &mut Child,
        identity: &ProcessIdentity,
    ) -> Result<TerminateResult, IdentityError>;
}

/// Fail-closed backend for tests or platforms without a native identity
/// primitive. It never falls back to a raw-pid signal.
#[derive(Debug, Default, Clone, Copy)]
pub struct UnprovenIdentityBackend;

impl IdentityBackend for UnprovenIdentityBackend {
    fn capture(
        &self,
        _child: &Child,
        pid: u32,
        spawned_at: SystemTime,
    ) -> Result<ProcessIdentity, IdentityError> {
        Ok(ProcessIdentity::unproven(pid, millis(spawned_at)))
    }

    fn terminate(
        &self,
        _child: &mut Child,
        _identity: &ProcessIdentity,
    ) -> Result<TerminateResult, IdentityError> {
        Err(IdentityError::Unproven)
    }
}

/// Native process identity backend.
#[derive(Debug, Default, Clone, Copy)]
pub struct NativeIdentityBackend;

impl IdentityBackend for NativeIdentityBackend {
    fn capture(
        &self,
        child: &Child,
        pid: u32,
        spawned_at: SystemTime,
    ) -> Result<ProcessIdentity, IdentityError> {
        #[cfg(windows)]
        {
            let _ = child;
            Ok(ProcessIdentity {
                pid,
                spawned_at_ms: millis(spawned_at),
                proof: IdentityProof::HandleBacked,
            })
        }

        #[cfg(target_os = "linux")]
        {
            let _ = child;
            // `pidfd_open` binds the identity to the kernel process object at
            // capture time. If the kernel does not provide it, returning an
            // error is intentional: the broker may not weaken this to a
            // numeric-pid kill.
            let fd = pidfd_open(child, pid).map_err(|_| IdentityError::Unavailable)?;
            Ok(ProcessIdentity {
                pid,
                spawned_at_ms: millis(spawned_at),
                proof: IdentityProof::LinuxPidFd {
                    fd: Arc::new(fd),
                    pid,
                },
            })
        }

        #[cfg(target_os = "macos")]
        {
            let _ = child;
            let start = mac_process_start_time(pid).map_err(|_| IdentityError::Unavailable)?;
            Ok(ProcessIdentity {
                pid,
                spawned_at_ms: millis(spawned_at),
                proof: IdentityProof::MacStartTime {
                    seconds: start.seconds,
                    microseconds: start.microseconds,
                },
            })
        }

        #[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
        {
            let _ = child;
            let _ = pid;
            let _ = spawned_at;
            Err(IdentityError::Unavailable)
        }
    }

    fn terminate(
        &self,
        child: &mut Child,
        identity: &ProcessIdentity,
    ) -> Result<TerminateResult, IdentityError> {
        #[cfg(windows)]
        {
            if !matches!(identity.proof, IdentityProof::HandleBacked) {
                return Err(IdentityError::Unproven);
            }
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

        #[cfg(target_os = "linux")]
        {
            let IdentityProof::LinuxPidFd { fd, pid } = &identity.proof else {
                return Err(IdentityError::Unproven);
            };
            if child.id() != identity.pid || child.id() != *pid {
                return Err(IdentityError::Mismatch);
            }
            if child
                .try_wait()
                .map_err(|error| IdentityError::TerminationFailed(error.to_string()))?
                .is_some()
            {
                return Ok(TerminateResult::AlreadyExited);
            }
            match rustix::process::pidfd_send_signal(fd.as_ref(), Signal::KILL) {
                Ok(()) => Ok(TerminateResult::Terminated),
                Err(error) if error.raw_os_error() == rustix::io::Errno::SRCH.raw_os_error() => {
                    if child
                        .try_wait()
                        .map_err(|wait_error| {
                            IdentityError::TerminationFailed(wait_error.to_string())
                        })?
                        .is_some()
                    {
                        Ok(TerminateResult::AlreadyExited)
                    } else {
                        Err(IdentityError::TerminationFailed(error.to_string()))
                    }
                }
                Err(error) => Err(IdentityError::TerminationFailed(error.to_string())),
            }
        }

        #[cfg(target_os = "macos")]
        {
            let (seconds, microseconds) = match &identity.proof {
                IdentityProof::MacStartTime {
                    seconds,
                    microseconds,
                } => (*seconds, *microseconds),
                _ => return Err(IdentityError::Unproven),
            };
            if child.id() != identity.pid {
                return Err(IdentityError::Mismatch);
            }
            if child
                .try_wait()
                .map_err(|error| IdentityError::TerminationFailed(error.to_string()))?
                .is_some()
            {
                return Ok(TerminateResult::AlreadyExited);
            }

            // macOS has no pidfd. Read the kernel start identity immediately
            // before `kill`; if it changed, fail closed and never signal the
            // recycled pid. The tiny FFI wrapper below only fills a
            // `proc_bsdinfo` allocated by Rust and never takes ownership of
            // an OS pointer.
            let current = mac_process_start_time(identity.pid)?;
            if current.seconds != seconds || current.microseconds != microseconds {
                return Err(IdentityError::Mismatch);
            }
            let pid = i32::try_from(identity.pid).map_err(|_| IdentityError::Mismatch)?;
            let Some(pid) = rustix::process::Pid::from_raw(pid) else {
                return Err(IdentityError::Mismatch);
            };
            match rustix::process::kill_process(pid, rustix::process::Signal::KILL) {
                Ok(()) => Ok(TerminateResult::Terminated),
                Err(error)
                    if error.raw_os_error() == rustix::io::Errno::SRCH.raw_os_error()
                        && child
                            .try_wait()
                            .map_err(|wait_error| {
                                IdentityError::TerminationFailed(wait_error.to_string())
                            })?
                            .is_some() =>
                {
                    Ok(TerminateResult::AlreadyExited)
                }
                Err(error) => Err(IdentityError::TerminationFailed(error.to_string())),
            }
        }

        #[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
        {
            let _ = child;
            let _ = identity;
            Err(IdentityError::Unavailable)
        }
    }
}

#[cfg(target_os = "linux")]
fn pidfd_open(child: &Child, pid: u32) -> std::io::Result<OwnedFd> {
    if child.id() != pid {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "child pid changed before pidfd capture",
        ));
    }
    rustix::process::pidfd_open(Pid::from_child(child), PidfdFlags::empty())
        .map_err(|error| std::io::Error::from_raw_os_error(error.raw_os_error()))
}

#[cfg(target_os = "macos")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct MacStartTime {
    seconds: u64,
    microseconds: u64,
}

#[cfg(target_os = "macos")]
fn mac_process_start_time(pid: u32) -> Result<MacStartTime, IdentityError> {
    let pid = i32::try_from(pid).map_err(|_| IdentityError::Unavailable)?;
    let info = libproc::proc_pid::pidinfo::<libproc::bsd_info::BSDInfo>(pid, 0)
        .map_err(|_| IdentityError::Unavailable)?;
    Ok(MacStartTime {
        seconds: info.pbi_start_tvsec,
        microseconds: info.pbi_start_tvusec,
    })
}

fn millis(time: SystemTime) -> u64 {
    time.duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    #[test]
    fn unproven_backend_never_signals() {
        let mut child = Command::new(if cfg!(windows) { "cmd" } else { "sh" })
            .args(if cfg!(windows) {
                vec!["/c", "pause"]
            } else {
                vec!["-c", "sleep 30"]
            })
            .spawn()
            .expect("spawn test child");
        let identity = ProcessIdentity::unproven(child.id(), 0);
        assert_eq!(
            UnprovenIdentityBackend.terminate(&mut child, &identity),
            Err(IdentityError::Unproven)
        );
        let _ = child.kill();
        let _ = child.wait();
    }

    #[cfg(target_os = "linux")]
    fn spawn_linux_child() -> Child {
        Command::new("sh")
            .args(["-c", "sleep 30"])
            .spawn()
            .expect("spawn linux test child")
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_pidfd_terminates_exact_child() {
        let mut child = spawn_linux_child();
        let identity = NativeIdentityBackend
            .capture(&child, child.id(), SystemTime::now())
            .expect("pidfd must be available on the test kernel");
        assert!(matches!(identity.proof, IdentityProof::LinuxPidFd { .. }));
        assert_eq!(
            NativeIdentityBackend.terminate(&mut child, &identity),
            Ok(TerminateResult::Terminated)
        );
        let _ = child.wait();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_pidfd_rejects_identity_mismatch() {
        let mut first = spawn_linux_child();
        let mut second = spawn_linux_child();
        let identity = NativeIdentityBackend
            .capture(&first, first.id(), SystemTime::now())
            .expect("pidfd must be available on the test kernel");
        let mismatch = ProcessIdentity {
            pid: second.id(),
            spawned_at_ms: identity.spawned_at_ms,
            proof: identity.proof,
        };
        // A pidfd remains bound to `first`; changing the informational pid
        // cannot redirect the termination to `second`.
        assert_eq!(
            NativeIdentityBackend.terminate(&mut second, &mismatch),
            Err(IdentityError::Mismatch)
        );
        let _ = first.kill();
        let _ = second.kill();
        let _ = first.wait();
        let _ = second.wait();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_pidfd_reports_already_exited() {
        let mut child = Command::new("sh")
            .args(["-c", "exit 0"])
            .spawn()
            .expect("spawn exiting child");
        let identity = NativeIdentityBackend
            .capture(&child, child.id(), SystemTime::now())
            .expect("capture pidfd before reap");
        let _ = child.wait();
        assert_eq!(
            NativeIdentityBackend.terminate(&mut child, &identity),
            Ok(TerminateResult::AlreadyExited)
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn mac_start_time_rejects_identity_mismatch() {
        let mut first = Command::new("sh")
            .args(["-c", "sleep 30"])
            .spawn()
            .expect("spawn first child");
        let mut second = Command::new("sh")
            .args(["-c", "sleep 30"])
            .spawn()
            .expect("spawn second child");
        let identity = NativeIdentityBackend
            .capture(&first, first.id(), SystemTime::now())
            .expect("capture mac start time");
        let mismatch = ProcessIdentity {
            pid: second.id(),
            spawned_at_ms: identity.spawned_at_ms,
            proof: identity.proof,
        };
        assert_eq!(
            NativeIdentityBackend.terminate(&mut second, &mismatch),
            Err(IdentityError::Mismatch)
        );
        let _ = first.kill();
        let _ = second.kill();
        let _ = first.wait();
        let _ = second.wait();
    }
}
