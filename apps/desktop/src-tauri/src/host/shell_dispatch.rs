//! Typed dispatch for requests and notifications arriving at the native shell.
//!
//! This module deliberately has no Tauri dependency.  The application layer
//! supplies [`ShellPlatform`] with the small set of native operations needed
//! by the host protocol.

use super::rpc_adapter::{RpcAdapterError, RpcBrokerEventReceiver, RpcProcessBroker};
use crate::app_events::{
    self, AppEvent, AppEventAdapter, AppTransition, Effect as AppEventEffect, Platform,
};
use crate::lifecycle::{Action as LifecycleAction, Continuation, QuitReason, State};
use crate::rpc::protocol::{
    AppExitParams, AppFocusParams, AppProtocolClientParams, ClipboardWriteTextParams,
    DialogErrorParams, EmptyParams, IpcInvokeParams, ProcessMetric, ProcessRegisterParams,
    ProcessSpawnParams, RegisteredResult, RpcError, RpcErrorData, RpcErrorKind, RpcMethod,
    RpcNotification, RpcParams, RpcRequest, RpcResult, ShellOpenExternalParams, WindowBoundsResult,
    WindowCreateParams, WindowCreatedResult, WindowLabelParams, WindowStateResult,
};

/// Native operations required by the host/shell protocol.
///
/// Implementations may perform Tauri work, but this trait stays independent of
/// Tauri so dispatch can be tested with a deterministic fake.
pub trait ShellPlatform {
    fn app_quit(&mut self) -> Result<(), String>;
    fn app_exit(&mut self, params: AppExitParams) -> Result<(), String>;
    fn app_relaunch(&mut self) -> Result<(), String>;
    fn app_focus(&mut self, params: AppFocusParams) -> Result<(), String>;
    fn app_shutdown_complete(&mut self) -> Result<(), String>;
    fn app_is_protocol_client(
        &mut self,
        params: AppProtocolClientParams,
    ) -> Result<RegisteredResult, String>;
    fn app_set_protocol_client(
        &mut self,
        params: AppProtocolClientParams,
    ) -> Result<crate::rpc::protocol::OkResult, String>;
    fn app_get_metrics(&mut self) -> Result<Vec<ProcessMetric>, String>;

    fn window_create(&mut self, params: WindowCreateParams) -> Result<WindowCreatedResult, String>;
    fn window_get_bounds(
        &mut self,
        params: WindowLabelParams,
    ) -> Result<WindowBoundsResult, String>;
    fn window_get_state(&mut self, params: WindowLabelParams) -> Result<WindowStateResult, String>;
    fn window_notification(&mut self, method: RpcMethod, params: RpcParams) -> Result<(), String>;

    fn dialog_error(&mut self, params: DialogErrorParams) -> Result<(), String>;
    fn shell_open_external(
        &mut self,
        params: ShellOpenExternalParams,
    ) -> Result<crate::rpc::protocol::OkResult, String>;
    fn clipboard_write_text(&mut self, params: ClipboardWriteTextParams) -> Result<(), String>;

    /// Handles an `ipc.invoke` request sent by the host.
    fn ipc_invoke(
        &mut self,
        params: IpcInvokeParams,
    ) -> Result<crate::rpc::protocol::IpcInvokeResult, String>;

    /// Applies an app/lifecycle effect which is not owned by the process
    /// broker.  The Tauri integration uses this hook to send asynchronous
    /// notifications to the sidecar and to apply native actions (for example
    /// preventing a quit or passing through an already-authorized exit).
    ///
    /// The default keeps existing platform implementations source-compatible;
    /// a native integration that owns the lifecycle should override it.
    fn apply_app_effect(&mut self, _effect: AppEffect) -> Result<(), String> {
        Ok(())
    }

    /// Returns the host lifecycle platform used by [`AppEventAdapter`].
    ///
    /// Implementations may override this when a test or a launcher needs to
    /// model a platform different from the target OS.
    fn app_platform(&self) -> Platform {
        default_platform()
    }
}

/// App/lifecycle effects delegated to the native integration.
///
/// `TerminateManagedChildren` is intentionally absent: the dispatcher owns
/// that effect and applies it through [`RpcProcessBroker::transport_close`]
/// exactly once before feeding `ResidueTerminated` back into the reducer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppEffect {
    PreventExit,
    BeforeQuit { reason: QuitReason },
    BeforeQuitResponse { prevented: bool },
    WindowAllClosed,
    NotifyActivate { has_visible_windows: bool },
    FocusMainWindow { steal: bool },
    ShowHostError,
    Run(Continuation),
    PassThrough(Continuation),
}

/// Routes typed JSON-RPC envelopes to the platform and native process broker.
#[derive(Debug)]
pub struct ShellDispatcher<P> {
    platform: P,
    broker: RpcProcessBroker,
    app_events: AppEventAdapter,
    broker_cleanup_applied: bool,
}

impl<P: ShellPlatform> ShellDispatcher<P> {
    #[must_use]
    pub fn new(platform: P, broker: RpcProcessBroker) -> Self {
        let app_platform = platform.app_platform();
        Self::with_platform(platform, broker, app_platform)
    }

    /// Creates a dispatcher with an explicit lifecycle platform.
    #[must_use]
    pub fn with_platform(platform: P, broker: RpcProcessBroker, app_platform: Platform) -> Self {
        Self {
            platform,
            broker,
            app_events: AppEventAdapter::new(app_platform),
            broker_cleanup_applied: false,
        }
    }

    /// Alias for callers that prefer a constructor-style name.
    #[must_use]
    pub fn new_with_platform(
        platform: P,
        broker: RpcProcessBroker,
        app_platform: Platform,
    ) -> Self {
        Self::with_platform(platform, broker, app_platform)
    }

    #[must_use]
    pub fn app_state(&self) -> State {
        self.app_events.state()
    }

    #[must_use]
    pub fn app_platform(&self) -> Platform {
        self.app_events.platform()
    }

    #[must_use]
    pub fn broker_cleanup_applied(&self) -> bool {
        self.broker_cleanup_applied
    }

    pub fn request(&mut self, request: RpcRequest) -> Result<RpcResult, RpcError> {
        let params = request.params;
        match request.method {
            RpcMethod::AppIsProtocolClient => {
                let params =
                    expect_params(params, RpcMethod::AppIsProtocolClient, "AppProtocolClient")?;
                self.platform
                    .app_is_protocol_client(expect_app_protocol_client(
                        RpcMethod::AppIsProtocolClient,
                        params,
                    )?)
                    .map(RpcResult::Registered)
                    .map_err(platform_error)
            }
            RpcMethod::AppSetProtocolClient => {
                let params =
                    expect_params(params, RpcMethod::AppSetProtocolClient, "AppProtocolClient")?;
                self.platform
                    .app_set_protocol_client(expect_app_protocol_client(
                        RpcMethod::AppSetProtocolClient,
                        params,
                    )?)
                    .map(RpcResult::Ok)
                    .map_err(platform_error)
            }
            RpcMethod::AppGetMetrics => {
                expect_empty(params, RpcMethod::AppGetMetrics)?;
                self.platform
                    .app_get_metrics()
                    .map(RpcResult::Metrics)
                    .map_err(platform_error)
            }
            RpcMethod::ProcessRegister => {
                let params = expect_params(params, RpcMethod::ProcessRegister, "ProcessRegister")?;
                self.broker
                    .register(expect_process_register(params)?)
                    .map(RpcResult::Registration)
                    .map_err(adapter_error)
            }
            RpcMethod::ProcessSpawn => {
                let params = expect_params(params, RpcMethod::ProcessSpawn, "ProcessSpawn")?;
                self.broker
                    .spawn(expect_process_spawn(params)?)
                    .map(RpcResult::ProcessSpawn)
                    .map_err(adapter_error)
            }
            RpcMethod::IpcInvoke => {
                let params = expect_params(params, RpcMethod::IpcInvoke, "IpcInvoke")?;
                self.platform
                    .ipc_invoke(expect_ipc_invoke(params)?)
                    .map(RpcResult::IpcInvoke)
                    .map_err(platform_error)
            }
            RpcMethod::WindowCreate => {
                let params = expect_params(params, RpcMethod::WindowCreate, "WindowCreate")?;
                self.platform
                    .window_create(expect_window_create(params)?)
                    .map(RpcResult::WindowCreated)
                    .map_err(platform_error)
            }
            RpcMethod::WindowGetBounds => {
                let params = expect_params(params, RpcMethod::WindowGetBounds, "WindowLabel")?;
                self.platform
                    .window_get_bounds(expect_window_label(RpcMethod::WindowGetBounds, params)?)
                    .map(RpcResult::WindowBounds)
                    .map_err(platform_error)
            }
            RpcMethod::WindowGetState => {
                let params = expect_params(params, RpcMethod::WindowGetState, "WindowLabel")?;
                self.platform
                    .window_get_state(expect_window_label(RpcMethod::WindowGetState, params)?)
                    .map(RpcResult::WindowState)
                    .map_err(platform_error)
            }
            RpcMethod::DialogError => {
                let params = expect_params(params, RpcMethod::DialogError, "DialogError")?;
                self.platform
                    .dialog_error(expect_dialog_error(params)?)
                    .map(|()| RpcResult::Empty(crate::rpc::protocol::EmptyResult {}))
                    .map_err(platform_error)
            }
            RpcMethod::ShellOpenExternal => {
                let params =
                    expect_params(params, RpcMethod::ShellOpenExternal, "ShellOpenExternal")?;
                self.platform
                    .shell_open_external(expect_shell_open_external(params)?)
                    .map(RpcResult::Ok)
                    .map_err(platform_error)
            }
            method => Err(unsupported(method)),
        }
    }

    /// Reduces and applies one native/peer lifecycle event.
    ///
    /// The reducer is updated before effects are applied.  If a transition
    /// requests managed-child cleanup, the broker transport is closed once,
    /// then `ResidueTerminated` is fed back into the reducer before any
    /// resulting `Run`/`PassThrough` effect is delegated to the platform.
    pub fn dispatch_app_event(&mut self, event: AppEvent) -> Result<AppTransition, RpcError> {
        let transition = self.app_events.dispatch(event);
        self.apply_app_transition(transition)
    }

    fn apply_app_transition(
        &mut self,
        transition: AppTransition,
    ) -> Result<AppTransition, RpcError> {
        let mut state = transition.state;
        let mut effects = transition.effects;
        let mut index = 0;
        while index < effects.len() {
            let effect = effects[index];
            if matches!(
                effect,
                AppEventEffect::Lifecycle(LifecycleAction::TerminateManagedChildren)
            ) {
                if !self.broker_cleanup_applied {
                    // Set the guard before invoking the broker.  This keeps
                    // the operation one-shot even if a platform callback
                    // re-enters the dispatcher while cleanup is in progress.
                    self.broker_cleanup_applied = true;
                    self.broker.transport_close();
                }
                let residue = self.feed_residue_terminated();
                state = residue.state;
                // Insert the reducer's continuation immediately after the
                // cleanup action so it always runs after broker teardown.
                for generated in residue.effects.into_iter().rev() {
                    effects.insert(index + 1, generated);
                }
            } else {
                if let Some(platform_effect) = to_platform_effect(effect) {
                    self.platform
                        .apply_app_effect(platform_effect)
                        .map_err(platform_error)?;
                }
            }
            index += 1;
        }
        Ok(AppTransition { state, effects })
    }

    fn feed_residue_terminated(&mut self) -> AppTransition {
        let transition = crate::lifecycle::transition(
            self.app_events.state(),
            crate::lifecycle::Event::ResidueTerminated,
        );
        self.app_events = AppEventAdapter::with_state(self.app_events.platform(), transition.state);
        AppTransition {
            state: transition.state,
            effects: transition
                .actions
                .into_iter()
                .map(AppEventEffect::Lifecycle)
                .collect(),
        }
    }

    /// Handles a host notification and returns native failures to the caller.
    ///
    /// Notifications have no wire response, but silently dropping process,
    /// window, clipboard, or platform errors leaves the host believing an
    /// operation succeeded. The shell runtime can log this result or close
    /// the transport while keeping the protocol's one-way shape intact.
    pub fn notification(&mut self, notification: RpcNotification) -> Result<(), RpcError> {
        if matches!(
            notification.method,
            RpcMethod::AppQuit
                | RpcMethod::AppExit
                | RpcMethod::AppRelaunch
                | RpcMethod::AppFocus
                | RpcMethod::AppShutdownComplete
        ) {
            let event = app_events::decode_notification(&notification).map_err(decode_error)?;
            self.dispatch_app_event(AppEvent::Host(event))?;
            return Ok(());
        }
        let params = notification.params;
        match notification.method {
            RpcMethod::ProcessInput => {
                if let Some(RpcParams::ProcessInput(params)) = params {
                    self.broker
                        .input(params)
                        .map(|_| ())
                        .map_err(adapter_error)?;
                }
            }
            RpcMethod::ProcessKill => {
                if let Some(RpcParams::ProcessKill(params)) = params {
                    self.broker
                        .kill(params)
                        .map(|_| ())
                        .map_err(adapter_error)?;
                }
            }
            RpcMethod::ProcessRelease => {
                if let Some(RpcParams::ProcessRelease(params)) = params {
                    self.broker
                        .release(params)
                        .map(|_| ())
                        .map_err(adapter_error)?;
                }
            }
            RpcMethod::ProcessCancel => {
                if let Some(RpcParams::ProcessCancel(params)) = params {
                    self.broker
                        .cancel(params)
                        .map(|_| ())
                        .map_err(adapter_error)?;
                }
            }
            RpcMethod::ClipboardWriteText => {
                if let Some(RpcParams::ClipboardWriteText(params)) = params {
                    self.platform
                        .clipboard_write_text(params)
                        .map_err(platform_error)?;
                }
            }
            method if is_window_notification(method) => {
                if let Some(params) = params {
                    self.platform
                        .window_notification(method, params)
                        .map_err(platform_error)?;
                }
            }
            _ => {}
        }
        Ok(())
    }

    #[must_use]
    pub fn next_broker_event(&mut self) -> Option<Result<RpcNotification, RpcError>> {
        self.broker
            .next_event()
            .map(|result| result.map_err(adapter_error))
    }

    pub fn try_next_broker_event(&mut self) -> Option<Result<RpcNotification, RpcError>> {
        self.broker
            .try_next_event()
            .map(|result| result.map_err(adapter_error))
    }

    /// Returns a blocking event receiver that does not borrow the dispatcher.
    ///
    /// Call this once before moving the dispatcher into its request/notification
    /// mutex, then consume `receiver.next()` from a dedicated event task.
    #[must_use]
    pub fn subscribe_broker_events(&self) -> RpcBrokerEventReceiver {
        self.broker.subscribe_events()
    }

    pub fn drain_broker_events(&mut self) -> Vec<Result<RpcNotification, RpcError>> {
        let mut events = Vec::new();
        while let Some(event) = self.next_broker_event() {
            events.push(event);
        }
        events
    }

    pub fn transport_close(&mut self) {
        if !self.broker_cleanup_applied {
            self.broker_cleanup_applied = true;
            self.broker.transport_close();
        }
    }
}

fn is_window_notification(method: RpcMethod) -> bool {
    matches!(
        method,
        RpcMethod::WindowShow
            | RpcMethod::WindowHide
            | RpcMethod::WindowClose
            | RpcMethod::WindowDestroy
            | RpcMethod::WindowFocus
            | RpcMethod::WindowMinimize
            | RpcMethod::WindowRestore
            | RpcMethod::WindowMaximize
            | RpcMethod::WindowUnmaximize
            | RpcMethod::WindowReload
            | RpcMethod::WindowToggleDevTools
            | RpcMethod::WindowSetFullscreen
            | RpcMethod::WindowSetTitle
            | RpcMethod::WindowSetBounds
            | RpcMethod::WindowSetBackgroundColor
            | RpcMethod::WindowSetZoom
            | RpcMethod::WindowSetAlwaysOnTop
    )
}

fn to_platform_effect(effect: AppEventEffect) -> Option<AppEffect> {
    match effect {
        AppEventEffect::Lifecycle(LifecycleAction::PreventExit) => Some(AppEffect::PreventExit),
        AppEventEffect::Lifecycle(LifecycleAction::BeforeQuit { reason }) => {
            Some(AppEffect::BeforeQuit { reason })
        }
        AppEventEffect::Lifecycle(LifecycleAction::WindowAllClosed) => {
            Some(AppEffect::WindowAllClosed)
        }
        AppEventEffect::Lifecycle(LifecycleAction::ShowHostError) => Some(AppEffect::ShowHostError),
        AppEventEffect::Lifecycle(LifecycleAction::Run(continuation)) => {
            Some(AppEffect::Run(continuation))
        }
        AppEventEffect::Lifecycle(LifecycleAction::PassThrough(continuation)) => {
            Some(AppEffect::PassThrough(continuation))
        }
        AppEventEffect::BeforeQuitResponse { prevented } => {
            Some(AppEffect::BeforeQuitResponse { prevented })
        }
        AppEventEffect::NotifyActivate {
            has_visible_windows,
        } => Some(AppEffect::NotifyActivate {
            has_visible_windows,
        }),
        AppEventEffect::FocusMainWindow { steal } => Some(AppEffect::FocusMainWindow { steal }),
        AppEventEffect::Lifecycle(LifecycleAction::TerminateManagedChildren) => None,
    }
}

fn decode_error(error: app_events::DecodeError) -> RpcError {
    let (code, kind) = match error {
        app_events::DecodeError::UnsupportedMethod(_) => (-32601, RpcErrorKind::Unsupported),
        app_events::DecodeError::RequestNotNotification
        | app_events::DecodeError::ResponseNotNotification
        | app_events::DecodeError::InvalidParams(_)
        | app_events::DecodeError::InvalidExitCode(_)
        | app_events::DecodeError::InvalidBeforeQuitResult
        | app_events::DecodeError::BeforeQuitFailed => (-32602, RpcErrorKind::InvalidParams),
    };
    RpcError {
        code,
        message: error.to_string(),
        data: Some(RpcErrorData { kind }),
    }
}

fn default_platform() -> Platform {
    #[cfg(target_os = "macos")]
    {
        Platform::Macos
    }
    #[cfg(target_os = "windows")]
    {
        Platform::Windows
    }
    #[cfg(target_os = "linux")]
    {
        Platform::Linux
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        Platform::Other
    }
}

fn expect_params(
    params: Option<RpcParams>,
    method: RpcMethod,
    expected: &str,
) -> Result<RpcParams, RpcError> {
    params.ok_or_else(|| invalid_params(method, format!("expected {expected} params")))
}

fn expect_empty(params: Option<RpcParams>, method: RpcMethod) -> Result<(), RpcError> {
    match params {
        Some(RpcParams::Empty(EmptyParams {})) | None => Ok(()),
        Some(_) => Err(invalid_params(method, "expected empty params")),
    }
}

fn expect_app_protocol_client(
    method: RpcMethod,
    params: RpcParams,
) -> Result<AppProtocolClientParams, RpcError> {
    match params {
        RpcParams::AppProtocolClient(value) => Ok(value),
        _ => Err(invalid_params(method, "wrong params shape")),
    }
}

fn expect_process_register(params: RpcParams) -> Result<ProcessRegisterParams, RpcError> {
    match params {
        RpcParams::ProcessRegister(value) => Ok(value),
        _ => Err(invalid_params(
            RpcMethod::ProcessRegister,
            "wrong params shape",
        )),
    }
}

fn expect_process_spawn(params: RpcParams) -> Result<ProcessSpawnParams, RpcError> {
    match params {
        RpcParams::ProcessSpawn(value) => Ok(value),
        _ => Err(invalid_params(
            RpcMethod::ProcessSpawn,
            "wrong params shape",
        )),
    }
}

fn expect_ipc_invoke(params: RpcParams) -> Result<IpcInvokeParams, RpcError> {
    match params {
        RpcParams::IpcInvoke(value) => Ok(value),
        _ => Err(invalid_params(RpcMethod::IpcInvoke, "wrong params shape")),
    }
}

fn expect_window_create(params: RpcParams) -> Result<WindowCreateParams, RpcError> {
    match params {
        RpcParams::WindowCreate(value) => Ok(value),
        _ => Err(invalid_params(
            RpcMethod::WindowCreate,
            "wrong params shape",
        )),
    }
}

fn expect_window_label(
    method: RpcMethod,
    params: RpcParams,
) -> Result<WindowLabelParams, RpcError> {
    match params {
        RpcParams::WindowLabel(value) => Ok(value),
        _ => Err(invalid_params(method, "wrong params shape")),
    }
}

fn expect_dialog_error(params: RpcParams) -> Result<DialogErrorParams, RpcError> {
    match params {
        RpcParams::DialogError(value) => Ok(value),
        _ => Err(invalid_params(RpcMethod::DialogError, "wrong params shape")),
    }
}

fn expect_shell_open_external(params: RpcParams) -> Result<ShellOpenExternalParams, RpcError> {
    match params {
        RpcParams::ShellOpenExternal(value) => Ok(value),
        _ => Err(invalid_params(
            RpcMethod::ShellOpenExternal,
            "wrong params shape",
        )),
    }
}

fn invalid_params(method: RpcMethod, message: impl Into<String>) -> RpcError {
    RpcError {
        code: -32602,
        message: format!("{method:?}: {}", message.into()),
        data: Some(RpcErrorData {
            kind: RpcErrorKind::InvalidParams,
        }),
    }
}

fn unsupported(method: RpcMethod) -> RpcError {
    RpcError {
        code: -32601,
        message: format!("unsupported method: {method:?}"),
        data: Some(RpcErrorData {
            kind: RpcErrorKind::Unsupported,
        }),
    }
}

fn platform_error(message: String) -> RpcError {
    RpcError {
        code: -32000,
        message,
        data: Some(RpcErrorData {
            kind: RpcErrorKind::Platform,
        }),
    }
}

fn adapter_error(error: RpcAdapterError) -> RpcError {
    let kind = match error {
        RpcAdapterError::InvalidRequest(_)
        | RpcAdapterError::InvalidBase64
        | RpcAdapterError::UnsupportedSignal(_) => RpcErrorKind::InvalidParams,
        _ => RpcErrorKind::Platform,
    };
    let code = if matches!(&kind, RpcErrorKind::InvalidParams) {
        -32602
    } else {
        -32000
    };
    RpcError {
        code,
        message: error.to_string(),
        data: Some(RpcErrorData { kind }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_events::{AppEvent, NativeEvent};
    use crate::host::{BrokerConfig, ProcessBroker};
    use crate::lifecycle::{Continuation, QuitReason};
    use crate::rpc::protocol::{JsonRpcVersion, ProcessKind, ProcessStreamMode, RpcId};
    use std::collections::BTreeMap;

    struct FakePlatform {
        opened: Vec<String>,
        clipboard: Vec<String>,
        app_effects: Vec<AppEffect>,
        fail_window_notifications: bool,
        fail_clipboard: bool,
        lifecycle_platform: Platform,
    }

    impl Default for FakePlatform {
        fn default() -> Self {
            Self {
                opened: Vec::new(),
                clipboard: Vec::new(),
                app_effects: Vec::new(),
                fail_window_notifications: false,
                fail_clipboard: false,
                lifecycle_platform: Platform::Linux,
            }
        }
    }

    impl ShellPlatform for FakePlatform {
        fn app_quit(&mut self) -> Result<(), String> {
            Ok(())
        }
        fn app_exit(&mut self, _: AppExitParams) -> Result<(), String> {
            Ok(())
        }
        fn app_relaunch(&mut self) -> Result<(), String> {
            Ok(())
        }
        fn app_focus(&mut self, _: AppFocusParams) -> Result<(), String> {
            Ok(())
        }
        fn app_shutdown_complete(&mut self) -> Result<(), String> {
            Ok(())
        }
        fn app_is_protocol_client(
            &mut self,
            _: AppProtocolClientParams,
        ) -> Result<RegisteredResult, String> {
            Ok(RegisteredResult { registered: true })
        }
        fn app_set_protocol_client(
            &mut self,
            _: AppProtocolClientParams,
        ) -> Result<crate::rpc::protocol::OkResult, String> {
            Ok(crate::rpc::protocol::OkResult { ok: true })
        }
        fn app_get_metrics(&mut self) -> Result<Vec<ProcessMetric>, String> {
            Ok(Vec::new())
        }
        fn window_create(
            &mut self,
            params: WindowCreateParams,
        ) -> Result<WindowCreatedResult, String> {
            Ok(WindowCreatedResult {
                label: params.label,
            })
        }
        fn window_get_bounds(
            &mut self,
            _: WindowLabelParams,
        ) -> Result<WindowBoundsResult, String> {
            Ok(WindowBoundsResult {
                x: 0,
                y: 0,
                width: 10,
                height: 10,
                maximized: false,
            })
        }
        fn window_get_state(&mut self, _: WindowLabelParams) -> Result<WindowStateResult, String> {
            Ok(WindowStateResult {
                visible: true,
                focused: true,
                minimized: false,
                maximized: false,
                fullscreen: false,
                destroyed: false,
            })
        }
        fn window_notification(&mut self, _: RpcMethod, _: RpcParams) -> Result<(), String> {
            if self.fail_window_notifications {
                Err("window operation failed".to_owned())
            } else {
                Ok(())
            }
        }
        fn dialog_error(&mut self, _: DialogErrorParams) -> Result<(), String> {
            Ok(())
        }
        fn shell_open_external(
            &mut self,
            params: ShellOpenExternalParams,
        ) -> Result<crate::rpc::protocol::OkResult, String> {
            self.opened.push(params.url);
            Ok(crate::rpc::protocol::OkResult { ok: true })
        }
        fn clipboard_write_text(&mut self, params: ClipboardWriteTextParams) -> Result<(), String> {
            if self.fail_clipboard {
                return Err("clipboard operation failed".to_owned());
            }
            self.clipboard.push(params.text);
            Ok(())
        }
        fn ipc_invoke(
            &mut self,
            params: IpcInvokeParams,
        ) -> Result<crate::rpc::protocol::IpcInvokeResult, String> {
            Ok(crate::rpc::protocol::IpcInvokeResult {
                result: params.payload,
            })
        }

        fn apply_app_effect(&mut self, effect: AppEffect) -> Result<(), String> {
            self.app_effects.push(effect);
            Ok(())
        }

        fn app_platform(&self) -> Platform {
            self.lifecycle_platform
        }
    }

    fn dispatcher() -> ShellDispatcher<FakePlatform> {
        ShellDispatcher::new(
            FakePlatform::default(),
            RpcProcessBroker::new(ProcessBroker::new(BrokerConfig::default())),
        )
    }

    fn request(method: RpcMethod, params: Option<RpcParams>) -> RpcRequest {
        RpcRequest {
            jsonrpc: JsonRpcVersion::V2,
            id: 1_i64 as RpcId,
            method,
            params,
        }
    }

    fn notification(method: RpcMethod, params: Option<RpcParams>) -> RpcNotification {
        RpcNotification {
            jsonrpc: JsonRpcVersion::V2,
            method,
            params,
        }
    }

    fn empty_notification(method: RpcMethod) -> RpcNotification {
        notification(method, None)
    }

    fn app_effects(dispatch: &ShellDispatcher<FakePlatform>) -> &[AppEffect] {
        &dispatch.platform.app_effects
    }

    #[test]
    fn first_and_second_host_quit_follow_cleanup_then_run_order() {
        let mut dispatch = dispatcher();

        dispatch
            .notification(empty_notification(RpcMethod::AppQuit))
            .expect("first app.quit should decode");
        assert_eq!(
            dispatch.app_state(),
            State::QuitRequested {
                reason: QuitReason::Host,
                continuation: Continuation::Exit(0),
            }
        );
        assert_eq!(
            app_effects(&dispatch),
            &[
                AppEffect::PreventExit,
                AppEffect::BeforeQuit {
                    reason: QuitReason::Host,
                },
            ]
        );
        assert!(!dispatch.broker_cleanup_applied());

        dispatch
            .notification(empty_notification(RpcMethod::AppQuit))
            .expect("second app.quit should decode");
        assert_eq!(
            dispatch.app_state(),
            State::ExitAuthorized {
                continuation: Continuation::Exit(0),
            }
        );
        assert_eq!(
            app_effects(&dispatch),
            &[
                AppEffect::PreventExit,
                AppEffect::BeforeQuit {
                    reason: QuitReason::Host,
                },
                AppEffect::Run(Continuation::Exit(0)),
            ]
        );
        assert!(dispatch.broker_cleanup_applied());

        // A repeated acknowledgement is a pass-through continuation and does
        // not execute broker teardown a second time.
        dispatch
            .notification(empty_notification(RpcMethod::AppQuit))
            .expect("repeated app.quit should remain valid");
        assert_eq!(
            app_effects(&dispatch).last(),
            Some(&AppEffect::PassThrough(Continuation::Exit(0)))
        );
        assert!(dispatch.broker_cleanup_applied());
    }

    #[test]
    fn shutdown_complete_acknowledges_quit_before_run() {
        let mut dispatch = dispatcher();
        dispatch
            .notification(empty_notification(RpcMethod::AppQuit))
            .expect("quit should decode");
        dispatch
            .notification(empty_notification(RpcMethod::AppShutdownComplete))
            .expect("shutdown-complete should decode");
        assert_eq!(
            dispatch.app_state(),
            State::ExitAuthorized {
                continuation: Continuation::Exit(0),
            }
        );
        assert_eq!(
            app_effects(&dispatch).last(),
            Some(&AppEffect::Run(Continuation::Exit(0)))
        );
        assert!(dispatch.broker_cleanup_applied());
    }

    #[test]
    fn relaunch_then_exit_zero_preserves_restart_and_cleans_once() {
        let mut dispatch = dispatcher();
        dispatch
            .notification(empty_notification(RpcMethod::AppRelaunch))
            .expect("relaunch should decode");
        assert_eq!(
            dispatch.app_state(),
            State::ExitAuthorized {
                continuation: Continuation::Restart,
            }
        );
        assert_eq!(
            app_effects(&dispatch),
            &[AppEffect::Run(Continuation::Restart),]
        );
        dispatch
            .notification(notification(
                RpcMethod::AppExit,
                Some(RpcParams::AppExit(AppExitParams { code: 0 })),
            ))
            .expect("exit should decode");
        assert_eq!(
            app_effects(&dispatch).last(),
            Some(&AppEffect::PassThrough(Continuation::Restart))
        );
        assert!(dispatch.broker_cleanup_applied());
    }

    #[test]
    fn app_exit_75_is_authorized_with_exact_code() {
        let mut dispatch = dispatcher();
        dispatch
            .notification(notification(
                RpcMethod::AppExit,
                Some(RpcParams::AppExit(AppExitParams { code: 75 })),
            ))
            .expect("exit 75 should decode");
        assert_eq!(
            dispatch.app_state(),
            State::ExitAuthorized {
                continuation: Continuation::Exit(75),
            }
        );
        assert_eq!(
            app_effects(&dispatch),
            &[AppEffect::Run(Continuation::Exit(75))]
        );
        assert!(dispatch.broker_cleanup_applied());
    }

    #[test]
    fn last_window_is_prevented_and_forwarded_without_cleanup() {
        let mut dispatch = dispatcher();
        let transition = dispatch
            .dispatch_app_event(AppEvent::Native(NativeEvent::LastWindowClosed))
            .expect("last-window event should apply");
        assert_eq!(transition.state, State::Running);
        assert_eq!(
            app_effects(&dispatch),
            &[AppEffect::PreventExit, AppEffect::WindowAllClosed]
        );
        assert!(!dispatch.broker_cleanup_applied());
    }

    #[test]
    fn peer_close_cleans_managed_children_before_error_and_exit() {
        let mut dispatch = dispatcher();
        let transition = dispatch
            .dispatch_app_event(AppEvent::PeerClosed)
            .expect("peer close should apply");
        assert_eq!(transition.state, State::Failed);
        assert_eq!(
            app_effects(&dispatch),
            &[
                AppEffect::ShowHostError,
                AppEffect::Run(Continuation::Exit(1)),
            ]
        );
        assert!(dispatch.broker_cleanup_applied());
    }

    #[test]
    fn lifecycle_app_notifications_reject_wrong_or_out_of_range_params() {
        let mut dispatch = dispatcher();
        for invalid in [
            notification(
                RpcMethod::AppQuit,
                Some(RpcParams::AppExit(AppExitParams { code: 0 })),
            ),
            notification(
                RpcMethod::AppRelaunch,
                Some(RpcParams::AppFocus(AppFocusParams { steal: true })),
            ),
            notification(
                RpcMethod::AppExit,
                Some(RpcParams::AppExit(AppExitParams {
                    code: i64::from(i32::MAX) + 1,
                })),
            ),
            notification(RpcMethod::AppFocus, Some(RpcParams::Empty(EmptyParams {}))),
            notification(
                RpcMethod::AppShutdownComplete,
                Some(RpcParams::AppExit(AppExitParams { code: 0 })),
            ),
        ] {
            let result = dispatch.notification(invalid);
            assert_eq!(result.as_ref().err().map(|error| error.code), Some(-32602));
            assert_eq!(dispatch.app_state(), State::Running);
            assert!(app_effects(&dispatch).is_empty());
        }
    }

    #[test]
    fn rejects_wrong_request_shape_with_invalid_params() {
        let mut dispatch = dispatcher();
        let result = dispatch.request(request(
            RpcMethod::WindowGetBounds,
            Some(RpcParams::Empty(EmptyParams {})),
        ));
        assert_eq!(result.as_ref().err().map(|error| error.code), Some(-32602));
    }

    #[test]
    fn opens_only_the_platform_validated_url() {
        let mut dispatch = dispatcher();
        let result = dispatch.request(request(
            RpcMethod::ShellOpenExternal,
            Some(RpcParams::ShellOpenExternal(ShellOpenExternalParams {
                url: "https://example.com".to_owned(),
            })),
        ));
        assert!(matches!(
            result,
            Ok(RpcResult::Ok(crate::rpc::protocol::OkResult { ok: true }))
        ));
    }

    #[test]
    fn notification_errors_are_observable_to_the_shell_runtime() {
        let mut dispatch = ShellDispatcher::new(
            FakePlatform {
                fail_window_notifications: true,
                ..FakePlatform::default()
            },
            RpcProcessBroker::new(ProcessBroker::new(BrokerConfig::default())),
        );
        let result = dispatch.notification(RpcNotification {
            jsonrpc: JsonRpcVersion::V2,
            method: RpcMethod::WindowShow,
            params: Some(RpcParams::WindowLabel(WindowLabelParams {
                label: "main".to_owned(),
            })),
        });
        assert!(matches!(
            result,
            Err(RpcError {
                code: -32000,
                message,
                ..
            }) if message == "window operation failed"
        ));

        let mut process_dispatch = dispatcher();
        let result = process_dispatch.notification(RpcNotification {
            jsonrpc: JsonRpcVersion::V2,
            method: RpcMethod::ProcessCancel,
            params: Some(RpcParams::ProcessCancel(
                crate::rpc::protocol::ProcessCancelParams {
                    attempt_id: "missing".to_owned(),
                },
            )),
        });
        assert!(matches!(result, Err(RpcError { code: -32000, .. })));
    }

    #[test]
    fn spawns_fixture_through_native_broker() {
        #[cfg(windows)]
        let (command, args) = (
            "cmd",
            vec!["/D".to_owned(), "/C".to_owned(), "exit 0".to_owned()],
        );
        #[cfg(not(windows))]
        let (command, args) = ("sh", vec!["-c".to_owned(), "exit 0".to_owned()]);
        let mut dispatch = dispatcher();
        let params = ProcessSpawnParams {
            attempt_id: "attempt-test".to_owned(),
            kind: ProcessKind::Other,
            command: command.to_owned(),
            args,
            cwd: None,
            env: BTreeMap::new(),
            extend_env: true,
            stdin: ProcessStreamMode::Pipe,
            stdout: ProcessStreamMode::Pipe,
            stderr: ProcessStreamMode::Pipe,
            additional_fds: Vec::new(),
        };
        let result = dispatch.request(request(
            RpcMethod::ProcessSpawn,
            Some(RpcParams::ProcessSpawn(params)),
        ));
        assert!(matches!(result, Ok(RpcResult::ProcessSpawn(_))));
    }
}
