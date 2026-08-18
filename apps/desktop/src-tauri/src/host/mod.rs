//! Native child-process supervision for the shell/host boundary.
//!
//! The host broker is intentionally independent from Tauri and from the JSON
//! RPC codec.  It owns the native [`std::process::Child`] handle from the
//! instant `spawn` returns, and only then exposes an attempt token that the
//! transport can acknowledge.  The parent crate can mount this module with
//! `pub mod host;` without changing the broker's API.

mod broker;
mod identity;

pub use broker::{
    BrokerConfig, BrokerError, BrokerEvent, EventStream, ExitStatusInfo, MAX_OUTPUT_CHUNK_BYTES,
    OutputStream, ProcessBroker, ProcessKind, RegistrationOutcome, ReleaseOutcome, SpawnRequest,
    SpawnedProcess, StdinOutcome,
};
pub use identity::{
    IdentityBackend, IdentityError, IdentityProof, NativeIdentityBackend, ProcessIdentity,
    TerminateResult, UnprovenIdentityBackend,
};
