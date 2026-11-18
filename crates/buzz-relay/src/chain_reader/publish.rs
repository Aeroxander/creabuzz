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

/// Sign `content` as the relay, replace the project's earlier record, and send
/// it to live subscribers when it was stored. Returns the event id.
pub async fn publish(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    tags: Vec<Tag>,
    d_tag: &str,
    content: &Value,
    created_at: u64,
) -> anyhow::Result<[u8; 32]> {
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
    if inserted {
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
    }
    Ok(event.id.to_bytes())
}
