//! The reader against real Postgres and the real run of the contracts
//! (`testdata/pot-run.json`) served block by block by a fake node: the
//! Launcher's events lead it to every project's contracts, the stored rows
//! rebuild exactly the numbers the contracts' views gave, a log delivered
//! twice or from a stranger changes nothing, and a chain reorganisation that
//! drops a join takes its numbers back. Ignored without infrastructure (a
//! migrated database and Redis); run with
//! `cargo test -p buzz-relay --lib chain_reader::scan_postgres_tests -- --ignored`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde_json::Value;
use uuid::Uuid;

use super::events::Role;
use super::fixture::Fixture;
use super::ledger::{Ledger, Stored};
use super::source::{ChainSource, Header, RawLog};
use super::store;
use super::word::{hex0x, Word};
use super::{ChainReader, ChainReaderConfig};

/// The run's blocks served by a fake node. `fork` replaces the tail with
/// empty blocks of another hash, as a reorganisation does.
struct FixtureChain {
    blocks: Mutex<Vec<(Header, Vec<RawLog>)>>,
    /// Answer every log request twice over.
    duplicate: AtomicBool,
    /// Answer with every log of the range, whatever addresses were asked.
    ignore_filter: AtomicBool,
    /// The real chain's answers to the record's view calls at one block (the
    /// run's `books`), by contract and calldata; the Launcher is asked for
    /// under its replaced address (`aliases`: replaced, real).
    answers: Mutex<super::fixture::Answers>,
    book_block: Mutex<Option<u64>>,
    aliases: Mutex<Vec<([u8; 20], [u8; 20])>>,
}

impl FixtureChain {
    /// The run, with its Launcher's address replaced by `launcher` (so tests
    /// running side by side keep their rows apart).
    fn new(fx: &Fixture, launcher: [u8; 20]) -> Self {
        let mut blocks: Vec<(Header, Vec<RawLog>)> =
            fx.blocks.iter().map(|h| (h.clone(), Vec::new())).collect();
        for log in &fx.logs {
            let mut log = log.clone();
            if log.address == fx.launcher {
                log.address = launcher;
            }
            blocks[usize::try_from(log.block_number).expect("block")]
                .1
                .push(log);
        }
        Self {
            blocks: Mutex::new(blocks),
            duplicate: AtomicBool::new(false),
            ignore_filter: AtomicBool::new(false),
            answers: Mutex::new(HashMap::new()),
            book_block: Mutex::new(None),
            aliases: Mutex::new(vec![(launcher, fx.launcher)]),
        }
    }

    /// Serve the views of the books `names` (all taken at one block).
    fn serve_books(&self, fx: &Fixture, names: &[&str]) {
        let mut answers = self.answers.lock().expect("lock");
        for name in names {
            let (_, book) = super::fixture::BookChain::load(fx, name);
            *self.book_block.lock().expect("lock") = Some(book.block);
            answers.extend(book.answers);
        }
    }

    /// An empty block on top of the chain (a different hash for each `salt`).
    fn mine_empty(&self, salt: u8) {
        let mut blocks = self.blocks.lock().expect("lock");
        let (parent, time) = blocks
            .last()
            .map_or(([0u8; 32], 0), |(h, _)| (h.hash, h.time));
        let number = blocks.len() as u64;
        let mut hash = [salt; 32];
        hash[..8].copy_from_slice(&number.to_be_bytes());
        blocks.push((
            Header {
                number,
                hash,
                parent,
                time: time + 1,
            },
            Vec::new(),
        ));
    }

    /// Keep blocks `0..len`.
    fn truncate(&self, len: usize) {
        self.blocks.lock().expect("lock").truncate(len);
    }

    /// A log from `address`, in the block `number`.
    fn add_log(&self, number: u64, address: [u8; 20], topics: Vec<Word>, data: Vec<u8>) {
        let mut blocks = self.blocks.lock().expect("lock");
        let (header, logs) = &mut blocks[usize::try_from(number).expect("block")];
        let log_index = logs.last().map_or(0, |l| l.log_index + 1);
        logs.push(RawLog {
            block_number: number,
            block_hash: header.hash,
            tx_hash: [0xee; 32],
            log_index,
            address,
            topics,
            data,
            removed: false,
        });
    }
}

#[async_trait]
impl ChainSource for FixtureChain {
    async fn chain_id(&self) -> anyhow::Result<u64> {
        Ok(31337)
    }
    async fn head(&self) -> anyhow::Result<u64> {
        Ok(self.blocks.lock().expect("lock").len() as u64 - 1)
    }
    async fn header(&self, number: u64) -> anyhow::Result<Option<Header>> {
        Ok(self
            .blocks
            .lock()
            .expect("lock")
            .get(usize::try_from(number)?)
            .map(|(h, _)| h.clone()))
    }
    async fn eth_call(
        &self,
        to: &[u8; 20],
        data: &[u8],
        at: u64,
    ) -> anyhow::Result<Option<Vec<u8>>> {
        let served = *self.book_block.lock().expect("lock");
        if served != Some(at) {
            anyhow::bail!("the node cannot serve block {at}");
        }
        let real = self
            .aliases
            .lock()
            .expect("lock")
            .iter()
            .find(|(fake, _)| fake == to)
            .map_or(*to, |(_, real)| *real);
        self.answers
            .lock()
            .expect("lock")
            .get(&(real, data.to_vec()))
            .cloned()
            .map(Some)
            .ok_or_else(|| anyhow::anyhow!("no captured answer for 0x{}", hex::encode(to)))
    }

    async fn logs(
        &self,
        addresses: &[[u8; 20]],
        topics: &[Word],
        from: u64,
        to: u64,
    ) -> anyhow::Result<Vec<RawLog>> {
        let blocks = self.blocks.lock().expect("lock");
        let loose = self.ignore_filter.load(Ordering::SeqCst);
        let mut found: Vec<RawLog> = blocks
            .iter()
            .filter(|(h, _)| h.number >= from && h.number <= to)
            .flat_map(|(_, logs)| logs.iter())
            .filter(|l| loose || (addresses.contains(&l.address) && topics.contains(&l.topics[0])))
            .cloned()
            .collect();
        if self.duplicate.load(Ordering::SeqCst) {
            let again = found.clone();
            found.extend(again);
        }
        Ok(found)
    }
}

fn config(launcher: [u8; 20]) -> ChainReaderConfig {
    ChainReaderConfig {
        rpc_url: "http://127.0.0.1:1".into(),
        chain_id: 31337,
        launcher,
        start_block: 0,
        confirmations: 0,
        poll_secs: 1,
        refresh_secs: 3_600,
        active_refresh_secs: 600,
        log_range: 9,
        community_host: None,
        helper: None,
    }
}

async fn setup(fx: &Fixture) -> (ChainReader, Arc<FixtureChain>, Arc<crate::state::AppState>) {
    let state = crate::test_support::test_state().await;
    let host = format!("chain-reader-{}.example", Uuid::new_v4().simple());
    state
        .db
        .ensure_configured_community(&host)
        .await
        .expect("community");
    // A fresh Launcher per test keeps the rows of parallel runs apart.
    let mut launcher = fx.launcher;
    launcher[..16].copy_from_slice(&Uuid::new_v4().into_bytes());
    let chain = Arc::new(FixtureChain::new(fx, launcher));
    // The newest two blocks are never read (the confirmation depth is at
    // least two), so the run's last block is final only with two on top.
    chain.mine_empty(1);
    chain.mine_empty(1);
    let reader = ChainReader::new(
        Arc::clone(&state),
        Arc::clone(&chain) as Arc<dyn ChainSource>,
        config(launcher),
        host,
    );
    (reader, chain, state)
}

/// Passes until the reader has read to the head less its lag.
async fn read_all(reader: &ChainReader, chain: &FixtureChain) -> super::scan::ScanReport {
    let want = chain.head().await.expect("head") - 2;
    for _ in 0..20 {
        let report = reader.pass().await.expect("a pass").0;
        if store::cursor(reader.state.db.pool(), reader.reader_id())
            .await
            .expect("cursor")
            > want
        {
            return report;
        }
    }
    panic!("the reader did not reach block {want}");
}

fn n(v: &Value, name: &str) -> u128 {
    v[name]
        .as_str()
        .expect("a number")
        .parse()
        .expect("a number")
}

fn stored_of(views: &Value, vester_team_balance: u128) -> Stored {
    Stored {
        pot: n(views, "pot"),
        paid_in: n(views, "paidIn"),
        box_: n(views, "box"),
        arriving: n(views, "arriving"),
        fees_owed: n(views, "feesOwed"),
        z: n(views, "Z"),
        active_seconds: n(views, "activeSeconds"),
        last_settle: u64::try_from(n(views, "lastSettle")).expect("time"),
        shares_supply: n(views, "sharesSupply"),
        team_supply: n(views, "teamSupply"),
        vester_team_balance,
    }
}

/// The project's ledger from the stored rows and running balances, as the
/// publish pass builds it.
async fn ledger_of(reader: &ChainReader, key: &Word, block: u64) -> Ledger {
    let pool = reader.state.db.pool();
    let id = reader.reader_id();
    let rows = store::project_logs(pool, id, key, block)
        .await
        .expect("rows");
    let mut ledger = Ledger::from_logs(&rows).expect("reads").expect("launched");
    ledger
        .set_balances(
            &store::balances(pool, id, key, Role::Shares, block)
                .await
                .expect("shares"),
            &store::balances(pool, id, key, Role::Team, block)
                .await
                .expect("team"),
        )
        .expect("balances");
    ledger
}

/// Every number the ledger holds against the end-of-run views, both tokens.
fn assert_end_of_run(fx: &Fixture, name: &str, ledger: &Ledger) {
    let fin = &fx.json["final"][name];
    let vester = hex0x(&fx.projects[name].vester);
    let vester_balance = fin["balances"]["team"]
        .get(&vester)
        .map_or(0, |v| v.as_str().expect("amount").parse().expect("number"));
    assert_eq!(
        ledger.mismatches(&stored_of(&fin["views"], vester_balance)),
        vec![],
        "{name}"
    );
    for (token, ours) in [
        ("shares", ledger.shares_balances().collect::<Vec<_>>()),
        ("team", ledger.team_balances().collect::<Vec<_>>()),
    ] {
        let theirs: HashMap<&str, u128> = fin["balances"][token]
            .as_object()
            .expect("balances")
            .iter()
            .map(|(a, b)| {
                (
                    a.as_str(),
                    b.as_str().expect("amount").parse().expect("number"),
                )
            })
            .collect();
        let ours: HashMap<&str, u128> = ours.into_iter().map(|(a, b)| (a.as_str(), *b)).collect();
        assert_eq!(ours, theirs, "{name}: {token} balances");
    }
}

/// The reader finds both projects of the run from the Launcher's events
/// alone, in ranges of nine blocks, and the numbers it stores rebuild exactly
/// the end-of-run views, with each token's balances apart.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn the_reader_finds_the_projects_and_rebuilds_the_numbers_the_views_gave() {
    let fx = Fixture::load();
    let (reader, chain, _state) = setup(&fx).await;
    read_all(&reader, &chain).await;
    let pool = reader.state.db.pool();
    let id = reader.reader_id();
    let found = store::contracts(pool, id).await.expect("contracts");
    for (name, p) in &fx.projects {
        for (address, role) in [
            (p.treasury, Role::Treasury),
            (p.shares, Role::Shares),
            (p.team, Role::Team),
            (p.vester, Role::Vester),
        ] {
            assert!(
                found.iter().any(|c| c.address == address
                    && c.role == role
                    && c.project_key == Some(p.key)),
                "{name}: {role:?} was not found"
            );
        }
    }
    assert!(found
        .iter()
        .any(|c| Some(c.address) == fx.projects["B"].pair && c.role == Role::Pair));
    assert!(
        !found.iter().any(|c| c.address == fx.dollar),
        "the dollar is not followed"
    );
    let projects = store::final_projects(pool, id, fx.head())
        .await
        .expect("projects");
    assert_eq!(projects.len(), 2);
    for name in ["A", "B"] {
        let key = fx.projects[name].key;
        let ledger = ledger_of(&reader, &key, fx.head()).await;
        assert_end_of_run(&fx, name, &ledger);
    }
    // Team Shares and backer Shares are kept apart, though they move in the
    // same transactions: project A's Team token has holders the Shares token
    // has not.
    let a = ledger_of(&reader, &fx.projects["A"].key, fx.head()).await;
    assert!(a.team_balances().count() >= 1 && a.shares_balances().count() >= 1);
    assert_ne!(
        a.shares_balances()
            .map(|(k, _)| k.clone())
            .collect::<Vec<_>>(),
        a.team_balances()
            .map(|(k, _)| k.clone())
            .collect::<Vec<_>>()
    );
}

/// A node that answers every log twice over changes nothing: the same rows,
/// the same numbers.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_log_delivered_twice_changes_nothing() {
    let fx = Fixture::load();
    let (once_reader, once_chain, _s1) = setup(&fx).await;
    read_all(&once_reader, &once_chain).await;
    let (twice_reader, twice_chain, _s2) = setup(&fx).await;
    twice_chain.duplicate.store(true, Ordering::SeqCst);
    read_all(&twice_reader, &twice_chain).await;
    let count = |r: &ChainReader| {
        let pool = r.state.db.pool().clone();
        let id = r.reader_id().to_owned();
        async move {
            sqlx::query_scalar::<_, i64>("SELECT count(*) FROM chain_logs WHERE reader = $1")
                .bind(id)
                .fetch_one(&pool)
                .await
                .expect("count")
        }
    };
    assert_eq!(count(&once_reader).await, count(&twice_reader).await);
    for name in ["A", "B"] {
        let key = fx.projects[name].key;
        assert_end_of_run(&fx, name, &ledger_of(&twice_reader, &key, fx.head()).await);
    }
}

/// A log from a contract that is not the project's is ignored, even from a
/// node that answers more than it was asked: a stranger's `Joined`, a
/// stranger's look-alike `ProjectLaunched`, and the dollar's own transfers.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn an_event_from_a_contract_that_is_not_the_projects_is_ignored() {
    let fx = Fixture::load();
    let (reader, chain, _state) = setup(&fx).await;
    let stranger = [0x99u8; 20];
    // A copy of project A's last Joined and of its ProjectLaunched, emitted by a stranger.
    let copy_of = |event: &str, from: [u8; 20]| {
        fx.logs
            .iter()
            .find(|l| {
                l.address == from
                    && l.topics.first()
                        == super::events::topic_of(
                            if event == "Joined" {
                                Role::Treasury
                            } else {
                                Role::Launcher
                            },
                            event,
                        )
                        .as_ref()
            })
            .expect("a log to copy")
            .clone()
    };
    let join = copy_of("Joined", fx.projects["A"].treasury);
    let launch = copy_of("ProjectLaunched", fx.launcher);
    let tail = fx.head();
    for l in [join, launch] {
        chain.add_log(tail, stranger, l.topics, l.data);
    }
    // The dollar's logs are in the run (a transfer for every join); a loose node returns them too.
    chain.ignore_filter.store(true, Ordering::SeqCst);
    read_all(&reader, &chain).await;
    let pool = reader.state.db.pool();
    let strangers: i64 =
        sqlx::query_scalar("SELECT count(*) FROM chain_logs WHERE reader = $1 AND address = $2")
            .bind(reader.reader_id())
            .bind(stranger.as_slice())
            .fetch_one(pool)
            .await
            .expect("count");
    assert_eq!(strangers, 0);
    let dollars: i64 =
        sqlx::query_scalar("SELECT count(*) FROM chain_logs WHERE reader = $1 AND address = $2")
            .bind(reader.reader_id())
            .bind(fx.dollar.as_slice())
            .fetch_one(pool)
            .await
            .expect("count");
    assert_eq!(dollars, 0);
    let found = store::contracts(pool, reader.reader_id())
        .await
        .expect("contracts");
    assert!(!found.iter().any(|c| c.address == stranger));
    for name in ["A", "B"] {
        let key = fx.projects[name].key;
        assert_end_of_run(&fx, name, &ledger_of(&reader, &key, fx.head()).await);
    }
}

/// A reorganisation that drops a join takes its numbers back: the stored rows,
/// the running balances of both tokens and the ledger return to what the
/// views gave before that join.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_reorg_that_drops_a_joined_rolls_the_numbers_back() {
    let fx = Fixture::load();
    let (reader, chain, _state) = setup(&fx).await;
    read_all(&reader, &chain).await;
    let a = fx.projects["A"].key;
    let before = ledger_of(&reader, &a, fx.head()).await;
    // The block of project A's last Joined.
    let rows = fx.rows("A", fx.head());
    let join = rows
        .iter()
        .rev()
        .find(|r| r.role == Role::Treasury && r.event == "Joined")
        .expect("a join");
    let x = join.block;
    // The chain forks just before it: the join and everything after it are
    // gone, and other (empty) blocks take their place.
    // (A chain shorter than the stored blocks reads as a node that is behind,
    // not as a reorganisation, so the fork is longer than what it replaces.)
    let old_head = chain.head().await.expect("head");
    chain.truncate(usize::try_from(x).expect("block"));
    while chain.head().await.expect("head") <= old_head + 1 {
        chain.mine_empty(2);
    }
    let after_pass = reader.pass().await.expect("a pass after the reorg").0;
    assert!(
        after_pass.rolled_back_to.is_some_and(|f| f < x),
        "{after_pass:?}"
    );
    assert!(after_pass.logs_removed > 0);
    // Read on to the new head.
    let new_head = chain.head().await.expect("head");
    for _ in 0..10 {
        reader.pass().await.expect("a pass");
    }
    let after = ledger_of(&reader, &a, new_head - 2).await;
    assert_ne!(after.paid_in, before.paid_in);
    assert!(after.totals.joined < before.totals.joined);
    // What the views said right before the join.
    let snap = fx.json["snapshots"]["A"]
        .as_array()
        .expect("snapshots")
        .iter()
        .rev()
        .find(|s| s["block"].as_u64().expect("block") < x)
        .expect("a snapshot before the join");
    let views = &snap["views"];
    assert_eq!(after.pot, n(views, "pot"));
    assert_eq!(after.paid_in, n(views, "paidIn"));
    assert_eq!(after.shares, n(views, "sharesSupply"));
    assert_eq!(after.team, n(views, "teamSupply"));
    assert_eq!(after.fees_owed, n(views, "feesOwed"));
    // The running balances of both tokens went back with the logs: they add
    // up to the supplies the events say, and the cross-check passes.
    assert_eq!(after.shares_in_hands(), after.shares);
    assert_eq!(
        after.team_balances().map(|(_, v)| *v).sum::<u128>(),
        after.team
    );
    assert_eq!(
        after.mismatches(&stored_of(views, after.vester_team_balance())),
        vec![]
    );
    // The other project, whose events are all before the fork or untouched,
    // is as it was where the chain still agrees.
    let b = ledger_of(&reader, &fx.projects["B"].key, new_head - 2).await;
    assert!(b.shares > 0 || b.pot > 0 || b.totals.joined > 0 || !b.grants.is_empty());
}

/// The whole reader on the run's last block: it signs each project's record
/// from the stored rows and the real chain's answers to the view calls, the
/// stored record is the one the typed record writes, an unchanged project is
/// not signed again before its promised refresh, and it is signed again, with
/// a later `builtAt`, when the refresh is due even though nothing changed.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn the_reader_signs_records_and_signs_them_again_when_the_refresh_is_due() {
    let fx = Fixture::load();
    let (reader, chain, state) = setup(&fx).await;
    chain.serve_books(&fx, &["A_end", "B_end"]);
    // A promised refresh of three seconds, so the heartbeat can be seen.
    let mut config = config(reader.config.launcher);
    config.refresh_secs = 3;
    config.active_refresh_secs = 3;
    let reader = ChainReader::new(
        Arc::clone(&state),
        Arc::clone(&chain) as Arc<dyn ChainSource>,
        config,
        reader.host.clone(),
    );
    read_all(&reader, &chain).await;
    let pool = state.db.pool();
    let id = reader.reader_id().to_owned();
    let head = chain.head().await.expect("head");
    let first = store::published(pool, &id).await.expect("published");
    assert_eq!(first.len(), 2, "both projects were signed: {first:?}");
    // The record kept is the typed record, true for the run's last block.
    let community = state
        .db
        .lookup_community_by_host(&reader.host)
        .await
        .expect("lookup")
        .expect("community");
    for (key, p) in &first {
        let event_id: Vec<u8> = sqlx::query_scalar(
            "SELECT event_id FROM chain_project_numbers WHERE reader = $1 AND project_key = $2",
        )
        .bind(&id)
        .bind(key.as_slice())
        .fetch_one(pool)
        .await
        .expect("the stored event id");
        let stored = state
            .db
            .get_event_by_id(community.id, &event_id)
            .await
            .expect("read")
            .expect("the record is stored");
        let record: super::record::Record =
            serde_json::from_str(&stored.event.content).expect("the typed record reads it back");
        assert_eq!(record.version, 2);
        assert_eq!(record.as_of.block, head - 2);
        assert_eq!(super::word::hex0x(key), record.key);
        assert_eq!(
            record.built_at,
            u64::try_from(p.published_at).expect("time")
        );
        assert!(super::record::validate(&record).is_empty());
    }
    // Nothing moved and the refresh is not due: nothing is signed.
    let report = reader.publish_pass(head).await.expect("publish");
    assert_eq!(report.signed, 0, "{report:?}");
    // The refresh is due: a record is signed with nothing changed.
    tokio::time::sleep(std::time::Duration::from_millis(3_200)).await;
    let report = reader.publish_pass(head).await.expect("publish");
    assert_eq!(report.signed, 2, "{report:?}");
    let second = store::published(pool, &id).await.expect("published");
    for (key, p) in &first {
        assert!(
            second[key].published_at > p.published_at,
            "builtAt moved on"
        );
    }
}
