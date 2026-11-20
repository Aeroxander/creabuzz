//! The alert maker against a real database: the chain's own rows (the real run's launch and Share transfers, and task
//! rows the tests add), real signed wallet links through the real ingest, and devices kept the way the paths keep them.
//! Ignored without infrastructure; run with
//! `cargo test -p buzz-relay --lib -- web_push::alerts_postgres_tests --include-ignored --test-threads=1`.
//!
//! Each guard is switched off once and the test that names it fails: the cursor's start (P7b), the unique key (P7), the
//! audience's link and floor (P8), the two caps (P10), the rollback (P14), the failed pass that keeps the cursor.

use chrono::Utc;
use sqlx::Row;

use super::alerts::{audience_of, make_alerts, ALERT_LIFETIME_SECS};
use super::test_support::{
    add_block, add_task_row, push_world, set_reader_next, subscribed, task_event, PushWorld,
};
use crate::handlers::room_write::ROOM_MIN_SHARES;

// The run's accounts (see `room_write_postgres_tests.rs`): account 3 holds Shares at the end, account 2 backed and took
// out, account 4 was sent Shares, account 0 holds nothing of project A.
const HOLDER: usize = 3;
const LEAVER: usize = 2;
const LATE: usize = 4;
const NOBODY: usize = 0;

async fn scalar(pw: &PushWorld, sql: &'static str) -> i64 {
    sqlx::query_scalar::<_, i64>(sql)
        .bind(&pw.w.reader)
        .bind(pw.w.tenant.community().as_uuid())
        .fetch_one(pw.w.state.db.pool())
        .await
        .expect("a count")
}

async fn alert_count(pw: &PushWorld) -> i64 {
    scalar(
        pw,
        "SELECT count(*) FROM web_push_alerts WHERE reader = $1 AND $2::uuid IS NOT NULL",
    )
    .await
}

async fn outbox_count(pw: &PushWorld) -> i64 {
    scalar(
        pw,
        "SELECT count(*) FROM web_push_outbox o JOIN web_push_alerts a ON a.id = o.alert_id \
         WHERE a.reader = $1 AND o.community_id = $2",
    )
    .await
}

async fn cursor(pw: &PushWorld) -> Option<i64> {
    sqlx::query_scalar("SELECT next_block FROM web_push_cursor WHERE reader = $1")
        .bind(&pw.w.reader)
        .fetch_optional(pw.w.state.db.pool())
        .await
        .expect("the cursor")
}

async fn make(pw: &PushWorld) -> anyhow::Result<super::alerts::MakeReport> {
    make_alerts(&pw.w.state, &pw.config, Utc::now()).await
}

/// The newest block of the run and its time: the task rows the tests add come after it.
fn head(pw: &PushWorld) -> (u64, u64) {
    let head = pw.w.fx.head();
    (head, pw.w.time_of(head))
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn p7b_a_fresh_cursor_starts_at_the_readers_position_and_old_rows_make_no_alert() {
    let pw = push_world().await;
    let (head, t0) = head(&pw);
    let (_holder, _device) = subscribed(&pw, HOLDER).await;
    // 100 task rows the chain has had since before push was on: the reader has read all of them.
    for i in 1..=100u64 {
        add_block(&pw.w, head + i, t0 + i * 12).await;
        add_task_row(&pw.w, head + i, 0, "TaskAnnounced", i, None).await;
    }
    set_reader_next(&pw.w, head + 101).await;
    assert_eq!(
        cursor(&pw).await,
        None,
        "no cursor before push is first switched on"
    );
    let first = make(&pw).await.expect("the first pass");
    assert_eq!(
        (first.rows, first.made),
        (0, 0),
        "the history is never alerted: {first:?}"
    );
    assert_eq!(
        cursor(&pw).await,
        Some(i64::try_from(head + 101).expect("block"))
    );
    assert_eq!(alert_count(&pw).await, 0);
    // One row after the cursor makes one alert.
    task_event(&pw.w, head + 101, t0 + 2_000, "TaskAnnounced", 101, None).await;
    let second = make(&pw).await.expect("the second pass");
    assert_eq!(
        (second.rows, second.made, second.queued),
        (1, 1, 1),
        "{second:?}"
    );
    assert_eq!(
        cursor(&pw).await,
        Some(i64::try_from(head + 102).expect("block"))
    );
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn p7_one_alert_per_task_event_and_a_repeated_pass_or_a_rewound_cursor_makes_no_second() {
    let pw = push_world().await;
    let (head, t0) = head(&pw);
    let (_holder, _device) = subscribed(&pw, HOLDER).await;
    make(&pw).await.expect("starts the cursor");
    task_event(&pw.w, head + 1, t0 + 100, "TaskAnnounced", 1, None).await;
    let first = make(&pw).await.expect("pass");
    assert_eq!((first.made, first.queued), (1, 1), "{first:?}");
    assert_eq!(make(&pw).await.expect("a repeated pass").made, 0);
    // A stop between the alert and the cursor repeats the row and never makes a second alert: rewind the cursor.
    sqlx::query("UPDATE web_push_cursor SET next_block = $2 WHERE reader = $1")
        .bind(&pw.w.reader)
        .bind(i64::try_from(head + 1).expect("block"))
        .execute(pw.w.state.db.pool())
        .await
        .expect("rewind");
    let again = make(&pw).await.expect("the repeated row");
    assert_eq!(
        (again.rows, again.made, again.queued),
        (1, 0, 0),
        "{again:?}"
    );
    assert_eq!((alert_count(&pw).await, outbox_count(&pw).await), (1, 1));
    // The three kinds, each its own alert; the task ended in any way but a withdrawal is `ended`.
    task_event(&pw.w, head + 2, t0 + 200, "TaskTaken", 1, None).await;
    task_event(&pw.w, head + 3, t0 + 300, "TaskResolved", 1, Some(3)).await;
    let rest = make(&pw).await.expect("pass");
    assert_eq!(rest.made, 2, "{rest:?}");
    let kinds: Vec<String> =
        sqlx::query_scalar("SELECT kind FROM web_push_alerts WHERE reader = $1 ORDER BY id")
            .bind(&pw.w.reader)
            .fetch_all(pw.w.state.db.pool())
            .await
            .expect("kinds");
    assert_eq!(kinds, ["planned", "taken", "ended"]);
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_withdrawn_plan_makes_no_alert_and_the_other_endings_do() {
    let pw = push_world().await;
    let (head, t0) = head(&pw);
    let (_holder, _device) = subscribed(&pw, HOLDER).await;
    make(&pw).await.expect("starts the cursor");
    task_event(&pw.w, head + 1, t0 + 100, "TaskResolved", 1, Some(6)).await;
    let withdrawn = make(&pw).await.expect("pass");
    assert_eq!(
        (withdrawn.rows, withdrawn.made, withdrawn.skipped),
        (1, 0, 1),
        "{withdrawn:?}"
    );
    // A plan that is announced and withdrawn before the pass looks at it makes no alert at all: neither the plan nor the end.
    add_block(&pw.w, head + 2, t0 + 150).await;
    add_task_row(&pw.w, head + 2, 0, "TaskAnnounced", 7, None).await;
    task_event(&pw.w, head + 3, t0 + 160, "TaskResolved", 7, Some(6)).await;
    let both = make(&pw).await.expect("pass");
    assert_eq!((both.rows, both.made, both.skipped), (2, 0, 2), "{both:?}");
    assert_eq!(alert_count(&pw).await, 0);
    for (i, state) in [4u64, 5, 7].into_iter().enumerate() {
        let block = head + 4 + u64::try_from(i).expect("small");
        task_event(
            &pw.w,
            block,
            t0 + 200 + u64::try_from(i).expect("small"),
            "TaskResolved",
            10 + state,
            Some(state),
        )
        .await;
    }
    assert_eq!(
        make(&pw).await.expect("pass").made,
        3,
        "sent back, lapsed and run out are all `ended`"
    );
}

/// Rule 1: a pass that fails leaves the cursor where it was, so the next pass makes the same alerts; none is skipped and
/// none is made twice.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_failed_pass_keeps_the_cursor_and_the_next_pass_makes_every_alert() {
    let pw = push_world().await;
    let (head, t0) = head(&pw);
    let (_holder, _device) = subscribed(&pw, HOLDER).await;
    make(&pw).await.expect("starts the cursor");
    let start = cursor(&pw).await.expect("cursor");
    task_event(&pw.w, head + 1, t0 + 100, "TaskAnnounced", 1, None).await;
    task_event(&pw.w, head + 2, t0 + 200, "TaskAnnounced", 2, None).await;
    // A row that cannot be read (a serial that is not a number) fails the whole pass.
    sqlx::query("UPDATE chain_logs SET decoded = jsonb_set(decoded, '{serial}', '\"x\"') WHERE reader = $1 AND block_number = $2")
        .bind(&pw.w.reader)
        .bind(i64::try_from(head + 2).expect("block"))
        .execute(pw.w.state.db.pool())
        .await
        .expect("break a row");
    assert!(make(&pw).await.is_err(), "the pass fails");
    assert_eq!(cursor(&pw).await, Some(start), "the cursor did not move");
    assert_eq!(
        (alert_count(&pw).await, outbox_count(&pw).await),
        (0, 0),
        "and nothing was made"
    );
    sqlx::query("UPDATE chain_logs SET decoded = jsonb_set(decoded, '{serial}', '\"2\"') WHERE reader = $1 AND block_number = $2")
        .bind(&pw.w.reader)
        .bind(i64::try_from(head + 2).expect("block"))
        .execute(pw.w.state.db.pool())
        .await
        .expect("mend it");
    let report = make(&pw).await.expect("the next pass");
    assert_eq!((report.made, report.queued), (2, 2), "{report:?}");
    assert_eq!(
        cursor(&pw).await,
        Some(i64::try_from(head + 3).expect("block"))
    );
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_row_older_than_the_alerts_own_lifetime_is_dropped_not_sent() {
    let pw = push_world().await;
    let (head, t0) = head(&pw);
    let (_holder, _device) = subscribed(&pw, HOLDER).await;
    make(&pw).await.expect("starts the cursor");
    // The row is in an old block; the reader has since read a block a day and an hour later.
    add_block(&pw.w, head + 1, t0 + 10).await;
    add_task_row(&pw.w, head + 1, 0, "TaskAnnounced", 1, None).await;
    add_block(&pw.w, head + 2, t0 + 10 + ALERT_LIFETIME_SECS + 3_600).await;
    set_reader_next(&pw.w, head + 3).await;
    let report = make(&pw).await.expect("pass");
    assert_eq!(
        (report.rows, report.too_old, report.made),
        (1, 1, 0),
        "{report:?}"
    );
    assert_eq!(
        cursor(&pw).await,
        Some(i64::try_from(head + 3).expect("block")),
        "the cursor still moved past it"
    );
}

/// P8: the audience is the accounts that proved the wallet of a holder, and nobody else.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn p8_only_a_linked_holder_is_told() {
    let pw = push_world().await;
    let (head, t0) = head(&pw);
    let (holder, holder_device) = subscribed(&pw, HOLDER).await;
    let (_leaver, leaver_device) = subscribed(&pw, LEAVER).await;
    let (_nobody, nobody_device) = subscribed(&pw, NOBODY).await;
    // A person with a device and no linked wallet; and a holder (account 4) who linked and then took the link back.
    let unlinked = pw.w.account().await;
    let unlinked_device = pw.stand_in.device();
    super::test_support::keep(&pw, &unlinked, &unlinked_device).await;
    let (revoked, revoked_device) = subscribed(&pw, LATE).await;
    // A replacement signed in the same second as the record it replaces does not replace it.
    tokio::time::sleep(std::time::Duration::from_millis(1_100)).await;
    pw.w.unlink(&revoked, LATE)
        .await
        .expect("takes the link back");
    make(&pw).await.expect("starts the cursor");
    task_event(&pw.w, head + 1, t0 + 100, "TaskAnnounced", 1, None).await;
    let report = make(&pw).await.expect("pass");
    assert_eq!((report.made, report.queued), (1, 1), "{report:?}");
    let told: Vec<Vec<u8>> = sqlx::query_scalar(
        "SELECT s.pubkey FROM web_push_outbox o JOIN web_push_subscriptions s \
         ON s.community_id = o.community_id AND s.id = o.subscription_id WHERE o.community_id = $1",
    )
    .bind(pw.w.tenant.community().as_uuid())
    .fetch_all(pw.w.state.db.pool())
    .await
    .expect("who is told");
    assert_eq!(
        told,
        vec![holder.public_key().to_bytes().to_vec()],
        "only the linked holder"
    );
    let _ = (
        holder_device,
        leaver_device,
        nobody_device,
        unlinked_device,
        revoked_device,
    );
}

/// P8: the audience's order, the dust floor, the contract accounts left out, and the cut at 2,000 with the cut counted.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn p8_the_audience_is_largest_first_above_the_floor_and_cut_at_2000_with_the_cut_counted() {
    let pw = push_world().await;
    let key = [0x5au8; 32];
    let community = pw.w.tenant.community();
    let wallet = |n: usize| {
        let (_, address) = crate::handlers::room_support::anvil(&pw.w.fx, n);
        crate::chain_reader::word::parse_fixed::<20>(&address).expect("address")
    };
    let mut accounts = Vec::new();
    for n in [HOLDER, LATE, NOBODY, LEAVER] {
        let keys = pw.w.account().await;
        pw.w.link(&keys, n, 3_600).await.expect("link");
        accounts.push((n, keys.public_key().to_bytes().to_vec()));
    }
    let set = |n: usize, token: &'static str, amount: u128| {
        let account = wallet(n);
        let (pool, reader) = (pw.w.state.db.pool().clone(), pw.w.reader.clone());
        async move {
            sqlx::query(
                "INSERT INTO chain_balances (reader, project_key, token, account, balance) VALUES ($1, $2, $3, $4, $5::numeric)",
            )
            .bind(reader)
            .bind(key.as_slice())
            .bind(token)
            .bind(account.as_slice())
            .bind(amount.to_string())
            .execute(&pool)
            .await
            .expect("a balance");
        }
    };
    set(LATE, "shares", 9_000_000_000_000_000_000).await;
    set(HOLDER, "shares", 5_000_000_000_000_000_000).await;
    set(NOBODY, "shares", ROOM_MIN_SHARES).await; // exactly at the floor
    set(LEAVER, "team", ROOM_MIN_SHARES - 1).await; // one wei short of it
    let pubkey_of = |n: usize| {
        accounts
            .iter()
            .find(|(m, _)| *m == n)
            .expect("account")
            .1
            .clone()
    };
    let told = audience_of(&pw.w.state, community, &pw.w.reader, &key, &[])
        .await
        .expect("audience");
    assert_eq!(
        told.accounts,
        vec![pubkey_of(LATE), pubkey_of(HOLDER), pubkey_of(NOBODY)],
        "largest first, the floor in, a wei short out"
    );
    assert_eq!((told.holders, told.cut), (3, 0));
    let without_late = audience_of(
        &pw.w.state,
        community,
        &pw.w.reader,
        &key,
        &[wallet(LATE).to_vec()],
    )
    .await
    .expect("audience");
    assert_eq!(
        without_late.accounts,
        vec![pubkey_of(HOLDER), pubkey_of(NOBODY)],
        "an excluded account is left out"
    );
    // 2,005 more holders (no linked wallet among them): the cut is at 2,000 and the five are counted.
    sqlx::query(
        "INSERT INTO chain_balances (reader, project_key, token, account, balance) \
         SELECT $1::text, $2::bytea, 'shares', \
                substring(decode(md5($1::text || i::text) || md5(encode($2::bytea, 'hex') || i::text), 'hex') from 1 for 20), \
                1000000000000000 + i FROM generate_series(1, 2005) AS i",
    )
    .bind(&pw.w.reader)
    .bind(key.as_slice())
    .execute(pw.w.state.db.pool())
    .await
    .expect("holders");
    let many = audience_of(&pw.w.state, community, &pw.w.reader, &key, &[])
        .await
        .expect("audience");
    assert_eq!(many.holders, 2_000);
    assert_eq!(many.cut, 3 + 2005 - 2_000, "the cut is counted");
    assert_eq!(
        many.accounts.first(),
        Some(&pubkey_of(LATE)),
        "the largest holder is still first"
    );
}

/// P10: at most `daily_cap` alerts a device a day and 3 a project; the rest are written as `dropped` with the reason.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn p10_the_project_cap_and_the_daily_cap_write_dropped_rows_with_their_reason() {
    for (daily_cap, expected) in [
        (
            6u32,
            vec![
                ("pending", None),
                ("pending", None),
                ("pending", None),
                ("dropped", Some("project_cap")),
            ],
        ),
        (
            2,
            vec![
                ("pending", None),
                ("pending", None),
                ("dropped", Some("daily_cap")),
                ("dropped", Some("daily_cap")),
            ],
        ),
    ] {
        let mut pw = push_world().await;
        pw.config.daily_cap = daily_cap;
        let (head, t0) = head(&pw);
        let (_holder, _device) = subscribed(&pw, HOLDER).await;
        make(&pw).await.expect("starts the cursor");
        for serial in 1..=4u64 {
            task_event(
                &pw.w,
                head + serial,
                t0 + serial * 100,
                "TaskAnnounced",
                serial,
                None,
            )
            .await;
        }
        let report = make(&pw).await.expect("pass");
        assert_eq!(report.made, 4, "{report:?}");
        let rows = sqlx::query(
            "SELECT o.state, o.drop_reason, o.done_at IS NOT NULL AS done FROM web_push_outbox o \
             JOIN web_push_alerts a ON a.id = o.alert_id WHERE a.reader = $1 ORDER BY a.serial",
        )
        .bind(&pw.w.reader)
        .fetch_all(pw.w.state.db.pool())
        .await
        .expect("rows");
        let got: Vec<(String, Option<String>)> = rows
            .iter()
            .map(|r| {
                (
                    r.get::<String, _>("state"),
                    r.get::<Option<String>, _>("drop_reason"),
                )
            })
            .collect();
        let want: Vec<(String, Option<String>)> = expected
            .iter()
            .map(|(s, r)| ((*s).to_owned(), r.map(str::to_owned)))
            .collect();
        assert_eq!(got, want, "daily cap {daily_cap}");
        assert!(
            rows.iter()
                .all(|r| r.get::<bool, _>("done") == (r.get::<String, _>("state") == "dropped")),
            "a dropped row is finished the moment it is written"
        );
        assert_eq!(
            report.dropped,
            want.iter().filter(|(s, _)| s == "dropped").count()
        );
    }
}

/// A project whose record cannot be found makes an alert that reaches nobody, as a durable row.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_project_with_no_record_makes_an_alert_that_reaches_nobody() {
    let pw = push_world().await;
    let (head, t0) = head(&pw);
    let (_holder, _device) = subscribed(&pw, HOLDER).await;
    make(&pw).await.expect("starts the cursor");
    add_block(&pw.w, head + 1, t0 + 100).await;
    let stranger_project = vec![0x77u8; 32];
    sqlx::query(
        "INSERT INTO chain_logs (reader, block_number, log_index, block_hash, tx_hash, address, role, project_key, event, \
         topics, data, decoded) VALUES ($1, $2, 0, $3, $3, $4, 'tasks', $5, 'TaskAnnounced', $6, $7, '{\"serial\":\"1\"}'::jsonb)",
    )
    .bind(&pw.w.reader)
    .bind(i64::try_from(head + 1).expect("block"))
    .bind(vec![1u8; 32])
    .bind(vec![2u8; 20])
    .bind(&stranger_project)
    .bind(Vec::<Vec<u8>>::new())
    .bind(Vec::<u8>::new())
    .execute(pw.w.state.db.pool())
    .await
    .expect("a row of a project nobody has a record of");
    set_reader_next(&pw.w, head + 2).await;
    let report = make(&pw).await.expect("pass");
    assert_eq!((report.made, report.queued), (1, 0), "{report:?}");
    let link: Option<String> =
        sqlx::query_scalar("SELECT link_ref FROM web_push_alerts WHERE reader = $1")
            .bind(&pw.w.reader)
            .fetch_one(pw.w.state.db.pool())
            .await
            .expect("the alert");
    assert_eq!(link, None);
}

/// The link is the project's own: the record's id and the first 16 hex of its founder, tied to the launch.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn the_alert_carries_the_projects_link_reference() {
    let pw = push_world().await;
    let (head, t0) = head(&pw);
    let (_holder, _device) = subscribed(&pw, HOLDER).await;
    make(&pw).await.expect("starts the cursor");
    task_event(&pw.w, head + 1, t0 + 100, "TaskAnnounced", 1, None).await;
    make(&pw).await.expect("pass");
    let link: Option<String> =
        sqlx::query_scalar("SELECT link_ref FROM web_push_alerts WHERE reader = $1")
            .bind(&pw.w.reader)
            .fetch_one(pw.w.state.db.pool())
            .await
            .expect("the alert");
    assert_eq!(
        link,
        Some(format!(
            "orbit-{}",
            &pw.w.founder.public_key().to_hex()[..16]
        ))
    );
}

/// P14: a rollback below an alert's block deletes its rows that have not left the server and leaves delivered ones; the
/// cursor comes down with the reader, and the new chain's alert can be made.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn p14_a_rollback_deletes_pending_rows_and_leaves_delivered_ones() {
    let pw = push_world().await;
    let (head, t0) = head(&pw);
    let (_holder, _device) = subscribed(&pw, HOLDER).await;
    make(&pw).await.expect("starts the cursor");
    task_event(&pw.w, head + 1, t0 + 100, "TaskAnnounced", 1, None).await;
    task_event(&pw.w, head + 2, t0 + 200, "TaskAnnounced", 2, None).await;
    assert_eq!(make(&pw).await.expect("pass").made, 2);
    // The first alert's row has left the server.
    sqlx::query(
        "UPDATE web_push_outbox SET state = 'delivered', done_at = now() WHERE alert_id = \
         (SELECT id FROM web_push_alerts WHERE reader = $1 AND serial = 1)",
    )
    .bind(&pw.w.reader)
    .execute(pw.w.state.db.pool())
    .await
    .expect("deliver");
    // The chain falls back to block head + 1: both rows are on blocks that no longer exist (the reader deletes them).
    sqlx::query("DELETE FROM chain_logs WHERE reader = $1 AND block_number > $2")
        .bind(&pw.w.reader)
        .bind(i64::try_from(head).expect("block"))
        .execute(pw.w.state.db.pool())
        .await
        .expect("the reader forgets the rolled back rows");
    set_reader_next(&pw.w, head + 1).await;
    let report = make(&pw).await.expect("pass after the rollback");
    assert_eq!(report.undone, 1, "{report:?}");
    let states: Vec<(i64, String)> = sqlx::query(
        "SELECT a.serial, o.state FROM web_push_alerts a JOIN web_push_outbox o ON o.alert_id = a.id WHERE a.reader = $1",
    )
    .bind(&pw.w.reader)
    .fetch_all(pw.w.state.db.pool())
    .await
    .expect("rows")
    .iter()
    .map(|r| (r.get("serial"), r.get("state")))
    .collect();
    assert_eq!(
        states,
        vec![(1, "delivered".to_owned())],
        "only the delivered row is left"
    );
    let serials: Vec<i64> =
        sqlx::query_scalar("SELECT serial FROM web_push_alerts WHERE reader = $1 ORDER BY serial")
            .bind(&pw.w.reader)
            .fetch_all(pw.w.state.db.pool())
            .await
            .expect("serials");
    assert_eq!(
        serials,
        vec![1],
        "the alert nobody was told of can be made again by the new chain"
    );
    assert_eq!(
        cursor(&pw).await,
        Some(i64::try_from(head + 1).expect("block")),
        "the cursor came down with the reader"
    );
    // The new chain has the task at a later block: the alert is made again.
    task_event(&pw.w, head + 1, t0 + 300, "TaskAnnounced", 2, None).await;
    assert_eq!(make(&pw).await.expect("pass").made, 1);
}
