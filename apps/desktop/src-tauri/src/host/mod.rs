//! Native child-process supervision for the shell/host boundary.
//!
//! The host broker is intentionally independent from Tauri and from the JSON
//! RPC codec.  It owns the native [`std::process::Child`] handle from the
//! instant `spawn` returns, and only then exposes an attempt token that the
//! transport can acknowledge.  The parent crate can mount this module with
//! `pub mod host;` without changing the broker's API.

mod broker;
mod identity;
pub mod rpc_adapter;
pub mod shell_dispatch;
pub mod sidecar;

pub use broker::{
    AttemptToken, BrokerConfig, BrokerError, BrokerEvent, EventStream, ExitStatusInfo,
    MAX_OUTPUT_CHUNK_BYTES, OutputStream, ProcessBroker, ProcessKind, RegistrationOutcome,
    RegistrationToken, ReleaseOutcome, SpawnRequest, SpawnedProcess, StdinOutcome,
};
pub use identity::{
    IdentityBackend, IdentityError, IdentityProof, NativeIdentityBackend, ProcessIdentity,
    TerminateResult, UnprovenIdentityBackend,
};
pub use rpc_adapter::{RpcBrokerEventReceiver, RpcProcessBroker};
pub use shell_dispatch::{AppEffect, ShellDispatcher, ShellPlatform};
pub use sidecar::{SidecarHandlers, SidecarSpawnSpec, SidecarSupervisor};
