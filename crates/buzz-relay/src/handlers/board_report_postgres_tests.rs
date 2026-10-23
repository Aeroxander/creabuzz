//! Board moderation pass 2 (D99) through the real seams: a moderator's removal
//! tells the author (and names them in the public log), a board's moderators
//! read that board's reports without who sent them, and close reports within
//! the board's rules. Removing the notice, the board read or the resolve rule
//! fails these tests. Ignored without infrastructure; run with
//! `cargo test -p buzz-relay --lib -- board_report_postgres_tests -- --ignored`.

use std::sync::Arc;

use buzz_core::kind::{
    KIND_BOARD_APPOINT_MODERATOR, KIND_BOARD_MODERATION_LOG, KIND_MODERATION_RESOLVE_REPORT,
    KIND_NIP29_DELETE_EVENT, KIND_REPORT, KIND_STREAM_MESSAGE,
};
use buzz_core::tenant::TenantContext;
use nostr::{Event, Keys};
use uuid::Uuid;

use super::board_moderation_postgres_tests::{
    accept, board, community, has_tag, on_person, post, refuse, relay_events, reply, signed,
};
use crate::state::AppState;

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

fn resolve(keys: &Keys, report: &Event, action: &str) -> Event {
    let status = if action == "dismiss" {
        "dismissed"
    } else {
        "resolved"
    };
    signed(
        keys,
        KIND_MODERATION_RESOLVE_REPORT,
        "",
        &[
            &["report", &report.id.to_hex()],
            &["status", status],
            &["action", action],
        ],
    )
}

fn remove(keys: &Keys, board: Uuid, target: &Event, reason: &str) -> Event {
    signed(
        keys,
        KIND_NIP29_DELETE_EVENT,
        "",
        &[
            &["h", &board.to_string()],
            &["e", &target.id.to_hex()],
            &["public_reason", reason],
        ],
    )
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

/// The server's notices in this community: relay-signed messages. Read without
/// opening anyone's moderation thread, which would race the notice's own open.
async fn notices(state: &Arc<AppState>, tenant: &TenantContext) -> Vec<Event> {
    let relay = state.relay_keypair.public_key();
    state
        .db
        .query_events(&buzz_db::event::EventQuery {
            kinds: Some(vec![KIND_STREAM_MESSAGE as i32]),
            pubkey: Some(relay.to_bytes().to_vec()),
            limit: Some(100),
            ..buzz_db::event::EventQuery::for_community(tenant.community())
        })
        .await
        .expect("query")
        .into_iter()
        .map(|stored| stored.event)
        .collect()
}

/// `GET /moderation/reports?channel=…` through the router, as `reader`.
async fn board_reports(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    board: Uuid,
    reader: &Keys,
) -> (axum::http::StatusCode, serde_json::Value) {
    use axum::body::{to_bytes, Body};
    use tower::ServiceExt;
    let response = crate::router::build_router(Arc::clone(state))
        .oneshot(
            axum::http::Request::builder()
                .method("GET")
                .uri(format!("/moderation/reports?channel={board}&status=open"))
                .header("host", tenant.host())
                .header("x-pubkey", reader.public_key().to_hex())
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("router");
    let status = response.status();
    let body = to_bytes(response.into_body(), 1 << 20).await.expect("body");
    (
        status,
        serde_json::from_slice(&body).unwrap_or(serde_json::Value::Null),
    )
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_moderators_removal_tells_the_author_and_names_them_in_the_log() {
    let (owner, moderator, author) = (Keys::generate(), Keys::generate(), Keys::generate());
    let (state, tenant) = community(&[
        (&owner, "member"),
        (&moderator, "member"),
        (&author, "member"),
    ])
    .await;
    let b = board(&state, &tenant, &owner, "ideas").await;
    accept(
        &state,
        &tenant,
        on_person(&owner, KIND_BOARD_APPOINT_MODERATOR, b, &moderator, None),
        "appoint",
    )
    .await;
    let thread = post(&state, &tenant, &owner, b).await;
    let answer = reply(&author, b, &thread, "root");
    accept(&state, &tenant, answer.clone(), "reply").await;

    accept(
        &state,
        &tenant,
        remove(&moderator, b, &answer, "off topic"),
        "moderator removes the reply",
    )
    .await;

    let log = relay_events(&state, &tenant, b, KIND_BOARD_MODERATION_LOG).await;
    let removal = log
        .iter()
        .find(|e| has_tag(e, "action", "remove"))
        .expect("removal in the log");
    assert!(
        has_tag(removal, "p", &author.public_key().to_hex()),
        "the log entry names whose words were removed"
    );
    // The author finds it by their own key, the read the app's notifications make.
    let by_key = state
        .db
        .query_events(&buzz_db::event::EventQuery {
            kinds: Some(vec![KIND_BOARD_MODERATION_LOG as i32]),
            p_tag_hex: Some(author.public_key().to_hex()),
            limit: Some(10),
            ..buzz_db::event::EventQuery::for_community(tenant.community())
        })
        .await
        .expect("query by key");
    assert!(
        by_key.iter().any(|stored| stored.event.id == removal.id),
        "a #p read finds the removal"
    );
    let action_id = removal
        .tags
        .iter()
        .find(|t| t.as_slice().first().map(String::as_str) == Some("action_id"))
        .and_then(|t| t.as_slice().get(1).cloned())
        .expect("action id");

    // The notice is sent on its own task after the removal: wait for it, boundedly.
    let mut notice = None;
    for _ in 0..50 {
        notice = notices(&state, &tenant)
            .await
            .into_iter()
            .find(|e| has_tag(e, "moderation_source", &action_id));
        if notice.is_some() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    let notice = notice.expect("the author is told");
    // In the author's own moderation thread (opening it now finds the one the notice made).
    let relay = state.relay_keypair.public_key();
    let (thread_with_author, _) = state
        .db
        .open_dm(
            tenant.community(),
            &[author.public_key().to_bytes().as_slice()],
            relay.to_bytes().as_slice(),
        )
        .await
        .expect("moderation thread");
    assert!(has_tag(&notice, "h", &thread_with_author.id.to_string()));
    assert!(
        notice
            .content
            .contains("A moderator removed your reply on the board ideas"),
        "{}",
        notice.content
    );
    assert!(notice.content.contains("\"a reply\""));
    assert!(notice.content.contains("Reason: off topic"));
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_boards_moderators_read_its_reports_without_who_sent_them() {
    let (owner, moderator, member, reporter, admin) = (
        Keys::generate(),
        Keys::generate(),
        Keys::generate(),
        Keys::generate(),
        Keys::generate(),
    );
    let (state, tenant) = community(&[
        (&owner, "member"),
        (&moderator, "member"),
        (&member, "member"),
        (&reporter, "member"),
        (&admin, "admin"),
    ])
    .await;
    let b = board(&state, &tenant, &owner, "ideas").await;
    let elsewhere = board(&state, &tenant, &owner, "other").await;
    accept(
        &state,
        &tenant,
        on_person(&owner, KIND_BOARD_APPOINT_MODERATOR, b, &moderator, None),
        "appoint",
    )
    .await;
    let here = post(&state, &tenant, &member, b).await;
    let there = post(&state, &tenant, &member, elsewhere).await;
    accept(&state, &tenant, report(&reporter, &here), "report here").await;
    accept(&state, &tenant, report(&reporter, &there), "report there").await;

    let (status, rows) = board_reports(&state, &tenant, b, &moderator).await;
    assert_eq!(status, axum::http::StatusCode::OK, "{rows}");
    let rows = rows.as_array().expect("rows");
    assert_eq!(rows.len(), 1, "only this board's reports: {rows:?}");
    assert_eq!(rows[0]["target"], here.id.to_hex());
    assert_eq!(rows[0]["note"], "selling things");
    assert!(
        rows[0]["reporter_pubkey"].is_null(),
        "a board's moderators are not told who reported"
    );

    // The board owner moderates it too; a member does not, nor a moderator of another board.
    assert_eq!(
        board_reports(&state, &tenant, b, &owner).await.0,
        axum::http::StatusCode::OK
    );
    assert_eq!(
        board_reports(&state, &tenant, b, &member).await.0,
        axum::http::StatusCode::FORBIDDEN
    );
    assert_eq!(
        board_reports(&state, &tenant, elsewhere, &moderator)
            .await
            .0,
        axum::http::StatusCode::FORBIDDEN
    );

    // A community moderator still sees who reported, on the board's read as on the whole queue.
    let (status, rows) = board_reports(&state, &tenant, b, &admin).await;
    assert_eq!(status, axum::http::StatusCode::OK);
    assert_eq!(rows[0]["reporter_pubkey"], reporter.public_key().to_hex());
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_board_moderator_closes_reports_within_the_boards_rules() {
    let (owner, moderator, second, member, reporter) = (
        Keys::generate(),
        Keys::generate(),
        Keys::generate(),
        Keys::generate(),
        Keys::generate(),
    );
    let (state, tenant) = community(&[
        (&owner, "member"),
        (&moderator, "member"),
        (&second, "member"),
        (&member, "member"),
        (&reporter, "member"),
    ])
    .await;
    let b = board(&state, &tenant, &owner, "ideas").await;
    for person in [&moderator, &second] {
        accept(
            &state,
            &tenant,
            on_person(&owner, KIND_BOARD_APPOINT_MODERATOR, b, person, None),
            "appoint",
        )
        .await;
    }
    let spam = post(&state, &tenant, &member, b).await;
    let fine = post(&state, &tenant, &member, b).await;
    let own = post(&state, &tenant, &moderator, b).await;
    let fellow = post(&state, &tenant, &second, b).await;
    let by_owner = post(&state, &tenant, &owner, b).await;
    let reports: Vec<Event> = [&spam, &fine, &own, &fellow, &by_owner]
        .into_iter()
        .map(|target| report(&reporter, target))
        .collect();
    for r in &reports {
        accept(&state, &tenant, r.clone(), "report").await;
    }
    let [spam_report, fine_report, own_report, fellow_report, owner_report] = &reports[..] else {
        unreachable!()
    };

    // Nothing more than a removal or a dismissal.
    refuse(
        &state,
        &tenant,
        resolve(&moderator, spam_report, "ban"),
        "anything more is for the community's moderators",
        "board moderator bans",
    )
    .await;
    // Closing as removed needs the words gone first.
    refuse(
        &state,
        &tenant,
        resolve(&moderator, spam_report, "delete"),
        "remove the post or reply first",
        "close before removing",
    )
    .await;
    accept(
        &state,
        &tenant,
        remove(&moderator, b, &spam, "spam"),
        "remove the reported post",
    )
    .await;
    accept(
        &state,
        &tenant,
        resolve(&moderator, spam_report, "delete"),
        "close as removed",
    )
    .await;
    assert_eq!(
        report_status(&state, &tenant, spam_report).await,
        "resolved"
    );

    accept(
        &state,
        &tenant,
        resolve(&moderator, fine_report, "dismiss"),
        "dismiss",
    )
    .await;
    assert_eq!(
        report_status(&state, &tenant, fine_report).await,
        "dismissed"
    );

    // Never about their own words, nor about someone of the same or higher standing.
    refuse(
        &state,
        &tenant,
        resolve(&moderator, own_report, "dismiss"),
        "your own words",
        "dismiss a report about oneself",
    )
    .await;
    refuse(
        &state,
        &tenant,
        resolve(&moderator, fellow_report, "dismiss"),
        "same or higher standing",
        "dismiss a report about a fellow moderator",
    )
    .await;
    refuse(
        &state,
        &tenant,
        resolve(&moderator, owner_report, "dismiss"),
        "same or higher standing",
        "dismiss a report about the owner",
    )
    .await;
    // The board's owner outranks a moderator; a member closes nothing.
    accept(
        &state,
        &tenant,
        resolve(&owner, own_report, "dismiss"),
        "owner dismisses a report about a moderator",
    )
    .await;
    refuse(
        &state,
        &tenant,
        resolve(&member, fellow_report, "dismiss"),
        "restricted:",
        "member dismisses",
    )
    .await;

    // Recorded as a board moderator's, so the closing counts toward the hourly limit.
    let actions = state
        .db
        .list_moderation_actions(tenant.community(), 50)
        .await
        .expect("audit");
    let mine: Vec<_> = actions
        .iter()
        .filter(|a| a.actor_pubkey == moderator.public_key().to_bytes().as_slice())
        .map(|a| a.action.as_str())
        .collect();
    assert!(mine.contains(&"dismiss_report"), "{mine:?}");
    assert!(mine.contains(&"resolve:delete"), "{mine:?}");
    assert_eq!(
        state
            .db
            .board_moderator_actions_since(
                tenant.community(),
                &moderator.public_key().to_bytes(),
                chrono::Utc::now() - chrono::Duration::hours(1),
            )
            .await
            .expect("count"),
        2,
        "the removal and the dismissal count; closing after the removal does not count again"
    );
}

/// A private board created by `owner`, with `members` added to it.
async fn private_board(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    owner: &Keys,
    members: &[&Keys],
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
                &["name", "private-board"],
                &["visibility", "private"],
                &["channel_type", "forum"],
            ],
        ),
        "create a private board",
    )
    .await;
    for person in members {
        accept(
            state,
            tenant,
            signed(
                owner,
                9000,
                "",
                &[
                    &["h", &id.to_string()],
                    &["p", &person.public_key().to_hex()],
                    &["role", "member"],
                ],
            ),
            "add to the private board",
        )
        .await;
    }
    id
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_moderator_removed_from_a_private_board_keeps_no_authority_there() {
    let (owner, moderator, kept, author, reporter) = (
        Keys::generate(),
        Keys::generate(),
        Keys::generate(),
        Keys::generate(),
        Keys::generate(),
    );
    let (state, tenant) = community(&[
        (&owner, "member"),
        (&moderator, "member"),
        (&kept, "member"),
        (&author, "member"),
        (&reporter, "member"),
    ])
    .await;
    let b = private_board(
        &state,
        &tenant,
        &owner,
        &[&moderator, &kept, &author, &reporter],
    )
    .await;
    for person in [&moderator, &kept] {
        accept(
            &state,
            &tenant,
            on_person(&owner, KIND_BOARD_APPOINT_MODERATOR, b, person, None),
            "appoint",
        )
        .await;
    }
    let before = post(&state, &tenant, &author, b).await;
    let before_report = report(&reporter, &before);
    accept(
        &state,
        &tenant,
        before_report.clone(),
        "report before removal",
    )
    .await;
    assert_eq!(
        board_reports(&state, &tenant, b, &moderator).await.0,
        axum::http::StatusCode::OK,
        "a moderator on the board reads its reports"
    );

    // The owner removes the moderator from the board; the appointment itself is left as it was.
    accept(
        &state,
        &tenant,
        signed(
            &owner,
            9001,
            "",
            &[
                &["h", &b.to_string()],
                &["p", &moderator.public_key().to_hex()],
            ],
        ),
        "remove the moderator from the private board",
    )
    .await;
    let after = post(&state, &tenant, &author, b).await;
    let after_report = report(&reporter, &after);
    accept(
        &state,
        &tenant,
        after_report.clone(),
        "report after removal",
    )
    .await;

    // No report read, no closing (of a report filed before or after), no command.
    assert_eq!(
        board_reports(&state, &tenant, b, &moderator).await.0,
        axum::http::StatusCode::FORBIDDEN,
        "a removed moderator reads no private reports"
    );
    for r in [&before_report, &after_report] {
        refuse(
            &state,
            &tenant,
            resolve(&moderator, r, "dismiss"),
            "restricted:",
            "a removed moderator closes a report",
        )
        .await;
    }
    for kind in [
        buzz_core::kind::KIND_BOARD_LOCK_THREAD,
        buzz_core::kind::KIND_BOARD_PIN_THREAD,
    ] {
        assert!(
            !matches!(
                super::board_moderation_postgres_tests::ingest(
                    &state,
                    &tenant,
                    super::board_moderation_postgres_tests::on_post(&moderator, kind, b, &after),
                )
                .await,
                Ok(ref result) if result.accepted
            ),
            "a removed moderator still moderates (kind {kind})"
        );
    }
    let removal = remove(&moderator, b, &after, "spam");
    assert!(
        !matches!(
            super::board_moderation_postgres_tests::ingest(&state, &tenant, removal).await,
            Ok(ref result) if result.accepted
        ),
        "a removed moderator still removes posts"
    );
    assert_eq!(report_status(&state, &tenant, &before_report).await, "open");
    assert_eq!(report_status(&state, &tenant, &after_report).await, "open");

    // The moderator still on the board keeps every power, the report filed after the removal included.
    let (status, rows) = board_reports(&state, &tenant, b, &kept).await;
    assert_eq!(status, axum::http::StatusCode::OK);
    assert_eq!(rows.as_array().map_or(0, Vec::len), 2, "{rows}");
    accept(
        &state,
        &tenant,
        super::board_moderation_postgres_tests::on_post(
            &kept,
            buzz_core::kind::KIND_BOARD_LOCK_THREAD,
            b,
            &after,
        ),
        "a moderator still on the board locks",
    )
    .await;
    accept(
        &state,
        &tenant,
        resolve(&kept, &after_report, "dismiss"),
        "a moderator still on the board closes the later report",
    )
    .await;
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_moderators_actions_sent_together_stop_at_the_hourly_limit_across_paths() {
    let (owner, moderator, author, reporter) = (
        Keys::generate(),
        Keys::generate(),
        Keys::generate(),
        Keys::generate(),
    );
    let (state, tenant) = community(&[
        (&owner, "member"),
        (&moderator, "member"),
        (&author, "member"),
        (&reporter, "member"),
    ])
    .await;
    let b = board(&state, &tenant, &owner, "rate-race").await;
    // A second board: the allowance spans the community's boards.
    let other_board = board(&state, &tenant, &owner, "rate-race-two").await;
    for board in [b, other_board] {
        accept(
            &state,
            &tenant,
            on_person(
                &owner,
                KIND_BOARD_APPOINT_MODERATOR,
                board,
                &moderator,
                None,
            ),
            "appoint",
        )
        .await;
    }
    // Nineteen of the twenty, one at a time.
    let seed = post(&state, &tenant, &author, b).await;
    for round in 0..19 {
        let kind = if round % 2 == 0 {
            buzz_core::kind::KIND_BOARD_LOCK_THREAD
        } else {
            buzz_core::kind::KIND_BOARD_UNLOCK_THREAD
        };
        accept(
            &state,
            &tenant,
            super::board_moderation_postgres_tests::on_post(&moderator, kind, b, &seed),
            &format!("action {round}"),
        )
        .await;
    }
    // Then ten together, on both boards and by all three paths: locks, removals and dismissals.
    let mut together = Vec::new();
    let mut reports = Vec::new();
    for i in 0..4 {
        let board = if i % 2 == 0 { b } else { other_board };
        let thread = post(&state, &tenant, &author, board).await;
        together.push(super::board_moderation_postgres_tests::on_post(
            &moderator,
            buzz_core::kind::KIND_BOARD_LOCK_THREAD,
            board,
            &thread,
        ));
    }
    let mut removable = Vec::new();
    for _ in 0..3 {
        let words = post(&state, &tenant, &author, other_board).await;
        together.push(remove(&moderator, other_board, &words, "spam"));
        removable.push(words);
    }
    for _ in 0..3 {
        let words = post(&state, &tenant, &author, b).await;
        let r = report(&reporter, &words);
        accept(&state, &tenant, r.clone(), "report").await;
        together.push(resolve(&moderator, &r, "dismiss"));
        reports.push(r);
    }
    futures_util::future::join_all(
        together
            .into_iter()
            .map(|event| super::board_moderation_postgres_tests::ingest(&state, &tenant, event)),
    )
    .await;

    let counted = state
        .db
        .board_moderator_actions_since(
            tenant.community(),
            &moderator.public_key().to_bytes(),
            chrono::Utc::now() - chrono::Duration::hours(1),
        )
        .await
        .expect("count");
    assert_eq!(counted, 20, "the hour's actions");
    // Exactly one of the ten took effect, and only what was counted did.
    let mut effects = 0;
    for words in &removable {
        if state
            .db
            .get_event_by_id(tenant.community(), &words.id.to_bytes())
            .await
            .expect("read")
            .is_none()
        {
            effects += 1;
        }
    }
    for r in &reports {
        if report_status(&state, &tenant, r).await != "open" {
            effects += 1;
        }
    }
    let locked: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM board_thread_state WHERE community_id = $1 AND locked_at IS NOT NULL",
    )
    .bind(tenant.community().as_uuid())
    .fetch_one(state.db.pool())
    .await
    .expect("count locks");
    // The seed thread ends locked (the nineteenth action was a lock).
    effects += usize::try_from(locked - 1).expect("locks");
    assert_eq!(effects, 1, "one of the ten took effect");
}
