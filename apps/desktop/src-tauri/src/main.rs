#![forbid(unsafe_code)]

use std::sync::Mutex;

use agent_nanoni_desktop::bridge::{
    DesktopEvent, HostInvokeContext, HostInvokeHandler, HostInvokeRequest, TauriDesktopEvents,
    dispatch_host_invoke, ordered_desktop_events,
};
use serde_json::Value;
use tauri::{Manager, WebviewWindow, ipc::Channel};

const PHASE_ZERO_ECHO_CHANNEL: &str = "nanoni.phase0.echo";

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
    state: tauri::State<'_, BridgeRuntime>,
    channel: Channel<DesktopEvent>,
) -> Result<(), String> {
    state.set_desktop_events(channel)
}

fn main() {
    let result = tauri::Builder::default()
        .manage(BridgeRuntime::default())
        .setup(|app| {
            let window = app
                .get_webview_window("main")
                .ok_or_else(|| "main webview window was not created".to_owned())?;
            let url = window.url().map_err(|error| error.to_string())?;
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
