#![forbid(unsafe_code)]

use std::sync::{Arc, Mutex};

use agent_nanoni_desktop::bridge::{
    DesktopEvent, HostInvokeContext, HostInvokeHandler, HostInvokeRequest, TauriDesktopEvents,
    dispatch_host_invoke, ordered_desktop_events,
};
use serde_json::Value;
use tauri::{Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, ipc::Channel};
use tauri_plugin_opener::OpenerExt;

use agent_nanoni_desktop::opener::validate_external_url;
use agent_nanoni_desktop::window::{
    NavigationDecision, is_application_entry_url, navigation_decision, new_window_decision,
};

const PHASE_ZERO_ECHO_CHANNEL: &str = "nanoni.phase0.echo";
const RENDERER_INIT_SCRIPT: &str = include_str!("../gen/renderer-init.js");

#[derive(Default)]
struct BridgeRuntime {
    application_url: Mutex<Option<String>>,
    desktop_events: Mutex<Option<TauriDesktopEvents>>,
}

impl BridgeRuntime {
    fn set_application_url(&self, url: String) -> Result<(), String> {
        let mut application_url = self
            .application_url
            .lock()
            .map_err(|_| "application URL lock is poisoned".to_owned())?;
        *application_url = Some(url);
        Ok(())
    }

    fn application_url(&self) -> Result<String, String> {
        self.application_url
            .lock()
            .map_err(|_| "application URL lock is poisoned".to_owned())?
            .clone()
            .ok_or_else(|| "main webview URL is not initialized".to_owned())
    }

    fn set_desktop_events(&self, channel: Channel<DesktopEvent>) -> Result<(), String> {
        let mut desktop_events = self
            .desktop_events
            .lock()
            .map_err(|_| "desktop events lock is poisoned".to_owned())?;
        *desktop_events = Some(ordered_desktop_events(channel));
        Ok(())
    }

    fn push(&self, event: DesktopEvent) -> Result<(), String> {
        let desktop_events = self
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
}

impl HostInvokeHandler for BridgeRuntime {
    fn invoke(&self, request: &HostInvokeRequest) -> Result<Value, String> {
        if request.channel != PHASE_ZERO_ECHO_CHANNEL {
            return Err(format!("unknown Phase 0 host channel: {}", request.channel));
        }
        self.push(
            DesktopEvent::new(request.channel.clone(), request.payload.clone())
                .map_err(|error| error.to_string())?,
        )?;
        Ok(request.payload.clone())
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
    dispatch_host_invoke(
        HostInvokeContext {
            webview_label: webview.label(),
            application_url: &application_url,
            current_url: current_url.as_str(),
        },
        HostInvokeRequest { channel, payload },
        state.inner(),
    )
    .map(|response| response.result)
    .map_err(|error| error.to_string())
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

fn main() {
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(BridgeRuntime::default())
        .setup(|app| {
            let expected_dev_url = app.config().build.dev_url.as_ref().map(ToString::to_string);
            let application_url = Arc::new(Mutex::new(None::<String>));
            let navigation_application_url = Arc::clone(&application_url);
            let navigation_app = app.handle().clone();
            let new_window_app = app.handle().clone();

            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                .title("Agent Nanoni")
                .inner_size(1280.0, 800.0)
                .min_inner_size(960.0, 640.0)
                .resizable(true)
                .initialization_script(RENDERER_INIT_SCRIPT)
                .on_navigation(move |url| {
                    let Ok(mut application_url) = navigation_application_url.lock() else {
                        return false;
                    };
                    let Some(application_url) = application_url.as_ref() else {
                        if !is_application_entry_url(expected_dev_url.as_deref(), url.as_str()) {
                            return false;
                        }
                        *application_url = Some(url.to_string());
                        return true;
                    };
                    match navigation_decision(application_url, url.as_str()) {
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
                })
                .build()?;
            let url = window.url().map_err(|error| error.to_string())?;
            if let Ok(mut application_url) = application_url.lock() {
                *application_url = Some(url.to_string());
            }
            app.state::<BridgeRuntime>()
                .set_application_url(url.to_string())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![host_invoke, desktop_events])
        .run(tauri::generate_context!());

    if let Err(error) = result {
        eprintln!("failed to run Agent Nanoni: {error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

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
}
