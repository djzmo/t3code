//! Shared, lock-scoped lifecycle reduction for native and host event sources.
//!
//! The native shell may receive a quit callback on a thread that does not own
//! the host dispatcher.  [`LifecycleGate`] is the one shared piece of mutable
//! state those paths need.  It deliberately only protects the pure reducer;
//! callers apply returned effects after this module releases its mutex.

use std::fmt::{Display, Formatter};
use std::sync::{Arc, Mutex, TryLockError};

use crate::app_events::{AppEvent, AppEventAdapter, AppTransition, Effect, NativeEvent, Platform};
use crate::lifecycle::{self, Action as LifecycleAction, Continuation, QuitReason, State};

/// A clonable handle that can be shared with native callbacks.
pub type SharedLifecycleGate = Arc<LifecycleGate>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct GateState {
    adapter: AppEventAdapter,
}

/// Errors returned when the lifecycle state cannot be reduced safely.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LifecycleGateError {
    /// Another thread currently owns the gate for a non-blocking read.
    Busy,
    /// A thread panicked while holding the gate mutex.
    Poisoned,
}

impl Display for LifecycleGateError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Busy => formatter.write_str("lifecycle gate is busy"),
            Self::Poisoned => formatter.write_str("lifecycle gate lock is poisoned"),
        }
    }
}

impl std::error::Error for LifecycleGateError {}

/// The synchronous decision made for a native quit callback.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeQuitDecision {
    /// Keep the native event loop alive while the host shuts down.
    Cancel,
    /// Allow the already-authorized continuation through the native loop.
    Now(Continuation),
}

/// Pure lifecycle work produced by a native quit callback.
///
/// `transition` is present only when the reducer succeeded.  The caller may
/// apply its effects after returning from [`LifecycleGate::native_quit`]; no
/// platform, broker, or Tauri operation is performed by the gate itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeQuitPlan {
    pub decision: NativeQuitDecision,
    /// The host request to send, if this quit started a new shutdown.
    pub before_quit: Option<QuitReason>,
    pub transition: Option<AppTransition>,
    /// Present only for a fail-closed `Cancel` plan produced by a lock error.
    pub error: Option<LifecycleGateError>,
}

impl NativeQuitPlan {
    fn from_transition(transition: AppTransition) -> Self {
        let mut decision = NativeQuitDecision::Cancel;
        let mut before_quit = None;
        for effect in &transition.effects {
            match effect {
                Effect::Lifecycle(LifecycleAction::PassThrough(continuation)) => {
                    decision = NativeQuitDecision::Now(*continuation);
                }
                Effect::Lifecycle(LifecycleAction::BeforeQuit { reason }) => {
                    before_quit = Some(*reason);
                }
                _ => {}
            }
        }
        Self {
            decision,
            before_quit,
            transition: Some(transition),
            error: None,
        }
    }

    fn fail_closed(error: LifecycleGateError) -> Self {
        Self {
            decision: NativeQuitDecision::Cancel,
            before_quit: None,
            transition: None,
            error: Some(error),
        }
    }

    /// Returns whether the native callback must synchronously prevent exit.
    #[must_use]
    pub const fn prevents_exit(&self) -> bool {
        matches!(self.decision, NativeQuitDecision::Cancel)
    }
}

/// Shared lifecycle reducer state.
#[derive(Debug)]
pub struct LifecycleGate {
    state: Mutex<GateState>,
}

impl LifecycleGate {
    /// Creates a running gate for the given target platform.
    #[must_use]
    pub fn new(platform: Platform) -> Self {
        Self {
            state: Mutex::new(GateState {
                adapter: AppEventAdapter::new(platform),
            }),
        }
    }

    /// Creates a gate with an existing lifecycle state for compatibility with
    /// reducers that persisted the state outside the dispatcher.
    #[must_use]
    pub fn with_state(platform: Platform, state: State) -> Self {
        Self {
            state: Mutex::new(GateState {
                adapter: AppEventAdapter::with_state(platform, state),
            }),
        }
    }

    /// Returns an `Arc` suitable for native callbacks and host dispatchers.
    #[must_use]
    pub fn shared(platform: Platform) -> SharedLifecycleGate {
        Arc::new(Self::new(platform))
    }

    /// Reads state, failing closed when the mutex is poisoned.
    #[must_use]
    pub fn state(&self) -> State {
        match self.try_state() {
            Ok(state) => state,
            Err(_) => State::Failed,
        }
    }

    /// Reads state without blocking.  This is useful for proving that effect
    /// application does not retain the lifecycle mutex.
    pub fn try_state(&self) -> Result<State, LifecycleGateError> {
        match self.state.try_lock() {
            Ok(guard) => Ok(guard.adapter.state()),
            Err(TryLockError::Poisoned(_)) => Err(LifecycleGateError::Poisoned),
            Err(TryLockError::WouldBlock) => Err(LifecycleGateError::Busy),
        }
    }

    /// Reads the configured target platform, conservatively returning `Other`
    /// when the gate cannot be read.
    #[must_use]
    pub fn platform(&self) -> Platform {
        match self.state.lock() {
            Ok(guard) => guard.adapter.platform(),
            Err(_) => Platform::Other,
        }
    }

    /// Reduces one event while holding the mutex only for the pure state
    /// update.  The returned transition must be applied by the caller after
    /// this method returns.
    pub fn reduce(&self, event: AppEvent) -> Result<AppTransition, LifecycleGateError> {
        let mut guard = self
            .state
            .lock()
            .map_err(|_| LifecycleGateError::Poisoned)?;
        Ok(guard.adapter.dispatch(event))
    }

    /// Feeds managed-child teardown completion back into the reducer.
    pub fn residue_terminated(&self) -> Result<AppTransition, LifecycleGateError> {
        let mut guard = self
            .state
            .lock()
            .map_err(|_| LifecycleGateError::Poisoned)?;
        let transition =
            lifecycle::transition(guard.adapter.state(), lifecycle::Event::ResidueTerminated);
        guard.adapter = AppEventAdapter::with_state(guard.adapter.platform(), transition.state);
        Ok(AppTransition {
            state: transition.state,
            effects: transition
                .actions
                .into_iter()
                .map(Effect::Lifecycle)
                .collect(),
        })
    }

    /// Reduces a native quit synchronously and returns a fail-closed plan.
    ///
    /// A poisoned gate cannot prove that exit was authorized, so the returned
    /// plan is always `Cancel` and carries the error for logging/telemetry.
    #[must_use]
    pub fn native_quit(&self, reason: QuitReason) -> NativeQuitPlan {
        match self.reduce(AppEvent::Native(NativeEvent::BeforeQuit { reason })) {
            Ok(transition) => NativeQuitPlan::from_transition(transition),
            Err(error) => NativeQuitPlan::fail_closed(error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_events::HostNotification;

    #[test]
    fn repeated_native_quits_are_coalesced_until_authorization() {
        let gate = LifecycleGate::new(Platform::Linux);
        let first = gate.native_quit(QuitReason::User);
        assert_eq!(first.decision, NativeQuitDecision::Cancel);
        assert_eq!(first.before_quit, Some(QuitReason::User));
        let second = gate.native_quit(QuitReason::Menu);
        assert_eq!(second.decision, NativeQuitDecision::Cancel);
        assert_eq!(second.before_quit, None);
        assert_eq!(
            gate.state(),
            State::QuitRequested {
                reason: QuitReason::User,
                continuation: Continuation::Exit(0),
            }
        );
    }

    #[test]
    fn authorized_native_quit_returns_now_without_before_quit() {
        let gate = LifecycleGate::new(Platform::Linux);
        let _ = gate.reduce(AppEvent::Host(HostNotification::Relaunch));
        let plan = gate.native_quit(QuitReason::User);
        assert_eq!(
            plan.decision,
            NativeQuitDecision::Now(Continuation::Restart)
        );
        assert_eq!(plan.before_quit, None);
        assert!(plan.error.is_none());
    }

    #[test]
    fn poisoned_gate_fails_closed() {
        let gate = Arc::new(LifecycleGate::new(Platform::Linux));
        let poisoned = Arc::clone(&gate);
        let _ = std::thread::spawn(move || {
            let _guard = poisoned.state.lock().expect("test lock should succeed");
            panic!("poison lifecycle gate for test");
        })
        .join();
        let plan = gate.native_quit(QuitReason::User);
        assert_eq!(plan.decision, NativeQuitDecision::Cancel);
        assert_eq!(plan.error, Some(LifecycleGateError::Poisoned));
        assert!(plan.transition.is_none());
    }

    #[test]
    fn state_read_is_available_after_reduction_lock_is_released() {
        let gate = Arc::new(LifecycleGate::new(Platform::Linux));
        let transition = gate
            .reduce(AppEvent::Host(HostNotification::Relaunch))
            .expect("pure reduction should succeed");
        assert_eq!(
            transition.state,
            State::ExitAuthorized {
                continuation: Continuation::Restart,
            }
        );
        assert_eq!(gate.try_state(), Ok(transition.state));
    }
}
