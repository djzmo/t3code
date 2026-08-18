//! Typed dispatch for requests and notifications arriving at the native shell.
//!
//! This module deliberately has no Tauri dependency.  The application layer
//! supplies [`ShellPlatform`] with the small set of native operations needed
//! by the host protocol.

use super::rpc_adapter::{RpcAdapterError, RpcProcessBroker};
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
}

/// Routes typed JSON-RPC envelopes to the platform and native process broker.
#[derive(Debug)]
pub struct ShellDispatcher<P> {
    platform: P,
    broker: RpcProcessBroker,
}

impl<P: ShellPlatform> ShellDispatcher<P> {
    #[must_use]
    pub fn new(platform: P, broker: RpcProcessBroker) -> Self {
        Self { platform, broker }
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

    pub fn notification(&mut self, notification: RpcNotification) {
        let params = notification.params;
        match notification.method {
            RpcMethod::AppQuit => {
                if params.is_none() || matches!(params, Some(RpcParams::Empty(_))) {
                    let _ = self.platform.app_quit();
                }
            }
            RpcMethod::AppExit => {
                if let Some(RpcParams::AppExit(params)) = params {
                    let _ = self.platform.app_exit(params);
                }
            }
            RpcMethod::AppRelaunch => {
                if params.is_none() || matches!(params, Some(RpcParams::Empty(_))) {
                    let _ = self.platform.app_relaunch();
                }
            }
            RpcMethod::AppFocus => {
                if let Some(RpcParams::AppFocus(params)) = params {
                    let _ = self.platform.app_focus(params);
                }
            }
            RpcMethod::AppShutdownComplete => {
                if params.is_none() || matches!(params, Some(RpcParams::Empty(_))) {
                    let _ = self.platform.app_shutdown_complete();
                }
            }
            RpcMethod::ProcessInput => {
                if let Some(RpcParams::ProcessInput(params)) = params {
                    let _ = self.broker.input(params);
                }
            }
            RpcMethod::ProcessKill => {
                if let Some(RpcParams::ProcessKill(params)) = params {
                    let _ = self.broker.kill(params);
                }
            }
            RpcMethod::ProcessRelease => {
                if let Some(RpcParams::ProcessRelease(params)) = params {
                    let _ = self.broker.release(params);
                }
            }
            RpcMethod::ProcessCancel => {
                if let Some(RpcParams::ProcessCancel(params)) = params {
                    let _ = self.broker.cancel(params);
                }
            }
            RpcMethod::ClipboardWriteText => {
                if let Some(RpcParams::ClipboardWriteText(params)) = params {
                    let _ = self.platform.clipboard_write_text(params);
                }
            }
            method if is_window_notification(method) => {
                if let Some(params) = params {
                    let _ = self.platform.window_notification(method, params);
                }
            }
            _ => {}
        }
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

    pub fn drain_broker_events(&mut self) -> Vec<Result<RpcNotification, RpcError>> {
        let mut events = Vec::new();
        while let Some(event) = self.next_broker_event() {
            events.push(event);
        }
        events
    }

    pub fn transport_close(&mut self) {
        self.broker.transport_close();
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
    use crate::host::{BrokerConfig, ProcessBroker};
    use crate::rpc::protocol::{JsonRpcVersion, ProcessKind, ProcessStreamMode, RpcId};
    use std::collections::BTreeMap;

    #[derive(Default)]
    struct FakePlatform {
        opened: Vec<String>,
        clipboard: Vec<String>,
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
            Ok(())
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
