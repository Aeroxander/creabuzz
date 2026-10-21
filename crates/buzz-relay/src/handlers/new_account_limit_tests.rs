//! A new account (first heard from less than a day ago) may send only a few posts, board posts and board replies an
//! hour; established accounts, owners and admins are not limited, and neither are votes. Drives the real
//! `ingest_event` seam, so removing the `check_new_account_limit` call fails these tests. Ignored without
//! infrastructure; run with `cargo test -p buzz-relay --lib -- new_account_limit -- --ignored`.

use std::sync::Arc;

use buzz_auth::Scope;
use buzz_core::tenant::TenantContext;
use nostr::{EventBuilder, Keys, Kind, Tag};
use uuid::Uuid;

use super::ingest::{ingest_event, IngestAuth, IngestError, IngestResult};
use crate::state::AppState;

fn note(keys: &Keys, text: &str) -> nostr::Event {
    EventBuilder::new(Kind::Custom(1), text)
        .sign_with_keys(keys)
        .expect("sign note")
}

fn upvote(keys: &Keys, target: &nostr::Event) -> nostr::Event {
    EventBuilder::new(Kind::Custom(7), "+")
        .tags(vec![Tag::parse(["e", &target.id.to_hex()]).expect("tag")])
        .sign_with_keys(keys)
        .expect("sign vote")
}

async fn ingest(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    event: nostr::Event,
) -> Result<IngestResult, IngestError> {
    let auth = IngestAuth::Nip42 {
        pubkey: event.pubkey,
        scopes: vec![Scope::MessagesWrite],
        channel_ids: None,
        conn_id: Uuid::new_v4(),
    };
    ingest_event(state, tenant, event, auth).await
}

async fn community_with(limit: u32, people: &[(&Keys, &str)]) -> (Arc<AppState>, TenantContext) {
    let state = crate::test_support::test_state_with(|c| {
        c.new_account_posts_per_hour = limit;
        c.new_account_hours = 24;
    })
    .await;
    let host = format!("new-account-{}.example", Uuid::new_v4().simple());
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
async fn new_account_limit_stops_a_fresh_account_at_the_hourly_cap_but_not_its_votes() {
    let fresh = Keys::generate();
    let (state, tenant) = community_with(3, &[(&fresh, "member")]).await;
    let mut first = None;
    for n in 0..3 {
        let post = note(&fresh, &format!("post {n}"));
        first.get_or_insert_with(|| post.clone());
        accepted(ingest(&state, &tenant, post).await, &format!("post {n}"));
    }
    match ingest(&state, &tenant, note(&fresh, "one too many")).await {
        Err(IngestError::Rejected(msg)) => assert!(
            msg.starts_with("rate-limited:") && msg.contains("3 times an hour"),
            "unexpected refusal: {msg}"
        ),
        Err(other) => panic!("fourth post should be rate-limited, got {other:?}"),
        Ok(r) => panic!("fourth post should be refused, was answered: {}", r.message),
    }
    let target = first.expect("a first post");
    accepted(
        ingest(&state, &tenant, upvote(&fresh, &target)).await,
        "a vote",
    );
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn new_account_limit_spares_established_accounts_owners_and_a_switched_off_server() {
    let (old, owner) = (Keys::generate(), Keys::generate());
    let (state, tenant) = community_with(1, &[(&old, "member"), (&owner, "owner")]).await;

    // An account this server first heard from two days ago.
    accepted(
        ingest(&state, &tenant, note(&old, "long ago")).await,
        "old post",
    );
    let pool = sqlx::PgPool::connect(&crate::test_support::database_url())
        .await
        .expect("connect");
    sqlx::query("UPDATE events SET received_at = now() - interval '2 days' WHERE community_id = $1 AND pubkey = $2")
        .bind(tenant.community().as_uuid())
        .bind(old.public_key().to_bytes().to_vec())
        .execute(&pool)
        .await
        .expect("age the account");
    for n in 0..3 {
        accepted(
            ingest(&state, &tenant, note(&old, &format!("old {n}"))).await,
            "established post",
        );
        accepted(
            ingest(&state, &tenant, note(&owner, &format!("owner {n}"))).await,
            "owner post",
        );
    }

    let fresh = Keys::generate();
    let (state, tenant) = community_with(0, &[(&fresh, "member")]).await;
    for n in 0..3 {
        accepted(
            ingest(&state, &tenant, note(&fresh, &format!("free {n}"))).await,
            "limit off",
        );
    }
}
