//! Process identity and termination boundary.
//!
//! The broker never calls a Unix `kill(pid)` based only on a pid supplied by
//! the host.  The [`IdentityBackend`] trait is the explicit seam for the
//! platform implementation that proves a creation-time identity.  Until a
//! platform backend can make that proof, [`UnprovenIdentityBackend`] returns a
//! typed error and the broker fails closed.

use std::process::Child;
use std::time::SystemTime;

/// Proof attached to a retained child identity.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IdentityProof {
    /// On Windows, the retained `Child` owns an OS process handle.  Calling
    /// `Child::kill` uses that handle rather than looking up a reused pid.
    HandleBacked,
    /// A future Unix backend can record an OS start-time value and compare it
    /// before signalling.  The value is kept opaque to this crate.
    UnixStartTime { value: u64 },
    /// Spawn succeeded but this backend could not prove an exact identity.
    Unproven,
}

/// Identity captured at spawn time.  `pid` is informational unless the proof
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
/// operation.  The broker passes the retained `Child`, never a raw pid, so a
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

/// Fail-closed backend for Unix until an OS-native start-time comparison is
/// supplied.  It is also useful in tests that assert no raw-pid kill path.
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

/// The default backend.  Windows' retained process handle is an exact
/// identity; Unix intentionally remains fail-closed until a native backend is
/// selected by the shell integration.
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

        #[cfg(not(windows))]
        {
            let _ = child;
            Ok(ProcessIdentity::unproven(pid, millis(spawned_at)))
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

        #[cfg(not(windows))]
        {
            let _ = child;
            let _ = identity;
            // In particular, do not call Child::kill here: std's Unix
            // implementation resolves the pid at the time of the call and
            // cannot prove that the pid was not reused.
            Err(IdentityError::Unproven)
        }
    }
}

fn millis(time: SystemTime) -> u64 {
    time.duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}
