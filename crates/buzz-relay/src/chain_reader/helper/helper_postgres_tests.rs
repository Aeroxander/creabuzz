//! The helper against real Postgres, the fake chain and a fake writer: what it
//! sends, when it waits, and what it never does. Ignored without
//! infrastructure; run with
//! `cargo test -p buzz-relay --lib chain_reader -- --include-ignored --test-threads=1`.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use buzz_evm_allowance::abi::{keccak256, selector};
use buzz_evm_allowance::Wallet;
use uuid::Uuid;

use super::calls::HelperCall;
use super::writer::{CallError, ChainWriter, Fees, Receipt, SendError, TxRequest};
use super::HelperConfig;
use crate::chain_reader::events::Role;
use crate::chain_reader::postgres_tests::{
    a, ask, data, launch_logs, topic, u, with_launcher, FakeChain, BOB, DAY, FOUNDER, LAUNCHER,
    ROUNDS, T0, VESTER,
};
use crate::chain_reader::word::Word;
use crate::chain_reader::{ChainReader, ChainReaderConfig, PassReport};

const ALICE: [u8; 20] = [0xa1; 20];
const CLAIM: [u8; 20] = [0xe1; 20];
/// anvil's account 4: a public development key, used only in tests.
const DEV_KEY: &str = "47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a";

/// A writer that answers from tables: views by calldata, reverts by
/// selector, everything else 64 zero bytes. Sends are recorded and, unless
/// `hold` is set, mined at once in `mined_block`.
pub(super) struct FakeWriter {
    address: [u8; 20],
    views: Mutex<HashMap<Vec<u8>, Vec<u8>>>,
    reverts: Mutex<HashMap<[u8; 4], String>>,
    pub(super) sent: Mutex<Vec<TxRequest>>,
    receipts: Mutex<HashMap<Word, Receipt>>,
    pub(super) known: Mutex<HashSet<Word>>,
    nonce: AtomicU64,
    pub(super) hold: AtomicBool,
    mined_block: AtomicU64,
}

impl FakeWriter {
    pub(super) fn new() -> Self {
        let wallet = Wallet::from_private_key_hex(DEV_KEY).expect("dev key");
        Self {
            address: wallet.address(),
            views: Mutex::new(HashMap::new()),
            reverts: Mutex::new(HashMap::new()),
            sent: Mutex::new(Vec::new()),
            receipts: Mutex::new(HashMap::new()),
            known: Mutex::new(HashSet::new()),
            nonce: AtomicU64::new(0),
            hold: AtomicBool::new(false),
            mined_block: AtomicU64::new(1_000_000),
        }
    }

    pub(super) fn answer(&self, signature: &str, args: &[Word], words: &[Word]) {
        let mut key = selector(signature).to_vec();
        args.iter().for_each(|w| key.extend_from_slice(w));
        self.views.lock().expect("lock").insert(key, data(words));
    }

    pub(super) fn revert(&self, signature: &str, error: &str) {
        let s = selector(error);
        self.reverts.lock().expect("lock").insert(
            selector(signature),
            format!(
                r#"{{"code":3,"message":"execution reverted: custom error 0x{}","data":"0x{}"}}"#,
                hex::encode(s),
                hex::encode(s)
            ),
        );
    }

    pub(super) fn calls(&self) -> Vec<Vec<u8>> {
        self.sent
            .lock()
            .expect("lock")
            .iter()
            .map(|t| t.data.clone())
            .collect()
    }
}

fn hash_of(tx: &TxRequest) -> Word {
    let mut bytes = tx.to.to_vec();
    bytes.extend_from_slice(&tx.data);
    bytes.extend_from_slice(&tx.nonce.to_be_bytes());
    bytes.extend_from_slice(&tx.fees.max_fee_per_gas.to_be_bytes());
    keccak256(&bytes)
}

#[async_trait]
impl ChainWriter for FakeWriter {
    fn address(&self) -> [u8; 20] {
        self.address
    }
    async fn call(&self, _to: &[u8; 20], data: &[u8]) -> Result<Vec<u8>, CallError> {
        let mut sel = [0u8; 4];
        sel.copy_from_slice(&data[..4]);
        if let Some(r) = self.reverts.lock().expect("lock").get(&sel) {
            return Err(CallError::Reverted(r.clone()));
        }
        Ok(self
            .views
            .lock()
            .expect("lock")
            .get(data)
            .cloned()
            .unwrap_or_else(|| vec![0; 64]))
    }
    async fn estimate_gas(&self, to: &[u8; 20], data: &[u8]) -> Result<u64, CallError> {
        self.call(to, data).await.map(|_| 100_000)
    }
    async fn nonce(&self) -> anyhow::Result<u64> {
        Ok(self.nonce.load(Ordering::SeqCst))
    }
    async fn fees(&self) -> anyhow::Result<Fees> {
        Ok(Fees {
            max_fee_per_gas: 2_000_000_000,
            max_priority_fee_per_gas: 1_000_000_000,
        })
    }
    fn tx_hash(&self, tx: &TxRequest) -> anyhow::Result<Word> {
        Ok(hash_of(tx))
    }
    async fn send(&self, tx: &TxRequest) -> Result<Word, SendError> {
        let hash = hash_of(tx);
        self.sent.lock().expect("lock").push(tx.clone());
        self.known.lock().expect("lock").insert(hash);
        if !self.hold.load(Ordering::SeqCst) {
            self.nonce.fetch_add(1, Ordering::SeqCst);
            self.receipts.lock().expect("lock").insert(
                hash,
                Receipt {
                    success: true,
                    block: self.mined_block.load(Ordering::SeqCst),
                    gas_used: 60_000,
                    effective_gas_price: 1_500_000_000,
                },
            );
        }
        Ok(hash)
    }
    async fn receipt(&self, hash: &Word) -> anyhow::Result<Option<Receipt>> {
        Ok(self.receipts.lock().expect("lock").get(hash).copied())
    }
    async fn known(&self, hash: &Word) -> anyhow::Result<bool> {
        Ok(self.known.lock().expect("lock").contains(hash))
    }
}

pub(super) fn helper_config(change: impl FnOnce(&mut HelperConfig)) -> HelperConfig {
    let mut cfg = HelperConfig::with_key(Wallet::from_private_key_hex(DEV_KEY).expect("dev key"));
    cfg.build_every_secs = 0;
    cfg.wait_secs = 0;
    change(&mut cfg);
    cfg
}

/// A reader with the helper on, writing through `writer`; `launcher` names
/// the reader (two readers with the same launcher share their rows).
pub(super) async fn setup_helper(
    chain: Arc<FakeChain>,
    writer: Arc<FakeWriter>,
    helper: HelperConfig,
    launcher: Option<[u8; 20]>,
) -> (ChainReader, Arc<crate::state::AppState>) {
    let state = crate::test_support::test_state().await;
    let host = format!("chain-helper-{}.example", Uuid::new_v4().simple());
    state
        .db
        .ensure_configured_community(&host)
        .await
        .expect("community");
    let mut l = LAUNCHER;
    l[..16].copy_from_slice(&Uuid::new_v4().into_bytes());
    let cfg = ChainReaderConfig {
        rpc_url: "http://127.0.0.1:1".into(),
        chain_id: 31337,
        launcher: launcher.unwrap_or(l),
        start_block: 0,
        confirmations: 0,
        poll_secs: 1,
        refresh_secs: 3_600,
        log_range: 50,
        community_host: None,
        helper: Some(helper),
    };
    let reader = ChainReader::new(Arc::clone(&state), chain, cfg, host).with_writer(writer);
    (reader, state)
}

fn closed(asked: u128) -> ([u8; 20], Vec<Word>, Vec<u8>) {
    (
        ROUNDS,
        vec![topic(Role::Rounds, "RoundClosed"), u(1)],
        data(&[u(asked), u(asked), u(DAY as u128)]),
    )
}

fn asked_by(who: &[u8; 20], amount: u128) -> ([u8; 20], Vec<Word>, Vec<u8>) {
    (
        ROUNDS,
        vec![topic(Role::Rounds, "Asked"), u(1), a(who)],
        data(&[u(amount), u(amount)]),
    )
}

/// Head `n` blocks later, empty.
fn idle(chain: &FakeChain, from_time: u64, n: u64) {
    for i in 0..n {
        chain.mine(from_time + i, 1, vec![]);
    }
}

async fn jobs(state: &crate::state::AppState, reader: &str) -> Vec<(String, String, i32)> {
    sqlx::query_as(
        "SELECT call, state, attempts FROM chain_helper_jobs WHERE reader = $1 ORDER BY id",
    )
    .bind(reader)
    .fetch_all(state.db.pool())
    .await
    .expect("jobs")
}

async fn pause_of(state: &crate::state::AppState, reader: &str) -> f64 {
    sqlx::query_scalar(
        "SELECT extract(epoch FROM next_try_at - now())::float8 FROM chain_helper_jobs \
         WHERE reader = $1 AND call = 'rounds.close'",
    )
    .bind(reader)
    .fetch_one(state.db.pool())
    .await
    .expect("pause")
}

async fn make_due(state: &crate::state::AppState, reader: &str) {
    sqlx::query("UPDATE chain_helper_jobs SET next_try_at = now() WHERE reader = $1")
        .bind(reader)
        .execute(state.db.pool())
        .await
        .expect("due now");
}

fn helper_of(report: &PassReport) -> &super::HelperReport {
    report.helper.as_ref().expect("the helper ran")
}

fn position(ask: u128, settled: bool) -> Vec<Word> {
    vec![u(ask), u(0), u(0), u(u128::from(settled))]
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_round_closes_and_settles_with_nobody_pressing() {
    let chain = Arc::new(FakeChain::default());
    let writer = Arc::new(FakeWriter::new());
    let (reader, state) = setup_helper(
        Arc::clone(&chain),
        Arc::clone(&writer),
        helper_config(|_| {}),
        None,
    )
    .await;
    let launcher = reader.config.launcher;
    chain.mine(T0, 1, with_launcher(launch_logs(), launcher)); // 0
    chain.mine(T0 + 10, 1, vec![ask(100_000_000)]); // 1
    idle(&chain, T0 + 20, 2); // 2, 3: the round's day has not passed at block 1
    let early = reader.pass_all().await.expect("pass");
    assert!(early.writer);
    assert_eq!(
        helper_of(&early).sent,
        0,
        "nothing is due before the day passes"
    );

    idle(&chain, T0 + DAY + 1, 3); // 4..6: final block 4 is past closesAt
    let report = reader.pass_all().await.expect("pass");
    assert_eq!(helper_of(&report).sent, 1);
    assert_eq!(helper_of(&report).done, 1);
    let close = HelperCall::RoundsClose {
        rounds: ROUNDS,
        round: 1,
    }
    .calldata();
    assert_eq!(writer.calls(), vec![close.clone()]);

    // Not sent again while the close is not final yet.
    idle(&chain, T0 + DAY + 10, 1);
    reader.pass_all().await.expect("pass");
    assert_eq!(writer.calls().len(), 1, "the close is sent once");

    // The close reaches the chain; once final, Bob is settled.
    chain.mine(T0 + DAY + 20, 1, vec![closed(100_000_000)]);
    idle(&chain, T0 + DAY + 30, 2);
    writer.answer(
        "positionOf(uint256,address)",
        &[u(1), a(&BOB)],
        &position(100_000_000, false),
    );
    let report = reader.pass_all().await.expect("pass");
    assert_eq!(helper_of(&report).sent, 1, "{report:?}");
    let settle = HelperCall::RoundsSettleMany {
        rounds: ROUNDS,
        round: 1,
        backers: vec![BOB],
    }
    .calldata();
    assert_eq!(writer.calls(), vec![close, settle]);
    let rows = jobs(&state, reader.reader_id()).await;
    assert!(rows
        .iter()
        .any(|(c, s, _)| c == "rounds.close" && s == "done"));
    assert!(rows
        .iter()
        .any(|(c, s, _)| c == "rounds.settleMany" && s == "done"));
    // Each send is kept with what it cost.
    let spent: Vec<(Option<i64>, Option<String>)> = sqlx::query_as(
        "SELECT gas_used, spent_wei::text FROM chain_helper_sends WHERE reader = $1",
    )
    .bind(reader.reader_id())
    .fetch_all(state.db.pool())
    .await
    .expect("sends");
    assert_eq!(spent.len(), 2);
    assert!(spent
        .iter()
        .all(|(g, w)| *g == Some(60_000) && w.as_deref() == Some("90000000000000")));
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_reverting_call_waits_longer_each_time_and_ends_failed() {
    let chain = Arc::new(FakeChain::default());
    let writer = Arc::new(FakeWriter::new());
    writer.revert("close(uint256)", "Reentrancy()");
    let cfg = helper_config(|c| c.max_attempts = 3);
    let (reader, state) = setup_helper(Arc::clone(&chain), Arc::clone(&writer), cfg, None).await;
    let launcher = reader.config.launcher;
    chain.mine(T0, 1, with_launcher(launch_logs(), launcher));
    chain.mine(T0 + 10, 1, vec![ask(100_000_000)]);
    idle(&chain, T0 + DAY + 1, 3);
    let mut pauses = Vec::new();
    for _ in 0..2 {
        let r = reader.pass_all().await.expect("pass");
        assert_eq!(helper_of(&r).retried, 1);
        pauses.push(pause_of(&state, reader.reader_id()).await);
        make_due(&state, reader.reader_id()).await;
    }
    assert!((55.0..=61.0).contains(&pauses[0]), "{pauses:?}");
    assert!(
        (115.0..=121.0).contains(&pauses[1]),
        "the pause grows: {pauses:?}"
    );
    let r = reader.pass_all().await.expect("pass");
    assert_eq!(helper_of(&r).failed, 1);
    let rows = jobs(&state, reader.reader_id()).await;
    assert!(
        rows.contains(&("rounds.close".into(), "failed".into(), 3)),
        "{rows:?}"
    );
    // Terminal: never tried again, and the builder does not reopen it.
    make_due(&state, reader.reader_id()).await;
    let r = reader.pass_all().await.expect("pass");
    assert_eq!(helper_of(&r).retried + helper_of(&r).failed, 0);
    assert!(writer.calls().is_empty(), "nothing was ever sent");
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_rollback_past_the_row_that_made_a_job_due_drops_it() {
    let chain = Arc::new(FakeChain::default());
    let writer = Arc::new(FakeWriter::new());
    // A cap too small for any call keeps the job waiting.
    let cfg = helper_config(|c| c.daily_gas = 50_000);
    let (reader, state) = setup_helper(Arc::clone(&chain), Arc::clone(&writer), cfg, None).await;
    let launcher = reader.config.launcher;
    let mut launch = with_launcher(launch_logs(), launcher);
    let opened = launch.pop().expect("RoundOpened"); // the round opens in block 1
    chain.mine(T0, 1, launch); // 0
    chain.mine(T0 + 1, 1, vec![opened, ask(100_000_000)]); // 1
    idle(&chain, T0 + DAY + 1, 3); // 2..4
    let r = reader.pass_all().await.expect("pass");
    assert_eq!(helper_of(&r).postponed, 1);
    assert_eq!(
        jobs(&state, reader.reader_id()).await,
        vec![("rounds.close".to_string(), "pending".to_string(), 0)],
        "the cap puts it off without counting an attempt"
    );
    // The chain drops block 1 (the round never opened there).
    chain.truncate(1);
    for i in 0..4 {
        chain.mine(T0 + DAY + i, 2, vec![]); // a different block 1, and 2..4
    }
    let r = reader.pass_all().await.expect("pass");
    assert_eq!(r.scanned.rolled_back_to, Some(0));
    assert!(jobs(&state, reader.reader_id()).await.is_empty());
    assert!(writer.calls().is_empty());
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_settled_backer_is_left_out_of_the_batch() {
    let chain = Arc::new(FakeChain::default());
    let writer = Arc::new(FakeWriter::new());
    let (reader, _) = setup_helper(
        Arc::clone(&chain),
        Arc::clone(&writer),
        helper_config(|_| {}),
        None,
    )
    .await;
    let launcher = reader.config.launcher;
    chain.mine(T0, 1, with_launcher(launch_logs(), launcher));
    chain.mine(T0 + 10, 1, vec![asked_by(&BOB, 50), asked_by(&ALICE, 70)]);
    chain.mine(T0 + DAY + 1, 1, vec![closed(120)]);
    idle(&chain, T0 + DAY + 2, 2);
    // Bob took his money back between the final block and now: the refund
    // settled him first, and settling him again would revert the batch.
    writer.answer(
        "positionOf(uint256,address)",
        &[u(1), a(&BOB)],
        &position(50, true),
    );
    writer.answer(
        "positionOf(uint256,address)",
        &[u(1), a(&ALICE)],
        &position(70, false),
    );
    reader.pass_all().await.expect("pass");
    let settle = HelperCall::RoundsSettleMany {
        rounds: ROUNDS,
        round: 1,
        backers: vec![ALICE],
    }
    .calldata();
    assert_eq!(writer.calls(), vec![settle]);
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn deliveries_leave_out_entries_inside_their_wait() {
    let chain = Arc::new(FakeChain::default());
    let writer = Arc::new(FakeWriter::new());
    let (reader, _) = setup_helper(
        Arc::clone(&chain),
        Arc::clone(&writer),
        helper_config(|_| {}),
        None,
    )
    .await;
    let launcher = reader.config.launcher;
    let key = crate::chain_reader::postgres_tests::key();
    let mut launch = with_launcher(launch_logs(), launcher);
    launch.pop(); // no round here
    launch.push((
        launcher,
        vec![topic(Role::Launcher, "ProjectZeroSplit"), key, a(&CLAIM)],
        data(&[u(10), u(20), u(30)]),
    ));
    chain.mine(T0, 1, launch);
    chain.mine(
        T0 + DAY,
        1,
        vec![(
            VESTER,
            vec![topic(Role::Vester, "Started")],
            data(&[u(T0 as u128)]),
        )],
    );
    let now = T0 + 40 * DAY;
    idle(&chain, now, 3);
    writer.answer("entryCount()", &[], &[u(3)]);
    writer.answer("minHoldFromConsent()", &[], &[u(0)]);
    // Entry 0 agreed 10 days ago (inside its 21), entry 1 30 days ago, entry 2 open.
    let entry = |consent: u64| vec![a(&ALICE), u(1), u(consent as u128)];
    writer.answer("entryOf(uint256)", &[u(0)], &entry(now - 10 * DAY));
    writer.answer("entryOf(uint256)", &[u(1)], &entry(now - 30 * DAY));
    writer.answer("entryOf(uint256)", &[u(2)], &entry(0));
    writer.answer("due(uint256)", &[u(0)], &[u(5)]);
    writer.answer("due(uint256)", &[u(1)], &[u(5)]);
    reader.pass_all().await.expect("pass");
    let deliver = HelperCall::EarlierDeliverMany {
        claim: CLAIM,
        entries: vec![1],
    }
    .calldata();
    assert_eq!(writer.calls(), vec![deliver]);
    // The founder's plain grant had nothing claimable: not sent.
    assert!(!writer
        .calls()
        .iter()
        .any(|c| c[..4] == selector("claim(address)")));
    let _ = FOUNDER;
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_vanished_transaction_is_checked_again_and_sent_again() {
    let chain = Arc::new(FakeChain::default());
    let writer = Arc::new(FakeWriter::new());
    writer.hold.store(true, Ordering::SeqCst);
    let (reader, state) = setup_helper(
        Arc::clone(&chain),
        Arc::clone(&writer),
        helper_config(|_| {}),
        None,
    )
    .await;
    let launcher = reader.config.launcher;
    chain.mine(T0, 1, with_launcher(launch_logs(), launcher));
    chain.mine(T0 + 10, 1, vec![ask(100_000_000)]);
    idle(&chain, T0 + DAY + 1, 3);
    let r = reader.pass_all().await.expect("pass");
    assert_eq!(helper_of(&r).sent, 1);
    // Still waiting: nothing else is sent while it is in flight.
    let r = reader.pass_all().await.expect("pass");
    assert_eq!(helper_of(&r).sent, 0);
    assert!(helper_of(&r).in_flight);
    assert_eq!(
        jobs(&state, reader.reader_id()).await[0].1,
        "sent".to_string()
    );
    // The node forgets it (a rollback of the head, a dropped pool).
    writer.known.lock().expect("lock").clear();
    let r = reader.pass_all().await.expect("pass");
    assert_eq!(helper_of(&r).returned, 1);
    assert_eq!(helper_of(&r).sent, 1, "checked again and sent again");
    let sent = writer.sent.lock().expect("lock").clone();
    assert_eq!(sent.len(), 2);
    assert_eq!(
        sent[0].nonce, sent[1].nonce,
        "the same nonce, read from latest"
    );
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_second_replica_without_the_writer_lock_signs_and_sends_nothing() {
    let chain = Arc::new(FakeChain::default());
    let first = Arc::new(FakeWriter::new());
    let second = Arc::new(FakeWriter::new());
    let (reader, _) = setup_helper(
        Arc::clone(&chain),
        Arc::clone(&first),
        helper_config(|_| {}),
        None,
    )
    .await;
    let launcher = reader.config.launcher;
    let (other, _) = setup_helper(
        Arc::clone(&chain),
        Arc::clone(&second),
        helper_config(|_| {}),
        Some(launcher),
    )
    .await;
    chain.mine(T0, 1, with_launcher(launch_logs(), launcher));
    chain.mine(T0 + 10, 1, vec![ask(100_000_000)]);
    idle(&chain, T0 + DAY + 1, 3);
    assert!(reader.pass_all().await.expect("pass").writer);
    let r = other.pass_all().await.expect("pass");
    assert!(!r.writer, "the lock is held by the first replica");
    assert!(r.helper.is_none());
    assert_eq!(r.published.signed, 0);
    assert!(second.calls().is_empty());
    assert_eq!(first.calls().len(), 1);
    // The first one stops; the second takes over.
    drop(reader);
    let mut took = false;
    for _ in 0..50 {
        if other.is_writer().await.expect("lock") {
            took = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    assert!(took, "the lock is freed when its holder goes away");
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn the_daily_cap_puts_a_job_off_without_counting_an_attempt() {
    let chain = Arc::new(FakeChain::default());
    let writer = Arc::new(FakeWriter::new());
    // 130,000 gas (the estimate plus margin) at 2 gwei is 2.6e14 wei.
    let cfg = helper_config(|c| c.daily_spend_wei = 200_000_000_000_000);
    let (reader, state) = setup_helper(Arc::clone(&chain), Arc::clone(&writer), cfg, None).await;
    let launcher = reader.config.launcher;
    chain.mine(T0, 1, with_launcher(launch_logs(), launcher));
    chain.mine(T0 + 10, 1, vec![ask(100_000_000)]);
    idle(&chain, T0 + DAY + 1, 3);
    let r = reader.pass_all().await.expect("pass");
    assert_eq!(helper_of(&r).postponed, 1);
    assert!(writer.calls().is_empty());
    let (attempts, wait): (i32, f64) = sqlx::query_as(
        "SELECT attempts, extract(epoch FROM next_try_at - now())::float8 FROM chain_helper_jobs \
         WHERE reader = $1",
    )
    .bind(reader.reader_id())
    .fetch_one(state.db.pool())
    .await
    .expect("job");
    assert_eq!(attempts, 0);
    assert!(wait > 3_500.0, "{wait}");
}
