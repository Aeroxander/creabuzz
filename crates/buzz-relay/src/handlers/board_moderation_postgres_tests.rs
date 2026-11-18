//! Board moderation (D93) driven through the real `ingest_event` seam: locks,
//! pins, rules, board-only mutes, appointed moderators and their guard rails,
//! and the public log. Removing the routing, the write enforcement or a guard
//! rail fails these tests. Ignored without infrastructure; run with
//! `cargo test -p buzz-relay --lib -- board_moderation_postgres_tests -- --ignored`.

use std::sync::Arc;

use buzz_auth::Scope;
use buzz_core::kind::{
    KIND_BOARD_APPOINT_MODERATOR, KIND_BOARD_LOCK_THREAD, KIND_BOARD_MODERATION_LOG,
    KIND_BOARD_MUTE, KIND_BOARD_PIN_THREAD, KIND_BOARD_REMOVE_MODERATOR, KIND_BOARD_SET_RULES,
    KIND_BOARD_STATE, KIND_BOARD_UNLOCK_THREAD, KIND_BOARD_UNMUTE, KIND_FORUM_COMMENT,
    KIND_FORUM_POST, KIND_FORUM_VOTE, KIND_NIP29_DELETE_EVENT,
};
use buzz_core::tenant::TenantContext;
use chrono::{Duration, Utc};
use nostr::{Event, EventBuilder, Keys, Kind, Tag};
use uuid::Uuid;

use super::ingest::{ingest_event, IngestAuth, IngestError, IngestResult};
use crate::state::AppState;

pub(super) fn signed(keys: &Keys, kind: u32, content: &str, tags: &[&[&str]]) -> Event {
    let tags: Vec<Tag> = tags
        .iter()
        .map(|parts| Tag::parse(parts.to_vec()).expect("parse tag"))
        .collect();
    // Self-tagging kept: stepping down and lifting one's own mute name the signer.
    EventBuilder::new(Kind::Custom(kind as u16), content)
        .tags(tags)
        .allow_self_tagging()
        .sign_with_keys(keys)
        .expect("sign")
}

pub(super) async fn ingest(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    event: Event,
) -> Result<IngestResult, IngestError> {
    let auth = IngestAuth::Nip42 {
        pubkey: event.pubkey,
        scopes: vec![
            Scope::ChannelsWrite,
            Scope::MessagesWrite,
            Scope::AdminChannels,
        ],
        channel_ids: None,
        conn_id: Uuid::new_v4(),
    };
    ingest_event(state, tenant, event, auth).await
}

pub(super) async fn community(people: &[(&Keys, &str)]) -> (Arc<AppState>, TenantContext) {
    let state = crate::test_support::test_state_with(|c| c.new_account_posts_per_hour = 0).await;
    let host = format!("board-moderation-{}.example", Uuid::new_v4().simple());
    let community = state
        .db
        .ensure_configured_community(&host)
        .await
        .expect("create community")
        .id;
    for (keys, role) in people {
        state
            .db
            .add_relay_member(community, &keys.public_key().to_hex(), role, None)
            .await
            .expect("add relay member");
    }
    (state, TenantContext::resolved(community, host))
}

pub(super) async fn accept(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    event: Event,
    what: &str,
) -> String {
    match ingest(state, tenant, event).await {
        Ok(r) => {
            assert!(r.accepted, "{what}: not accepted: {}", r.message);
            r.message
        }
        Err(e) => panic!("{what}: rejected: {e:?}"),
    }
}

pub(super) async fn refuse(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    event: Event,
    expected: &str,
    what: &str,
) {
    match ingest(state, tenant, event).await {
        Err(IngestError::Rejected(msg)) | Err(IngestError::AuthFailed(msg)) => assert!(
            msg.contains(expected),
            "{what}: refused for the wrong reason: {msg}"
        ),
        Err(other) => panic!("{what}: refused oddly: {other:?}"),
        Ok(r) => assert!(
            !r.accepted && r.message.contains(expected),
            "{what}: should be refused, answered: {}",
            r.message
        ),
    }
}

/// An open board created by `owner`, who becomes its owner.
pub(super) async fn board(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    owner: &Keys,
    name: &str,
) -> Uuid {
    let id = Uuid::new_v4();
    accept(
        state,
        tenant,
        signed(
            owner,
            9007,
            "",
            &[
                &["h", &id.to_string()],
                &["name", name],
                &["visibility", "open"],
                &["channel_type", "forum"],
            ],
        ),
        "create board",
    )
    .await;
    id
}

pub(super) async fn post(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    keys: &Keys,
    board: Uuid,
) -> Event {
    // A different text each time: two posts signed in the same second must not share an id.
    let text = format!("A title\n\n{}", Uuid::new_v4());
    let event = signed(keys, KIND_FORUM_POST, &text, &[&["h", &board.to_string()]]);
    accept(state, tenant, event.clone(), "post").await;
    event
}

pub(super) fn reply(keys: &Keys, board: Uuid, root: &Event, marker: &str) -> Event {
    signed(
        keys,
        KIND_FORUM_COMMENT,
        "a reply",
        &[
            &["h", &board.to_string()],
            &["e", &root.id.to_hex(), "", marker],
        ],
    )
}

pub(super) fn on_post(keys: &Keys, kind: u32, board: Uuid, target: &Event) -> Event {
    signed(
        keys,
        kind,
        "",
        &[&["h", &board.to_string()], &["e", &target.id.to_hex()]],
    )
}

pub(super) fn on_person(
    keys: &Keys,
    kind: u32,
    board: Uuid,
    target: &Keys,
    until: Option<i64>,
) -> Event {
    let board = board.to_string();
    let person = target.public_key().to_hex();
    match until {
        Some(until) => {
            let until = until.to_string();
            signed(
                keys,
                kind,
                "",
                &[&["h", &board], &["p", &person], &["expiration", &until]],
            )
        }
        None => signed(keys, kind, "", &[&["h", &board], &["p", &person]]),
    }
}

pub(super) fn in_days(days: i64) -> i64 {
    (Utc::now() + Duration::days(days)).timestamp()
}

pub(super) async fn relay_events(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    board: Uuid,
    kind: u32,
) -> Vec<Event> {
    let mut events: Vec<Event> = state
        .db
        .query_events(&buzz_db::event::EventQuery {
            kinds: Some(vec![kind as i32]),
            channel_id: Some(board),
            limit: Some(100),
            ..buzz_db::event::EventQuery::for_community(tenant.community())
        })
        .await
        .expect("query")
        .into_iter()
        .map(|stored| stored.event)
        .collect();
    events.sort_by_key(|e| e.created_at);
    events
}

pub(super) async fn board_state(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    board: Uuid,
) -> Event {
    relay_events(state, tenant, board, KIND_BOARD_STATE)
        .await
        .pop()
        .expect("a board state record")
}

pub(super) fn has_tag(event: &Event, name: &str, value: &str) -> bool {
    event.tags.iter().any(|t| {
        let parts = t.as_slice();
        parts.len() >= 2 && parts[0] == name && parts[1] == value
    })
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_locked_thread_refuses_replies_below_moderator_whatever_the_marker_and_is_logged() {
    let (owner, member) = (Keys::generate(), Keys::generate());
    let (state, tenant) = community(&[(&owner, "member"), (&member, "member")]).await;
    let b = board(&state, &tenant, &owner, "supporters").await;
    let thread = post(&state, &tenant, &member, b).await;

    refuse(
        &state,
        &tenant,
        on_post(&member, KIND_BOARD_LOCK_THREAD, b, &thread),
        "restricted:",
        "member lock",
    )
    .await;
    accept(
        &state,
        &tenant,
        on_post(&owner, KIND_BOARD_LOCK_THREAD, b, &thread),
        "owner lock",
    )
    .await;
    refuse(
        &state,
        &tenant,
        on_post(&owner, KIND_BOARD_LOCK_THREAD, b, &thread),
        "already locked",
        "second lock",
    )
    .await;

    for marker in ["reply", "root", ""] {
        refuse(
            &state,
            &tenant,
            reply(&member, b, &thread, marker),
            "thread is locked",
            marker,
        )
        .await;
    }
    accept(
        &state,
        &tenant,
        reply(&owner, b, &thread, "reply"),
        "owner replies in a locked thread",
    )
    .await;
    // Votes still count on a locked thread.
    accept(
        &state,
        &tenant,
        signed(
            &member,
            KIND_FORUM_VOTE,
            "+",
            &[&["h", &b.to_string()], &["e", &thread.id.to_hex()]],
        ),
        "vote on a locked thread",
    )
    .await;

    let record = board_state(&state, &tenant, b).await;
    assert!(
        has_tag(&record, "locked", &thread.id.to_hex()),
        "state lists the lock"
    );
    // Live delivery reaches only `#h` subscriptions, so the record must carry it.
    assert!(
        has_tag(&record, "h", &b.to_string()),
        "state names its board in h"
    );
    // Who locked it, so a client offers Unlock only to someone of at least their standing.
    assert!(
        record.tags.iter().any(|t| {
            let parts = t.as_slice();
            parts[0] == "locked"
                && parts[1] == thread.id.to_hex()
                && parts.get(3) == Some(&owner.public_key().to_hex())
        }),
        "the lock names who placed it"
    );
    assert_eq!(record.pubkey, state.relay_keypair.public_key());
    let log = relay_events(&state, &tenant, b, KIND_BOARD_MODERATION_LOG).await;
    assert_eq!(log.len(), 1, "one entry per accepted action");
    assert!(has_tag(&log[0], "action", "lock"));
    assert!(has_tag(&log[0], "actor", &owner.public_key().to_hex()));
    assert!(has_tag(&log[0], "e", &thread.id.to_hex()));

    refuse(
        &state,
        &tenant,
        on_post(&member, KIND_BOARD_UNLOCK_THREAD, b, &thread),
        "restricted:",
        "member unlock",
    )
    .await;
    accept(
        &state,
        &tenant,
        on_post(&owner, KIND_BOARD_UNLOCK_THREAD, b, &thread),
        "owner unlock",
    )
    .await;
    accept(
        &state,
        &tenant,
        reply(&member, b, &thread, "reply"),
        "reply after unlock",
    )
    .await;
    assert!(!has_tag(
        &board_state(&state, &tenant, b).await,
        "locked",
        &thread.id.to_hex()
    ));
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_board_mute_holds_on_that_board_only_and_expires_by_rule() {
    let (owner, member) = (Keys::generate(), Keys::generate());
    let (state, tenant) = community(&[(&owner, "member"), (&member, "member")]).await;
    let a = board(&state, &tenant, &owner, "a").await;
    let other = board(&state, &tenant, &owner, "b").await;
    let thread = post(&state, &tenant, &owner, a).await;

    refuse(
        &state,
        &tenant,
        on_person(&owner, KIND_BOARD_MUTE, a, &member, Some(in_days(31))),
        "at most 30 days",
        "too long",
    )
    .await;
    refuse(
        &state,
        &tenant,
        on_person(&owner, KIND_BOARD_MUTE, a, &member, None),
        "expiration",
        "no end",
    )
    .await;
    accept(
        &state,
        &tenant,
        on_person(&owner, KIND_BOARD_MUTE, a, &member, Some(in_days(2))),
        "mute",
    )
    .await;

    refuse(
        &state,
        &tenant,
        signed(&member, KIND_FORUM_POST, "x", &[&["h", &a.to_string()]]),
        "muted on this board",
        "post while muted",
    )
    .await;
    refuse(
        &state,
        &tenant,
        reply(&member, a, &thread, "reply"),
        "muted on this board",
        "reply while muted",
    )
    .await;
    refuse(
        &state,
        &tenant,
        signed(
            &member,
            KIND_FORUM_VOTE,
            "+",
            &[&["h", &a.to_string()], &["e", &thread.id.to_hex()]],
        ),
        "muted on this board",
        "vote while muted",
    )
    .await;
    post(&state, &tenant, &member, other).await;

    refuse(
        &state,
        &tenant,
        on_person(&member, KIND_BOARD_UNMUTE, a, &member, None),
        "restricted:",
        "lift own mute",
    )
    .await;
    accept(
        &state,
        &tenant,
        on_person(&owner, KIND_BOARD_UNMUTE, a, &member, None),
        "unmute",
    )
    .await;
    post(&state, &tenant, &member, a).await;

    let log = relay_events(&state, &tenant, a, KIND_BOARD_MODERATION_LOG).await;
    assert_eq!(log.len(), 2, "the refused mutes are not logged");
    let mute = log
        .iter()
        .find(|e| has_tag(e, "action", "mute"))
        .expect("the mute is logged");
    assert!(has_tag(mute, "p", &member.public_key().to_hex()));
    assert!(
        mute.tags.iter().any(|t| t.as_slice()[0] == "until"),
        "the log says when the mute ends"
    );
    assert!(
        mute.tags.iter().all(|t| t.as_slice()[0] != "expiration"),
        "the log entry must not expire with the mute"
    );
    assert!(log.iter().any(|e| has_tag(e, "action", "unmute")));
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn appointed_moderators_act_within_the_guard_rails() {
    let (owner, mod1, mod2, member) = (
        Keys::generate(),
        Keys::generate(),
        Keys::generate(),
        Keys::generate(),
    );
    let (state, tenant) = community(&[
        (&owner, "member"),
        (&mod1, "member"),
        (&mod2, "member"),
        (&member, "member"),
    ])
    .await;
    let b = board(&state, &tenant, &owner, "supporters").await;
    let owners_thread = post(&state, &tenant, &owner, b).await;
    let members_thread = post(&state, &tenant, &member, b).await;
    // Posted before the member is muted, removed later.
    let doomed = post(&state, &tenant, &member, b).await;

    refuse(
        &state,
        &tenant,
        on_person(&mod1, KIND_BOARD_APPOINT_MODERATOR, b, &mod1, None),
        "restricted:",
        "self-appoint",
    )
    .await;
    refuse(
        &state,
        &tenant,
        on_person(
            &owner,
            KIND_BOARD_APPOINT_MODERATOR,
            b,
            &mod1,
            Some(in_days(91)),
        ),
        "at most 90 days",
        "term too long",
    )
    .await;
    accept(
        &state,
        &tenant,
        on_person(&owner, KIND_BOARD_APPOINT_MODERATOR, b, &mod1, None),
        "appoint mod1",
    )
    .await;
    accept(
        &state,
        &tenant,
        on_person(&owner, KIND_BOARD_APPOINT_MODERATOR, b, &mod2, None),
        "appoint mod2",
    )
    .await;
    let record = board_state(&state, &tenant, b).await;
    assert!(has_tag(&record, "moderator", &mod1.public_key().to_hex()));
    assert!(has_tag(&record, "moderator", &mod2.public_key().to_hex()));

    // What a moderator may do, and may not.
    accept(
        &state,
        &tenant,
        on_post(&mod1, KIND_BOARD_LOCK_THREAD, b, &members_thread),
        "mod locks a member's thread",
    )
    .await;
    refuse(
        &state,
        &tenant,
        on_post(&mod1, KIND_BOARD_LOCK_THREAD, b, &owners_thread),
        "restricted:",
        "mod locks owner's",
    )
    .await;
    refuse(
        &state,
        &tenant,
        on_person(&mod1, KIND_BOARD_MUTE, b, &mod2, Some(in_days(1))),
        "restricted:",
        "mod mutes mod",
    )
    .await;
    refuse(
        &state,
        &tenant,
        on_person(&mod1, KIND_BOARD_MUTE, b, &owner, Some(in_days(1))),
        "restricted:",
        "mod mutes owner",
    )
    .await;
    refuse(
        &state,
        &tenant,
        signed(
            &mod1,
            KIND_BOARD_SET_RULES,
            "No rules",
            &[&["h", &b.to_string()]],
        ),
        "restricted:",
        "mod sets rules",
    )
    .await;
    refuse(
        &state,
        &tenant,
        on_person(&mod1, KIND_BOARD_APPOINT_MODERATOR, b, &member, None),
        "restricted:",
        "mod appoints",
    )
    .await;
    refuse(
        &state,
        &tenant,
        on_person(&mod1, KIND_BOARD_REMOVE_MODERATOR, b, &mod2, None),
        "restricted:",
        "mod dismisses mod",
    )
    .await;

    // Longer than seven days needs a second moderator.
    let message = accept(
        &state,
        &tenant,
        on_person(&mod1, KIND_BOARD_MUTE, b, &member, Some(in_days(20))),
        "mod1 asks for 20 days",
    )
    .await;
    assert!(message.contains("second moderator"), "{message}");
    // The log says how long was asked for, so another moderator can confirm it.
    let asked = relay_events(&state, &tenant, b, KIND_BOARD_MODERATION_LOG).await;
    assert!(asked.iter().any(|e| {
        has_tag(e, "status", "awaiting_second_moderator")
            && e.tags.iter().any(|t| {
                t.as_slice()[0] == "asked_until"
                    && t.as_slice()[1]
                        .parse::<i64>()
                        .is_ok_and(|v| v > in_days(19))
            })
    }));
    let person = state
        .db
        .board_person(tenant.community(), b, &member.public_key().to_bytes())
        .await
        .expect("read")
        .expect("row");
    let muted = person.muted_until.expect("muted");
    assert!(
        muted <= Utc::now() + Duration::days(7) + Duration::minutes(1),
        "one moderator: 7 days"
    );
    assert!(person.longer_mute_until.is_some());
    // The same moderator again does not confirm their own request.
    accept(
        &state,
        &tenant,
        on_person(&mod1, KIND_BOARD_MUTE, b, &member, Some(in_days(20))),
        "mod1 again",
    )
    .await;
    let still = state
        .db
        .board_person(tenant.community(), b, &member.public_key().to_bytes())
        .await
        .expect("read")
        .expect("row");
    assert!(
        still.muted_until.expect("muted") <= Utc::now() + Duration::days(7) + Duration::minutes(1)
    );
    let message = accept(
        &state,
        &tenant,
        on_person(&mod2, KIND_BOARD_MUTE, b, &member, Some(in_days(20))),
        "mod2 confirms",
    )
    .await;
    assert!(message.contains("confirmed"), "{message}");
    let confirmed = state
        .db
        .board_person(tenant.community(), b, &member.public_key().to_bytes())
        .await
        .expect("read")
        .expect("row");
    assert!(confirmed.muted_until.expect("muted") > Utc::now() + Duration::days(19));
    assert!(confirmed.longer_mute_until.is_none());
    let log = relay_events(&state, &tenant, b, KIND_BOARD_MODERATION_LOG).await;
    assert!(log
        .iter()
        .any(|e| has_tag(e, "status", "confirmed_by_second_moderator")));

    // Removing a post: a member's, yes; the owner's, no. Logged with the removal.
    accept(
        &state,
        &tenant,
        signed(
            &mod1,
            KIND_NIP29_DELETE_EVENT,
            "",
            &[&["h", &b.to_string()], &["e", &doomed.id.to_hex()]],
        ),
        "mod removes a member's post",
    )
    .await;
    assert!(state
        .db
        .get_event_by_id_for_event_write(tenant.community(), doomed.id.as_bytes())
        .await
        .expect("read")
        .is_none());
    let log = relay_events(&state, &tenant, b, KIND_BOARD_MODERATION_LOG).await;
    assert!(log
        .iter()
        .any(|e| has_tag(e, "action", "remove") && has_tag(e, "e", &doomed.id.to_hex())));
    refuse(
        &state,
        &tenant,
        signed(
            &mod1,
            KIND_NIP29_DELETE_EVENT,
            "",
            &[&["h", &b.to_string()], &["e", &owners_thread.id.to_hex()]],
        ),
        "same or higher standing",
        "mod removes the owner's post",
    )
    .await;

    // A moderator may resign; the owner may dismiss one. Either way they stop.
    accept(
        &state,
        &tenant,
        on_person(&mod2, KIND_BOARD_REMOVE_MODERATOR, b, &mod2, None),
        "mod2 resigns",
    )
    .await;
    accept(
        &state,
        &tenant,
        on_person(&owner, KIND_BOARD_REMOVE_MODERATOR, b, &mod1, None),
        "owner dismisses mod1",
    )
    .await;
    let fresh = post(&state, &tenant, &owner, b).await;
    for moderator in [&mod1, &mod2] {
        refuse(
            &state,
            &tenant,
            on_post(moderator, KIND_BOARD_PIN_THREAD, b, &fresh),
            "restricted:",
            "former mod",
        )
        .await;
    }
    let record = board_state(&state, &tenant, b).await;
    assert!(!record.tags.iter().any(|t| t.as_slice()[0] == "moderator"));
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_moderator_is_held_to_twenty_actions_an_hour_and_owners_are_not() {
    let (owner, moderator) = (Keys::generate(), Keys::generate());
    let (state, tenant) = community(&[(&owner, "member"), (&moderator, "member")]).await;
    let b = board(&state, &tenant, &owner, "busy").await;
    let thread = post(&state, &tenant, &owner, b).await;
    let other = post(&state, &tenant, &moderator, b).await;
    accept(
        &state,
        &tenant,
        on_person(&owner, KIND_BOARD_APPOINT_MODERATOR, b, &moderator, None),
        "appoint",
    )
    .await;
    for round in 0..10 {
        accept(
            &state,
            &tenant,
            on_post(&moderator, KIND_BOARD_LOCK_THREAD, b, &other),
            &format!("lock {round}"),
        )
        .await;
        accept(
            &state,
            &tenant,
            on_post(&moderator, KIND_BOARD_UNLOCK_THREAD, b, &other),
            &format!("unlock {round}"),
        )
        .await;
    }
    refuse(
        &state,
        &tenant,
        on_post(&moderator, KIND_BOARD_LOCK_THREAD, b, &other),
        "rate-limited:",
        "21st",
    )
    .await;
    for _ in 0..11 {
        accept(
            &state,
            &tenant,
            on_post(&owner, KIND_BOARD_LOCK_THREAD, b, &thread),
            "owner lock",
        )
        .await;
        accept(
            &state,
            &tenant,
            on_post(&owner, KIND_BOARD_UNLOCK_THREAD, b, &thread),
            "owner unlock",
        )
        .await;
    }
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn pins_sent_together_stop_at_the_boards_limit() {
    let owner = Keys::generate();
    let (state, tenant) = community(&[(&owner, "member")]).await;
    let b = board(&state, &tenant, &owner, "pin-race").await;
    let mut pins = Vec::new();
    for _ in 0..8 {
        let thread = post(&state, &tenant, &owner, b).await;
        pins.push(on_post(&owner, KIND_BOARD_PIN_THREAD, b, &thread));
    }
    // All eight pass the early check together; the count under the board's lock holds.
    let results = futures_util::future::join_all(
        pins.into_iter().map(|event| ingest(&state, &tenant, event)),
    )
    .await;
    let accepted = results
        .iter()
        .filter(|result| matches!(result, Ok(r) if r.accepted))
        .count();
    let pinned = state
        .db
        .board_pinned_count(tenant.community(), b)
        .await
        .expect("count pins");
    assert_eq!(pinned, 3, "pins on the board");
    let answers: Vec<String> = results
        .iter()
        .map(|result| match result {
            Ok(r) => r.message.clone(),
            Err(e) => format!("{e:?}"),
        })
        .collect();
    assert_eq!(accepted, 3, "pins accepted: {answers:?}");
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn pins_rules_and_relay_only_records() {
    let (owner, member) = (Keys::generate(), Keys::generate());
    let (state, tenant) = community(&[(&owner, "member"), (&member, "member")]).await;
    let b = board(&state, &tenant, &owner, "pins").await;
    let mut threads = Vec::new();
    for _ in 0..4 {
        threads.push(post(&state, &tenant, &member, b).await);
    }
    for thread in &threads[..3] {
        accept(
            &state,
            &tenant,
            on_post(&owner, KIND_BOARD_PIN_THREAD, b, thread),
            "pin",
        )
        .await;
    }
    refuse(
        &state,
        &tenant,
        on_post(&owner, KIND_BOARD_PIN_THREAD, b, &threads[3]),
        "3 pinned threads",
        "4th pin",
    )
    .await;
    // A pinned post its author deletes no longer takes a pin's place.
    accept(
        &state,
        &tenant,
        signed(&member, 5, "", &[&["e", &threads[0].id.to_hex()]]),
        "author deletes a pinned post",
    )
    .await;
    accept(
        &state,
        &tenant,
        on_post(&owner, KIND_BOARD_PIN_THREAD, b, &threads[3]),
        "pin after a deletion",
    )
    .await;
    let record = board_state(&state, &tenant, b).await;
    assert!(!has_tag(&record, "pinned", &threads[0].id.to_hex()));
    assert!(has_tag(&record, "pinned", &threads[3].id.to_hex()));

    refuse(
        &state,
        &tenant,
        signed(
            &member,
            KIND_BOARD_SET_RULES,
            "My rules",
            &[&["h", &b.to_string()]],
        ),
        "restricted:",
        "member sets rules",
    )
    .await;
    accept(
        &state,
        &tenant,
        signed(
            &owner,
            KIND_BOARD_SET_RULES,
            "Be kind. Stay on topic.",
            &[&["h", &b.to_string()]],
        ),
        "owner sets rules",
    )
    .await;
    assert_eq!(
        board_state(&state, &tenant, b).await.content,
        "Be kind. Stay on topic."
    );

    // Nobody but the server writes the state record or the log.
    for kind in [KIND_BOARD_STATE, KIND_BOARD_MODERATION_LOG] {
        refuse(
            &state,
            &tenant,
            signed(
                &owner,
                kind,
                "",
                &[&["h", &b.to_string()], &["d", &b.to_string()]],
            ),
            "relay-only",
            "client-written board record",
        )
        .await;
    }
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_community_admin_removes_on_any_board_and_a_member_cannot() {
    let (owner, admin, member, other) = (
        Keys::generate(),
        Keys::generate(),
        Keys::generate(),
        Keys::generate(),
    );
    let (state, tenant) = community(&[
        (&owner, "member"),
        (&admin, "admin"),
        (&member, "member"),
        (&other, "member"),
    ])
    .await;
    let b = board(&state, &tenant, &owner, "general").await;
    let target = post(&state, &tenant, &member, b).await;
    refuse(
        &state,
        &tenant,
        signed(
            &other,
            KIND_NIP29_DELETE_EVENT,
            "",
            &[&["h", &b.to_string()], &["e", &target.id.to_hex()]],
        ),
        "board moderator",
        "member removes someone else's post",
    )
    .await;
    accept(
        &state,
        &tenant,
        signed(
            &admin,
            KIND_NIP29_DELETE_EVENT,
            "",
            &[
                &["h", &b.to_string()],
                &["e", &target.id.to_hex()],
                &["public_reason", "spam"],
            ],
        ),
        "community admin removes",
    )
    .await;
    let log = relay_events(&state, &tenant, b, KIND_BOARD_MODERATION_LOG).await;
    assert_eq!(log.len(), 1);
    assert!(has_tag(&log[0], "action", "remove") && has_tag(&log[0], "role", "community_admin"));
    assert_eq!(log[0].content, "spam");
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_board_admin_removes_members_but_not_the_owner_or_a_fellow_admin() {
    let (owner, admin, other_admin, member) = (
        Keys::generate(),
        Keys::generate(),
        Keys::generate(),
        Keys::generate(),
    );
    let (state, tenant) = community(&[
        (&owner, "member"),
        (&admin, "member"),
        (&other_admin, "member"),
        (&member, "member"),
    ])
    .await;
    let b = board(&state, &tenant, &owner, "staff").await;
    let put = |keys: &Keys, person: &Keys, role: &str| {
        signed(
            keys,
            9000,
            "",
            &[
                &["h", &b.to_string()],
                &["p", &person.public_key().to_hex()],
                &["role", role],
            ],
        )
    };
    let remove = |keys: &Keys, person: &Keys| {
        signed(
            keys,
            9001,
            "",
            &[
                &["h", &b.to_string()],
                &["p", &person.public_key().to_hex()],
            ],
        )
    };
    accept(&state, &tenant, put(&owner, &admin, "admin"), "make admin").await;
    accept(
        &state,
        &tenant,
        put(&owner, &other_admin, "admin"),
        "make second admin",
    )
    .await;
    accept(
        &state,
        &tenant,
        put(&owner, &member, "member"),
        "add member",
    )
    .await;

    refuse(
        &state,
        &tenant,
        remove(&admin, &owner),
        "an admin cannot remove an owner or a fellow admin",
        "admin removes owner",
    )
    .await;
    refuse(
        &state,
        &tenant,
        remove(&admin, &other_admin),
        "an admin cannot remove an owner or a fellow admin",
        "admin removes admin",
    )
    .await;
    accept(
        &state,
        &tenant,
        remove(&admin, &member),
        "admin removes member",
    )
    .await;
    accept(
        &state,
        &tenant,
        remove(&owner, &other_admin),
        "owner removes admin",
    )
    .await;
}
