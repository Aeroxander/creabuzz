//! The helper's pass against a real database and a fake node: what it does
//! with a job whose call reverts because there is nothing left to do.
//! Ignored without a migrated database; run with
//! `cargo test -p buzz-relay --lib chain_reader::helper::postgres_tests -- --ignored`.

use std::sync::Arc;

use async_trait::async_trait;
use buzz_evm_allowance::abi::selector;
use buzz_evm_allowance::Wallet;
use uuid::Uuid;

use super::calls::HelperCall;
use super::plan::Job;
use super::store;
use super::writer::{CallError, ChainWriter, Fees, Receipt, SendError, TxRequest};
use super::{Helper, HelperConfig};
use crate::chain_reader::word::Word;

/// anvil's account 4: a public development key.
const DEV_KEY: &str = "47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a";

/// A node where the Treasury shows a fee owed, but the call to collect it
/// reverts with `NothingToPay()` (another caller collected it first).
struct FeeAlreadyCollected;

#[async_trait]
impl ChainWriter for FeeAlreadyCollected {
    fn address(&self) -> [u8; 20] {
        [0x11; 20]
    }
    async fn call(&self, _to: &[u8; 20], data: &[u8]) -> Result<Vec<u8>, CallError> {
        if data == selector("feesOwed()").as_slice() {
            let mut word = vec![0u8; 32];
            word[31] = 1;
            return Ok(word);
        }
        if data == selector("collectFees()").as_slice() {
            return Err(CallError::Reverted(format!(
                "execution reverted, data: \"0x{}\"",
                hex::encode(selector("NothingToPay()"))
            )));
        }
        Err(CallError::Unavailable(anyhow::anyhow!("unexpected call")))
    }
    async fn estimate_gas(&self, _to: &[u8; 20], _data: &[u8]) -> Result<u64, CallError> {
        Err(CallError::Unavailable(anyhow::anyhow!("not asked")))
    }
    async fn nonce(&self) -> anyhow::Result<u64> {
        anyhow::bail!("not asked")
    }
    async fn fees(&self) -> anyhow::Result<Fees> {
        anyhow::bail!("not asked")
    }
    fn tx_hash(&self, _tx: &TxRequest) -> anyhow::Result<Word> {
        anyhow::bail!("not asked")
    }
    async fn send(&self, _tx: &TxRequest) -> Result<Word, SendError> {
        Err(SendError::Rejected("nothing may be sent".into()))
    }
    async fn receipt(&self, _hash: &Word) -> anyhow::Result<Option<Receipt>> {
        Ok(None)
    }
    async fn known(&self, _hash: &Word) -> anyhow::Result<bool> {
        Ok(false)
    }
}

/// Two collectors race for the platform's fee; the loser's call reverts with
/// "nothing to pay". The job is dropped, not counted as a failed attempt (it
/// would be tried again and again until it failed for good).
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_fee_collected_by_someone_else_drops_the_job_without_a_failed_attempt() {
    let state = crate::test_support::test_state().await;
    let pool = state.db.pool();
    let reader = format!("helper-test:{}", Uuid::new_v4().simple());
    crate::chain_reader::store::ensure_reader(pool, &reader, &[0x01; 20], 0)
        .await
        .expect("reader");
    let treasury = [0x22; 20];
    let job = Job {
        key: format!("fees:{}", Uuid::new_v4().simple()),
        call: HelperCall::TreasuryCollectFees { treasury },
        project_key: [0x33; 32],
        due_block: 1,
        repeats: true,
    };
    store::upsert_jobs(pool, &reader, std::slice::from_ref(&job), 1)
        .await
        .expect("a job");
    let wallet = Wallet::from_private_key_hex(DEV_KEY).expect("a key");
    let helper = Helper::new(
        Arc::new(FeeAlreadyCollected),
        HelperConfig::with_key(wallet),
    );

    let report = helper
        .pass(pool, &reader, (10, 1_000), None)
        .await
        .expect("a pass");
    assert_eq!(report.dropped, 1, "{report:?}");
    assert_eq!(report.retried, 0, "{report:?}");
    assert_eq!(report.sent, 0, "{report:?}");
}

/// A node where the Treasury's `nextExpiry()` says `next_expiry`, `settle()`
/// either works or reverts, and everything the helper sends is remembered.
struct TaskNode {
    next_expiry: u128,
    settle_reverts: bool,
    sent: std::sync::Mutex<Vec<([u8; 20], Vec<u8>)>>,
}

impl TaskNode {
    fn new(next_expiry: u128, settle_reverts: bool) -> Arc<Self> {
        Arc::new(Self {
            next_expiry,
            settle_reverts,
            sent: std::sync::Mutex::new(Vec::new()),
        })
    }

    fn sent(&self) -> Vec<([u8; 20], Vec<u8>)> {
        self.sent.lock().expect("lock").clone()
    }
}

#[async_trait]
impl ChainWriter for TaskNode {
    fn address(&self) -> [u8; 20] {
        [0x11; 20]
    }
    async fn call(&self, _to: &[u8; 20], data: &[u8]) -> Result<Vec<u8>, CallError> {
        if data == selector("nextExpiry()").as_slice() {
            let mut word = vec![0u8; 32];
            word[16..].copy_from_slice(&self.next_expiry.to_be_bytes());
            return Ok(word);
        }
        if data == selector("settle()").as_slice() {
            if self.settle_reverts {
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
        hash[0] = u8::try_from(tx.nonce % 200)?;
        Ok(hash)
    }
    async fn send(&self, tx: &TxRequest) -> Result<Word, SendError> {
        self.sent
            .lock()
            .expect("lock")
            .push((tx.to, tx.data.clone()));
        Ok([0xab; 32])
    }
    async fn receipt(&self, _hash: &Word) -> anyhow::Result<Option<Receipt>> {
        Ok((!self.sent().is_empty()).then_some(Receipt {
            success: true,
            block: 12,
            gas_used: 50_000,
            effective_gas_price: 1_000_000_000,
        }))
    }
    async fn known(&self, _hash: &Word) -> anyhow::Result<bool> {
        Ok(false)
    }
}

const TASK_TREASURY: [u8; 20] = [0x22; 20];
const EXPIRY: u64 = 1_000;

/// A new reader with one task-settle job in it; its id.
async fn task_job(pool: &sqlx::PgPool) -> (String, i64) {
    let reader = format!("helper-test:{}", Uuid::new_v4().simple());
    crate::chain_reader::store::ensure_reader(pool, &reader, &[0x01; 20], 0)
        .await
        .expect("reader");
    let job = Job {
        key: format!("settle-task:{}:{EXPIRY}", Uuid::new_v4().simple()),
        call: HelperCall::TreasurySettleTasks {
            treasury: TASK_TREASURY,
            expiry: EXPIRY,
        },
        project_key: [0x33; 32],
        due_block: 1,
        repeats: false,
    };
    store::upsert_jobs(pool, &reader, std::slice::from_ref(&job), 1)
        .await
        .expect("a job");
    let id = store::due_jobs(pool, &reader, 10)
        .await
        .expect("jobs")
        .first()
        .expect("the job")
        .id;
    (reader, id)
}

fn helper_on(node: &Arc<TaskNode>, max_attempts: u32) -> Helper {
    let wallet = Wallet::from_private_key_hex(DEV_KEY).expect("a key");
    let mut config = HelperConfig::with_key(wallet);
    config.max_attempts = max_attempts;
    Helper::new(node.clone(), config)
}

/// Ten minutes after a task ran out and nobody settled, the helper sends
/// `settle()` to the Treasury, and exactly that: no other call, no argument.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_task_that_ran_out_is_settled_with_a_plain_settle() {
    let state = crate::test_support::test_state().await;
    let pool = state.db.pool();
    let (reader, id) = task_job(pool).await;
    let node = TaskNode::new(u128::from(EXPIRY), false);
    let helper = helper_on(&node, 8);
    let report = helper
        .pass(pool, &reader, (10, EXPIRY + 600), None)
        .await
        .expect("a pass");
    assert_eq!((report.sent, report.done), (1, 1), "{report:?}");
    assert_eq!(
        node.sent(),
        vec![(TASK_TREASURY, selector("settle()").to_vec())]
    );
    assert_eq!(store::job(pool, id).await.expect("job").state, "done");
}

/// Nine minutes and 59 seconds after: the holders' own time is not cut short.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_task_that_ran_out_a_second_short_of_ten_minutes_ago_is_left_alone() {
    let state = crate::test_support::test_state().await;
    let pool = state.db.pool();
    let (reader, id) = task_job(pool).await;
    let node = TaskNode::new(u128::from(EXPIRY), false);
    let report = helper_on(&node, 8)
        .pass(pool, &reader, (10, EXPIRY + 599), None)
        .await
        .expect("a pass");
    assert_eq!((report.sent, report.dropped), (0, 1), "{report:?}");
    assert!(node.sent().is_empty());
    assert_eq!(store::job(pool, id).await.expect("job").state, "dropped");
}

/// Someone else settled first (a holder's take-out does): the Treasury has no
/// open task left, so nothing is sent and the job is dropped, not failed.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_task_someone_else_already_returned_is_not_settled_again() {
    let state = crate::test_support::test_state().await;
    let pool = state.db.pool();
    let (reader, id) = task_job(pool).await;
    let node = TaskNode::new(0, false);
    let report = helper_on(&node, 8)
        .pass(pool, &reader, (10, EXPIRY + 3_600), None)
        .await
        .expect("a pass");
    assert_eq!(
        (report.sent, report.dropped, report.retried),
        (0, 1, 0),
        "{report:?}"
    );
    assert!(node.sent().is_empty());
    assert_eq!(store::job(pool, id).await.expect("job").state, "dropped");
}

/// A settle that keeps reverting is tried with a growing pause, counted, and
/// ends `failed` at the limit: never sent, never tried for ever.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_settle_that_keeps_failing_waits_longer_each_time_and_ends_failed() {
    let state = crate::test_support::test_state().await;
    let pool = state.db.pool();
    let (reader, id) = task_job(pool).await;
    let node = TaskNode::new(u128::from(EXPIRY), true);
    let helper = helper_on(&node, 3);
    let head = (10, EXPIRY + 3_600);
    let mut pauses = Vec::new();
    for attempt in 1..=3 {
        let report = helper
            .pass(pool, &reader, head, None)
            .await
            .expect("a pass");
        assert_eq!(report.retried + report.failed, 1, "{report:?}");
        assert_eq!(report.failed, u32::from(attempt == 3), "{report:?}");
        let row = store::job(pool, id).await.expect("job");
        assert_eq!(row.attempts, attempt);
        pauses.push(
            sqlx::query_scalar::<_, f64>(
                "SELECT EXTRACT(EPOCH FROM (next_try_at - now()))::float8 \
                 FROM chain_helper_jobs WHERE id = $1",
            )
            .bind(id)
            .fetch_one(pool)
            .await
            .expect("pause"),
        );
        // Straight away again: the pause holds it back.
        let again = helper
            .pass(pool, &reader, head, None)
            .await
            .expect("a pass");
        assert_eq!(again.retried + again.failed, 0, "{again:?}");
        sqlx::query("UPDATE chain_helper_jobs SET next_try_at = now() WHERE id = $1")
            .bind(id)
            .execute(pool)
            .await
            .expect("skip the wait");
    }
    // The pause after the first failure is about a minute, after the second
    // about two (the third ended the job).
    assert!(pauses[0] > 30.0 && pauses[0] <= 60.0, "{pauses:?}");
    assert!(pauses[1] > 90.0 && pauses[1] <= 120.0, "{pauses:?}");
    let row = store::job(pool, id).await.expect("job");
    assert_eq!(row.state, "failed");
    assert!(node.sent().is_empty(), "a reverting call is never sent");
    // A failed job is not picked up again.
    let after = helper
        .pass(pool, &reader, head, None)
        .await
        .expect("a pass");
    assert_eq!(
        (after.retried, after.failed, after.sent, after.dropped),
        (0, 0, 0, 0)
    );
}
