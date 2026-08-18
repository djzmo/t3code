//! Pure shell/host lifecycle state machine.
//!
//! The native shell owns this state machine.  It deliberately has no Tauri,
//! process, or transport dependencies: callers apply the returned actions to
//! their platform integration and feed completion events back into
//! [`transition`].

use std::time::Duration;

/// The host gives its finalizers five seconds to complete.  The shell's
/// deadline is deliberately longer so a healthy host can finish first.
pub const HOST_HARD_EXIT_TIMEOUT: Duration = Duration::from_secs(5);
pub const SHELL_QUIT_DEADLINE: Duration = Duration::from_secs(10);

/// The continuation selected for an authorized shutdown.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Continuation {
    Exit(i32),
    Restart,
    Install,
}

/// The source/reason carried by the `app.before-quit` request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuitReason {
    User,
    Menu,
    LastWindow,
    Host,
    Updater,
}

/// Lifecycle states owned by the shell.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    Running,
    QuitRequested {
        reason: QuitReason,
        continuation: Continuation,
    },
    HostShuttingDown {
        continuation: Continuation,
    },
    ExitAuthorized {
        continuation: Continuation,
    },
    Failed,
}

/// Events observed at the shell/host boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Event {
    /// A native `ExitRequested` hook.  `None` is the last-window path and is
    /// always prevented; `Some` is an actual quit request.
    ExitRequested {
        code: Option<i32>,
        reason: QuitReason,
    },
    /// The host's `app.quit` notification.  The first one starts shutdown;
    /// the second one acknowledges that the host completed its shutdown.
    HostAppQuit,
    /// Explicit acknowledgement used by hosts that do not emit the second
    /// `app.quit` notification.
    HostShutdownComplete,
    HostAppExit {
        code: i32,
    },
    HostAppRelaunch,
    UpdaterInstall,
    /// The shell has terminated all managed residue after host shutdown.
    ResidueTerminated,
    /// The shell's ten-second deadline expired.
    ShellDeadlineElapsed,
    /// The host exited unexpectedly (including its five-second hard exit).
    HostDied,
    /// The host transport closed before an authorized continuation ran.
    TransportClosed,
}

/// Side effects requested by a transition.  The state machine never performs
/// these effects itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    /// Synchronously cancel the platform exit request.
    PreventExit,
    /// Send `app.before-quit` to the host.
    BeforeQuit { reason: QuitReason },
    /// Send `app.window-all-closed` to the host.
    WindowAllClosed,
    /// Terminate managed host children/residue.
    TerminateManagedChildren,
    /// Show the native unexpected-host-death error dialog.
    ShowHostError,
    /// Apply a continuation after it has been authorized.
    Run(Continuation),
    /// A platform exit hook arrived after authorization.  It must not be
    /// intercepted again.
    PassThrough(Continuation),
}

/// The result of one pure state transition.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Transition {
    pub state: State,
    pub actions: Vec<Action>,
}

impl Transition {
    fn new(state: State, actions: impl Into<Vec<Action>>) -> Self {
        Self {
            state,
            actions: actions.into(),
        }
    }

    fn unchanged(state: State) -> Self {
        Self::new(state, Vec::new())
    }
}

fn continuation_for(reason: QuitReason) -> Continuation {
    match reason {
        QuitReason::Updater => Continuation::Install,
        QuitReason::User | QuitReason::Menu | QuitReason::LastWindow | QuitReason::Host => {
            Continuation::Exit(0)
        }
    }
}

fn is_exit(continuation: Continuation) -> bool {
    matches!(continuation, Continuation::Exit(_))
}

fn direct_authorized(continuation: Continuation) -> Transition {
    Transition::new(
        State::ExitAuthorized { continuation },
        [Action::TerminateManagedChildren, Action::Run(continuation)],
    )
}

fn authorize_after_residue(continuation: Continuation) -> Transition {
    Transition::new(
        State::ExitAuthorized { continuation },
        [Action::Run(continuation)],
    )
}

fn failed() -> Transition {
    Transition::new(
        State::Failed,
        [
            Action::TerminateManagedChildren,
            Action::ShowHostError,
            Action::Run(Continuation::Exit(1)),
        ],
    )
}

fn last_window(state: State) -> Transition {
    match state {
        State::Running => Transition::new(
            State::Running,
            [Action::PreventExit, Action::WindowAllClosed],
        ),
        State::QuitRequested { .. } => {
            Transition::new(state, [Action::PreventExit, Action::WindowAllClosed])
        }
        State::HostShuttingDown { .. } | State::Failed => Transition::unchanged(state),
        State::ExitAuthorized { continuation } => {
            Transition::new(state, [Action::PassThrough(continuation)])
        }
    }
}

/// Apply one event to one lifecycle state.
///
/// Every `(State, Event)` pair is handled explicitly.  Repeated requests are
/// intentionally no-ops (coalesced), while an updater request may upgrade a
/// pending `Exit(_)` continuation to `Install`.
#[must_use]
pub fn transition(state: State, event: Event) -> Transition {
    match event {
        Event::ExitRequested { code: None, .. } => last_window(state),
        Event::ExitRequested {
            code: Some(_),
            reason,
        } => match state {
            State::Running => {
                let continuation = continuation_for(reason);
                Transition::new(
                    State::QuitRequested {
                        reason,
                        continuation,
                    },
                    [Action::PreventExit, Action::BeforeQuit { reason }],
                )
            }
            State::QuitRequested { .. } | State::HostShuttingDown { .. } | State::Failed => {
                Transition::unchanged(state)
            }
            State::ExitAuthorized { continuation } => {
                Transition::new(state, [Action::PassThrough(continuation)])
            }
        },

        Event::HostAppQuit => match state {
            State::Running => Transition::new(
                State::QuitRequested {
                    reason: QuitReason::Host,
                    continuation: Continuation::Exit(0),
                },
                [
                    Action::PreventExit,
                    Action::BeforeQuit {
                        reason: QuitReason::Host,
                    },
                ],
            ),
            State::QuitRequested { continuation, .. } => Transition::new(
                State::HostShuttingDown { continuation },
                [Action::TerminateManagedChildren],
            ),
            State::HostShuttingDown { .. } | State::Failed => Transition::unchanged(state),
            State::ExitAuthorized { continuation } => {
                Transition::new(state, [Action::PassThrough(continuation)])
            }
        },

        Event::HostShutdownComplete => match state {
            State::QuitRequested { continuation, .. } => Transition::new(
                State::HostShuttingDown { continuation },
                [Action::TerminateManagedChildren],
            ),
            State::Running | State::HostShuttingDown { .. } | State::Failed => {
                Transition::unchanged(state)
            }
            State::ExitAuthorized { continuation } => {
                Transition::new(state, [Action::PassThrough(continuation)])
            }
        },

        Event::HostAppExit { code } => match state {
            State::ExitAuthorized {
                continuation: Continuation::Restart,
            } => Transition::new(state, [Action::PassThrough(Continuation::Restart)]),
            _ => direct_authorized(Continuation::Exit(code)),
        },

        Event::HostAppRelaunch => match state {
            State::ExitAuthorized {
                continuation: Continuation::Restart,
            } => Transition::new(state, [Action::PassThrough(Continuation::Restart)]),
            _ => direct_authorized(Continuation::Restart),
        },

        Event::UpdaterInstall => match state {
            State::Running => Transition::new(
                State::QuitRequested {
                    reason: QuitReason::Updater,
                    continuation: Continuation::Install,
                },
                [
                    Action::PreventExit,
                    Action::BeforeQuit {
                        reason: QuitReason::Updater,
                    },
                ],
            ),
            State::QuitRequested { continuation, .. } if is_exit(continuation) => Transition::new(
                State::QuitRequested {
                    reason: QuitReason::Updater,
                    continuation: Continuation::Install,
                },
                Vec::new(),
            ),
            State::QuitRequested {
                reason,
                continuation,
            } => Transition::unchanged(State::QuitRequested {
                reason,
                continuation,
            }),
            State::HostShuttingDown { continuation } if is_exit(continuation) => Transition::new(
                State::HostShuttingDown {
                    continuation: Continuation::Install,
                },
                Vec::new(),
            ),
            State::HostShuttingDown { continuation } => {
                Transition::unchanged(State::HostShuttingDown { continuation })
            }
            State::ExitAuthorized { continuation } => {
                Transition::unchanged(State::ExitAuthorized { continuation })
            }
            State::Failed => Transition::unchanged(State::Failed),
        },

        Event::ResidueTerminated => match state {
            State::HostShuttingDown { continuation } => authorize_after_residue(continuation),
            State::Running
            | State::QuitRequested { .. }
            | State::ExitAuthorized { .. }
            | State::Failed => Transition::unchanged(state),
        },

        Event::ShellDeadlineElapsed => match state {
            State::QuitRequested { .. } | State::HostShuttingDown { .. } => {
                direct_authorized(Continuation::Exit(1))
            }
            State::ExitAuthorized { continuation } => {
                Transition::new(state, [Action::PassThrough(continuation)])
            }
            State::Running => failed(),
            State::Failed => Transition::unchanged(State::Failed),
        },

        Event::HostDied | Event::TransportClosed => match state {
            State::ExitAuthorized { continuation } => {
                Transition::new(state, [Action::PassThrough(continuation)])
            }
            State::Failed => Transition::unchanged(State::Failed),
            State::Running | State::QuitRequested { .. } | State::HostShuttingDown { .. } => {
                failed()
            }
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn all_states() -> Vec<State> {
        let continuations = [
            Continuation::Exit(0),
            Continuation::Exit(75),
            Continuation::Restart,
            Continuation::Install,
        ];
        let reasons = [
            QuitReason::User,
            QuitReason::Menu,
            QuitReason::LastWindow,
            QuitReason::Host,
            QuitReason::Updater,
        ];
        let mut states = vec![State::Running, State::Failed];
        states.extend(reasons.into_iter().flat_map(|reason| {
            continuations
                .into_iter()
                .map(move |continuation| State::QuitRequested {
                    reason,
                    continuation,
                })
        }));
        states.extend(
            continuations
                .into_iter()
                .map(|continuation| State::HostShuttingDown { continuation }),
        );
        states.extend(
            continuations
                .into_iter()
                .map(|continuation| State::ExitAuthorized { continuation }),
        );
        states
    }

    fn all_events() -> Vec<Event> {
        vec![
            Event::ExitRequested {
                code: Some(0),
                reason: QuitReason::User,
            },
            Event::ExitRequested {
                code: None,
                reason: QuitReason::LastWindow,
            },
            Event::HostAppQuit,
            Event::HostShutdownComplete,
            Event::HostAppExit { code: 0 },
            Event::HostAppRelaunch,
            Event::UpdaterInstall,
            Event::ResidueTerminated,
            Event::ShellDeadlineElapsed,
            Event::HostDied,
            Event::TransportClosed,
        ]
    }

    #[test]
    fn every_state_and_event_pair_is_total() {
        for state in all_states() {
            for event in all_events() {
                let result = transition(state, event);
                assert!(result.actions.len() <= 3);
            }
        }
    }

    #[test]
    fn normal_quit_waits_for_host_and_residue_before_authorizing_exit() {
        let requested = transition(
            State::Running,
            Event::ExitRequested {
                code: Some(0),
                reason: QuitReason::User,
            },
        );
        assert_eq!(
            requested.state,
            State::QuitRequested {
                reason: QuitReason::User,
                continuation: Continuation::Exit(0),
            }
        );
        assert_eq!(
            requested.actions,
            vec![
                Action::PreventExit,
                Action::BeforeQuit {
                    reason: QuitReason::User
                }
            ]
        );

        let shutting_down = transition(requested.state, Event::HostAppQuit);
        assert_eq!(
            shutting_down.state,
            State::HostShuttingDown {
                continuation: Continuation::Exit(0)
            }
        );
        assert_eq!(
            shutting_down.actions,
            vec![Action::TerminateManagedChildren]
        );

        let authorized = transition(shutting_down.state, Event::ResidueTerminated);
        assert_eq!(
            authorized.state,
            State::ExitAuthorized {
                continuation: Continuation::Exit(0)
            }
        );
        assert_eq!(authorized.actions, vec![Action::Run(Continuation::Exit(0))]);

        let pass_through = transition(
            authorized.state,
            Event::ExitRequested {
                code: Some(0),
                reason: QuitReason::User,
            },
        );
        assert_eq!(pass_through.state, authorized.state);
        assert_eq!(
            pass_through.actions,
            vec![Action::PassThrough(Continuation::Exit(0))]
        );
    }

    #[test]
    fn shutdown_complete_is_an_alternate_host_acknowledgement() {
        let requested = transition(
            State::Running,
            Event::ExitRequested {
                code: Some(0),
                reason: QuitReason::Menu,
            },
        );
        let shutting_down = transition(requested.state, Event::HostShutdownComplete);
        assert_eq!(
            shutting_down.state,
            State::HostShuttingDown {
                continuation: Continuation::Exit(0)
            }
        );
        assert_eq!(
            shutting_down.actions,
            vec![Action::TerminateManagedChildren]
        );
    }

    #[test]
    fn quit_during_a_turn_is_coalesced() {
        let first = transition(
            State::Running,
            Event::ExitRequested {
                code: Some(0),
                reason: QuitReason::User,
            },
        );
        let second = transition(
            first.state,
            Event::ExitRequested {
                code: Some(0),
                reason: QuitReason::Menu,
            },
        );
        assert_eq!(second.state, first.state);
        assert!(second.actions.is_empty());
    }

    #[test]
    fn updater_install_arms_install_and_upgrades_pending_exit() {
        let from_running = transition(State::Running, Event::UpdaterInstall);
        assert_eq!(
            from_running.state,
            State::QuitRequested {
                reason: QuitReason::Updater,
                continuation: Continuation::Install,
            }
        );
        assert_eq!(
            from_running.actions,
            vec![
                Action::PreventExit,
                Action::BeforeQuit {
                    reason: QuitReason::Updater
                }
            ]
        );

        let pending = transition(
            State::Running,
            Event::ExitRequested {
                code: Some(0),
                reason: QuitReason::User,
            },
        );
        let upgraded = transition(pending.state, Event::UpdaterInstall);
        assert_eq!(
            upgraded.state,
            State::QuitRequested {
                reason: QuitReason::Updater,
                continuation: Continuation::Install,
            }
        );
        assert!(upgraded.actions.is_empty());

        let shutting_down = transition(upgraded.state, Event::HostAppQuit);
        let authorized = transition(shutting_down.state, Event::ResidueTerminated);
        assert_eq!(
            authorized.state,
            State::ExitAuthorized {
                continuation: Continuation::Install
            }
        );
        assert_eq!(authorized.actions, vec![Action::Run(Continuation::Install)]);
    }

    #[test]
    fn updater_never_downgrades_restart() {
        let restart = State::HostShuttingDown {
            continuation: Continuation::Restart,
        };
        assert_eq!(transition(restart, Event::UpdaterInstall).state, restart);
        let authorized = State::ExitAuthorized {
            continuation: Continuation::Restart,
        };
        assert_eq!(
            transition(authorized, Event::UpdaterInstall).state,
            authorized
        );
    }

    #[test]
    fn relaunch_precedence_absorbs_exit_zero() {
        let relaunch = transition(State::Running, Event::HostAppRelaunch);
        assert_eq!(
            relaunch.state,
            State::ExitAuthorized {
                continuation: Continuation::Restart
            }
        );
        let exit = transition(relaunch.state, Event::HostAppExit { code: 0 });
        assert_eq!(exit.state, relaunch.state);
        assert_eq!(
            exit.actions,
            vec![Action::PassThrough(Continuation::Restart)]
        );
    }

    #[test]
    fn host_exit_code_is_preserved() {
        let exit = transition(State::Running, Event::HostAppExit { code: 75 });
        assert_eq!(
            exit.state,
            State::ExitAuthorized {
                continuation: Continuation::Exit(75)
            }
        );
        assert_eq!(
            exit.actions,
            vec![
                Action::TerminateManagedChildren,
                Action::Run(Continuation::Exit(75))
            ]
        );
    }

    #[test]
    fn last_window_is_always_prevented_and_not_a_quit() {
        let result = transition(
            State::Running,
            Event::ExitRequested {
                code: None,
                reason: QuitReason::LastWindow,
            },
        );
        assert_eq!(result.state, State::Running);
        assert_eq!(
            result.actions,
            vec![Action::PreventExit, Action::WindowAllClosed]
        );

        let pending = State::QuitRequested {
            reason: QuitReason::User,
            continuation: Continuation::Exit(0),
        };
        let result = transition(
            pending,
            Event::ExitRequested {
                code: None,
                reason: QuitReason::LastWindow,
            },
        );
        assert_eq!(result.state, pending);
        assert_eq!(
            result.actions,
            vec![Action::PreventExit, Action::WindowAllClosed]
        );
    }

    #[test]
    fn shell_deadline_forces_exit_one() {
        for state in [
            State::QuitRequested {
                reason: QuitReason::User,
                continuation: Continuation::Exit(0),
            },
            State::HostShuttingDown {
                continuation: Continuation::Exit(0),
            },
        ] {
            let result = transition(state, Event::ShellDeadlineElapsed);
            assert_eq!(
                result.state,
                State::ExitAuthorized {
                    continuation: Continuation::Exit(1)
                }
            );
            assert_eq!(
                result.actions,
                vec![
                    Action::TerminateManagedChildren,
                    Action::Run(Continuation::Exit(1))
                ]
            );
        }
    }

    #[test]
    fn unexpected_host_death_fails_closed() {
        for event in [Event::HostDied, Event::TransportClosed] {
            let result = transition(State::Running, event);
            assert_eq!(result.state, State::Failed);
            assert_eq!(
                result.actions,
                vec![
                    Action::TerminateManagedChildren,
                    Action::ShowHostError,
                    Action::Run(Continuation::Exit(1))
                ]
            );
        }
    }

    #[test]
    fn host_deadline_is_shorter_than_shell_deadline() {
        assert!(HOST_HARD_EXIT_TIMEOUT < SHELL_QUIT_DEADLINE);
        assert_eq!(HOST_HARD_EXIT_TIMEOUT.as_secs(), 5);
        assert_eq!(SHELL_QUIT_DEADLINE.as_secs(), 10);
    }
}
