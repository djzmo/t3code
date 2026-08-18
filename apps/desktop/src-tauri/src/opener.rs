//! Safe external URL validation for the native shell.
//!
//! The renderer validates URLs before it crosses the Tauri boundary, but the
//! native side is the final security boundary.  This module owns the second
//! validation pass and exposes a small opener trait so platform integrations
//! can be injected without coupling URL policy to a transport or OS API.

use std::fmt;

use thiserror::Error;

/// Schemes accepted by the upstream Electron shell implementation.
///
/// The remote editor schemes are derived from the contracts editor registry:
/// Cursor, VS Code, VS Code Insiders, and VSCodium.  Keep this list in sync
/// with `apps/desktop/src/electron/ElectronShell.ts`.
pub const SAFE_EXTERNAL_SCHEMES: [&str; 6] = [
    "http",
    "https",
    "cursor",
    "vscode",
    "vscode-insiders",
    "vscodium",
];

/// A URL that has passed the native external-open policy.
///
/// The contained string is the URL-standard serialization, equivalent to the
/// `href` returned by the browser `URL` constructor used by ElectronShell.
/// Its field is private so callers cannot construct an unvalidated value.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SafeExternalUrl(String);

impl SafeExternalUrl {
    /// Return the normalized URL to hand to a platform opener.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Consume the validated URL and return its normalized string.
    #[must_use]
    pub fn into_string(self) -> String {
        self.0
    }
}

impl AsRef<str> for SafeExternalUrl {
    fn as_ref(&self) -> &str {
        self.as_str()
    }
}

impl fmt::Display for SafeExternalUrl {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// Why an external URL was rejected before it reached the OS.
#[derive(Clone, Copy, Debug, Eq, Error, PartialEq)]
pub enum ExternalUrlError {
    #[error("external URL is malformed")]
    Malformed,
    #[error("external URL scheme is not allow-listed")]
    DisallowedScheme,
}

/// Validate and normalize one external URL.
///
/// Parsing uses Tauri's re-export of the WHATWG URL implementation, which
/// gives the native boundary the same scheme and serialization semantics as
/// the renderer's `new URL(rawUrl)`.  Only HTTP(S) and the four remote-editor
/// schemes are accepted; all other schemes are rejected after parsing.
pub fn validate_external_url(raw_url: &str) -> Result<SafeExternalUrl, ExternalUrlError> {
    let url = tauri::Url::parse(raw_url).map_err(|_| ExternalUrlError::Malformed)?;
    if !is_safe_external_scheme(url.scheme()) {
        return Err(ExternalUrlError::DisallowedScheme);
    }

    Ok(SafeExternalUrl(url.to_string()))
}

/// Option-shaped validator for callers that only need the upstream
/// `parseSafeExternalUrl`-style yes/no result.
#[must_use]
pub fn parse_safe_external_url(raw_url: &str) -> Option<SafeExternalUrl> {
    validate_external_url(raw_url).ok()
}

/// Return whether a URL scheme is in the external-open allow-list.
#[must_use]
pub fn is_safe_external_scheme(scheme: &str) -> bool {
    SAFE_EXTERNAL_SCHEMES
        .iter()
        .any(|candidate| candidate.eq_ignore_ascii_case(scheme))
}

/// Transport/OS boundary implemented by a platform-specific opener.
///
/// Implementations receive [`SafeExternalUrl`] rather than an arbitrary
/// string.  The only public entry point that invokes this method is
/// [`open_external`], which performs the native validation immediately before
/// dispatching the request.
pub trait ExternalOpener {
    type Error;

    /// Open a URL that has already passed [`validate_external_url`].
    fn open_validated(&self, url: &SafeExternalUrl) -> Result<(), Self::Error>;
}

/// Error returned by [`open_external`] when validation or transport fails.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum OpenExternalError<E> {
    #[error("external URL rejected: {0}")]
    Rejected(#[from] ExternalUrlError),
    #[error("external opener transport failed")]
    Transport(E),
}

/// Re-validate `raw_url` and dispatch it through an injected opener.
///
/// This function is intentionally independent of Tauri commands and OS APIs;
/// a caller can adapt it to `shell.openExternal`, a test double, or another
/// transport while preserving the native URL policy.
pub fn open_external<O>(opener: &O, raw_url: &str) -> Result<(), OpenExternalError<O::Error>>
where
    O: ExternalOpener + ?Sized,
{
    let safe_url = validate_external_url(raw_url)?;
    opener
        .open_validated(&safe_url)
        .map_err(OpenExternalError::Transport)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[test]
    fn normalizes_http_and_https_like_url_href() {
        let http = validate_external_url("HTTP://EXAMPLE.COM/path");
        assert_eq!(
            http,
            Ok(SafeExternalUrl("http://example.com/path".to_owned()))
        );

        let https = validate_external_url("https://example.com");
        assert_eq!(
            https,
            Ok(SafeExternalUrl("https://example.com/".to_owned()))
        );
    }

    #[test]
    fn preserves_every_allow_listed_remote_editor_scheme() {
        for scheme in ["cursor", "vscode", "vscode-insiders", "vscodium"] {
            let raw = format!("{scheme}://vscode-remote/ssh-remote+dev/workspace");
            let parsed = validate_external_url(&raw);

            assert_eq!(parsed.map(|url| url.into_string()), Ok(raw));
        }
    }

    #[test]
    fn rejects_malformed_and_disallowed_urls() {
        for raw in [
            "",
            "not a URL",
            "https://",
            "https://[not-an-ip]",
            "file:///private/secret",
            "javascript:alert(1)",
            "data:text/plain,secret",
            "blob:https://example.com/id",
            "agent-nanoni://callback",
            "custom+scheme://payload",
        ] {
            assert!(validate_external_url(raw).is_err(), "{raw}");
            assert!(parse_safe_external_url(raw).is_none(), "{raw}");
        }
    }

    #[test]
    fn option_validator_matches_result_validator() {
        let accepted = "https://example.com/path?q=1";
        assert_eq!(
            parse_safe_external_url(accepted),
            validate_external_url(accepted).ok()
        );
    }

    struct FakeOpener {
        calls: RefCell<Vec<String>>,
        result: Result<(), &'static str>,
    }

    impl ExternalOpener for FakeOpener {
        type Error = &'static str;

        fn open_validated(&self, url: &SafeExternalUrl) -> Result<(), Self::Error> {
            self.calls.borrow_mut().push(url.to_string());
            self.result
        }
    }

    #[test]
    fn opener_revalidates_before_invoking_transport() {
        let opener = FakeOpener {
            calls: RefCell::new(Vec::new()),
            result: Ok(()),
        };

        let rejected = open_external(&opener, "file:///private/secret");
        assert_eq!(
            rejected,
            Err(OpenExternalError::Rejected(
                ExternalUrlError::DisallowedScheme
            ))
        );
        assert!(opener.calls.borrow().is_empty());

        let accepted = open_external(&opener, "https://example.com");
        assert_eq!(accepted, Ok(()));
        assert_eq!(opener.calls.borrow().as_slice(), ["https://example.com/"]);
    }

    #[test]
    fn opener_propagates_transport_failure_after_validation() {
        let opener = FakeOpener {
            calls: RefCell::new(Vec::new()),
            result: Err("shell unavailable"),
        };

        let result = open_external(&opener, "vscode://vscode-remote/ssh-remote+dev/workspace");
        assert_eq!(
            result,
            Err(OpenExternalError::Transport("shell unavailable"))
        );
        assert_eq!(
            opener.calls.borrow().as_slice(),
            ["vscode://vscode-remote/ssh-remote+dev/workspace"]
        );
    }
}
