//! JSON-RPC 2.0 contract for the shell/host boundary.
//!
//! This module models the wire envelopes and the metadata fixture used by the
//! TypeScript host. It does not read or write a transport. Framing, lifecycle,
//! and process ownership are deliberately separate concerns.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use thiserror::Error;

/// The canonical fixture is owned by the host contract and consumed by both
/// implementations. Keeping it in one place prevents drift in the Rust shell.
pub const PROTOCOL_FIXTURES_JSON: &str =
    include_str!("../../../src/tauri/rpc/fixtures/protocol-fixtures.json");

const JSON_RPC_VERSION: JsonRpcVersion = JsonRpcVersion::V2;

/// JSON-RPC version accepted by this protocol.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum JsonRpcVersion {
    #[serde(rename = "2.0")]
    V2,
}

/// Integer request identifier. JSON-RPC permits either strings or integers;
/// the frozen Appendix B contract deliberately uses integers only.
pub type RpcId = i64;

const JS_SAFE_INTEGER_MAX: RpcId = 9_007_199_254_740_991;

pub const MAX_FRAME_BYTES: u64 = 16 * 1024 * 1024;
pub const MAX_NESTING_DEPTH: u64 = 64;
pub const MAX_PENDING_REQUESTS: u64 = 1024;
pub const PRE_READY_RENDERER_QUEUE_LIMIT: u64 = 256;
pub const HELLO_TIMEOUT_MS: u64 = 15_000;

/// A required JSON property whose value may be null.
///
/// The non-optional field rejects an omitted key, while the inner `Option`
/// preserves the wire-level `T | null` shape.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequiredNullable<T>(pub Option<T>);

impl<T> Serialize for RequiredNullable<T>
where
    T: Serialize,
{
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        self.0.serialize(serializer)
    }
}

impl<'de, T> Deserialize<'de> for RequiredNullable<T>
where
    T: Deserialize<'de>,
{
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        Option::<T>::deserialize(deserializer).map(Self)
    }
}

fn deserialize_optional<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

pub type RequiredNullableString = RequiredNullable<String>;

/// Direction metadata carried by fixture entries.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RpcDirection {
    HostToShell,
    ShellToHost,
}

/// The category of a fixture envelope.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RpcFixtureKind {
    Request,
    Notification,
    Response,
}

/// Method names frozen by Appendix B.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum RpcMethod {
    #[serde(rename = "shell.hello")]
    ShellHello,
    #[serde(rename = "app.quit")]
    AppQuit,
    #[serde(rename = "app.exit")]
    AppExit,
    #[serde(rename = "app.relaunch")]
    AppRelaunch,
    #[serde(rename = "app.focus")]
    AppFocus,
    #[serde(rename = "app.isProtocolClient")]
    AppIsProtocolClient,
    #[serde(rename = "app.setProtocolClient")]
    AppSetProtocolClient,
    #[serde(rename = "app.getMetrics")]
    AppGetMetrics,
    #[serde(rename = "app.before-quit")]
    AppBeforeQuit,
    #[serde(rename = "app.window-all-closed")]
    AppWindowAllClosed,
    #[serde(rename = "app.activate")]
    AppActivate,
    #[serde(rename = "app.second-instance")]
    AppSecondInstance,
    #[serde(rename = "app.open-url")]
    AppOpenUrl,
    #[serde(rename = "app.shutdown-complete")]
    AppShutdownComplete,
    #[serde(rename = "process.register")]
    ProcessRegister,
    #[serde(rename = "process.unregister")]
    ProcessUnregister,
    #[serde(rename = "process.cancel")]
    ProcessCancel,
    #[serde(rename = "ipc.invoke")]
    IpcInvoke,
    #[serde(rename = "ipc.push")]
    IpcPush,
    #[serde(rename = "window.create")]
    WindowCreate,
    #[serde(rename = "window.show")]
    WindowShow,
    #[serde(rename = "window.hide")]
    WindowHide,
    #[serde(rename = "window.close")]
    WindowClose,
    #[serde(rename = "window.destroy")]
    WindowDestroy,
    #[serde(rename = "window.focus")]
    WindowFocus,
    #[serde(rename = "window.minimize")]
    WindowMinimize,
    #[serde(rename = "window.restore")]
    WindowRestore,
    #[serde(rename = "window.maximize")]
    WindowMaximize,
    #[serde(rename = "window.unmaximize")]
    WindowUnmaximize,
    #[serde(rename = "window.reload")]
    WindowReload,
    #[serde(rename = "window.toggleDevTools")]
    WindowToggleDevTools,
    #[serde(rename = "window.setFullscreen")]
    WindowSetFullscreen,
    #[serde(rename = "window.setTitle")]
    WindowSetTitle,
    #[serde(rename = "window.setBounds")]
    WindowSetBounds,
    #[serde(rename = "window.setBackgroundColor")]
    WindowSetBackgroundColor,
    #[serde(rename = "window.setZoom")]
    WindowSetZoom,
    #[serde(rename = "window.setAlwaysOnTop")]
    WindowSetAlwaysOnTop,
    #[serde(rename = "window.getBounds")]
    WindowGetBounds,
    #[serde(rename = "window.getState")]
    WindowGetState,
    #[serde(rename = "window.event")]
    WindowEvent,
    #[serde(rename = "dialog.openFolder")]
    DialogOpenFolder,
    #[serde(rename = "dialog.openFiles")]
    DialogOpenFiles,
    #[serde(rename = "dialog.message")]
    DialogMessage,
    #[serde(rename = "dialog.error")]
    DialogError,
    #[serde(rename = "menu.setApplication")]
    MenuSetApplication,
    #[serde(rename = "menu.popup")]
    MenuPopup,
    #[serde(rename = "menu.click")]
    MenuClick,
    #[serde(rename = "shell.openExternal")]
    ShellOpenExternal,
    #[serde(rename = "shell.showItemInFolder")]
    ShellShowItemInFolder,
    #[serde(rename = "clipboard.writeText")]
    ClipboardWriteText,
    #[serde(rename = "wsl.registerGuest")]
    WslRegisterGuest,
    #[serde(rename = "wsl.unregisterGuest")]
    WslUnregisterGuest,
    #[serde(rename = "auth.callback")]
    AuthCallback,
    #[serde(rename = "theme.get")]
    ThemeGet,
    #[serde(rename = "theme.setSource")]
    ThemeSetSource,
    #[serde(rename = "theme.updated")]
    ThemeUpdated,
    #[serde(rename = "safeStorage.status")]
    SafeStorageStatus,
    #[serde(rename = "safeStorage.encrypt")]
    SafeStorageEncrypt,
    #[serde(rename = "safeStorage.decrypt")]
    SafeStorageDecrypt,
    #[serde(rename = "updater.configure")]
    UpdaterConfigure,
    #[serde(rename = "updater.check")]
    UpdaterCheck,
    #[serde(rename = "updater.download")]
    UpdaterDownload,
    #[serde(rename = "updater.install")]
    UpdaterInstall,
    #[serde(rename = "updater.progress")]
    UpdaterProgress,
    #[serde(rename = "power.snapshot")]
    PowerSnapshot,
    #[serde(rename = "power.event")]
    PowerEvent,
}

/// Exhaustive Appendix B method list. Keeping this separate from the serde
/// enum makes fixture coverage checks fail closed when a method is omitted.
pub const ALL_METHODS: &[RpcMethod] = &[
    RpcMethod::ShellHello,
    RpcMethod::AppQuit,
    RpcMethod::AppExit,
    RpcMethod::AppRelaunch,
    RpcMethod::AppFocus,
    RpcMethod::AppIsProtocolClient,
    RpcMethod::AppSetProtocolClient,
    RpcMethod::AppGetMetrics,
    RpcMethod::AppBeforeQuit,
    RpcMethod::AppWindowAllClosed,
    RpcMethod::AppActivate,
    RpcMethod::AppSecondInstance,
    RpcMethod::AppOpenUrl,
    RpcMethod::AppShutdownComplete,
    RpcMethod::ProcessRegister,
    RpcMethod::ProcessUnregister,
    RpcMethod::ProcessCancel,
    RpcMethod::IpcInvoke,
    RpcMethod::IpcPush,
    RpcMethod::WindowCreate,
    RpcMethod::WindowShow,
    RpcMethod::WindowHide,
    RpcMethod::WindowClose,
    RpcMethod::WindowDestroy,
    RpcMethod::WindowFocus,
    RpcMethod::WindowMinimize,
    RpcMethod::WindowRestore,
    RpcMethod::WindowMaximize,
    RpcMethod::WindowUnmaximize,
    RpcMethod::WindowReload,
    RpcMethod::WindowToggleDevTools,
    RpcMethod::WindowSetFullscreen,
    RpcMethod::WindowSetTitle,
    RpcMethod::WindowSetBounds,
    RpcMethod::WindowSetBackgroundColor,
    RpcMethod::WindowSetZoom,
    RpcMethod::WindowSetAlwaysOnTop,
    RpcMethod::WindowGetBounds,
    RpcMethod::WindowGetState,
    RpcMethod::WindowEvent,
    RpcMethod::DialogOpenFolder,
    RpcMethod::DialogOpenFiles,
    RpcMethod::DialogMessage,
    RpcMethod::DialogError,
    RpcMethod::MenuSetApplication,
    RpcMethod::MenuPopup,
    RpcMethod::MenuClick,
    RpcMethod::ShellOpenExternal,
    RpcMethod::ShellShowItemInFolder,
    RpcMethod::ClipboardWriteText,
    RpcMethod::WslRegisterGuest,
    RpcMethod::WslUnregisterGuest,
    RpcMethod::AuthCallback,
    RpcMethod::ThemeGet,
    RpcMethod::ThemeSetSource,
    RpcMethod::ThemeUpdated,
    RpcMethod::SafeStorageStatus,
    RpcMethod::SafeStorageEncrypt,
    RpcMethod::SafeStorageDecrypt,
    RpcMethod::UpdaterConfigure,
    RpcMethod::UpdaterCheck,
    RpcMethod::UpdaterDownload,
    RpcMethod::UpdaterInstall,
    RpcMethod::UpdaterProgress,
    RpcMethod::PowerSnapshot,
    RpcMethod::PowerEvent,
];

impl RpcMethod {
    /// Returns the method's Appendix B direction and envelope category.
    #[must_use]
    pub const fn spec(self) -> (RpcDirection, RpcFixtureKind) {
        use RpcDirection::{HostToShell as H, ShellToHost as S};
        use RpcFixtureKind::{Notification as N, Request as Q};

        match self {
            Self::ShellHello => (H, Q),
            Self::AppQuit | Self::AppExit | Self::AppRelaunch | Self::AppFocus => (H, N),
            Self::AppIsProtocolClient | Self::AppSetProtocolClient | Self::AppGetMetrics => (H, Q),
            Self::AppBeforeQuit => (S, Q),
            Self::AppWindowAllClosed
            | Self::AppActivate
            | Self::AppSecondInstance
            | Self::AppOpenUrl => (S, N),
            Self::AppShutdownComplete => (H, N),
            Self::ProcessRegister => (H, Q),
            Self::ProcessUnregister | Self::ProcessCancel => (H, N),
            Self::IpcInvoke => (S, Q),
            Self::IpcPush => (H, N),
            Self::WindowCreate => (H, Q),
            Self::WindowShow
            | Self::WindowHide
            | Self::WindowClose
            | Self::WindowDestroy
            | Self::WindowFocus
            | Self::WindowMinimize
            | Self::WindowRestore
            | Self::WindowMaximize
            | Self::WindowUnmaximize
            | Self::WindowReload
            | Self::WindowToggleDevTools
            | Self::WindowSetFullscreen
            | Self::WindowSetTitle
            | Self::WindowSetBounds
            | Self::WindowSetBackgroundColor
            | Self::WindowSetZoom
            | Self::WindowSetAlwaysOnTop => (H, N),
            Self::WindowGetBounds | Self::WindowGetState => (H, Q),
            Self::WindowEvent => (S, N),
            Self::DialogOpenFolder
            | Self::DialogOpenFiles
            | Self::DialogMessage
            | Self::DialogError
            | Self::MenuSetApplication
            | Self::MenuPopup
            | Self::ShellOpenExternal
            | Self::WslRegisterGuest
            | Self::WslUnregisterGuest
            | Self::ThemeGet
            | Self::SafeStorageStatus
            | Self::SafeStorageEncrypt
            | Self::SafeStorageDecrypt
            | Self::UpdaterCheck
            | Self::PowerSnapshot => (H, Q),
            Self::MenuClick => (S, N),
            Self::ShellShowItemInFolder | Self::ClipboardWriteText => (H, N),
            Self::AuthCallback | Self::ThemeUpdated | Self::UpdaterProgress | Self::PowerEvent => {
                (S, N)
            }
            Self::ThemeSetSource
            | Self::UpdaterConfigure
            | Self::UpdaterDownload
            | Self::UpdaterInstall => (H, N),
        }
    }

    #[must_use]
    const fn requires_params(self) -> bool {
        !matches!(
            self,
            Self::AppQuit
                | Self::AppRelaunch
                | Self::AppGetMetrics
                | Self::AppWindowAllClosed
                | Self::AppShutdownComplete
                | Self::ThemeGet
                | Self::SafeStorageStatus
                | Self::UpdaterCheck
                | Self::UpdaterDownload
                | Self::PowerSnapshot
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EmptyParams {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShellHelloParams {
    pub protocol_version: String,
    pub host_pid: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppExitParams {
    pub code: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppFocusParams {
    pub steal: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppProtocolClientParams {
    pub scheme: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppBeforeQuitParams {
    pub reason: QuitReason,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum QuitReason {
    User,
    Menu,
    LastWindow,
    Host,
    Updater,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppActivateParams {
    pub has_visible_windows: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppSecondInstanceParams {
    pub argv: Vec<String>,
    pub cwd: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppOpenUrlParams {
    pub urls: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProcessRegisterParams {
    pub attempt_id: String,
    pub pid: u64,
    pub kind: ProcessKind,
    pub spawned_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProcessKind {
    Server,
    Ssh,
    Wsl,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProcessUnregisterParams {
    pub registration_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProcessCancelParams {
    pub attempt_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IpcInvokeParams {
    pub channel: String,
    /// IPC payloads are intentionally opaque to the shell contract.
    pub payload: Value,
}

pub type IpcPushParams = IpcInvokeParams;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WindowLabelParams {
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WindowFullscreenParams {
    pub label: String,
    pub fullscreen: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WindowTitleParams {
    pub label: String,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WindowBoundsParams {
    pub label: String,
    pub x: i64,
    pub y: i64,
    pub width: i64,
    pub height: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WindowBackgroundColorParams {
    pub label: String,
    pub color: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WindowZoomParams {
    pub label: String,
    pub zoom_factor: f64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WindowAlwaysOnTopParams {
    pub label: String,
    pub flag: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WindowCreateParams {
    pub label: String,
    #[serde(
        default,
        deserialize_with = "deserialize_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub url: Option<String>,
    pub title: String,
    pub width: i64,
    pub height: i64,
    pub min_width: i64,
    pub min_height: i64,
    #[serde(
        default,
        deserialize_with = "deserialize_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub x: Option<i64>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub y: Option<i64>,
    pub show: bool,
    pub background_color: String,
    pub decorations: bool,
    pub title_bar_style: String,
    pub hidden_title: bool,
    #[serde(
        default,
        deserialize_with = "deserialize_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub traffic_light_position: Option<Point>,
    pub init_scripts: Vec<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub zoom_factor: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Point {
    pub x: i64,
    pub y: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WindowEventParams {
    pub label: String,
    pub r#type: WindowEventType,
    #[serde(
        default,
        deserialize_with = "deserialize_optional",
        skip_serializing_if = "Option::is_none"
    )]
    /// Event-specific values are intentionally opaque to this boundary.
    pub data: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WindowEventType {
    Created,
    Closed,
    Focus,
    Blur,
    Minimized,
    Restored,
    Maximized,
    Unmaximized,
    Fullscreen,
    Moved,
    Resized,
    ThemeChanged,
    LoadFailed,
    WebviewCrashed,
    NavigationBlocked,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DialogOpenFolderParams {
    #[serde(
        default,
        deserialize_with = "deserialize_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub owner_label: Option<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub default_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DialogOpenFilesParams {
    #[serde(
        default,
        deserialize_with = "deserialize_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub owner_label: Option<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub default_path: Option<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub filters: Option<Vec<DialogFilter>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DialogFilter {
    pub name: String,
    pub extensions: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DialogMessageParams {
    pub kind: String,
    #[serde(
        default,
        deserialize_with = "deserialize_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub title: Option<String>,
    pub message: String,
    #[serde(
        default,
        deserialize_with = "deserialize_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub detail: Option<String>,
    pub buttons: Vec<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub default_id: Option<u64>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub cancel_id: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DialogErrorParams {
    pub title: String,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MenuItem {
    #[serde(
        default,
        deserialize_with = "deserialize_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub id: Option<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub label: Option<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub role: Option<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional",
        rename = "type",
        skip_serializing_if = "Option::is_none"
    )]
    pub item_type: Option<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub enabled: Option<bool>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub checked: Option<bool>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub accelerator: Option<String>,
    /// Nested menu entries have intentionally open shape for forward parity.
    #[serde(
        default,
        deserialize_with = "deserialize_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub submenu: Option<Vec<Value>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MenuSetApplicationParams {
    pub items: Vec<MenuItem>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MenuPopupParams {
    pub owner_label: String,
    pub items: Vec<MenuItem>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub position: Option<Point>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MenuClickParams {
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShellOpenExternalParams {
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShellShowItemParams {
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClipboardWriteTextParams {
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WslRegisterGuestParams {
    pub instance_id: String,
    pub distro: String,
    pub nonce: String,
    pub identity_file: String,
    pub state: WslGuestState,
    #[serde(
        default,
        deserialize_with = "deserialize_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub pid: Option<u64>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub pgid: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WslGuestState {
    Pending,
    Active,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WslUnregisterGuestParams {
    pub instance_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthCallbackParams {
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThemeSetSourceParams {
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThemeUpdatedParams {
    pub should_use_dark_colors: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SafeStorageEncryptParams {
    pub plaintext: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SafeStorageDecryptParams {
    pub ciphertext_base64: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdaterConfigureParams {
    pub endpoints: Vec<String>,
    pub channel: String,
    pub allow_downgrade: bool,
    #[serde(
        default,
        deserialize_with = "deserialize_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub target: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdaterInstallParams {
    pub relaunch: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdaterProgressParams {
    pub transferred: u64,
    #[serde(
        default,
        deserialize_with = "deserialize_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub total: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PowerEventParams {
    pub r#type: String,
    /// Platform-specific event values remain opaque until the power spike.
    pub value: Value,
}

/// Method parameters. The enum keeps the envelope's payload typed while the
/// few intentionally extensible fields remain [`serde_json::Value`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RpcParams {
    Empty(EmptyParams),
    ShellHello(ShellHelloParams),
    AppExit(AppExitParams),
    AppFocus(AppFocusParams),
    AppProtocolClient(AppProtocolClientParams),
    AppBeforeQuit(AppBeforeQuitParams),
    AppActivate(AppActivateParams),
    AppSecondInstance(AppSecondInstanceParams),
    AppOpenUrl(AppOpenUrlParams),
    ProcessRegister(ProcessRegisterParams),
    ProcessUnregister(ProcessUnregisterParams),
    ProcessCancel(ProcessCancelParams),
    IpcInvoke(IpcInvokeParams),
    IpcPush(IpcPushParams),
    WindowLabel(WindowLabelParams),
    WindowFullscreen(WindowFullscreenParams),
    WindowTitle(WindowTitleParams),
    WindowBounds(WindowBoundsParams),
    WindowBackgroundColor(WindowBackgroundColorParams),
    WindowZoom(WindowZoomParams),
    WindowAlwaysOnTop(WindowAlwaysOnTopParams),
    WindowCreate(WindowCreateParams),
    WindowEvent(WindowEventParams),
    DialogOpenFolder(DialogOpenFolderParams),
    DialogOpenFiles(DialogOpenFilesParams),
    DialogMessage(DialogMessageParams),
    DialogError(DialogErrorParams),
    MenuSetApplication(MenuSetApplicationParams),
    MenuPopup(MenuPopupParams),
    MenuClick(MenuClickParams),
    ShellOpenExternal(ShellOpenExternalParams),
    ShellShowItem(ShellShowItemParams),
    ClipboardWriteText(ClipboardWriteTextParams),
    WslRegisterGuest(WslRegisterGuestParams),
    WslUnregisterGuest(WslUnregisterGuestParams),
    AuthCallback(AuthCallbackParams),
    ThemeSetSource(ThemeSetSourceParams),
    ThemeUpdated(ThemeUpdatedParams),
    SafeStorageEncrypt(SafeStorageEncryptParams),
    SafeStorageDecrypt(SafeStorageDecryptParams),
    UpdaterConfigure(UpdaterConfigureParams),
    UpdaterInstall(UpdaterInstallParams),
    UpdaterProgress(UpdaterProgressParams),
    PowerEvent(PowerEventParams),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShellHelloResult {
    pub app_name: String,
    pub identifier: String,
    pub version: String,
    pub tauri_version: String,
    pub platform: String,
    pub arch: String,
    pub is_dev: bool,
    pub exec_path: String,
    pub resource_dir: String,
    pub server_root: String,
    pub app_data_dir: String,
    pub log_dir: String,
    pub system_locale: String,
    pub deep_link_scheme: String,
    pub argv: Vec<String>,
    pub launch_urls: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProcessMetric {
    pub pid: u64,
    #[serde(rename = "type")]
    pub metric_type: String,
    pub cpu_percent: f64,
    pub memory_kb: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegisteredResult {
    pub registered: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OkResult {
    pub ok: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreventedResult {
    pub prevented: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegistrationResult {
    #[serde(deserialize_with = "RequiredNullable::deserialize")]
    pub registration_id: RequiredNullableString,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IpcInvokeResult {
    pub result: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WindowCreatedResult {
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WindowBoundsResult {
    pub x: i64,
    pub y: i64,
    pub width: i64,
    pub height: i64,
    pub maximized: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WindowStateResult {
    pub visible: bool,
    pub focused: bool,
    pub minimized: bool,
    pub maximized: bool,
    pub fullscreen: bool,
    pub destroyed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PathResult {
    #[serde(deserialize_with = "RequiredNullable::deserialize")]
    pub path: RequiredNullableString,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PathsResult {
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DialogMessageResult {
    pub response: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SelectedIdResult {
    #[serde(deserialize_with = "RequiredNullable::deserialize")]
    pub selected_id: RequiredNullableString,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThemeResult {
    pub should_use_dark_colors: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SafeStorageStatusResult {
    pub available: bool,
    #[serde(
        default,
        deserialize_with = "deserialize_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub backend: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CiphertextResult {
    pub ciphertext_base64: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlaintextResult {
    pub plaintext: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdaterCheckResult {
    pub available: bool,
    #[serde(
        default,
        deserialize_with = "deserialize_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub version: Option<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub notes: Option<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub date: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PowerSnapshotResult {
    pub on_battery: bool,
    pub idle_seconds: u64,
    pub idle_state: String,
    pub thermal_state: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EmptyResult {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RpcResult {
    Empty(EmptyResult),
    ShellHello(Box<ShellHelloResult>),
    Registered(RegisteredResult),
    Ok(OkResult),
    Metrics(Vec<ProcessMetric>),
    Prevented(PreventedResult),
    Registration(RegistrationResult),
    IpcInvoke(IpcInvokeResult),
    WindowCreated(WindowCreatedResult),
    WindowBounds(WindowBoundsResult),
    WindowState(WindowStateResult),
    Path(PathResult),
    Paths(PathsResult),
    DialogMessage(DialogMessageResult),
    SelectedId(SelectedIdResult),
    Theme(ThemeResult),
    SafeStorageStatus(SafeStorageStatusResult),
    Ciphertext(CiphertextResult),
    Plaintext(PlaintextResult),
    UpdaterCheck(UpdaterCheckResult),
    PowerSnapshot(PowerSnapshotResult),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RpcRequest {
    pub jsonrpc: JsonRpcVersion,
    pub id: RpcId,
    pub method: RpcMethod,
    #[serde(
        default,
        deserialize_with = "deserialize_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub params: Option<RpcParams>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RpcNotification {
    pub jsonrpc: JsonRpcVersion,
    pub method: RpcMethod,
    #[serde(
        default,
        deserialize_with = "deserialize_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub params: Option<RpcParams>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RpcSuccessResponse {
    pub jsonrpc: JsonRpcVersion,
    pub id: RpcId,
    pub result: RpcResult,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RpcErrorResponse {
    pub jsonrpc: JsonRpcVersion,
    #[serde(deserialize_with = "RequiredNullable::deserialize")]
    pub id: RequiredNullable<RpcId>,
    pub error: RpcError,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RpcResponse {
    Success(Box<RpcSuccessResponse>),
    Error(RpcErrorResponse),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RpcEnvelope {
    Request(RpcRequest),
    Notification(RpcNotification),
    Response(RpcResponse),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RpcErrorKind {
    Unsupported,
    InvalidParams,
    Platform,
    Cancelled,
    Timeout,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RpcErrorData {
    pub kind: RpcErrorKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    #[serde(
        default,
        deserialize_with = "deserialize_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub data: Option<RpcErrorData>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorFixtureKind {
    InvalidRequest,
    MethodNotFound,
    InvalidParams,
    Platform,
    Unsupported,
    Cancelled,
    Timeout,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FrameExpectation {
    Accept,
    Reject,
    Resync,
    Close,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LimitExpectation {
    Accept,
    Reject,
    Close,
    Queue,
    Cancel,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RpcFixture {
    pub name: String,
    pub direction: RpcDirection,
    pub envelope: RpcEnvelope,
    pub kind: RpcFixtureKind,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RpcResultFixture {
    pub name: String,
    pub method: RpcMethod,
    pub direction: RpcDirection,
    pub kind: ResponseFixtureKind,
    pub envelope: RpcSuccessResponse,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ResponseFixtureKind {
    Response,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ErrorFixture {
    pub name: String,
    pub description: String,
    pub envelope: RpcErrorResponse,
    pub expect_kind: ErrorFixtureKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LimitFixture {
    pub name: String,
    pub description: String,
    pub limit: u64,
    pub observed: u64,
    pub expect: LimitExpectation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FrameFixture {
    pub name: String,
    pub description: String,
    #[serde(
        default,
        deserialize_with = "deserialize_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub frame: Option<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub bytes_base64: Option<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub bytes: Option<Vec<u8>>,
    pub expect: FrameExpectation,
    #[serde(
        default,
        deserialize_with = "deserialize_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProtocolFixtureDocument {
    pub protocol_version: JsonRpcVersion,
    pub fixtures: Vec<RpcFixture>,
    pub errors: Vec<ErrorFixture>,
    pub limits: Vec<LimitFixture>,
    pub frames: Vec<FrameFixture>,
    pub results: Vec<RpcResultFixture>,
}

/// Errors produced while loading or validating the shared protocol contract.
#[derive(Debug, Error)]
pub enum ProtocolError {
    #[error("failed to decode protocol fixtures: {0}")]
    Decode(#[from] serde_json::Error),
    #[error("fixture {fixture}: {reason}")]
    InvalidFixture { fixture: String, reason: String },
}

/// Decode the canonical JSON fixture without performing any transport action.
pub fn fixture_document() -> Result<ProtocolFixtureDocument, ProtocolError> {
    let document = serde_json::from_str(PROTOCOL_FIXTURES_JSON)?;
    Ok(document)
}

/// Decode one wire envelope and enforce the Appendix B request/notification
/// kind and parameter contract. Response result validation remains
/// method-aware in the peer that owns the pending request table.
pub fn decode_envelope(json: &str) -> Result<RpcEnvelope, ProtocolError> {
    let envelope = serde_json::from_str(json)?;
    validate_envelope(&envelope)?;
    Ok(envelope)
}

pub fn validate_envelope(envelope: &RpcEnvelope) -> Result<(), ProtocolError> {
    match envelope {
        RpcEnvelope::Request(request) => {
            validate_rpc_id("envelope", request.id)?;
            if request.method.spec().1 != RpcFixtureKind::Request {
                return Err(invalid_fixture(
                    "envelope",
                    "notification method cannot carry a request id",
                ));
            }
            validate_params("envelope", request.method, request.params.as_ref())
        }
        RpcEnvelope::Notification(notification) => {
            if notification.method.spec().1 != RpcFixtureKind::Notification {
                return Err(invalid_fixture(
                    "envelope",
                    "request method must carry a request id",
                ));
            }
            validate_params(
                "envelope",
                notification.method,
                notification.params.as_ref(),
            )
        }
        RpcEnvelope::Response(RpcResponse::Success(response)) => {
            validate_rpc_id("envelope", response.id)
        }
        RpcEnvelope::Response(RpcResponse::Error(response)) => {
            if let Some(id) = response.id.0 {
                validate_rpc_id("envelope", id)?;
            }
            Ok(())
        }
    }
}

/// Decode and validate the canonical fixture's method categories, directions,
/// and method-specific parameter/result contracts.
pub fn validate_fixture_document(document: &ProtocolFixtureDocument) -> Result<(), ProtocolError> {
    if document.protocol_version != JSON_RPC_VERSION {
        return Err(invalid_fixture(
            "document",
            "protocolVersion must be JSON-RPC 2.0",
        ));
    }

    for fixture in &document.fixtures {
        validate_fixture(fixture)?;
    }
    for fixture in &document.results {
        validate_result_fixture(fixture)?;
    }
    for fixture in &document.errors {
        validate_error_fixture(fixture)?;
    }

    validate_fixture_metadata(document)?;
    validate_limit_fixtures(&document.limits)?;
    validate_frame_fixtures(&document.frames)?;

    validate_method_coverage(document)?;

    Ok(())
}

fn validate_fixture_metadata(document: &ProtocolFixtureDocument) -> Result<(), ProtocolError> {
    for name in document
        .fixtures
        .iter()
        .map(|fixture| fixture.name.as_str())
        .chain(document.results.iter().map(|fixture| fixture.name.as_str()))
        .chain(document.errors.iter().map(|fixture| fixture.name.as_str()))
        .chain(document.limits.iter().map(|fixture| fixture.name.as_str()))
        .chain(document.frames.iter().map(|fixture| fixture.name.as_str()))
    {
        if name.is_empty() {
            return Err(invalid_fixture(
                "document",
                "fixture names must be non-empty",
            ));
        }
    }
    for (name, description) in document
        .errors
        .iter()
        .map(|fixture| (fixture.name.as_str(), fixture.description.as_str()))
        .chain(
            document
                .limits
                .iter()
                .map(|fixture| (fixture.name.as_str(), fixture.description.as_str())),
        )
        .chain(
            document
                .frames
                .iter()
                .map(|fixture| (fixture.name.as_str(), fixture.description.as_str())),
        )
    {
        if description.is_empty() {
            return Err(invalid_fixture(
                name,
                "fixture descriptions must be non-empty",
            ));
        }
    }
    Ok(())
}

fn validate_limit_fixtures(fixtures: &[LimitFixture]) -> Result<(), ProtocolError> {
    let expected = [
        (
            "max-frame-bytes",
            MAX_FRAME_BYTES,
            MAX_FRAME_BYTES,
            LimitExpectation::Accept,
        ),
        (
            "oversized-frame",
            MAX_FRAME_BYTES,
            MAX_FRAME_BYTES + 1,
            LimitExpectation::Close,
        ),
        (
            "max-nesting-depth",
            MAX_NESTING_DEPTH,
            MAX_NESTING_DEPTH,
            LimitExpectation::Accept,
        ),
        (
            "too-deep-frame",
            MAX_NESTING_DEPTH,
            MAX_NESTING_DEPTH + 1,
            LimitExpectation::Close,
        ),
        (
            "pending-request-capacity",
            MAX_PENDING_REQUESTS,
            MAX_PENDING_REQUESTS,
            LimitExpectation::Queue,
        ),
        (
            "pending-request-overflow",
            MAX_PENDING_REQUESTS,
            MAX_PENDING_REQUESTS + 1,
            LimitExpectation::Reject,
        ),
        (
            "pre-ready-renderer-queue",
            PRE_READY_RENDERER_QUEUE_LIMIT,
            PRE_READY_RENDERER_QUEUE_LIMIT,
            LimitExpectation::Queue,
        ),
        (
            "pre-ready-renderer-overflow",
            PRE_READY_RENDERER_QUEUE_LIMIT,
            PRE_READY_RENDERER_QUEUE_LIMIT + 1,
            LimitExpectation::Reject,
        ),
        (
            "hello-timeout",
            HELLO_TIMEOUT_MS,
            HELLO_TIMEOUT_MS + 1,
            LimitExpectation::Close,
        ),
        ("cancel-request", 1, 1, LimitExpectation::Cancel),
    ];
    if fixtures.len() != expected.len() {
        return Err(invalid_fixture("limits", "limit fixture count changed"));
    }
    for (name, limit, observed, expectation) in expected {
        let matches = fixtures
            .iter()
            .filter(|fixture| fixture.name == name)
            .collect::<Vec<_>>();
        if matches.len() != 1 {
            return Err(invalid_fixture(name, "expected exactly one limit fixture"));
        }
        let fixture = matches[0];
        if fixture.limit != limit || fixture.observed != observed || fixture.expect != expectation {
            return Err(invalid_fixture(name, "frozen limit metadata changed"));
        }
    }
    Ok(())
}

fn validate_frame_fixtures(fixtures: &[FrameFixture]) -> Result<(), ProtocolError> {
    const EXPECTED_NAMES: [&str; 10] = [
        "ascii-frame",
        "emoji-byte-length",
        "cjk-byte-length",
        "split-utf8-codepoint",
        "invalid-utf8",
        "partial-frame",
        "unframed-bytes",
        "malformed-json",
        "length-mismatch",
        "direct-stdout-after-takeover",
    ];
    if fixtures.len() != EXPECTED_NAMES.len() {
        return Err(invalid_fixture("frames", "frame fixture count changed"));
    }
    for name in EXPECTED_NAMES {
        if fixtures
            .iter()
            .filter(|fixture| fixture.name == name)
            .count()
            != 1
        {
            return Err(invalid_fixture(name, "expected exactly one frame fixture"));
        }
    }
    let invalid_utf8 = fixtures
        .iter()
        .find(|fixture| fixture.name == "invalid-utf8")
        .ok_or_else(|| invalid_fixture("invalid-utf8", "fixture missing"))?;
    if invalid_utf8.bytes_base64.as_deref() != Some("//4=")
        || invalid_utf8.frame.is_some()
        || invalid_utf8.expect != FrameExpectation::Reject
    {
        return Err(invalid_fixture(
            "invalid-utf8",
            "invalid UTF-8 bytes or expectation changed",
        ));
    }
    let split = fixtures
        .iter()
        .find(|fixture| fixture.name == "split-utf8-codepoint")
        .ok_or_else(|| invalid_fixture("split-utf8-codepoint", "fixture missing"))?;
    if split.bytes.is_none() || split.bytes_base64.is_some() {
        return Err(invalid_fixture(
            "split-utf8-codepoint",
            "split UTF-8 fixture must preserve raw bytes",
        ));
    }
    Ok(())
}

fn validate_method_coverage(document: &ProtocolFixtureDocument) -> Result<(), ProtocolError> {
    let mut fixture_counts = HashMap::<RpcMethod, usize>::new();
    for fixture in &document.fixtures {
        let method = match &fixture.envelope {
            RpcEnvelope::Request(request) => Some(request.method),
            RpcEnvelope::Notification(notification) => Some(notification.method),
            RpcEnvelope::Response(_) => None,
        };
        if let Some(method) = method {
            let count = fixture_counts.entry(method).or_default();
            *count += 1;
        }
    }

    let mut result_counts = HashMap::<RpcMethod, usize>::new();
    for fixture in &document.results {
        let count = result_counts.entry(fixture.method).or_default();
        *count += 1;
    }

    for method in ALL_METHODS {
        let fixture_count = fixture_counts.get(method).copied().unwrap_or(0);
        if fixture_count != 1 {
            return Err(invalid_fixture(
                "document",
                &format!(
                    "method {method:?} has {fixture_count} fixture entries; expected exactly one"
                ),
            ));
        }

        let result_count = result_counts.get(method).copied().unwrap_or(0);
        let expected_result_count = match method.spec().1 {
            RpcFixtureKind::Request => 1,
            RpcFixtureKind::Notification => 0,
            RpcFixtureKind::Response => 0,
        };
        if result_count != expected_result_count {
            return Err(invalid_fixture(
                "document",
                &format!(
                    "method {method:?} has {result_count} positive result fixtures; expected {expected_result_count}"
                ),
            ));
        }
    }
    Ok(())
}

fn validate_fixture(fixture: &RpcFixture) -> Result<(), ProtocolError> {
    let (method, has_id, params) = match &fixture.envelope {
        RpcEnvelope::Request(request) => {
            validate_rpc_id(&fixture.name, request.id)?;
            (request.method, true, request.params.as_ref())
        }
        RpcEnvelope::Notification(notification) => {
            (notification.method, false, notification.params.as_ref())
        }
        RpcEnvelope::Response(_) => {
            return if fixture.kind == RpcFixtureKind::Response {
                Ok(())
            } else {
                Err(invalid_fixture(
                    &fixture.name,
                    "request/notification metadata cannot describe a response envelope",
                ))
            };
        }
    };

    let (expected_direction, expected_kind) = method.spec();
    if fixture.direction != expected_direction || fixture.kind != expected_kind {
        return Err(invalid_fixture(
            &fixture.name,
            "direction or kind does not match Appendix B",
        ));
    }
    if has_id != (expected_kind == RpcFixtureKind::Request) {
        return Err(invalid_fixture(
            &fixture.name,
            "request id presence does not match method kind",
        ));
    }
    validate_params(fixture.name.as_str(), method, params)
}

fn validate_result_fixture(fixture: &RpcResultFixture) -> Result<(), ProtocolError> {
    if fixture.kind != ResponseFixtureKind::Response {
        return Err(invalid_fixture(
            &fixture.name,
            "result fixtures must be response entries",
        ));
    }
    let (request_direction, _) = fixture.method.spec();
    let expected_direction = match request_direction {
        RpcDirection::HostToShell => RpcDirection::ShellToHost,
        RpcDirection::ShellToHost => RpcDirection::HostToShell,
    };
    if fixture.direction != expected_direction {
        return Err(invalid_fixture(
            &fixture.name,
            "result direction does not oppose the request direction",
        ));
    }
    validate_rpc_id(&fixture.name, fixture.envelope.id)?;
    validate_result(
        fixture.name.as_str(),
        fixture.method,
        &fixture.envelope.result,
    )
}

fn validate_error_fixture(fixture: &ErrorFixture) -> Result<(), ProtocolError> {
    let expected = match fixture.expect_kind {
        ErrorFixtureKind::InvalidRequest => (-32600, None),
        ErrorFixtureKind::MethodNotFound => (-32601, Some(RpcErrorKind::Unsupported)),
        ErrorFixtureKind::InvalidParams => (-32602, Some(RpcErrorKind::InvalidParams)),
        ErrorFixtureKind::Platform => (-32000, Some(RpcErrorKind::Platform)),
        ErrorFixtureKind::Unsupported => (-32001, Some(RpcErrorKind::Unsupported)),
        ErrorFixtureKind::Cancelled => (-32002, Some(RpcErrorKind::Cancelled)),
        ErrorFixtureKind::Timeout => (-32003, Some(RpcErrorKind::Timeout)),
    };
    if fixture.envelope.error.code != expected.0 {
        return Err(invalid_fixture(
            &fixture.name,
            "error code does not match expectKind",
        ));
    }
    let actual_kind = fixture
        .envelope
        .error
        .data
        .as_ref()
        .map(|data| data.kind.clone());
    if actual_kind != expected.1 {
        return Err(invalid_fixture(
            &fixture.name,
            "error data.kind does not match expectKind",
        ));
    }
    if let Some(id) = fixture.envelope.id.0 {
        validate_rpc_id(&fixture.name, id)?;
    }
    if matches!(fixture.expect_kind, ErrorFixtureKind::InvalidRequest)
        && fixture.envelope.id.0.is_some()
    {
        return Err(invalid_fixture(
            &fixture.name,
            "invalid-request errors must use a null id",
        ));
    }
    Ok(())
}

fn validate_rpc_id(fixture_name: &str, id: RpcId) -> Result<(), ProtocolError> {
    if id.unsigned_abs() > JS_SAFE_INTEGER_MAX as u64 {
        return Err(invalid_fixture(
            fixture_name,
            "id must be within the JavaScript safe-integer range",
        ));
    }
    Ok(())
}

fn validate_non_empty_fields(
    fixture_name: &str,
    value: &Value,
    fields: &[&str],
) -> Result<(), ProtocolError> {
    for field in fields {
        let Some(field_value) = value.get(*field) else {
            continue;
        };
        let is_non_empty = field_value.as_str().is_some_and(|text| !text.is_empty());
        if !is_non_empty {
            return Err(invalid_fixture(
                fixture_name,
                &format!("{field} must be a non-empty string"),
            ));
        }
    }
    Ok(())
}

fn non_empty_param_fields(method: RpcMethod) -> &'static [&'static str] {
    match method {
        RpcMethod::AppIsProtocolClient | RpcMethod::AppSetProtocolClient => &["scheme"],
        RpcMethod::ProcessRegister => &["attemptId"],
        RpcMethod::ProcessUnregister => &["registrationId"],
        RpcMethod::ProcessCancel => &["attemptId"],
        RpcMethod::IpcInvoke | RpcMethod::IpcPush => &["channel"],
        RpcMethod::WindowCreate
        | RpcMethod::WindowShow
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
        | RpcMethod::WindowGetBounds
        | RpcMethod::WindowGetState
        | RpcMethod::WindowSetFullscreen
        | RpcMethod::WindowSetTitle
        | RpcMethod::WindowSetBounds
        | RpcMethod::WindowSetBackgroundColor
        | RpcMethod::WindowSetZoom
        | RpcMethod::WindowSetAlwaysOnTop
        | RpcMethod::WindowEvent => &["label"],
        RpcMethod::MenuPopup => &["ownerLabel"],
        RpcMethod::MenuClick => &["id"],
        RpcMethod::ShellOpenExternal => &["url"],
        RpcMethod::ShellShowItemInFolder => &["path"],
        RpcMethod::WslRegisterGuest => &["instanceId", "distro", "nonce", "identityFile"],
        RpcMethod::WslUnregisterGuest => &["instanceId"],
        RpcMethod::AuthCallback => &["url"],
        _ => &[],
    }
}

fn validate_params(
    fixture_name: &str,
    method: RpcMethod,
    params: Option<&RpcParams>,
) -> Result<(), ProtocolError> {
    if params.is_none() {
        return if method.requires_params() {
            Err(invalid_fixture(fixture_name, "method requires params"))
        } else {
            Ok(())
        };
    }

    let Some(params) = params else {
        return Err(invalid_fixture(fixture_name, "method requires params"));
    };
    let value = params_to_value(fixture_name, params)?;
    if !method.requires_params() && value != Value::Object(serde_json::Map::new()) {
        return Err(invalid_fixture(
            fixture_name,
            "a no-params method may only carry an empty object",
        ));
    }
    validate_non_empty_fields(fixture_name, &value, non_empty_param_fields(method))?;
    let result = match method {
        RpcMethod::ShellHello => {
            serde_json::from_value::<ShellHelloParams>(value).map(|_| EmptyParams {})
        }
        RpcMethod::AppQuit
        | RpcMethod::AppRelaunch
        | RpcMethod::AppGetMetrics
        | RpcMethod::AppWindowAllClosed
        | RpcMethod::AppShutdownComplete
        | RpcMethod::ThemeGet
        | RpcMethod::SafeStorageStatus
        | RpcMethod::UpdaterCheck
        | RpcMethod::UpdaterDownload
        | RpcMethod::PowerSnapshot => Ok(EmptyParams {}),
        RpcMethod::AppExit => {
            serde_json::from_value::<AppExitParams>(value).map(|_| EmptyParams {})
        }
        RpcMethod::AppFocus => {
            serde_json::from_value::<AppFocusParams>(value).map(|_| EmptyParams {})
        }
        RpcMethod::AppIsProtocolClient | RpcMethod::AppSetProtocolClient => {
            serde_json::from_value::<AppProtocolClientParams>(value).map(|_| EmptyParams {})
        }
        RpcMethod::AppBeforeQuit => {
            serde_json::from_value::<AppBeforeQuitParams>(value).map(|_| EmptyParams {})
        }
        RpcMethod::AppActivate => {
            serde_json::from_value::<AppActivateParams>(value).map(|_| EmptyParams {})
        }
        RpcMethod::AppSecondInstance => {
            serde_json::from_value::<AppSecondInstanceParams>(value).map(|_| EmptyParams {})
        }
        RpcMethod::AppOpenUrl => {
            serde_json::from_value::<AppOpenUrlParams>(value).map(|_| EmptyParams {})
        }
        RpcMethod::ProcessRegister => {
            serde_json::from_value::<ProcessRegisterParams>(value).map(|_| EmptyParams {})
        }
        RpcMethod::ProcessUnregister => {
            serde_json::from_value::<ProcessUnregisterParams>(value).map(|_| EmptyParams {})
        }
        RpcMethod::ProcessCancel => {
            serde_json::from_value::<ProcessCancelParams>(value).map(|_| EmptyParams {})
        }
        RpcMethod::IpcInvoke => {
            serde_json::from_value::<IpcInvokeParams>(value).map(|_| EmptyParams {})
        }
        RpcMethod::IpcPush => {
            serde_json::from_value::<IpcPushParams>(value).map(|_| EmptyParams {})
        }
        RpcMethod::WindowCreate => {
            serde_json::from_value::<WindowCreateParams>(value).map(|_| EmptyParams {})
        }
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
        | RpcMethod::WindowGetBounds
        | RpcMethod::WindowGetState => {
            serde_json::from_value::<WindowLabelParams>(value).map(|_| EmptyParams {})
        }
        RpcMethod::WindowSetFullscreen => {
            serde_json::from_value::<WindowFullscreenParams>(value).map(|_| EmptyParams {})
        }
        RpcMethod::WindowSetTitle => {
            serde_json::from_value::<WindowTitleParams>(value).map(|_| EmptyParams {})
        }
        RpcMethod::WindowSetBounds => {
            serde_json::from_value::<WindowBoundsParams>(value).map(|_| EmptyParams {})
        }
        RpcMethod::WindowSetBackgroundColor => {
            serde_json::from_value::<WindowBackgroundColorParams>(value).map(|_| EmptyParams {})
        }
        RpcMethod::WindowSetZoom => {
            serde_json::from_value::<WindowZoomParams>(value).map(|_| EmptyParams {})
        }
        RpcMethod::WindowSetAlwaysOnTop => {
            serde_json::from_value::<WindowAlwaysOnTopParams>(value).map(|_| EmptyParams {})
        }
        RpcMethod::WindowEvent => {
            serde_json::from_value::<WindowEventParams>(value).map(|_| EmptyParams {})
        }
        RpcMethod::DialogOpenFolder => {
            serde_json::from_value::<DialogOpenFolderParams>(value).map(|_| EmptyParams {})
        }
        RpcMethod::DialogOpenFiles => {
            serde_json::from_value::<DialogOpenFilesParams>(value).map(|_| EmptyParams {})
        }
        RpcMethod::DialogMessage => {
            serde_json::from_value::<DialogMessageParams>(value).map(|_| EmptyParams {})
        }
        RpcMethod::DialogError => {
            serde_json::from_value::<DialogErrorParams>(value).map(|_| EmptyParams {})
        }
        RpcMethod::MenuSetApplication => {
            serde_json::from_value::<MenuSetApplicationParams>(value).map(|_| EmptyParams {})
        }
        RpcMethod::MenuPopup => {
            serde_json::from_value::<MenuPopupParams>(value).map(|_| EmptyParams {})
        }
        RpcMethod::MenuClick => {
            serde_json::from_value::<MenuClickParams>(value).map(|_| EmptyParams {})
        }
        RpcMethod::ShellOpenExternal => {
            serde_json::from_value::<ShellOpenExternalParams>(value).map(|_| EmptyParams {})
        }
        RpcMethod::ShellShowItemInFolder => {
            serde_json::from_value::<ShellShowItemParams>(value).map(|_| EmptyParams {})
        }
        RpcMethod::ClipboardWriteText => {
            serde_json::from_value::<ClipboardWriteTextParams>(value).map(|_| EmptyParams {})
        }
        RpcMethod::WslRegisterGuest => {
            serde_json::from_value::<WslRegisterGuestParams>(value).map(|_| EmptyParams {})
        }
        RpcMethod::WslUnregisterGuest => {
            serde_json::from_value::<WslUnregisterGuestParams>(value).map(|_| EmptyParams {})
        }
        RpcMethod::AuthCallback => {
            serde_json::from_value::<AuthCallbackParams>(value).map(|_| EmptyParams {})
        }
        RpcMethod::ThemeSetSource => {
            serde_json::from_value::<ThemeSetSourceParams>(value).map(|_| EmptyParams {})
        }
        RpcMethod::ThemeUpdated => {
            serde_json::from_value::<ThemeUpdatedParams>(value).map(|_| EmptyParams {})
        }
        RpcMethod::SafeStorageEncrypt => {
            serde_json::from_value::<SafeStorageEncryptParams>(value).map(|_| EmptyParams {})
        }
        RpcMethod::SafeStorageDecrypt => {
            serde_json::from_value::<SafeStorageDecryptParams>(value).map(|_| EmptyParams {})
        }
        RpcMethod::UpdaterConfigure => {
            serde_json::from_value::<UpdaterConfigureParams>(value).map(|_| EmptyParams {})
        }
        RpcMethod::UpdaterInstall => {
            serde_json::from_value::<UpdaterInstallParams>(value).map(|_| EmptyParams {})
        }
        RpcMethod::UpdaterProgress => {
            serde_json::from_value::<UpdaterProgressParams>(value).map(|_| EmptyParams {})
        }
        RpcMethod::PowerEvent => {
            serde_json::from_value::<PowerEventParams>(value).map(|_| EmptyParams {})
        }
    };
    result
        .map(|_| ())
        .map_err(|error| invalid_fixture(fixture_name, &format!("invalid params: {error}")))
}

fn params_to_value(fixture_name: &str, params: &RpcParams) -> Result<Value, ProtocolError> {
    serde_json::to_value(params).map_err(|error| {
        invalid_fixture(fixture_name, &format!("failed to inspect params: {error}"))
    })
}

fn validate_result(
    fixture_name: &str,
    method: RpcMethod,
    result: &RpcResult,
) -> Result<(), ProtocolError> {
    let value = serde_json::to_value(result).map_err(|error| {
        invalid_fixture(fixture_name, &format!("failed to inspect result: {error}"))
    })?;
    let non_empty_fields = match method {
        RpcMethod::WindowCreate => &["label"][..],
        _ => &[][..],
    };
    validate_non_empty_fields(fixture_name, &value, non_empty_fields)?;
    macro_rules! decode {
        ($result:ty) => {
            serde_json::from_value::<$result>(value).map(|_| ())
        };
    }
    let decoded = match method {
        RpcMethod::ShellHello => decode!(ShellHelloResult),
        RpcMethod::AppQuit
        | RpcMethod::AppExit
        | RpcMethod::AppRelaunch
        | RpcMethod::AppFocus
        | RpcMethod::AppWindowAllClosed
        | RpcMethod::AppActivate
        | RpcMethod::AppSecondInstance
        | RpcMethod::AppOpenUrl
        | RpcMethod::AppShutdownComplete
        | RpcMethod::ProcessUnregister
        | RpcMethod::ProcessCancel
        | RpcMethod::IpcPush
        | RpcMethod::WindowShow
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
        | RpcMethod::WindowEvent
        | RpcMethod::DialogError
        | RpcMethod::MenuSetApplication
        | RpcMethod::MenuClick
        | RpcMethod::ShellShowItemInFolder
        | RpcMethod::ClipboardWriteText
        | RpcMethod::AuthCallback
        | RpcMethod::ThemeSetSource
        | RpcMethod::ThemeUpdated
        | RpcMethod::UpdaterConfigure
        | RpcMethod::UpdaterDownload
        | RpcMethod::UpdaterInstall
        | RpcMethod::UpdaterProgress
        | RpcMethod::PowerEvent => decode!(EmptyResult),
        RpcMethod::AppIsProtocolClient => decode!(RegisteredResult),
        RpcMethod::AppSetProtocolClient
        | RpcMethod::ShellOpenExternal
        | RpcMethod::WslRegisterGuest
        | RpcMethod::WslUnregisterGuest => decode!(OkResult),
        RpcMethod::AppGetMetrics => decode!(Vec<ProcessMetric>),
        RpcMethod::AppBeforeQuit => decode!(PreventedResult),
        RpcMethod::ProcessRegister => decode!(RegistrationResult),
        RpcMethod::IpcInvoke => decode!(IpcInvokeResult),
        RpcMethod::WindowCreate => decode!(WindowCreatedResult),
        RpcMethod::WindowGetBounds => decode!(WindowBoundsResult),
        RpcMethod::WindowGetState => decode!(WindowStateResult),
        RpcMethod::DialogOpenFolder => decode!(PathResult),
        RpcMethod::DialogOpenFiles => decode!(PathsResult),
        RpcMethod::DialogMessage => decode!(DialogMessageResult),
        RpcMethod::MenuPopup => decode!(SelectedIdResult),
        RpcMethod::ThemeGet => decode!(ThemeResult),
        RpcMethod::SafeStorageStatus => decode!(SafeStorageStatusResult),
        RpcMethod::SafeStorageEncrypt => decode!(CiphertextResult),
        RpcMethod::SafeStorageDecrypt => decode!(PlaintextResult),
        RpcMethod::UpdaterCheck => decode!(UpdaterCheckResult),
        RpcMethod::PowerSnapshot => decode!(PowerSnapshotResult),
    };
    decoded.map_err(|error| invalid_fixture(fixture_name, &format!("invalid result: {error}")))
}

fn invalid_fixture(fixture: &str, reason: &str) -> ProtocolError {
    ProtocolError::InvalidFixture {
        fixture: fixture.to_owned(),
        reason: reason.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_fixture_decodes_and_validates() -> Result<(), ProtocolError> {
        let document = fixture_document()?;
        validate_fixture_document(&document)?;
        assert_eq!(document.protocol_version, JsonRpcVersion::V2);
        assert_eq!(document.fixtures.len(), 67);
        assert_eq!(document.results.len(), 25);
        assert_eq!(document.errors.len(), 7);
        Ok(())
    }

    #[test]
    fn envelopes_round_trip_semantically() -> Result<(), ProtocolError> {
        let document = fixture_document()?;
        for fixture in &document.fixtures {
            let encoded = serde_json::to_string(&fixture.envelope)?;
            let decoded: RpcEnvelope = serde_json::from_str(&encoded)?;
            assert_eq!(decoded, fixture.envelope, "{}", fixture.name);
        }
        Ok(())
    }

    #[test]
    fn result_fixtures_round_trip_and_validate() -> Result<(), ProtocolError> {
        let document = fixture_document()?;
        for fixture in &document.results {
            let encoded = serde_json::to_string(&fixture.envelope)?;
            let decoded: RpcSuccessResponse = serde_json::from_str(&encoded)?;
            assert_eq!(decoded, fixture.envelope, "{}", fixture.name);
            validate_result_fixture(fixture)?;
        }
        Ok(())
    }

    #[test]
    fn error_limit_and_frame_fixtures_round_trip_and_validate() -> Result<(), ProtocolError> {
        let document = fixture_document()?;

        for fixture in &document.errors {
            let encoded = serde_json::to_string(fixture)?;
            let decoded: ErrorFixture = serde_json::from_str(&encoded)?;
            assert_eq!(decoded, *fixture, "{}", fixture.name);
            validate_error_fixture(fixture)?;
        }
        for fixture in &document.limits {
            let encoded = serde_json::to_string(fixture)?;
            let decoded: LimitFixture = serde_json::from_str(&encoded)?;
            assert_eq!(decoded, *fixture, "{}", fixture.name);
        }
        for fixture in &document.frames {
            let encoded = serde_json::to_string(fixture)?;
            let decoded: FrameFixture = serde_json::from_str(&encoded)?;
            assert_eq!(decoded, *fixture, "{}", fixture.name);
        }

        validate_limit_fixtures(&document.limits)?;
        validate_frame_fixtures(&document.frames)
    }

    #[test]
    fn envelope_decoder_rejects_wrong_method_kind_and_params() {
        for invalid in [
            r#"{"jsonrpc":"2.0","id":1,"method":"app.exit","params":{"code":0}}"#,
            r#"{"jsonrpc":"2.0","method":"shell.hello","params":{"protocolVersion":"2.0","hostPid":1}}"#,
            r#"{"jsonrpc":"2.0","method":"window.getBounds","params":{"label":"main"}}"#,
            r#"{"jsonrpc":"2.0","id":1,"method":"app.open-url","params":{"urls":[]}}"#,
            r#"{"jsonrpc":"2.0","id":1,"method":"shell.hello","params":{"steal":true}}"#,
        ] {
            assert!(decode_envelope(invalid).is_err(), "accepted {invalid}");
        }
    }

    #[test]
    fn metadata_rejects_wrong_kind_for_notification() -> Result<(), ProtocolError> {
        let mut document = fixture_document()?;
        let fixture = document
            .fixtures
            .iter_mut()
            .find(|fixture| fixture.name == "app.quit")
            .ok_or_else(|| invalid_fixture("test", "app.quit fixture missing"))?;
        fixture.kind = RpcFixtureKind::Request;
        let error = validate_fixture_document(&document)
            .expect_err("wrong request/notification metadata must be rejected");
        assert!(error.to_string().contains("app.quit"));
        Ok(())
    }

    #[test]
    fn coverage_rejects_duplicate_and_omitted_methods() -> Result<(), ProtocolError> {
        let mut duplicate = fixture_document()?;
        let fixture = duplicate
            .fixtures
            .iter_mut()
            .find(|fixture| fixture.name == "app.quit")
            .ok_or_else(|| invalid_fixture("test", "app.quit fixture missing"))?;
        if let RpcEnvelope::Notification(notification) = &mut fixture.envelope {
            notification.method = RpcMethod::AppRelaunch;
        }
        let error = validate_fixture_document(&duplicate)
            .expect_err("duplicate method fixture must fail exact coverage");
        assert!(error.to_string().contains("fixture entries"));

        let mut omitted = fixture_document()?;
        omitted
            .fixtures
            .retain(|fixture| fixture.name != "app.quit");
        let error = validate_fixture_document(&omitted)
            .expect_err("omitted method fixture must fail exact coverage");
        assert!(error.to_string().contains("fixture entries"));
        Ok(())
    }

    #[test]
    fn coverage_rejects_missing_request_result() -> Result<(), ProtocolError> {
        let mut document = fixture_document()?;
        document
            .results
            .retain(|fixture| fixture.method != RpcMethod::AppGetMetrics);
        let error = validate_fixture_document(&document)
            .expect_err("every request method needs one positive result fixture");
        assert!(error.to_string().contains("positive result fixtures"));
        Ok(())
    }

    #[test]
    fn metadata_rejects_empty_names_and_descriptions() -> Result<(), ProtocolError> {
        let mut empty_name = fixture_document()?;
        empty_name.fixtures[0].name.clear();
        assert!(validate_fixture_document(&empty_name).is_err());

        let mut empty_description = fixture_document()?;
        empty_description.limits[0].description.clear();
        assert!(validate_fixture_document(&empty_description).is_err());
        Ok(())
    }

    #[test]
    fn representative_wrong_payloads_are_rejected() -> Result<(), ProtocolError> {
        let mut document = fixture_document()?;
        let fixture = document
            .fixtures
            .iter_mut()
            .find(|fixture| fixture.name == "window.setBounds")
            .ok_or_else(|| invalid_fixture("test", "window.setBounds fixture missing"))?;
        if let RpcEnvelope::Notification(notification) = &mut fixture.envelope {
            notification.params = Some(RpcParams::WindowBounds(WindowBoundsParams {
                label: "main".to_owned(),
                x: 0,
                y: 0,
                width: 1,
                height: 1,
            }));
        }
        // The typed payload itself is valid, so mutate the method-specific
        // shape through JSON to prove strict field validation is active.
        let mut value = serde_json::to_value(&fixture.envelope)?;
        if let Some(params) = value.get_mut("params") {
            params["width"] = Value::String("1200".to_owned());
        }
        let error = serde_json::from_value::<RpcEnvelope>(value)
            .expect_err("a string width must fail envelope decoding");
        assert!(error.to_string().contains("did not match any variant"));
        Ok(())
    }

    #[test]
    fn required_nullable_fields_reject_omission_and_round_trip_null() -> Result<(), ProtocolError> {
        assert!(serde_json::from_str::<RegistrationResult>(r#"{}"#).is_err());
        assert!(serde_json::from_str::<PathResult>(r#"{}"#).is_err());
        assert!(serde_json::from_str::<SelectedIdResult>(r#"{}"#).is_err());
        assert!(
            serde_json::from_str::<RpcErrorResponse>(
                r#"{"jsonrpc":"2.0","error":{"code":-32600,"message":"Invalid Request"}}"#,
            )
            .is_err()
        );

        let registration = RegistrationResult {
            registration_id: RequiredNullable(None),
        };
        let encoded = serde_json::to_value(&registration)?;
        assert_eq!(encoded, serde_json::json!({ "registrationId": null }));
        assert_eq!(
            serde_json::from_value::<RegistrationResult>(encoded)?,
            registration
        );

        let error = RpcErrorResponse {
            jsonrpc: JSON_RPC_VERSION,
            id: RequiredNullable(None),
            error: RpcError {
                code: -32600,
                message: "Invalid Request".to_owned(),
                data: None,
            },
        };
        let encoded = serde_json::to_value(&error)?;
        assert_eq!(encoded["id"], Value::Null);
        assert_eq!(serde_json::from_value::<RpcErrorResponse>(encoded)?, error);
        Ok(())
    }

    #[test]
    fn optional_none_fields_are_omitted_on_serialization() -> Result<(), ProtocolError> {
        assert!(
            decode_envelope(r#"{"jsonrpc":"2.0","method":"app.quit","params":null}"#,).is_err()
        );
        assert!(
            serde_json::from_str::<UpdaterCheckResult>(r#"{"available":false,"version":null}"#,)
                .is_err()
        );
        assert!(
            serde_json::from_str::<FrameFixture>(
                r#"{"name":"test","description":"test","frame":null,"expect":"accept"}"#,
            )
            .is_err()
        );
        assert!(serde_json::from_str::<MenuItem>(r#"{"type":null}"#).is_err());

        let result = UpdaterCheckResult {
            available: false,
            version: None,
            notes: None,
            date: None,
        };
        assert_eq!(
            serde_json::to_value(result)?,
            serde_json::json!({ "available": false })
        );

        let frame = FrameFixture {
            name: "test".to_owned(),
            description: "test".to_owned(),
            frame: None,
            bytes_base64: None,
            bytes: Some(vec![1, 2, 3]),
            expect: FrameExpectation::Accept,
            reason: None,
        };
        let encoded = serde_json::to_value(frame)?;
        assert!(encoded.get("frame").is_none());
        assert!(encoded.get("bytesBase64").is_none());
        assert!(encoded.get("reason").is_none());
        assert_eq!(encoded["bytes"], serde_json::json!([1, 2, 3]));
        Ok(())
    }

    #[test]
    fn semantic_fixture_validation_rejects_empty_required_strings_and_unsafe_ids()
    -> Result<(), ProtocolError> {
        let mut empty = fixture_document()?;
        let fixture = empty
            .fixtures
            .iter_mut()
            .find(|fixture| fixture.name == "process.unregister")
            .ok_or_else(|| invalid_fixture("test", "process.unregister fixture missing"))?;
        if let RpcEnvelope::Notification(notification) = &mut fixture.envelope {
            notification.params = Some(RpcParams::ProcessUnregister(ProcessUnregisterParams {
                registration_id: String::new(),
            }));
        }
        let error = validate_fixture_document(&empty)
            .expect_err("empty NonEmptyString payload must be rejected");
        assert!(error.to_string().contains("non-empty string"));

        let mut unsafe_id = fixture_document()?;
        let fixture = unsafe_id
            .fixtures
            .iter_mut()
            .find(|fixture| fixture.name == "shell.hello/request")
            .ok_or_else(|| invalid_fixture("test", "shell.hello fixture missing"))?;
        if let RpcEnvelope::Request(request) = &mut fixture.envelope {
            request.id = JS_SAFE_INTEGER_MAX + 1;
        }
        let error = validate_fixture_document(&unsafe_id)
            .expect_err("unsafe integer request id must be rejected");
        assert!(error.to_string().contains("safe-integer"));
        Ok(())
    }
}
