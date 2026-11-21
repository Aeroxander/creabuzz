//! The job builder: which calls are due, worked out from one project's FINAL
//! logs only (the reader's rows at least the confirmation depth under the
//! head) as of one final block. Pure: no node, no database.
//!
//! A job names the row that made it due (`due_block`), so a rollback past that
//! row deletes it. Whether a due call would still do something is checked
//! again at the head right before it is sent (`super::check`): this builder
//! only says when to look.
//!
//! Six jobs exist, all calls anyone may make:
//! - the platform's fee waiting in a Treasury (`feesOwed`), collected once a
//!   week at most;
//! - outside money that has all arrived but is still stored as arriving: a
//!   settle moves it into the pot;
//! - a task that has run out (the end of a take window, or a deadline) ten
//!   minutes ago and that nobody has settled: a settle returns its money, once
//!   per expiry second (plan 2.7);
//! - a proposed rise of the allowance rate whose wait has ended: applying it
//!   is `Treasury.applyRate()`, once per proposal;
//! - the announced part of a grant whose notice has run: `Vester.execute(id)`,
//!   once per grant;
//! - after a wind-down and one more time unit, a grant that is still live and
//!   not protected: `Vester.burnAfterWindDown(id)`, once per grant.
//!
//! The last three wait [`NOTICE_GRACE_SECS`] after their time (whoever is there
//! has had that time to do it themselves), and a project gets at most
//! [`MAX_GRANT_JOBS_PER_PROJECT`] jobs of each Vester kind in one build.

use anyhow::Context;

use super::calls::{HelperCall, NOTICE_GRACE_SECS, TASK_SETTLE_DELAY_SECS};
use crate::chain_reader::ledger::{GrantState, Ledger, LogRow};
use crate::chain_reader::word::{parse_fixed, Word};

/// One week, the period of the repeating jobs.
pub const WEEK: u64 = 7 * 86_400;

/// The most jobs of each Vester kind (a grant's burn, a grant's burn after a
/// wind-down) one project gets in one build, earliest first.
pub const MAX_GRANT_JOBS_PER_PROJECT: usize = 16;

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

/// The block of the newest row of `event` whose `field` reads `value`.
fn row_block(logs: &[LogRow], event: &str, field: &str, value: u64) -> Option<u64> {
    let want = value.to_string();
    logs.iter()
        .filter(|l| {
            l.event == event
                && l.fields.get(field).and_then(serde_json::Value::as_str) == Some(want.as_str())
        })
        .map(|l| l.block)
        .max()
}

/// The jobs due for one project, from its final logs (oldest first) as of
/// `ctx`.
pub fn plan(key: &Word, logs: &[LogRow], ctx: &PlanContext) -> anyhow::Result<Vec<Job>> {
    let Some(ledger) = Ledger::from_logs(logs)? else {
        return Ok(Vec::new());
    };
    plan_ledger(key, logs, &ledger, ctx)
}

/// The jobs due for one project, from its ledger (built from `logs`).
fn plan_ledger(
    key: &Word,
    logs: &[LogRow],
    ledger: &Ledger,
    ctx: &PlanContext,
) -> anyhow::Result<Vec<Job>> {
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
    // A proposed rise of the rate whose wait has ended. One proposal is
    // pending at a time, so the second it becomes applicable names it.
    if ledger.wind_down.is_none() {
        if let Some(pending) = ledger.pending_rate {
            if ctx.time >= pending.applicable_at.saturating_add(NOTICE_GRACE_SECS) {
                if let Some(due_block) = last_block(logs, "RateProposed") {
                    jobs.push(Job {
                        key: format!(
                            "apply-rate:{}:{}",
                            ledger.contracts.treasury, pending.applicable_at
                        ),
                        call: HelperCall::TreasuryApplyRate { treasury },
                        project_key: *key,
                        due_block,
                        repeats: false,
                    });
                }
            }
        }
    }
    let vester = parse_fixed::<20>(&ledger.contracts.vester).context("the Vester address")?;
    // A grant whose announced burn is due: the earliest first.
    let mut announced: Vec<_> = ledger
        .grants
        .values()
        .filter(|g| {
            g.state == GrantState::Announced
                && ctx.time >= g.burn_at.saturating_add(NOTICE_GRACE_SECS)
        })
        .collect();
    announced.sort_by_key(|g| (g.burn_at, g.id));
    for g in announced.into_iter().take(MAX_GRANT_JOBS_PER_PROJECT) {
        if let Some(due_block) = row_block(logs, "ForfeitAnnounced", "id", g.id) {
            jobs.push(Job {
                key: format!("vester-execute:{}:{}", ledger.contracts.vester, g.id),
                call: HelperCall::VesterExecute {
                    vester,
                    grant: g.id,
                },
                project_key: *key,
                due_block,
                repeats: false,
            });
        }
    }
    // After a wind-down and one more time unit: every grant still live and
    // not protected keeps only part of what was granted. (A grant announced
    // before the wind-down is burned by its own `execute` above.)
    if let Some(wound) = ledger.wind_down {
        if ctx.time
            >= wound
                .at
                .saturating_add(ledger.unit)
                .saturating_add(NOTICE_GRACE_SECS)
        {
            if let Some(due_block) = last_block(logs, "WoundDown") {
                let mut live: Vec<_> = ledger
                    .grants
                    .values()
                    .filter(|g| g.state == GrantState::Live && !g.protected)
                    .collect();
                live.sort_by_key(|g| g.id);
                for g in live.into_iter().take(MAX_GRANT_JOBS_PER_PROJECT) {
                    jobs.push(Job {
                        key: format!("vester-burn:{}:{}", ledger.contracts.vester, g.id),
                        call: HelperCall::VesterBurnAfterWindDown {
                            vester,
                            grant: g.id,
                        },
                        project_key: *key,
                        due_block,
                        repeats: false,
                    });
                }
            }
        }
    }
    Ok(jobs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chain_reader::fixture::Fixture;
    use crate::chain_reader::ledger::Grant;

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
        // At the end of the run the fee was collected: no fee is due (what is
        // left is the burn of a grant the run never closed, project A having
        // been wound down).
        let end = fx.head();
        let jobs = plan(&key, &fx.rows("A", end), &ctx(end, fx.time_of(end))).expect("plans");
        assert!(
            jobs.iter()
                .all(|j| matches!(j.call, HelperCall::VesterBurnAfterWindDown { .. })),
            "{jobs:?}"
        );
        // Project B still owes its fee even though it is wound down.
        let b = fx.projects["B"].key;
        let jobs = plan(&b, &fx.rows("B", end), &ctx(end, fx.time_of(end))).expect("plans");
        let fees = jobs
            .iter()
            .filter(|j| matches!(j.call, HelperCall::TreasuryCollectFees { .. }))
            .count();
        assert_eq!(fees, 1, "{jobs:?}");
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

    /// The jobs of the optional kinds only.
    fn optional_jobs(jobs: &[Job]) -> Vec<&Job> {
        jobs.iter()
            .filter(|j| super::super::calls::is_optional(j.call.name()))
            .collect()
    }

    /// The block of project A's first row of `event` (the run has few).
    fn block_of(fx: &Fixture, event: &str) -> u64 {
        fx.rows("A", fx.head())
            .iter()
            .find(|l| l.event == event)
            .unwrap_or_else(|| panic!("the run has {event}"))
            .block
    }

    #[test]
    fn a_proposed_rate_is_applied_ten_minutes_after_its_wait_and_once() {
        let fx = Fixture::load();
        let key = fx.projects["A"].key;
        let proposed = block_of(&fx, "RateProposed");
        let applied = block_of(&fx, "RateSet");
        // Pending: after the proposal and before the rate was set in the run.
        let rows = fx.rows("A", applied - 1);
        let ledger = Ledger::from_logs(&rows).expect("reads").expect("launched");
        let pending = ledger.pending_rate.expect("a rate is waiting");
        let at = |t: u64| plan(&key, &rows, &ctx(applied - 1, t)).expect("plans");
        // Its wait has ended, but the ten minutes have not: nothing yet.
        let early = at(pending.applicable_at + NOTICE_GRACE_SECS - 1);
        assert!(optional_jobs(&early).is_empty(), "{early:?}");
        // Ten minutes after: one job, named by the second it became applicable.
        let jobs = at(pending.applicable_at + NOTICE_GRACE_SECS);
        let apply: Vec<_> = jobs
            .iter()
            .filter(|j| matches!(j.call, HelperCall::TreasuryApplyRate { .. }))
            .collect();
        assert_eq!(apply.len(), 1, "{jobs:?}");
        assert_eq!(
            apply[0].key,
            format!(
                "apply-rate:{}:{}",
                ledger.contracts.treasury, pending.applicable_at
            )
        );
        assert_eq!(apply[0].due_block, proposed);
        assert!(!apply[0].repeats);
        // Days later: the same key, so the same job.
        let later = at(pending.applicable_at + 30 * 86_400);
        assert_eq!(later.iter().filter(|j| j.key == apply[0].key).count(), 1);
        // Once the rate is set (the run applies it at the next block) there is
        // nothing to apply, at any time.
        let done = fx.rows("A", applied);
        let jobs = plan(&key, &done, &ctx(applied, pending.applicable_at + 86_400)).expect("plans");
        assert!(
            jobs.iter()
                .all(|j| !matches!(j.call, HelperCall::TreasuryApplyRate { .. })),
            "{jobs:?}"
        );
    }

    #[test]
    fn a_rate_waiting_in_a_wound_down_project_is_not_applied() {
        let fx = Fixture::load();
        let key = fx.projects["A"].key;
        let end = fx.head();
        let rows = fx.rows("A", end);
        let mut ledger = Ledger::from_logs(&rows).expect("reads").expect("launched");
        assert!(ledger.wind_down.is_some(), "project A ends wound down");
        ledger.pending_rate = Some(crate::chain_reader::ledger::PendingRate {
            ppm: 1_500,
            applicable_at: 1,
            proposed_at: 0,
        });
        let jobs = plan_ledger(&key, &rows, &ledger, &ctx(end, u64::MAX / 2)).expect("plans");
        assert!(
            jobs.iter()
                .all(|j| !matches!(j.call, HelperCall::TreasuryApplyRate { .. })),
            "{jobs:?}"
        );
    }

    #[test]
    fn an_announced_burn_is_executed_ten_minutes_after_its_notice_and_once() {
        let fx = Fixture::load();
        let key = fx.projects["A"].key;
        let announced = block_of(&fx, "ForfeitAnnounced");
        let executed = block_of(&fx, "Forfeited");
        let rows = fx.rows("A", executed - 1);
        let ledger = Ledger::from_logs(&rows).expect("reads").expect("launched");
        let grant = ledger
            .grants
            .values()
            .find(|g| g.state == GrantState::Announced)
            .expect("a grant is announced to burn");
        let at = |t: u64| plan(&key, &rows, &ctx(executed - 1, t)).expect("plans");
        let early = at(grant.burn_at + NOTICE_GRACE_SECS - 1);
        assert!(optional_jobs(&early).is_empty(), "{early:?}");
        let jobs = at(grant.burn_at + NOTICE_GRACE_SECS);
        let exec = optional_jobs(&jobs);
        assert_eq!(exec.len(), 1, "{jobs:?}");
        let vester = parse_fixed::<20>(&ledger.contracts.vester).expect("address");
        assert_eq!(
            exec[0].call,
            HelperCall::VesterExecute {
                vester,
                grant: grant.id
            }
        );
        assert_eq!(
            exec[0].key,
            format!("vester-execute:{}:{}", ledger.contracts.vester, grant.id)
        );
        assert_eq!(exec[0].due_block, announced);
        assert!(!exec[0].repeats);
        // Burned in the run: no job at any time.
        let done = fx.rows("A", executed);
        let jobs = plan(&key, &done, &ctx(executed, u64::MAX / 2)).expect("plans");
        assert!(
            jobs.iter()
                .all(|j| !matches!(j.call, HelperCall::VesterExecute { .. })),
            "{jobs:?}"
        );
    }

    #[test]
    fn after_a_wind_down_and_a_unit_each_live_grant_gets_one_burn_job() {
        let fx = Fixture::load();
        let key = fx.projects["A"].key;
        let wound = block_of(&fx, "WoundDown");
        let first_burn = fx
            .rows("A", fx.head())
            .iter()
            .filter(|l| l.event == "Forfeited" && l.block > wound)
            .map(|l| l.block)
            .min()
            .expect("the run burns after the wind-down");
        let rows = fx.rows("A", first_burn - 1);
        let ledger = Ledger::from_logs(&rows).expect("reads").expect("launched");
        let w = ledger.wind_down.expect("wound down");
        let live: Vec<u64> = ledger
            .grants
            .values()
            .filter(|g| g.state == GrantState::Live && !g.protected)
            .map(|g| g.id)
            .collect();
        assert!(live.len() >= 2, "the run leaves live grants: {live:?}");
        let at = |t: u64| plan(&key, &rows, &ctx(first_burn - 1, t)).expect("plans");
        // A unit after the wind-down, but not the ten minutes: nothing yet.
        let early = at(w.at + ledger.unit + NOTICE_GRACE_SECS - 1);
        assert!(optional_jobs(&early).is_empty(), "{early:?}");
        let jobs = at(w.at + ledger.unit + NOTICE_GRACE_SECS);
        let burns = optional_jobs(&jobs);
        let ids: Vec<u64> = burns
            .iter()
            .map(|j| match j.call {
                HelperCall::VesterBurnAfterWindDown { grant, .. } => grant,
                _ => panic!("only burns are due: {j:?}"),
            })
            .collect();
        assert_eq!(ids, live, "one job per live grant, in id order");
        assert!(burns
            .iter()
            .all(|j| j.due_block == wound && !j.repeats && j.key.contains("vester-burn:")));
        // Once some burned in the run, only the grants still live are named:
        // a burned grant (closed) never gets a job again.
        let done = fx.rows("A", fx.head());
        let end = Ledger::from_logs(&done).expect("reads").expect("launched");
        let still: Vec<u64> = end
            .grants
            .values()
            .filter(|g| g.state == GrantState::Live && !g.protected)
            .map(|g| g.id)
            .collect();
        assert!(still.len() < live.len(), "the run burned some: {still:?}");
        let jobs = plan(&key, &done, &ctx(fx.head(), u64::MAX / 2)).expect("plans");
        let ids: Vec<u64> = optional_jobs(&jobs)
            .iter()
            .filter_map(|j| match j.call {
                HelperCall::VesterBurnAfterWindDown { grant, .. } => Some(grant),
                _ => None,
            })
            .collect();
        assert_eq!(ids, still);
    }

    #[test]
    fn a_grant_that_is_protected_announced_or_in_a_live_project_gets_no_burn_job() {
        let fx = Fixture::load();
        let key = fx.projects["A"].key;
        let end = fx.head();
        let rows = fx.rows("A", end);
        let mut ledger = Ledger::from_logs(&rows).expect("reads").expect("launched");
        let far = u64::MAX / 2;
        let template = ledger.grants.values().next().expect("a grant").clone();
        let add = |ledger: &mut Ledger, id: u64, state: GrantState, protected: bool| {
            ledger.grants.insert(
                id,
                Grant {
                    id,
                    state,
                    protected,
                    ..template.clone()
                },
            );
        };
        ledger.grants.clear();
        add(&mut ledger, 1_001, GrantState::Live, true);
        add(&mut ledger, 1_002, GrantState::Live, false);
        add(&mut ledger, 1_003, GrantState::Announced, false);
        add(&mut ledger, 1_004, GrantState::Closed, false);
        let jobs = plan_ledger(&key, &rows, &ledger, &ctx(end, far)).expect("plans");
        let ids: Vec<u64> = optional_jobs(&jobs)
            .iter()
            .filter_map(|j| match j.call {
                HelperCall::VesterBurnAfterWindDown { grant, .. } => Some(grant),
                _ => None,
            })
            .collect();
        assert_eq!(
            ids,
            vec![1_002],
            "a protected, an announced and a closed grant are never burned after a wind-down"
        );
        // Without a wind-down there is no burn after one, at any time.
        ledger.wind_down = None;
        let jobs = plan_ledger(&key, &rows, &ledger, &ctx(end, far)).expect("plans");
        assert!(
            optional_jobs(&jobs)
                .iter()
                .all(|j| !matches!(j.call, HelperCall::VesterBurnAfterWindDown { .. })),
            "{jobs:?}"
        );
    }

    #[test]
    fn one_project_gets_a_bounded_number_of_grant_jobs_earliest_first() {
        let fx = Fixture::load();
        let key = fx.projects["A"].key;
        let end = fx.head();
        let rows = fx.rows("A", end);
        let mut ledger = Ledger::from_logs(&rows).expect("reads").expect("launched");
        let template = ledger.grants.values().next().expect("a grant").clone();
        ledger.grants.clear();
        // A row for every announcement, as the chain has (the run's own, with
        // the grant's id changed).
        let announce = rows
            .iter()
            .find(|l| l.event == "ForfeitAnnounced")
            .expect("the run announces a burn")
            .clone();
        let many = u64::try_from(MAX_GRANT_JOBS_PER_PROJECT).expect("small") * 3;
        for id in 0..many {
            // Live ones for the burn after the wind-down; announced ones for the
            // execute, the later ids with the later times.
            ledger.grants.insert(
                id,
                Grant {
                    id,
                    state: if id % 2 == 0 {
                        GrantState::Live
                    } else {
                        GrantState::Announced
                    },
                    protected: false,
                    burn_at: 1_000 + id,
                    ..template.clone()
                },
            );
        }
        let mut rows = rows;
        for id in 0..many {
            let mut row = announce.clone();
            row.fields["id"] = serde_json::Value::String(id.to_string());
            rows.push(row);
        }
        let jobs = plan_ledger(&key, &rows, &ledger, &ctx(end, u64::MAX / 2)).expect("plans");
        let count = |f: fn(&HelperCall) -> bool| jobs.iter().filter(|j| f(&j.call)).count();
        assert_eq!(
            count(|c| matches!(c, HelperCall::VesterExecute { .. })),
            MAX_GRANT_JOBS_PER_PROJECT
        );
        assert_eq!(
            count(|c| matches!(c, HelperCall::VesterBurnAfterWindDown { .. })),
            MAX_GRANT_JOBS_PER_PROJECT
        );
        // The earliest announced burns come first.
        let first: Vec<u64> = jobs
            .iter()
            .filter_map(|j| match j.call {
                HelperCall::VesterExecute { grant, .. } => Some(grant),
                _ => None,
            })
            .collect();
        assert_eq!(first[..3], [1, 3, 5]);
    }
}
