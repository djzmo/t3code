//! Transport-agnostic adapter for the shell/host `app.*` contract.
//!
//! The Tauri/tao integration owns the native callbacks and the RPC peer owns
//! framing.  This module sits between those two pieces: it turns typed app
//! notifications (or native callbacks) into [`lifecycle::Event`] values and
//! returns explicit effects for the platform integration to apply.  It does
//! not call Tauri, tao, a transport, or a process API.

use crate::lifecycle::{
    self, Action as LifecycleAction, Event as LifecycleEvent, QuitReason as LifecycleQuitReason,
    State,
};
use crate::rpc::protocol::{
    AppBeforeQuitParams, AppExitParams, AppFocusParams, RpcEnvelope, RpcMethod, RpcNotification,
    RpcParams, RpcResponse, RpcResult, UpdaterInstallParams,
};

/// The platform facts needed for the last-window and activation rules.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    /// macOS keeps the process alive when the last window closes.  A Dock
    /// activation is forwarded so the host can recreate the main window.
    Macos,
    /// Windows quits after the host receives `app.window-all-closed`.
    Windows,
    /// Linux quits after the host receives `app.window-all-closed`.
    Linux,
    /// An explicitly unsupported platform follows the conservative
    /// Windows/Linux (quit) behaviour.
    Other,
}

/// Native app callbacks supplied by the platform shell.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeEvent {
    /// A quit request with a native exit code.  `Some` is a real quit request;
    /// `None` is reserved for [`NativeEvent::LastWindowClosed`].
    BeforeQuit { reason: LifecycleQuitReason },
    /// The last native window was closed.  This is always prevented first;
    /// the host decides whether to quit (Windows/Linux) or stay resident
    /// (macOS).
    LastWindowClosed,
    /// A native activation/reopen callback.  tao supplies whether any window
    /// is currently visible.
    Activate { has_visible_windows: bool },
}

/// Host-originated `app.*` notifications that affect lifecycle or focus.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostNotification {
    Quit,
    Exit {
        code: i32,
    },
    Relaunch,
    /// Request an updater installation.  The lifecycle currently selects the
    /// install continuation regardless of `relaunch`, but retain the typed
    /// value so malformed or future protocol payloads cannot be accepted as a
    /// bare lifecycle signal.
    UpdaterInstall {
        relaunch: bool,
    },
    Focus {
        steal: bool,
    },
    ShutdownComplete,
}

/// A peer close is deliberately separate from a host `app.exit`: it is an
/// unexpected transport failure until the shell has already authorized a
/// continuation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppEvent {
    Native(NativeEvent),
    Host(HostNotification),
    PeerClosed,
    /// The shell's quit deadline expired before an authorized continuation.
    ShellDeadlineElapsed,
}

/// Effects that the native/transport integration must apply.
///
/// Lifecycle effects preserve the existing state machine's actions exactly;
/// the remaining effects are the small app-surface operations that cannot be
/// represented by `lifecycle::Action` (activation/focus and the synchronous
/// before-quit response).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Effect {
    Lifecycle(LifecycleAction),
    /// The native callback must return this value synchronously.  It is true
    /// until the lifecycle reaches `ExitAuthorized` and emits `PassThrough`.
    BeforeQuitResponse {
        prevented: bool,
    },
    /// Forward a macOS Dock/reopen activation to the host.
    NotifyActivate {
        has_visible_windows: bool,
    },
    /// Apply the host's `app.focus` notification to the main window.
    FocusMainWindow {
        steal: bool,
    },
}

/// Result of reducing one app event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppTransition {
    pub state: State,
    pub effects: Vec<Effect>,
}

impl AppTransition {
    fn lifecycle(transition: lifecycle::Transition) -> Self {
        let effects = transition
            .actions
            .into_iter()
            .map(Effect::Lifecycle)
            .collect();
        Self {
            state: transition.state,
            effects,
        }
    }

    fn unchanged(state: State) -> Self {
        Self {
            state,
            effects: Vec::new(),
        }
    }
}

/// Stateful convenience wrapper for native event loops.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AppEventAdapter {
    platform: Platform,
    state: State,
}

impl AppEventAdapter {
    #[must_use]
    pub const fn new(platform: Platform) -> Self {
        Self {
            platform,
            state: State::Running,
        }
    }

    #[must_use]
    pub const fn with_state(platform: Platform, state: State) -> Self {
        Self { platform, state }
    }

    #[must_use]
    pub const fn platform(&self) -> Platform {
        self.platform
    }

    #[must_use]
    pub const fn state(&self) -> State {
        self.state
    }

    /// Reduce an event and retain its resulting lifecycle state.
    pub fn dispatch(&mut self, event: AppEvent) -> AppTransition {
        let transition = reduce(self.platform, self.state, event);
        self.state = transition.state;
        transition
    }

    /// Reduce an event without mutating the adapter.
    #[must_use]
    pub fn preview(&self, event: AppEvent) -> AppTransition {
        reduce(self.platform, self.state, event)
    }
}

/// Reduce one app event against one lifecycle state.
#[must_use]
pub fn reduce(platform: Platform, state: State, event: AppEvent) -> AppTransition {
    match event {
        AppEvent::Native(native) => reduce_native(platform, state, native),
        AppEvent::Host(notification) => reduce_host(state, notification),
        AppEvent::PeerClosed => lifecycle_transition(state, LifecycleEvent::TransportClosed),
        AppEvent::ShellDeadlineElapsed => {
            lifecycle_transition(state, LifecycleEvent::ShellDeadlineElapsed)
        }
    }
}

fn lifecycle_transition(state: State, event: LifecycleEvent) -> AppTransition {
    AppTransition::lifecycle(lifecycle::transition(state, event))
}

fn reduce_native(platform: Platform, state: State, event: NativeEvent) -> AppTransition {
    match event {
        NativeEvent::BeforeQuit { reason } => {
            let transition = lifecycle::transition(
                state,
                LifecycleEvent::ExitRequested {
                    code: Some(0),
                    reason,
                },
            );
            let prevented = !transition
                .actions
                .iter()
                .any(|action| matches!(action, LifecycleAction::PassThrough(_)));
            let mut result = AppTransition::lifecycle(transition);
            result
                .effects
                .push(Effect::BeforeQuitResponse { prevented });
            result
        }
        NativeEvent::LastWindowClosed => lifecycle_transition(
            state,
            LifecycleEvent::ExitRequested {
                code: None,
                reason: LifecycleQuitReason::LastWindow,
            },
        ),
        NativeEvent::Activate {
            has_visible_windows,
        } => {
            // tao's reopen/activate callback is meaningful on macOS.  On
            // Windows/Linux the host receives window-all-closed and decides
            // to quit; forwarding activation there could recreate a window
            // after an intentional quit.  Keep Other conservative too.
            if platform == Platform::Macos {
                AppTransition {
                    state,
                    effects: vec![Effect::NotifyActivate {
                        has_visible_windows,
                    }],
                }
            } else {
                AppTransition::unchanged(state)
            }
        }
    }
}

fn reduce_host(state: State, notification: HostNotification) -> AppTransition {
    match notification {
        HostNotification::Quit => lifecycle_transition(state, LifecycleEvent::HostAppQuit),
        HostNotification::Exit { code } => {
            lifecycle_transition(state, LifecycleEvent::HostAppExit { code })
        }
        HostNotification::Relaunch => lifecycle_transition(state, LifecycleEvent::HostAppRelaunch),
        HostNotification::UpdaterInstall { .. } => {
            lifecycle_transition(state, LifecycleEvent::UpdaterInstall)
        }
        HostNotification::ShutdownComplete => {
            lifecycle_transition(state, LifecycleEvent::HostShutdownComplete)
        }
        HostNotification::Focus { steal } => AppTransition {
            state,
            effects: vec![Effect::FocusMainWindow { steal }],
        },
    }
}

/// Parse a host-to-shell `app.*` notification into an app event.
///
/// Non-app notifications and app requests are rejected so the caller cannot
/// accidentally treat a different RPC method as a lifecycle signal.  The
/// transport remains responsible for validating the complete envelope before
/// calling this function.
pub fn host_notification(envelope: &RpcEnvelope) -> Result<AppEvent, DecodeError> {
    let notification = match envelope {
        RpcEnvelope::Notification(notification) => notification,
        RpcEnvelope::Request(_) => return Err(DecodeError::RequestNotNotification),
        RpcEnvelope::Response(_) => return Err(DecodeError::ResponseNotNotification),
    };
    decode_notification(notification).map(AppEvent::Host)
}

/// Decode one host notification.  This separate function is useful to peers
/// that already stripped the JSON-RPC envelope.
pub fn decode_notification(
    notification: &RpcNotification,
) -> Result<HostNotification, DecodeError> {
    match notification.method {
        RpcMethod::AppQuit => require_empty(notification, HostNotification::Quit),
        RpcMethod::AppExit => match notification.params.as_ref() {
            Some(RpcParams::AppExit(AppExitParams { code })) => {
                let code = i32::try_from(*code).map_err(|_| DecodeError::InvalidExitCode(*code))?;
                Ok(HostNotification::Exit { code })
            }
            _ => Err(DecodeError::InvalidParams(RpcMethod::AppExit)),
        },
        RpcMethod::AppRelaunch => require_empty(notification, HostNotification::Relaunch),
        RpcMethod::UpdaterInstall => match notification.params.as_ref() {
            Some(RpcParams::UpdaterInstall(UpdaterInstallParams { relaunch })) => {
                Ok(HostNotification::UpdaterInstall {
                    relaunch: *relaunch,
                })
            }
            _ => Err(DecodeError::InvalidParams(RpcMethod::UpdaterInstall)),
        },
        RpcMethod::AppFocus => match notification.params.as_ref() {
            Some(RpcParams::AppFocus(AppFocusParams { steal })) => {
                Ok(HostNotification::Focus { steal: *steal })
            }
            _ => Err(DecodeError::InvalidParams(RpcMethod::AppFocus)),
        },
        RpcMethod::AppShutdownComplete => {
            require_empty(notification, HostNotification::ShutdownComplete)
        }
        _ => Err(DecodeError::UnsupportedMethod(notification.method)),
    }
}

fn require_empty(
    notification: &RpcNotification,
    event: HostNotification,
) -> Result<HostNotification, DecodeError> {
    if matches!(notification.params, None | Some(RpcParams::Empty(_))) {
        Ok(event)
    } else {
        Err(DecodeError::InvalidParams(notification.method))
    }
}

/// Decode a shell-to-host `app.before-quit` request's parameters for callers
/// that need to record the request before dispatching the native event.
pub fn decode_before_quit(params: &RpcParams) -> Result<LifecycleQuitReason, DecodeError> {
    match params {
        RpcParams::AppBeforeQuit(AppBeforeQuitParams { reason }) => {
            Ok(protocol_reason_to_lifecycle(reason))
        }
        _ => Err(DecodeError::InvalidParams(RpcMethod::AppBeforeQuit)),
    }
}

/// Extract the host's synchronous `{prevented}` result for an
/// `app.before-quit` request.  JSON-RPC ids are intentionally left to the
/// peer's pending-request table; this function only validates the result.
pub fn decode_before_quit_result(response: &RpcResponse) -> Result<bool, DecodeError> {
    match response {
        RpcResponse::Success(success) => match &success.result {
            RpcResult::Prevented(result) => Ok(result.prevented),
            _ => Err(DecodeError::InvalidBeforeQuitResult),
        },
        RpcResponse::Error(_) => Err(DecodeError::BeforeQuitFailed),
    }
}

fn protocol_reason_to_lifecycle(reason: &crate::rpc::protocol::QuitReason) -> LifecycleQuitReason {
    match reason {
        crate::rpc::protocol::QuitReason::User => LifecycleQuitReason::User,
        crate::rpc::protocol::QuitReason::Menu => LifecycleQuitReason::Menu,
        crate::rpc::protocol::QuitReason::LastWindow => LifecycleQuitReason::LastWindow,
        crate::rpc::protocol::QuitReason::Host => LifecycleQuitReason::Host,
        crate::rpc::protocol::QuitReason::Updater => LifecycleQuitReason::Updater,
    }
}

/// Errors returned while decoding app-specific RPC messages.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecodeError {
    RequestNotNotification,
    ResponseNotNotification,
    UnsupportedMethod(RpcMethod),
    InvalidParams(RpcMethod),
    InvalidExitCode(i64),
    InvalidBeforeQuitResult,
    BeforeQuitFailed,
}

impl std::fmt::Display for DecodeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::RequestNotNotification => {
                formatter.write_str("app RPC request is not a notification")
            }
            Self::ResponseNotNotification => {
                formatter.write_str("app RPC response is not a notification")
            }
            Self::UnsupportedMethod(method) => {
                write!(formatter, "unsupported app RPC method: {method:?}")
            }
            Self::InvalidParams(method) => {
                write!(formatter, "invalid params for app RPC method: {method:?}")
            }
            Self::InvalidExitCode(code) => {
                write!(formatter, "app.exit code is outside i32 range: {code}")
            }
            Self::InvalidBeforeQuitResult => {
                formatter.write_str("app.before-quit result is not {prevented: bool}")
            }
            Self::BeforeQuitFailed => formatter.write_str("app.before-quit request failed"),
        }
    }
}

impl std::error::Error for DecodeError {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lifecycle::Continuation;
    use crate::rpc::protocol::{
        AppExitParams, AppFocusParams, EmptyParams, JsonRpcVersion, PreventedResult, RpcId,
        RpcRequest, RpcSuccessResponse, UpdaterInstallParams,
    };

    fn lifecycle_effects(result: &AppTransition) -> Vec<LifecycleAction> {
        result
            .effects
            .iter()
            .filter_map(|effect| match effect {
                Effect::Lifecycle(action) => Some(*action),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn native_quit_is_prevented_and_requests_host_shutdown() {
        let result = reduce(
            Platform::Linux,
            State::Running,
            AppEvent::Native(NativeEvent::BeforeQuit {
                reason: LifecycleQuitReason::User,
            }),
        );
        assert_eq!(
            result.state,
            State::QuitRequested {
                reason: LifecycleQuitReason::User,
                continuation: Continuation::Exit(0),
            }
        );
        assert_eq!(
            lifecycle_effects(&result),
            vec![
                LifecycleAction::PreventExit,
                LifecycleAction::BeforeQuit {
                    reason: LifecycleQuitReason::User,
                },
            ]
        );
        assert!(
            result
                .effects
                .contains(&Effect::BeforeQuitResponse { prevented: true })
        );
    }

    #[test]
    fn authorized_native_quit_is_not_prevented() {
        let state = State::ExitAuthorized {
            continuation: Continuation::Exit(0),
        };
        let result = reduce(
            Platform::Windows,
            state,
            AppEvent::Native(NativeEvent::BeforeQuit {
                reason: LifecycleQuitReason::User,
            }),
        );
        assert_eq!(result.state, state);
        assert_eq!(
            result.effects,
            vec![
                Effect::Lifecycle(LifecycleAction::PassThrough(Continuation::Exit(0))),
                Effect::BeforeQuitResponse { prevented: false },
            ]
        );
    }

    #[test]
    fn last_window_is_prevented_on_every_platform() {
        for platform in [
            Platform::Macos,
            Platform::Windows,
            Platform::Linux,
            Platform::Other,
        ] {
            let result = reduce(
                platform,
                State::Running,
                AppEvent::Native(NativeEvent::LastWindowClosed),
            );
            assert_eq!(result.state, State::Running);
            assert_eq!(
                lifecycle_effects(&result),
                vec![
                    LifecycleAction::PreventExit,
                    LifecycleAction::WindowAllClosed
                ]
            );
        }
    }

    #[test]
    fn only_macos_forwards_activate_without_recreating_gui_itself() {
        for platform in [Platform::Windows, Platform::Linux, Platform::Other] {
            assert_eq!(
                reduce(
                    platform,
                    State::Running,
                    AppEvent::Native(NativeEvent::Activate {
                        has_visible_windows: false,
                    })
                ),
                AppTransition::unchanged(State::Running)
            );
        }
        for has_visible_windows in [false, true] {
            assert_eq!(
                reduce(
                    Platform::Macos,
                    State::Running,
                    AppEvent::Native(NativeEvent::Activate {
                        has_visible_windows,
                    }),
                ),
                AppTransition {
                    state: State::Running,
                    effects: vec![Effect::NotifyActivate {
                        has_visible_windows
                    }],
                }
            );
        }
    }

    #[test]
    fn host_notifications_follow_lifecycle_continuations() {
        let requested = reduce(
            Platform::Linux,
            State::Running,
            AppEvent::Host(HostNotification::Quit),
        );
        assert_eq!(
            requested.state,
            State::QuitRequested {
                reason: LifecycleQuitReason::Host,
                continuation: Continuation::Exit(0),
            }
        );
        let shutting_down = reduce(
            Platform::Linux,
            requested.state,
            AppEvent::Host(HostNotification::Quit),
        );
        assert_eq!(
            shutting_down.state,
            State::HostShuttingDown {
                continuation: Continuation::Exit(0),
            }
        );
        let relaunch = reduce(
            Platform::Linux,
            State::Running,
            AppEvent::Host(HostNotification::Relaunch),
        );
        assert_eq!(
            relaunch.effects,
            vec![
                Effect::Lifecycle(LifecycleAction::TerminateManagedChildren),
                Effect::Lifecycle(LifecycleAction::Run(Continuation::Restart)),
            ]
        );
    }

    #[test]
    fn host_exit_and_focus_are_explicit_effects() {
        let exit = reduce(
            Platform::Linux,
            State::Running,
            AppEvent::Host(HostNotification::Exit { code: 75 }),
        );
        assert_eq!(
            exit.effects,
            vec![
                Effect::Lifecycle(LifecycleAction::TerminateManagedChildren),
                Effect::Lifecycle(LifecycleAction::Run(Continuation::Exit(75))),
            ]
        );
        assert_eq!(
            reduce(
                Platform::Linux,
                State::Running,
                AppEvent::Host(HostNotification::Focus { steal: true }),
            )
            .effects,
            vec![Effect::FocusMainWindow { steal: true }]
        );
    }

    #[test]
    fn updater_install_reduces_to_install_continuation_and_preserves_relaunch() {
        let notification = RpcNotification {
            jsonrpc: JsonRpcVersion::V2,
            method: RpcMethod::UpdaterInstall,
            params: Some(RpcParams::UpdaterInstall(UpdaterInstallParams {
                relaunch: true,
            })),
        };
        assert_eq!(
            decode_notification(&notification),
            Ok(HostNotification::UpdaterInstall { relaunch: true })
        );

        let result = reduce(
            Platform::Linux,
            State::Running,
            AppEvent::Host(HostNotification::UpdaterInstall { relaunch: true }),
        );
        assert_eq!(
            result.state,
            State::QuitRequested {
                reason: LifecycleQuitReason::Updater,
                continuation: Continuation::Install,
            }
        );
        assert_eq!(
            lifecycle_effects(&result),
            vec![
                LifecycleAction::PreventExit,
                LifecycleAction::BeforeQuit {
                    reason: LifecycleQuitReason::Updater,
                },
            ]
        );
    }

    #[test]
    fn updater_install_requires_typed_relaunch_params() {
        let base = RpcNotification {
            jsonrpc: JsonRpcVersion::V2,
            method: RpcMethod::UpdaterInstall,
            params: None,
        };
        assert_eq!(
            decode_notification(&base),
            Err(DecodeError::InvalidParams(RpcMethod::UpdaterInstall))
        );
        assert_eq!(
            decode_notification(&RpcNotification {
                params: Some(RpcParams::Empty(EmptyParams {})),
                ..base
            }),
            Err(DecodeError::InvalidParams(RpcMethod::UpdaterInstall))
        );
    }

    #[test]
    fn shutdown_complete_is_an_alternate_ack() {
        let requested = reduce(
            Platform::Linux,
            State::Running,
            AppEvent::Native(NativeEvent::BeforeQuit {
                reason: LifecycleQuitReason::Menu,
            }),
        );
        let result = reduce(
            Platform::Linux,
            requested.state,
            AppEvent::Host(HostNotification::ShutdownComplete),
        );
        assert_eq!(
            result.state,
            State::HostShuttingDown {
                continuation: Continuation::Exit(0),
            }
        );
        assert_eq!(
            lifecycle_effects(&result),
            vec![LifecycleAction::TerminateManagedChildren]
        );
    }

    #[test]
    fn peer_close_is_deterministic_and_fails_closed() {
        let result = reduce(Platform::Linux, State::Running, AppEvent::PeerClosed);
        assert_eq!(result.state, State::Failed);
        assert_eq!(
            result.effects,
            vec![
                Effect::Lifecycle(LifecycleAction::TerminateManagedChildren),
                Effect::Lifecycle(LifecycleAction::ShowHostError),
                Effect::Lifecycle(LifecycleAction::Run(Continuation::Exit(1))),
            ]
        );
    }

    #[test]
    fn peer_close_after_authorization_passes_through_once() {
        let state = State::ExitAuthorized {
            continuation: Continuation::Restart,
        };
        let result = reduce(Platform::Macos, state, AppEvent::PeerClosed);
        assert_eq!(result.state, state);
        assert_eq!(
            result.effects,
            vec![Effect::Lifecycle(LifecycleAction::PassThrough(
                Continuation::Restart,
            ))]
        );
    }

    #[test]
    fn decode_host_notifications_is_strict_and_total() {
        let empty = RpcNotification {
            jsonrpc: JsonRpcVersion::V2,
            method: RpcMethod::AppQuit,
            params: Some(RpcParams::Empty(EmptyParams {})),
        };
        assert_eq!(decode_notification(&empty), Ok(HostNotification::Quit));
        let missing = RpcNotification {
            params: None,
            ..empty.clone()
        };
        assert_eq!(decode_notification(&missing), Ok(HostNotification::Quit));
        let wrong = RpcNotification {
            method: RpcMethod::AppQuit,
            params: Some(RpcParams::AppFocus(AppFocusParams { steal: false })),
            ..empty.clone()
        };
        assert_eq!(
            decode_notification(&wrong),
            Err(DecodeError::InvalidParams(RpcMethod::AppQuit))
        );
        let exit = RpcNotification {
            method: RpcMethod::AppExit,
            params: Some(RpcParams::AppExit(AppExitParams { code: 75 })),
            ..empty.clone()
        };
        assert_eq!(
            decode_notification(&exit),
            Ok(HostNotification::Exit { code: 75 })
        );
        let bad_exit = RpcNotification {
            params: Some(RpcParams::AppExit(AppExitParams {
                code: i64::from(i32::MAX) + 1,
            })),
            ..exit
        };
        assert_eq!(
            decode_notification(&bad_exit),
            Err(DecodeError::InvalidExitCode(i64::from(i32::MAX) + 1))
        );
        for method in [RpcMethod::AppIsProtocolClient, RpcMethod::AppGetMetrics] {
            let unsupported = RpcNotification {
                method,
                params: None,
                ..empty.clone()
            };
            assert_eq!(
                decode_notification(&unsupported),
                Err(DecodeError::UnsupportedMethod(method))
            );
        }
    }

    #[test]
    fn envelope_decode_rejects_non_notifications() {
        let request = RpcEnvelope::Request(RpcRequest {
            jsonrpc: JsonRpcVersion::V2,
            id: 1 as RpcId,
            method: RpcMethod::AppQuit,
            params: None,
        });
        assert_eq!(
            host_notification(&request),
            Err(DecodeError::RequestNotNotification)
        );
        let response = RpcEnvelope::Response(RpcResponse::Success(Box::new(RpcSuccessResponse {
            jsonrpc: JsonRpcVersion::V2,
            id: 1,
            result: RpcResult::Empty(crate::rpc::protocol::EmptyResult {}),
        })));
        assert_eq!(
            host_notification(&response),
            Err(DecodeError::ResponseNotNotification)
        );
    }

    #[test]
    fn app_before_quit_params_and_result_round_trip() {
        for (wire, expected) in [
            (
                crate::rpc::protocol::QuitReason::User,
                LifecycleQuitReason::User,
            ),
            (
                crate::rpc::protocol::QuitReason::Menu,
                LifecycleQuitReason::Menu,
            ),
            (
                crate::rpc::protocol::QuitReason::LastWindow,
                LifecycleQuitReason::LastWindow,
            ),
            (
                crate::rpc::protocol::QuitReason::Host,
                LifecycleQuitReason::Host,
            ),
            (
                crate::rpc::protocol::QuitReason::Updater,
                LifecycleQuitReason::Updater,
            ),
        ] {
            assert_eq!(
                decode_before_quit(&RpcParams::AppBeforeQuit(AppBeforeQuitParams {
                    reason: wire,
                })),
                Ok(expected)
            );
        }
        let response = RpcResponse::Success(Box::new(RpcSuccessResponse {
            jsonrpc: JsonRpcVersion::V2,
            id: 7,
            result: RpcResult::Prevented(PreventedResult { prevented: true }),
        }));
        assert_eq!(decode_before_quit_result(&response), Ok(true));
        let wrong = RpcResponse::Success(Box::new(RpcSuccessResponse {
            jsonrpc: JsonRpcVersion::V2,
            id: 7,
            result: RpcResult::Empty(crate::rpc::protocol::EmptyResult {}),
        }));
        assert_eq!(
            decode_before_quit_result(&wrong),
            Err(DecodeError::InvalidBeforeQuitResult)
        );
        let failed = RpcResponse::Error(crate::rpc::protocol::RpcErrorResponse {
            jsonrpc: JsonRpcVersion::V2,
            id: crate::rpc::protocol::RequiredNullable(Some(7)),
            error: crate::rpc::protocol::RpcError {
                code: -32000,
                message: String::from("failed"),
                data: None,
            },
        });
        assert_eq!(
            decode_before_quit_result(&failed),
            Err(DecodeError::BeforeQuitFailed)
        );
    }

    #[test]
    fn adapter_dispatches_and_preview_does_not_mutate() {
        let mut adapter = AppEventAdapter::new(Platform::Linux);
        let preview = adapter.preview(AppEvent::Host(HostNotification::Relaunch));
        assert_eq!(adapter.state(), State::Running);
        assert_eq!(
            preview.state,
            State::ExitAuthorized {
                continuation: Continuation::Restart,
            }
        );
        let dispatched = adapter.dispatch(AppEvent::Host(HostNotification::Relaunch));
        assert_eq!(adapter.state(), dispatched.state);
        assert_eq!(adapter.platform(), Platform::Linux);
    }

    #[test]
    fn every_platform_and_event_pair_is_total() {
        let platforms = [
            Platform::Macos,
            Platform::Windows,
            Platform::Linux,
            Platform::Other,
        ];
        let states = [
            State::Running,
            State::Failed,
            State::ExitAuthorized {
                continuation: Continuation::Exit(0),
            },
            State::ExitAuthorized {
                continuation: Continuation::Restart,
            },
            State::HostShuttingDown {
                continuation: Continuation::Exit(0),
            },
            State::QuitRequested {
                reason: LifecycleQuitReason::User,
                continuation: Continuation::Exit(0),
            },
        ];
        let natives = [
            NativeEvent::BeforeQuit {
                reason: LifecycleQuitReason::User,
            },
            NativeEvent::LastWindowClosed,
            NativeEvent::Activate {
                has_visible_windows: false,
            },
        ];
        let hosts = [
            HostNotification::Quit,
            HostNotification::Exit { code: 0 },
            HostNotification::Relaunch,
            HostNotification::UpdaterInstall { relaunch: true },
            HostNotification::Focus { steal: false },
            HostNotification::ShutdownComplete,
        ];
        for platform in platforms {
            for state in states {
                for native in natives {
                    let _ = reduce(platform, state, AppEvent::Native(native));
                }
                for host in hosts {
                    let _ = reduce(platform, state, AppEvent::Host(host));
                }
                let _ = reduce(platform, state, AppEvent::PeerClosed);
            }
        }
    }
}
