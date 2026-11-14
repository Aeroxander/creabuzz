//! Removing a Home post (a kind:9005 with no `h` tag) through the real
//! `ingest_event` seam: who may, the admin guard rail, and that one accepted
//! removal soft-deletes the post, closes its open reports, writes the audit
//! row and a global public log entry the author finds by `#p` — all or none.
//! Before this path a kind:9005 without an `h` tag was refused outright, so no
//! moderator could remove a Home post. Ignored without infrastructure; run with
//! `cargo test -p buzz-relay --lib -- home_moderation_postgres_tests -- --ignored`.

use std::sync::Arc;

use buzz_core::kind::{
    KIND_BOARD_MODERATION_LOG, KIND_NIP29_DELETE_EVENT, KIND_REPORT, KIND_TEXT_NOTE,
};
use buzz_core::tenant::TenantContext;
use nostr::{Event, Keys};

use super::board_moderation_postgres_tests::{accept, community, has_tag, refuse, signed};
use super::home_moderation::{ADMIN_GUARD_RAIL, NOT_A_MODERATOR};
use crate::state::AppState;

async fn home_post(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    keys: &Keys,
    text: &str,
) -> Event {
    let note = signed(keys, KIND_TEXT_NOTE, text, &[]);
    accept(state, tenant, note.clone(), "Home post").await;
    note
}

fn report(reporter: &Keys, target: &Event) -> Event {
    signed(
        reporter,
        KIND_REPORT,
        "selling things",
        &[
            &["e", &target.id.to_hex(), "spam"],
            &["p", &target.pubkey.to_hex()],
        ],
    )
}

fn remove(keys: &Keys, target: &Event, reason: &str) -> Event {
    signed(
        keys,
        KIND_NIP29_DELETE_EVENT,
        "",
        &[&["e", &target.id.to_hex()], &["public_reason", reason]],
    )
}

async fn still_there(state: &Arc<AppState>, tenant: &TenantContext, post: &Event) -> bool {
    state
        .db
        .get_event_by_id(tenant.community(), &post.id.to_bytes())
        .await
        .expect("read post")
        .is_some()
}

async fn report_status(state: &Arc<AppState>, tenant: &TenantContext, report: &Event) -> String {
    state
        .db
        .get_moderation_report_by_event(tenant.community(), &report.id.to_bytes())
        .await
        .expect("read report")
        .expect("report row")
        .status
}

/// The log entries about `person`, the read their notifications make.
async fn log_about(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    person: &Keys,
) -> Vec<buzz_core::StoredEvent> {
    state
        .db
        .query_events(&buzz_db::event::EventQuery {
            kinds: Some(vec![KIND_BOARD_MODERATION_LOG as i32]),
            p_tag_hex: Some(person.public_key().to_hex()),
            limit: Some(10),
            ..buzz_db::event::EventQuery::for_community(tenant.community())
        })
        .await
        .expect("query by key")
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn an_owner_removes_a_home_post_with_a_reason_in_one_commit() {
    let (owner, author, reporter) = (Keys::generate(), Keys::generate(), Keys::generate());
    let (state, tenant) = community(&[
        (&owner, "owner"),
        (&author, "member"),
        (&reporter, "member"),
    ])
    .await;
    let post = home_post(&state, &tenant, &author, "Buy cheap watches here").await;
    let reported = report(&reporter, &post);
    accept(&state, &tenant, reported.clone(), "report the post").await;
    assert_eq!(report_status(&state, &tenant, &reported).await, "open");

    accept(
        &state,
        &tenant,
        remove(&owner, &post, "Spam"),
        "owner removes the Home post",
    )
    .await;

    assert!(
        !still_there(&state, &tenant, &post).await,
        "the post is gone"
    );
    let everyone = state
        .db
        .query_events(&buzz_db::event::EventQuery {
            kinds: Some(vec![KIND_TEXT_NOTE as i32]),
            pubkey: Some(author.public_key().to_bytes().to_vec()),
            limit: Some(10),
            ..buzz_db::event::EventQuery::for_community(tenant.community())
        })
        .await
        .expect("read Home");
    assert!(
        everyone.iter().all(|stored| stored.event.id != post.id),
        "Home reads no longer return it"
    );
    assert_eq!(
        report_status(&state, &tenant, &reported).await,
        "resolved",
        "the open report is closed with the removal"
    );

    let entries = log_about(&state, &tenant, &author).await;
    assert_eq!(entries.len(), 1, "one public log entry names the author");
    let entry = &entries[0];
    assert_eq!(entry.channel_id, None, "a Home removal belongs to no board");
    assert_eq!(entry.event.pubkey, state.relay_keypair.public_key());
    assert_eq!(entry.event.content, "Spam");
    assert!(has_tag(&entry.event, "action", "remove"));
    assert!(has_tag(&entry.event, "role", "community_owner"));
    assert!(has_tag(&entry.event, "e", &post.id.to_hex()));
    assert!(
        !entry.event.tags.iter().any(|t| t.as_slice()[0] == "h"),
        "no board tag"
    );
    assert!(
        !entry.event.tags.iter().any(|t| t.as_slice()[0] == "thread"),
        "a post is not a reply"
    );

    let audit = state
        .db
        .list_moderation_actions(tenant.community(), 10)
        .await
        .expect("audit");
    let row = audit
        .iter()
        .find(|row| row.action == "delete_message")
        .expect("audit row for the removal");
    assert_eq!(
        row.target_event_id.as_deref(),
        Some(post.id.as_bytes().as_slice())
    );
    assert_eq!(
        row.target_pubkey.as_deref(),
        Some(author.public_key().to_bytes().as_slice())
    );
    assert_eq!(row.public_reason.as_deref(), Some("Spam"));
    let report_row = state
        .db
        .get_moderation_report_by_event(tenant.community(), &reported.id.to_bytes())
        .await
        .expect("read report")
        .expect("report row");
    assert_eq!(
        report_row.action_id,
        Some(row.id),
        "closed against the removal"
    );

    // A resend finds it gone: accepted, nothing written twice.
    let again = accept(&state, &tenant, remove(&owner, &post, "Spam"), "resend").await;
    assert!(again.starts_with("duplicate:"), "{again}");
    assert_eq!(log_about(&state, &tenant, &author).await.len(), 1);
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn an_admin_removes_a_members_reply_but_not_the_owners_post_and_members_cannot() {
    let (owner, admin, author, other) = (
        Keys::generate(),
        Keys::generate(),
        Keys::generate(),
        Keys::generate(),
    );
    let (state, tenant) = community(&[
        (&owner, "owner"),
        (&admin, "admin"),
        (&author, "member"),
        (&other, "member"),
    ])
    .await;
    let owners_post = home_post(&state, &tenant, &owner, "Welcome everyone").await;
    let reply = signed(
        &author,
        KIND_TEXT_NOTE,
        "nobody asked",
        &[
            &["e", &owners_post.id.to_hex(), "", "root"],
            &["p", &owner.public_key().to_hex()],
        ],
    );
    accept(&state, &tenant, reply.clone(), "reply on Home").await;

    refuse(
        &state,
        &tenant,
        remove(&other, &reply, "rude"),
        NOT_A_MODERATOR,
        "a member removes someone else's reply",
    )
    .await;
    refuse(
        &state,
        &tenant,
        remove(&author, &reply, "changed my mind"),
        NOT_A_MODERATOR,
        "an author uses delete, not the moderators' removal",
    )
    .await;
    refuse(
        &state,
        &tenant,
        remove(&admin, &owners_post, "no"),
        ADMIN_GUARD_RAIL,
        "an admin removes the owner's post",
    )
    .await;
    assert!(still_there(&state, &tenant, &reply).await);
    assert!(still_there(&state, &tenant, &owners_post).await);

    accept(
        &state,
        &tenant,
        remove(&admin, &reply, "Be kind"),
        "admin removes the reply",
    )
    .await;
    assert!(!still_there(&state, &tenant, &reply).await);
    assert!(
        still_there(&state, &tenant, &owners_post).await,
        "only the reply"
    );
    let entries = log_about(&state, &tenant, &author).await;
    assert_eq!(entries.len(), 1);
    assert!(has_tag(&entries[0].event, "role", "community_admin"));
    assert!(
        has_tag(&entries[0].event, "thread", &owners_post.id.to_hex()),
        "a removed reply names its thread"
    );
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_failed_log_write_leaves_the_post_and_its_report_untouched() {
    let (owner, author, reporter) = (Keys::generate(), Keys::generate(), Keys::generate());
    let (state, tenant) = community(&[
        (&owner, "owner"),
        (&author, "member"),
        (&reporter, "member"),
    ])
    .await;
    let post = home_post(&state, &tenant, &author, "hello").await;
    let reported = report(&reporter, &post);
    accept(&state, &tenant, reported.clone(), "report").await;

    // A log entry that is already stored cannot be written again: the removal
    // must roll back with it.
    let log = signed(
        &Keys::generate(),
        KIND_BOARD_MODERATION_LOG,
        "",
        &[&["p", &author.public_key().to_hex()]],
    );
    state
        .db
        .insert_event(tenant.community(), &log, None)
        .await
        .expect("store the entry first");
    let owner_bytes = owner.public_key().to_bytes();
    let author_bytes = author.public_key().to_bytes();
    let post_id = post.id.to_bytes();
    let result = state
        .db
        .remove_home_post(
            tenant.community(),
            buzz_db::home_moderation::HomeRemoval {
                action_id: uuid::Uuid::new_v4(),
                at: chrono::Utc::now(),
                actor_pubkey: &owner_bytes,
                author_pubkey: &author_bytes,
                event_id: &post_id,
                public_reason: Some("Spam"),
                log_event: &log,
            },
        )
        .await;
    assert!(
        result.is_err(),
        "the duplicate log entry refuses the removal"
    );
    assert!(
        still_there(&state, &tenant, &post).await,
        "nothing was deleted"
    );
    assert_eq!(report_status(&state, &tenant, &reported).await, "open");
}
