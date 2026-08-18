//! Renderer bridge primitives for the Tauri shell.
//!
//! The command handlers themselves are intentionally kept out of this module.
//! A Tauri command owns a runtime-specific [`tauri::State`] and webview, while
//! these small types keep the wire shape and security checks testable without a
//! running application.  The composition owner can register a command by
//! calling [`dispatch_host_invoke`] and use [`OrderedDesktopEvents`] for the
//! `desktop_events` channel.

use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

use crate::window::is_same_origin;

/// The only webview that may call the host bridge.
pub const MAIN_WEBVIEW_LABEL: &str = "main";

/// Upper bound for an IPC channel name.  Channel names are not opaque byte
/// streams: keeping this bounded prevents an accidental unbounded allocation
/// when a renderer is navigated to an untrusted page.
pub const MAX_CHANNEL_NAME_BYTES: usize = 256;

/// The JSON shape accepted by the `host_invoke` command.
///
/// This deliberately matches the renderer command object exactly:
/// `{ "channel": string, "payload": unknown }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostInvokeRequest {
    pub channel: String,
    pub payload: Value,
}

impl HostInvokeRequest {
    /// Validates the part of the request the shell can check without knowing
    /// the host's channel registry.  Payload validation belongs to the host.
    pub fn validate(&self) -> Result<(), BridgeError> {
        if self.channel.trim().is_empty() {
            return Err(BridgeError::InvalidChannel);
        }
        if self.channel.len() > MAX_CHANNEL_NAME_BYTES {
            return Err(BridgeError::ChannelTooLong {
                maximum: MAX_CHANNEL_NAME_BYTES,
            });
        }
        Ok(())
    }
}

/// The JSON shape returned by a successful `host_invoke` dispatch.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostInvokeResponse {
    pub result: Value,
}

/// The JSON event sent through the renderer's `desktop_events` channel.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopEvent {
    pub channel: String,
    pub payload: Value,
}

impl DesktopEvent {
    /// Builds an event after checking the channel name bound.
    pub fn new(channel: impl Into<String>, payload: Value) -> Result<Self, BridgeError> {
        let event = Self {
            channel: channel.into(),
            payload,
        };
        if event.channel.trim().is_empty() {
            return Err(BridgeError::InvalidChannel);
        }
        if event.channel.len() > MAX_CHANNEL_NAME_BYTES {
            return Err(BridgeError::ChannelTooLong {
                maximum: MAX_CHANNEL_NAME_BYTES,
            });
        }
        Ok(event)
    }
}

/// Context supplied by the Tauri command wrapper before it dispatches a
/// renderer request.  Keeping the context explicit makes the capability and
/// navigation invariant easy to test and difficult to accidentally omit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HostInvokeContext<'a> {
    pub webview_label: &'a str,
    pub application_url: &'a str,
    pub current_url: &'a str,
}

/// Errors returned by bridge validation or a host dispatch.
#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum BridgeError {
    #[error("host_invoke is only available to the main webview")]
    WebviewNotAllowed,
    #[error("host_invoke is unavailable to a foreign-origin webview")]
    OriginNotAllowed,
    #[error("IPC channel name must not be empty")]
    InvalidChannel,
    #[error("IPC channel name exceeds {maximum} bytes")]
    ChannelTooLong { maximum: usize },
    #[error("desktop event channel is closed: {0}")]
    ChannelClosed(String),
    #[error("host invocation failed: {0}")]
    Host(String),
}

/// Checks the command capability boundary before any payload is forwarded to
/// the Node host.  A capability file scopes the command to `main`; this runtime
/// check is a second line of defence for a stale or foreign webview.
pub fn authorize_host_invoke(context: HostInvokeContext<'_>) -> Result<(), BridgeError> {
    if context.webview_label != MAIN_WEBVIEW_LABEL {
        return Err(BridgeError::WebviewNotAllowed);
    }
    if !is_same_origin(context.application_url, context.current_url) {
        return Err(BridgeError::OriginNotAllowed);
    }
    Ok(())
}

/// Minimal host dispatch interface used by the Tauri command wrapper.
///
/// The host implementation can bridge this trait to the existing RPC peer,
/// while tests can provide a synchronous fake.  No async runtime or Tauri
/// state is required here.
pub trait HostInvokeHandler {
    fn invoke(&self, request: &HostInvokeRequest) -> Result<Value, String>;
}

/// Validates and dispatches one renderer invocation.
pub fn dispatch_host_invoke<H: HostInvokeHandler>(
    context: HostInvokeContext<'_>,
    request: HostInvokeRequest,
    handler: &H,
) -> Result<HostInvokeResponse, BridgeError> {
    authorize_host_invoke(context)?;
    request.validate()?;
    let result = handler.invoke(&request).map_err(BridgeError::Host)?;
    Ok(HostInvokeResponse { result })
}

/// A small adapter around a Tauri [`Channel`] that serialises sends.  Tauri
/// invokes a channel callback synchronously, but callers can originate pushes
/// on several host/reactor threads; the mutex gives those calls a single,
/// deterministic order.
pub trait DesktopEventSink: Send + Sync + 'static {
    fn send_event(&self, event: DesktopEvent) -> Result<(), String>;
}

impl DesktopEventSink for tauri::ipc::Channel<DesktopEvent> {
    fn send_event(&self, event: DesktopEvent) -> Result<(), String> {
        self.send(event).map_err(|error| error.to_string())
    }
}

/// Ordered push state for the `desktop_events` command.
pub struct OrderedDesktopEvents<S: DesktopEventSink> {
    sink: S,
    send_lock: Arc<Mutex<()>>,
}

impl<S: DesktopEventSink + Clone> Clone for OrderedDesktopEvents<S> {
    fn clone(&self) -> Self {
        Self {
            sink: self.sink.clone(),
            send_lock: Arc::clone(&self.send_lock),
        }
    }
}

impl<S: DesktopEventSink> OrderedDesktopEvents<S> {
    #[must_use]
    pub fn new(sink: S) -> Self {
        Self {
            sink,
            send_lock: Arc::new(Mutex::new(())),
        }
    }

    /// Sends one event.  The lock is held through the channel callback, so a
    /// later event cannot overtake an earlier one.
    pub fn push(&self, event: DesktopEvent) -> Result<(), BridgeError> {
        let _guard = self
            .send_lock
            .lock()
            .map_err(|_| BridgeError::ChannelClosed("send lock poisoned".to_owned()))?;
        self.sink
            .send_event(event)
            .map_err(BridgeError::ChannelClosed)
    }
}

/// Convenience alias for the runtime channel used by the Tauri command.
pub type TauriDesktopEvents = OrderedDesktopEvents<tauri::ipc::Channel<DesktopEvent>>;

/// Constructs the ordered sender that a `desktop_events { channel: Channel }`
/// command stores in host state.
#[must_use]
pub fn ordered_desktop_events(channel: tauri::ipc::Channel<DesktopEvent>) -> TauriDesktopEvents {
    OrderedDesktopEvents::new(channel)
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use serde_json::json;

    use super::*;

    struct EchoHandler;

    impl HostInvokeHandler for EchoHandler {
        fn invoke(&self, request: &HostInvokeRequest) -> Result<Value, String> {
            Ok(json!({ "channel": request.channel, "payload": request.payload }))
        }
    }

    #[test]
    fn host_invoke_round_trip_uses_canonical_shape() {
        let request: HostInvokeRequest = match serde_json::from_value(json!({
            "channel": "app.getMetrics",
            "payload": { "verbose": true }
        })) {
            Ok(value) => value,
            Err(error) => panic!("request shape should decode: {error}"),
        };
        let response = dispatch_host_invoke(
            HostInvokeContext {
                webview_label: MAIN_WEBVIEW_LABEL,
                application_url: "https://app.example/",
                current_url: "https://app.example/settings",
            },
            request,
            &EchoHandler,
        );
        assert!(response.is_ok());
        assert_eq!(
            response.ok().map(|value| value.result),
            Some(json!({ "channel": "app.getMetrics", "payload": { "verbose": true } }))
        );
    }

    #[test]
    fn foreign_webview_is_denied_even_on_same_origin() {
        let result = authorize_host_invoke(HostInvokeContext {
            webview_label: "preview",
            application_url: "https://app.example/",
            current_url: "https://app.example/",
        });
        assert_eq!(result, Err(BridgeError::WebviewNotAllowed));
    }

    #[test]
    fn foreign_origin_is_denied_even_in_main_webview() {
        let result = authorize_host_invoke(HostInvokeContext {
            webview_label: MAIN_WEBVIEW_LABEL,
            application_url: "https://app.example/",
            current_url: "https://evil.example/",
        });
        assert_eq!(result, Err(BridgeError::OriginNotAllowed));
    }

    #[derive(Clone)]
    struct RecordingSink(Arc<Mutex<Vec<DesktopEvent>>>);

    impl DesktopEventSink for RecordingSink {
        fn send_event(&self, event: DesktopEvent) -> Result<(), String> {
            let mut events = self
                .0
                .lock()
                .map_err(|_| "recording sink lock poisoned".to_owned())?;
            events.push(event);
            Ok(())
        }
    }

    #[test]
    fn desktop_events_preserve_push_order() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let sender = OrderedDesktopEvents::new(RecordingSink(Arc::clone(&events)));
        assert!(
            sender
                .push(DesktopEvent::new("first", json!(1)).expect("valid event"))
                .is_ok()
        );
        assert!(
            sender
                .push(DesktopEvent::new("second", json!(2)).expect("valid event"))
                .is_ok()
        );
        let recorded = events.lock().expect("recording lock not poisoned");
        assert_eq!(
            recorded
                .iter()
                .map(|event| event.channel.as_str())
                .collect::<Vec<_>>(),
            vec!["first", "second"]
        );
    }
}
