//! EVM auth HTTP API (creabuzz) — SIWE onboarding.
//!
//! Routes (both **membership-gate exempt**, like `/api/invites/claim` — the
//! caller is not a member yet):
//!
//! - `GET /auth/siwe/nonce` — issue a single-use SIWE nonce (Redis, 10 min).
//! - `POST /auth/siwe/register` — one-tap registration:
//!   1. Nostr proof event (kind:27235, fresh, content = EVM address) proves
//!      control of the joining npub.
//!   2. SIWE signature (EIP-4361/EIP-191 `personal_sign`) proves control of
//!      the EVM root account.
//!   3. The SIWE `Resources:` entry `nostr:<npub-hex>` binds the two inside
//!      the EVM-signed payload.
//!
//!   On success the npub becomes a relay member (`added_by = 'evm_siwe'`) and
//!   the npub ↔ EVM binding is recorded in `evm_identities`.
//!
//! The whole module is feature-gated on `config.evm_auth` (BUZZ_EVM_AUTH);
//! when disabled the routes are not registered.

use std::sync::Arc;

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::Json,
};
use chrono::Utc;
use serde::Deserialize;
use serde_json::{json, Value};

use buzz_evm_auth::{EvmAddress, SiweRequirements};

use crate::handlers::side_effects::{publish_nip43_member_added, publish_nip43_membership_list};
use crate::state::AppState;

use super::{api_error, internal_error};

/// Redis key prefix for single-use SIWE nonces.
const NONCE_KEY_PREFIX: &str = "siwe:nonce:";
/// Nonce lifetime in seconds (10 minutes).
const NONCE_TTL_SECS: u64 = 600;
/// Fixed window for the per-npub registration rate limit.
const RATE_WINDOW_SECS: u64 = 60;
/// Max registration attempts per npub per window.
const RATE_MAX_ATTEMPTS: u32 = 10;
/// Freshness tolerance for the Nostr proof event (±10 minutes).
const NOSTR_PROOF_MAX_AGE_SECS: u64 = 600;
/// Kind of the Nostr proof event (NIP-98 HTTP Auth).
const NOSTR_PROOF_KIND: u16 = 27235;
/// URI tag expected in the Nostr proof event for registration.
const NOSTR_PROOF_URI: &str = "/auth/siwe/register";
/// URI tag expected in the Nostr proof event for revocation.
const REVOKE_PROOF_URI: &str = "/auth/siwe/revoke";

/// Body for `POST /auth/siwe/register`.
#[derive(Debug, Deserialize)]
pub struct SiweRegisterRequest {
    /// The canonical SIWE message (EIP-4361) the wallet signed.
    pub message: String,
    /// 65-byte hex `personal_sign` signature over the message.
    pub signature: String,
    /// Signed Nostr event proving control of the joining npub:
    /// kind 27235, fresh `created_at`, `["u", "/auth/siwe/register"]` tag,
    /// content = the same EVM address as in the SIWE message.
    pub nostr_proof: nostr::Event,
    /// Optional EIP-712 `NostrSigner` attestation binding the EVM root to this
    /// npub. Stored against the binding and enforced at event intake when
    /// `BUZZ_EVM_ENFORCE_ATTESTATION` is enabled.
    #[serde(default)]
    pub attestation: Option<serde_json::Value>,
}

/// Body for `POST /auth/siwe/revoke`.
#[derive(Debug, Deserialize)]
pub struct SiweRevokeRequest {
    /// Signed Nostr event proving control of the npub to revoke:
    /// kind 27235, fresh `created_at`, `["u", "/auth/siwe/revoke"]` tag,
    /// content = the EVM address bound to that npub.
    pub nostr_proof: nostr::Event,
}

/// `GET /auth/siwe/nonce` — issue a single-use nonce for a SIWE login.
pub async fn issue_nonce(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let mut conn = state
        .redis_pool
        .get()
        .await
        .map_err(|e| internal_error(&format!("redis pool: {e}")))?;

    let nonce = uuid::Uuid::new_v4().simple().to_string();
    let key = format!("{NONCE_KEY_PREFIX}{nonce}");
    redis::cmd("SET")
        .arg(&key)
        .arg(1)
        .arg("EX")
        .arg(NONCE_TTL_SECS)
        .arg("NX")
        .query_async::<String>(&mut conn)
        .await
        .map_err(|e| internal_error(&format!("redis SET nonce: {e}")))?;

    Ok(Json(json!({
        "nonce": nonce,
        "expires_in_secs": NONCE_TTL_SECS,
    })))
}

/// `POST /auth/siwe/register` — verify SIWE + Nostr proof, provision membership.
pub async fn register(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    // Row zero: bind the request to its community from the Host header,
    // failing closed — identical to the NIP-05 door.
    let raw_host = headers
        .get(axum::http::header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let tenant = crate::tenant::bind_community(&state.db, raw_host)
        .await
        .map_err(|_| api_error(StatusCode::NOT_FOUND, "unknown_host"))?;

    let request: SiweRegisterRequest = serde_json::from_slice(&body).map_err(|e| {
        api_error(
            StatusCode::BAD_REQUEST,
            &format!("invalid register JSON: {e}"),
        )
    })?;

    let npub_hex = request.nostr_proof.pubkey.to_hex();

    // Fixed-window rate limit per npub (Redis INCR/EXPIRE) — registrations are
    // idempotent, so a real user performs exactly one.
    if rate_limited(&state, &npub_hex).await? {
        return Err(api_error(
            StatusCode::TOO_MANY_REQUESTS,
            "too many registration attempts, slow down",
        ));
    }

    // 1. Nostr proof: valid signature, right kind, fresh, tagged for this
    //    endpoint, and carrying the EVM address in its content.
    let proof_address = verify_nostr_proof(&request.nostr_proof, NOSTR_PROOF_URI)
        .map_err(|e| api_error(StatusCode::FORBIDDEN, &format!("nostr_proof: {e}")))?;

    // 2. SIWE: parse, verify domain/chain/signature/time-window.
    let evm_config = state
        .config
        .evm_auth
        .as_ref()
        .ok_or_else(|| api_error(StatusCode::NOT_FOUND, "evm_auth_disabled"))?;
    let requirements = SiweRequirements {
        domain: host_domain(tenant.host()),
        chain_id: evm_config.chain_id,
    };

    // Route signature verification through the RPC-backed verifier when a
    // JSON-RPC endpoint is configured — this extends SIWE to smart accounts
    // (EIP-1271 deployed, EIP-6492 counterfactual) while falling back to the
    // offline EOA path (`verify_siwe`) otherwise.
    let siwe = match &evm_config.rpc_url {
        Some(rpc_url) => {
            let mut verifier = buzz_evm_auth::RpcSignatureVerifier::new(rpc_url);
            if let Some(validator) = &evm_config.erc6492_validator {
                let validator = EvmAddress::parse(validator).map_err(|e| {
                    api_error(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        &format!("bad BUZZ_EVM_ERC6492_VALIDATOR: {e}"),
                    )
                })?;
                verifier = verifier.with_erc6492_validator(validator);
            }
            buzz_evm_auth::verify_siwe_smart(
                &request.message,
                &request.signature,
                &requirements,
                Utc::now(),
                &verifier,
            )
            .await
            .map_err(|e| api_error(StatusCode::FORBIDDEN, &format!("siwe: {e}")))?
        }
        None => buzz_evm_auth::verify_siwe(
            &request.message,
            &request.signature,
            &requirements,
            Utc::now(),
        )
        .map_err(|e| api_error(StatusCode::FORBIDDEN, &format!("siwe: {e}")))?,
    };

    // 3. Binding checks (both directions):
    //    - the Nostr proof's content address == the SIWE message address
    //    - the EVM-signed message explicitly names the joining npub
    if proof_address != siwe.address {
        return Err(api_error(
            StatusCode::FORBIDDEN,
            "address mismatch between nostr_proof and siwe message",
        ));
    }
    let expected_resource = format!("nostr:{npub_hex}");
    if !siwe.resources.iter().any(|r| r == &expected_resource) {
        return Err(api_error(
            StatusCode::FORBIDDEN,
            "siwe message missing `Resources: - nostr:<npub>` binding",
        ));
    }

    // 3b. Reject re-registration of a soft-revoked binding.
    if state
        .db
        .is_evm_identity_revoked(tenant.community(), &npub_hex)
        .await
        .map_err(|e| internal_error(&format!("evm revoked check: {e}")))?
        == Some(true)
    {
        return Err(api_error(StatusCode::FORBIDDEN, "evm_identity_revoked"));
    }

    // 3c. If an attestation was supplied, verify it binds this npub to the
    //     SIWE address before storing. Malformed/unexpired/foreign attestations
    //     are rejected rather than silently dropped.
    if let Some(attestation_json) = &request.attestation {
        let envelope: buzz_evm_auth::AttestationEnvelope =
            serde_json::from_value(attestation_json.clone()).map_err(|e| {
                api_error(
                    StatusCode::BAD_REQUEST,
                    &format!("bad attestation JSON: {e}"),
                )
            })?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let attested_account = envelope
            .verify_for_npub(&npub_hex, now)
            .map_err(|e| api_error(StatusCode::FORBIDDEN, &format!("attestation: {e}")))?;
        if attested_account != siwe.address {
            return Err(api_error(
                StatusCode::FORBIDDEN,
                "attestation account does not match siwe address",
            ));
        }
    }

    // 4. Consume the single-use nonce (only now, after all free checks pass).
    consume_nonce(&state, &siwe.nonce).await?;

    // 5. Provision: membership + identity binding.
    let was_inserted = state
        .db
        .claim_relay_membership_evm(tenant.community(), &npub_hex, "member")
        .await
        .map_err(|e| internal_error(&format!("evm membership insert: {e}")))?;
    state
        .db
        .upsert_evm_identity(
            tenant.community(),
            &npub_hex,
            siwe.address.as_bytes(),
            request.attestation.as_ref(),
        )
        .await
        .map_err(|e| internal_error(&format!("evm identity upsert: {e}")))?;

    if was_inserted {
        tracing::info!(
            community = %tenant.community(),
            member = %npub_hex,
            evm = %siwe.address,
            "relay member added via SIWE"
        );
        if let Err(e) = publish_nip43_member_added(&tenant, &state, &npub_hex).await {
            tracing::warn!("failed to publish NIP-43 member-added delta after SIWE join: {e}");
        }
        if let Err(e) = publish_nip43_membership_list(&tenant, &state).await {
            tracing::warn!("failed to publish NIP-43 membership list after SIWE join: {e}");
        }
    }

    Ok(Json(json!({
        "status": if was_inserted { "joined" } else { "already_member" },
        "community_id": tenant.community().to_string(),
        "host": tenant.host(),
        "npub": npub_hex,
        "evm_address": siwe.address.to_hex(),
        "role": "member",
    })))
}

/// `POST /auth/siwe/revoke` — soft-revoke an EVM identity binding.
///
/// The caller proves control of the npub via the same Nostr proof format as
/// registration (kind 27235, fresh, `["u", "/auth/siwe/revoke"]` tag, content
/// = the EVM address bound to that npub). On success the binding is marked
/// `revoked_at` and the npub is removed from `relay_members`. The binding
/// row is preserved for audit; a revoked npub cannot re-register.
pub async fn revoke(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let raw_host = headers
        .get(axum::http::header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let tenant = crate::tenant::bind_community(&state.db, raw_host)
        .await
        .map_err(|_| api_error(StatusCode::NOT_FOUND, "unknown_host"))?;

    let request: SiweRevokeRequest = serde_json::from_slice(&body).map_err(|e| {
        api_error(
            StatusCode::BAD_REQUEST,
            &format!("invalid revoke JSON: {e}"),
        )
    })?;

    let npub_hex = request.nostr_proof.pubkey.to_hex();

    // Nostr proof proves control of the npub being revoked, and carries the
    // EVM address bound to it (so a stale/mismatched proof can't revoke a
    // binding whose EVM root differs).
    let proof_address = verify_nostr_proof(&request.nostr_proof, REVOKE_PROOF_URI)
        .map_err(|e| api_error(StatusCode::FORBIDDEN, &format!("nostr_proof: {e}")))?;

    // The binding must exist and must not already be revoked.
    let binding = state
        .db
        .get_evm_identity(tenant.community(), &npub_hex)
        .await
        .map_err(|e| internal_error(&format!("evm identity get: {e}")))?;
    let binding =
        binding.ok_or_else(|| api_error(StatusCode::NOT_FOUND, "evm_identity_not_found"))?;
    if binding.is_revoked() {
        return Err(api_error(
            StatusCode::CONFLICT,
            "evm_identity_already_revoked",
        ));
    }
    let bound_address = EvmAddress::parse(&hex::encode(&binding.evm_address))
        .map_err(|e| internal_error(&format!("stored evm address: {e}")))?;
    if bound_address != proof_address {
        return Err(api_error(
            StatusCode::FORBIDDEN,
            "address mismatch between nostr_proof and bound evm identity",
        ));
    }

    // Soft-revoke the binding and remove relay membership (owner cannot be
    // removed, which is fine — an owner revoking via this path is a misconfig
    // that the admin flow handles separately).
    state
        .db
        .revoke_evm_identity(tenant.community(), &npub_hex, &npub_hex, None)
        .await
        .map_err(|e| internal_error(&format!("evm identity revoke: {e}")))?;

    use buzz_db::relay_members::RemoveResult;
    match state
        .db
        .remove_relay_member(tenant.community(), &npub_hex)
        .await
    {
        Ok(RemoveResult::Removed) | Ok(RemoveResult::NotFound) => {}
        Ok(RemoveResult::IsOwner) => {
            tracing::warn!(community = %tenant.community(), member = %npub_hex,
                "SIWE revoke: binding revoked but membership is owner; kept");
        }
        Ok(RemoveResult::RoleMismatch) => {
            tracing::warn!(community = %tenant.community(), member = %npub_hex,
                "SIWE revoke: membership role changed during revoke");
        }
        Err(e) => {
            return Err(internal_error(&format!("relay member remove: {e}")));
        }
    }

    tracing::info!(
        community = %tenant.community(),
        member = %npub_hex,
        evm = %bound_address,
        "relay member revoked via SIWE"
    );

    Ok(Json(json!({
        "status": "revoked",
        "community_id": tenant.community().to_string(),
        "npub": npub_hex,
        "evm_address": bound_address.to_hex(),
    })))
}

/// Verify the Nostr proof event; returns the EVM address from its content.
///
/// `uri` is the endpoint the proof is bound to (`["u", "<uri>"]` tag):
/// `NOSTR_PROOF_URI` for registration, `REVOKE_PROOF_URI` for revocation.
fn verify_nostr_proof(event: &nostr::Event, uri: &str) -> Result<EvmAddress, String> {
    if event.kind != nostr::Kind::from(NOSTR_PROOF_KIND) {
        return Err(format!("expected kind {NOSTR_PROOF_KIND}"));
    }
    event
        .verify()
        .map_err(|e| format!("bad event signature: {e}"))?;

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs();
    let created = event.created_at.as_secs();
    if now.abs_diff(created) > NOSTR_PROOF_MAX_AGE_SECS {
        return Err("stale created_at".into());
    }

    let has_uri_tag = event.tags.iter().any(|tag| {
        let slice = tag.as_slice();
        slice.len() == 2 && slice[0] == "u" && slice[1] == uri
    });
    if !has_uri_tag {
        return Err(format!("missing [\"u\", \"{uri}\"] tag"));
    }

    EvmAddress::parse(event.content.trim()).map_err(|e| e.to_string())
}

/// Consume a single-use SIWE nonce from Redis (GETDEL).
async fn consume_nonce(state: &AppState, nonce: &str) -> Result<(), (StatusCode, Json<Value>)> {
    let mut conn = state
        .redis_pool
        .get()
        .await
        .map_err(|e| internal_error(&format!("redis pool: {e}")))?;
    let key = format!("{NONCE_KEY_PREFIX}{nonce}");
    let existed: Option<String> = redis::cmd("GETDEL")
        .arg(&key)
        .query_async(&mut conn)
        .await
        .map_err(|e| internal_error(&format!("redis GETDEL nonce: {e}")))?;
    if existed.is_none() {
        return Err(api_error(StatusCode::FORBIDDEN, "nonce_invalid"));
    }
    Ok(())
}

/// Fixed-window per-npub rate limit via Redis INCR/EXPIRE.
async fn rate_limited(state: &AppState, npub_hex: &str) -> Result<bool, (StatusCode, Json<Value>)> {
    let mut conn = state
        .redis_pool
        .get()
        .await
        .map_err(|e| internal_error(&format!("redis pool: {e}")))?;
    let key = format!("siwe:register-rate:{npub_hex}");
    let count: u32 = redis::cmd("INCR")
        .arg(&key)
        .query_async(&mut conn)
        .await
        .map_err(|e| internal_error(&format!("redis INCR: {e}")))?;
    if count == 1 {
        redis::cmd("EXPIRE")
            .arg(&key)
            .arg(RATE_WINDOW_SECS)
            .query_async::<u32>(&mut conn)
            .await
            .map_err(|e| internal_error(&format!("redis EXPIRE: {e}")))?;
    }
    Ok(count > RATE_MAX_ATTEMPTS)
}

/// Lowercase domain without scheme or port (SIWE `domain` comparison form).
fn host_domain(host: &str) -> String {
    let without_scheme = host
        .split("://")
        .nth(1)
        .unwrap_or(host)
        .split('/')
        .next()
        .unwrap_or(host);
    without_scheme
        .split(':')
        .next()
        .unwrap_or(without_scheme)
        .to_lowercase()
}
