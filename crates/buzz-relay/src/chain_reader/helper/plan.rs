//! The job builder: which calls are due, worked out from one project's FINAL
//! logs only (the reader's rows at least the confirmation depth under the
//! head) as of one final block. Pure: no node, no database.
//!
//! A job names the row that made it due (`due_block`), so a rollback past that
//! row deletes it. Whether a due call would still do something is checked
//! again at the head right before it is sent (`super::check`): this builder
//! only says when to look.
//!
//! Three jobs exist, all calls anyone may make:
//! - the platform's fee waiting in a Treasury (`feesOwed`), collected once a
//!   week at most;
//! - outside money that has all arrived but is still stored as arriving: a
//!   settle moves it into the pot;
//! - a task that has run out (the end of a take window, or a deadline) ten
//!   minutes ago and that nobody has settled: a settle returns its money, once
//!   per expiry second (plan 2.7).

use anyhow::Context;

use super::calls::{HelperCall, TASK_SETTLE_DELAY_SECS};
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
    // The earliest open task whose time ran out ten minutes ago. One settle
    // returns every task that is due, so one job per project and expiry
    // second is enough; when it is done the next overdue one gets its own.
    let overdue = ledger
        .tasks
        .open()
        .filter(|k| k.expires_at.saturating_add(TASK_SETTLE_DELAY_SECS) <= ctx.time)
        .min_by_key(|k| (k.expires_at, k.serial));
    if let Some(task) = overdue {
        // The row that fixed the second it runs out: its announcement, or
        // its take when that moved the end to the deadline.
        let due_block = logs
            .iter()
            .filter(|l| {
                matches!(l.event.as_str(), "TaskAnnounced" | "TaskTaken")
                    && l.fields.get("serial").and_then(serde_json::Value::as_str)
                        == Some(task.serial.to_string().as_str())
            })
            .map(|l| l.block)
            .max()
            .with_context(|| format!("no row of task {} in its project's logs", task.serial))?;
        jobs.push(Job {
            key: format!(
                "settle-task:{}:{}",
                ledger.contracts.treasury, task.expires_at
            ),
            call: HelperCall::TreasurySettleTasks {
                treasury,
                expiry: task.expires_at,
            },
            project_key: *key,
            due_block,
            repeats: false,
        });
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

    /// The jobs of the tasks' kind only.
    fn task_jobs(jobs: &[Job]) -> Vec<&Job> {
        jobs.iter()
            .filter(|j| matches!(j.call, HelperCall::TreasurySettleTasks { .. }))
            .collect()
    }

    /// Project A at the block after the run-out task's deadline that no
    /// Treasury call has settled: its rows, its ledger and the earliest second
    /// an open task runs out.
    fn overdue() -> (Fixture, u64, Vec<LogRow>, Ledger, u64) {
        let fx = Fixture::load();
        let block = fx.json["books"]["A_overdue"]["block"]
            .as_u64()
            .expect("block");
        let rows = fx.rows("A", block);
        let ledger = Ledger::from_logs(&rows).expect("reads").expect("launched");
        let first = ledger.tasks.next_expiry().expect("a task is open");
        (fx, block, rows, ledger, first)
    }

    #[test]
    fn a_task_that_ran_out_ten_minutes_ago_gets_one_settle_for_that_second() {
        let (fx, block, rows, ledger, first) = overdue();
        let key = fx.projects["A"].key;
        // Ten minutes less a second after it ran out: nothing yet.
        let early =
            plan(&key, &rows, &ctx(block, first + TASK_SETTLE_DELAY_SECS - 1)).expect("plans");
        assert!(task_jobs(&early).is_empty(), "{early:?}");
        // Ten minutes after: one job, for that second, once.
        let jobs = plan(&key, &rows, &ctx(block, first + TASK_SETTLE_DELAY_SECS)).expect("plans");
        let tasks = task_jobs(&jobs);
        assert_eq!(tasks.len(), 1, "{jobs:?}");
        let job = tasks[0];
        let treasury = parse_fixed::<20>(&ledger.contracts.treasury).expect("address");
        assert_eq!(
            job.call,
            HelperCall::TreasurySettleTasks {
                treasury,
                expiry: first
            }
        );
        assert_eq!(
            job.key,
            format!("settle-task:{}:{first}", ledger.contracts.treasury)
        );
        assert!(!job.repeats, "a settle is looked at again, not repeated");
        // It names the row that fixed that second (the task's take or its
        // announcement), and that row is at or before the block.
        let serial = ledger
            .tasks
            .open()
            .find(|k| k.expires_at == first)
            .expect("the task")
            .serial
            .to_string();
        let row_block = rows
            .iter()
            .filter(|l| {
                matches!(l.event.as_str(), "TaskAnnounced" | "TaskTaken")
                    && l.fields["serial"].as_str() == Some(serial.as_str())
            })
            .map(|l| l.block)
            .max()
            .expect("its rows");
        assert_eq!(job.due_block, row_block);
        assert!(job.due_block <= block);
        // Days later nothing changes: the same key, so the same job.
        let later = plan(&key, &rows, &ctx(block, first + 30 * 86_400)).expect("plans");
        assert_eq!(task_jobs(&later).len(), 1);
        assert_eq!(task_jobs(&later)[0].key, job.key);
    }

    #[test]
    fn it_is_the_earliest_task_that_runs_out_and_a_settle_ends_the_job() {
        let (fx, block, rows, ledger, first) = overdue();
        let key = fx.projects["A"].key;
        // Every open task is long past: still one job, for the earliest second.
        let far = ledger
            .tasks
            .open()
            .map(|k| k.expires_at)
            .max()
            .expect("open")
            + 86_400;
        let jobs = plan(&key, &rows, &ctx(block, far)).expect("plans");
        let tasks = task_jobs(&jobs);
        assert_eq!(tasks.len(), 1, "{jobs:?}");
        assert!(tasks[0].key.ends_with(&format!(":{first}")));
        // The settle that returned that task (a holder's take-out in the run) is
        // a final row: its time is no longer a time that ran out.
        let serial = ledger
            .tasks
            .open()
            .find(|k| k.expires_at == first)
            .expect("the task")
            .serial
            .to_string();
        let resolved = fx
            .rows("A", fx.head())
            .into_iter()
            .find(|l| {
                l.event == "TaskResolved"
                    && l.block > block
                    && l.fields["serial"].as_str() == Some(serial.as_str())
            })
            .expect("the run returns it");
        let after = fx.rows("A", resolved.block);
        let jobs = plan(
            &key,
            &after,
            &ctx(resolved.block, first + TASK_SETTLE_DELAY_SECS),
        )
        .expect("plans");
        assert!(
            task_jobs(&jobs)
                .iter()
                .all(|j| !j.key.ends_with(&format!(":{first}"))),
            "{jobs:?}"
        );
        // A project with no task open has no such job at any time.
        let end = fx.head();
        let jobs = plan(&key, &fx.rows("A", end), &ctx(end, u64::MAX / 2)).expect("plans");
        assert!(task_jobs(&jobs).is_empty(), "{jobs:?}");
    }
}
