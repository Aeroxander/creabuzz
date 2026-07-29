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
        "SELECT pubkey, evm_address, attestation, created_at, updated_at \
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
        "SELECT pubkey, evm_address, attestation, created_at, updated_at \
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
