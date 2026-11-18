//! The helper job (plan v2 section 8, milestone 5 part 2): sends the calls
//! anyone may make so that rounds close, Shares are delivered, sales finish
//! and fees are collected with nobody pressing.
//!
//! - **What:** a closed list of calls ([`calls::HelperCall`]); never a
//!   backer's held Shares, a refund, a check-in, anything a runner or a Pair
//!   signs, or anything that moves a person's money by choice.
//! - **When:** jobs are built only from the reader's final rows
//!   ([`plan::plan`]) and dropped when a rollback removes the row that made
//!   them due. Right before sending, each job is checked again at the head:
//!   with the contract's views (a call that would do nothing is never sent),
//!   then with `eth_call` and `eth_estimateGas` from the helper's address.
//! - **How:** one relay-held key (`BUZZ_CHAIN_HELPER_KEY`, off by default),
//!   one transaction in flight at a time with its nonce read from `latest`,
//!   a daily gas and spend cap counted from every broadcast (reserved until
//!   mined), a growing pause after each failed attempt and a terminal
//!   `failed` state after the limit. Only the replica holding the writer lock
//!   runs it (see `ChainReader::pass`).

pub mod calls;
pub mod plan;
pub mod settings;
pub mod store;
pub mod writer;

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Context};
use buzz_evm_allowance::abi::selector;
use sqlx::PgPool;

pub use settings::HelperConfig;

use calls::HelperCall;
use plan::{PlanContext, Position};
use store::{JobRow, SendRow};
use writer::{CallError, ChainWriter, Fees, Receipt, SendError, TxRequest};

use super::word::{hex0x, word_to_u128, Word};

/// Jobs checked per pass at most.
pub const JOBS_PER_PASS: usize = 10;
/// The longest pause between attempts of one job.
pub const MAX_PAUSE_SECS: f64 = 6.0 * 3_600.0;
/// The first pause after a failed attempt; it doubles with each attempt.
pub const FIRST_PAUSE_SECS: f64 = 60.0;
/// The pause when a daily cap or an empty balance stops a send.
pub const CAP_PAUSE_SECS: f64 = 3_600.0;
/// `EarlierBackers.CHALLENGE`: no delivery inside 21 days of a consent.
pub const CHALLENGE_SECS: u64 = 21 * 86_400;

/// What one helper pass did.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct HelperReport {
    /// Jobs added (or reopened) by the builder.
    pub built: u64,
    /// Transactions broadcast (replacements included).
    pub sent: u32,
    /// Jobs whose transaction mined and succeeded.
    pub done: u32,
    /// Jobs with nothing to do at the head.
    pub dropped: u32,
    /// Failed attempts (the job waits, then tries again).
    pub retried: u32,
    /// Jobs that reached the attempt limit or cannot be read back.
    pub failed: u32,
    /// Jobs put off without an attempt (a daily cap, the balance).
    pub postponed: u32,
    /// Sent transactions that vanished; their jobs are checked again.
    pub returned: u32,
    /// Stuck transactions replaced at the same nonce with a higher fee.
    pub replaced: u32,
    /// A transaction is still in flight at the end of the pass.
    pub in_flight: bool,
}

/// The helper of one reader.
pub struct Helper {
    writer: Arc<dyn ChainWriter>,
    config: HelperConfig,
    last_build: AtomicI64,
}

enum Check {
    /// Send this (the job's call, maybe with fewer backers or entries).
    Due(HelperCall),
    /// Nothing to do now.
    Nothing(String),
}

enum Outcome {
    /// Go on with the next job.
    Next,
    /// Stop the pass (a transaction in flight, or a cap reached).
    Stop,
}

fn word(data: &[u8], index: usize) -> Option<Word> {
    data.get(index * 32..index * 32 + 32)
        .and_then(|s| <[u8; 32]>::try_from(s).ok())
}

fn is_zero_word(data: &[u8], index: usize) -> bool {
    word(data, index).is_none_or(|w| w == [0u8; 32])
}

fn uint(data: &[u8], index: usize) -> anyhow::Result<u128> {
    word(data, index)
        .and_then(|w| word_to_u128(&w))
        .ok_or_else(|| anyhow!("view answer too short or too large"))
}

fn view(signature: &str, args: &[Word]) -> Vec<u8> {
    let mut out = selector(signature).to_vec();
    for a in args {
        out.extend_from_slice(a);
    }
    out
}

fn uint_arg(v: u64) -> Word {
    let mut w = [0u8; 32];
    w[24..].copy_from_slice(&v.to_be_bytes());
    w
}

fn addr_arg(a: &[u8; 20]) -> Word {
    let mut w = [0u8; 32];
    w[12..].copy_from_slice(a);
    w
}

fn pause_after(attempts: i32) -> f64 {
    let n = attempts.clamp(0, 30);
    (FIRST_PAUSE_SECS * 2f64.powi(n)).min(MAX_PAUSE_SECS)
}

fn short(text: &str) -> String {
    text.chars().take(400).collect()
}

impl Helper {
    /// A helper writing through `writer`.
    pub fn new(writer: Arc<dyn ChainWriter>, config: HelperConfig) -> Self {
        Self {
            writer,
            config,
            last_build: AtomicI64::new(i64::MIN),
        }
    }

    /// The helper's address.
    pub fn address(&self) -> [u8; 20] {
        self.writer.address()
    }

    /// One pass. `head` is the chain's newest block and its time; `final_block`
    /// the newest final block and its time when the reader has read it (jobs
    /// are built only then).
    pub async fn pass(
        &self,
        pool: &PgPool,
        reader: &str,
        head: (u64, u64),
        final_block: Option<(u64, u64)>,
        positions: &[(Word, Position)],
    ) -> anyhow::Result<HelperReport> {
        let mut report = HelperReport::default();
        let now = chrono::Utc::now().timestamp();
        if let Some((block, time)) = final_block {
            let every = i64::try_from(self.config.build_every_secs).unwrap_or(i64::MAX);
            if now.saturating_sub(self.last_build.load(Ordering::Relaxed)) >= every {
                report.built = self.build(pool, reader, block, time, positions).await?;
                store::prune(pool, reader).await?;
                self.last_build.store(now, Ordering::Relaxed);
            }
        }

        // At most one transaction in flight: settle it first.
        for job in store::in_flight(pool, reader).await? {
            if let Outcome::Stop = self.resolve(pool, reader, &job, &mut report).await? {
                report.in_flight = true;
                return Ok(report);
            }
        }

        let mut due = store::due_jobs(pool, reader, 200).await?;
        due.sort_by_key(|j| {
            let priority = calls::HelperCall::parse(&j.call, j.target, &j.args)
                .map(|c| c.priority())
                .unwrap_or(0);
            (priority, j.id)
        });
        due.truncate(JOBS_PER_PASS);
        for job in due {
            if let Outcome::Stop = self.run(pool, reader, &job, head, &mut report).await? {
                break;
            }
        }
        Ok(report)
    }

    async fn build(
        &self,
        pool: &PgPool,
        reader: &str,
        block: u64,
        time: u64,
        positions: &[(Word, Position)],
    ) -> anyhow::Result<u64> {
        let ctx = PlanContext {
            block,
            time,
            batch: self.config.batch,
        };
        let mut jobs = Vec::new();
        for (key, _) in super::store::final_projects(pool, reader, block).await? {
            let logs = super::store::project_logs(pool, reader, &key, block).await?;
            let own: Vec<Position> = positions
                .iter()
                .filter(|(k, _)| *k == key)
                .map(|(_, p)| p.clone())
                .collect();
            match plan::plan(&key, &logs, &own, &ctx) {
                Ok(mut more) => jobs.append(&mut more),
                Err(e) => {
                    tracing::error!(project = %hex0x(&key), "chain helper: jobs not built: {e:#}")
                }
            }
        }
        store::upsert_jobs(pool, reader, &jobs, block).await
    }

    async fn view_uint(
        &self,
        target: &[u8; 20],
        data: Vec<u8>,
        index: usize,
    ) -> anyhow::Result<u128> {
        match self.writer.call(target, &data).await {
            Ok(answer) => uint(&answer, index),
            Err(CallError::Reverted(d)) => Err(anyhow!("a view reverted: {}", short(&d))),
            Err(CallError::Unavailable(e)) => Err(e),
        }
    }

    /// Whether the call would still do something at the head, read from the
    /// contracts' views; batches lose the backers and entries that would make
    /// them revert.
    async fn check(&self, call: HelperCall, head_time: u64) -> anyhow::Result<Check> {
        let target = call.target();
        let positive = |v: u128, what: &str| {
            if v > 0 {
                Check::Due(call.clone())
            } else {
                Check::Nothing(format!("{what} is zero at the head"))
            }
        };
        Ok(match &call {
            HelperCall::RoundsSettleMany {
                rounds,
                round,
                backers,
            } => {
                let mut keep = Vec::new();
                for b in backers {
                    let pos = view(
                        "positionOf(uint256,address)",
                        &[uint_arg(*round), addr_arg(b)],
                    );
                    let answer = match self.writer.call(rounds, &pos).await {
                        Ok(a) => a,
                        Err(CallError::Reverted(d)) => {
                            anyhow::bail!("positionOf reverted: {}", short(&d))
                        }
                        Err(CallError::Unavailable(e)) => return Err(e),
                    };
                    // Position { ask, held, bought, settled }: only an
                    // unsettled backer with an ask can be settled.
                    if !is_zero_word(&answer, 0) && is_zero_word(&answer, 3) {
                        keep.push(*b);
                    }
                }
                if keep.is_empty() {
                    Check::Nothing("every backer in the batch is settled or has no ask".into())
                } else {
                    Check::Due(HelperCall::RoundsSettleMany {
                        rounds: *rounds,
                        round: *round,
                        backers: keep,
                    })
                }
            }
            HelperCall::RoundsRelease { round, .. } => positive(
                self.view_uint(&target, view("releasable(uint256)", &[uint_arg(*round)]), 0)
                    .await?,
                "releasable",
            ),
            HelperCall::RoundsReturnUnsold { .. } => positive(
                self.view_uint(&target, view("unsold()", &[]), 0).await?,
                "unsold",
            ),
            HelperCall::RoundsSweepFees { .. } => positive(
                self.view_uint(&target, view("platformOwed()", &[]), 0)
                    .await?,
                "platformOwed",
            ),
            HelperCall::TreasurySweepFees { .. } => positive(
                self.view_uint(&target, view("feesOwed()", &[]), 0).await?,
                "feesOwed",
            ),
            HelperCall::TreasuryRelease { .. } => positive(
                self.view_uint(&target, view("pendingRelease()", &[]), 0)
                    .await?,
                "pendingRelease",
            ),
            HelperCall::VesterClaim { beneficiary, .. } => positive(
                self.view_uint(
                    &target,
                    view("claimable(address)", &[addr_arg(beneficiary)]),
                    0,
                )
                .await?,
                "claimable",
            ),
            HelperCall::EarlierDeliverMany { claim, entries } => {
                let count = self.view_uint(claim, view("entryCount()", &[]), 0).await?;
                let hold = self
                    .view_uint(claim, view("minHoldFromConsent()", &[]), 0)
                    .await?;
                let wait = u64::try_from(hold).unwrap_or(u64::MAX).max(CHALLENGE_SECS);
                let mut keep = Vec::new();
                for &e in entries.iter().filter(|e| u128::from(**e) < count) {
                    // Entry { holder, holderVersion, consentAt, ... }: open
                    // entries and entries inside their wait would revert the
                    // whole batch (EarlierBackers review O1).
                    let consent_at = self
                        .view_uint(claim, view("entryOf(uint256)", &[uint_arg(e)]), 2)
                        .await?;
                    let consent_at = u64::try_from(consent_at).unwrap_or(u64::MAX);
                    if consent_at == 0 || head_time < consent_at.saturating_add(wait) {
                        continue;
                    }
                    if self
                        .view_uint(claim, view("due(uint256)", &[uint_arg(e)]), 0)
                        .await?
                        > 0
                    {
                        keep.push(e);
                    }
                }
                if keep.is_empty() {
                    Check::Nothing("no agreed entry has Shares due".into())
                } else {
                    Check::Due(HelperCall::EarlierDeliverMany {
                        claim: *claim,
                        entries: keep,
                    })
                }
            }
            // A revert or the call's own answer decides these.
            HelperCall::RoundsClose { .. }
            | HelperCall::FinisherOpenPool { .. }
            | HelperCall::FinisherSettle { .. }
            | HelperCall::FinisherSweep { .. }
            | HelperCall::FinisherAbandon { .. }
            | HelperCall::HolderCollect { .. } => Check::Due(call.clone()),
        })
    }

    async fn retry(
        &self,
        pool: &PgPool,
        job: &JobRow,
        error: &str,
        report: &mut HelperReport,
    ) -> anyhow::Result<()> {
        let ended = store::mark_retry(
            pool,
            job.id,
            error,
            pause_after(job.attempts),
            self.config.max_attempts,
        )
        .await?;
        if ended {
            report.failed += 1;
            metrics::counter!("buzz_chain_helper_failed_total", "call" => job.call.clone())
                .increment(1);
            tracing::error!(job = %job.key, attempts = job.attempts + 1, "chain helper: job failed for good: {error}");
        } else {
            report.retried += 1;
            tracing::warn!(job = %job.key, attempts = job.attempts + 1, "chain helper: attempt failed: {error}");
        }
        Ok(())
    }

    /// Check one due job at the head and send it.
    async fn run(
        &self,
        pool: &PgPool,
        reader: &str,
        job: &JobRow,
        head: (u64, u64),
        report: &mut HelperReport,
    ) -> anyhow::Result<Outcome> {
        let call = match HelperCall::parse(&job.call, job.target, &job.args) {
            Ok(call) => call,
            Err(e) => {
                store::mark_failed(pool, job.id, &format!("cannot be sent: {e:#}")).await?;
                report.failed += 1;
                metrics::counter!("buzz_chain_helper_failed_total", "call" => "unknown")
                    .increment(1);
                tracing::error!(job = %job.key, "chain helper: stored job cannot be read: {e:#}");
                return Ok(Outcome::Next);
            }
        };
        let call = match self.check(call, head.1).await {
            Ok(Check::Due(call)) => call,
            Ok(Check::Nothing(reason)) => {
                store::mark_dropped(pool, job.id, &reason, head.0).await?;
                report.dropped += 1;
                return Ok(Outcome::Next);
            }
            Err(e) => {
                // A view that reverts is the job's problem; a node that does
                // not answer is not (the pass fails and nothing is counted).
                if e.to_string().contains("reverted") {
                    self.retry(pool, job, &format!("{e:#}"), report).await?;
                    return Ok(Outcome::Next);
                }
                return Err(e);
            }
        };
        let target = call.target();
        let data = call.calldata();

        // The call itself, from the helper's address, at the head.
        match self.writer.call(&target, &data).await {
            Err(CallError::Reverted(detail)) => {
                let lower = detail.to_ascii_lowercase();
                if let Some(name) = call
                    .nothing_to_do_errors()
                    .iter()
                    .find(|e| lower.contains(&hex::encode(selector(e))))
                {
                    store::mark_dropped(pool, job.id, &format!("nothing to do: {name}"), head.0)
                        .await?;
                    report.dropped += 1;
                } else {
                    self.retry(
                        pool,
                        job,
                        &format!("the call would revert: {}", short(&detail)),
                        report,
                    )
                    .await?;
                }
                return Ok(Outcome::Next);
            }
            Err(CallError::Unavailable(e)) => return Err(e.context("eth_call")),
            Ok(answer) => {
                let nothing = match &call {
                    HelperCall::FinisherOpenPool { .. }
                    | HelperCall::FinisherSettle { .. }
                    | HelperCall::FinisherSweep { .. } => {
                        is_zero_word(&answer, 0).then_some("the step answers false")
                    }
                    HelperCall::HolderCollect { .. } => (is_zero_word(&answer, 0)
                        && is_zero_word(&answer, 1))
                    .then_some("no fees to collect"),
                    HelperCall::RoundsRelease { .. } | HelperCall::VesterClaim { .. } => {
                        is_zero_word(&answer, 0).then_some("the call would move nothing")
                    }
                    _ => None,
                };
                if let Some(reason) = nothing {
                    store::mark_dropped(pool, job.id, reason, head.0).await?;
                    report.dropped += 1;
                    return Ok(Outcome::Next);
                }
            }
        }
        let estimate = match self.writer.estimate_gas(&target, &data).await {
            Ok(g) => g,
            Err(CallError::Reverted(d)) => {
                self.retry(
                    pool,
                    job,
                    &format!("gas estimate reverted: {}", short(&d)),
                    report,
                )
                .await?;
                return Ok(Outcome::Next);
            }
            Err(CallError::Unavailable(e)) => return Err(e.context("eth_estimateGas")),
        };
        let gas_limit = estimate.saturating_add(estimate / 5).saturating_add(10_000);
        if gas_limit > self.config.call_gas_cap {
            self.retry(
                pool,
                job,
                &format!(
                    "needs {gas_limit} gas, over the cap of {}",
                    self.config.call_gas_cap
                ),
                report,
            )
            .await?;
            return Ok(Outcome::Next);
        }
        let fees = self.writer.fees().await.context("fees")?;
        if let Some(reason) = self
            .over_cap(pool, reader, gas_limit, fees.max_fee_per_gas)
            .await?
        {
            store::postpone(pool, job.id, &reason, CAP_PAUSE_SECS).await?;
            report.postponed += 1;
            tracing::warn!(job = %job.key, "chain helper: {reason}; put off");
            return Ok(Outcome::Stop);
        }
        let nonce = self.writer.nonce().await.context("nonce")?;
        let tx = TxRequest {
            to: target,
            data,
            nonce,
            gas_limit,
            fees,
        };
        self.broadcast(pool, reader, job, &call, tx, report).await
    }

    /// `None` when `gas` at `fee` fits today's caps, else why not.
    async fn over_cap(
        &self,
        pool: &PgPool,
        reader: &str,
        gas: u64,
        fee: u128,
    ) -> anyhow::Result<Option<String>> {
        let (used_gas, used_wei) = store::used_last_day(pool, reader).await?;
        let reserve = u128::from(gas).saturating_mul(fee);
        if used_gas.saturating_add(u128::from(gas)) > self.config.daily_gas {
            return Ok(Some(format!(
                "the daily gas cap ({}) is reached: {used_gas} used, {gas} more needed",
                self.config.daily_gas
            )));
        }
        if used_wei.saturating_add(reserve) > self.config.daily_spend_wei {
            return Ok(Some(format!(
                "the daily spend cap ({} wei) is reached: {used_wei} used, {reserve} more reserved",
                self.config.daily_spend_wei
            )));
        }
        Ok(None)
    }

    /// Remember, broadcast, and wait a little for the receipt.
    async fn broadcast(
        &self,
        pool: &PgPool,
        reader: &str,
        job: &JobRow,
        call: &HelperCall,
        tx: TxRequest,
        report: &mut HelperReport,
    ) -> anyhow::Result<Outcome> {
        let hash = self.writer.tx_hash(&tx)?;
        store::record_send(
            pool,
            reader,
            SendRow {
                job_id: job.id,
                tx_hash: &hash,
                nonce: tx.nonce,
                gas_limit: tx.gas_limit,
                max_fee_per_gas: tx.fees.max_fee_per_gas,
                max_priority_fee_per_gas: tx.fees.max_priority_fee_per_gas,
            },
            &call.args(),
        )
        .await?;
        match self.writer.send(&tx).await {
            Ok(_) => {
                report.sent += 1;
                tracing::info!(job = %job.key, tx = %hex0x(&hash), nonce = tx.nonce, "chain helper: sent");
            }
            Err(SendError::Rejected(detail)) => {
                store::void_send(pool, reader, &hash).await?;
                if detail.to_ascii_lowercase().contains("insufficient funds") {
                    store::postpone(
                        pool,
                        job.id,
                        "the helper's balance is too low",
                        CAP_PAUSE_SECS,
                    )
                    .await?;
                    report.postponed += 1;
                    tracing::error!(address = %hex0x(&self.address()), "chain helper: balance too low to send");
                    return Ok(Outcome::Stop);
                }
                self.retry(
                    pool,
                    job,
                    &format!("the node refused it: {}", short(&detail)),
                    report,
                )
                .await?;
                return Ok(Outcome::Next);
            }
            Err(SendError::Uncertain(detail)) => {
                // It may be in flight: the next pass looks for it.
                tracing::warn!(job = %job.key, "chain helper: no clear answer to the send: {detail}");
                return Ok(Outcome::Stop);
            }
        }
        let job = store::job(pool, job.id).await?;
        let mut waited = 0;
        loop {
            if let Some(r) = self.writer.receipt(&hash).await? {
                self.finish(pool, reader, &job, &hash, r, report).await?;
                return Ok(Outcome::Next);
            }
            if waited >= self.config.wait_secs {
                break;
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
            waited += 1;
        }
        Ok(Outcome::Stop)
    }

    async fn finish(
        &self,
        pool: &PgPool,
        reader: &str,
        job: &JobRow,
        hash: &Word,
        r: Receipt,
        report: &mut HelperReport,
    ) -> anyhow::Result<()> {
        store::settle_send(
            pool,
            reader,
            hash,
            r.gas_used,
            u128::from(r.gas_used).saturating_mul(r.effective_gas_price),
        )
        .await?;
        if r.success {
            store::mark_done(pool, job.id, r.block).await?;
            report.done += 1;
            tracing::info!(job = %job.key, tx = %hex0x(hash), block = r.block, "chain helper: done");
        } else {
            self.retry(
                pool,
                job,
                &format!("the transaction reverted in block {}", r.block),
                report,
            )
            .await?;
        }
        Ok(())
    }

    /// Settle the job whose transaction is in flight: mined, vanished, used up
    /// by another transaction, or stuck (replaced with a higher fee).
    async fn resolve(
        &self,
        pool: &PgPool,
        reader: &str,
        job: &JobRow,
        report: &mut HelperReport,
    ) -> anyhow::Result<Outcome> {
        let Some(nonce) = job.nonce else {
            store::back_to_pending(pool, job.id, "sent without a nonce").await?;
            report.returned += 1;
            return Ok(Outcome::Next);
        };
        let sends = store::sends_at_nonce(pool, reader, job.id, nonce).await?;
        for s in &sends {
            if let Some(r) = self.writer.receipt(&s.tx_hash).await? {
                for other in sends.iter().filter(|o| o.tx_hash != s.tx_hash) {
                    store::void_send(pool, reader, &other.tx_hash).await?;
                }
                self.finish(pool, reader, job, &s.tx_hash, r, report)
                    .await?;
                return Ok(Outcome::Next);
            }
        }
        let latest = self.writer.nonce().await?;
        let mut known = false;
        for s in &sends {
            if self.writer.known(&s.tx_hash).await? {
                known = true;
                break;
            }
        }
        if latest > nonce || !known {
            // The nonce was used by another transaction, or the node no longer
            // has ours (a rollback, a dropped mempool): nothing of ours will
            // mine at this nonce. The job is checked again at the head.
            for s in &sends {
                store::void_send(pool, reader, &s.tx_hash).await?;
            }
            let why = if latest > nonce {
                "another transaction used the nonce"
            } else {
                "the transaction vanished"
            };
            store::back_to_pending(pool, job.id, why).await?;
            report.returned += 1;
            tracing::warn!(job = %job.key, nonce, "chain helper: {why}; checking the job again");
            return Ok(Outcome::Next);
        }
        let stuck = job
            .sent_secs_ago
            .is_some_and(|s| s >= self.config.stuck_after_secs as f64);
        let Some(newest) = sends.first() else {
            return Ok(Outcome::Stop);
        };
        if !stuck {
            return Ok(Outcome::Stop);
        }
        // Replace at the same nonce, both fee caps up by at least a quarter.
        let now = self.writer.fees().await?;
        let bump = |old: u128| old.saturating_add(old / 4).saturating_add(1);
        let fees = Fees {
            max_fee_per_gas: now.max_fee_per_gas.max(bump(newest.max_fee_per_gas)),
            max_priority_fee_per_gas: now
                .max_priority_fee_per_gas
                .max(bump(newest.max_priority_fee_per_gas)),
        };
        let call = HelperCall::parse(&job.call, job.target, &job.args)?;
        if let Some(reason) = self
            .over_cap(pool, reader, newest.gas_limit, fees.max_fee_per_gas)
            .await?
        {
            tracing::warn!(job = %job.key, "chain helper: stuck transaction not replaced: {reason}");
            report.postponed += 1;
            return Ok(Outcome::Stop);
        }
        let tx = TxRequest {
            to: call.target(),
            data: call.calldata(),
            nonce,
            gas_limit: newest.gas_limit,
            fees,
        };
        // Sent first and remembered after: a refused replacement leaves the
        // first transaction in flight, still tracked.
        match self.writer.send(&tx).await {
            Ok(hash) => {
                store::record_send(
                    pool,
                    reader,
                    SendRow {
                        job_id: job.id,
                        tx_hash: &hash,
                        nonce,
                        gas_limit: tx.gas_limit,
                        max_fee_per_gas: fees.max_fee_per_gas,
                        max_priority_fee_per_gas: fees.max_priority_fee_per_gas,
                    },
                    &job.args,
                )
                .await?;
                report.sent += 1;
                report.replaced += 1;
                tracing::warn!(job = %job.key, nonce, tx = %hex0x(&hash), "chain helper: stuck transaction replaced with a higher fee");
            }
            Err(e) => {
                tracing::warn!(job = %job.key, nonce, "chain helper: replacement not sent: {e:?}");
            }
        }
        Ok(Outcome::Stop)
    }
}

#[cfg(test)]
#[path = "helper_postgres_tests.rs"]
mod helper_postgres_tests;
