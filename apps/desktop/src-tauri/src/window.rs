//! Runtime-agnostic window creation and navigation guards.
//!
//! Tauri's concrete `WebviewWindowBuilder` is owned by the composition layer.
//! This module prepares the `window.create` request and exposes the security
//! decisions that the runtime callback must apply.  Keeping these decisions
//! pure gives us deterministic tests for foreign navigation and new-window
//! handling without creating a second Tauri state registry.

use serde_json::Value;
use thiserror::Error;

use crate::opener::validate_external_url;
use crate::rpc::protocol::WindowCreateParams;

/// The boot metadata global read by the renderer before its first module.
pub const NANONI_BOOT_GLOBAL: &str = "__NANONI_BOOT__";

/// A prepared `window.create` request, including the host's boot script.
#[derive(Debug, Clone, PartialEq)]
pub struct WindowCreateModel {
    /// The canonical Appendix B request sent to the Tauri runtime.
    pub params: WindowCreateParams,
}

/// Window creation validation failures.
#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum WindowError {
    #[error("window label must not be empty")]
    EmptyLabel,
    #[error("window dimensions must be positive")]
    InvalidDimensions,
    #[error("minimum window dimensions cannot exceed the window dimensions")]
    InvalidMinimumDimensions,
    #[error("boot metadata must be a JSON object")]
    InvalidBootMetadata,
    #[error("the bridge shim must not be empty")]
    EmptyShim,
    #[error("boot metadata could not be encoded: {0}")]
    BootEncoding(String),
}

impl WindowCreateModel {
    /// Adds the boot assignment and minimal shim before the host's first init
    /// script.  This ordering is the init-script race invariant: the shim and
    /// `window.__NANONI_BOOT__` exist before the SPA's first evaluation.
    pub fn new(
        mut params: WindowCreateParams,
        boot: &Value,
        shim: &str,
    ) -> Result<Self, WindowError> {
        validate_window_params(&params)?;
        if !boot.is_object() {
            return Err(WindowError::InvalidBootMetadata);
        }
        if shim.trim().is_empty() {
            return Err(WindowError::EmptyShim);
        }

        let encoded_boot = serde_json::to_string(boot)
            .map_err(|error| WindowError::BootEncoding(error.to_string()))?;
        let boot_script =
            format!("window.{NANONI_BOOT_GLOBAL} = Object.freeze({encoded_boot});\n{shim}");

        // The host's first script is the bridge bundle.  Prefixing that script
        // preserves its position while guaranteeing boot metadata is visible
        // first; any later scripts remain in the supplied order.
        match params.init_scripts.first_mut() {
            Some(first) => {
                let host_script = std::mem::take(first);
                *first = format!("{boot_script}\n{host_script}");
            }
            None => params.init_scripts.push(boot_script),
        }

        Ok(Self { params })
    }

    /// Returns the request in the shape consumed by the Appendix B peer.
    #[must_use]
    pub fn into_params(self) -> WindowCreateParams {
        self.params
    }

    /// Returns the first init script, which always contains boot metadata and
    /// the shim after [`Self::new`] succeeds.
    #[must_use]
    pub fn initialization_script(&self) -> Option<&str> {
        self.params.init_scripts.first().map(String::as_str)
    }
}

fn validate_window_params(params: &WindowCreateParams) -> Result<(), WindowError> {
    if params.label.trim().is_empty() {
        return Err(WindowError::EmptyLabel);
    }
    if params.width <= 0 || params.height <= 0 || params.min_width <= 0 || params.min_height <= 0 {
        return Err(WindowError::InvalidDimensions);
    }
    if params.min_width > params.width || params.min_height > params.height {
        return Err(WindowError::InvalidMinimumDimensions);
    }
    Ok(())
}

/// Returns whether two renderer URLs are same-origin for the shell's app
/// boundary.  The URL parser's opaque-origin treatment for custom schemes is
/// intentionally avoided: packaged/dev app URLs may use a custom scheme, and
/// two URLs with the same scheme, host, and effective port are one app origin.
pub fn is_same_origin(application_url: &str, navigation_url: &str) -> bool {
    let Ok(application) = tauri::Url::parse(application_url) else {
        return false;
    };
    let Ok(navigation) = tauri::Url::parse(navigation_url) else {
        return false;
    };
    let Some(application_origin) = origin_key(&application) else {
        return false;
    };
    let Some(navigation_origin) = origin_key(&navigation) else {
        return false;
    };
    application_origin == navigation_origin
}

fn origin_key(url: &tauri::Url) -> Option<(String, String, Option<u16>)> {
    // A file URL has no host and must never be treated as the app's origin.
    if url.scheme() == "file" {
        return None;
    }
    let host = url.host_str()?.to_ascii_lowercase();
    let port = url.port_or_known_default();
    Some((url.scheme().to_ascii_lowercase(), host, port))
}

/// First-document placeholders used by WebView2 (and other engines) before the
/// application URL is committed.  Blocking these prevents the real entry URL
/// from loading, so they must be allowed without becoming the app origin.
#[must_use]
pub fn is_webview_placeholder_url(url: &str) -> bool {
    let candidate = url.trim();
    candidate.is_empty()
        || candidate == "about:blank"
        || candidate == "about:srcdoc"
        || candidate.starts_with("about:blank?")
}

/// Validates the first URL before it is allowed to establish the main
/// webview's application origin. Development builds must match the configured
/// dev server; packaged builds accept only Tauri's platform asset origins.
#[must_use]
pub fn is_application_entry_url(expected_dev_url: Option<&str>, candidate: &str) -> bool {
    if let Some(expected_dev_url) = expected_dev_url {
        return is_same_origin(expected_dev_url, candidate);
    }

    let Ok(candidate) = tauri::Url::parse(candidate) else {
        return false;
    };
    matches!(
        (candidate.scheme(), candidate.host_str()),
        ("tauri", Some("localhost")) | ("http", Some("tauri.localhost"))
    )
}

/// Parses and canonicalises a URL that may be opened by the system handler.
///
/// Returning the canonical URL (rather than the raw string) matches
/// `new URL(raw).href` in the Electron implementation and prevents malformed
/// or unsupported schemes from reaching the opener.
pub fn parse_safe_external_url(raw_url: &str) -> Option<String> {
    validate_external_url(raw_url)
        .ok()
        .map(|url| url.into_string())
}

/// Decision made by the `will-navigate` callback.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NavigationDecision {
    /// Keep the navigation inside the app webview.
    Allow,
    /// Prevent the webview navigation and ask the opener to handle this URL.
    OpenExternal(String),
    /// Prevent the navigation without invoking an external handler.
    Block,
}

/// Applies the same-origin guard and safe external URL policy.
#[must_use]
pub fn navigation_decision(application_url: &str, navigation_url: &str) -> NavigationDecision {
    if is_same_origin(application_url, navigation_url) {
        return NavigationDecision::Allow;
    }
    parse_safe_external_url(navigation_url)
        .map_or(NavigationDecision::Block, NavigationDecision::OpenExternal)
}

/// Tauri always denies a renderer-requested new window.  A safe URL is still
/// converted into an explicit system-open decision, preserving Electron's
/// `setWindowOpenHandler` behaviour without allowing a second webview.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewWindowDecision {
    pub deny: bool,
    pub open_external: Option<String>,
}

#[must_use]
pub fn new_window_decision(url: &str) -> NewWindowDecision {
    NewWindowDecision {
        deny: true,
        open_external: parse_safe_external_url(url),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn params() -> WindowCreateParams {
        WindowCreateParams {
            label: "main".to_owned(),
            url: Some("https://app.example/".to_owned()),
            title: "Agent Nanoni".to_owned(),
            width: 1200,
            height: 800,
            min_width: 840,
            min_height: 620,
            x: None,
            y: None,
            show: false,
            background_color: "#101010".to_owned(),
            decorations: false,
            title_bar_style: "hidden".to_owned(),
            hidden_title: false,
            traffic_light_position: None,
            init_scripts: vec!["window.desktopBridge = {};".to_owned()],
            zoom_factor: None,
        }
    }

    #[test]
    fn window_create_prefixes_boot_and_preserves_host_script_order() {
        let model = WindowCreateModel::new(
            params(),
            &json!({ "productVersion": "1.0.0", "isDev": true }),
            "window.__NANONI_SHIM__ = true;",
        );
        assert!(model.is_ok());
        let model = model.ok();
        let script = model
            .as_ref()
            .and_then(WindowCreateModel::initialization_script);
        assert!(script.is_some_and(|value| {
            value.contains("window.__NANONI_BOOT__ = Object.freeze")
                && value.contains("window.__NANONI_SHIM__ = true;")
                && value.ends_with("window.desktopBridge = {};")
        }));
    }

    #[test]
    fn window_create_rejects_invalid_dimensions_and_boot() {
        let mut invalid = params();
        invalid.min_width = invalid.width + 1;
        assert_eq!(
            WindowCreateModel::new(invalid, &json!({}), "window.shim = true;"),
            Err(WindowError::InvalidMinimumDimensions)
        );
        assert_eq!(
            WindowCreateModel::new(params(), &json!([]), "window.shim = true;"),
            Err(WindowError::InvalidBootMetadata)
        );
    }

    #[test]
    fn same_origin_guard_allows_app_and_rejects_foreign_origin() {
        assert!(is_same_origin(
            "https://app.example/",
            "https://app.example/settings"
        ));
        assert!(is_same_origin(
            "agent-nanoni://app/",
            "agent-nanoni://app/settings"
        ));
        assert!(!is_same_origin(
            "https://app.example/",
            "https://evil.example/"
        ));
        assert!(!is_same_origin("https://app.example/", "not a URL"));
    }

    #[test]
    fn first_navigation_cannot_choose_a_foreign_application_origin() {
        assert!(is_application_entry_url(
            Some("http://127.0.0.1:5733"),
            "http://127.0.0.1:5733/"
        ));
        assert!(!is_application_entry_url(
            Some("http://127.0.0.1:5733"),
            "https://evil.example/"
        ));
        assert!(is_application_entry_url(None, "tauri://localhost/"));
        assert!(is_application_entry_url(None, "http://tauri.localhost/"));
        assert!(!is_application_entry_url(None, "https://example.com/"));
        assert!(!is_application_entry_url(None, "about:blank"));
    }

    #[test]
    fn webview_placeholder_urls_are_not_application_origins() {
        assert!(is_webview_placeholder_url("about:blank"));
        assert!(is_webview_placeholder_url(" about:blank "));
        assert!(is_webview_placeholder_url("about:blank?unencoded=1"));
        assert!(is_webview_placeholder_url("about:srcdoc"));
        assert!(is_webview_placeholder_url(""));
        assert!(!is_webview_placeholder_url("http://tauri.localhost/"));
        assert!(!is_webview_placeholder_url("https://example.com/"));
    }

    #[test]
    fn foreign_navigation_opens_only_safe_external_urls() {
        assert_eq!(
            navigation_decision("https://app.example/", "https://example.com/docs"),
            NavigationDecision::OpenExternal("https://example.com/docs".to_owned())
        );
        assert_eq!(
            navigation_decision("https://app.example/", "javascript:alert(1)"),
            NavigationDecision::Block
        );
        assert_eq!(
            navigation_decision("https://app.example/", "file:///private/secret"),
            NavigationDecision::Block
        );
    }

    #[test]
    fn new_window_is_always_denied_and_safe_url_is_forwarded() {
        assert_eq!(
            new_window_decision("vscode://vscode-remote/ssh-remote+dev/workspace"),
            NewWindowDecision {
                deny: true,
                open_external: Some("vscode://vscode-remote/ssh-remote+dev/workspace".to_owned()),
            }
        );
        assert_eq!(
            new_window_decision("data:text/html,secret"),
            NewWindowDecision {
                deny: true,
                open_external: None,
            }
        );
    }
}
