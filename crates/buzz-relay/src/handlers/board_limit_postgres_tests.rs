//! Anyone in a community may start a board, up to `boards_per_person_per_day` a day unless they own or administer the
//! community. Drives the real `ingest_event` seam, so removing the `check_board_creation_limit` call fails these tests.
//! Ignored without infrastructure; run with
//! `cargo test -p buzz-relay --lib -- board_limit -- --ignored`.

use std::sync::Arc;

use buzz_auth::Scope;
use buzz_core::tenant::TenantContext;
use nostr::{EventBuilder, Keys, Kind, Tag};
use uuid::Uuid;

use super::ingest::{ingest_event, IngestAuth, IngestError, IngestResult};
use crate::state::AppState;

fn t(kind: &str, value: &str) -> Tag {
    Tag::parse([kind, value]).expect("parse tag")
}

fn create(keys: &Keys, name: &str, channel_type: &str) -> nostr::Event {
    EventBuilder::new(Kind::Custom(9007), "")
        .tags(vec![
            t("h", &Uuid::new_v4().to_string()),
            t("name", name),
            t("visibility", "open"),
            t("channel_type", channel_type),
        ])
        .sign_with_keys(keys)
        .expect("sign create")
}

async fn ingest(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    event: nostr::Event,
) -> Result<IngestResult, IngestError> {
    let auth = IngestAuth::Nip42 {
        pubkey: event.pubkey,
        scopes: vec![Scope::ChannelsWrite, Scope::MessagesWrite],
        channel_ids: None,
        conn_id: Uuid::new_v4(),
    };
    ingest_event(state, tenant, event, auth).await
}

async fn community_with(limit: u32, people: &[(&Keys, &str)]) -> (Arc<AppState>, TenantContext) {
    let state = crate::test_support::test_state_with(|c| c.boards_per_person_per_day = limit).await;
    let host = format!("board-limit-{}.example", Uuid::new_v4().simple());
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

fn accepted(result: Result<IngestResult, IngestError>, what: &str) {
    match result {
        Ok(r) => assert!(r.accepted, "{what}: not accepted: {}", r.message),
        Err(e) => panic!("{what}: rejected: {e:?}"),
    }
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn board_limit_stops_a_member_at_the_daily_cap_but_not_chat_rooms() {
    let member = Keys::generate();
    let (state, tenant) = community_with(2, &[(&member, "member")]).await;

    accepted(
        ingest(&state, &tenant, create(&member, "one", "forum")).await,
        "first board",
    );
    accepted(
        ingest(&state, &tenant, create(&member, "two", "forum")).await,
        "second board",
    );
    match ingest(&state, &tenant, create(&member, "three", "forum")).await {
        Err(IngestError::Rejected(msg)) => assert!(
            msg.starts_with("rate-limited:") && msg.contains("2 boards a day"),
            "unexpected refusal: {msg}"
        ),
        Err(other) => panic!("third board should be refused as rate-limited, got {other:?}"),
        Ok(r) => panic!(
            "third board should be refused, but was answered: {}",
            r.message
        ),
    }
    // Chat rooms are not counted: launches and templates create several at once.
    accepted(
        ingest(&state, &tenant, create(&member, "room", "stream")).await,
        "chat room",
    );
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn board_limit_does_not_apply_to_owners_and_admins_or_when_switched_off() {
    let (owner, admin) = (Keys::generate(), Keys::generate());
    let (state, tenant) = community_with(1, &[(&owner, "owner"), (&admin, "admin")]).await;
    for (who, keys) in [("owner", &owner), ("admin", &admin)] {
        for n in 0..3 {
            accepted(
                ingest(
                    &state,
                    &tenant,
                    create(keys, &format!("{who}-{n}"), "forum"),
                )
                .await,
                &format!("{who} board {n}"),
            );
        }
    }

    let member = Keys::generate();
    let (state, tenant) = community_with(0, &[(&member, "member")]).await;
    for n in 0..3 {
        accepted(
            ingest(
                &state,
                &tenant,
                create(&member, &format!("open-{n}"), "forum"),
            )
            .await,
            &format!("unlimited board {n}"),
        );
    }
}
