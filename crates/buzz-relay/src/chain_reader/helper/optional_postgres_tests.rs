//! The three optional calls (apply a proposed rate, execute an announced burn,
//! burn after a wind-down) through the helper's real pass against a real
//! database and a fake node: each is sent when due, not sent when not due, and
//! not repeated when it keeps failing; and the bounds that keep a stranger from
//! making the helper pay for calls (per pass, per project and day).
//! Ignored without a migrated database; run with
//! `cargo test -p buzz-relay --lib chain_reader::helper::optional_postgres_tests -- --ignored`.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use buzz_evm_allowance::abi::selector;
use buzz_evm_allowance::Wallet;
use uuid::Uuid;

use super::calls::{self, HelperCall};
use super::plan::Job;
use super::store;
use super::writer::{CallError, ChainWriter, Fees, Receipt, SendError, TxRequest};
use super::{Helper, HelperConfig};
use crate::chain_reader::word::Word;

/// anvil's account 4: a public development key.
const DEV_KEY: &str = "47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a";
const TREASURY: [u8; 20] = [0x22; 20];
const VESTER: [u8; 20] = [0x44; 20];
const UNIT: u128 = 604_800;
const PROJECT: Word = [0x33; 32];

fn word_of(v: u128) -> Vec<u8> {
    let mut w = vec![0u8; 32];
    w[16..].copy_from_slice(&v.to_be_bytes());
    w
}

/// A node answering the views the three calls are checked with, from what the
/// test says the chain looks like.
struct Node {
    wind_kind: u128,
    wind_at: u128,
    pending_at: u128,
    grant_state: u128,
    grant_protected: u128,
    burn_at: u128,
    /// The call itself reverts when asked with `eth_call`.
    call_reverts: bool,
    /// The transaction mines and reverts.
    tx_fails: bool,
    sent: Mutex<Vec<([u8; 20], Vec<u8>)>>,
    /// How many reads of the chain the helper made (`eth_call`).
    views: AtomicUsize,
}

impl Node {
    fn sent(&self) -> Vec<([u8; 20], Vec<u8>)> {
        self.sent.lock().expect("lock").clone()
    }
}

#[async_trait]
impl ChainWriter for Node {
    fn address(&self) -> [u8; 20] {
        [0x11; 20]
    }
    async fn call(&self, _to: &[u8; 20], data: &[u8]) -> Result<Vec<u8>, CallError> {
        self.views.fetch_add(1, Ordering::SeqCst);
        let is = |sig: &str| data.starts_with(selector(sig).as_slice());
        if is("windDownKind()") {
            return Ok(word_of(self.wind_kind));
        }
        if is("windDownAt()") {
            return Ok(word_of(self.wind_at));
        }
        if is("unit()") {
            return Ok(word_of(UNIT));
        }
        if is("pendingAt()") {
            return Ok(word_of(self.pending_at));
        }
        if is("treasury()") {
            let mut w = vec![0u8; 32];
            w[12..].copy_from_slice(&TREASURY);
            return Ok(w);
        }
        if is("grantOf(uint256)") {
            // member, protected, state, burnAt, total, claimed, start, burn
            let mut out = word_of(1);
            for v in [
                self.grant_protected,
                self.grant_state,
                self.burn_at,
                1,
                0,
                0,
                0,
            ] {
                out.extend(word_of(v));
            }
            return Ok(out);
        }
        if is("applyRate()") || is("execute(uint256)") || is("burnAfterWindDown(uint256)") {
            if self.call_reverts {
                return Err(CallError::Reverted("execution reverted".into()));
            }
            return Ok(Vec::new());
        }
        Err(CallError::Unavailable(anyhow::anyhow!("unexpected call")))
    }
    async fn estimate_gas(&self, _to: &[u8; 20], _data: &[u8]) -> Result<u64, CallError> {
        Ok(60_000)
    }
    async fn nonce(&self) -> anyhow::Result<u64> {
        Ok(u64::try_from(self.sent().len())?)
    }
    async fn fees(&self) -> anyhow::Result<Fees> {
        Ok(Fees {
            max_fee_per_gas: 2_000_000_000,
            max_priority_fee_per_gas: 1_000_000_000,
        })
    }
    fn tx_hash(&self, tx: &TxRequest) -> anyhow::Result<Word> {
        let mut hash = [0xab; 32];
        hash[..8].copy_from_slice(&tx.nonce.to_be_bytes());
        Ok(hash)
    }
    async fn send(&self, tx: &TxRequest) -> Result<Word, SendError> {
        self.sent
            .lock()
            .expect("lock")
            .push((tx.to, tx.data.clone()));
        Ok([0xab; 32])
    }
    async fn receipt(&self, hash: &Word) -> anyhow::Result<Option<Receipt>> {
        // The nonce is in the hash: mined once something was sent at it.
        let nonce = usize::try_from(u64::from_be_bytes(hash[..8].try_into()?))?;
        Ok((nonce < self.sent().len()).then_some(Receipt {
            success: !self.tx_fails,
            block: 12,
            gas_used: 50_000,
            effective_gas_price: 1_000_000_000,
        }))
    }
    async fn known(&self, _hash: &Word) -> anyhow::Result<bool> {
        Ok(false)
    }
}

/// One of the three calls, the chain that makes it due and the second the
/// head must have reached for it to be due.
struct Case {
    name: &'static str,
    call: HelperCall,
    due_time: u64,
}

fn cases() -> Vec<Case> {
    let grace = calls::NOTICE_GRACE_SECS;
    let unit = u64::try_from(UNIT).expect("small");
    vec![
        Case {
            name: "applyRate",
            call: HelperCall::TreasuryApplyRate { treasury: TREASURY },
            due_time: 1_000 + unit + grace,
        },
        Case {
            name: "execute",
            call: HelperCall::VesterExecute {
                vester: VESTER,
                grant: 5,
            },
            due_time: 5_000 + grace,
        },
        Case {
            name: "burnAfterWindDown",
            call: HelperCall::VesterBurnAfterWindDown {
                vester: VESTER,
                grant: 6,
            },
            due_time: 2_000 + unit + grace,
        },
    ]
}

/// The chain as it is when `case` is due: a rate pending since second 1,000, a
/// grant announced to burn at second 5,000, a project wound down at second
/// 2,000 holding a live grant.
fn node(call_reverts: bool, tx_fails: bool) -> Arc<Node> {
    Arc::new(Node {
        wind_kind: 0,
        wind_at: 0,
        pending_at: 1_000,
        grant_state: 1,
        grant_protected: 0,
        burn_at: 5_000,
        call_reverts,
        tx_fails,
        sent: Mutex::new(Vec::new()),
        views: AtomicUsize::new(0),
    })
}

/// A chain for the burn after a wind-down (live grant, wound down at 2,000)
/// and for the other two: both are asked with the same node, the views each
/// reads differ, so the node is built for the case.
fn node_for(case: &Case, call_reverts: bool, tx_fails: bool) -> Arc<Node> {
    let base = node(call_reverts, tx_fails);
    let mut n = Arc::try_unwrap(base).unwrap_or_else(|_| unreachable!("one owner"));
    if matches!(case.call, HelperCall::VesterBurnAfterWindDown { .. }) {
        n.wind_kind = 1;
        n.wind_at = 2_000;
        n.grant_state = 0;
    }
    Arc::new(n)
}

fn helper_on(node: &Arc<Node>, max_attempts: u32) -> Helper {
    let wallet = Wallet::from_private_key_hex(DEV_KEY).expect("a key");
    let mut config = HelperConfig::with_key(wallet);
    config.max_attempts = max_attempts;
    Helper::new(node.clone(), config)
}

async fn reader(pool: &sqlx::PgPool) -> String {
    let reader = format!("helper-test:{}", Uuid::new_v4().simple());
    crate::chain_reader::store::ensure_reader(pool, &reader, &[0x01; 20], 0)
        .await
        .expect("reader");
    reader
}

/// Store a job for `call` of `project`; its id.
async fn add_job(pool: &sqlx::PgPool, reader: &str, call: HelperCall, project: Word) -> i64 {
    let key = format!("optional:{}", Uuid::new_v4().simple());
    let job = Job {
        key: key.clone(),
        call,
        project_key: project,
        due_block: 1,
        repeats: false,
    };
    store::upsert_jobs(pool, reader, std::slice::from_ref(&job), 1)
        .await
        .expect("a job");
    sqlx::query_scalar("SELECT id FROM chain_helper_jobs WHERE reader = $1 AND job_key = $2")
        .bind(reader)
        .bind(&key)
        .fetch_one(pool)
        .await
        .expect("its id")
}

fn grant_call(grant: u64) -> HelperCall {
    HelperCall::VesterExecute {
        vester: VESTER,
        grant,
    }
}

async fn skip_the_wait(pool: &sqlx::PgPool, id: i64) {
    sqlx::query("UPDATE chain_helper_jobs SET next_try_at = now() WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await
        .expect("skip the wait");
}

/// Each call is sent when its time has come, and is sent as exactly that call.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn each_optional_call_is_sent_when_due_and_only_that_call() {
    let state = crate::test_support::test_state().await;
    let pool = state.db.pool();
    for case in cases() {
        let reader = reader(pool).await;
        let id = add_job(pool, &reader, case.call.clone(), PROJECT).await;
        let node = node_for(&case, false, false);
        let report = helper_on(&node, 8)
            .pass(pool, &reader, (10, case.due_time), None)
            .await
            .expect("a pass");
        assert_eq!(
            (report.sent, report.done),
            (1, 1),
            "{}: {report:?}",
            case.name
        );
        assert_eq!(
            node.sent(),
            vec![(case.call.target(), case.call.calldata())],
            "{}",
            case.name
        );
        assert_eq!(store::job(pool, id).await.expect("job").state, "done");
    }
}

/// One second before the time (the ten minutes of grace included) nothing is
/// sent and the job is dropped, not failed.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn each_optional_call_is_left_alone_a_second_before_its_time() {
    let state = crate::test_support::test_state().await;
    let pool = state.db.pool();
    for case in cases() {
        let reader = reader(pool).await;
        let id = add_job(pool, &reader, case.call.clone(), PROJECT).await;
        let node = node_for(&case, false, false);
        let report = helper_on(&node, 8)
            .pass(pool, &reader, (10, case.due_time - 1), None)
            .await
            .expect("a pass");
        assert_eq!(
            (report.sent, report.dropped, report.retried),
            (0, 1, 0),
            "{}: {report:?}",
            case.name
        );
        assert!(node.sent().is_empty(), "{}", case.name);
        assert_eq!(store::job(pool, id).await.expect("job").state, "dropped");
    }
}

/// A change to the chain a case is asked about.
type Change = Box<dyn Fn(&mut Node)>;

/// At the head each call is looked at again, and is not sent when the chain
/// says it is no longer the call to make, however old the job is.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_call_is_not_sent_when_the_chain_no_longer_wants_it() {
    let state = crate::test_support::test_state().await;
    let pool = state.db.pool();
    let cases = cases();
    // (case, what changed on the chain, how to say it)
    let changes: Vec<(&Case, &str, Change)> = vec![
        // The project was wound down since the rate was proposed.
        (&cases[0], "wound down", Box::new(|n| n.wind_kind = 1)),
        // Another caller applied it: nothing is pending any more.
        (&cases[0], "applied", Box::new(|n| n.pending_at = 0)),
        // The burn already ran (the grant is closed).
        (&cases[1], "closed", Box::new(|n| n.grant_state = 2)),
        // The grant is not announced (live) at all.
        (&cases[1], "not announced", Box::new(|n| n.grant_state = 0)),
        // The grant was closed by an earlier burn.
        (&cases[2], "closed", Box::new(|n| n.grant_state = 2)),
        // The grant was announced before the wind-down: `execute` is its call.
        (&cases[2], "announced", Box::new(|n| n.grant_state = 1)),
        // The grant is protected.
        (&cases[2], "protected", Box::new(|n| n.grant_protected = 1)),
        // Not wound down.
        (&cases[2], "not wound down", Box::new(|n| n.wind_kind = 0)),
    ];
    for (case, what, change) in changes {
        let reader = reader(pool).await;
        let id = add_job(pool, &reader, case.call.clone(), PROJECT).await;
        let mut n =
            Arc::try_unwrap(node_for(case, false, false)).unwrap_or_else(|_| unreachable!());
        change(&mut n);
        let node = Arc::new(n);
        let report = helper_on(&node, 8)
            .pass(pool, &reader, (10, case.due_time + 1_000_000), None)
            .await
            .expect("a pass");
        assert_eq!(
            (report.sent, report.dropped, report.retried),
            (0, 1, 0),
            "{} ({what}): {report:?}",
            case.name
        );
        assert!(node.sent().is_empty(), "{} ({what})", case.name);
        assert_eq!(store::job(pool, id).await.expect("job").state, "dropped");
    }
}

/// A call that someone else already made (the view says it is due, the call
/// itself says there is nothing left) is dropped, not counted as a failure.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_call_someone_else_made_first_is_dropped_not_failed() {
    struct Raced(Arc<Node>, &'static str);
    #[async_trait]
    impl ChainWriter for Raced {
        fn address(&self) -> [u8; 20] {
            self.0.address()
        }
        async fn call(&self, to: &[u8; 20], data: &[u8]) -> Result<Vec<u8>, CallError> {
            if data.starts_with(selector(&self.1[..self.1.len()]).as_slice()) {
                return Err(CallError::Reverted(format!(
                    "execution reverted, data: \"0x{}\"",
                    hex::encode(selector("WrongState()"))
                )));
            }
            self.0.call(to, data).await
        }
        async fn estimate_gas(&self, to: &[u8; 20], data: &[u8]) -> Result<u64, CallError> {
            self.0.estimate_gas(to, data).await
        }
        async fn nonce(&self) -> anyhow::Result<u64> {
            self.0.nonce().await
        }
        async fn fees(&self) -> anyhow::Result<Fees> {
            self.0.fees().await
        }
        fn tx_hash(&self, tx: &TxRequest) -> anyhow::Result<Word> {
            self.0.tx_hash(tx)
        }
        async fn send(&self, tx: &TxRequest) -> Result<Word, SendError> {
            self.0.send(tx).await
        }
        async fn receipt(&self, hash: &Word) -> anyhow::Result<Option<Receipt>> {
            self.0.receipt(hash).await
        }
        async fn known(&self, hash: &Word) -> anyhow::Result<bool> {
            self.0.known(hash).await
        }
    }
    let state = crate::test_support::test_state().await;
    let pool = state.db.pool();
    let case = &cases()[1];
    let reader = reader(pool).await;
    let id = add_job(pool, &reader, case.call.clone(), PROJECT).await;
    let inner = node_for(case, false, false);
    let wallet = Wallet::from_private_key_hex(DEV_KEY).expect("a key");
    let helper = Helper::new(
        Arc::new(Raced(inner.clone(), "execute(uint256)")),
        HelperConfig::with_key(wallet),
    );
    let report = helper
        .pass(pool, &reader, (10, case.due_time), None)
        .await
        .expect("a pass");
    assert_eq!(
        (report.sent, report.dropped, report.retried),
        (0, 1, 0),
        "{report:?}"
    );
    assert_eq!(store::job(pool, id).await.expect("job").state, "dropped");
}

/// A call that keeps reverting is never sent, counted, and ends `failed` after
/// three attempts although the setting allows eight.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn an_optional_call_that_keeps_reverting_ends_failed_after_three_attempts() {
    let state = crate::test_support::test_state().await;
    let pool = state.db.pool();
    for case in cases() {
        let reader = reader(pool).await;
        let id = add_job(pool, &reader, case.call.clone(), PROJECT).await;
        let node = node_for(&case, true, false);
        let helper = helper_on(&node, 8);
        let head = (10, case.due_time);
        for attempt in 1..=3 {
            let report = helper
                .pass(pool, &reader, head, None)
                .await
                .expect("a pass");
            assert_eq!(
                report.retried + report.failed,
                1,
                "{} attempt {attempt}: {report:?}",
                case.name
            );
            assert_eq!(report.failed, u32::from(attempt == 3), "{}", case.name);
            assert_eq!(store::job(pool, id).await.expect("job").attempts, attempt);
            skip_the_wait(pool, id).await;
        }
        let row = store::job(pool, id).await.expect("job");
        assert_eq!(row.state, "failed", "{}", case.name);
        assert!(row.attempts == 3, "{}", case.name);
        assert!(
            node.sent().is_empty(),
            "{}: a reverting call is never sent",
            case.name
        );
        // A failed job is not picked up again, whatever the time.
        let after = helper
            .pass(pool, &reader, head, None)
            .await
            .expect("a pass");
        assert_eq!(
            (after.retried, after.failed, after.sent, after.dropped),
            (0, 0, 0, 0),
            "{}",
            case.name
        );
    }
}

/// A call whose transaction mines and reverts costs gas each time: it is sent
/// three times at most, then the job ends `failed` and nothing more is sent.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn an_optional_call_whose_transaction_keeps_reverting_is_sent_three_times_at_most() {
    let state = crate::test_support::test_state().await;
    let pool = state.db.pool();
    for case in cases() {
        let reader = reader(pool).await;
        let id = add_job(pool, &reader, case.call.clone(), PROJECT).await;
        let node = node_for(&case, false, true);
        let helper = helper_on(&node, 8);
        let head = (10, case.due_time);
        for _ in 0..6 {
            helper
                .pass(pool, &reader, head, None)
                .await
                .expect("a pass");
            skip_the_wait(pool, id).await;
        }
        let row = store::job(pool, id).await.expect("job");
        assert_eq!(row.state, "failed", "{}", case.name);
        assert_eq!(node.sent().len(), 3, "{}", case.name);
    }
}

/// A pass looks at three jobs of these kinds at most; the rest wait for the
/// next pass untouched (no attempt counted, no pause).
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_pass_sends_at_most_three_optional_calls() {
    let state = crate::test_support::test_state().await;
    let pool = state.db.pool();
    let case = &cases()[1];
    let reader = reader(pool).await;
    let mut ids = Vec::new();
    for n in 0..5u8 {
        // Each job its own project, so only the per-pass bound is at work.
        ids.push(add_job(pool, &reader, grant_call(u64::from(n)), [n + 1; 32]).await);
    }
    let node = node_for(case, false, false);
    let helper = helper_on(&node, 8);
    let first = helper
        .pass(pool, &reader, (10, case.due_time), None)
        .await
        .expect("a pass");
    assert_eq!((first.sent, first.done), (3, 3), "{first:?}");
    let mut left = 0;
    for id in &ids {
        let row = store::job(pool, *id).await.expect("job");
        if row.state == "pending" {
            left += 1;
            assert_eq!(row.attempts, 0);
        }
    }
    assert_eq!(left, 2);
    let second = helper
        .pass(pool, &reader, (10, case.due_time), None)
        .await
        .expect("a pass");
    assert_eq!((second.sent, second.done), (2, 2), "{second:?}");
}

/// One project gets eight of these calls in a day however many jobs it has:
/// the rest are put off (not failed) and another project is not held back.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn one_project_gets_at_most_eight_optional_calls_a_day() {
    let state = crate::test_support::test_state().await;
    let pool = state.db.pool();
    let case = &cases()[1];
    let reader = reader(pool).await;
    let mut ids = Vec::new();
    for n in 0..11u64 {
        ids.push(add_job(pool, &reader, grant_call(n), PROJECT).await);
    }
    let node = node_for(case, false, false);
    let helper = helper_on(&node, 8);
    let head = (10, case.due_time);
    // Three a pass: 3, 3, 2 are sent; then the cap holds the rest back.
    let mut sent = 0;
    for _ in 0..4 {
        sent += helper
            .pass(pool, &reader, head, None)
            .await
            .expect("a pass")
            .sent;
        for id in &ids {
            skip_the_wait(pool, *id).await;
        }
    }
    assert_eq!(sent, calls::OPTIONAL_PER_PROJECT_PER_DAY as u32);
    assert_eq!(node.sent().len(), 8);
    let mut waiting = 0;
    for id in &ids {
        let row = store::job(pool, *id).await.expect("job");
        if row.state == "pending" {
            waiting += 1;
            assert_eq!(row.attempts, 0, "held back, not failed");
            assert!(
                row.last_error_text(pool).await.contains("for the day"),
                "the reason is recorded"
            );
        }
    }
    assert_eq!(waiting, 3);
    // Another project is not held back by this one's cap.
    let other = add_job(pool, &reader, grant_call(99), [0x77; 32]).await;
    let report = helper
        .pass(pool, &reader, head, None)
        .await
        .expect("a pass");
    assert_eq!(report.sent, 1, "{report:?}");
    assert_eq!(store::job(pool, other).await.expect("job").state, "done");
}

/// The fee and the settle are not held to any of this: they are sent past the
/// project's count of optional calls.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn the_first_two_calls_are_not_held_to_the_optional_bounds() {
    let state = crate::test_support::test_state().await;
    let pool = state.db.pool();
    let reader = reader(pool).await;
    // Eight optional sends already for the project.
    let case = &cases()[1];
    for n in 0..8u64 {
        add_job(pool, &reader, grant_call(n), PROJECT).await;
    }
    let node = node_for(case, false, false);
    let helper = helper_on(&node, 8);
    for _ in 0..3 {
        helper
            .pass(pool, &reader, (10, case.due_time), None)
            .await
            .expect("a pass");
    }
    assert_eq!(node.sent().len(), 8);
    let settle = add_job(
        pool,
        &reader,
        HelperCall::TreasurySettleTasks {
            treasury: TREASURY,
            expiry: 1_000,
        },
        PROJECT,
    )
    .await;
    // nextExpiry() is not answered by this node: the job is put off by the node,
    // which proves it was looked at, not held back by the project's count.
    let report = helper
        .pass(pool, &reader, (10, case.due_time), None)
        .await
        .expect("a pass");
    assert_eq!(report.node_errors, 1, "{report:?}");
    assert!(store::job(pool, settle).await.expect("job").attempts == 0);
}

/// Strangers' projects can make the optional calls due in numbers; together they
/// may use only their own slice of the day's caps, and the settle (which returns
/// a task's money) is still looked at afterwards, not put off for the day.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn the_optional_calls_together_keep_to_their_own_slice_of_the_day() {
    let state = crate::test_support::test_state().await;
    let pool = state.db.pool();
    let case = &cases()[1];
    let reader = reader(pool).await;
    // Twelve projects, each with one due burn: the per-project cap is nowhere near.
    let mut ids = Vec::new();
    for n in 0..12u64 {
        let mut project = [0x50; 32];
        project[0] = u8::try_from(n).expect("small");
        ids.push(add_job(pool, &reader, grant_call(n), project).await);
    }
    let node = node_for(case, false, false);
    // 1,000,000 gas a day: the optional slice (20%) is 200,000, the routine share 500,000.
    let wallet = Wallet::from_private_key_hex(DEV_KEY).expect("a key");
    let mut config = HelperConfig::with_key(wallet);
    config.daily_gas = 1_000_000;
    let helper = Helper::new(node.clone(), config);
    let head = (10, case.due_time);
    let mut sent = 0;
    for _ in 0..5 {
        sent += helper
            .pass(pool, &reader, head, None)
            .await
            .expect("a pass")
            .sent;
        for id in &ids {
            skip_the_wait(pool, *id).await;
        }
    }
    // Each send reserves its gas limit (60,000 estimated, plus a fifth and
    // 10,000: 82,000) and uses 50,000 when mined. Two fit one pass (82,000,
    // 164,000), the third would reach 246,000 and waits; once those mine
    // (100,000 used) a third fits (182,000), and from 150,000 used the next
    // would reach 232,000, over the slice of 200,000. Exactly three: with the
    // check that reserves the call's gas limit off, a fourth goes out.
    assert_eq!(sent, 3, "the slice lets exactly three through");
    assert_eq!(node.sent().len(), sent as usize);
    let mut waiting = 0;
    for id in &ids {
        let row = store::job(pool, *id).await.expect("job");
        if row.state == "pending" {
            waiting += 1;
            assert_eq!(row.attempts, 0, "held back, not failed");
        }
    }
    assert_eq!(waiting, 12 - sent as usize);
    // The settle is not held back by what the optional calls used: it is looked
    // at (this node does not answer its view, so the node puts it off).
    let settle = add_job(
        pool,
        &reader,
        HelperCall::TreasurySettleTasks {
            treasury: TREASURY,
            expiry: 1_000,
        },
        PROJECT,
    )
    .await;
    let report = helper
        .pass(pool, &reader, head, None)
        .await
        .expect("a pass");
    assert_eq!(report.node_errors, 1, "{report:?}");
    assert_eq!(store::job(pool, settle).await.expect("job").attempts, 0);
}

/// A slice used up exactly is looked at before the node is asked anything: a
/// stranger's due calls cost the helper no reads once the slice is gone, and
/// the jobs wait without a failed attempt.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_used_up_slice_puts_the_call_off_before_the_node_is_asked() {
    let state = crate::test_support::test_state().await;
    let pool = state.db.pool();
    let case = &cases()[1];
    let reader = reader(pool).await;
    // An earlier optional send of today that used the whole slice (20% of
    // 1,000,000 gas).
    let earlier = add_job(pool, &reader, grant_call(100), [0x61; 32]).await;
    let hash = [0xcd; 32];
    store::record_send(
        pool,
        &reader,
        store::SendRow {
            job_id: earlier,
            tx_hash: &hash,
            nonce: 0,
            gas_limit: 200_000,
            max_fee_per_gas: 2_000_000_000,
            max_priority_fee_per_gas: 1_000_000_000,
        },
        &serde_json::json!({}),
    )
    .await
    .expect("a send");
    store::settle_send(pool, &reader, &hash, 200_000, 200_000_000_000_000)
        .await
        .expect("settled");
    let due = add_job(pool, &reader, grant_call(101), [0x62; 32]).await;
    let node = node_for(case, false, false);
    let wallet = Wallet::from_private_key_hex(DEV_KEY).expect("a key");
    let mut config = HelperConfig::with_key(wallet);
    config.daily_gas = 1_000_000;
    let helper = Helper::new(node.clone(), config);
    let report = helper
        .pass(pool, &reader, (10, case.due_time), None)
        .await
        .expect("a pass");
    assert_eq!(report.sent, 0, "{report:?}");
    assert_eq!(report.postponed, 1, "{report:?}");
    assert_eq!(node.views.load(Ordering::SeqCst), 0, "no read of the chain");
    let row = store::job(pool, due).await.expect("job");
    assert_eq!((row.state.as_str(), row.attempts), ("pending", 0));
    assert!(row
        .last_error_text(pool)
        .await
        .contains("optional calls' share"));
}

impl store::JobRow {
    /// The job's recorded reason (tests).
    async fn last_error_text(&self, pool: &sqlx::PgPool) -> String {
        sqlx::query_scalar::<_, Option<String>>(
            "SELECT last_error FROM chain_helper_jobs WHERE id = $1",
        )
        .bind(self.id)
        .fetch_one(pool)
        .await
        .expect("a row")
        .unwrap_or_default()
    }
}
