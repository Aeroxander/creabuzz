//! The server's reads behind tasks open to anyone and manager agents (see `launch_update_authority`).
//!
//! - [`stored_takes`]: who has a task open to anyone, from its stored `take`, `give-up` and `cancel` steps.
//! - [`enforce_take_caps`]: a few takes a day per account; a refused take is not stored, so it uses no room.
//! - [`is_manager_agent`]: an account on record as an agent whose stored profile says `["agent-role", "manager"]`.
//!
//! A lookup that fails is a server fault and refuses the write: an outage never lets a record past the check.

use std::sync::Arc;

use buzz_core::kind::{KIND_LAUNCH_UPDATE, KIND_PROFILE};
use buzz_core::tenant::CommunityId;
use nostr::Event;

use super::agent_label::{role_of, AgentRole};
use super::ingest::IngestError;
use super::launch_update_authority::{
    internal, is_agent_account, read_takes, TakeFacts, TaskPart, TAKING_TOO_MUCH,
};
use crate::state::AppState;

/// The most steps of one task read to learn who has it. A take is refused while one is live and a taker who gave up
/// cannot take again, so a task holds about one take per person who ever gave it up; past this bound the newest are
/// read, and the record of who took it first may be cut (the report of milestone 8 says so).
const STEPS_READ: i64 = 200;

/// What the stored steps of the task `task_id` say about who has it, for the record `signer` is writing.
pub(crate) async fn stored_takes(
    state: &Arc<AppState>,
    community: CommunityId,
    task_id: &[u8; 32],
    signer: &str,
) -> Result<TakeFacts, IngestError> {
    let stored = state
        .db
        .query_events_for_event_write(&buzz_db::EventQuery {
            kinds: Some(vec![KIND_LAUNCH_UPDATE as i32]),
            tag_filters: vec![
                ("task".to_string(), vec![hex::encode(task_id)]),
                (
                    "task-part".to_string(),
                    vec!["take".into(), "give-up".into(), "cancel".into()],
                ),
            ],
            global_only: true,
            limit: Some(STEPS_READ),
            ..buzz_db::EventQuery::for_community(community)
        })
        .await
        .map_err(|e| internal("reading who took the task", e))?;
    let steps: Vec<(String, u64, String, TaskPart)> = stored
        .iter()
        .filter_map(|record| {
            let event = &record.event;
            let part = event.tags.iter().find_map(|tag| {
                let fields = tag.as_slice();
                (fields.first().map(String::as_str) == Some("task-part"))
                    .then(|| fields.get(1).and_then(|value| TaskPart::parse(value)))
                    .flatten()
            })?;
            Some((
                event.pubkey.to_hex(),
                event.created_at.as_secs(),
                event.id.to_hex(),
                part,
            ))
        })
        .collect();
    Ok(read_takes(&steps, signer))
}

/// Hold one account to `per_day` takes in 24 hours, counted by the server's receive time.
pub(crate) async fn enforce_take_caps(
    state: &Arc<AppState>,
    community: CommunityId,
    event: &Event,
    per_day: i64,
) -> Result<(), IngestError> {
    let today = state
        .db
        .count_tagged_events_received_since(
            community,
            &event.pubkey.to_bytes(),
            &[KIND_LAUNCH_UPDATE as i32],
            &[("task-part", "take")],
            Some(chrono::Utc::now() - chrono::Duration::hours(24)),
        )
        .await
        .map_err(|e| internal("counting tasks taken today", e))?;
    if today >= per_day {
        return Err(IngestError::Rejected(TAKING_TOO_MUCH.into()));
    }
    Ok(())
}

/// Whether `account` is a manager agent: on record as an agent (someone runs it) and its stored profile says so.
pub(crate) async fn is_manager_agent(
    state: &Arc<AppState>,
    community: CommunityId,
    account: &[u8; 32],
) -> Result<bool, IngestError> {
    if !is_agent_account(state, community, account).await? {
        return Ok(false);
    }
    Ok(stored_role(state, community, account).await? == Some(AgentRole::Manager))
}

/// The role the account's stored profile (kind 0) gives it, if it is labelled.
pub(crate) async fn stored_role(
    state: &Arc<AppState>,
    community: CommunityId,
    account: &[u8; 32],
) -> Result<Option<AgentRole>, IngestError> {
    let profile = state
        .db
        .query_events_for_event_write(&buzz_db::EventQuery {
            kinds: Some(vec![KIND_PROFILE as i32]),
            pubkey: Some(account.to_vec()),
            limit: Some(1),
            ..buzz_db::EventQuery::for_community(community)
        })
        .await
        .map_err(|e| internal("reading the account's profile", e))?
        .into_iter()
        .next();
    Ok(profile.and_then(|stored| role_of(&stored.event)))
}
