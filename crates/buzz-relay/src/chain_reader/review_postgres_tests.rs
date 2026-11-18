//! Regression tests for the milestone 5 part 1 review (findings I1-I3 and
//! F1-F4), on the fake chain of `postgres_tests.rs` with real Postgres. Ignored
//! without infrastructure; run with
//! `cargo test -p buzz-relay --lib chain_reader::review_postgres_tests -- --ignored --test-threads=1`.

use std::sync::atomic::Ordering;
use std::sync::Arc;

use buzz_core::kind::KIND_PROJECT_NUMBERS;
use serde_json::Value;
use sqlx::Row;

use super::events::Role;
use super::postgres_tests::{
    a, ask, data, launch_logs, setup, topic, u, with_launcher, FakeChain, DAY, PRICE, T0,
};
use super::store;
use super::word::{hex0x, Word};

type LogSpec = ([u8; 20], Vec<Word>, Vec<u8>);

const FOUNDER: [u8; 20] = [0xf0; 20];
const BACKER: [u8; 20] = [0xb0; 20];

/// Project `i`'s contracts: shares 1, treasury 2, vester 3, finisher 4, rounds 5.
fn addr(i: u8, r: u8) -> [u8; 20] {
    let mut x = [0u8; 20];
    x[0] = 0x40;
    x[1] = i;
    x[2] = r;
    x
}

/// Project `i` launched: key `[i; 32]`.
fn launch(launcher: [u8; 20], i: u8) -> LogSpec {
    let mut words = vec![a(&FOUNDER)];
    for r in 1..=5 {
        words.push(a(&addr(i, r)));
    }
    words.push(u(T0 as u128));
    words.extend([u(1), u(2), u(3), u(4), u(5), u(6)]);
    words.extend([
        a(&[0xd0; 20]),
        a(&[0xe0; 20]),
        a(&[0xc0; 20]),
        u(500),
        u(300),
        u(15),
        u(60),
        u(1),
        u(1),
    ]);
    (
        launcher,
        vec![
            topic(Role::Launcher, "ProjectLaunched"),
            [i; 32],
            [7; 32],
            a(&FOUNDER),
        ],
        data(&words),
    )
}

fn check_in(i: u8) -> LogSpec {
    (
        addr(i, 2),
        vec![topic(Role::Treasury, "CheckedIn"), a(&FOUNDER)],
        Vec::new(),
    )
}

fn round_opened(i: u8) -> LogSpec {
    (
        addr(i, 5),
        vec![topic(Role::Rounds, "RoundOpened"), u(1)],
        data(&[
            u(10_000_000_000),
            u(PRICE),
            u(T0 as u128),
            u((T0 + DAY) as u128),
        ]),
    )
}

fn close_and_settle(i: u8, amount: u128) -> Vec<LogSpec> {
    vec![
        (
            addr(i, 5),
            vec![topic(Role::Rounds, "RoundClosed"), u(1)],
            data(&[u(amount), u(amount), u(DAY as u128)]),
        ),
        (
            addr(i, 5),
            vec![topic(Role::Rounds, "Settled"), u(1), a(&BACKER)],
            data(&[
                u(amount),
                u(0),
                u(amount * PRICE),
                u(amount * 3 / 100),
                u(amount * 15 / 100),
                u(amount * 82 / 100),
            ]),
        ),
        (
            addr(i, 3),
            vec![topic(Role::Vester, "HeldGranted"), u(1), a(&BACKER)],
            data(&[u(amount * PRICE)]),
        ),
    ]
}

fn runner_changed(i: u8, from: &[u8; 20], to: &[u8; 20]) -> LogSpec {
    (
        addr(i, 2),
        vec![topic(Role::Treasury, "RunnerChanged"), a(from), a(to)],
        data(&[u(0)]),
    )
}

/// The newest record signed for project `key` in the reader's community.
async fn record_of(state: &crate::state::AppState, host: &str, key: &Word) -> Option<Value> {
    let community = state
        .db
        .lookup_community_by_host(host)
        .await
        .expect("lookup")
        .expect("community")
        .id;
    let rows = sqlx::query(
        "SELECT content FROM events WHERE community_id = $1 AND kind = $2 AND deleted_at IS NULL \
         ORDER BY created_at DESC",
    )
    .bind(community.as_uuid())
    .bind(KIND_PROJECT_NUMBERS as i32)
    .fetch_all(state.db.pool())
    .await
    .expect("query");
    rows.into_iter()
        .map(|r| {
            let text: String = r.try_get("content").expect("content");
            serde_json::from_str::<Value>(&text).expect("json")
        })
        .find(|v| v["key"] == hex0x(key))
}

/// I2 / F1: a range answering more logs than the node allows is read in
/// smaller ranges instead of failing every pass for good.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_range_with_too_many_logs_is_read_in_smaller_ranges() {
    let chain = Arc::new(FakeChain::default());
    *chain.limit.lock().expect("lock") = Some(5);
    let (reader, state, host) = setup(Arc::clone(&chain), 0).await;
    let launcher = reader.config.launcher;
    chain.mine(T0, 1, with_launcher(launch_logs(), launcher)); // 0: 4 logs
    chain.mine(
        T0 + 10,
        1,
        vec![ask(1_000_000), ask(2_000_000), ask(3_000_000)],
    ); // 1
    chain.mine(
        T0 + 20,
        1,
        vec![ask(4_000_000), ask(5_000_000), ask(6_000_000)],
    ); // 2
    chain.mine(T0 + 30, 1, vec![]); // 3
    chain.mine(T0 + 40, 1, vec![]); // 4: head; blocks 0..=2 are read
                                    // log_range 3: blocks 0..=2 hold 10 logs, over the node's 5.
    let (scanned, published) = reader.pass().await.expect("the pass reads smaller ranges");
    assert_eq!(scanned.scanned_to, Some(2));
    assert_eq!(scanned.logs, 10);
    assert_eq!(published.signed, 1);
    assert_eq!(
        store::cursor(state.db.pool(), reader.reader_id())
            .await
            .expect("cursor"),
        3
    );
    let n = latest_record_of_key(&state, &host).await;
    assert_eq!(n["rounds"][0]["asked"], "6000000");

    // One block alone over the limit: the pass fails and says why.
    let chain = Arc::new(FakeChain::default());
    *chain.limit.lock().expect("lock") = Some(2);
    let (reader, _, _) = setup(Arc::clone(&chain), 0).await;
    chain.mine(T0, 1, with_launcher(launch_logs(), reader.config.launcher));
    chain.mine(T0 + 10, 1, vec![]);
    chain.mine(T0 + 20, 1, vec![]);
    let err = reader.pass().await.expect_err("one block over the limit");
    assert!(format!("{err:#}").contains("block 0 alone"), "{err:#}");
}

async fn latest_record_of_key(state: &crate::state::AppState, host: &str) -> Value {
    record_of(state, host, &super::postgres_tests::key())
        .await
        .expect("a record")
}

/// F2: a node whose log index trails its headers by a block cannot make the
/// reader pass a block before its logs are there.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_log_index_behind_the_headers_loses_no_logs() {
    let chain = Arc::new(FakeChain::default());
    chain.lagging.store(true, Ordering::SeqCst);
    let (reader, state, host) = setup(Arc::clone(&chain), 0).await;
    let launcher = reader.config.launcher;
    chain.mine(T0, 1, with_launcher(launch_logs(), launcher)); // 0
    chain.mine(T0 + 10, 1, vec![ask(100_000_000)]); // 1 = head, its logs not indexed yet
    reader.pass().await.expect("pass 1");
    chain.mine(T0 + 20, 1, vec![]); // 2
    chain.mine(T0 + 30, 1, vec![]); // 3
    reader.pass().await.expect("pass 2");
    let n = latest_record_of_key(&state, &host).await;
    assert_eq!(
        n["rounds"][0]["asked"], "100000000",
        "the ask in block 1 was lost"
    );
}

/// I1 / F3: records whose numbers did not change leave the refresh queue
/// until their next refresh, so a project past the first hundred whose refund
/// moves with time is signed again.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn quiet_projects_do_not_starve_a_moving_one_of_its_refresh() {
    let chain = Arc::new(FakeChain::default());
    let (mut reader, state, host) = setup(Arc::clone(&chain), 0).await;
    // refresh 0 stands for "every record is older than the refresh time".
    reader.config.refresh_secs = 0;
    let launcher = reader.config.launcher;
    // 100 quiet solo projects (keys 1..=100) and one backed project whose
    // refund moves with time (key 0xfe, last in key order).
    let mut block0: Vec<LogSpec> = (1..=100u8).map(|i| launch(launcher, i)).collect();
    block0.extend([launch(launcher, 0xfe), check_in(0xfe), round_opened(0xfe)]);
    chain.mine(T0, 1, block0); // 0
    chain.mine(
        T0 + 10,
        1,
        vec![(
            addr(0xfe, 5),
            vec![topic(Role::Rounds, "Asked"), u(1), a(&BACKER)],
            data(&[u(100_000_000), u(100_000_000)]),
        )],
    ); // 1
    chain.mine(T0 + DAY, 1, close_and_settle(0xfe, 100_000_000)); // 2
    chain.mine(T0 + DAY + 12, 1, vec![]); // 3
    chain.mine(T0 + DAY + 24, 1, vec![]); // 4
    chain.mine(T0 + DAY + 36, 1, vec![]); // 5: blocks up to 3 are final
    reader.pass().await.expect("pass 1");
    reader.pass().await.expect("pass 2");
    let first = record_of(&state, &host, &[0xfe; 32]).await.expect("record");
    assert_eq!(first["asOf"]["block"], 3);
    assert_eq!(first["now"]["refunds"][0]["per100"], "77.90");

    let checked = |key: Word| {
        let state = Arc::clone(&state);
        let reader_id = reader.reader_id().to_owned();
        async move {
            sqlx::query_scalar::<_, f64>(
                "SELECT extract(epoch FROM published_at)::float8 FROM chain_project_numbers \
                 WHERE reader = $1 AND project_key = $2",
            )
            .bind(reader_id)
            .bind(key.as_slice())
            .fetch_one(state.db.pool())
            .await
            .expect("checked")
        }
    };
    let quiet_before = checked([1; 32]).await;

    // Five days later the backer's refund is lower; nothing else happened.
    for n in 0..3 {
        chain.mine(T0 + 6 * DAY + n, 1, vec![]); // 6, 7, 8: block 6 is final
    }
    for _ in 0..3 {
        reader.pass().await.expect("pass");
    }
    let later = record_of(&state, &host, &[0xfe; 32]).await.expect("record");
    assert_eq!(
        later["asOf"]["block"], 6,
        "the moving project was not signed again"
    );
    assert_ne!(later["now"]["refunds"][0]["per100"], "77.90");
    // A quiet project found unchanged is marked checked, not signed again.
    assert!(checked([1; 32]).await > quiet_before);
    let quiet = record_of(&state, &host, &[1; 32]).await.expect("record");
    assert_eq!(quiet["asOf"]["block"], 3);
}

/// I3: a known event that does not decode fails the range (read again next
/// pass) instead of being stored as unknown and left out of the numbers.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_known_event_that_does_not_decode_stops_the_reader() {
    let chain = Arc::new(FakeChain::default());
    let (reader, state, _) = setup(Arc::clone(&chain), 0).await;
    let launcher = reader.config.launcher;
    chain.mine(T0, 1, with_launcher(launch_logs(), launcher)); // 0
                                                               // Asked with one data word where the contracts emit two.
    let (rounds, topics, _) = ask(100_000_000);
    chain.mine(T0 + 10, 1, vec![(rounds, topics, data(&[u(100_000_000)]))]); // 1
    chain.mine(T0 + 20, 1, vec![]);
    chain.mine(T0 + 30, 1, vec![]);
    let err = reader.pass().await.expect_err("an undecodable known event");
    assert!(format!("{err:#}").contains("does not decode"), "{err:#}");
    let unknown: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM chain_logs WHERE reader = $1 AND (event = 'unknown' OR block_number = 1)",
    )
    .bind(reader.reader_id())
    .fetch_one(state.db.pool())
    .await
    .expect("count");
    assert_eq!(unknown, 0);
}

/// B1: the Launcher's Pair list is one for every project; a Pair made for
/// project 1 that takes project 2's seat makes project 2 Team, read through
/// the stored Launcher events.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_pair_made_for_another_project_raises_the_cap() {
    let chain = Arc::new(FakeChain::default());
    let (reader, state, host) = setup(Arc::clone(&chain), 0).await;
    let launcher = reader.config.launcher;
    let pair = [0xaa; 20];
    chain.mine(T0, 1, vec![launch(launcher, 1), launch(launcher, 2)]); // 0
    chain.mine(
        T0 + 10,
        1,
        vec![
            runner_changed(1, &FOUNDER, &pair),
            (
                launcher,
                vec![topic(Role::Launcher, "PairMade"), [1; 32], a(&pair)],
                data(&[a(&FOUNDER), a(&BACKER)]),
            ),
        ],
    ); // 1
    chain.mine(T0 + 20, 1, vec![runner_changed(2, &FOUNDER, &pair)]); // 2
    chain.mine(T0 + 30, 1, vec![]);
    chain.mine(T0 + 40, 1, vec![]);
    reader.pass().await.expect("pass");
    for key in [[1; 32], [2; 32]] {
        let n = record_of(&state, &host, &key).await.expect("record");
        assert_eq!(n["stage"]["name"], "team", "{}", hex0x(&key));
        assert_eq!(n["raised"]["cap"], "50000000000");
    }
}
