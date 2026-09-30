//! Browser → desktop account handoff ("Sign in with browser").
//!
//! Phase 4 of the product plan: adopt the web account's identity on this
//! device without ever pasting a key. The desktop generates a ONE-TIME
//! X-only secp256k1 keypair and a 32-byte random nonce, stores them as a
//! single-use pending request, and opens the system browser at
//! `https://<web-host>/link-device?pub=<hex pubkey>&nonce=<hex>&cb=creaton://identity`
//! (web host configurable via `BUZZ_WEB_HOST`). The web page encrypts the
//! canonical account JSON
//! `{"v":1,"sk":"<64-hex account secret key>","nonce":"<hex>","exp":<unix secs>}`
//! with NIP-44 (the ACCOUNT key is the sender, the one-time key the
//! recipient) and redirects to
//! `creaton://identity?p=<base64url(ciphertext)>&from=<64-hex account pubkey>`
//! (the `p` value is base64url — unpadded — over the UTF-8 text of the
//! NIP-44 ciphertext string, matching the web half's
//! `buildLinkDeviceCallback` in `packages/creaton-core/src/link-device.ts`).
//! `from` is required: a NIP-44 payload does not identify its sender, so the
//! conversation key cannot be derived without it.
//!
//! This module validates the response — version, nonce (must match the
//! pending request), expiry, and the sender binding (`from` must be the
//! pubkey `sk` derives) — then commits the account key through the
//! existing keyring-first import path (`commit_imported_identity` +
//! `persist_imported_identity`), exactly the tier manual import uses. The
//! macOS keychain service name is untouched (`app_state::keyring_service`).
//!
//! SECURITY CONTRACT:
//! - The payload is the NIP-44 plaintext's carrier and is NEVER logged: no
//!   path in this module (or the `deep-link` arm) prints the payload, the
//!   deep-link URL, or the account secret key.
//! - The pending request is consumed exactly once, on success. A replayed
//!   payload finds no request that decrypts it and is rejected; a wrong
//!   nonce or an expired payload is rejected without consuming or storing
//!   anything.
//!
//! The whole JSON (not just `sk`) is the NIP-44 plaintext. Decryption uses
//! the one-time keypair as RECIPIENT and `from` as sender:
//! `nip44::decrypt(one_time_secret_key, from_pubkey, ciphertext)`.

use std::collections::VecDeque;
use std::sync::Mutex;

use base64::Engine as _;
use nostr::nips::nip19::ToBech32;
use nostr::nips::nip44;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, State};
use url::Url;

/// Upper bound on outstanding link requests. Each holds a one-time keypair;
/// the queue is a bounded VecDeque so a runaway caller cannot grow it.
const MAX_PENDING_LINKS: usize = 4;

/// A pending request older than this is pruned on the next insert. The
/// browser round trip expires after 300s per the web half, so 15 minutes is
/// a generous bound that still keeps the queue finite.
const PENDING_LINK_TTL_SECS: u64 = 900;

/// `v` of the frozen handoff JSON. Anything else is rejected as malformed.
const HANDOFF_VERSION: u32 = 1;

/// Tauri event announcing the outcome. Carries only the request id, the
/// outcome category, and the linked npub — never the payload.
pub(crate) const IDENTITY_LINK_EVENT: &str = "deep-link-identity";

pub(crate) const STATUS_LINKED: &str = "linked";
pub(crate) const STATUS_REJECTED: &str = "rejected";

/// Why a handoff payload was refused. The `reason` code sent to the
/// frontend is stable and carries no payload content, so user-facing copy
/// can be mapped to it without leaking internals.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum IdentityLinkError {
    /// Base64url/UTF-8/JSON decoding failed, `v` is not 1, or `sk` is not a
    /// valid 64-hex secret key.
    Malformed,
    /// The decrypted `nonce` did not match the pending request's nonce.
    NonceMismatch,
    /// The decrypted `exp` is already past.
    Expired,
    /// The payload decrypted, but `sk` does not derive the `from` sender
    /// pubkey — the sender is not handing over its own account.
    SenderMismatch,
    /// No pending request decrypted the payload: never started, cancelled,
    /// already consumed (replay), or the app restarted.
    NoPendingRequest,
    /// The account key parsed, but committing it to the keyring/file tier
    /// failed. Nothing was swapped in memory on this path.
    Storage(String),
}

impl IdentityLinkError {
    /// Stable, payload-free reason code for the frontend copy map.
    pub(crate) fn reason_code(&self) -> &'static str {
        match self {
            IdentityLinkError::Malformed => "malformed",
            IdentityLinkError::NonceMismatch => "nonce-mismatch",
            IdentityLinkError::Expired => "expired",
            IdentityLinkError::SenderMismatch => "sender-mismatch",
            IdentityLinkError::NoPendingRequest => "no-pending-request",
            IdentityLinkError::Storage(_) => "storage",
        }
    }
}

/// A rejection, tagged with the pending request the payload decrypted under
/// when one is known — the frontend fences a stale rejection (or a stray
/// payload addressed to no live request) away from a newer flow.
#[derive(Debug)]
pub(crate) struct RejectedIdentityLink {
    pub(crate) id: Option<String>,
    pub(crate) error: IdentityLinkError,
}

impl RejectedIdentityLink {
    fn here(id: Option<String>, error: IdentityLinkError) -> Self {
        RejectedIdentityLink { id, error }
    }
}

/// The decrypted handoff JSON. The WHOLE JSON is the NIP-44 plaintext.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct HandoffPayload {
    v: u32,
    sk: String,
    nonce: String,
    exp: u64,
}

/// A single outstanding request: the one-time keypair and the nonce the web
/// page must echo back inside the encrypted JSON.
struct PendingIdentityLink {
    id: String,
    nonce_hex: String,
    keys: nostr::Keys,
    created_at: u64,
}

/// Bounded, in-memory store of outstanding link requests. Deliberately not
/// persisted: a request lives for one short browser round trip, and a
/// restart invalidating the request is the safe direction (single-use).
#[derive(Default)]
pub(crate) struct PendingIdentityLinks(Mutex<VecDeque<PendingIdentityLink>>);

impl PendingIdentityLinks {
    fn lock(&self) -> std::sync::MutexGuard<'_, VecDeque<PendingIdentityLink>> {
        self.0.lock().unwrap_or_else(|poisoned| {
            eprintln!("buzz-desktop: recovering poisoned pending identity-link queue");
            poisoned.into_inner()
        })
    }

    /// Insert a request, pruning stale entries and evicting the oldest once
    /// the cap is reached so the store stays bounded.
    fn insert_pending(&self, link: PendingIdentityLink, now_unix: u64) {
        let mut queue = self.lock();
        queue.retain(|item| now_unix.saturating_sub(item.created_at) < PENDING_LINK_TTL_SECS);
        queue.push_back(link);
        while queue.len() > MAX_PENDING_LINKS {
            queue.pop_front();
        }
    }

    fn discard(&self, id: &str) {
        self.lock().retain(|item| item.id != id);
    }

    fn clear(&self) {
        self.lock().clear();
    }
}

/// A successful decrypt + validation: the request id (consumed single-use)
/// and the account keys parsed from `sk`.
#[derive(Debug)]
pub(crate) struct ConsumedLink {
    pub(crate) id: String,
    pub(crate) keys: nostr::Keys,
}

/// Decode a base64url payload. Accepts padded and unpadded forms; anything
/// else (including the empty payload) is malformed.
fn decode_base64url(value: &str) -> Option<Vec<u8>> {
    if value.is_empty() {
        return None;
    }
    use base64::engine::general_purpose::{URL_SAFE, URL_SAFE_NO_PAD};
    URL_SAFE_NO_PAD
        .decode(value)
        .or_else(|_| URL_SAFE.decode(value))
        .ok()
}

fn hex_lower(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        // Writing to a String never fails.
        let _ = write!(out, "{byte:02x}");
    }
    out
}

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or_default()
}

fn random_nonce_hex() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes)
        .map_err(|error| format!("random generator failed: {error}"))?;
    Ok(hex_lower(&bytes))
}

/// Validate an incoming `creaton://identity?p=…&from=…` body against the
/// pending requests and consume the matching one (single-use).
///
/// This is the production validation core: the deep-link arm hands the raw
/// payload here, unmodified.
///
/// Order is the frozen contract: NIP-44-decrypt under a pending one-time key
/// (recipient) and `from` (sender) → parse the JSON → check `v`, then `nonce`
/// (must match that request), then `exp` (not past) → parse `sk` and bind the
/// sender (`sk` must derive `from`). Only on full success is the pending
/// request consumed; every rejection leaves the store untouched.
pub(crate) fn consume_identity_payload(
    links: &PendingIdentityLinks,
    payload: &str,
    from_pub_hex: &str,
    now_unix: u64,
) -> Result<ConsumedLink, RejectedIdentityLink> {
    let from_pubkey = nostr::PublicKey::from_hex(from_pub_hex)
        .map_err(|_| RejectedIdentityLink::here(None, IdentityLinkError::Malformed))?;
    let ciphertext_bytes = decode_base64url(payload)
        .ok_or_else(|| RejectedIdentityLink::here(None, IdentityLinkError::Malformed))?;
    let ciphertext = std::str::from_utf8(&ciphertext_bytes)
        .map_err(|_| RejectedIdentityLink::here(None, IdentityLinkError::Malformed))?;

    let mut queue = links.lock();
    // Newest first: the most recently started request is the live one.
    for index in (0..queue.len()).rev() {
        let pending = &queue[index];
        let plaintext = match nip44::decrypt(pending.keys.secret_key(), &from_pubkey, ciphertext) {
            Ok(plaintext) => zeroize::Zeroizing::new(plaintext),
            // Not addressed to this pending request — try the next one.
            Err(_) => continue,
        };
        let request_id = Some(pending.id.clone());
        let parsed: HandoffPayload = serde_json::from_str(plaintext.as_str()).map_err(|_| {
            RejectedIdentityLink::here(request_id.clone(), IdentityLinkError::Malformed)
        })?;
        if parsed.v != HANDOFF_VERSION {
            return Err(RejectedIdentityLink::here(
                request_id,
                IdentityLinkError::Malformed,
            ));
        }
        // The nonce binds the response to THIS request, compared verbatim
        // exactly as the web half's `checkLinkDevicePayload` does. A payload
        // encrypted for our one-time key but carrying another request's
        // nonce is a confused-deputy response and must not link anything.
        if parsed.nonce != pending.nonce_hex {
            return Err(RejectedIdentityLink::here(
                request_id,
                IdentityLinkError::NonceMismatch,
            ));
        }
        if parsed.exp < now_unix {
            return Err(RejectedIdentityLink::here(
                request_id,
                IdentityLinkError::Expired,
            ));
        }
        let sk = zeroize::Zeroizing::new(parsed.sk);
        let secret = nostr::SecretKey::from_hex(sk.as_str()).map_err(|_| {
            RejectedIdentityLink::here(request_id.clone(), IdentityLinkError::Malformed)
        })?;
        let keys = nostr::Keys::new(secret);
        // Sender binding: the sender must be handing over its own account —
        // `from` (the NIP-44 sender) must be the pubkey `sk` derives.
        if keys.public_key() != from_pubkey {
            return Err(RejectedIdentityLink::here(
                request_id,
                IdentityLinkError::SenderMismatch,
            ));
        }
        let consumed = queue
            .remove(index)
            .ok_or_else(|| RejectedIdentityLink::here(None, IdentityLinkError::NoPendingRequest))?;
        return Ok(ConsumedLink {
            id: consumed.id,
            keys,
        });
    }
    Err(RejectedIdentityLink::here(
        None,
        IdentityLinkError::NoPendingRequest,
    ))
}

/// Normalize a configured web host to an `https://` origin. Accepts a bare
/// host (optionally with port) or a full `https://` origin; anything else is
/// refused so the browser is never opened at an attacker-shaped URL.
fn normalize_web_origin(value: &str) -> Result<String, String> {
    let trimmed = value.trim().trim_end_matches('/');
    let with_scheme = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };
    let parsed = Url::parse(&with_scheme)
        .map_err(|error| format!("BUZZ_WEB_HOST is not a valid host: {error}"))?;
    if parsed.scheme() != "https" {
        return Err("BUZZ_WEB_HOST must be an https host".to_string());
    }
    if parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err("BUZZ_WEB_HOST must be just a host name (optionally with a port)".to_string());
    }
    Ok(with_scheme)
}

/// The web host is configuration, never a hardcoded literal.
fn configured_web_origin() -> Result<String, String> {
    match std::env::var("BUZZ_WEB_HOST") {
        Ok(value) => normalize_web_origin(&value),
        Err(_) => Err(
            "Set BUZZ_WEB_HOST to your web app host (for example app.example.com), \
             then try signing in again."
                .to_string(),
        ),
    }
}

/// Build the `link-device` URL the system browser opens. The `cb` value is
/// the frozen `creaton://identity` callback the web page redirects to.
pub(crate) fn build_link_url(
    web_origin: &str,
    pub_hex: &str,
    nonce_hex: &str,
) -> Result<Url, String> {
    let origin = normalize_web_origin(web_origin)?;
    let mut url = Url::parse(&format!("{origin}/link-device"))
        .map_err(|error| format!("invalid web host: {error}"))?;
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("pub", pub_hex);
        query.append_pair("nonce", nonce_hex);
        query.append_pair("cb", "creaton://identity");
    }
    Ok(url)
}

/// What the frontend receives after a link attempt resolves. Contains no
/// payload material: request id (for fencing), outcome, and the linked npub
/// or a stable rejection reason.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IdentityLinkResult {
    pub(crate) id: Option<String>,
    pub(crate) status: String,
    pub(crate) npub: Option<String>,
    pub(crate) reason: Option<String>,
}

/// Single-slot result queue so a deep link that lands before (or without)
/// the settings surface mounted is not lost. Bounded by construction.
#[derive(Default)]
pub(crate) struct IdentityLinkResults(Mutex<Option<IdentityLinkResult>>);

impl IdentityLinkResults {
    fn lock(&self) -> std::sync::MutexGuard<'_, Option<IdentityLinkResult>> {
        self.0.lock().unwrap_or_else(|poisoned| {
            eprintln!("buzz-desktop: recovering poisoned identity-link result slot");
            poisoned.into_inner()
        })
    }

    fn set(&self, result: IdentityLinkResult) {
        *self.lock() = Some(result);
    }

    fn take(&self) -> Option<IdentityLinkResult> {
        self.lock().take()
    }
}

/// Returned to the frontend when a new browser sign-in starts.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IdentityLinkStart {
    pub(crate) id: String,
    pub(crate) url: String,
}

/// Start the browser sign-in: generate the one-time keypair and nonce,
/// register the single-use pending request, then open the system browser at
/// the web app's `link-device` page.
#[tauri::command]
pub(crate) fn start_identity_link(
    app: tauri::AppHandle,
    pending: State<'_, PendingIdentityLinks>,
) -> Result<IdentityLinkStart, String> {
    let origin = configured_web_origin()?;
    let keys = nostr::Keys::generate();
    let nonce_hex = random_nonce_hex()?;
    let url = build_link_url(&origin, &keys.public_key().to_hex(), &nonce_hex)?;
    let id = uuid::Uuid::new_v4().to_string();
    pending.insert_pending(
        PendingIdentityLink {
            id: id.clone(),
            nonce_hex,
            keys,
            created_at: now_unix(),
        },
        now_unix(),
    );
    if let Err(error) =
        tauri_plugin_opener::OpenerExt::opener(&app).open_url(url.as_str(), None::<&str>)
    {
        // Do not leave an orphaned request behind a failed open.
        pending.discard(&id);
        return Err(format!("Could not open the browser: {error}"));
    }
    Ok(IdentityLinkStart {
        id,
        url: url.into(),
    })
}

/// Abandon any outstanding sign-in requests (the user cancelled or closed
/// the flow). Nothing is stored anywhere on this path.
#[tauri::command]
pub(crate) fn cancel_identity_link(pending: State<'_, PendingIdentityLinks>) {
    pending.clear();
}

/// Consume the queued link result, if any. The frontend calls this on mount
/// to pick up a result that raced its event subscription.
#[tauri::command]
pub(crate) fn take_identity_link_result(
    results: State<'_, IdentityLinkResults>,
) -> Option<IdentityLinkResult> {
    results.take()
}

struct CompletedIdentityLink {
    id: String,
    npub: String,
}

/// Decrypt, validate, consume, and commit a handoff payload. On success the
/// account key is live on this device through the same keyring-first tier a
/// manual import uses; on failure nothing is consumed and nothing stored.
fn complete_identity_link(
    app: &tauri::AppHandle,
    payload: &str,
    from_pub_hex: &str,
) -> Result<CompletedIdentityLink, RejectedIdentityLink> {
    let consumed = {
        let pending = app.state::<PendingIdentityLinks>();
        consume_identity_payload(&pending, payload, from_pub_hex, now_unix())?
    };

    let state = app.state::<crate::app_state::AppState>();
    let data_dir = app.path().app_data_dir().map_err(|error| {
        RejectedIdentityLink::here(
            Some(consumed.id.clone()),
            IdentityLinkError::Storage(format!("app data dir: {error}")),
        )
    })?;
    let key_path = data_dir.join("identity.key");

    // Serialize against persist_current_identity exactly as manual import
    // does; `commit_imported_identity` owns the persist-then-swap ordering.
    let _mutation_guard = state
        .identity_mutation
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let (pubkey, _storage) =
        crate::commands::commit_imported_identity(&state, &data_dir, consumed.keys, |keys| {
            // Keyring first (store → verify → marker → delete file), 0o600
            // file fallback — the existing tier, same service name.
            let store =
                crate::secret_store::SecretStore::shared(crate::app_state::keyring_service());
            crate::app_state::persist_imported_identity(store, keys, &key_path, &data_dir)
        })
        .map_err(|error| {
            RejectedIdentityLink::here(Some(consumed.id.clone()), IdentityLinkError::Storage(error))
        })?;

    let npub = pubkey.to_bech32().map_err(|error| {
        RejectedIdentityLink::here(
            Some(consumed.id.clone()),
            IdentityLinkError::Storage(format!("encode npub: {error}")),
        )
    })?;
    Ok(CompletedIdentityLink {
        id: consumed.id,
        npub,
    })
}

/// Handle the `creaton://identity` deep link: validate + commit the payload,
/// queue the outcome, and announce it on [`IDENTITY_LINK_EVENT`]. The
/// payload is never included in the result, the event, or any log line.
pub(crate) fn handle_identity_payload(app: &tauri::AppHandle, payload: &str, from_pub_hex: &str) {
    let result = match complete_identity_link(app, payload, from_pub_hex) {
        Ok(completed) => IdentityLinkResult {
            id: Some(completed.id),
            status: STATUS_LINKED.to_string(),
            npub: Some(completed.npub),
            reason: None,
        },
        Err(rejection) => IdentityLinkResult {
            id: rejection.id,
            status: STATUS_REJECTED.to_string(),
            npub: None,
            reason: Some(rejection.error.reason_code().to_string()),
        },
    };
    app.state::<IdentityLinkResults>().set(result.clone());
    if let Err(error) = app.emit(IDENTITY_LINK_EVENT, &result) {
        eprintln!("buzz-desktop: failed to announce identity link result: {error}");
    }
}

#[cfg(test)]
#[path = "identity_link_tests.rs"]
mod tests;
