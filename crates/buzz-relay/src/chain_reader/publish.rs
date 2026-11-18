//! Sign and store one "project numbers" record (kind 39009).

use std::sync::Arc;

use anyhow::Context;
use buzz_core::kind::{event_kind_u32, KIND_PROJECT_NUMBERS};
use buzz_core::tenant::TenantContext;
use nostr::{EventBuilder, Kind, Tag, Timestamp};
use serde_json::Value;

use crate::handlers::event::dispatch_persistent_event;
use crate::state::AppState;

/// The tags of a record: `d` = the project's key, plus the chain and the
/// Launcher so a reader of the record can tell which deployment it describes.
pub fn tags(key_hex: &str, chain_id: u64, launcher_hex: &str) -> anyhow::Result<Vec<Tag>> {
    Ok(vec![
        Tag::parse(["d", key_hex])?,
        Tag::parse(["chain", &chain_id.to_string()])?,
        Tag::parse(["launcher", launcher_hex])?,
    ])
}

/// What happened to a signed record.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// It is the project's stored record now (its id).
    Stored([u8; 32]),
    /// A newer record for the project is stored (another writer's, or one
    /// signed with a clock ahead of this one): this one was not kept. Holds
    /// the stored record's `created_at` (review F6).
    Superseded(u64),
}

/// Sign `content` as the relay, replace the project's earlier record, and send
/// it to live subscribers when it was stored.
pub async fn publish(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    tags: Vec<Tag>,
    d_tag: &str,
    content: &Value,
    created_at: u64,
) -> anyhow::Result<Outcome> {
    let event = EventBuilder::new(
        Kind::Custom(KIND_PROJECT_NUMBERS as u16),
        content.to_string(),
    )
    .tags(tags)
    .custom_created_at(Timestamp::from(created_at))
    .sign_with_keys(&state.relay_keypair)
    .context("sign the project numbers record")?;
    let (stored, inserted) = state
        .db
        .replace_parameterized_event(tenant.community(), &event, d_tag, None)
        .await
        .context("store the project numbers record")?;
    if !inserted {
        // Not stored: either this very record is already the live one (a
        // repeat), or a newer one is. The store answers both with the
        // incoming event, so look at the live record itself.
        let live: Option<(chrono::DateTime<chrono::Utc>, Vec<u8>)> = sqlx::query_as(
            "SELECT created_at, id FROM events \
             WHERE community_id = $1 AND kind = $2 AND pubkey = $3 AND d_tag = $4 \
               AND deleted_at IS NULL \
             ORDER BY created_at DESC, id ASC LIMIT 1",
        )
        .bind(tenant.community().as_uuid())
        .bind(KIND_PROJECT_NUMBERS as i32)
        .bind(event.pubkey.to_bytes().as_slice())
        .bind(d_tag)
        .fetch_optional(state.db.pool())
        .await
        .context("read the stored project numbers record")?;
        return match live {
            Some((_, id)) if id.as_slice() == event.id.as_bytes().as_slice() => {
                Ok(Outcome::Stored(event.id.to_bytes()))
            }
            Some((at, _)) => Ok(Outcome::Superseded(
                u64::try_from(at.timestamp()).context("stored record before 1970")?,
            )),
            None => anyhow::bail!("the project numbers record was refused"),
        };
    }
    let relay_pubkey = state.relay_keypair.public_key().to_hex();
    dispatch_persistent_event(
        tenant,
        state,
        &stored,
        event_kind_u32(&stored.event),
        &relay_pubkey,
        None,
    )
    .await;
    Ok(Outcome::Stored(event.id.to_bytes()))
}
