//! Milestone 5 part 2 review fixes, against real Postgres: the default batch
//! fits the caps and an oversized batch is halved (B1), one reverting backer
//! does not hold back its batch (I1), routine calls cannot use the budget a
//! close needs (I2), and a node that does not answer the helper does not fail
//! the reader's pass (I3). The second review of those fixes added: a stuck
//! routine call is still replaced when its share is used up, every entry of
//! a halved repeating delivery is delivered, and a node error while settling
//! the send in flight does not fail the reader's pass. Most drive the production `Helper::pass` with a
//! fake writer whose gas estimates follow the measured contract costs
//! (adopted from the review's failing tests).
//!
//! `cargo test -p buzz-relay --lib chain_reader -- --include-ignored --test-threads=1`

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use buzz_evm_allowance::abi::{keccak256, selector};
use buzz_evm_allowance::Wallet;
use sqlx::PgPool;

use super::calls::HelperCall;
use super::helper_postgres_tests::{helper_config, idle, jobs, setup_helper, FakeWriter};
use super::plan::Job;
use super::store;
use super::writer::{CallError, ChainWriter, Fees, Receipt, SendError, TxRequest};
use super::{Helper, HelperConfig};
use crate::chain_reader::postgres_tests::{ask, launch_logs, with_launcher, FakeChain, DAY, T0};
use crate::chain_reader::word::Word;

/// anvil's account 4: a public development key, used only in tests.
const DEV_KEY: &str = "47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a";
const ROUNDS: [u8; 20] = [0x10; 20];
const VESTER: [u8; 20] = [0x30; 20];
const POISON: [u8; 20] = [0xbb; 20];

/// `settleMany` gas per backer, from the M4 gas report (119,157 to 132,278
/// each; 153,672 for the first of a large list).
const SETTLE_GAS_PER_BACKER: u64 = 125_000;
/// A plain `Vester.claim` (or any small call).
const SMALL_CALL_GAS: u64 = 60_000;
/// `deliverMany` gas per entry: 64 entries in one call is about 3.8M gas.
const DELIVER_GAS_PER_ENTRY: u64 = 59_000;
const CLAIM: [u8; 20] = [0xe1; 20];

fn entries_in(data: &[u8]) -> Vec<u64> {
    // selector | offset | length | items
    let word_at = |at: usize| {
        data.get(at + 24..at + 32)
            .and_then(|b| <[u8; 8]>::try_from(b).ok())
            .map(u64::from_be_bytes)
    };
    let len = word_at(4 + 32).unwrap_or(0) as usize;
    (0..len).filter_map(|i| word_at(4 + 64 + 32 * i)).collect()
}

fn backers_in(data: &[u8]) -> Vec<[u8; 20]> {
    // selector | round | offset | length | items
    let len = data
        .get(4 + 64 + 24..4 + 96)
        .and_then(|b| <[u8; 8]>::try_from(b).ok())
        .map(u64::from_be_bytes)
        .unwrap_or(0) as usize;
    (0..len)
        .filter_map(|i| {
            let at = 4 + 96 + 32 * i + 12;
            data.get(at..at + 20)
                .and_then(|b| <[u8; 20]>::try_from(b).ok())
        })
        .collect()
}

/// A chain where every view answers "yes, something to do", `settleMany`
/// costs what it really costs per backer, and a settle that pays POISON back
/// reverts (a blacklisted dollar receiver).
struct Writer {
    address: [u8; 20],
    sent: Mutex<Vec<TxRequest>>,
    nonce: AtomicU64,
    /// Sends mine at once; when false, they stay in flight for good.
    mines: AtomicBool,
}

impl Writer {
    fn new() -> Self {
        Self {
            address: Wallet::from_private_key_hex(DEV_KEY)
                .expect("dev key")
                .address(),
            sent: Mutex::new(Vec::new()),
            nonce: AtomicU64::new(0),
            mines: AtomicBool::new(true),
        }
    }

    fn sent_calls(&self) -> Vec<TxRequest> {
        self.sent.lock().expect("lock").clone()
    }

    fn gas_of(data: &[u8]) -> u64 {
        if data[..4] == selector("settleMany(uint256,address[])") {
            21_000 + SETTLE_GAS_PER_BACKER * backers_in(data).len() as u64
        } else if data[..4] == selector("deliverMany(uint256[])") {
            21_000 + DELIVER_GAS_PER_ENTRY * entries_in(data).len() as u64
        } else {
            SMALL_CALL_GAS
        }
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
impl ChainWriter for Writer {
    fn address(&self) -> [u8; 20] {
        self.address
    }
    async fn call(&self, _to: &[u8; 20], data: &[u8]) -> Result<Vec<u8>, CallError> {
        if data[..4] == selector("settleMany(uint256,address[])")
            && backers_in(data).contains(&POISON)
        {
            return Err(CallError::Reverted(
                r#"{"code":3,"message":"execution reverted: Blacklistable: account is blacklisted"}"#
                    .into(),
            ));
        }
        // positionOf: ask 1, not settled; the claim: 64 entries, each agreed
        // long ago (consentAt 1); every other uint view: 1.
        let mut out = vec![0u8; 128];
        if data[..4] == selector("entryCount()") {
            out[31] = 64;
        } else if data[..4] == selector("entryOf(uint256)") {
            out[95] = 1;
        } else {
            out[31] = 1;
        }
        Ok(out)
    }
    async fn estimate_gas(&self, to: &[u8; 20], data: &[u8]) -> Result<u64, CallError> {
        self.call(to, data).await.map(|_| Self::gas_of(data))
    }
    async fn nonce(&self) -> anyhow::Result<u64> {
        Ok(self.nonce.load(Ordering::SeqCst))
    }
    async fn fees(&self) -> anyhow::Result<Fees> {
        Ok(Fees {
            max_fee_per_gas: 2_000_000,
            max_priority_fee_per_gas: 1_000_000,
        })
    }
    fn tx_hash(&self, tx: &TxRequest) -> anyhow::Result<Word> {
        Ok(hash_of(tx))
    }
    async fn send(&self, tx: &TxRequest) -> Result<Word, SendError> {
        self.sent.lock().expect("lock").push(tx.clone());
        if self.mines.load(Ordering::SeqCst) {
            self.nonce.fetch_add(1, Ordering::SeqCst);
        }
        Ok(hash_of(tx))
    }
    async fn receipt(&self, hash: &Word) -> anyhow::Result<Option<Receipt>> {
        if !self.mines.load(Ordering::SeqCst) {
            return Ok(None);
        }
        let sent = self.sent.lock().expect("lock");
        Ok(sent.iter().find(|t| hash_of(t) == *hash).map(|t| Receipt {
            success: true,
            block: 1_000,
            gas_used: Self::gas_of(&t.data),
            effective_gas_price: 1_500_000,
        }))
    }
    async fn known(&self, hash: &Word) -> anyhow::Result<bool> {
        Ok(self
            .sent
            .lock()
            .expect("lock")
            .iter()
            .any(|t| hash_of(t) == *hash))
    }
}

async fn pool() -> PgPool {
    crate::test_support::test_state().await.db.pool().clone()
}

fn reader() -> String {
    format!("review-m5p2-{}", uuid::Uuid::new_v4().simple())
}

async fn clean(pool: &PgPool, reader: &str) {
    for sql in [
        "DELETE FROM chain_helper_sends WHERE reader = $1",
        "DELETE FROM chain_helper_jobs WHERE reader = $1",
    ] {
        sqlx::query(sql)
            .bind(reader)
            .execute(pool)
            .await
            .expect("clean");
    }
}

async fn make_due(pool: &PgPool, reader: &str) {
    sqlx::query("UPDATE chain_helper_jobs SET next_try_at = now() WHERE reader = $1")
        .bind(reader)
        .execute(pool)
        .await
        .expect("due now");
}

type JobState = (String, String, i32, Option<String>);

async fn states(pool: &PgPool, reader: &str) -> Vec<JobState> {
    sqlx::query_as(
        "SELECT call, state, attempts, last_error FROM chain_helper_jobs WHERE reader = $1 ORDER BY id",
    )
    .bind(reader)
    .fetch_all(pool)
    .await
    .expect("jobs")
}

fn config(change: impl FnOnce(&mut HelperConfig)) -> HelperConfig {
    let mut cfg = HelperConfig::with_key(Wallet::from_private_key_hex(DEV_KEY).expect("dev key"));
    cfg.wait_secs = 0;
    change(&mut cfg);
    cfg
}

fn job(key: &str, call: HelperCall, project: u8, repeats: bool) -> Job {
    Job {
        key: key.into(),
        call,
        project_key: [project; 32],
        due_block: 10,
        repeats,
    }
}

fn backer(i: usize) -> [u8; 20] {
    let mut a = [0x0au8; 20];
    a[12..].copy_from_slice(&(i as u64 + 1).to_be_bytes());
    a
}

fn now() -> u64 {
    u64::try_from(chrono::Utc::now().timestamp()).unwrap_or(0)
}

/// Run `passes` helper passes, each with every waiting job made due first.
async fn run(helper: &Helper, pool: &PgPool, reader: &str, passes: usize) {
    for _ in 0..passes {
        make_due(pool, reader).await;
        helper
            .pass(pool, reader, (1_000, now()), None, &[])
            .await
            .expect("pass");
    }
}

fn settled_by(writer: &Writer) -> Vec<[u8; 20]> {
    writer
        .sent_calls()
        .iter()
        .filter(|t| t.data[..4] == selector("settleMany(uint256,address[])"))
        .flat_map(|t| backers_in(&t.data))
        .collect()
}

async fn settle_job(pool: &PgPool, reader: &str, backers: Vec<[u8; 20]>) {
    store::upsert_jobs(
        pool,
        reader,
        &[job(
            "rounds.settleMany:review",
            HelperCall::RoundsSettleMany {
                rounds: ROUNDS,
                round: 1,
                backers,
            },
            1,
            false,
        )],
        10,
    )
    .await
    .expect("job");
}

/// B1: with the default settings a batch of the default size is sent (it
/// fits the per-call cap and the daily cap with the helper's margin).
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_default_sized_settle_batch_is_sent() {
    let pool = pool().await;
    let reader = reader();
    let writer = Arc::new(Writer::new());
    let cfg = config(|_| {});
    settle_job(&pool, &reader, (0..cfg.batch).map(backer).collect()).await;
    let helper = Helper::new(writer.clone(), cfg.clone());
    run(&helper, &pool, &reader, 2).await;
    let jobs = states(&pool, &reader).await;
    let settled = settled_by(&writer);
    clean(&pool, &reader).await;
    assert_eq!(
        settled.len(),
        cfg.batch,
        "the whole default batch is sent at once; jobs: {jobs:?}"
    );
    assert!(jobs.iter().all(|j| j.1 == "done"), "{jobs:?}");
}

/// B1: a batch over the per-call cap is halved until it fits, and its first
/// part is sent; it never ends `failed` for its size.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn an_oversized_batch_is_halved_not_failed() {
    let pool = pool().await;
    let reader = reader();
    let writer = Arc::new(Writer::new());
    let cfg = config(|_| {});
    // 40 settles: about 6.0M gas with the margin, twice the 3M cap.
    settle_job(&pool, &reader, (0..40).map(backer).collect()).await;
    let helper = Helper::new(writer.clone(), cfg.clone());
    run(&helper, &pool, &reader, cfg.max_attempts as usize + 2).await;
    let jobs = states(&pool, &reader).await;
    let settled = settled_by(&writer);
    clean(&pool, &reader).await;
    assert!(
        !settled.is_empty() && jobs.iter().all(|j| j.1 != "failed"),
        "a batch over the cap is made smaller, never failed; settled {}; jobs: {jobs:?}",
        settled.len()
    );
    let sent = writer.sent_calls();
    assert!(
        sent.iter().all(|t| t.gas_limit <= cfg.call_gas_cap),
        "every send fits the cap"
    );
    assert_eq!(settled, (0..10).map(backer).collect::<Vec<_>>());
}

/// I1: one backer whose settle reverts (the dollars returned to a blacklisted
/// address) is left out; the rest of the batch is settled.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn one_reverting_backer_does_not_strand_the_rest_of_its_batch() {
    let pool = pool().await;
    let reader = reader();
    let writer = Arc::new(Writer::new());
    let cfg = config(|_| {});
    settle_job(&pool, &reader, vec![backer(0), POISON, backer(1)]).await;
    let helper = Helper::new(writer.clone(), cfg.clone());
    run(&helper, &pool, &reader, cfg.max_attempts as usize + 2).await;
    let jobs = states(&pool, &reader).await;
    let settled = settled_by(&writer);
    clean(&pool, &reader).await;
    assert_eq!(
        settled,
        vec![backer(0), backer(1)],
        "the two good backers are settled, the blacklisted one left out; jobs: {jobs:?}"
    );
    // Alone, the reverting backer's batch fails for good (terminal) without
    // touching anyone else.
    let reader = self::reader();
    let writer = Arc::new(Writer::new());
    settle_job(&pool, &reader, vec![POISON]).await;
    let helper = Helper::new(writer.clone(), cfg.clone());
    run(&helper, &pool, &reader, cfg.max_attempts as usize + 2).await;
    let jobs = states(&pool, &reader).await;
    clean(&pool, &reader).await;
    assert!(writer.sent_calls().is_empty());
    assert_eq!(jobs[0].1, "failed", "{jobs:?}");
}

/// I2: the daily caps keep room for the calls a round or a sale waits on. One
/// project's many small claims use at most the routine share, and another
/// project's round still closes the same day.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn dust_claims_of_one_project_do_not_stop_another_projects_close() {
    let pool = pool().await;
    let reader = reader();
    let writer = Arc::new(Writer::new());
    // Room for five small calls a day (each asks 60,000 x 1.2 + 10,000).
    let per_call = SMALL_CALL_GAS + SMALL_CALL_GAS / 5 + 10_000;
    let cfg = config(|c| {
        c.daily_gas = u128::from(per_call) * 5;
    });
    let claims: Vec<Job> = (0..12)
        .map(|i| {
            job(
                &format!("vester.claim:dust:{i}"),
                HelperCall::VesterClaim {
                    vester: VESTER,
                    beneficiary: backer(100 + i),
                },
                0xaa,
                true,
            )
        })
        .collect();
    store::upsert_jobs(&pool, &reader, &claims, 10)
        .await
        .expect("claims");
    let helper = Helper::new(writer.clone(), cfg.clone());
    run(&helper, &pool, &reader, 3).await;
    // Another project's round is now due to close.
    store::upsert_jobs(
        &pool,
        &reader,
        &[job(
            "rounds.close:other:1",
            HelperCall::RoundsClose {
                rounds: ROUNDS,
                round: 1,
            },
            0xbb,
            false,
        )],
        10,
    )
    .await
    .expect("close");
    run(&helper, &pool, &reader, 2).await;
    let jobs = states(&pool, &reader).await;
    let closed = writer
        .sent_calls()
        .iter()
        .any(|t| t.data[..4] == selector("close(uint256)"));
    let claims_sent = writer
        .sent_calls()
        .iter()
        .filter(|t| t.data[..4] == selector("claim(address)"))
        .count();
    clean(&pool, &reader).await;
    assert!(
        closed,
        "the other project's round should close; jobs: {jobs:?}"
    );
    assert!(
        claims_sent < 5,
        "routine claims stay within their share: {claims_sent}"
    );
    assert!(
        jobs.iter()
            .filter(|j| j.0 == "vester.claim" && j.1 == "pending")
            .all(|j| j.2 == 0),
        "claims put off by the cap count no attempt: {jobs:?}"
    );
}

/// I3: a node that does not answer the helper (a rate limit) puts the job off
/// without counting an attempt; the reader's pass still succeeds and its
/// record is signed.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_node_that_does_not_answer_the_helper_does_not_fail_the_pass() {
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
    idle(&chain, T0 + DAY + 1, 4); // 2..5: the round is due to close
    writer.down.store(true, Ordering::SeqCst);
    let report = reader.pass_all().await.expect("the reader's pass works");
    assert!(report.writer);
    assert!(report.published.signed >= 1, "{report:?}");
    let h = report.helper.as_ref().expect("the helper ran");
    assert_eq!(h.node_errors, 1, "{h:?}");
    assert_eq!(h.sent, 0);
    let rows = jobs(&state, reader.reader_id()).await;
    assert!(
        rows.iter()
            .any(|(c, s, n)| c == "rounds.close" && s == "pending" && *n == 0),
        "put off, no attempt counted: {rows:?}"
    );

    // The node answers again: the close goes out.
    writer.down.store(false, Ordering::SeqCst);
    sqlx::query("UPDATE chain_helper_jobs SET next_try_at = now() WHERE reader = $1")
        .bind(reader.reader_id())
        .execute(state.db.pool())
        .await
        .expect("due now");
    let report = reader.pass_all().await.expect("pass");
    assert_eq!(report.helper.as_ref().map(|h| h.sent), Some(1));
}

/// Second review of I2: a routine call that gets stuck after its share of the
/// day is used up is still replaced. It was let in when first sent, and only
/// one transaction at its nonce can mine, so the replacement is checked for
/// what it adds over the stuck one, against the whole caps. Before, it was
/// checked for its whole cost again against the routine share, was never
/// replaced, and held back every other job behind the one nonce.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_stuck_routine_call_is_replaced_when_its_share_is_used_up() {
    let pool = pool().await;
    let reader = reader();
    let writer = Arc::new(Writer::new());
    writer.mines.store(false, Ordering::SeqCst);
    // The routine share holds exactly one claim (60,000 x 1.2 + 10,000).
    let per_call = SMALL_CALL_GAS + SMALL_CALL_GAS / 5 + 10_000;
    let cfg = config(|c| {
        c.daily_gas = u128::from(per_call) * 2;
        c.stuck_after_secs = 0;
    });
    store::upsert_jobs(
        &pool,
        &reader,
        &[job(
            "vester.claim:stuck",
            HelperCall::VesterClaim {
                vester: VESTER,
                beneficiary: backer(7),
            },
            0xaa,
            true,
        )],
        10,
    )
    .await
    .expect("claim");
    let helper = Helper::new(writer.clone(), cfg);
    run(&helper, &pool, &reader, 3).await;
    let jobs = states(&pool, &reader).await;
    clean(&pool, &reader).await;
    let sent = writer.sent_calls();
    assert_eq!(
        sent.len(),
        3,
        "sent once, then replaced on each pass; jobs: {jobs:?}"
    );
    assert!(sent.iter().all(|t| t.nonce == 0), "one nonce");
    assert!(
        sent.windows(2)
            .all(|w| w[1].fees.max_fee_per_gas > w[0].fees.max_fee_per_gas),
        "each replacement pays more"
    );
}

/// Second review of B1: a repeating `deliverMany` batch over the gas room is
/// halved, and the half left out is delivered too. Its key names the day and
/// the batch's position, so the builder would make the same first half again
/// each day and the rest would never go out. The settings are a batch of 64
/// (`BUZZ_CHAIN_HELPER_BATCH=64`: every entry in one batch, about 3.8M gas
/// with the margin over the 3M per-call cap), as the builder makes it.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn every_due_entry_of_a_halved_repeating_delivery_is_delivered() {
    let pool = pool().await;
    let reader = reader();
    let writer = Arc::new(Writer::new());
    let cfg = config(|c| c.batch = 64);
    let all: Vec<u64> = (0..64).collect();
    store::upsert_jobs(
        &pool,
        &reader,
        &[job(
            "earlier.deliverMany:claim:d1:0-64",
            HelperCall::EarlierDeliverMany {
                claim: CLAIM,
                entries: all.clone(),
            },
            0xcc,
            true,
        )],
        10,
    )
    .await
    .expect("delivery");
    let helper = Helper::new(writer.clone(), cfg.clone());
    run(&helper, &pool, &reader, 4).await;
    let jobs = states(&pool, &reader).await;
    clean(&pool, &reader).await;
    let sent = writer.sent_calls();
    let mut delivered: Vec<u64> = sent
        .iter()
        .filter(|t| t.data[..4] == selector("deliverMany(uint256[])"))
        .flat_map(|t| entries_in(&t.data))
        .collect();
    delivered.sort_unstable();
    assert_eq!(
        delivered, all,
        "every entry with Shares due is delivered once; jobs: {jobs:?}"
    );
    assert!(
        sent.len() > 1 && sent.iter().all(|t| t.gas_limit <= cfg.call_gas_cap),
        "halved to fit the cap"
    );
    assert!(jobs.iter().all(|j| j.1 == "done"), "{jobs:?}");
}

/// Second review of I3: a node error while settling the transaction in
/// flight (its receipt cannot be read) fails the helper's pass only. The
/// reader's pass succeeds, keeps the helper's error, and signs its record.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_node_error_on_the_send_in_flight_does_not_fail_the_readers_pass() {
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
    idle(&chain, T0 + 20, 2); // 2..3
                              // A transaction in flight from an earlier pass.
    let pool = state.db.pool();
    let id = reader.reader_id().to_owned();
    store::upsert_jobs(
        pool,
        &id,
        &[job(
            "rounds.close:in-flight",
            HelperCall::RoundsClose {
                rounds: ROUNDS,
                round: 1,
            },
            0xdd,
            false,
        )],
        10,
    )
    .await
    .expect("job");
    let job_id: i64 = sqlx::query_scalar("SELECT id FROM chain_helper_jobs WHERE reader = $1")
        .bind(&id)
        .fetch_one(pool)
        .await
        .expect("job id");
    store::record_send(
        pool,
        &id,
        store::SendRow {
            job_id,
            tx_hash: &[0x77; 32],
            nonce: 0,
            gas_limit: 100_000,
            max_fee_per_gas: 2_000_000_000,
            max_priority_fee_per_gas: 1_000_000_000,
        },
        &serde_json::json!({ "round": 1 }),
        None,
    )
    .await
    .expect("in flight");
    writer.receipts_down.store(true, Ordering::SeqCst);
    let report = reader.pass_all().await.expect("the reader's pass works");
    assert!(report.writer);
    assert!(report.published.signed >= 1, "{report:?}");
    assert!(report.helper.is_none(), "{report:?}");
    assert!(
        report
            .helper_error
            .as_deref()
            .is_some_and(|e| e.contains("502")),
        "{report:?}"
    );
    sqlx::query("DELETE FROM chain_helper_sends WHERE reader = $1")
        .bind(&id)
        .execute(pool)
        .await
        .expect("clean");
}
