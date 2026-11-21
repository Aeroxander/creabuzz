//! The server's reads behind tasks open to anyone and manager agents (see `launch_update_authority`).
//!
//! - [`stored_takes`]: who has a task open to anyone, from its stored `take`, `give-up` and `cancel` steps.
//! - [`stored_pay_to`]: the wallet a worker named on their own `take` and `accept` steps of a task.
//! - [`enforce_take_caps`]: a few takes a day per account; a refused take is not stored, so it uses no room.
//! - [`is_manager_agent`]: an account on record as an agent whose stored profile says `["agent-role", "manager"]`.
//!
//! A lookup that fails is a server fault and refuses the write: an outage never lets a record past the check.

use std::collections::HashSet;
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

/// The most takes and give-ups of one task read to learn who has it. A take is refused while one is live and a taker
/// who gave up cannot take again, so a task holds about one take per person who ever gave it up; past this bound the
/// newest are read, and the record of who took it first may be cut (the report of milestone 8 says so). A cancel and
/// the signer's own steps are read apart, so crowding cannot push them out.
const STEPS_READ: i64 = 200;

/// The most cancel steps of one task read: any one of them ends it.
const CANCELS_READ: i64 = 5;
/// The most of one account's own steps of one task read: its give-up is final for it.
const OWN_STEPS_READ: i64 = 50;

/// What the stored steps of the task `task_id` say about who has it, for the record `signer` is writing.
///
/// Three reads, so that crowding cannot hide what decides the answer: the newest [`STEPS_READ`] takes and give-ups, a
/// cancel step wherever it sits, and the signer's own steps wherever they sit. Steps found twice count once.
pub(crate) async fn stored_takes(
    state: &Arc<AppState>,
    community: CommunityId,
    task_id: &[u8; 32],
    signer: &str,
) -> Result<TakeFacts, IngestError> {
    let read = |parts: &[&str], pubkey: Option<Vec<u8>>, limit: i64| {
        let query = buzz_db::EventQuery {
            kinds: Some(vec![KIND_LAUNCH_UPDATE as i32]),
            pubkey,
            tag_filters: vec![
                ("task".to_string(), vec![hex::encode(task_id)]),
                (
                    "task-part".to_string(),
                    parts.iter().map(|p| p.to_string()).collect(),
                ),
            ],
            global_only: true,
            limit: Some(limit),
            ..buzz_db::EventQuery::for_community(community)
        };
        async move {
            state
                .db
                .query_events_for_event_write(&query)
                .await
                .map_err(|e| internal("reading who took the task", e))
        }
    };
    let mut stored = read(&["take", "give-up"], None, STEPS_READ).await?;
    stored.extend(read(&["cancel"], None, CANCELS_READ).await?);
    if let Ok(own) = hex::decode(signer) {
        stored.extend(read(&["take", "give-up", "cancel"], Some(own), OWN_STEPS_READ).await?);
    }
    let mut seen = HashSet::new();
    let steps: Vec<(String, u64, String, TaskPart)> = stored
        .iter()
        .filter(|record| seen.insert(record.event.id))
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

/// The most of the worker's own `take` and `accept` steps of one task read for their wallet.
const PAY_TO_STEPS_READ: i64 = 50;

/// The one wallet among `values` (each a `task-pay-to` tag value, in any case): every value that is an address (`0x` and
/// 40 hex digits) counts, and two different ones read as none, so a wallet changed after the fact is never believed.
/// Lower case.
pub(crate) fn single_wallet<'a>(values: impl IntoIterator<Item = &'a str>) -> Option<String> {
    let mut named = HashSet::new();
    for value in values {
        let Some(digits) = value.strip_prefix("0x") else {
            continue;
        };
        if digits.len() == 40 && digits.bytes().all(|b| b.is_ascii_hexdigit()) {
            named.insert(value.to_lowercase());
        }
    }
    let mut named = named.into_iter();
    match (named.next(), named.next()) {
        (Some(wallet), None) => Some(wallet),
        _ => None,
    }
}

/// The wallet the account `worker` (hex) named on its own `take` and `accept` steps of the task `task_id`: the one wallet
/// they all agree on, lower case, or `None` when they named none or two different ones.
pub(crate) async fn stored_pay_to(
    state: &Arc<AppState>,
    community: CommunityId,
    task_id: &[u8; 32],
    worker: &str,
) -> Result<Option<String>, IngestError> {
    let Ok(worker) = hex::decode(worker) else {
        return Ok(None);
    };
    let steps = state
        .db
        .query_events_for_event_write(&buzz_db::EventQuery {
            kinds: Some(vec![KIND_LAUNCH_UPDATE as i32]),
            pubkey: Some(worker),
            tag_filters: vec![
                ("task".to_string(), vec![hex::encode(task_id)]),
                (
                    "task-part".to_string(),
                    vec!["take".to_string(), "accept".to_string()],
                ),
            ],
            global_only: true,
            limit: Some(PAY_TO_STEPS_READ),
            ..buzz_db::EventQuery::for_community(community)
        })
        .await
        .map_err(|e| internal("reading the wallet the worker named", e))?;
    let wallets: Vec<String> = steps
        .iter()
        .filter_map(|record| {
            record.event.tags.iter().find_map(|tag| {
                let fields = tag.as_slice();
                (fields.first().map(String::as_str) == Some("task-pay-to"))
                    .then(|| fields.get(1).cloned())
                    .flatten()
            })
        })
        .collect();
    Ok(single_wallet(wallets.iter().map(String::as_str)))
}

/// The wallet named on the `take` and `accept` steps of the task `task_id` by anyone: the one wallet they all agree on,
/// lower case, or `None` when they named none or two different ones. It is how the server tells which wallet another
/// task's payment was meant for when it counts the tasks that name one payment (see `task_chain`); it is never the
/// wallet a payment is judged against (that is [`stored_pay_to`], the worker's own).
pub(crate) async fn stored_pay_to_of_anyone(
    state: &Arc<AppState>,
    community: CommunityId,
    task_id: &[u8; 32],
) -> Result<Option<String>, IngestError> {
    let steps = state
        .db
        .query_events_for_event_write(&buzz_db::EventQuery {
            kinds: Some(vec![KIND_LAUNCH_UPDATE as i32]),
            tag_filters: vec![
                ("task".to_string(), vec![hex::encode(task_id)]),
                (
                    "task-part".to_string(),
                    vec!["take".to_string(), "accept".to_string()],
                ),
            ],
            global_only: true,
            limit: Some(PAY_TO_STEPS_READ),
            ..buzz_db::EventQuery::for_community(community)
        })
        .await
        .map_err(|e| internal("reading the wallet another task names", e))?;
    let wallets: Vec<String> = steps
        .iter()
        .filter_map(|record| {
            record.event.tags.iter().find_map(|tag| {
                let fields = tag.as_slice();
                (fields.first().map(String::as_str) == Some("task-pay-to"))
                    .then(|| fields.get(1).cloned())
                    .flatten()
            })
        })
        .collect();
    Ok(single_wallet(wallets.iter().map(String::as_str)))
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

#[cfg(test)]
mod tests {
    use super::single_wallet;

    const A: &str = "0x00000000000000000000000000000000000000aa";
    const B: &str = "0x00000000000000000000000000000000000000bb";

    #[test]
    fn the_wallet_a_worker_named_is_the_one_they_all_agree_on() {
        assert_eq!(single_wallet([A]), Some(A.to_owned()));
        // The same wallet in another spelling is the same wallet; the answer is lower case.
        assert_eq!(
            single_wallet([A, "0x00000000000000000000000000000000000000AA"]),
            Some(A.to_owned())
        );
        // Two different wallets from one worker read as none; so does nothing, or a value that is no address.
        assert_eq!(single_wallet([A, B]), None);
        assert_eq!(single_wallet([]), None);
        assert_eq!(single_wallet(["0xabc", "nonsense"]), None);
        // A value that is no address counts for nothing: it neither names a wallet nor spoils the other.
        assert_eq!(single_wallet(["0xabc", A]), Some(A.to_owned()));
    }
}
