//! Native Paperclip window, and the NIP-98 signer it needs.
//!
//! **Why a window rather than an embedded frame.** The app's CSP declares no
//! `frame-src`, so `frame-src` falls back to `default-src 'self'` and an iframe
//! pointing at Paperclip's origin is refused in a packaged build. The policy is
//! only enforced on assets Tauri itself serves, which is exactly why neither
//! `just dev` nor the Playwright suite can catch it. A separate webview loads
//! the remote origin directly, so the app policy does not apply to it and
//! Paperclip's UI gets a real browser context instead of a framed approximation.
//!
//! **Sign-in.** Paperclip authenticates a Nostr identity with NIP-98, so this
//! module injects a NIP-07-compatible `window.nostr` into the Paperclip webview.
//! The page can ask for the public key and for a signature; the secret key never
//! leaves the Rust process.
//!
//! **Who gets the signer.** Tauri grants IPC to a remote origin only when a
//! capability lists that origin, so the `nip07` commands are granted solely by
//! `capabilities/paperclip-nip07.json`, which admits the managed loopback
//! instance (`http://127.0.0.1:*`, `http://localhost:*`) and nothing else. A
//! hosted HTTPS Paperclip therefore opens with no signer, which is the
//! conservative default: an https-wide pattern would hand a signing capability
//! to any page the window later navigated to. A bracketed IPv6 literal cannot be
//! expressed as a Tauri URL pattern, so a v6-only instance also opens without
//! the signer, and the window itself still opens because loopback is allowed.
//!
//! **What the signer will and will not sign.** An injected `window.nostr` is a
//! capability handed to whatever that webview loads, so the signer is narrowed
//! to exactly what sign-in needs: a kind-27235 authentication event, carrying a
//! URL tag for an http(s) origin, a method tag, and nothing but the tags NIP-98
//! defines. It cannot be used to sign a message, a reaction, or a relay
//! authentication event as the user.

use nostr::JsonUtil;
use serde::{Deserialize, Serialize};
use tauri::{Manager, PhysicalPosition, PhysicalSize, State, WebviewUrl, WebviewWindowBuilder};

use crate::app_state::AppState;

/// Label of the Paperclip window. Also the label the capability file must admit.
pub const PAPERCLIP_WINDOW_LABEL: &str = "paperclip";

/// NIP-98: HTTP authentication.
const KIND_NIP98: u16 = 27235;

/// Tag names a NIP-98 authentication event may carry.
const ALLOWED_TAGS: [&str; 4] = ["u", "method", "nonce", "payload"];

/// Whether a URL may be opened in the Paperclip window.
///
/// Loopback over plain HTTP is the managed local instance; HTTPS is a hosted
/// community instance. Anything else — a file URL, a non-HTTP scheme, or plain
/// HTTP to a remote host — is refused, so the window can only ever show
/// Paperclip over a transport we would accept for a credential.
pub(crate) fn paperclip_window_url_is_allowed(url: &str) -> bool {
    let trimmed = url.trim();
    if let Some(rest) = trimmed.strip_prefix("https://") {
        return !rest.is_empty() && !rest.starts_with('/');
    }
    if let Some(rest) = trimmed.strip_prefix("http://") {
        let authority = rest.split('/').next().unwrap_or_default();
        // A bracketed IPv6 literal contains colons, so the port separator can
        // only be searched outside the brackets.
        let host = match authority.find(']') {
            Some(end) => &authority[..=end],
            None => authority.split(':').next().unwrap_or_default(),
        };
        return matches!(host, "127.0.0.1" | "localhost" | "[::1]" | "::1");
    }
    false
}

/// Whether a NIP-98 `u` tag names a URL on the same origin as the page asking
/// for the signature.
///
/// Without this the shim would mint authentication credentials for *any* origin
/// a page named, which is a token the page could then present elsewhere. Binding
/// it to the origin the webview is actually showing keeps the signature local to
/// the instance the user opened.
pub(crate) fn nip98_url_is_on_page_origin(url_tag: &str, page_url: &str) -> bool {
    let Ok(target) = tauri::Url::parse(url_tag.trim()) else {
        return false;
    };
    let Ok(page) = tauri::Url::parse(page_url.trim()) else {
        return false;
    };
    target.scheme() == page.scheme()
        && target.host_str() == page.host_str()
        && target.port_or_known_default() == page.port_or_known_default()
}

/// Validate that an event is a NIP-98 authentication request and nothing else.
#[cfg(test)]
pub(crate) fn validate_nip98_request(
    kind: u16,
    content: &str,
    tags: &[Vec<String>],
) -> Result<(), String> {
    validate_nip98_request_for_page(kind, content, tags, None)
}

/// As [`validate_nip98_request`], and when `page_url` is known the `u` tag must
/// be on that origin.
pub(crate) fn validate_nip98_request_for_page(
    kind: u16,
    content: &str,
    tags: &[Vec<String>],
    page_url: Option<&str>,
) -> Result<(), String> {
    if kind != KIND_NIP98 {
        return Err(format!(
            "refusing to sign kind {kind}: this signer only signs NIP-98 authentication (kind {KIND_NIP98})"
        ));
    }
    if !content.is_empty() {
        return Err("a NIP-98 authentication event must have empty content".to_string());
    }
    let mut has_url = false;
    let mut has_method = false;
    for tag in tags {
        let name = tag.first().map(String::as_str).unwrap_or_default();
        if !ALLOWED_TAGS.contains(&name) {
            return Err(format!("tag `{name}` is not part of a NIP-98 request"));
        }
        let value = tag.get(1).map(String::as_str).unwrap_or_default();
        match name {
            "u" => {
                if !(value.starts_with("http://") || value.starts_with("https://")) {
                    return Err(format!("`u` tag must be an http(s) URL, got `{value}`"));
                }
                if let Some(page_url) = page_url {
                    if !nip98_url_is_on_page_origin(value, page_url) {
                        return Err(format!(
                            "refusing to sign a credential for `{value}`: it is not on the origin                              this window is showing"
                        ));
                    }
                }
                has_url = true;
            }
            "method" => {
                if value.trim().is_empty() {
                    return Err("`method` tag must not be empty".to_string());
                }
                has_method = true;
            }
            _ => {}
        }
    }
    if !has_url {
        return Err("a NIP-98 request needs a `u` tag naming the request URL".to_string());
    }
    if !has_method {
        return Err("a NIP-98 request needs a `method` tag".to_string());
    }
    Ok(())
}

/// Script injected into the Paperclip webview, exposing a NIP-07 signer.
///
/// Kept small and dependency-free: it uses the IPC object Tauri installs in
/// every webview it creates, so it needs no bundler and no page cooperation.
///
/// Rejections are wrapped in `Error` objects on purpose. Tauri command
/// failures reject as raw strings (the commands return `Result<_, String>`),
/// and a page that does `catch (error)` and only formats `error.message` when
/// `error instanceof Error` would otherwise show a generic fallback — losing
/// the one message that says what actually went wrong (a refused origin, a
/// recovery-mode identity, an IPC denial). The Paperclip sign-in page does
/// exactly that, so the wrap is what keeps its error line diagnostic.
pub(crate) const NIP07_SHIM: &str = r#"(function () {
  var internals = window.__TAURI_INTERNALS__;
  if (!internals || typeof internals.invoke !== "function") {
    return;
  }
  function asError(value) {
    if (value instanceof Error) return value;
    var message =
      (typeof value === "string" && value.trim()) ||
      (value && typeof value.message === "string" && value.message) ||
      "the Nostr signer failed";
    return new Error(message);
  }
  function invoke(command, args) {
    try {
      return internals.invoke(command, args).catch(function (error) {
        throw asError(error);
      });
    } catch (error) {
      return Promise.reject(asError(error));
    }
  }
  window.nostr = {
    getPublicKey: function () {
      return invoke("plugin:nip07|nip07_public_key");
    },
    signEvent: function (event) {
      return invoke("plugin:nip07|nip07_sign_event", { event: event });
    },
    getRelays: function () {
      return Promise.resolve({});
    },
  };
  window.dispatchEvent(new Event("nostr:ready"));
})();"#;

/// A rectangle in the app's content area, in CSS pixels.
#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
pub struct WebviewRect {
    /// Left edge, relative to the content area.
    pub x: f64,
    /// Top edge, relative to the content area.
    pub y: f64,
    /// Width.
    pub width: f64,
    /// Height.
    pub height: f64,
}

/// Where a docked child window goes, in logical coordinates.
///
/// The webview reports rectangles in CSS pixels relative to its own content area,
/// while a window is placed in screen coordinates. `inner_position` is the content
/// area's top-left in physical screen pixels, so the two are combined through the
/// window's scale factor.
pub(crate) fn docked_bounds(
    inner_position: (i32, i32),
    scale_factor: f64,
    rect: &WebviewRect,
) -> (f64, f64, f64, f64) {
    let scale = if scale_factor > 0.0 {
        scale_factor
    } else {
        1.0
    };
    (
        inner_position.0 as f64 / scale + rect.x,
        inner_position.1 as f64 / scale + rect.y,
        rect.width.max(1.0),
        rect.height.max(1.0),
    )
}

/// Open (or focus) the Paperclip window for `url`.
///
/// `docked` parents the window to the app window and strips its decorations, so it
/// sits over the content area and moves with the app - an embedded panel rather than
/// a separate window. Docking needs no unstable API: `WebviewWindowBuilder::parent`
/// is stable, and Tauri maps it to `NSWindow.addChildWindow` on macOS, an owned
/// window on Windows and a transient window on Linux. The child is still a real
/// webview, so Paperclip's page runs as a first-party document and the injected
/// NIP-07 signer works.
#[tauri::command]
pub async fn open_paperclip_window(
    app: tauri::AppHandle,
    url: String,
    docked: Option<bool>,
    bounds: Option<WebviewRect>,
) -> Result<(), String> {
    if !paperclip_window_url_is_allowed(&url) {
        return Err(format!(
            "refusing to open `{url}`: the Paperclip window only accepts https, or http on loopback"
        ));
    }
    let parsed = tauri::Url::parse(url.trim()).map_err(|error| format!("invalid URL: {error}"))?;
    let docked = docked.unwrap_or(false);

    if let Some(window) = app.get_webview_window(PAPERCLIP_WINDOW_LABEL) {
        window.show().map_err(|error| error.to_string())?;
        if !docked {
            window.set_focus().map_err(|error| error.to_string())?;
        }
        return Ok(());
    }

    let mut builder =
        WebviewWindowBuilder::new(&app, PAPERCLIP_WINDOW_LABEL, WebviewUrl::External(parsed))
            // The signer is injected before any page script runs, so a sign-in page
            // finds `window.nostr` already present.
            .initialization_script(NIP07_SHIM);

    builder = if docked {
        let main = app
            .get_webview_window("main")
            .ok_or_else(|| "the main window is unavailable".to_string())?;
        let rect = bounds.unwrap_or(WebviewRect {
            x: 0.0,
            y: 0.0,
            width: 900.0,
            height: 600.0,
        });
        let inner = main
            .inner_position()
            .map_err(|error| format!("cannot read the app window position: {error}"))?;
        let scale = main
            .scale_factor()
            .map_err(|error| format!("cannot read the display scale: {error}"))?;
        let (x, y, width, height) = docked_bounds((inner.x, inner.y), scale, &rect);
        builder
            .parent(&main)
            .map_err(|error| format!("cannot parent the Paperclip window: {error}"))?
            .decorations(false)
            .resizable(false)
            .skip_taskbar(true)
            .inner_size(width, height)
            .position(x, y)
    } else {
        builder
            .title("Paperclip")
            .inner_size(1280.0, 860.0)
            .min_inner_size(900.0, 600.0)
    };

    builder.build().map_err(|error| error.to_string())?;
    Ok(())
}

/// Move and resize the docked Paperclip window to match its placeholder.
#[tauri::command]
pub fn set_paperclip_window_bounds(
    app: tauri::AppHandle,
    bounds: WebviewRect,
) -> Result<(), String> {
    let Some(window) = app.get_webview_window(PAPERCLIP_WINDOW_LABEL) else {
        return Ok(());
    };
    let Some(main) = app.get_webview_window("main") else {
        return Ok(());
    };
    let inner = main
        .inner_position()
        .map_err(|error| format!("cannot read the app window position: {error}"))?;
    let scale = main
        .scale_factor()
        .map_err(|error| format!("cannot read the display scale: {error}"))?;
    let (x, y, width, height) = docked_bounds((inner.x, inner.y), scale, &bounds);
    window
        .set_position(PhysicalPosition::new(
            (x * scale).round() as i32,
            (y * scale).round() as i32,
        ))
        .map_err(|error| error.to_string())?;
    window
        .set_size(PhysicalSize::new(
            (width * scale).round().max(1.0) as u32,
            (height * scale).round().max(1.0) as u32,
        ))
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// Whether the Paperclip window is currently docked to the app window.
#[tauri::command]
pub fn paperclip_window_is_docked(app: tauri::AppHandle) -> bool {
    app.get_webview_window(PAPERCLIP_WINDOW_LABEL)
        .map(|window| !window.is_decorated().unwrap_or(true))
        .unwrap_or(false)
}

/// Close the Paperclip window, if it is open.
#[tauri::command]
pub fn close_paperclip_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(PAPERCLIP_WINDOW_LABEL) {
        window.close().map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// The `nip07` inlined plugin: the NIP-07 surface the Paperclip webview may
/// reach.
///
/// A plugin rather than plain app commands because the Paperclip window loads a
/// remote URL, and Tauri's ACL resolves every remote invoke strictly: with no
/// app-defined permissions, app commands are not in the allow-list at all and a
/// remote call is refused ("... not allowed. Plugin not found"). Local windows
/// are unaffected either way, which is why the main window never noticed. The
/// commands are granted only by `capabilities/paperclip-nip07.json`, which
/// scopes them to the `paperclip` window on the managed loopback origin.
pub(crate) fn nip07_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("nip07")
        .invoke_handler(tauri::generate_handler![nip07_public_key, nip07_sign_event])
        .build()
}

/// The public key the Paperclip window signs in as.
#[tauri::command]
pub fn nip07_public_key(state: State<'_, AppState>) -> Result<String, String> {
    Ok(state.signing_keys()?.public_key().to_hex())
}

/// Sign a NIP-98 authentication event with the user's identity.
///
/// Takes the unsigned event the page built (kind, content, tags, optional
/// `created_at`), refuses anything that is not a NIP-98 authentication request,
/// and returns the signed event.
#[tauri::command]
pub async fn nip07_sign_event<R: tauri::Runtime>(
    window: tauri::Webview<R>,
    event: serde_json::Value,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let kind = event
        .get("kind")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| "event.kind is required".to_string())?;
    let kind = u16::try_from(kind).map_err(|_| format!("kind {kind} is out of range"))?;
    let content = event
        .get("content")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_string();
    let tags: Vec<Vec<String>> = event
        .get("tags")
        .and_then(|value| serde_json::from_value(value.clone()).ok())
        .unwrap_or_default();
    let created_at = event.get("created_at").and_then(serde_json::Value::as_u64);

    // The page must only be able to mint a credential for the origin it is.
    let page_url = window.url().ok().map(|url| url.to_string());
    validate_nip98_request_for_page(kind, &content, &tags, page_url.as_deref())?;

    let keys = state.signing_keys()?;
    tauri::async_runtime::spawn_blocking(move || {
        let nostr_tags = tags
            .into_iter()
            .map(|tag| nostr::Tag::parse(tag).map_err(|error| format!("invalid tag: {error}")))
            .collect::<Result<Vec<_>, _>>()?;
        let mut builder =
            nostr::EventBuilder::new(nostr::Kind::Custom(kind), content).tags(nostr_tags);
        if let Some(created_at) = created_at {
            builder = builder.custom_created_at(nostr::Timestamp::from(created_at));
        }
        let signed = builder
            .sign_with_keys(&keys)
            .map_err(|error| format!("sign failed: {error}"))?;
        serde_json::from_str(&signed.as_json()).map_err(|error| format!("encode failed: {error}"))
    })
    .await
    .map_err(|error| format!("spawn_blocking failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_https_or_loopback_http_may_open_the_window() {
        assert!(paperclip_window_url_is_allowed("http://127.0.0.1:3101"));
        assert!(paperclip_window_url_is_allowed("http://localhost:3101/#/x"));
        assert!(paperclip_window_url_is_allowed("http://[::1]:3101"));
        assert!(paperclip_window_url_is_allowed("https://tasks.example.com"));
        for refused in [
            "",
            "  ",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "http://tasks.example.com",
            "http://192.168.1.10:3100",
            "://example.com",
        ] {
            assert!(
                !paperclip_window_url_is_allowed(refused),
                "{refused} must not open a window holding a signing capability"
            );
        }
    }

    #[test]
    fn a_docked_window_lands_on_its_placeholder() {
        // Content area starts at (100, 200) on a 2x display; the placeholder sits
        // 260 CSS px in and is 900x600.
        let rect = WebviewRect {
            x: 260.0,
            y: 40.0,
            width: 900.0,
            height: 600.0,
        };
        let (x, y, width, height) = docked_bounds((200, 400), 2.0, &rect);
        // 200/2 + 260 = 360 on x; 400/2 + 40 = 240 on y.
        assert_eq!((x, y), (360.0, 240.0), "screen offset plus the placeholder");
        assert_eq!((width, height), (900.0, 600.0));
    }

    #[test]
    fn a_zero_or_bogus_scale_never_produces_a_broken_window() {
        let rect = WebviewRect {
            x: 10.0,
            y: 10.0,
            width: 0.0,
            height: -5.0,
        };
        let (x, y, width, height) = docked_bounds((0, 0), 0.0, &rect);
        assert_eq!((x, y), (10.0, 10.0));
        assert!(
            width >= 1.0 && height >= 1.0,
            "a window needs a positive size"
        );
    }

    fn nip98_tags() -> Vec<Vec<String>> {
        vec![
            vec![
                "u".to_string(),
                "http://127.0.0.1:3101/api/auth/nostr/login".to_string(),
            ],
            vec!["method".to_string(), "POST".to_string()],
            vec!["nonce".to_string(), "abc123".to_string()],
        ]
    }

    #[test]
    fn a_well_formed_nip98_request_is_accepted() {
        assert!(validate_nip98_request(KIND_NIP98, "", &nip98_tags()).is_ok());
    }

    /// The exact shape Paperclip's sign-in page builds, including the `payload`
    /// tag that `nostr-tools` requires when the request has a body. If this test
    /// fails, sign-in fails with a 401 from the server rather than here.
    #[test]
    fn the_sign_in_page_event_shape_is_accepted() {
        let tags = vec![
            vec![
                "u".to_string(),
                "http://127.0.0.1:3101/api/auth/nostr/login".to_string(),
            ],
            vec!["method".to_string(), "POST".to_string()],
            vec!["nonce".to_string(), "0123456789abcdef".to_string()],
            vec!["payload".to_string(), "a".repeat(64)],
        ];
        assert!(
            validate_nip98_request_for_page(KIND_NIP98, "", &tags, Some("http://127.0.0.1:3101/"))
                .is_ok(),
            "the page's event shape must be signable"
        );
    }

    #[test]
    fn the_signer_refuses_a_credential_for_another_origin() {
        let tags = vec![
            vec![
                "u".to_string(),
                "https://attacker.example/login".to_string(),
            ],
            vec!["method".to_string(), "POST".to_string()],
            vec!["nonce".to_string(), "abc".to_string()],
        ];
        let error =
            validate_nip98_request_for_page(KIND_NIP98, "", &tags, Some("http://127.0.0.1:3101/"))
                .expect_err("a credential for another origin must be refused");
        assert!(error.contains("not on the origin"), "{error}");
    }

    #[test]
    fn origin_binding_compares_scheme_host_and_port() {
        assert!(nip98_url_is_on_page_origin(
            "http://127.0.0.1:3101/api/auth/nostr/login",
            "http://127.0.0.1:3101/"
        ));
        assert!(nip98_url_is_on_page_origin(
            "https://tasks.example.com/api/auth/nostr/login",
            "https://tasks.example.com/"
        ));
        assert!(
            !nip98_url_is_on_page_origin("http://127.0.0.1:3102/login", "http://127.0.0.1:3101/"),
            "a different port is a different origin"
        );
        assert!(
            !nip98_url_is_on_page_origin("https://127.0.0.1:3101/login", "http://127.0.0.1:3101/"),
            "a different scheme is a different origin"
        );
        assert!(!nip98_url_is_on_page_origin(
            "not a url",
            "http://127.0.0.1:3101/"
        ));
    }

    #[test]
    fn the_signer_refuses_every_other_kind() {
        for kind in [1u16, 7, 9, 22242, 44011, 30023] {
            let error = validate_nip98_request(kind, "", &nip98_tags())
                .expect_err("only NIP-98 may be signed");
            assert!(error.contains("only signs NIP-98"), "{error}");
        }
    }

    #[test]
    fn the_signer_refuses_non_nip98_tags_and_content() {
        let mut with_extra = nip98_tags();
        with_extra.push(vec!["p".to_string(), "a".repeat(64)]);
        assert!(validate_nip98_request(KIND_NIP98, "", &with_extra).is_err());

        assert!(
            validate_nip98_request(KIND_NIP98, "hello", &nip98_tags()).is_err(),
            "content must be empty, so the signer cannot sign a payload"
        );
    }

    #[test]
    fn the_signer_requires_a_url_and_a_method() {
        let only_url = vec![vec!["u".to_string(), "https://x.example".to_string()]];
        assert!(validate_nip98_request(KIND_NIP98, "", &only_url).is_err());
        let only_method = vec![vec!["method".to_string(), "POST".to_string()]];
        assert!(validate_nip98_request(KIND_NIP98, "", &only_method).is_err());
        let bad_url = vec![
            vec!["u".to_string(), "file:///etc/passwd".to_string()],
            vec!["method".to_string(), "POST".to_string()],
        ];
        assert!(validate_nip98_request(KIND_NIP98, "", &bad_url).is_err());
        let empty_method = vec![
            vec!["u".to_string(), "https://x.example".to_string()],
            ["method".to_string(), "  ".to_string()].to_vec(),
        ];
        assert!(validate_nip98_request(KIND_NIP98, "", &empty_method).is_err());
    }

    /// Runs the production shim against a stubbed Tauri IPC and reports what a
    /// page sees from `window.nostr`.
    ///
    /// This binds the production seam: it executes the exact [`NIP07_SHIM`]
    /// source the webview receives, so a change to the shim's rejection shape
    /// fails here instead of hiding the real signer failure behind a generic
    /// "Nostr sign-in failed" line on Paperclip's sign-in page.
    fn run_shim_with(setup_js: &str) -> serde_json::Value {
        use std::process::{Command, Stdio};

        // The shim is embedded inside a template literal; the source must stay
        // free of the delimiters or the probe itself would be malformed.
        assert!(!NIP07_SHIM.contains('`'), "shim must stay embeddable");
        assert!(!NIP07_SHIM.contains("${"), "shim must stay embeddable");

        let mut probe = String::from("globalThis.window = globalThis;\n");
        probe.push_str(setup_js);
        probe.push_str("\nconst shimSource = `");
        probe.push_str(NIP07_SHIM);
        probe.push_str(
            r#"`
;(0, eval)(shimSource);
const out = [];
const record = async (call, fn) => {
  try {
    out.push({ call, resolved: await fn() });
  } catch (error) {
    out.push({
      call,
      isError: error instanceof Error,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
if (typeof window.nostr === "object" && window.nostr !== null) {
  await record("getPublicKey", () => window.nostr.getPublicKey());
  await record("signEvent", () =>
    window.nostr.signEvent({ kind: 27235, content: "", tags: [] }));
}
console.log(JSON.stringify({
  nostrInstalled: typeof window.nostr === "object" && window.nostr !== null,
  readyDispatched: globalThis.__ready === true,
  out,
}));"#,
        );

        let output = Command::new("node")
            .arg("--input-type=module")
            .arg("--eval")
            .arg(&probe)
            .stdin(Stdio::null())
            .output()
            .expect("node must be on PATH to execute the shim probe");
        assert!(
            output.status.success(),
            "the shim probe must run cleanly: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let stdout = String::from_utf8_lossy(&output.stdout);
        let line = stdout
            .lines()
            .last()
            .expect("the shim probe prints one JSON line");
        serde_json::from_str(line).expect("the shim probe prints a JSON array")
    }

    /// The stub every probe shares: alias `window`, observe `nostr:ready`.
    const PROBE_BASE_SETUP: &str = r#"
globalThis.addEventListener = (type, listener) => process.on(type, listener);
globalThis.removeEventListener = (type, listener) => process.off(type, listener);
globalThis.dispatchEvent = (event) => process.emit(event.type);
process.on("nostr:ready", () => {
  globalThis.__ready = true;
});"#;

    #[test]
    fn the_shim_surfaces_a_string_rejection_as_a_real_error() {
        // What a Tauri `Result<_, String>` command failure rejects with.
        let results = run_shim_with(&format!(
            "{PROBE_BASE_SETUP}\nglobalThis.__TAURI_INTERNALS__ = {{\n  invoke: function () {{\n    return Promise.reject(\"identity is in recovery mode; event signing is disabled\");\n  }},\n}};"
        ));
        assert!(results["nostrInstalled"].as_bool().unwrap());
        assert!(results["readyDispatched"].as_bool().unwrap());
        for entry in results["out"].as_array().expect("two call entries") {
            assert_eq!(
                entry["isError"], true,
                "a raw-string rejection must reach the page as an Error: {entry}"
            );
            assert!(
                entry["message"]
                    .as_str()
                    .expect("an Error message")
                    .contains("recovery mode"),
                "the Rust message must survive into the page: {entry}"
            );
        }
    }

    #[test]
    fn the_shim_resolves_a_successful_invoke_and_announces_nostr_ready() {
        // The stub rejects any command it does not expect, so a drift in the
        // shim's invoke targets fails here instead of silently never signing.
        let results = run_shim_with(&format!(
            "{PROBE_BASE_SETUP}\nglobalThis.__TAURI_INTERNALS__ = {{\n  invoke: function (command) {{\n    if (command === \"plugin:nip07|nip07_public_key\") {{\n      return Promise.resolve(\"a\".repeat(64));\n    }}\n    if (command === \"plugin:nip07|nip07_sign_event\") {{\n      return Promise.resolve({{ id: \"e\".repeat(64), pubkey: \"a\".repeat(64), sig: \"f\".repeat(128) }});\n    }}\n    return Promise.reject(\"unexpected command: \" + command);\n  }},\n}};"
        ));
        assert!(results["nostrInstalled"].as_bool().unwrap());
        assert!(results["readyDispatched"].as_bool().unwrap());
        let out = results["out"].as_array().expect("two call entries");
        assert_eq!(out[0]["call"], "getPublicKey");
        assert_eq!(
            out[0]["resolved"].as_str(),
            Some("a".repeat(64).as_str()),
            "a successful getPublicKey must resolve with the command value, not an Error"
        );
        assert_eq!(out[1]["call"], "signEvent");
        assert_eq!(
            out[1]["resolved"]["id"].as_str(),
            Some("e".repeat(64).as_str())
        );
    }

    #[test]
    fn the_shim_installs_nothing_when_the_ipc_object_is_missing() {
        let results = run_shim_with(PROBE_BASE_SETUP);
        assert_eq!(
            results["nostrInstalled"].as_bool(),
            Some(false),
            "no IPC object means no signer and no nostr:ready — the page must degrade, not throw"
        );
        assert_eq!(results["readyDispatched"].as_bool(), Some(false));
        assert!(results["out"].as_array().expect("no calls").is_empty());
    }

    /// The signer's exposure lives in the capability files, so the files
    /// themselves must be pinned: exactly one capability may grant the
    /// `nip07` plugin to a remote origin, and only to loopback http for the
    /// `paperclip` window. A broader `remote` entry elsewhere would hand the
    /// signing capability (or any other permission) to pages those windows
    /// load, which is the failure this test exists to catch.
    #[test]
    fn the_capability_scopes_the_signer_to_the_managed_loopback_origin() {
        let capabilities_dir =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities");
        let mut nip07_capabilities = Vec::new();
        for entry in
            std::fs::read_dir(&capabilities_dir).expect("capabilities directory must exist")
        {
            let path = entry.expect("readable capabilities entry").path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let text = std::fs::read_to_string(&path)
                .map_err(|error| format!("{}: {error}", path.display()))
                .expect("readable capability file");
            let capability: serde_json::Value = serde_json::from_str(&text)
                .map_err(|error| format!("{}: {error}", path.display()))
                .expect("valid capability JSON");
            let identifier = capability["identifier"].as_str().expect("identifier");

            // Every remote grant anywhere must be loopback-only http. An https
            // wildcard would hand the signer to whatever a hosted page loaded.
            if let Some(urls) = capability["remote"]["urls"].as_array() {
                for url in urls {
                    let url = url.as_str().expect("a remote url string");
                    assert!(
                        url == "http://127.0.0.1:*" || url == "http://localhost:*",
                        "{identifier}: remote url `{url}` must be the managed loopback patterns"
                    );
                }
                if capability["permissions"]
                    .as_array()
                    .expect("permissions")
                    .iter()
                    .any(|p| p.as_str() == Some("nip07:default"))
                {
                    nip07_capabilities.push(identifier.to_string());
                }
            }
        }

        assert_eq!(
            nip07_capabilities,
            vec!["paperclip-nip07".to_string()],
            "exactly one capability must grant the nip07 signer to a remote origin"
        );

        let grant: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(capabilities_dir.join("paperclip-nip07.json"))
                .expect("the signer capability file"),
        )
        .expect("valid signer capability JSON");
        assert_eq!(grant["windows"][0], "paperclip");
        assert_eq!(
            grant["local"], false,
            "the paperclip window is always remote"
        );
        assert_eq!(grant["permissions"][0], "nip07:default");
    }

    /// The ACL the build generates for the `nip07` plugin must allow exactly
    /// the command names the shim invokes. The build-side `InlinedPlugin`
    /// command list and the runtime handler fn names are separate sources of
    /// truth — if they drift, every sign-in dies at the ACL with "not allowed"
    /// and nothing else in this suite notices, so the generated manifest is
    /// the seam to pin.
    #[test]
    fn the_generated_acl_allows_exactly_the_commands_the_shim_invokes() {
        let manifest: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("gen/schemas/acl-manifests.json"),
            )
            .expect("generated ACL manifests (tauri-build runs before tests)"),
        )
        .expect("valid generated ACL manifests");
        let nip07 = &manifest["nip07"];
        assert!(
            nip07.is_object(),
            "the nip07 plugin must have a generated ACL manifest"
        );

        let default_permissions: Vec<&str> = nip07["default_permission"]["permissions"]
            .as_array()
            .expect("default permission set")
            .iter()
            .map(|p| p.as_str().expect("permission identifier"))
            .collect();
        assert_eq!(
            default_permissions,
            vec!["allow-nip07-public-key", "allow-nip07-sign-event"]
        );
        for (permission, command) in [
            ("allow-nip07-public-key", "nip07_public_key"),
            ("allow-nip07-sign-event", "nip07_sign_event"),
        ] {
            let allowed: Vec<&str> = nip07["permissions"][permission]["commands"]["allow"]
                .as_array()
                .expect("allowed commands")
                .iter()
                .map(|c| c.as_str().expect("command name"))
                .collect();
            assert_eq!(
                allowed,
                [command],
                "{permission} must allow exactly `{command}`"
            );
        }
    }
}
