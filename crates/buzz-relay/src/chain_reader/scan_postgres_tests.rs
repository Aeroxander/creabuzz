//! The reader against real Postgres and the real run of the contracts
//! (`testdata/pot-run.json`) served block by block by a fake node: the
//! Launcher's events lead it to every project's contracts, the stored rows
//! rebuild exactly the numbers the contracts' views gave, a log delivered
//! twice or from a stranger changes nothing, and a chain reorganisation that
//! drops a join takes its numbers back. Ignored without infrastructure (a
//! migrated database and Redis); run with
//! `cargo test -p buzz-relay --lib chain_reader::scan_postgres_tests -- --ignored`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
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
use super::{ChainReader, ChainReaderConfig, PublishReport};

/// The run's blocks served by a fake node. `fork` replaces the tail with
/// empty blocks of another hash, as a reorganisation does.
struct FixtureChain {
    blocks: Mutex<Vec<(Header, Vec<RawLog>)>>,
    /// Answer every log request twice over.
    duplicate: AtomicBool,
    /// Answer with every log of the range, whatever addresses were asked.
    ignore_filter: AtomicBool,
    /// Answer log requests with every log from the range's start on, whatever
    /// its end (a node that ignores `toBlock`).
    ignore_to: AtomicBool,
    /// `eth_call`s answered (or refused) so far.
    calls: AtomicUsize,
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
            ignore_to: AtomicBool::new(false),
            calls: AtomicUsize::new(0),
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
        self.calls.fetch_add(1, Ordering::SeqCst);
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
        let wide = self.ignore_to.load(Ordering::SeqCst);
        let mut found: Vec<RawLog> = blocks
            .iter()
            .filter(|(h, _)| h.number >= from && (wide || h.number <= to))
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
    setup_deep(fx, 0, 2).await
}

/// [`setup`] with a confirmation depth: the reader's final block is the head
/// less `max(confirmations, 2)`, and `empty_on_top` empty blocks follow the
/// run.
async fn setup_deep(
    fx: &Fixture,
    confirmations: u64,
    empty_on_top: u64,
) -> (ChainReader, Arc<FixtureChain>, Arc<crate::state::AppState>) {
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
    for _ in 0..empty_on_top {
        chain.mine_empty(1);
    }
    let reader = ChainReader::new(
        Arc::clone(&state),
        Arc::clone(&chain) as Arc<dyn ChainSource>,
        ChainReaderConfig {
            confirmations,
            ..config(launcher)
        },
        host,
    );
    (reader, chain, state)
}

/// Passes until the reader has read to the head less its lag.
async fn read_all(reader: &ChainReader, chain: &FixtureChain) -> super::scan::ScanReport {
    let want = chain.head().await.expect("head") - reader.scan.lag;
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

// ---------------------------------------------------------------------------
// The publishing queue and the node's own misbehaviour (review fixes).
// ---------------------------------------------------------------------------

/// The content of the record last signed for `key`.
async fn stored_record(reader: &ChainReader, key: &Word) -> Value {
    let pool = reader.state.db.pool();
    let event_id: Vec<u8> = sqlx::query_scalar(
        "SELECT event_id FROM chain_project_numbers WHERE reader = $1 AND project_key = $2",
    )
    .bind(reader.reader_id())
    .bind(key.as_slice())
    .fetch_one(pool)
    .await
    .expect("a stored record id");
    let community = reader
        .state
        .db
        .lookup_community_by_host(&reader.host)
        .await
        .expect("lookup")
        .expect("community");
    let stored = reader
        .state
        .db
        .get_event_by_id(community.id, &event_id)
        .await
        .expect("read")
        .expect("the record is stored");
    serde_json::from_str(&stored.event.content).expect("json")
}

/// A node that answers a lower head than the blocks the reader has read (a
/// load-balanced node a few blocks behind), with every block it served before
/// still on its chain, is not a rollback. The record already signed must stay:
/// numbers worked out at the lower block must not replace newer ones (a join
/// already shown must not disappear).
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_head_that_steps_back_does_not_replace_a_newer_record_with_an_older_one() {
    let fx = Fixture::load();
    // 24 confirmations: the final block is the head less 24.
    let (reader, chain, _state) = setup_deep(&fx, 24, 24).await;
    chain.serve_books(&fx, &["A_end", "B_end"]);
    read_all(&reader, &chain).await;
    let pool = reader.state.db.pool();
    let a = fx.projects["A"].key;
    let before = stored_record(&reader, &a).await;
    assert_eq!(
        before["asOf"]["block"],
        fx.head(),
        "signed at the run's end"
    );
    let published_before = store::published(pool, reader.reader_id())
        .await
        .expect("published");

    // The node's head drops by 24 blocks; the newest stored block is still on
    // its chain (so it is not "behind" and not a rollback). The node can still
    // serve the views of the lower final block (the book of A at block 61).
    chain.truncate(usize::try_from(fx.head()).expect("block") + 1);
    chain.serve_books(&fx, &["A_live"]);
    let (scan, publish) = reader.pass().await.expect("a pass");
    assert!(scan.rolled_back_to.is_none() && !scan.behind, "{scan:?}");

    let after = stored_record(&reader, &a).await;
    assert_eq!(
        after["asOf"]["block"],
        fx.head(),
        "an older asOf replaced a newer one ({publish:?})"
    );
    let published_after = store::published(pool, reader.reader_id())
        .await
        .expect("published");
    assert_eq!(
        published_after[&a].published_at, published_before[&a].published_at,
        "nothing was signed"
    );
    assert_eq!(publish, PublishReport::default());
}

/// The same step back, with a project launched above the lower final block: it
/// is on the chain, so no removal may be signed for it.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_head_that_steps_back_does_not_publish_a_removal_for_a_live_project() {
    let fx = Fixture::load();
    let (reader, chain, _state) = setup_deep(&fx, 20, 0).await;
    // Project B is launched at block 19; with 20 confirmations a head of 54
    // makes block 34 final, and B's book "B_pair" is at block 34.
    chain.truncate(55);
    chain.serve_books(&fx, &["B_pair"]);
    let b = fx.projects["B"].key;
    for _ in 0..20 {
        reader.pass().await.expect("a pass");
        if store::cursor(reader.state.db.pool(), reader.reader_id())
            .await
            .expect("cursor")
            > 34
        {
            break;
        }
    }
    let pool = reader.state.db.pool();
    let before = stored_record(&reader, &b).await;
    assert_eq!(before["asOf"]["block"], 34);
    assert!(before.get("removed").is_none());

    // The head steps back to 34: the final block is 14, below B's launch.
    chain.truncate(35);
    let (scan, publish) = reader.pass().await.expect("a pass");
    assert!(scan.rolled_back_to.is_none(), "{scan:?}");
    assert_eq!(
        publish.removed, 0,
        "a removal was signed for a live project"
    );
    let published = store::published(pool, reader.reader_id())
        .await
        .expect("published");
    assert!(published.contains_key(&b), "B's row was forgotten");
    assert!(stored_record(&reader, &b).await.get("removed").is_none());
}

/// A project that is neither changed nor due costs the node nothing: after the
/// one look that finds its record still good, the passes that follow ask the
/// node no view call (it is looked at again when its own promised refresh is
/// due, or an event moves it).
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_project_that_is_not_due_and_has_not_changed_costs_no_view_calls() {
    let fx = Fixture::load();
    let (reader, chain, state) = setup(&fx).await;
    chain.serve_books(&fx, &["A_end", "B_end"]);
    read_all(&reader, &chain).await;
    let head = chain.head().await.expect("head");
    let id = reader.reader_id().to_owned();
    // Age the records to 700 s: past the 600 s after which the reader looks
    // again, inside the 3600 s a quiet project promised.
    sqlx::query(
        "UPDATE chain_project_numbers SET published_at = now() - interval '700 seconds' \
         WHERE reader = $1",
    )
    .bind(&id)
    .execute(state.db.pool())
    .await
    .expect("age the records");
    let mut spent = Vec::new();
    for _ in 0..3 {
        chain.calls.store(0, Ordering::SeqCst);
        let report = reader.publish_pass(head).await.expect("publish");
        assert_eq!(report.signed, 0, "nothing is due: {report:?}");
        spent.push(chain.calls.load(Ordering::SeqCst));
    }
    assert!(spent[0] > 0, "the first look reads the views: {spent:?}");
    assert_eq!(
        &spent[1..],
        &[0, 0],
        "passes with nothing to sign asked the node again: {spent:?}"
    );
}

/// 100 projects whose numbers cannot be built must not keep the front of the
/// queue: after one failed pass they wait out a pause and the others are
/// signed.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_hundred_projects_that_cannot_be_built_do_not_starve_the_others() {
    let fx = Fixture::load();
    let (reader, chain, _state) = setup(&fx).await;
    chain.serve_books(&fx, &["A_end", "B_end"]);
    read_all(&reader, &chain).await;
    let pool = reader.state.db.pool();
    let id = reader.reader_id().to_owned();
    let head = chain.head().await.expect("head");
    let (a, b) = (fx.projects["A"].key, fx.projects["B"].key);

    // 100 more launches of the Launcher, with keys that sort before the run's
    // two and contracts the node knows nothing about: their views cannot be
    // read, so their numbers cannot be built.
    let launch = fx
        .decoded()
        .into_iter()
        .find(|(_, p, r)| p.as_deref() == Some("A") && r.event == "ProjectLaunched")
        .map(|(_, _, r)| r)
        .expect("A's launch");
    let launcher: Vec<u8> = sqlx::query_scalar(
        "SELECT address FROM chain_logs WHERE reader = $1 AND role = 'launcher' LIMIT 1",
    )
    .bind(&id)
    .fetch_one(pool)
    .await
    .expect("the stored Launcher");
    for i in 0u8..100 {
        let mut key = [0u8; 32];
        key[31] = i + 1;
        let mut decoded = launch.fields.clone();
        decoded["key"] = Value::String(hex0x(&key));
        for (n, name) in ["shares", "team", "treasury", "vester"].iter().enumerate() {
            let mut address = [0xabu8; 20];
            address[0] = i;
            address[1] = u8::try_from(n).expect("small");
            decoded["project"][name] = Value::String(hex0x(&address));
        }
        sqlx::query(
            "INSERT INTO chain_logs (reader, block_number, log_index, block_hash, tx_hash, \
                 address, role, project_key, event, topics, data, decoded) \
             VALUES ($1, 3, $2, $3, $3, $4, 'launcher', $5, 'ProjectLaunched', $6, $7, $8)",
        )
        .bind(&id)
        .bind(1_000 + i32::from(i))
        .bind(vec![0u8; 32])
        .bind(&launcher)
        .bind(key.as_slice())
        .bind(Vec::<Vec<u8>>::new())
        .bind(Vec::<u8>::new())
        .bind(&decoded)
        .execute(pool)
        .await
        .expect("insert a launch row");
    }
    // The two real projects need a record again.
    for key in [&a, &b] {
        store::forget_published(pool, &id, key)
            .await
            .expect("forget");
    }

    let first = reader.publish_pass(head).await.expect("publish");
    assert_eq!(first.failed, 100, "{first:?}");
    assert_eq!(
        first.signed, 0,
        "the failing 100 take the whole pass: {first:?}"
    );
    // The next pass leaves them alone for their pause and signs the others.
    let second = reader.publish_pass(head).await.expect("publish");
    assert_eq!(
        second.failed, 0,
        "failed projects were tried again at once: {second:?}"
    );
    assert_eq!(second.signed, 2, "{second:?}");
    let published = store::published(pool, &id).await.expect("published");
    assert!(published.contains_key(&a) && published.contains_key(&b));
}

/// A node that ignores the end of the range sends logs of later blocks too.
/// They are read again in their own range and stored once: the reader reaches
/// the head and rebuilds the run's numbers (a duplicate row would fail every
/// pass from then on).
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_node_that_ignores_the_end_of_the_range_does_not_wedge_the_reader() {
    let fx = Fixture::load();
    let (reader, chain, _state) = setup(&fx).await;
    chain.ignore_to.store(true, Ordering::SeqCst);
    read_all(&reader, &chain).await;
    let head = chain.head().await.expect("head");
    for name in ["A", "B"] {
        let ledger = ledger_of(&reader, &fx.projects[name].key, head - 2).await;
        assert_end_of_run(&fx, name, &ledger);
    }
}

/// The dollar's kind is read by every replica, not only by the one that signs
/// records: a replica without the writer lock learns from its own passes that
/// the chain is play money (until then the safe answer, "play money", stands
/// for an unknown one).
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_replica_without_the_writer_lock_reads_whether_the_dollar_is_play_money() {
    let fx = Fixture::load();
    let (reader, chain, state) = setup(&fx).await;
    chain.serve_books(&fx, &["A_end", "B_end"]);
    // Another connection holds the writer lock.
    let mut other = state
        .db
        .pool()
        .acquire()
        .await
        .expect("a connection")
        .detach();
    let got: bool = sqlx::query_scalar("SELECT pg_try_advisory_lock(hashtextextended($1, 0))")
        .bind(format!("chain_writer:{}", reader.reader_id()))
        .fetch_one(&mut other)
        .await
        .expect("lock");
    assert!(got);
    super::forget_play_money_for_test();
    let report = reader.pass_all().await.expect("a pass");
    assert!(!report.writer, "this replica must not be the writer");
    assert_eq!(
        super::play_money(),
        Some(true),
        "a local chain is a test network; the replica did not read it"
    );
    drop(other);
}
