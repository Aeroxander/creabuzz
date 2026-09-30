//! EVM identity bindings (creabuzz): community-scoped npub ↔ EVM account map.
//!
//! The `evm_identities` table mirrors `relay_members` conventions: every read
//! and write is bound to one `community_id`; `pubkey` is a 64-char lowercase
//! hex Nostr pubkey; `evm_address` is the 20-byte EVM root account. One EVM
//! account may back several device npubs; each npub has exactly one root.

use chrono::{DateTime, Utc};
use sqlx::{PgPool, Row as _};

use crate::error::Result;
use crate::CommunityId;

/// A single EVM identity binding record.
#[derive(Debug, Clone)]
pub struct EvmIdentity {
    /// 64-char lowercase hex Nostr pubkey (device key).
    pub pubkey: String,
    /// 20-byte EVM root account address.
    pub evm_address: Vec<u8>,
    /// Optional EIP-712 `NostrSigner` attestation payload (when provided).
    pub attestation: Option<serde_json::Value>,
    /// When the binding was created.
    pub created_at: DateTime<Utc>,
    /// When the binding was last updated.
    pub updated_at: DateTime<Utc>,
    /// Set when the binding was soft-revoked via `POST /auth/siwe/revoke`.
    pub revoked_at: Option<DateTime<Utc>>,
    /// npub (hex) or admin actor that revoked the binding.
    pub revoked_by: Option<String>,
    /// Optional human-readable revocation reason.
    pub revoked_reason: Option<String>,
}

impl EvmIdentity {
    /// Whether this binding has been soft-revoked.
    pub fn is_revoked(&self) -> bool {
        self.revoked_at.is_some()
    }
}

/// Insert or refresh the binding `pubkey` → `evm_address` in `community`.
pub async fn upsert_evm_identity(
    pool: &PgPool,
    community: CommunityId,
    pubkey: &str,
    evm_address: &[u8; 20],
    attestation: Option<&serde_json::Value>,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO evm_identities (community_id, pubkey, evm_address, attestation) \
         VALUES ($1, $2, $3, $4) \
         ON CONFLICT (community_id, pubkey) DO UPDATE \
         SET evm_address = EXCLUDED.evm_address, \
             attestation = EXCLUDED.attestation, \
             updated_at = now()",
    )
    .bind(community.as_uuid())
    .bind(pubkey)
    .bind(evm_address.as_slice())
    .bind(attestation)
    .execute(pool)
    .await?;
    Ok(())
}

/// Fetch the binding for `pubkey` in `community`, if any.
pub async fn get_evm_identity(
    pool: &PgPool,
    community: CommunityId,
    pubkey: &str,
) -> Result<Option<EvmIdentity>> {
    let row = sqlx::query(
        "SELECT pubkey, evm_address, attestation, created_at, updated_at, \
                revoked_at, revoked_by, revoked_reason \
         FROM evm_identities WHERE community_id = $1 AND pubkey = $2",
    )
    .bind(community.as_uuid())
    .bind(pubkey)
    .fetch_optional(pool)
    .await?;

    row.map(|r| -> std::result::Result<EvmIdentity, sqlx::Error> {
        Ok(EvmIdentity {
            pubkey: r.try_get("pubkey")?,
            evm_address: r.try_get("evm_address")?,
            attestation: r.try_get("attestation")?,
            created_at: r.try_get("created_at")?,
            updated_at: r.try_get("updated_at")?,
            revoked_at: r.try_get("revoked_at")?,
            revoked_by: r.try_get("revoked_by")?,
            revoked_reason: r.try_get("revoked_reason")?,
        })
    })
    .transpose()
    .map_err(crate::error::DbError::from)
}

/// List all device-npub bindings for one EVM root account in `community`.
pub async fn list_identities_for_address(
    pool: &PgPool,
    community: CommunityId,
    evm_address: &[u8; 20],
) -> Result<Vec<EvmIdentity>> {
    let rows = sqlx::query(
        "SELECT pubkey, evm_address, attestation, created_at, updated_at, \
                revoked_at, revoked_by, revoked_reason \
         FROM evm_identities WHERE community_id = $1 AND evm_address = $2 \
         ORDER BY created_at ASC",
    )
    .bind(community.as_uuid())
    .bind(evm_address.as_slice())
    .fetch_all(pool)
    .await?;

    rows.into_iter()
        .map(|r| -> std::result::Result<EvmIdentity, sqlx::Error> {
            Ok(EvmIdentity {
                pubkey: r.try_get("pubkey")?,
                evm_address: r.try_get("evm_address")?,
                attestation: r.try_get("attestation")?,
                created_at: r.try_get("created_at")?,
                updated_at: r.try_get("updated_at")?,
                revoked_at: r.try_get("revoked_at")?,
                revoked_by: r.try_get("revoked_by")?,
                revoked_reason: r.try_get("revoked_reason")?,
            })
        })
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(crate::error::DbError::from)
}

/// SIWE variant of `claim_relay_membership`: identical semantics but
/// `added_by = 'evm_siwe'` so the admission source is auditable.
/// Returns `true` when the member row was newly inserted.
pub async fn claim_relay_membership_evm(
    pool: &PgPool,
    community: CommunityId,
    pubkey: &str,
    role: &str,
) -> Result<bool> {
    let result = sqlx::query(
        "INSERT INTO relay_members (community_id, pubkey, role, added_by) \
         VALUES ($1, $2, $3, 'evm_siwe') \
         ON CONFLICT (community_id, pubkey) DO NOTHING",
    )
    .bind(community.as_uuid())
    .bind(pubkey)
    .bind(role)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() > 0)
}

/// Soft-revoke the binding `pubkey` → `evm_address` in `community`.
///
/// Sets `revoked_at`, `revoked_by`, and an optional reason. Idempotent:
/// revoking an already-revoked binding is a no-op success. Returns `true`
/// when a binding row was actually updated (i.e. it existed and was not
/// already revoked).
pub async fn revoke_evm_identity(
    pool: &PgPool,
    community: CommunityId,
    pubkey: &str,
    revoked_by: &str,
    reason: Option<&str>,
) -> Result<bool> {
    let result = sqlx::query(
        "UPDATE evm_identities \
         SET revoked_at = now(), revoked_by = $3, \
             revoked_reason = COALESCE($4, revoked_reason), \
             updated_at = now() \
         WHERE community_id = $1 AND pubkey = $2 AND revoked_at IS NULL",
    )
    .bind(community.as_uuid())
    .bind(pubkey)
    .bind(revoked_by)
    .bind(reason)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() > 0)
}

/// Whether the binding `pubkey` in `community` exists and is soft-revoked.
///
/// Returns `Ok(None)` when no binding exists, `Ok(Some(true))` when revoked,
/// `Ok(Some(false))` when present but active.
pub async fn is_evm_identity_revoked(
    pool: &PgPool,
    community: CommunityId,
    pubkey: &str,
) -> Result<Option<bool>> {
    let row = sqlx::query(
        "SELECT (revoked_at IS NOT NULL) AS revoked \
         FROM evm_identities WHERE community_id = $1 AND pubkey = $2",
    )
    .bind(community.as_uuid())
    .bind(pubkey)
    .fetch_optional(pool)
    .await?;

    match row {
        None => Ok(None),
        Some(r) => {
            let revoked: bool = r.try_get("revoked")?;
            Ok(Some(revoked))
        }
    }
}

/// Re-activate a previously revoked binding (clears `revoked_at`).
///
/// Returns `true` when a row was updated. Used by a future re-register path
/// to re-bind a fresh device npub under the same EVM account.
pub async fn unrevoke_evm_identity(
    pool: &PgPool,
    community: CommunityId,
    pubkey: &str,
) -> Result<bool> {
    let result = sqlx::query(
        "UPDATE evm_identities \
         SET revoked_at = NULL, revoked_by = NULL, revoked_reason = NULL, \
             updated_at = now() \
         WHERE community_id = $1 AND pubkey = $2 AND revoked_at IS NOT NULL",
    )
    .bind(community.as_uuid())
    .bind(pubkey)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() > 0)
}
