//! Regression tests for the reader hardening of milestone 5 part 2 (review
//! findings F6 and F7), on the fake chain of `postgres_tests.rs` with real
//! Postgres. Ignored without infrastructure; run with
//! `cargo test -p buzz-relay --lib chain_reader::hardening_postgres_tests -- --ignored --test-threads=1`.

use std::sync::Arc;

use serde_json::json;

use super::postgres_tests::{
    ask, close_and_settle, key, latest_record, launch_logs, setup, with_launcher, FakeChain, DAY,
    T0,
};
use super::publish;
use super::store;
use super::word::hex0x;

/// F6: a newer record already stored for the project (another writer's, or
/// one signed with a clock ahead) hid the reader's record while the reader
/// remembered it as signed. Now it signs once more just after the stored one,
/// and remembers the time it kept.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_newer_stored_record_does_not_hide_the_numbers() {
    let chain = Arc::new(FakeChain::default());
    let (reader, state, host) = setup(Arc::clone(&chain), 0).await;
    chain.mine(T0, 1, with_launcher(launch_logs(), reader.config.launcher));
    chain.mine(T0 + 10, 1, vec![ask(1_000_000)]);
    chain.mine(T0 + 20, 1, vec![]);
    chain.mine(T0 + 30, 1, vec![]);

    // A record for the same project, signed an hour in the future.
    let ahead = u64::try_from(chrono::Utc::now().timestamp()).expect("time") + 3_600;
    let tenant = reader.tenant().await.expect("tenant").expect("community");
    let key_hex = hex0x(&key());
    let tags = publish::tags(
        &key_hex,
        reader.config.chain_id,
        &hex0x(&reader.config.launcher),
    )
    .expect("tags");
    let planted = publish::publish(
        &state,
        &tenant,
        tags,
        &key_hex,
        &json!({"version": 1, "key": key_hex, "planted": true}),
        ahead,
    )
    .await
    .expect("plant");
    assert!(matches!(planted, publish::Outcome::Stored(_)));

    let (_, published) = reader.pass().await.expect("pass");
    assert_eq!(published.signed, 1);
    let shown = latest_record(&state, &host).await.expect("a record");
    assert_eq!(shown.get("planted"), None, "the reader's numbers are shown");
    assert_eq!(shown["rounds"][0]["asked"], "1000000");
    let kept = store::published(state.db.pool(), reader.reader_id())
        .await
        .expect("published");
    let row = kept.get(&key()).expect("remembered");
    assert_eq!(row.published_at, i64::try_from(ahead + 1).expect("time"));
}

/// F7: a node behind the stored blocks (a lagging replica behind a load
/// balancer) is not a rollback: nothing is deleted, signed or sent, and the
/// reader carries on once the node catches up.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_node_behind_the_stored_blocks_is_waited_for_not_rolled_back() {
    let chain = Arc::new(FakeChain::default());
    let (reader, state, _host) = setup(Arc::clone(&chain), 0).await;
    chain.mine(T0, 1, with_launcher(launch_logs(), reader.config.launcher)); // 0
    chain.mine(T0 + 10, 1, vec![ask(1_000_000)]); // 1
    chain.mine(T0 + 20, 1, vec![]); // 2
    chain.mine(T0 + 30, 1, vec![]); // 3
    let (first, published) = reader.pass().await.expect("pass");
    assert_eq!(published.signed, 1);
    let cursor = store::cursor(state.db.pool(), reader.reader_id())
        .await
        .expect("cursor");
    let logs_before = count_logs(&state, reader.reader_id()).await;
    assert!(first.scanned_to.is_some());

    // New events arrive, but the node answering now is two blocks behind
    // what was stored.
    chain.mine(T0 + DAY, 1, close_and_settle(1_000_000)); // 4
    chain.mine(T0 + DAY + 10, 1, vec![]); // 5
    chain.mine(T0 + DAY + 20, 1, vec![]); // 6
    *chain.behind.lock().expect("lock") = Some(cursor.saturating_sub(3));
    let report = reader.pass_all().await.expect("a pass behind");
    assert!(report.scanned.behind, "{:?}", report.scanned);
    assert_eq!(report.scanned.rolled_back_to, None);
    assert_eq!(report.scanned.logs_removed, 0);
    assert_eq!(report.published.signed, 0);
    assert_eq!(count_logs(&state, reader.reader_id()).await, logs_before);
    assert_eq!(
        store::cursor(state.db.pool(), reader.reader_id())
            .await
            .expect("cursor"),
        cursor
    );

    // The node catches up: the new blocks are read, nothing was undone.
    *chain.behind.lock().expect("lock") = None;
    let report = reader.pass_all().await.expect("a pass caught up");
    assert!(!report.scanned.behind);
    assert_eq!(report.scanned.rolled_back_to, None);
    assert_eq!(report.published.signed, 1);
    assert!(count_logs(&state, reader.reader_id()).await > logs_before);
}

async fn count_logs(state: &crate::state::AppState, reader: &str) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM chain_logs WHERE reader = $1")
        .bind(reader)
        .fetch_one(state.db.pool())
        .await
        .expect("count")
}

/// The claim contract named in `ProjectZeroSplit` is followed from its launch
/// block, and its events reach project zero's record as counts and totals.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn the_earlier_backers_claim_is_found_and_counted() {
    use super::events::Role;
    use super::postgres_tests::{a, data, topic, u};
    const CLAIM: [u8; 20] = [0xc1; 20];
    let chain = Arc::new(FakeChain::default());
    let (reader, state, host) = setup(Arc::clone(&chain), 0).await;
    let launcher = reader.config.launcher;
    let mut launch = with_launcher(launch_logs(), launcher);
    launch.push((
        launcher,
        vec![topic(Role::Launcher, "ProjectZeroSplit"), key(), a(&CLAIM)],
        data(&[u(50), u(30), u(120)]),
    ));
    chain.mine(T0, 1, launch); // 0
    chain.mine(
        T0 + DAY,
        1,
        vec![(
            CLAIM,
            vec![
                topic(Role::Earlier, "Consented"),
                u(0),
                a(&[0xe1; 20]),
                a(&[0xd1; 20]),
            ],
            data(&[u(100), [0; 32]]),
        )],
    ); // 1
    chain.mine(T0 + DAY + 10, 1, vec![]); // 2
    chain.mine(T0 + DAY + 20, 1, vec![]); // 3
    let (_, published) = reader.pass().await.expect("pass");
    assert_eq!(published.signed, 1);
    let n = latest_record(&state, &host).await.expect("a record");
    assert_eq!(n["earlierBackers"]["teamBudget"], "120");
    assert_eq!(n["earlierBackers"]["consented"]["count"], 1);
    assert_eq!(n["earlierBackers"]["consented"]["total"], "100");
}
