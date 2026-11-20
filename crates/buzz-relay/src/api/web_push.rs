//! Web push subscriptions: `PUT /push/web` keeps a device, `DELETE /push/web` removes it.
//!
//! **Why HTTP and not a signed event.** A subscription is a bearer capability: the address that lets anyone send to that
//! device. It must not become a stored, public, fanned-out event. So it is an HTTP call signed per request (NIP-98: the
//! person's own key signs the method, the address and the body hash), resolved to a community by host like every API, and
//! replay-guarded like the others.
//!
//! **Off unless the operator turned push on.** Without `BUZZ_WEB_PUSH_*` both paths answer 404 "not switched on" before
//! anything else is read, and the tables are never written.
//!
//! **What is checked** (see [`crate::web_push::hosts`]): the address is `https`, at most 512 characters, with no
//! credentials, on a known push service (or one the operator listed for a local stand-in); `p256dh` is 65 bytes starting
//! with `0x04` **and a point on the curve**; `auth` is 16 bytes. At most 10 requests an hour per account.
//!
//! **What is kept**: the address, the two keys, a creation and an expiry time, and the account. Nothing else (no name, no
//! user agent, no address of the person, no project, no wallet).

use std::sync::{Arc, LazyLock};
use std::time::Duration;

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Json, Response},
};
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine;
use chrono::Utc;
use serde::Deserialize;

use super::{api_error, bridge, internal_error, relay_members};
use crate::state::AppState;
use crate::web_push::{ece, hosts, store};

/// The path of both calls.
pub const PATH: &str = "/push/web";
/// The largest request body read.
const BODY_MAX: usize = 4096;
/// Requests one account may make in an hour, saves and removals together.
pub const REQUESTS_PER_HOUR: u32 = 10;

/// What the server says to an account with no linked wallet: alerts are for people who back a project.
pub const NEEDS_LINK: &str =
    "Alerts are for people who back a project. Back one and confirm your account there, then turn alerts on.";
/// What the server says when it already keeps as many devices as it will.
pub const FULL: &str = "This server cannot keep more devices for alerts now. Try again later.";

/// What the server says when push is off. The app does not draw the card without `webPush` in the information document,
/// so this is only what a hand-made call is told.
pub const NOT_SWITCHED_ON: &str = "Alerts are not switched on for this server.";

/// Requests per account per window, in memory for one process. The cache has a hard capacity and its entries expire, so
/// the limiter cannot itself become an unbounded-memory problem when a caller generates keys.
pub struct RequestLimiter {
    seen: moka::sync::Cache<(uuid::Uuid, [u8; 32]), Arc<std::sync::atomic::AtomicU32>>,
}

impl RequestLimiter {
    /// A limiter with a window of `window`.
    pub fn new(window: Duration) -> Self {
        Self {
            seen: moka::sync::Cache::builder()
                .max_capacity(10_000)
                .time_to_live(window)
                .build(),
        }
    }

    /// Count one request. `false` once the account is over [`REQUESTS_PER_HOUR`] in the window.
    pub fn allow(&self, community: uuid::Uuid, account: &[u8; 32]) -> bool {
        let counter = self.seen.get_with((community, *account), || {
            Arc::new(std::sync::atomic::AtomicU32::new(0))
        });
        counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed) < REQUESTS_PER_HOUR
    }
}

static LIMITER: LazyLock<RequestLimiter> =
    LazyLock::new(|| RequestLimiter::new(Duration::from_secs(3_600)));

/// The body of `PUT`: what a browser's `PushSubscription.toJSON()` gives.
#[derive(Debug, Deserialize)]
struct PutBody {
    endpoint: String,
    keys: Keys,
}

#[derive(Debug, Deserialize)]
struct Keys {
    p256dh: String,
    auth: String,
}

/// The body of `DELETE`: the address to remove, or nothing for every device of the account.
#[derive(Debug, Deserialize)]
struct DeleteBody {
    endpoint: String,
}

fn decode(text: &str) -> Option<Vec<u8>> {
    // A browser writes base64url without padding; padding and the standard alphabet are accepted too.
    let normal: String = text
        .trim()
        .trim_end_matches('=')
        .chars()
        .map(|c| match c {
            '+' => '-',
            '/' => '_',
            other => other,
        })
        .collect();
    B64.decode(normal).ok()
}

/// The parts of a `PUT` body once checked.
#[derive(Debug, PartialEq, Eq)]
pub struct Checked {
    /// The address as given.
    pub endpoint: String,
    /// The device's public key.
    pub p256dh: [u8; 65],
    /// The device's auth secret.
    pub auth: [u8; 16],
}

/// Check what a person sent: the address against the rules, the key as a point on the curve, the secret as 16 bytes. The
/// sentence is the one the person is shown. Pure.
pub fn check_put(body: &[u8], extra_hosts: &[String]) -> Result<Checked, &'static str> {
    let parsed: PutBody = serde_json::from_slice(body)
        .map_err(|_| "Send the address and keys of the device, as the browser gives them.")?;
    hosts::check_endpoint(&parsed.endpoint, extra_hosts).map_err(hosts::Refusal::sentence)?;
    let p256dh: [u8; 65] = decode(&parsed.keys.p256dh)
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or("That device key is not valid.")?;
    ece::check_public_key(&p256dh).map_err(|_| "That device key is not valid.")?;
    let auth: [u8; 16] = decode(&parsed.keys.auth)
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or("That device secret is not valid.")?;
    Ok(Checked {
        endpoint: parsed.endpoint,
        p256dh,
        auth,
    })
}

async fn authenticate(
    state: &Arc<AppState>,
    headers: &HeaderMap,
    method: &'static str,
    body: &[u8],
) -> Result<(buzz_core::TenantContext, nostr::PublicKey), Response> {
    let tenant = crate::nip_fi_shadow::bind_tenant(state, headers)
        .await
        .ok_or_else(|| {
            api_error(
                StatusCode::NOT_FOUND,
                "relay: no community is configured for this host",
            )
            .into_response()
        })?;
    let expected_url = bridge::nip98_expected_url(&state.config.relay_url, &tenant, PATH);
    let signed_body = (!body.is_empty()).then(|| body.to_vec());
    // NIP-FI admission. [FI-TRACE-AUTHORITY-UNIFORM]
    let admission = crate::nip_fi_http::admit_nip_fi_http_on_state(
        state,
        headers,
        bridge::make_nip98_closure_for_admission(
            headers.clone(),
            method,
            expected_url,
            signed_body,
            true,
            !body.is_empty(),
        ),
    )?;
    let pubkey = *admission.proven_pubkey();
    let (event_id_bytes, signed_created_at) = admission.into_extra();

    bridge::enforce_http_admission(state, &tenant, &pubkey)
        .await
        .map_err(|e| e.into_response())?;
    bridge::check_nip98_replay(state, &tenant, event_id_bytes)
        .await
        .map_err(|e| e.into_response())?;
    relay_members::enforce_relay_membership(
        state,
        tenant.community(),
        &pubkey.to_bytes(),
        relay_members::extract_auth_tag_header(headers),
        signed_created_at,
    )
    .await
    .map_err(|e| e.into_response())?;
    Ok((tenant, pubkey))
}

/// `PUT /push/web`: keep this device for the signer's account.
pub async fn put(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    let Some(config) = state.config.web_push.as_ref() else {
        return api_error(StatusCode::NOT_FOUND, NOT_SWITCHED_ON).into_response();
    };
    if body.len() > BODY_MAX {
        return api_error(StatusCode::PAYLOAD_TOO_LARGE, "That request is too large.")
            .into_response();
    }
    let (tenant, pubkey) = match authenticate(&state, &headers, "PUT", &body).await {
        Ok(found) => found,
        Err(response) => return response,
    };
    let account = pubkey.to_bytes();
    if !LIMITER.allow(*tenant.community().as_uuid(), &account) {
        return api_error(
            StatusCode::TOO_MANY_REQUESTS,
            "Too many tries. Wait a while and try again.",
        )
        .into_response();
    }
    let checked = match check_put(&body, &config.extra_hosts) {
        Ok(checked) => checked,
        Err(sentence) => return api_error(StatusCode::BAD_REQUEST, sentence).into_response(),
    };
    // Alerts reach only holders, whose wallets the server knows from a link they made: on a server that reads the chain,
    // a device is kept only for an account that has one, so accounts made for nothing do not fill the table.
    if state.config.chain_reader.is_some() {
        match crate::handlers::wallet_binding::linked_wallets(&state, tenant.community(), &account)
            .await
        {
            Ok(wallets) if wallets.is_empty() => {
                return api_error(StatusCode::FORBIDDEN, NEEDS_LINK).into_response()
            }
            Ok(_) => {}
            Err(e) => {
                return internal_error(&format!("reading the wallets of an account: {e}"))
                    .into_response()
            }
        }
    }
    match store::upsert_subscription_capped(
        state.db.pool(),
        *tenant.community().as_uuid(),
        &account,
        store::NewDevice {
            endpoint: &checked.endpoint,
            p256dh: &checked.p256dh,
            auth: &checked.auth,
        },
        config.max_per_account,
        store::DEVICES_PER_COMMUNITY_MAX,
        Utc::now(),
    )
    .await
    {
        Ok(store::Kept::Kept) => {
            (StatusCode::OK, Json(serde_json::json!({ "ok": true }))).into_response()
        }
        Ok(store::Kept::CommunityFull) => {
            api_error(StatusCode::SERVICE_UNAVAILABLE, FULL).into_response()
        }
        Err(e) => internal_error(&format!("keeping a push subscription: {e}")).into_response(),
    }
}

/// `DELETE /push/web`: remove this device (the body names its address) or, with no body, every device of the account.
pub async fn delete(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    if state.config.web_push.is_none() {
        return api_error(StatusCode::NOT_FOUND, NOT_SWITCHED_ON).into_response();
    }
    if body.len() > BODY_MAX {
        return api_error(StatusCode::PAYLOAD_TOO_LARGE, "That request is too large.")
            .into_response();
    }
    let (tenant, pubkey) = match authenticate(&state, &headers, "DELETE", &body).await {
        Ok(found) => found,
        Err(response) => return response,
    };
    let account = pubkey.to_bytes();
    if !LIMITER.allow(*tenant.community().as_uuid(), &account) {
        return api_error(
            StatusCode::TOO_MANY_REQUESTS,
            "Too many tries. Wait a while and try again.",
        )
        .into_response();
    }
    let hash = if body.is_empty() {
        None
    } else {
        match serde_json::from_slice::<DeleteBody>(&body) {
            Ok(parsed) => Some(store::endpoint_hash(&parsed.endpoint)),
            Err(_) => {
                return api_error(
                    StatusCode::BAD_REQUEST,
                    "Send the address of the device to remove, or nothing to remove them all.",
                )
                .into_response()
            }
        }
    };
    match store::delete_subscriptions(
        state.db.pool(),
        *tenant.community().as_uuid(),
        &account,
        hash.as_ref(),
    )
    .await
    {
        Ok(removed) => (
            StatusCode::OK,
            Json(serde_json::json!({ "ok": true, "removed": removed })),
        )
            .into_response(),
        Err(e) => internal_error(&format!("removing push subscriptions: {e}")).into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::elliptic_curve::sec1::ToEncodedPoint;

    /// A device key pair made for the test, as a browser writes it.
    fn device() -> (String, String) {
        let secret = loop {
            let bytes: [u8; 32] = rand::random();
            if let Ok(secret) = p256::SecretKey::from_slice(&bytes) {
                break secret;
            }
        };
        let public = secret.public_key().to_encoded_point(false);
        let auth: [u8; 16] = rand::random();
        (B64.encode(public.as_bytes()), B64.encode(auth))
    }

    fn body(endpoint: &str, p256dh: &str, auth: &str) -> Vec<u8> {
        serde_json::json!({ "endpoint": endpoint, "keys": { "p256dh": p256dh, "auth": auth } })
            .to_string()
            .into_bytes()
    }

    #[test]
    fn a_good_subscription_passes_and_every_bad_one_is_refused_with_a_sentence() {
        let (p, a) = device();
        let good = "https://fcm.googleapis.com/fcm/send/abc";
        let ok = check_put(&body(good, &p, &a), &[]).expect("a good subscription");
        assert_eq!(ok.endpoint, good);
        // A browser may pad, or use the standard alphabet.
        assert!(check_put(&body(good, &format!("{p}="), &a), &[]).is_ok());

        let mut off_curve = decode(&p).expect("key");
        off_curve[64] ^= 1;
        let cases: Vec<(Vec<u8>, &str)> = vec![
            (body("http://fcm.googleapis.com/x", &p, &a), "secure"),
            (
                body("https://u:p@fcm.googleapis.com/x", &p, &a),
                "name or a password",
            ),
            (body("https://example.com/x", &p, &a), "not supported"),
            (body("https://127.0.0.1/x", &p, &a), "not supported"),
            (
                body(
                    &format!("https://fcm.googleapis.com/{}", "a".repeat(600)),
                    &p,
                    &a,
                ),
                "not valid",
            ),
            (body(good, &B64.encode(&off_curve), &a), "device key"),
            (body(good, &B64.encode([4u8; 10]), &a), "device key"),
            (body(good, "not base64!!", &a), "device key"),
            (body(good, &p, &B64.encode([1u8; 15])), "device secret"),
            (body(good, &p, &B64.encode([1u8; 17])), "device secret"),
            (b"{}".to_vec(), "Send the address"),
            (b"nonsense".to_vec(), "Send the address"),
        ];
        for (request, words) in cases {
            let sentence = check_put(&request, &[]).expect_err("refused");
            assert!(
                sentence.contains(words),
                "{sentence} should mention {words}"
            );
        }
    }

    #[test]
    fn an_account_has_ten_requests_an_hour() {
        let limiter = RequestLimiter::new(Duration::from_secs(3_600));
        let (community, account) = (uuid::Uuid::new_v4(), [9u8; 32]);
        for _ in 0..REQUESTS_PER_HOUR {
            assert!(limiter.allow(community, &account));
        }
        assert!(
            !limiter.allow(community, &account),
            "the eleventh is refused"
        );
        assert!(
            limiter.allow(community, &[8u8; 32]),
            "another account is unaffected"
        );
        assert!(
            limiter.allow(uuid::Uuid::new_v4(), &account),
            "so is the same key in another community"
        );
    }
}

#[cfg(test)]
#[path = "web_push_postgres_tests.rs"]
mod postgres_tests;
