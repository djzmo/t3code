//! macOS `applicationShouldTerminate:` hook and cross-platform install stub.
//!
//! On macOS, Cmd+Q and Dock Quit often bypass Tauri's `RunEvent::ExitRequested`.
//! The hook forwards those requests into the same lifecycle path as the Tauri
//! exit handler. Other platforms compile a no-op [`install`].

use std::fmt::{Display, Formatter};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};

use crate::app_events::{AppEvent, NativeEvent};
use crate::lifecycle::QuitReason;

/// Cocoa's synchronous terminate decision derived from lifecycle reduction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminateReply {
    /// Cancel this terminate request.  Cocoa must not receive `TerminateLater`
    /// unless the hook later calls `replyToApplicationShouldTerminate:`.
    Cancel,
    /// Allow Cocoa to proceed with termination immediately.
    Now,
}

/// Returns `true` when the lifecycle requested `PreventExit` / `{ prevented: true }`.
pub type BeforeQuitHandler = Arc<dyn Fn() -> bool + Send + Sync>;

static INSTALLED: AtomicBool = AtomicBool::new(false);
static HANDLER: OnceLock<BeforeQuitHandler> = OnceLock::new();

/// Errors returned while installing the terminate hook.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallError {
    AlreadyInstalled,
    HookFailed,
}

impl Display for InstallError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::AlreadyInstalled => formatter.write_str("terminate hook is already installed"),
            Self::HookFailed => {
                formatter.write_str("failed to install macOS applicationShouldTerminate hook")
            }
        }
    }
}

impl std::error::Error for InstallError {}

/// Maps lifecycle prevention into Cocoa's terminate reply.
#[must_use]
pub const fn terminate_reply_for_prevent(prevent: bool) -> TerminateReply {
    if prevent {
        TerminateReply::Cancel
    } else {
        TerminateReply::Now
    }
}

/// The native quit event used for Cmd+Q / Dock Quit on macOS.
#[must_use]
pub fn before_quit_event() -> AppEvent {
    AppEvent::Native(NativeEvent::BeforeQuit {
        reason: QuitReason::User,
    })
}

/// Installs the platform terminate hook once.
///
/// On macOS this adds `applicationShouldTerminate:` to tao's app delegate class.
/// On other platforms this stores the handler and returns `Ok(())` so callers can
/// share one setup path. A failed Objective-C attach does not latch the install
/// flags, so the caller can retry.
pub fn install(handler: BeforeQuitHandler) -> Result<(), InstallError> {
    install_with(handler, attach_platform_hook)
}

fn attach_platform_hook() -> Result<(), InstallError> {
    #[cfg(all(target_os = "macos", not(test)))]
    install_application_should_terminate_hook()?;
    Ok(())
}

fn install_with(
    handler: BeforeQuitHandler,
    attach: impl FnOnce() -> Result<(), InstallError>,
) -> Result<(), InstallError> {
    if INSTALLED.swap(true, Ordering::AcqRel) {
        return Err(InstallError::AlreadyInstalled);
    }
    if let Err(error) = attach() {
        INSTALLED.store(false, Ordering::Release);
        return Err(error);
    }
    if HANDLER.set(handler).is_err() {
        INSTALLED.store(false, Ordering::Release);
        return Err(InstallError::AlreadyInstalled);
    }
    Ok(())
}

#[cfg(all(target_os = "macos", not(test)))]
fn install_application_should_terminate_hook() -> Result<(), InstallError> {
    imp::install_application_should_terminate_hook()
}

#[cfg(all(target_os = "macos", not(test)))]
#[allow(
    unsafe_code,
    clippy::undocumented_unsafe_blocks,
    reason = "macOS terminate hook is the only crate-local Objective-C runtime surface"
)]
mod imp {
    use std::ffi::CStr;

    use objc2::ffi::class_addMethod;
    use objc2::runtime::{AnyClass, AnyObject, Bool, Imp, Sel};
    use objc2::sel;
    use objc2_app_kit::NSApplicationTerminateReply;

    use super::{HANDLER, InstallError, TerminateReply, terminate_reply_for_prevent};

    pub(super) fn install_application_should_terminate_hook() -> Result<(), InstallError> {
        let class = delegate_class().ok_or(InstallError::HookFailed)?;
        let selector = sel!(applicationShouldTerminate:);
        unsafe {
            // `class_addMethod` succeeds only when this class does not already
            // define the selector, including when a parent implements it.
            // tao's `TaoAppDelegateParent` does not, so this is the leaf add.
            let types = CStr::from_bytes_with_nul(b"Q@:@\0").expect("static method types");
            let added = class_addMethod(
                class as *mut _,
                selector,
                application_should_terminate as Imp,
                types.as_ptr(),
            );
            if Bool::new(added).as_bool() {
                return Ok(());
            }

            let method = class
                .instance_method(selector)
                .ok_or(InstallError::HookFailed)?;
            let _previous = method.set_implementation(application_should_terminate as Imp);
        }
        Ok(())
    }

    fn delegate_class() -> Option<&'static AnyClass> {
        use objc2::MainThreadMarker;
        use objc2_app_kit::NSApplication;

        let mtm = MainThreadMarker::new()?;
        let app = NSApplication::sharedApplication(mtm);
        let delegate = app.delegate()?;
        Some(delegate.class())
    }

    extern "C-unwind" fn application_should_terminate(
        _this: *mut AnyObject,
        _selector: Sel,
        _sender: *mut AnyObject,
    ) -> usize {
        let prevent = HANDLER.get().map(|handler| handler()).unwrap_or(true);
        match terminate_reply_for_prevent(prevent) {
            TerminateReply::Cancel => NSApplicationTerminateReply::TerminateCancel.0 as usize,
            TerminateReply::Now => NSApplicationTerminateReply::TerminateNow.0 as usize,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminate_reply_maps_prevention_to_cancel_and_authorization_to_now() {
        assert_eq!(terminate_reply_for_prevent(true), TerminateReply::Cancel);
        assert_eq!(terminate_reply_for_prevent(false), TerminateReply::Now);
    }

    #[test]
    fn before_quit_event_uses_user_reason() {
        assert_eq!(
            before_quit_event(),
            AppEvent::Native(NativeEvent::BeforeQuit {
                reason: QuitReason::User,
            })
        );
    }

    #[test]
    fn install_retries_after_hook_failure_then_rejects_a_second_success() {
        let handler: BeforeQuitHandler = Arc::new(|| false);
        if INSTALLED.load(Ordering::Acquire) {
            assert_eq!(
                install(Arc::clone(&handler)),
                Err(InstallError::AlreadyInstalled)
            );
            return;
        }
        assert_eq!(
            install_with(Arc::clone(&handler), || Err(InstallError::HookFailed)),
            Err(InstallError::HookFailed)
        );
        assert!(install(Arc::clone(&handler)).is_ok());
        assert_eq!(
            install(Arc::new(|| false) as BeforeQuitHandler),
            Err(InstallError::AlreadyInstalled)
        );
    }
}
