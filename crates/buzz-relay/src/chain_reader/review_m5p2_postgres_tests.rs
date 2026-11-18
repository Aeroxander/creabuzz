//! Milestone 5 part 2 review fixes for the reader, against real Postgres and
//! the fake chain: pool trades made before the pool is named are read back
//! (I1), contracts named by stored Launcher rows are followed with their
//! earlier logs (I2), and migration 0068 fills the running balances from the
//! Transfers already stored (I2). The second review added: an emptied
//! balance is kept, so two rollbacks in a row restore it, and migration 0069
//! puts back the zeros 0068 deleted. The first test is the review's failing
//! test, made realistic: the pool step (`PoolStep`, the transaction that
//! makes the pool) comes before the trade, as on chain.

use std::sync::Arc;

use super::events::Role;
use super::postgres_tests::{
    a, data, key, latest_record, launch_logs, setup, topic, u, with_launcher, FakeChain, DAY,
    FINISHER, SHARES, T0,
};

const STRATEGY: [u8; 20] = [0x52; 20];
const MANAGER: [u8; 20] = [0x53; 20];
const HOLDER: [u8; 20] = [0x51; 20];
const AUCTION: [u8; 20] = [0x54; 20];

fn signed(v: i128) -> [u8; 32] {
    let mut w = if v < 0 { [0xff; 32] } else { [0; 32] };
    w[16..].copy_from_slice(&v.to_be_bytes());
    w
}

fn shared_contracts(chain: &FakeChain, launcher: [u8; 20]) {
    let sel = |s: &str| buzz_evm_allowance::abi::selector(s).to_vec();
    let mut calls = chain.calls.lock().expect("lock");
    calls.insert((launcher, sel("holder()")), a(&HOLDER).to_vec());
    calls.insert((launcher, sel("strategy()")), a(&STRATEGY).to_vec());
    calls.insert((STRATEGY, sel("poolManager()")), a(&MANAGER).to_vec());
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn swaps_before_pool_opened_in_an_earlier_range_are_counted() {
    let pool_id: [u8; 32] = [0x77; 32];
    let chain = Arc::new(FakeChain::default());
    let (reader, state, host) = setup(Arc::clone(&chain), 0).await;
    let launcher = reader.config.launcher;
    shared_contracts(&chain, launcher);
    chain.mine(T0, 1, with_launcher(launch_logs(), launcher)); // 0
                                                               // The pool step makes the pool, and a trader swaps at once.
    chain.mine(
        T0 + DAY,
        1,
        vec![
            (
                FINISHER,
                vec![topic(Role::Finisher, "PoolStep"), a(&AUCTION)],
                data(&[u(1)]),
            ),
            (
                MANAGER,
                vec![topic(Role::PoolManager, "Swap"), pool_id, a(&[0xb0; 20])],
                data(&[signed(90), signed(-30), u(1), u(1), signed(-5), u(3000)]),
            ),
        ],
    ); // 1
    chain.mine(T0 + DAY + 10, 1, vec![]); // 2
    chain.mine(T0 + DAY + 20, 1, vec![]); // 3
    reader.pass().await.expect("first pass"); // reads 0..=1
                                              // settle() names the pool a few blocks later.
    chain.mine(
        T0 + DAY + 30,
        1,
        vec![(
            FINISHER,
            vec![topic(Role::Finisher, "PoolOpened"), a(&AUCTION)],
            data(&[pool_id, u(1), u(100), u(100)]),
        )],
    ); // 4
    chain.mine(T0 + DAY + 40, 1, vec![]); // 5
    chain.mine(T0 + DAY + 50, 1, vec![]); // 6
    reader.pass().await.expect("second pass"); // reads 2..=4
    let n = latest_record(&state, &host).await.expect("a record");
    assert_eq!(
        n["pool"]["trades"], 1,
        "the swap made before PoolOpened's range is lost: {}",
        n["pool"]
    );
    assert_eq!(n["pool"]["sharesBought"], "90");
}

/// I2: a reader that ran before auctions were followed has the Launcher's
/// `SaleOpened` row stored but does not follow the auction. The auction is
/// followed from the stored row, and its earlier bids are read back.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn contracts_named_by_stored_launcher_rows_are_followed_with_their_past() {
    let chain = Arc::new(FakeChain::default());
    let (reader, state, host) = setup(Arc::clone(&chain), 0).await;
    let launcher = reader.config.launcher;
    let mut launch = with_launcher(launch_logs(), launcher);
    launch.push((
        launcher,
        vec![
            topic(Role::Launcher, "SaleOpened"),
            key(),
            a(&AUCTION),
            a(&[0xf0; 20]),
        ],
        data(&[a(&FINISHER), u(1), u(1), u(9), u(1), u(1)]),
    ));
    let bid = |amount: u128| {
        (
            AUCTION,
            vec![topic(Role::Auction, "BidSubmitted"), u(1), a(&[0xb0; 20])],
            data(&[u(9), u(amount)]),
        )
    };
    chain.mine(T0, 1, launch); // 0
    chain.mine(T0 + 10, 1, vec![bid(500)]); // 1
    chain.mine(T0 + 20, 1, vec![]); // 2
    chain.mine(T0 + 30, 1, vec![]); // 3
    reader.pass().await.expect("first pass"); // reads 0..=1
                                              // As a reader from before auctions were followed left it: the Launcher's
                                              // row is stored, the auction and its logs are not.
    let pool = state.db.pool();
    for sql in [
        "DELETE FROM chain_logs WHERE reader = $1 AND role = 'auction'",
        "DELETE FROM chain_contracts WHERE reader = $1 AND role = 'auction'",
    ] {
        sqlx::query(sql)
            .bind(reader.reader_id())
            .execute(pool)
            .await
            .expect("forget the auction");
    }
    chain.mine(T0 + 40, 1, vec![bid(700)]); // 4
    chain.mine(T0 + 50, 1, vec![]); // 5
    chain.mine(T0 + 60, 1, vec![]); // 6
    reader.pass().await.expect("second pass"); // reads 2..=4
    let n = latest_record(&state, &host).await.expect("a record");
    assert_eq!(n["bids"][0]["count"], 2, "{}", n["bids"]);
    assert_eq!(n["bids"][0]["amount"], "1200");
}

async fn balances(pool: &sqlx::PgPool, reader: &str) -> Vec<(Vec<u8>, String)> {
    sqlx::query_as(
        "SELECT account, balance::text FROM chain_balances WHERE reader = $1 ORDER BY account",
    )
    .bind(reader)
    .fetch_all(pool)
    .await
    .expect("balances")
}

/// I2: migration 0068 fills the running balances from Shares Transfers that
/// were stored before migration 0067 kept them (the tables start empty).
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn migration_0068_fills_balances_from_stored_transfers() {
    const ALICE: [u8; 20] = [0xa1; 20];
    const CAROL: [u8; 20] = [0xc3; 20];
    let transfer = |from: &[u8; 20], to: &[u8; 20], value: u128| {
        (
            SHARES,
            vec![topic(Role::Shares, "Transfer"), a(from), a(to)],
            data(&[u(value)]),
        )
    };
    let chain = Arc::new(FakeChain::default());
    let (reader, state, _host) = setup(Arc::clone(&chain), 0).await;
    chain.mine(T0, 1, with_launcher(launch_logs(), reader.config.launcher)); // 0
    chain.mine(
        T0 + 10,
        1,
        vec![
            transfer(&[0; 20], &ALICE, 1_000),
            transfer(&ALICE, &CAROL, 400),
            transfer(&CAROL, &CAROL, 50),
        ],
    ); // 1
    chain.mine(T0 + 20, 1, vec![]); // 2
    chain.mine(T0 + 30, 1, vec![]); // 3
    reader.pass().await.expect("pass");
    let pool = state.db.pool();
    let id = reader.reader_id().to_owned();
    let kept = balances(pool, &id).await;
    assert!(!kept.is_empty());
    // As before 0067: the Transfers are stored, the running tables are empty.
    for sql in [
        "DELETE FROM chain_balance_changes WHERE reader = $1",
        "DELETE FROM chain_balances WHERE reader = $1",
    ] {
        sqlx::query(sql)
            .bind(&id)
            .execute(pool)
            .await
            .expect("empty");
    }
    sqlx::raw_sql(include_str!(
        "../../../../migrations/0068_chain_balances_backfill.sql"
    ))
    .execute(pool)
    .await
    .expect("migration 0068");
    assert_eq!(
        balances(pool, &id).await,
        kept,
        "filled from the stored Transfers"
    );
    // Safe to run again.
    sqlx::raw_sql(include_str!(
        "../../../../migrations/0068_chain_balances_backfill.sql"
    ))
    .execute(pool)
    .await
    .expect("migration 0068 again");
    assert_eq!(balances(pool, &id).await, kept);
}

const ALICE: [u8; 20] = [0xa1; 20];
const CAROL: [u8; 20] = [0xc3; 20];

fn transfer(from: &[u8; 20], to: &[u8; 20], value: u128) -> ([u8; 20], Vec<[u8; 32]>, Vec<u8>) {
    (
        SHARES,
        vec![topic(Role::Shares, "Transfer"), a(from), a(to)],
        data(&[u(value)]),
    )
}

fn free_of(n: &serde_json::Value, who: &[u8; 20]) -> Option<String> {
    n["holders"]
        .as_array()
        .expect("holders")
        .iter()
        .find(|h| h["account"] == super::word::hex0x(who))
        .map(|h| h["free"].as_str().unwrap_or_default().to_owned())
}

/// Mine `n` empty blocks with `salt` from `time`.
fn empty(chain: &FakeChain, time: u64, salt: u8, n: u64) {
    for i in 0..n {
        chain.mine(time + i, salt, vec![]);
    }
}

/// Second review: a rollback that brings a balance to 0 keeps its row. A
/// second rollback past earlier changes subtracts from it again; with the row
/// deleted, Carol's 400 was lost.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn two_rollbacks_in_a_row_restore_a_balance_that_was_emptied() {
    let chain = Arc::new(FakeChain::default());
    let (reader, state, host) = setup(Arc::clone(&chain), 0).await;
    chain.mine(T0, 1, with_launcher(launch_logs(), reader.config.launcher)); // 0
    chain.mine(T0 + 10, 1, vec![transfer(&[0; 20], &ALICE, 1_000)]); // 1
    chain.mine(T0 + 20, 1, vec![transfer(&ALICE, &CAROL, 400)]); // 2
    chain.mine(T0 + 30, 1, vec![transfer(&CAROL, &ALICE, 400)]); // 3
    chain.mine(T0 + 40, 1, vec![transfer(&ALICE, &CAROL, 100)]); // 4
    empty(&chain, T0 + 50, 1, 2); // 5, 6
    reader.pass().await.expect("pass");
    let n = latest_record(&state, &host).await.expect("a record");
    assert_eq!(free_of(&n, &CAROL).as_deref(), Some("100"));

    // Block 4 leaves the chain: Carol's balance is 0.
    chain.truncate(4);
    empty(&chain, T0 + 41, 2, 5); // 4'..8'
    let (scanned, _) = reader.pass().await.expect("first rollback");
    assert_eq!(scanned.rolled_back_to, Some(3));
    let n = latest_record(&state, &host).await.expect("a record");
    assert_eq!(free_of(&n, &CAROL), None, "a zero is not listed");

    // Block 3 leaves too: Carol never sent the 400 back.
    chain.truncate(3);
    empty(&chain, T0 + 31, 3, 8); // 3''..10''
    let (scanned, _) = reader.pass().await.expect("second rollback");
    assert_eq!(scanned.rolled_back_to, Some(2));
    let n = latest_record(&state, &host).await.expect("a record");
    assert_eq!(
        free_of(&n, &CAROL).as_deref(),
        Some("400"),
        "{}",
        n["holders"]
    );
    assert_eq!(free_of(&n, &ALICE).as_deref(), Some("600"));
}

/// Second review: migration 0069 puts back the zero balances that 0068
/// deleted, so a rollback past an emptied account's changes restores it.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn migration_0069_puts_back_emptied_balances() {
    let chain = Arc::new(FakeChain::default());
    let (reader, state, host) = setup(Arc::clone(&chain), 0).await;
    chain.mine(T0, 1, with_launcher(launch_logs(), reader.config.launcher)); // 0
    chain.mine(T0 + 10, 1, vec![transfer(&[0; 20], &ALICE, 1_000)]); // 1
    chain.mine(T0 + 20, 1, vec![transfer(&ALICE, &CAROL, 400)]); // 2
    chain.mine(T0 + 30, 1, vec![transfer(&CAROL, &ALICE, 400)]); // 3
    empty(&chain, T0 + 40, 1, 2); // 4, 5
    reader.pass().await.expect("pass");
    let pool = state.db.pool();
    let id = reader.reader_id().to_owned();
    // As 0068 (or an earlier rollback) left it: the emptied balance deleted.
    sqlx::query("DELETE FROM chain_balances WHERE reader = $1 AND balance = 0")
        .bind(&id)
        .execute(pool)
        .await
        .expect("as 0068 left it");
    for _ in 0..2 {
        sqlx::raw_sql(include_str!(
            "../../../../migrations/0069_chain_balances_keep_zeros.sql"
        ))
        .execute(pool)
        .await
        .expect("migration 0069 (safe to run again)");
    }
    let rows = balances(pool, &id).await;
    assert!(
        rows.contains(&(CAROL.to_vec(), "0".to_owned())),
        "Carol's 0 is back: {rows:?}"
    );
    assert!(rows.contains(&(ALICE.to_vec(), "1000".to_owned())));

    // Block 3 leaves the chain: Carol keeps her 400.
    chain.truncate(3);
    empty(&chain, T0 + 31, 2, 5); // 3'..7'
    let (scanned, _) = reader.pass().await.expect("rollback");
    assert_eq!(scanned.rolled_back_to, Some(2));
    let n = latest_record(&state, &host).await.expect("a record");
    assert_eq!(
        free_of(&n, &CAROL).as_deref(),
        Some("400"),
        "{}",
        n["holders"]
    );
}
