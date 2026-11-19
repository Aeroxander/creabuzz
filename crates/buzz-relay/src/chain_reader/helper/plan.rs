//! The job builder: which calls are due, worked out from one project's FINAL
//! logs only (the reader's rows at least the confirmation depth under the
//! head) as of one final block. Pure: no node, no database.
//!
//! A job names the row that made it due (`due_block`), so a rollback past that
//! row deletes it. Whether a due call would still do something is checked
//! again at the head right before it is sent (`super::check`): this builder
//! only says when to look.
//!
//! Two jobs exist, both calls anyone may make:
//! - the platform's fee waiting in a Treasury (`feesOwed`), collected once a
//!   week at most;
//! - outside money that has all arrived but is still stored as arriving: a
//!   settle moves it into the pot.

use anyhow::Context;

use super::calls::HelperCall;
use crate::chain_reader::ledger::{Ledger, LogRow};
use crate::chain_reader::word::{parse_fixed, Word};

/// One week, the period of the repeating jobs.
pub const WEEK: u64 = 7 * 86_400;

/// A call that is due, and why.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Job {
    /// Unique per reader: the call, its target, its arguments and, for a
    /// repeating call, its period.
    pub key: String,
    /// The call.
    pub call: HelperCall,
    /// The project.
    pub project_key: Word,
    /// The final block of the row that made it due.
    pub due_block: u64,
    /// A repeating call (the weekly fee collection): "nothing to do" ends this
    /// period's job for good. A one-off call (a settle) is looked at again if
    /// its effect has not reached the final rows by the time they pass the
    /// block where it was seen.
    pub repeats: bool,
}

/// What the builder needs besides the logs.
#[derive(Clone, Debug)]
pub struct PlanContext {
    /// The newest final block.
    pub block: u64,
    /// Its time.
    pub time: u64,
}

fn last_block(logs: &[LogRow], event: &str) -> Option<u64> {
    logs.iter()
        .filter(|l| l.event == event)
        .map(|l| l.block)
        .max()
}

/// The jobs due for one project, from its final logs (oldest first) as of
/// `ctx`.
pub fn plan(key: &Word, logs: &[LogRow], ctx: &PlanContext) -> anyhow::Result<Vec<Job>> {
    let Some(ledger) = Ledger::from_logs(logs)? else {
        return Ok(Vec::new());
    };
    let treasury = parse_fixed::<20>(&ledger.contracts.treasury).context("the Treasury address")?;
    let mut jobs = Vec::new();
    if ledger.fees_owed > 0 {
        if let Some(due_block) = last_block(logs, "Joined") {
            jobs.push(Job {
                key: format!("fees:{}:{}", ledger.contracts.treasury, ctx.time / WEEK),
                call: HelperCall::TreasuryCollectFees { treasury },
                project_key: *key,
                due_block,
                repeats: true,
            });
        }
    }
    if ledger.arriving > 0
        && ledger.arrival_end != 0
        && ctx.time >= ledger.arrival_end
        && ledger.wind_down.is_none()
    {
        if let Some(due_block) = last_block(logs, "RevenueAdded") {
            jobs.push(Job {
                key: format!(
                    "settle:{}:{}",
                    ledger.contracts.treasury, ledger.arrival_end
                ),
                call: HelperCall::TreasurySettle { treasury },
                project_key: *key,
                due_block,
                repeats: false,
            });
        }
    }
    Ok(jobs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chain_reader::fixture::Fixture;

    fn ctx(block: u64, time: u64) -> PlanContext {
        PlanContext { block, time }
    }

    #[test]
    fn a_fee_waiting_is_collected_once_a_week_and_only_when_there_is_one() {
        let fx = Fixture::load();
        let key = fx.projects["A"].key;
        // The live moment of project A: fees from two joins are owed.
        let block = fx.json["books"]["A_live"]["block"].as_u64().expect("block");
        let rows = fx.rows("A", block);
        let jobs = plan(&key, &rows, &ctx(block, fx.time_of(block))).expect("plans");
        assert_eq!(jobs.len(), 1, "{jobs:?}");
        assert!(matches!(
            jobs[0].call,
            HelperCall::TreasuryCollectFees { .. }
        ));
        assert!(jobs[0].repeats);
        assert!(jobs[0]
            .key
            .ends_with(&format!(":{}", fx.time_of(block) / WEEK)));
        // The row that made it due is a join at or before the block.
        assert!(jobs[0].due_block <= block);
        // Another week, another job; the same week, the same key.
        let later = plan(&key, &rows, &ctx(block, fx.time_of(block) + WEEK)).expect("plans");
        assert_ne!(later[0].key, jobs[0].key);
        // At the end of the run the fee was collected: nothing is due.
        let end = fx.head();
        let jobs = plan(&key, &fx.rows("A", end), &ctx(end, fx.time_of(end))).expect("plans");
        assert!(jobs.is_empty(), "{jobs:?}");
        // Project B still owes its fee even though it is wound down.
        let b = fx.projects["B"].key;
        let jobs = plan(&b, &fx.rows("B", end), &ctx(end, fx.time_of(end))).expect("plans");
        assert_eq!(jobs.len(), 1);
    }

    #[test]
    fn outside_money_that_has_all_arrived_is_settled() {
        let fx = Fixture::load();
        let key = fx.projects["A"].key;
        let block = fx.json["books"]["A_live"]["block"].as_u64().expect("block");
        let rows = fx.rows("A", block);
        let ledger = Ledger::from_logs(&rows).expect("reads").expect("launched");
        assert!(ledger.arriving > 0 && ledger.arrival_end > fx.time_of(block));
        let before = plan(&key, &rows, &ctx(block, ledger.arrival_end - 1)).expect("plans");
        assert!(before
            .iter()
            .all(|j| !matches!(j.call, HelperCall::TreasurySettle { .. })));
        let after = plan(&key, &rows, &ctx(block, ledger.arrival_end)).expect("plans");
        let settle: Vec<_> = after
            .iter()
            .filter(|j| matches!(j.call, HelperCall::TreasurySettle { .. }))
            .collect();
        assert_eq!(settle.len(), 1);
        assert!(!settle[0].repeats);
    }
}
