//! The reader against real Postgres and the second real run (`testdata/pot-run-pause.json`: the holder pause and the
//! earlier backers' claim contract on), served block by block by a fake node.
//!
//! - The Treasury's `PauseReady` and the Launcher's `EarlierBound` lead the reader to the two contracts, which are stored
//!   with the roles `pause` and `earlier` and the project they belong to.
//! - A park or an un-park is one change of the holding, not two movements: the stored balances are the holdings (a
//!   parker is not lowered by parking, the pause contract holds only what was sent to it by a plain transfer), and the
//!   window query of the held-for-a-window counts never sees a dip inside a park.
//! - The signed record is the one the pure builder gives for the same block.
//!
//! Ignored without infrastructure; run with
//! `cargo test -p buzz-relay --lib chain_reader::scan_pause_postgres_tests -- --ignored`.

use std::collections::BTreeMap;

use super::events::Role;
use super::fixture::Fixture;
use super::held::{self, Limits};
use super::ledger::Ledger;
use super::record_social_tests::changes_of;
use super::scan_postgres_tests::{read_all, setup, stored_record};
use super::store;
use super::word::hex0x;

/// Every stored balance of the project's backer Shares as of `block`.
async fn stored_shares(
    reader: &super::ChainReader,
    key: &[u8; 32],
    block: u64,
) -> BTreeMap<String, i128> {
    store::balances(
        reader.state.db.pool(),
        reader.reader_id(),
        key,
        Role::Shares,
        block,
    )
    .await
    .expect("balances")
    .into_iter()
    .collect()
}

/// The role and project the reader stored for `role` (`pause` or `earlier`), once it has read the whole run.
async fn stored_contract(role: &str) -> (Fixture, ([u8; 20], Option<Vec<u8>>)) {
    let fx = Fixture::load_pause();
    let (reader, chain, _state) = setup(&fx).await;
    chain.serve_books(&fx, &["Z_end"]);
    read_all(&reader, &chain).await;
    let found: Vec<(Vec<u8>, Option<Vec<u8>>)> = sqlx::query_as(
        "SELECT address, project_key FROM chain_contracts WHERE reader = $1 AND role = $2",
    )
    .bind(reader.reader_id())
    .bind(role)
    .fetch_all(reader.state.db.pool())
    .await
    .expect("contracts");
    assert_eq!(found.len(), 1, "exactly one contract of the role {role}");
    let (address, key) = found.into_iter().next().expect("one");
    (
        fx,
        (
            <[u8; 20]>::try_from(address.as_slice()).expect("address"),
            key,
        ),
    )
}

/// The Treasury's `PauseReady` leads the reader to the project's holder pause, stored with the role `pause` and the project.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn the_reader_finds_the_holder_pause_from_the_treasurys_pause_ready() {
    let (fx, (address, key)) = stored_contract("pause").await;
    let z = &fx.projects["Z"];
    assert_eq!(address, z.pause.expect("the run has a pause"));
    assert_eq!(key, Some(z.key.to_vec()));
}

/// The Launcher's `EarlierBound` leads the reader to the claim contract, tied to the one project its key names.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn the_reader_finds_the_claim_contract_from_the_launchers_earlier_bound() {
    let (fx, (address, key)) = stored_contract("earlier").await;
    let z = &fx.projects["Z"];
    assert_eq!(address, z.earlier.expect("the run has a claim contract"));
    assert_eq!(key, Some(z.key.to_vec()));
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn the_stored_holdings_and_the_held_window_are_not_lowered_by_parking() {
    let fx = Fixture::load_pause();
    let (reader, chain, _state) = setup(&fx).await;
    chain.serve_books(&fx, &["Z_end"]);
    read_all(&reader, &chain).await;
    let pool = reader.state.db.pool();
    let z = &fx.projects["Z"];

    // The stored holdings equal the ledger the pure replay gives (the pause's transfers cancelled with their parks), at
    // the block where the pause is on and one Share has been sent to the pause by a plain transfer.
    let block = fx.book_block("Z_paused");
    let stored = stored_shares(&reader, &z.key, block).await;
    let ledger = Ledger::from_logs(&fx.rows("Z", block))
        .expect("reads")
        .expect("launched");
    let pause = hex0x(&z.pause.expect("pause"));
    let held_by_ledger: BTreeMap<String, i128> = ledger
        .shares_balances()
        .map(|(a, v)| (a.clone(), i128::try_from(*v).expect("fits")))
        .collect();
    assert_eq!(
        stored, held_by_ledger,
        "the stored holdings are the ledger's"
    );
    assert_eq!(
        stored.get(&pause).copied(),
        Some(1_000_000_000_000_000_000),
        "the pause holds only the Share sent to it by a plain transfer"
    );
    assert!(
        ledger.pause_seen.parked_total > 0,
        "Shares are parked at this block"
    );

    // The held-for-a-window query agrees with the pure walk over the same changes (the parks cancelled), and a park is
    // no dip: from a time after the Backs and before the first park, the parker's lowest balance is what it holds.
    let start = fx.time_of(fx.launch_block("Z")) + 3 * 86_400 / 5;
    let raw = held::held_input(
        pool,
        reader.reader_id(),
        &z.key,
        block,
        start,
        Limits::default(),
    )
    .await
    .expect("the window");
    let inside: Vec<_> = changes_of(&fx.rows("Z", block))
        .into_iter()
        .filter(|(time, _)| *time > start)
        .map(|(_, c)| c)
        .collect();
    assert_eq!(
        raw,
        held::walk(&inside, Limits::default()),
        "the query is the walk"
    );
    let parker = fx.json["accounts"]["account2"]
        .as_str()
        .expect("account")
        .to_owned();
    let held::WindowRaw::Counted(runs) = raw else {
        panic!("the window is counted");
    };
    let run = runs.get(&parker).expect("the parker moved in the window");
    let holding = *stored.get(&parker).expect("the parker holds");
    assert_eq!(
        holding - run.total + run.lowest_run.min(0),
        holding,
        "parking lowered the parker's lowest balance"
    );
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn the_signed_record_of_the_second_run_is_the_one_the_pure_builder_gives() {
    let fx = Fixture::load_pause();
    let (reader, chain, _state) = setup(&fx).await;
    chain.serve_books(&fx, &["Z_end"]);
    read_all(&reader, &chain).await;
    let z = &fx.projects["Z"];
    let stored = stored_record(&reader, &z.key).await;
    assert_eq!(stored["asOf"]["block"], fx.book_block("Z_end"));
    assert_eq!(
        stored["contracts"]["pause"],
        hex0x(&z.pause.expect("pause"))
    );
    assert_eq!(stored["pause"]["parkedTotal"], "0");
    assert_eq!(stored["pause"]["paused"], false);
    assert_eq!(stored["earlierGrants"]["claimedRows"], 2);
    assert_eq!(
        stored["earlierGrants"]["contract"],
        hex0x(&z.earlier.expect("claims"))
    );
    // The holders the record lists are the holdings: the pause contract is none of them.
    let holders = stored["holders"].as_array().expect("holders");
    assert!(holders
        .iter()
        .all(|h| h["account"] != hex0x(&z.pause.expect("pause"))));
}
