#![forbid(unsafe_code)]

use std::collections::HashSet;
use std::env;
use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use agent_nanoni_desktop::app_events::{
    AppEvent, AppTransition, HostNotification, NativeEvent, Platform as AppPlatform,
};
use agent_nanoni_desktop::bridge::{
    DesktopEvent, HostInvokeContext, HostInvokeHandler, HostInvokeRequest, TauriDesktopEvents,
    dispatch_host_invoke, ordered_desktop_events,
};
use agent_nanoni_desktop::host::{
    AppEffect, BrokerConfig, ProcessBroker, RpcBrokerEventReceiver, RpcProcessBroker,
    ShellDispatcher, ShellPlatform, SidecarHandlers, SidecarSpawnSpec, SidecarSupervisor,
};
use agent_nanoni_desktop::lifecycle::{
    Continuation, QuitReason as LifecycleQuitReason, SHELL_QUIT_DEADLINE,
};
use agent_nanoni_desktop::opener::validate_external_url;
use agent_nanoni_desktop::rpc::protocol::{
    AppBeforeQuitParams, AppExitParams, AppFocusParams, AppProtocolClientParams,
    ClipboardWriteTextParams, DialogErrorParams, IpcInvokeParams, IpcInvokeResult, OkResult,
    ProcessMetric, RegisteredResult, RpcEnvelope, RpcMethod, RpcNotification, RpcParams,
    RpcRequest, RpcResponse, RpcResult, ShellHelloResult, ShellOpenExternalParams,
    WindowAlwaysOnTopParams, WindowBackgroundColorParams, WindowBoundsParams, WindowBoundsResult,
    WindowCreateParams, WindowCreatedResult, WindowEventParams, WindowEventType,
    WindowFullscreenParams, WindowLabelParams, WindowStateResult, WindowTitleParams,
    WindowZoomParams,
};
use agent_nanoni_desktop::window::{
    NavigationDecision, is_application_entry_url, is_webview_placeholder_url, navigation_decision,
    new_window_decision,
};
use serde_json::{Value, json};
use tauri::ipc::Channel;
use tauri::window::Color;
use tauri::{
    LogicalPosition, LogicalSize, Manager, RunEvent, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;

const SIDE_CAR_REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const SIDE_CAR_DEEP_LINK_SCHEME: &str = "agent-nanoni";
const SIDE_CAR_TAURI_VERSION: &str = "2.11.5";

type AppEventDispatcher = dyn Fn(AppEvent) -> Result<AppTransition, String> + Send + Sync + 'static;

#[derive(Default)]
struct BridgeRuntimeInner {
    application_url: Mutex<Option<String>>,
    app_event_dispatcher: Mutex<Option<Arc<AppEventDispatcher>>>,
    desktop_events: Mutex<Option<TauriDesktopEvents>>,
    sidecar: Mutex<Option<Arc<SidecarSupervisor>>>,
    smoke_backend_ready: AtomicBool,
    smoke_roundtrip_seen: AtomicBool,
    smoke_completion_scheduled: AtomicBool,
}

#[derive(Clone, Default)]
struct BridgeRuntime(Arc<BridgeRuntimeInner>);

impl BridgeRuntime {
    fn set_application_url(&self, url: String) -> Result<(), String> {
        let mut application_url = self
            .0
            .application_url
            .lock()
            .map_err(|_| "application URL lock is poisoned".to_owned())?;
        *application_url = Some(url);
        Ok(())
    }

    fn set_app_event_dispatcher(&self, dispatcher: Arc<AppEventDispatcher>) -> Result<(), String> {
        let mut target = self
            .0
            .app_event_dispatcher
            .lock()
            .map_err(|_| "app event dispatcher lock is poisoned".to_owned())?;
        *target = Some(dispatcher);
        Ok(())
    }

    fn dispatch_app_event(&self, event: AppEvent) -> Result<AppTransition, String> {
        let dispatcher = self
            .0
            .app_event_dispatcher
            .lock()
            .map_err(|_| "app event dispatcher lock is poisoned".to_owned())?
            .clone()
            .ok_or_else(|| "app event dispatcher is not initialized".to_owned())?;
        dispatcher(event)
    }

    fn application_url(&self) -> Result<String, String> {
        self.0
            .application_url
            .lock()
            .map_err(|_| "application URL lock is poisoned".to_owned())?
            .clone()
            .ok_or_else(|| "main webview URL is not initialized".to_owned())
    }

    fn application_url_optional(&self) -> Result<Option<String>, String> {
        self.0
            .application_url
            .lock()
            .map_err(|_| "application URL lock is poisoned".to_owned())
            .map(|url| url.clone())
    }

    fn set_desktop_events(&self, channel: Channel<DesktopEvent>) -> Result<(), String> {
        let mut desktop_events = self
            .0
            .desktop_events
            .lock()
            .map_err(|_| "desktop events lock is poisoned".to_owned())?;
        *desktop_events = Some(ordered_desktop_events(channel));
        Ok(())
    }

    fn push(&self, event: DesktopEvent) -> Result<(), String> {
        let desktop_events = self
            .0
            .desktop_events
            .lock()
            .map_err(|_| "desktop events lock is poisoned".to_owned())?;
        if let Some(desktop_events) = desktop_events.as_ref() {
            desktop_events
                .push(event)
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    fn set_sidecar(&self, sidecar: Arc<SidecarSupervisor>) -> Result<(), String> {
        let mut target = self
            .0
            .sidecar
            .lock()
            .map_err(|_| "sidecar lock is poisoned".to_owned())?;
        *target = Some(sidecar);
        Ok(())
    }

    fn sidecar(&self) -> Result<Arc<SidecarSupervisor>, String> {
        self.0
            .sidecar
            .lock()
            .map_err(|_| "sidecar lock is poisoned".to_owned())?
            .clone()
            .ok_or_else(|| "native host sidecar is not running".to_owned())
    }

    fn clear_sidecar(&self) {
        if let Ok(mut sidecar) = self.0.sidecar.lock() {
            *sidecar = None;
        }
    }

    fn mark_smoke_backend_ready(&self) {
        if env::var_os("AGENT_NANONI_SMOKE").as_deref() != Some(std::ffi::OsStr::new("1")) {
            return;
        }
        self.0.smoke_backend_ready.store(true, Ordering::Release);
        eprintln!("AGENT_NANONI_SMOKE backend-ready");
        self.schedule_smoke_completion_if_ready();
    }

    fn mark_smoke_roundtrip(&self) {
        if env::var_os("AGENT_NANONI_SMOKE").as_deref() != Some(std::ffi::OsStr::new("1")) {
            return;
        }
        self.0.smoke_roundtrip_seen.store(true, Ordering::Release);
        self.schedule_smoke_completion_if_ready();
    }

    fn schedule_smoke_completion_if_ready(&self) {
        if !self.0.smoke_backend_ready.load(Ordering::Acquire)
            || !self.0.smoke_roundtrip_seen.load(Ordering::Acquire)
            || self
                .0
                .smoke_completion_scheduled
                .swap(true, Ordering::AcqRel)
        {
            return;
        }

        let runtime = self.clone();
        let _ = thread::Builder::new()
            .name("nanoni-smoke-completion".to_owned())
            .spawn(move || {
                eprintln!("AGENT_NANONI_SMOKE first-roundtrip");
                if env::var_os("AGENT_NANONI_SMOKE_KILL_HOST").as_deref()
                    == Some(std::ffi::OsStr::new("1"))
                {
                    match runtime.sidecar().and_then(|sidecar| {
                        sidecar.terminate_for_smoke().map_err(|e| e.to_string())
                    }) {
                        Ok(pid) => eprintln!("AGENT_NANONI_SMOKE host-kill-requested pid={pid}"),
                        Err(error) => eprintln!("AGENT_NANONI_SMOKE host-kill-failed: {error}"),
                    }
                } else {
                    eprintln!("AGENT_NANONI_SMOKE clean-exit-requested");
                    if let Err(error) = runtime
                        .dispatch_app_event(AppEvent::Host(HostNotification::Exit { code: 0 }))
                    {
                        eprintln!("AGENT_NANONI_SMOKE clean-exit-failed: {error}");
                    }
                }
            });
    }
}

impl HostInvokeHandler for BridgeRuntime {
    fn invoke(&self, request: &HostInvokeRequest) -> Result<Value, String> {
        let sidecar = self.sidecar()?;
        let envelope = sidecar
            .invoke(
                request.channel.clone(),
                request.payload.clone(),
                SIDE_CAR_REQUEST_TIMEOUT,
            )
            .map_err(|error| error.to_string())?;
        match envelope {
            RpcEnvelope::Response(RpcResponse::Success(response)) => match response.result {
                RpcResult::IpcInvoke(IpcInvokeResult { result }) => Ok(result),
                result => Err(format!(
                    "host returned an unexpected ipc.invoke result: {result:?}"
                )),
            },
            RpcEnvelope::Response(RpcResponse::Error(response)) => Err(format!(
                "host ipc.invoke failed: {}",
                response.error.message
            )),
            RpcEnvelope::Request(_) | RpcEnvelope::Notification(_) => {
                Err("host ipc.invoke returned a non-response envelope".to_owned())
            }
        }
    }
}

struct TauriShellPlatform<R: tauri::Runtime> {
    app: tauri::AppHandle<R>,
    runtime: BridgeRuntime,
    protocol_clients: HashSet<String>,
}

impl<R: tauri::Runtime> TauriShellPlatform<R> {
    fn new(app: tauri::AppHandle<R>, runtime: BridgeRuntime) -> Self {
        Self {
            app,
            runtime,
            protocol_clients: HashSet::new(),
        }
    }

    fn window(&self, label: &str) -> Result<WebviewWindow<R>, String> {
        self.app
            .get_webview_window(label)
            .ok_or_else(|| format!("unknown webview window: {label}"))
    }
}

impl<R: tauri::Runtime> ShellPlatform for TauriShellPlatform<R> {
    fn app_quit(&mut self) -> Result<(), String> {
        Err("app.quit must be routed through the lifecycle dispatcher".to_owned())
    }

    fn app_exit(&mut self, _params: AppExitParams) -> Result<(), String> {
        Err("app.exit must be routed through the lifecycle dispatcher".to_owned())
    }

    fn app_relaunch(&mut self) -> Result<(), String> {
        Err("app.relaunch must be routed through the lifecycle dispatcher".to_owned())
    }

    fn app_focus(&mut self, _params: AppFocusParams) -> Result<(), String> {
        for window in self.app.webview_windows().into_values() {
            if window.is_minimized().map_err(|error| error.to_string())? {
                window.unminimize().map_err(|error| error.to_string())?;
            }
            window.show().map_err(|error| error.to_string())?;
            window.set_focus().map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    fn app_shutdown_complete(&mut self) -> Result<(), String> {
        Ok(())
    }

    fn app_is_protocol_client(
        &mut self,
        params: AppProtocolClientParams,
    ) -> Result<RegisteredResult, String> {
        Ok(RegisteredResult {
            registered: self.protocol_clients.contains(&params.scheme),
        })
    }

    fn app_set_protocol_client(
        &mut self,
        params: AppProtocolClientParams,
    ) -> Result<OkResult, String> {
        if params.scheme.trim().is_empty() {
            return Err("protocol scheme must not be empty".to_owned());
        }
        self.protocol_clients.insert(params.scheme);
        Ok(OkResult { ok: true })
    }

    fn app_get_metrics(&mut self) -> Result<Vec<ProcessMetric>, String> {
        Ok(Vec::new())
    }

    fn window_create(&mut self, params: WindowCreateParams) -> Result<WindowCreatedResult, String> {
        validate_window_create(&params)?;
        let target_url = match params.url.as_deref() {
            Some(raw_url) => WebviewUrl::External(
                tauri::Url::parse(raw_url)
                    .map_err(|error| format!("invalid window URL: {error}"))?,
            ),
            None => WebviewUrl::default(),
        };
        let expected_dev_url = if tauri::is_dev() {
            self.app
                .config()
                .build
                .dev_url
                .as_ref()
                .map(ToString::to_string)
        } else {
            None
        };
        let navigation_runtime = self.runtime.clone();
        let navigation_app = self.app.clone();
        let new_window_app = self.app.clone();
        let label = params.label.clone();
        let mut builder = WebviewWindowBuilder::new(&self.app, &label, target_url)
            .title(params.title)
            .inner_size(to_dimension(params.width)?, to_dimension(params.height)?)
            .min_inner_size(
                to_dimension(params.min_width)?,
                to_dimension(params.min_height)?,
            )
            .decorations(params.decorations)
            .resizable(true)
            .visible(params.show)
            .on_navigation(move |url| {
                if env::var_os("AGENT_NANONI_SMOKE").as_deref() == Some(std::ffi::OsStr::new("1")) {
                    eprintln!("AGENT_NANONI_SMOKE navigation {url}");
                }
                let Ok(application_url) = navigation_runtime.application_url_optional() else {
                    return false;
                };
                let Some(application_url) = application_url else {
                    if is_webview_placeholder_url(url.as_str()) {
                        return true;
                    }
                    if !is_application_entry_url(expected_dev_url.as_deref(), url.as_str()) {
                        return false;
                    }
                    return navigation_runtime
                        .set_application_url(url.to_string())
                        .is_ok();
                };
                match navigation_decision(&application_url, url.as_str()) {
                    NavigationDecision::Allow => true,
                    NavigationDecision::OpenExternal(url) => {
                        open_external_if_safe(&navigation_app, &url);
                        false
                    }
                    NavigationDecision::Block => false,
                }
            })
            .on_new_window(move |url, _features| {
                let decision = new_window_decision(url.as_str());
                if let Some(url) = decision.open_external {
                    open_external_if_safe(&new_window_app, &url);
                }
                tauri::webview::NewWindowResponse::Deny
            });
        if let Some((x, y)) = params.x.zip(params.y) {
            builder = builder.position(to_coordinate(x)?, to_coordinate(y)?);
        }
        if let Some(color) = parse_color(&params.background_color)? {
            builder = builder.background_color(color);
        }
        for script in params.init_scripts {
            if script.trim().is_empty() {
                return Err("window initialization scripts must not be empty".to_owned());
            }
            builder = builder.initialization_script(script);
        }
        if let Some(script) = smoke_roundtrip_init_script() {
            builder = builder
                .initialization_script(script)
                .on_page_load(|window, payload| {
                    if payload.event() != tauri::webview::PageLoadEvent::Finished {
                        return;
                    }
                    let _ = window.eval(SMOKE_ROUNDTRIP_INIT_SCRIPT);
                });
        }
        let window = builder.build().map_err(|error| error.to_string())?;
        let sidecar = self.runtime.sidecar()?;
        let event_sidecar = sidecar;
        let event_label = label.clone();
        window.on_window_event(move |event| {
            if let Some((r#type, data)) = map_window_event(event) {
                let _ = event_sidecar.notify(
                    RpcMethod::WindowEvent,
                    Some(RpcParams::WindowEvent(WindowEventParams {
                        label: event_label.clone(),
                        r#type,
                        data,
                    })),
                );
            }
        });
        Ok(WindowCreatedResult { label })
    }

    fn window_get_bounds(
        &mut self,
        params: WindowLabelParams,
    ) -> Result<WindowBoundsResult, String> {
        let window = self.window(&params.label)?;
        let position = window.outer_position().map_err(|error| error.to_string())?;
        let size = window.inner_size().map_err(|error| error.to_string())?;
        Ok(WindowBoundsResult {
            x: i64::from(position.x),
            y: i64::from(position.y),
            width: i64::from(size.width),
            height: i64::from(size.height),
            maximized: window.is_maximized().map_err(|error| error.to_string())?,
        })
    }

    fn window_get_state(&mut self, params: WindowLabelParams) -> Result<WindowStateResult, String> {
        let window = self.window(&params.label)?;
        Ok(WindowStateResult {
            visible: window.is_visible().map_err(|error| error.to_string())?,
            focused: window.is_focused().map_err(|error| error.to_string())?,
            minimized: window.is_minimized().map_err(|error| error.to_string())?,
            maximized: window.is_maximized().map_err(|error| error.to_string())?,
            fullscreen: window.is_fullscreen().map_err(|error| error.to_string())?,
            destroyed: false,
        })
    }

    fn window_notification(&mut self, method: RpcMethod, params: RpcParams) -> Result<(), String> {
        let is_window_show = method == RpcMethod::WindowShow;
        let result: Result<(), String> = match method {
            RpcMethod::WindowShow => stringify_error(self.window(&label_params(params)?)?.show()),
            RpcMethod::WindowHide => stringify_error(self.window(&label_params(params)?)?.hide()),
            RpcMethod::WindowClose => stringify_error(self.window(&label_params(params)?)?.close()),
            RpcMethod::WindowDestroy => {
                stringify_error(self.window(&label_params(params)?)?.destroy())
            }
            RpcMethod::WindowFocus => {
                stringify_error(self.window(&label_params(params)?)?.set_focus())
            }
            RpcMethod::WindowMinimize => {
                stringify_error(self.window(&label_params(params)?)?.minimize())
            }
            RpcMethod::WindowRestore => {
                stringify_error(self.window(&label_params(params)?)?.unminimize())
            }
            RpcMethod::WindowMaximize => {
                stringify_error(self.window(&label_params(params)?)?.maximize())
            }
            RpcMethod::WindowUnmaximize => {
                stringify_error(self.window(&label_params(params)?)?.unmaximize())
            }
            RpcMethod::WindowReload => {
                stringify_error(self.window(&label_params(params)?)?.reload())
            }
            RpcMethod::WindowToggleDevTools => {
                toggle_devtools(&self.window(label_params(params)?.as_str())?)
            }
            RpcMethod::WindowSetFullscreen => {
                let WindowFullscreenParams { label, fullscreen } = fullscreen_params(params)?;
                stringify_error(self.window(&label)?.set_fullscreen(fullscreen))
            }
            RpcMethod::WindowSetTitle => {
                let WindowTitleParams { label, title } = title_params(params)?;
                stringify_error(self.window(&label)?.set_title(&title))
            }
            RpcMethod::WindowSetBounds => {
                let WindowBoundsParams {
                    label,
                    x,
                    y,
                    width,
                    height,
                } = bounds_params(params)?;
                if width <= 0 || height <= 0 {
                    return Err("window dimensions must be positive".to_owned());
                }
                let window = self.window(&label)?;
                window
                    .set_size(LogicalSize::new(
                        to_dimension(width)?,
                        to_dimension(height)?,
                    ))
                    .map_err(|error| error.to_string())?;
                window
                    .set_position(LogicalPosition::new(to_coordinate(x)?, to_coordinate(y)?))
                    .map_err(|error| error.to_string())
            }
            RpcMethod::WindowSetBackgroundColor => {
                let WindowBackgroundColorParams { label, color } = background_params(params)?;
                let color =
                    parse_color(&color)?.ok_or_else(|| "invalid window color".to_owned())?;
                stringify_error(self.window(&label)?.set_background_color(Some(color)))
            }
            RpcMethod::WindowSetZoom => {
                let WindowZoomParams { label, zoom_factor } = zoom_params(params)?;
                if !zoom_factor.is_finite() || zoom_factor <= 0.0 {
                    return Err("window zoom must be finite and positive".to_owned());
                }
                stringify_error(self.window(&label)?.set_zoom(zoom_factor))
            }
            RpcMethod::WindowSetAlwaysOnTop => {
                let WindowAlwaysOnTopParams { label, flag } = always_on_top_params(params)?;
                stringify_error(self.window(&label)?.set_always_on_top(flag))
            }
            _ => return Err(format!("unsupported window notification: {method:?}")),
        };
        result?;
        if is_window_show {
            self.runtime.mark_smoke_backend_ready();
        }
        Ok(())
    }

    fn dialog_error(&mut self, params: DialogErrorParams) -> Result<(), String> {
        self.app
            .dialog()
            .message(params.content)
            .title(params.title)
            .kind(MessageDialogKind::Error)
            .blocking_show();
        Ok(())
    }

    fn shell_open_external(&mut self, params: ShellOpenExternalParams) -> Result<OkResult, String> {
        let url = validate_external_url(&params.url).map_err(|error| error.to_string())?;
        self.app
            .opener()
            .open_url(url.as_str(), None::<&str>)
            .map_err(|error| error.to_string())?;
        Ok(OkResult { ok: true })
    }

    fn clipboard_write_text(&mut self, _params: ClipboardWriteTextParams) -> Result<(), String> {
        Err("clipboard writes are not available from the Tauri shell yet".to_owned())
    }

    fn ipc_invoke(&mut self, _params: IpcInvokeParams) -> Result<IpcInvokeResult, String> {
        Err("ipc.invoke is a shell-to-host request and is handled by the sidecar".to_owned())
    }

    fn apply_app_effect(&mut self, effect: AppEffect) -> Result<(), String> {
        match effect {
            AppEffect::PreventExit | AppEffect::BeforeQuitResponse { .. } => Ok(()),
            AppEffect::BeforeQuit { reason } => {
                let runtime = self.runtime.clone();
                thread::Builder::new()
                    .name("nanoni-before-quit".to_owned())
                    .spawn(move || {
                        let started = Instant::now();
                        let Ok(sidecar) = runtime.sidecar() else {
                            return;
                        };
                        let result = sidecar.request(
                            RpcMethod::AppBeforeQuit,
                            Some(RpcParams::AppBeforeQuit(AppBeforeQuitParams {
                                reason: lifecycle_reason_to_protocol(reason),
                            })),
                            Duration::from_secs(5),
                        );
                        if let Err(error) = result {
                            eprintln!("host before-quit request failed: {error}");
                        }
                        thread::sleep(SHELL_QUIT_DEADLINE.saturating_sub(started.elapsed()));
                        if let Err(error) =
                            runtime.dispatch_app_event(AppEvent::ShellDeadlineElapsed)
                        {
                            eprintln!("shell quit deadline handling failed: {error}");
                        }
                    })
                    .map(|_| ())
                    .map_err(|error| error.to_string())
            }
            AppEffect::WindowAllClosed => self
                .runtime
                .sidecar()?
                .notify(RpcMethod::AppWindowAllClosed, None)
                .map_err(|error| error.to_string()),
            AppEffect::NotifyActivate {
                has_visible_windows,
            } => self
                .runtime
                .sidecar()?
                .notify(
                    RpcMethod::AppActivate,
                    Some(RpcParams::AppActivate(
                        agent_nanoni_desktop::rpc::protocol::AppActivateParams {
                            has_visible_windows,
                        },
                    )),
                )
                .map_err(|error| error.to_string()),
            AppEffect::FocusMainWindow { steal } => self.app_focus(AppFocusParams { steal }),
            AppEffect::ShowHostError => {
                // The forced-host smoke must remain unattended so it can
                // observe cleanup and the lifecycle continuation. Production
                // still surfaces the native error dialog.
                if env::var_os("AGENT_NANONI_SMOKE").as_deref() != Some(std::ffi::OsStr::new("1")) {
                    self.app
                        .dialog()
                        .message(
                            "The Agent Nanoni host exited unexpectedly. Managed processes were stopped.",
                        )
                        .title("Agent Nanoni host error")
                        .kind(MessageDialogKind::Error)
                        .blocking_show();
                }
                Ok(())
            }
            AppEffect::Run(continuation) => {
                let app = self.app.clone();
                thread::Builder::new()
                    .name("nanoni-lifecycle-continuation".to_owned())
                    .spawn(move || match continuation {
                        Continuation::Exit(code) => app.exit(code),
                        Continuation::Restart if tauri::is_dev() => app.exit(75),
                        Continuation::Restart => app.request_restart(),
                        Continuation::Install => {
                            eprintln!("updater installation is unavailable in Phase 0");
                            app.exit(1);
                        }
                    })
                    .map(|_| ())
                    .map_err(|error| error.to_string())
            }
            AppEffect::PassThrough(_) => Ok(()),
        }
    }

    fn app_platform(&self) -> AppPlatform {
        match env::consts::OS {
            "macos" => AppPlatform::Macos,
            "windows" => AppPlatform::Windows,
            "linux" => AppPlatform::Linux,
            _ => AppPlatform::Other,
        }
    }
}

fn lifecycle_reason_to_protocol(
    reason: LifecycleQuitReason,
) -> agent_nanoni_desktop::rpc::protocol::QuitReason {
    match reason {
        LifecycleQuitReason::User => agent_nanoni_desktop::rpc::protocol::QuitReason::User,
        LifecycleQuitReason::Menu => agent_nanoni_desktop::rpc::protocol::QuitReason::Menu,
        LifecycleQuitReason::LastWindow => {
            agent_nanoni_desktop::rpc::protocol::QuitReason::LastWindow
        }
        LifecycleQuitReason::Host => agent_nanoni_desktop::rpc::protocol::QuitReason::Host,
        LifecycleQuitReason::Updater => agent_nanoni_desktop::rpc::protocol::QuitReason::Updater,
    }
}

fn open_external_if_safe<R: tauri::Runtime>(manager: &impl Manager<R>, raw_url: &str) {
    let Ok(url) = validate_external_url(raw_url) else {
        return;
    };
    if let Err(error) = manager.opener().open_url(url.as_str(), None::<&str>) {
        eprintln!("failed to open external URL: {error}");
    }
}

#[tauri::command]
fn host_invoke(
    webview: WebviewWindow,
    state: tauri::State<'_, BridgeRuntime>,
    channel: String,
    payload: Value,
) -> Result<Value, String> {
    let application_url = state.application_url()?;
    let current_url = webview.url().map_err(|error| error.to_string())?;
    let response = dispatch_host_invoke(
        HostInvokeContext {
            webview_label: webview.label(),
            application_url: &application_url,
            current_url: current_url.as_str(),
        },
        HostInvokeRequest { channel, payload },
        state.inner(),
    )
    .map_err(|error| {
        if env::var_os("AGENT_NANONI_SMOKE").as_deref() == Some(std::ffi::OsStr::new("1")) {
            eprintln!("AGENT_NANONI_SMOKE host_invoke-failed: {error}");
        }
        error.to_string()
    })?;
    state.mark_smoke_roundtrip();
    Ok(response.result)
}

#[tauri::command]
fn desktop_events(
    webview: WebviewWindow,
    state: tauri::State<'_, BridgeRuntime>,
    channel: Channel<DesktopEvent>,
) -> Result<(), String> {
    let application_url = state.application_url()?;
    let current_url = webview.url().map_err(|error| error.to_string())?;
    agent_nanoni_desktop::bridge::authorize_host_invoke(HostInvokeContext {
        webview_label: webview.label(),
        application_url: &application_url,
        current_url: current_url.as_str(),
    })
    .map_err(|error| error.to_string())?;
    state.set_desktop_events(channel)
}

fn validate_window_create(params: &WindowCreateParams) -> Result<(), String> {
    if params.label.trim().is_empty() {
        return Err("window label must not be empty".to_owned());
    }
    for (name, value) in [
        ("width", params.width),
        ("height", params.height),
        ("minWidth", params.min_width),
        ("minHeight", params.min_height),
    ] {
        if (name == "width" || name == "height") && value <= 0 {
            return Err(format!("{name} must be positive"));
        }
        if (name == "minWidth" || name == "minHeight") && value < 0 {
            return Err(format!("{name} must not be negative"));
        }
    }
    if params.min_width > params.width || params.min_height > params.height {
        return Err("minimum window dimensions cannot exceed window dimensions".to_owned());
    }
    Ok(())
}

fn to_dimension(value: i64) -> Result<f64, String> {
    if value < 0 || value > i64::from(i32::MAX) {
        return Err(format!(
            "window dimension is outside the supported range: {value}"
        ));
    }
    Ok(value as f64)
}

fn to_coordinate(value: i64) -> Result<f64, String> {
    if value < i64::from(i32::MIN) || value > i64::from(i32::MAX) {
        return Err(format!(
            "window coordinate is outside the supported range: {value}"
        ));
    }
    Ok(value as f64)
}

fn stringify_error<T, E: std::fmt::Display>(result: Result<T, E>) -> Result<T, String> {
    result.map_err(|error| error.to_string())
}

fn parse_color(raw: &str) -> Result<Option<Color>, String> {
    let Some(hex) = raw.strip_prefix('#') else {
        return Ok(None);
    };
    if hex.len() != 6 && hex.len() != 8 {
        return Err("window color must be #RRGGBB or #RRGGBBAA".to_owned());
    }
    let component = |offset: usize| {
        u8::from_str_radix(&hex[offset..offset + 2], 16)
            .map_err(|_| "window color contains invalid hexadecimal digits".to_owned())
    };
    let alpha = if hex.len() == 8 { component(6)? } else { 255 };
    Ok(Some(Color(
        component(0)?,
        component(2)?,
        component(4)?,
        alpha,
    )))
}

fn label_params(params: RpcParams) -> Result<String, String> {
    match params {
        RpcParams::WindowLabel(params) => Ok(params.label),
        _ => Err("window notification requires label params".to_owned()),
    }
}

fn fullscreen_params(params: RpcParams) -> Result<WindowFullscreenParams, String> {
    match params {
        RpcParams::WindowFullscreen(params) => Ok(params),
        _ => Err("window.setFullscreen requires fullscreen params".to_owned()),
    }
}

fn title_params(params: RpcParams) -> Result<WindowTitleParams, String> {
    match params {
        RpcParams::WindowTitle(params) => Ok(params),
        _ => Err("window.setTitle requires title params".to_owned()),
    }
}

fn bounds_params(params: RpcParams) -> Result<WindowBoundsParams, String> {
    match params {
        RpcParams::WindowBounds(params) => Ok(params),
        _ => Err("window.setBounds requires bounds params".to_owned()),
    }
}

fn background_params(params: RpcParams) -> Result<WindowBackgroundColorParams, String> {
    match params {
        RpcParams::WindowBackgroundColor(params) => Ok(params),
        _ => Err("window.setBackgroundColor requires color params".to_owned()),
    }
}

fn zoom_params(params: RpcParams) -> Result<WindowZoomParams, String> {
    match params {
        RpcParams::WindowZoom(params) => Ok(params),
        _ => Err("window.setZoom requires zoom params".to_owned()),
    }
}

fn always_on_top_params(params: RpcParams) -> Result<WindowAlwaysOnTopParams, String> {
    match params {
        RpcParams::WindowAlwaysOnTop(params) => Ok(params),
        _ => Err("window.setAlwaysOnTop requires always-on-top params".to_owned()),
    }
}

fn toggle_devtools<R: tauri::Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
    #[cfg(debug_assertions)]
    {
        window.open_devtools();
        Ok(())
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = window;
        Err("developer tools are unavailable in this build".to_owned())
    }
}

fn map_window_event(event: &tauri::WindowEvent) -> Option<(WindowEventType, Option<Value>)> {
    match event {
        tauri::WindowEvent::Resized(size) => Some((
            WindowEventType::Resized,
            Some(json!({ "width": size.width, "height": size.height })),
        )),
        tauri::WindowEvent::Moved(position) => Some((
            WindowEventType::Moved,
            Some(json!({ "x": position.x, "y": position.y })),
        )),
        tauri::WindowEvent::Focused(focused) => Some((
            if *focused {
                WindowEventType::Focus
            } else {
                WindowEventType::Blur
            },
            None,
        )),
        tauri::WindowEvent::Destroyed => Some((WindowEventType::Closed, None)),
        tauri::WindowEvent::ThemeChanged(theme) => Some((
            WindowEventType::ThemeChanged,
            Some(json!({ "theme": format!("{theme:?}") })),
        )),
        tauri::WindowEvent::ScaleFactorChanged {
            scale_factor,
            new_inner_size,
            ..
        } => Some((
            WindowEventType::Resized,
            Some(json!({
                "width": new_inner_size.width,
                "height": new_inner_size.height,
                "scaleFactor": scale_factor,
            })),
        )),
        tauri::WindowEvent::CloseRequested { .. } => None,
        #[cfg(mobile)]
        tauri::WindowEvent::Suspended | tauri::WindowEvent::Resumed => None,
        _ => None,
    }
}

fn path_string(path: Result<PathBuf, impl std::fmt::Display>) -> String {
    path.map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn sidecar_compatible_path(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        dunce::simplified(&path).to_owned()
    }
    #[cfg(not(windows))]
    {
        path
    }
}

fn env_path(name: &str) -> Option<PathBuf> {
    env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn resolve_existing_path(candidates: impl IntoIterator<Item = PathBuf>) -> Option<PathBuf> {
    candidates.into_iter().find(|path| path.is_file())
}

fn resolve_sidecar_spec<R: tauri::Runtime>(
    app: &tauri::App<R>,
) -> Result<(SidecarSpawnSpec, ShellHelloResult), String> {
    let resource_dir = sidecar_compatible_path(
        app.path()
            .resource_dir()
            .map_err(|error| error.to_string())?,
    );
    // A debug bundle still enables Tauri's `custom-protocol` feature and must
    // resolve packaged resources. `debug_assertions` only describes compiler
    // optimization mode; Tauri's runtime predicate distinguishes `tauri dev`.
    let is_dev = tauri::is_dev();
    let current_dir = if is_dev {
        env::current_dir().ok()
    } else {
        Some(resource_dir.clone())
    }
    .map(sidecar_compatible_path);
    let dev_override = |name| is_dev.then(|| env_path(name)).flatten();
    let node = dev_override("AGENT_NANONI_NODE").or_else(|| {
        let names = if cfg!(windows) {
            ["agent-nanoni-node.exe", "agent-nanoni-node"]
        } else {
            ["agent-nanoni-node", "agent-nanoni-node"]
        };
        resolve_existing_path(names.into_iter().map(|name| resource_dir.join(name)))
    });
    let host_script = dev_override("AGENT_NANONI_HOST_ENTRY")
        .or_else(|| resolve_existing_path([resource_dir.join("host").join("host.cjs")]))
        .ok_or_else(|| "Agent Nanoni host entrypoint was not found".to_owned())?;
    let node = sidecar_compatible_path(
        node.ok_or_else(|| "Agent Nanoni Node executable was not found".to_owned())?,
    );
    let host_script = sidecar_compatible_path(host_script);
    if !node.is_file() {
        return Err(format!(
            "Agent Nanoni Node executable is not a file: {}",
            node.display()
        ));
    }
    if !host_script.is_file() {
        return Err(format!(
            "Agent Nanoni host entrypoint is not a file: {}",
            host_script.display()
        ));
    }
    let exec_path = path_string(std::env::current_exe());
    let smoke_home = (!is_dev
        && env::var_os("AGENT_NANONI_SMOKE").as_deref() == Some(std::ffi::OsStr::new("1")))
    .then(|| env_path("AGENT_NANONI_SMOKE_HOME"))
    .flatten()
    .map(|path| {
        if path.is_absolute() {
            Ok(path)
        } else {
            Err("AGENT_NANONI_SMOKE_HOME must be an absolute path".to_owned())
        }
    })
    .transpose()?;
    let app_data_dir = sidecar_compatible_path(if is_dev {
        env_path("T3CODE_HOME")
            .or_else(|| {
                current_dir
                    .as_ref()
                    .map(|path| path.join(".t3").join("tauri"))
            })
            .ok_or_else(|| "Agent Nanoni development home could not be resolved".to_owned())?
    } else if let Some(smoke_home) = smoke_home {
        smoke_home
    } else {
        app.path()
            .home_dir()
            .map_err(|error| error.to_string())?
            .join(".agent-nanoni")
    });
    let log_dir = sidecar_compatible_path(
        app.path()
            .app_log_dir()
            .map_err(|error| error.to_string())?,
    );
    let server_root = sidecar_compatible_path(
        dev_override("AGENT_NANONI_SERVER_ROOT")
            .or_else(|| is_dev.then(|| current_dir.clone()).flatten())
            .unwrap_or_else(|| resource_dir.join("server")),
    );
    let hello = ShellHelloResult {
        app_name: app.package_info().name.clone(),
        identifier: app.config().identifier.clone(),
        version: app.package_info().version.to_string(),
        tauri_version: SIDE_CAR_TAURI_VERSION.to_owned(),
        platform: env::consts::OS.to_owned(),
        arch: env::consts::ARCH.to_owned(),
        is_dev,
        exec_path,
        resource_dir: resource_dir.to_string_lossy().into_owned(),
        server_root: server_root.to_string_lossy().into_owned(),
        app_data_dir: app_data_dir.to_string_lossy().into_owned(),
        log_dir: log_dir.to_string_lossy().into_owned(),
        system_locale: env::var("LC_ALL")
            .or_else(|_| env::var("LANG"))
            .unwrap_or_else(|_| "en-US".to_owned()),
        deep_link_scheme: SIDE_CAR_DEEP_LINK_SCHEME.to_owned(),
        argv: env::args().collect(),
        launch_urls: Vec::new(),
    };
    Ok((
        SidecarSpawnSpec {
            node_executable: node,
            host_script,
            current_dir,
            environment: vec![(
                OsString::from("AGENT_NANONI_IS_PACKAGED"),
                OsString::from((!is_dev).to_string()),
            )],
        },
        hello,
    ))
}

fn spawn_broker_event_pump(broker_events: RpcBrokerEventReceiver, sidecar: Arc<SidecarSupervisor>) {
    thread::spawn(move || {
        while let Some(event) = broker_events.next() {
            match event {
                Ok(notification) => {
                    let _ = sidecar.notify(notification.method, notification.params);
                }
                Err(error) => {
                    eprintln!("native process broker event failed: {error}");
                }
            }
        }
    });
}

fn setup_sidecar<R: tauri::Runtime>(
    app: &mut tauri::App<R>,
    runtime: &BridgeRuntime,
) -> Result<(), Box<dyn std::error::Error>> {
    let (spec, hello) = resolve_sidecar_spec(app).map_err(std::io::Error::other)?;
    if env::var_os("AGENT_NANONI_SMOKE").as_deref() == Some(std::ffi::OsStr::new("1")) {
        let server_entry = std::path::Path::new(&hello.server_root)
            .join("apps")
            .join("server")
            .join("dist")
            .join("bin.mjs");
        eprintln!(
            "AGENT_NANONI_SMOKE sidecar node={} host={} cwd={} server_entry={} exists={}",
            spec.node_executable.display(),
            spec.host_script.display(),
            spec.current_dir.as_deref().map_or_else(
                || "<inherited>".to_owned(),
                |path| path.display().to_string()
            ),
            server_entry.display(),
            server_entry.is_file()
        );
    }
    let process_broker = ProcessBroker::new(BrokerConfig::default());
    let binding_broker = process_broker.clone();
    let dispatcher = ShellDispatcher::new(
        TauriShellPlatform::new(app.handle().clone(), runtime.clone()),
        RpcProcessBroker::new(process_broker),
    );
    let lifecycle_gate = dispatcher.lifecycle_gate();
    let broker_events = dispatcher.subscribe_broker_events();
    let dispatcher = Arc::new(Mutex::new(dispatcher));
    let app_event_dispatcher = Arc::clone(&dispatcher);
    runtime
        .set_app_event_dispatcher(Arc::new(move |event| {
            app_event_dispatcher
                .lock()
                .map_err(|_| "native shell dispatcher lock is poisoned".to_owned())?
                .dispatch_app_event(event)
                .map_err(|error| error.message)
        }))
        .map_err(std::io::Error::other)?;
    let request_dispatcher = Arc::clone(&dispatcher);
    let notification_dispatcher = Arc::clone(&dispatcher);
    let close_dispatcher = Arc::clone(&dispatcher);
    let push_runtime = runtime.clone();
    let close_runtime = runtime.clone();
    let handlers = SidecarHandlers {
        request: Arc::new(move |request: RpcRequest| match request_dispatcher.lock() {
            Ok(mut dispatcher) => dispatcher.request(request),
            Err(_) => Err(agent_nanoni_desktop::rpc::protocol::RpcError {
                code: -32000,
                message: "native shell dispatcher lock is poisoned".to_owned(),
                data: None,
            }),
        }),
        notification: Arc::new(move |notification: RpcNotification| {
            if let Ok(mut dispatcher) = notification_dispatcher.lock()
                && let Err(error) = dispatcher.notification(notification)
            {
                eprintln!("native shell notification failed: {}", error.message);
            }
        }),
        ipc_push: Arc::new(move |params: IpcInvokeParams| {
            if let Ok(event) = DesktopEvent::new(params.channel, params.payload) {
                let _ = push_runtime.push(event);
            }
        }),
        unexpected_close: Arc::new(move |reason| {
            if let Ok(mut dispatcher) = close_dispatcher.lock() {
                let cleanup = dispatcher.dispatch_app_event(AppEvent::PeerClosed);
                if let Err(error) = &cleanup {
                    eprintln!("native shell close handling failed: {}", error.message);
                }
                if cleanup.is_ok()
                    && dispatcher.broker_cleanup_applied()
                    && env::var_os("AGENT_NANONI_SMOKE_KILL_HOST").as_deref()
                        == Some(std::ffi::OsStr::new("1"))
                {
                    eprintln!("AGENT_NANONI_SMOKE no-orphans: host-killed cleanup-complete");
                }
            }
            close_runtime.clear_sidecar();
            eprintln!("Agent Nanoni host sidecar closed: {reason:?}");
        }),
    };
    let sidecar = Arc::new(
        SidecarSupervisor::spawn(spec, hello, handlers)
            .map_err(|error| std::io::Error::other(error.to_string()))?,
    );
    #[cfg(unix)]
    binding_broker
        .bind_host_group(sidecar.host_pid(), sidecar.host_pgid())
        .map_err(|error| std::io::Error::other(error.to_string()))?;
    #[cfg(not(unix))]
    binding_broker
        .bind_host_group(sidecar.host_pid(), sidecar.host_pid())
        .map_err(|error| std::io::Error::other(error.to_string()))?;
    runtime
        .set_sidecar(Arc::clone(&sidecar))
        .map_err(std::io::Error::other)?;
    spawn_broker_event_pump(broker_events, sidecar);
    let terminate_dispatcher = Arc::clone(&dispatcher);
    agent_nanoni_desktop::macos_terminate::install(Arc::new(move || {
        let plan = lifecycle_gate.native_quit(LifecycleQuitReason::User);
        if let Some(error) = plan.error {
            eprintln!("native macOS terminate gate failed: {error}");
        }
        let prevents = plan.prevents_exit();
        if let Some(transition) = plan.transition {
            let terminate_dispatcher = Arc::clone(&terminate_dispatcher);
            thread::spawn(move || match terminate_dispatcher.lock() {
                Ok(mut dispatcher) => {
                    if let Err(error) = dispatcher.apply_transition(transition) {
                        eprintln!("native macOS terminate effects failed: {}", error.message);
                    }
                }
                Err(_) => {
                    eprintln!(
                        "native macOS terminate effects skipped: dispatcher lock is poisoned"
                    );
                }
            });
        }
        prevents
    }))
    .map_err(|error| std::io::Error::other(error.to_string()))?;
    Ok(())
}

fn run_event<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    event: RunEvent,
    runtime: &BridgeRuntime,
) {
    let Ok(sidecar) = runtime.sidecar() else {
        return;
    };
    match event {
        RunEvent::ExitRequested { code, api, .. } => {
            let native_event = native_exit_event(code, app.webview_windows().is_empty());
            match runtime.dispatch_app_event(AppEvent::Native(native_event)) {
                Ok(transition) if transition_prevents_exit(&transition) => {
                    api.prevent_exit();
                }
                Ok(_) => {}
                Err(error) => {
                    eprintln!("native app event failed: {error}");
                    api.prevent_exit();
                }
            }
        }
        RunEvent::Exit => {
            let _ = sidecar.shutdown();
            runtime.clear_sidecar();
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen {
            has_visible_windows,
            ..
        } => {
            if let Err(error) =
                runtime.dispatch_app_event(AppEvent::Native(NativeEvent::Activate {
                    has_visible_windows,
                }))
            {
                eprintln!("native app activation failed: {error}");
            }
        }
        RunEvent::Ready
        | RunEvent::WindowEvent { .. }
        | RunEvent::Resumed
        | RunEvent::MainEventsCleared => {}
        _ => {}
    }
}

fn native_exit_event(code: Option<i32>, has_no_windows: bool) -> NativeEvent {
    if code.is_none() && has_no_windows {
        NativeEvent::LastWindowClosed
    } else {
        NativeEvent::BeforeQuit {
            reason: LifecycleQuitReason::User,
        }
    }
}

/// Renderer probe used only by packaged smoke.  The Nanoni init script does not
/// call `host_invoke` until the SPA uses an async bridge method, so smoke would
/// otherwise wait forever after `backend-ready`.  The first attempt often runs
/// before the main origin is authorized; retry until invoke succeeds.
const SMOKE_ROUNDTRIP_INIT_SCRIPT: &str = r#"(function () {
  "use strict";
  if (window.__NANONI_SMOKE_ROUNDTRIP__) return;
  var attempts = 0;
  function tryInvoke() {
    attempts += 1;
    if (attempts > 200) return;
    var internals = window.__TAURI_INTERNALS__;
    if (!internals || typeof internals.invoke !== "function") {
      setTimeout(tryInvoke, 50);
      return;
    }
    Promise.resolve(internals.invoke("host_invoke", {
      channel: "desktop:get-client-settings",
      payload: null
    })).then(function () {
      window.__NANONI_SMOKE_ROUNDTRIP__ = true;
    }, function () {
      setTimeout(tryInvoke, 50);
    });
  }
  tryInvoke();
})();"#;

fn smoke_roundtrip_init_script() -> Option<&'static str> {
    (env::var_os("AGENT_NANONI_SMOKE").as_deref() == Some(std::ffi::OsStr::new("1")))
        .then_some(SMOKE_ROUNDTRIP_INIT_SCRIPT)
}

fn transition_prevents_exit(transition: &AppTransition) -> bool {
    transition.effects.iter().any(|effect| {
        matches!(
            effect,
            agent_nanoni_desktop::app_events::Effect::BeforeQuitResponse { prevented: true }
                | agent_nanoni_desktop::app_events::Effect::Lifecycle(
                    agent_nanoni_desktop::lifecycle::Action::PreventExit
                )
        )
    })
}

#[cfg(any(test, all(debug_assertions, feature = "topology-a-pilot")))]
fn topology_a_benchmark_enabled(value: Option<&str>) -> bool {
    value == Some("1")
}

fn main() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init());

    #[cfg(all(debug_assertions, feature = "topology-a-pilot"))]
    let builder = if topology_a_benchmark_enabled(
        std::env::var("AGENT_NANONI_TOPOLOGY_A_BENCH")
            .ok()
            .as_deref(),
    ) {
        builder.plugin(tauri_plugin_pilot::init())
    } else {
        builder
    };

    let result = builder
        .manage(BridgeRuntime::default())
        .setup(|app| {
            let runtime = app.state::<BridgeRuntime>().inner().clone();
            setup_sidecar(app, &runtime)
        })
        .invoke_handler(tauri::generate_handler![host_invoke, desktop_events])
        .build(tauri::generate_context!());

    match result {
        Ok(app) => {
            let runtime = app.state::<BridgeRuntime>().inner().clone();
            app.run(move |app, event| run_event(app, event, &runtime));
        }
        Err(error) => {
            eprintln!("failed to run Agent Nanoni: {error}");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use agent_nanoni_desktop::app_events::{AppTransition, Effect};
    use agent_nanoni_desktop::lifecycle::{Action, State};
    use serde_json::Value;

    #[cfg(windows)]
    use super::sidecar_compatible_path;
    use super::{
        SMOKE_ROUNDTRIP_INIT_SCRIPT, native_exit_event, topology_a_benchmark_enabled,
        transition_prevents_exit,
    };

    #[test]
    fn capability_is_scoped_to_main_webview() {
        let capability: Value =
            serde_json::from_str(include_str!("../capabilities/main.json")).expect("valid JSON");

        assert_eq!(capability["identifier"], "main");
        assert_eq!(capability["webviews"], serde_json::json!(["main"]));
        assert!(
            capability["permissions"]
                .as_array()
                .is_some_and(|permissions| permissions
                    .iter()
                    .any(|permission| permission == "allow-host-invoke"))
        );
        assert!(
            capability["permissions"]
                .as_array()
                .is_some_and(|permissions| permissions
                    .iter()
                    .all(|permission| permission != "pilot:default"))
        );
    }

    #[test]
    fn topology_a_pilot_requires_the_exact_benchmark_flag() {
        assert!(topology_a_benchmark_enabled(Some("1")));
        assert!(!topology_a_benchmark_enabled(None));
        assert!(!topology_a_benchmark_enabled(Some("true")));
        assert!(!topology_a_benchmark_enabled(Some("0")));
    }

    #[test]
    fn smoke_roundtrip_script_invokes_host_from_the_renderer() {
        assert!(SMOKE_ROUNDTRIP_INIT_SCRIPT.contains("host_invoke"));
        assert!(SMOKE_ROUNDTRIP_INIT_SCRIPT.contains("desktop:get-client-settings"));
        assert!(SMOKE_ROUNDTRIP_INIT_SCRIPT.contains("setTimeout"));
    }

    #[test]
    fn capability_does_not_grant_remote_webview_access() {
        let capability: Value =
            serde_json::from_str(include_str!("../capabilities/main.json")).expect("valid JSON");

        assert!(
            capability["webviews"]
                .as_array()
                .is_some_and(|webviews| webviews.iter().all(|webview| webview == "main"))
        );
        assert!(!capability["windows"].is_array());
    }

    #[test]
    fn parses_hex_window_colors_without_accepting_malformed_values() {
        assert_eq!(
            super::parse_color("#102030"),
            Ok(Some(tauri::window::Color(16, 32, 48, 255)))
        );
        assert!(super::parse_color("#xyzxyz").is_err());
        assert!(super::parse_color("#12345").is_err());
        assert_eq!(super::parse_color("transparent"), Ok(None));
    }

    #[test]
    fn native_exit_distinguishes_last_window_from_an_explicit_quit() {
        assert_eq!(
            native_exit_event(None, true),
            agent_nanoni_desktop::app_events::NativeEvent::LastWindowClosed
        );
        for event in [
            native_exit_event(None, false),
            native_exit_event(Some(0), true),
        ] {
            assert_eq!(
                event,
                agent_nanoni_desktop::app_events::NativeEvent::BeforeQuit {
                    reason: agent_nanoni_desktop::lifecycle::QuitReason::User
                }
            );
        }
    }

    #[test]
    fn native_exit_is_prevented_only_when_the_lifecycle_requests_it() {
        let prevented = AppTransition {
            state: State::Running,
            effects: vec![Effect::Lifecycle(Action::PreventExit)],
        };
        assert!(transition_prevents_exit(&prevented));
        let authorized = AppTransition {
            state: State::Running,
            effects: Vec::new(),
        };
        assert!(!transition_prevents_exit(&authorized));
    }

    #[cfg(windows)]
    #[test]
    fn sidecar_paths_do_not_expose_windows_verbatim_prefixes_to_node() {
        assert_eq!(
            sidecar_compatible_path(std::path::PathBuf::from(
                r"\\?\D:\agent-nanoni\host\host.cjs"
            )),
            std::path::PathBuf::from(r"D:\agent-nanoni\host\host.cjs")
        );
    }
}
