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
        call: HelperCall::TreasurySweepFees { treasury },
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
