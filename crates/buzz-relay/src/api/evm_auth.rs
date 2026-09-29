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
//!   The response also carries `binding_event` — the **unsigned** kind:37017
//!   EVM binding record (the discovery-plane record for "which address holds
//!   this seat") for this bind, or `null` when no attestation accompanied it.
//!   The bound npub signs it and publishes it through the normal event door;
//!   the relay cannot, because authorship by that npub is exactly what ingest
//!   verifies.
//!
//! The whole module is feature-gated on `config.evm_auth` (BUZZ_EVM_AUTH).
//! The routes are always registered; each handler returns 404
//! `SIWE auth not enabled` while the feature is off.

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

/// Nonces one community may mint per [`NONCE_ISSUE_WINDOW_SECS`].
const NONCE_ISSUE_MAX_PER_WINDOW: u32 = 600;
/// Fixed window for [`NONCE_ISSUE_MAX_PER_WINDOW`].
const NONCE_ISSUE_WINDOW_SECS: u64 = 60;
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
    /// Optional NIP-05 alias to claim for this npub (e.g. `alice` → resolved as
    /// `alice@<relay-host>`). Validated against the tenant host and stored in
    /// `users` so `/.well-known/nostr.json` resolves it even before a kind:0
    /// profile exists.
    #[serde(default)]
    pub nip05_handle: Option<String>,
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
///
/// The response also carries the `domain` and `chain_id` the relay will require
/// inside the message, so a client builds the EIP-4361 payload from
/// relay-supplied values instead of guessing from `window.location` (whose host
/// carries a port that [`host_domain`] strips) or hardcoding mainnet.
pub async fn issue_nonce(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let evm_config = state
        .config
        .evm_auth
        .as_ref()
        .ok_or_else(|| api_error(StatusCode::NOT_FOUND, "SIWE auth not enabled"))?;

    // Row zero: a nonce belongs to one community's host, exactly like the
    // register call that consumes it — an unknown host fails closed.
    let raw_host = headers
        .get(axum::http::header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let tenant = crate::tenant::bind_community(&state.db, raw_host)
        .await
        .map_err(|_| api_error(StatusCode::NOT_FOUND, "unknown_host"))?;

    let mut conn = state
        .redis_pool
        .get()
        .await
        .map_err(|e| internal_error(&format!("redis pool: {e}")))?;

    // The endpoint is unauthenticated and every nonce is a Redis key that lives
    // for NONCE_TTL_SECS, so cap how many one community can mint per window.
    // This bounds Redis memory; it is a community-wide cap, not per client (the
    // relay has no trusted client-address source here), so a flood can slow
    // logins but never exhaust the store.
    let issue_key = format!("siwe:nonce-issue:{}", tenant.community());
    // One atomic EVAL: the increment and the window TTL arm (or repair) run
    // together, so no failure path can leave `issue_key` TTL-less — the old
    // INCR-then-EXPIRE pair could (an EXPIRE error after the INCR stuck), and
    // a TTL-less counter past the cap rate-limited the community forever.
    let issued: u32 = bump_fixed_window(&mut conn, &issue_key, NONCE_ISSUE_WINDOW_SECS)
        .await
        .map_err(|e| internal_error(&format!("redis nonce issue window: {e}")))?;
    if issued > NONCE_ISSUE_MAX_PER_WINDOW {
        return Err(api_error(StatusCode::TOO_MANY_REQUESTS, "rate_limited"));
    }

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
        "domain": host_domain(tenant.host()),
        "chain_id": evm_config.chain_id,
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

    if state.config.evm_auth.is_none() {
        return Err(api_error(StatusCode::NOT_FOUND, "SIWE auth not enabled"));
    }
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
    //     are rejected rather than silently dropped. The verified envelope is
    //     kept — it is the authenticity proof of the kind:37017 binding record
    //     this handler hands back for the caller to sign (ingest re-verifies it
    //     against that record's author, so an unverifiable record would never
    //     land: see `handlers::ingest::validate_evm_binding_envelope`).
    let mut verified_attestation: Option<buzz_evm_auth::AttestationEnvelope> = None;
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
        verified_attestation = Some(envelope);
    }

    // 3d. If a NIP-05 alias was claimed, validate it against the tenant host
    //     and bind it to this npub in `users`. Reused by the existing NIP-05
    //     endpoint with zero new lookup code.
    let nip05_handle = match &request.nip05_handle {
        Some(raw) if !raw.trim().is_empty() => {
            let canonical =
                crate::api::nip05::canonicalize_nip05(raw, tenant.host()).map_err(|e| {
                    api_error(StatusCode::BAD_REQUEST, &format!("bad nip05_handle: {e}"))
                })?;
            Some(canonical)
        }
        _ => None,
    };

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

    // 5b. Bind the claimed NIP-05 alias (if any) so the NIP-05 endpoint
    //     resolves it even before a kind:0 profile exists.
    if let Some(handle) = &nip05_handle {
        let pubkey_bytes =
            hex::decode(&npub_hex).map_err(|e| internal_error(&format!("npub hex: {e}")))?;
        state
            .db
            .set_user_nip05(tenant.community(), &pubkey_bytes, Some(handle))
            .await
            .map_err(|e| internal_error(&format!("nip05 alias insert: {e}")))?;
    }

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

    // 5c. Hand the caller the unsigned kind:37017 binding record for the
    //     binding this call just created. The record must be AUTHORED BY THE
    //     BOUND NPUB — authorship is the proof ingest checks — and the relay
    //     holds no user secret key (unlike the NIP-43 membership list it signs
    //     with `relay_keypair`), so publishing it internally is not an option:
    //     the client signs this skeleton and publishes it through the normal
    //     event door. `null` when no attestation accompanied the bind: ingest
    //     requires it for a live record, so emitting one would hand the client
    //     an event that can only be rejected.
    let binding_event = binding_event_skeleton(
        siwe.address,
        &request.message,
        verified_attestation
            .as_ref()
            .zip(request.attestation.as_ref()),
        Utc::now().timestamp(),
    );

    Ok(Json(json!({
        "status": if was_inserted { "joined" } else { "already_member" },
        "community_id": tenant.community().to_string(),
        "host": tenant.host(),
        "npub": npub_hex,
        "evm_address": siwe.address.to_hex(),
        "role": "member",
        "binding_event": binding_event,
    })))
}

/// Build the unsigned kind:37017 EVM binding record for a successful
/// `POST /auth/siwe/register`, or `None` when no verified attestation came
/// with the bind.
///
/// **Why the relay returns an unsigned skeleton instead of publishing**: the
/// record claims "this npub holds this address", and ingest verifies the
/// EIP-712 attestation against the event's signer — so the bound npub itself
/// must sign it. The relay never holds that secret key (its `relay_keypair`
/// only signs relay-authored events such as the NIP-43 membership list), so an
/// internally published record would fail the very check that makes the record
/// worth reading. The client signs `kind`/`created_at`/`tags`/`content` as-is
/// and publishes; a signed copy passes
/// `handlers::ingest::validate_evm_binding_envelope` (exercised by
/// `signed_binding_event_lands_at_ingest` below).
///
/// `siweMessageHash` is the EIP-191 `personal_sign` digest of the SIWE message
/// the relay just verified — a commitment a client holding the message can
/// re-derive; ingest checks its shape, not its provenance.
fn binding_event_skeleton(
    address: EvmAddress,
    siwe_message: &str,
    attestation: Option<(&buzz_evm_auth::AttestationEnvelope, &Value)>,
    created_at: i64,
) -> Option<Value> {
    let (envelope, attestation_json) = attestation?;
    let address_hex = address.to_hex();
    let siwe_message_hash = format!(
        "0x{}",
        hex::encode(buzz_evm_auth::personal_sign_digest(siwe_message.as_bytes(),))
    );
    let content = json!({
        "v": 1,
        "address": address_hex,
        "siweMessageHash": siwe_message_hash,
        "attestation": attestation_json,
    });
    let content = serde_json::to_string(&content).ok()?;
    Some(json!({
        // Unsigned: the client's signer fills in `pubkey`, `id`, and `sig`.
        "kind": buzz_core::kind::KIND_EVM_BINDING,
        "created_at": created_at,
        "tags": [
            ["d", &address_hex],
            ["address", &address_hex],
            ["chain", envelope.domain.chain_id.to_string()],
        ],
        "content": content,
    }))
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
    if state.config.evm_auth.is_none() {
        return Err(api_error(StatusCode::NOT_FOUND, "SIWE auth not enabled"));
    }
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

/// Lua for [`bump_fixed_window`]: `INCR` and the window `EXPIRE` run in ONE
/// atomic script, so no failure path can leave a counter key without a TTL.
/// The `TTL < 0` branch also repairs keys left TTL-less by the old
/// INCR-then-EXPIRE code — such a key gets a fresh window and then expires
/// normally instead of holding its community past the cap forever.
const BUMP_FIXED_WINDOW_LUA: &str = r"
local v = redis.call('INCR', KEYS[1])
if v == 1 or redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return v
";

/// The single `EVAL` command behind [`bump_fixed_window`].
fn bump_fixed_window_cmd(key: &str, window_secs: u64) -> redis::Cmd {
    let mut cmd = redis::cmd("EVAL");
    cmd.arg(BUMP_FIXED_WINDOW_LUA)
        .arg(1)
        .arg(key)
        .arg(window_secs);
    cmd
}

/// Atomically bump a fixed-window counter at `key`, arming (or repairing) its
/// `window_secs` TTL in the same script. Returns the post-increment value.
async fn bump_fixed_window<C: redis::aio::ConnectionLike>(
    conn: &mut C,
    key: &str,
    window_secs: u64,
) -> redis::RedisResult<u32> {
    bump_fixed_window_cmd(key, window_secs)
        .query_async::<u32>(conn)
        .await
}

/// Fixed-window per-npub rate limit backed by [`bump_fixed_window`] (same
/// wedge-proof atomic increment + window TTL as the community nonce cap).
async fn rate_limited(state: &AppState, npub_hex: &str) -> Result<bool, (StatusCode, Json<Value>)> {
    let mut conn = state
        .redis_pool
        .get()
        .await
        .map_err(|e| internal_error(&format!("redis pool: {e}")))?;
    let key = format!("siwe:register-rate:{npub_hex}");
    let count: u32 = bump_fixed_window(&mut conn, &key, RATE_WINDOW_SECS)
        .await
        .map_err(|e| internal_error(&format!("redis register rate window: {e}")))?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use k256::ecdsa::SigningKey;
    use nostr::{EventBuilder, Keys, Kind, Tag, Timestamp};

    /// Checksum-cased anvil account #0 — the address `register` verified.
    const TEST_ADDRESS: &str = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
    /// anvil account #0's private key: its address *is* [`TEST_ADDRESS`], so
    /// attestations signed with it recover to the bound account.
    const TEST_EVM_KEY: &str = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
    /// A canonical SIWE message (the relay verified it before reaching 3c).
    const TEST_SIWE_MESSAGE: &str =
        "example.com wants you to sign in with your Ethereum account:\n\nSign in to Buzz\n\nChain ID: 8453";
    /// Far-future expiry so fixtures never age out from under the test.
    const NOT_EXPIRED: u64 = 4_102_444_800;

    /// The secp256k1 key behind [`TEST_ADDRESS`].
    fn test_evm_key() -> SigningKey {
        SigningKey::from_slice(&hex::decode(TEST_EVM_KEY).expect("hex")).expect("secp256k1 key")
    }

    /// The window bump is ONE atomic `EVAL`: increment and TTL (re)arm travel
    /// in a single command, so no failure path can leave a counter key without
    /// a TTL (the old INCR-then-EXPIRE wedge), and the script repairs keys the
    /// old code already left TTL-less.
    #[test]
    fn bump_fixed_window_is_one_atomic_eval_with_ttl_repair() {
        let packed = bump_fixed_window_cmd("siwe:nonce-issue:test", 60).get_packed_command();
        let text = String::from_utf8(packed).expect("RESP is UTF-8");
        // One command, five argv slots: EVAL <lua> 1 <key> <window>.
        assert!(text.starts_with("*5\r\n"), "single EVAL command: {text:?}");
        // Increment and TTL arm share the one script ...
        assert!(text.contains("redis.call('INCR'"), "{text:?}");
        assert!(text.contains("redis.call('EXPIRE'"), "{text:?}");
        // ... and a counter left TTL-less (TTL < 0) is repaired, not just the
        // freshly created key (v == 1).
        assert!(text.contains("redis.call('TTL'"), "{text:?}");
        assert!(text.contains("siwe:nonce-issue:test"), "{text:?}");
        assert!(text.contains("\r\n60\r\n"), "window arg: {text:?}");
    }

    /// Recovery property (live Redis: `REDIS_URL` or `redis://127.0.0.1:6379`;
    /// run with `cargo test -p buzz-relay -- --ignored`): a counter left
    /// TTL-less — exactly what the old INCR-then-EXPIRE failure produced — has
    /// its window TTL repaired on the next bump and then expires with the
    /// window instead of rate-limiting its community forever.
    #[tokio::test]
    #[ignore = "needs a live Redis (REDIS_URL or redis://127.0.0.1:6379)"]
    async fn bump_fixed_window_repairs_a_ttl_less_counter() {
        let url =
            std::env::var("REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1:6379".to_string());
        let pool = deadpool_redis::Config::from_url(&url)
            .create_pool(Some(deadpool_redis::Runtime::Tokio1))
            .expect("redis pool");
        let mut conn = pool.get().await.expect("redis connection");
        let key = format!("siwe:test-window:{}", uuid::Uuid::new_v4().simple());
        // Wedge exactly what the old bug left behind: a counter with no TTL.
        redis::cmd("SET")
            .arg(&key)
            .arg(41)
            .query_async::<()>(&mut conn)
            .await
            .expect("seed wedge");
        let issued = bump_fixed_window(&mut conn, &key, 60)
            .await
            .expect("bump");
        assert_eq!(issued, 42, "counter keeps counting across the repair");
        let ttl: i64 = redis::cmd("TTL")
            .arg(&key)
            .query_async(&mut conn)
            .await
            .expect("ttl");
        assert!((1..=60).contains(&ttl), "wedged counter re-armed: ttl={ttl}");
        redis::cmd("DEL")
            .arg(&key)
            .query_async::<()>(&mut conn)
            .await
            .expect("cleanup");
    }

    /// An EIP-712 `NostrSigner` attestation for `npub`, signed by `key`, in
    /// both forms register sees it: the typed envelope and the raw JSON the
    /// record carries.
    fn attestation_for(
        key: &SigningKey,
        npub: &nostr::PublicKey,
        account: &str,
        chain_id: u64,
    ) -> (buzz_evm_auth::AttestationEnvelope, Value) {
        let attestation = buzz_evm_auth::NostrSignerAttestation {
            account: EvmAddress::parse(account).expect("address parses"),
            npub: npub.to_bytes(),
            expires: NOT_EXPIRED,
            nonce: 0,
        };
        let domain = buzz_evm_auth::Eip712Domain {
            name: "creabuzz".into(),
            version: "1".into(),
            chain_id,
            verifying_contract: EvmAddress::from_bytes([0u8; 20]),
        };
        let digest = attestation.digest(&domain);
        let (signature, recid) = key
            .sign_prehash_recoverable(&digest)
            .expect("attestation signs");
        let mut bytes = signature.to_bytes().to_vec();
        bytes.push(if recid.is_y_odd() { 28 } else { 27 });
        let envelope = buzz_evm_auth::AttestationEnvelope {
            attestation,
            domain,
            signature: hex::encode(bytes),
        };
        let raw = serde_json::to_value(&envelope).expect("envelope serializes");
        (envelope, raw)
    }

    /// Sign the returned skeleton exactly the way a client would.
    fn sign_skeleton(skeleton: &Value, keys: &Keys) -> nostr::Event {
        let kind = skeleton["kind"].as_u64().expect("kind") as u16;
        let created_at = skeleton["created_at"].as_i64().expect("created_at") as u64;
        let content = skeleton["content"]
            .as_str()
            .expect("content is the Nostr content string")
            .to_string();
        let tags: Vec<Tag> = skeleton["tags"]
            .as_array()
            .expect("tags array")
            .iter()
            .map(|row| {
                Tag::parse(
                    row.as_array()
                        .expect("tag row")
                        .iter()
                        .map(|cell| cell.as_str().expect("tag cell")),
                )
                .expect("tag parses")
            })
            .collect();
        EventBuilder::new(Kind::Custom(kind), content)
            .tags(tags)
            .custom_created_at(Timestamp::from_secs(created_at))
            .sign_with_keys(keys)
            .expect("client signs the skeleton")
    }

    /// The register → record path: whatever `register` hands back must be
    /// publishable as-is (bind the production seam — the same function the
    /// relay runs at ingest), and signing it with any other key must not be.
    #[test]
    fn signed_binding_event_lands_at_ingest() {
        let keys = Keys::generate();
        let evm_key = test_evm_key();
        let address = EvmAddress::parse(TEST_ADDRESS).expect("address");
        let (envelope, raw) = attestation_for(&evm_key, &keys.public_key(), TEST_ADDRESS, 8453);

        let skeleton = binding_event_skeleton(
            address,
            TEST_SIWE_MESSAGE,
            Some((&envelope, &raw)),
            1_790_000_000,
        )
        .expect("an attested bind yields a skeleton");

        // The contract a client consumes: kind, canonical `d`, a chain tag
        // matching the attestation domain, and content the relay verified.
        assert_eq!(
            skeleton["kind"].as_u64(),
            Some(u64::from(buzz_core::kind::KIND_EVM_BINDING))
        );
        assert_eq!(
            skeleton["tags"][0],
            serde_json::json!(["d", address.to_hex()]),
            "`d` must be the lowercase address (the NIP-33 coordinate)"
        );
        assert_eq!(
            skeleton["tags"][2],
            serde_json::json!(["chain", "8453"]),
            "the chain tag must equal the signed attestation domain chain"
        );
        let content: Value =
            serde_json::from_str(skeleton["content"].as_str().expect("content string"))
                .expect("content is JSON");
        assert_eq!(content["v"], serde_json::json!(1));
        assert_eq!(content["address"], serde_json::json!(address.to_hex()));
        assert_eq!(
            content["siweMessageHash"],
            serde_json::json!(format!(
                "0x{}",
                hex::encode(buzz_evm_auth::personal_sign_digest(
                    TEST_SIWE_MESSAGE.as_bytes()
                ))
            )),
            "siweMessageHash is the EIP-191 digest of the verified message"
        );
        assert_eq!(content["attestation"], raw);

        let event = sign_skeleton(&skeleton, &keys);
        assert!(
            crate::handlers::ingest::validate_evm_binding_envelope(&event).is_ok(),
            "the signed skeleton must pass the ingest envelope"
        );

        // The spoof the seam exists for: another npub signing the same
        // skeleton inherits an attestation that authorizes a different key.
        let other = Keys::generate();
        let spoofed = sign_skeleton(&skeleton, &other);
        let err = crate::handlers::ingest::validate_evm_binding_envelope(&spoofed)
            .expect_err("a foreign signer must not be able to publish the binding");
        assert!(
            err.contains("npub"),
            "the rejection must name the authorship failure, got {err:?}"
        );
    }

    /// Without a verified attestation there is nothing to publish: emitting a
    /// record anyway would hand the client an event ingest must reject.
    #[test]
    fn no_attestation_means_no_binding_event() {
        let address = EvmAddress::parse(TEST_ADDRESS).expect("address");
        assert!(
            binding_event_skeleton(address, TEST_SIWE_MESSAGE, None, 1_790_000_000).is_none(),
            "register must return a null binding_event when no attestation came with the bind"
        );
    }

    /// Register can only hand back a record that will land — including when
    /// the caller is about to revoke rather than activate.
    #[test]
    fn a_skeleton_never_carries_a_revocation() {
        let keys = Keys::generate();
        let evm_key = test_evm_key();
        let address = EvmAddress::parse(TEST_ADDRESS).expect("address");
        let (envelope, raw) = attestation_for(&evm_key, &keys.public_key(), TEST_ADDRESS, 8453);
        let skeleton =
            binding_event_skeleton(address, TEST_SIWE_MESSAGE, Some((&envelope, &raw)), 1)
                .expect("skeleton");
        let content: Value = serde_json::from_str(skeleton["content"].as_str().expect("content"))
            .expect("content is JSON");
        assert!(
            content.get("revoked").is_none(),
            "a fresh bind publishes a live record; revocation is a separate republication"
        );
    }
}
