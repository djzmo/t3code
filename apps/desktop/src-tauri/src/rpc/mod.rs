//! JSON-RPC contracts shared by the Tauri shell and Node host.

pub mod protocol;

pub use protocol::{
    ProtocolError, ProtocolFixtureDocument, RpcEnvelope, RpcMethod, RpcRequest, RpcResponse,
    decode_envelope, fixture_document, validate_envelope, validate_fixture_document,
};
