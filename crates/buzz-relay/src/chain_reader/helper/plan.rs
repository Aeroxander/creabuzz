//! The job builder: which calls are due, worked out from one project's FINAL
//! logs only (the reader's rows at least the confirmation depth under the
//! head) as of one final block. Pure: no node, no database.
//!
//! A job names the row that made it due (`due_block`), so a rollback past that
//! row deletes it. Whether a due call would still do something is checked
//! again at the head right before it is sent (`super::check`): this builder
//! only says when to look.
//!
//! Ten jobs exist, all calls anyone may make:
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
//! And the Council round's four vote calls (`COUNCIL-PLAN.md` section 5.5),
//! each anyone may make and none moving money: the seat election the Council
//! says is due (`HolderVote.openSeats()`, when `nextElection` has passed, no
//! ballot is live and the Council exists), the result of a ballot whose vote
//! has ended (`finish(id)`), a won result whose wait has run (`carryOut(id)`),
//! and a won result nobody carried out two time units after it was due
//! (`lapse(id)`). **The helper never opens a replace vote**: that is a
//! holder's press, and `openReplace` is not a call it can build. The planner
//! reads the ballot's own result first (a recorded `BallotFinished`, else the
//! frozen tallies) and makes at most the one vote job the ballot's state
//! allows; the helper reads the contract's `canCarryOut` and `canOpenSeats`
//! views at the head before anything is sent.
//!
//! The last three wait [`NOTICE_GRACE_SECS`] after their time (whoever is there
//! has had that time to do it themselves), and a project gets at most
//! [`MAX_GRANT_JOBS_PER_PROJECT`] jobs of each Vester kind in one build.
//!
//! The vote jobs are held to their own pace: once per project per
//! [`VOTE_PACE_SECS`] or a quarter of the stand window when that is smaller
//! ([`vote_pace_secs`]), at most [`VOTE_PER_PROJECT_PER_DAY`] a day for one
//! project, and at most [`VOTE_JOBS_PER_PASS`] looked at in one pass over all
//! projects.

use anyhow::Context;

use super::calls::{HelperCall, NOTICE_GRACE_SECS, TASK_SETTLE_DELAY_SECS};
use crate::chain_reader::ledger::{GrantState, Ledger, LogRow};
use crate::chain_reader::ledger_council::BallotSeen;
use crate::chain_reader::record_council::derive_result;
use crate::chain_reader::word::{parse_fixed, Word};

/// One week, the period of the repeating jobs.
pub const WEEK: u64 = 7 * 86_400;

/// The most jobs of each Vester kind (a grant's burn, a grant's burn after a
/// wind-down) one project gets in one build, earliest first.
pub const MAX_GRANT_JOBS_PER_PROJECT: usize = 16;

/// The helper's own pace for one project's vote calls, in seconds (ten
/// minutes); a quarter of the stand window when that is smaller
/// ([`vote_pace_secs`]).
pub const VOTE_PACE_SECS: u64 = 600;

/// The most vote jobs one pass looks at, over all projects (`COUNCIL-PLAN.md`
/// section 5.5).
pub const VOTE_JOBS_PER_PASS: usize = 3;

/// The most transactions of the vote calls the helper sends for one project in
/// any 24 hours.
pub const VOTE_PER_PROJECT_PER_DAY: i64 = 6;

/// How many time units after a won result's effective time it may still be
/// carried out, and when a won result nobody carried out lapses
/// (`HolderVote.LAPSE_UNITS`).
pub const LAPSE_UNITS: u64 = 2;

/// One whole Share in wei (`HolderVote.MIN_VOTE`), the smallest tally a person
/// needs to take a seat (the same value `record_council` holds).
const ONE_SHARE: u128 = 1_000_000_000_000_000_000;

/// The helper's pace for one project's vote calls, in seconds, from the
/// project's day (`HolderVote.day()`, a seventh of the time unit): ten minutes,
/// or a quarter of the stand window when that is smaller (`standSecs/4`,
/// COUNCIL-PLAN.md section 5.5 and V27). A day of zero (not a vote contract)
/// keeps the ten minutes.
pub fn vote_pace_secs_of_day(day: u64) -> u64 {
    if day == 0 {
        return VOTE_PACE_SECS;
    }
    VOTE_PACE_SECS.min(day / 4)
}

/// The same from the project's time unit (the planner's own number: a day is
/// a seventh of the unit).
pub fn vote_pace_secs(unit: u64) -> u64 {
    vote_pace_secs_of_day(unit / 7)
}

/// The result a ballot's events give from `voteEnd` on: the recorded
/// `BallotFinished` when there is one, else the frozen tallies (the contract's
/// own `_compute`, `derive_result`). `None` before `voteEnd`.
fn ballot_outcome(ballot: &BallotSeen, now: u64) -> Option<u8> {
    if let Some(finished) = ballot.finished {
        return Some(finished.outcome);
    }
    if now < ballot.vote_end {
        return None;
    }
    let (outcome, _) = derive_result(
        ballot.kind,
        &ballot.tallies,
        ballot.option_count(),
        ballot.cast,
        ballot.floor,
        ONE_SHARE,
    );
    Some(outcome)
}

/// Whether the ballot still blocks a new one (the contract's `_freeSettled`):
/// before its vote ends, or a won result still inside its carry-out window.
/// A landed, lapsed, or ended-without-effect ballot blocks nothing.
fn ballot_blocks(ballot: &BallotSeen, now: u64, unit: u64) -> bool {
    if ballot.carried_out_at.is_some() || ballot.lapsed {
        return false;
    }
    if now < ballot.vote_end {
        return true;
    }
    if !matches!(ballot_outcome(ballot, now), Some(3 | 4)) {
        return false;
    }
    now <= ballot
        .effective_at
        .saturating_add(LAPSE_UNITS.saturating_mul(unit))
}

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
    // The Council round's vote calls (COUNCIL-PLAN.md section 5.5). Only a
    // project whose pause is a vote contract has them: no pause row, no ballot
    // and no Council means no vote job at all.
    if let Some(pause) = &ledger.contracts.pause {
        let vote =
            parse_fixed::<20>(pause).context("the project's vote contract (its pause) address")?;
        let newest = ledger.vote.newest_ballot();
        // The seat election the Council says is due: no ballot may be live
        // (the contract's own `canOpenSeats` is read again at the head).
        if ledger.contracts.council.is_some()
            && ledger.council.next_election != 0
            && ctx.time >= ledger.council.next_election
            && !newest.is_some_and(|b| ballot_blocks(b, ctx.time, ledger.unit))
        {
            let next = ledger.council.next_election;
            if let Some(due_block) = last_block(logs, "SeatsSet") {
                jobs.push(Job {
                    key: format!("vote-open-seats:{}:{next}", pause),
                    call: HelperCall::VoteOpenSeats { vote },
                    project_key: *key,
                    due_block,
                    repeats: false,
                });
            }
        }
        if let Some(ballot) = newest.filter(|b| b.carried_out_at.is_none() && !b.lapsed) {
            // The row that made the ballot: its opening.
            let opened = row_block(logs, "BallotOpened", "id", u64::from(ballot.id));
            if let Some(opened) = opened {
                // The result of a ballot whose vote has ended, once.
                if ballot.finished.is_none() && ctx.time >= ballot.vote_end {
                    jobs.push(Job {
                        key: format!("vote-finish:{}:{}", pause, ballot.id),
                        call: HelperCall::VoteFinish {
                            vote,
                            ballot: ballot.id,
                        },
                        project_key: *key,
                        due_block: opened,
                        repeats: false,
                    });
                }
                // A won result: carried out once its wait has run, or lapsed
                // two time units later if nobody carried it out.
                if let Some(outcome) = ballot_outcome(ballot, ctx.time) {
                    if matches!(outcome, 3 | 4) && ctx.time >= ballot.effective_at {
                        let lapse_at = ballot
                            .effective_at
                            .saturating_add(LAPSE_UNITS.saturating_mul(ledger.unit));
                        if ctx.time > lapse_at {
                            jobs.push(Job {
                                key: format!("vote-lapse:{}:{}", pause, ballot.id),
                                call: HelperCall::VoteLapse {
                                    vote,
                                    ballot: ballot.id,
                                },
                                project_key: *key,
                                due_block: opened,
                                repeats: false,
                            });
                        } else {
                            jobs.push(Job {
                                key: format!("vote-carry-out:{}:{}", pause, ballot.id),
                                call: HelperCall::VoteCarryOut {
                                    vote,
                                    ballot: ballot.id,
                                },
                                project_key: *key,
                                due_block: opened,
                                repeats: false,
                            });
                        }
                    }
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

    // ── the Council round's four vote jobs (COUNCIL-PLAN.md section 5.5) ──

    /// The project's vote contract (its pause) and its Council, as text.
    const VOTE: &str = "0x00000000000000000000000000000000000000aa";
    const COUNCIL: &str = "0x00000000000000000000000000000000000000bb";
    /// The base run's unit is a week; a ballot's `voteEnd` and `effectiveAt`
    /// are picked from it.
    const UNIT: u64 = 7 * 86_400;

    /// The vote contract's address as `VOTE` parses: `0x` and 40 hex digits,
    /// the last two `aa`.
    fn vote_addr() -> [u8; 20] {
        let mut out = [0u8; 20];
        out[19] = 0xaa;
        out
    }

    /// One option on the ballot, as a `Stood` would leave it.
    fn option(
        kind: crate::chain_reader::ledger_council::OptionKind,
    ) -> crate::chain_reader::ledger_council::OptionSeen {
        crate::chain_reader::ledger_council::OptionSeen {
            kind,
            members: Vec::new(),
            proposer: None,
            record_hash: None,
        }
    }

    /// One ballot with everything the planner reads, the given fields left as
    /// the call sets them (opened at 1_000, a day of standing, three of voting).
    fn ballot(id: u32, kind: u8, opened_at: u64) -> BallotSeen {
        let stand_end = opened_at + UNIT / 7;
        BallotSeen {
            id,
            kind,
            opened_at,
            stand_end,
            vote_end: stand_end + 3 * (UNIT / 7),
            effective_at: stand_end + 3 * (UNIT / 7) + 5 * 86_400,
            supply: 1_000 * ONE_SHARE,
            floor: 334 * ONE_SHARE,
            up_a: 0,
            up_b: 1,
            // Option 0 is "keep" and option 1 the list or person: the count
            // and the ranking the contract's `_compute` walks (`optionCount`).
            options: std::collections::BTreeMap::from([
                (
                    0u8,
                    option(crate::chain_reader::ledger_council::OptionKind::Keep),
                ),
                (
                    1u8,
                    if kind == 1 {
                        option(crate::chain_reader::ledger_council::OptionKind::List)
                    } else {
                        option(crate::chain_reader::ledger_council::OptionKind::Person)
                    },
                ),
            ]),
            tallies: std::collections::BTreeMap::new(),
            cast: 0,
            finished: None,
            carried_out_at: None,
            carried_out_council: None,
            lapsed: false,
            lapsed_at: None,
            opened_block_time: opened_at,
        }
    }

    /// A row of `event` at `block` for `role`, so the planner can name the row
    /// that made the job due (the ballot's opening, the Council's seats).
    fn row(
        block: u64,
        log_index: u32,
        role: crate::chain_reader::events::Role,
        address: &str,
        event: &str,
        fields: serde_json::Value,
    ) -> LogRow {
        LogRow {
            block,
            log_index,
            time: block,
            tx: [0u8; 32],
            role,
            address: parse_fixed::<20>(address).expect("address"),
            event: event.to_owned(),
            fields,
        }
    }

    /// Project A's ledger with a vote contract, its Council and one ballot.
    fn vote_ledger(fx: &Fixture, block: u64, ballot: Option<BallotSeen>) -> (Ledger, Vec<LogRow>) {
        let mut rows = fx.rows("A", block);
        let mut ledger = Ledger::from_logs(&rows).expect("reads").expect("launched");
        ledger.contracts.pause = Some(VOTE.to_owned());
        if let Some(b) = &ballot {
            ledger.vote.newest = Some(b.id);
            ledger.vote.ballots.insert(b.id, b.clone());
            rows.push(row(
                10,
                0,
                crate::chain_reader::events::Role::Pause,
                VOTE,
                "BallotOpened",
                serde_json::json!({ "id": b.id.to_string() }),
            ));
        }
        (ledger, rows)
    }

    /// The jobs of the vote calls only.
    fn vote_jobs(jobs: &[Job]) -> Vec<&Job> {
        jobs.iter()
            .filter(|j| super::super::calls::is_vote(j.call.name()))
            .collect()
    }

    #[test]
    fn a_due_seat_election_gets_one_open_seats_job_and_not_before_time() {
        let fx = Fixture::load();
        let key = fx.projects["A"].key;
        let block = fx.head();
        let (mut ledger, mut rows) = vote_ledger(&fx, block, None);
        let seats_row = rows.len();
        rows.push(row(
            11,
            0,
            crate::chain_reader::events::Role::Council,
            COUNCIL,
            "SeatsSet",
            serde_json::json!({}),
        ));
        ledger.contracts.council = Some(COUNCIL.to_owned());
        ledger.council.next_election = 50_000;
        ledger.council.seats[0].who = Some("0x00000000000000000000000000000000000000c1".into());
        let at = |t: u64| {
            plan_ledger(&key, &rows, &ledger, &ctx(block, t))
                .expect("plans")
                .into_iter()
                .filter(|j| matches!(j.call, HelperCall::VoteOpenSeats { .. }))
                .collect::<Vec<_>>()
        };
        // A second before: nothing, and no other vote job either.
        assert!(at(49_999).is_empty());
        // At the Council's own next election: one job, named by that second,
        // built on the Council's seats row.
        let jobs = at(50_000);
        assert_eq!(jobs.len(), 1, "{jobs:?}");
        assert_eq!(
            jobs[0].call,
            HelperCall::VoteOpenSeats { vote: vote_addr() }
        );
        assert_eq!(jobs[0].key, format!("vote-open-seats:{VOTE}:50000"));
        assert_eq!(jobs[0].due_block, rows[seats_row].block);
        assert!(!jobs[0].repeats);
        // A ballot is live: the election waits (the contract would say no).
        let (mut ledger, rows) = vote_ledger(&fx, block, Some(ballot(1, 1, 40_000)));
        ledger.contracts.council = Some(COUNCIL.to_owned());
        ledger.council.next_election = 50_000;
        assert!(plan_ledger(&key, &rows, &ledger, &ctx(block, 50_000))
            .expect("plans")
            .iter()
            .all(|j| !matches!(j.call, HelperCall::VoteOpenSeats { .. })));
        // No Council: no seat election at any time.
        let (mut ledger, rows) = vote_ledger(&fx, block, None);
        ledger.council.next_election = 50_000;
        assert!(plan_ledger(&key, &rows, &ledger, &ctx(block, u64::MAX / 2))
            .expect("plans")
            .iter()
            .all(|j| !matches!(j.call, HelperCall::VoteOpenSeats { .. })));
    }

    #[test]
    fn a_ballot_whose_vote_ended_gets_one_finish_job() {
        let fx = Fixture::load();
        let key = fx.projects["A"].key;
        let block = fx.head();
        let b = ballot(7, 1, 1_000);
        let (ledger, rows) = vote_ledger(&fx, block, Some(b.clone()));
        let jobs = |t: u64| {
            plan_ledger(&key, &rows, &ledger, &ctx(block, t))
                .expect("plans")
                .into_iter()
                .filter(|j| matches!(j.call, HelperCall::VoteFinish { .. }))
                .collect::<Vec<_>>()
        };
        // The vote is still running: nothing.
        assert!(jobs(b.vote_end - 1).is_empty());
        // The second it ends: one job, once, for that ballot.
        let due = jobs(b.vote_end);
        assert_eq!(due.len(), 1, "{due:?}");
        assert_eq!(
            due[0].call,
            HelperCall::VoteFinish {
                vote: vote_addr(),
                ballot: 7
            }
        );
        assert_eq!(due[0].key, format!("vote-finish:{VOTE}:7"));
        assert_eq!(due[0].due_block, 10, "the ballot's own opening row");
        assert!(!due[0].repeats);
        // Days later, and after the recorded result: no second job.
        assert_eq!(jobs(b.vote_end + 30 * 86_400).len(), 1);
        let mut recorded = b.clone();
        recorded.finished = Some(crate::chain_reader::ledger_council::Finished {
            outcome: 2,
            winner: 0,
            winner_b: 0,
            cast_total: b.floor,
        });
        let (ledger, rows) = vote_ledger(&fx, block, Some(recorded));
        assert!(plan_ledger(&key, &rows, &ledger, &ctx(block, u64::MAX / 2))
            .expect("plans")
            .iter()
            .all(|j| !matches!(j.call, HelperCall::VoteFinish { .. })));
    }

    #[test]
    fn a_won_ballot_is_carried_out_after_its_wait_and_lapsed_two_units_later() {
        let fx = Fixture::load();
        let key = fx.projects["A"].key;
        let block = fx.head();
        let mut won = ballot(3, 1, 1_000);
        won.finished = Some(crate::chain_reader::ledger_council::Finished {
            outcome: 3,
            winner: 1,
            winner_b: 0,
            cast_total: 500 * ONE_SHARE,
        });
        let (ledger, rows) = vote_ledger(&fx, block, Some(won.clone()));
        let jobs = |t: u64| {
            plan_ledger(&key, &rows, &ledger, &ctx(block, t))
                .expect("plans")
                .into_iter()
                .filter(|j| {
                    matches!(
                        j.call,
                        HelperCall::VoteCarryOut { .. } | HelperCall::VoteLapse { .. }
                    )
                })
                .collect::<Vec<_>>()
        };
        // Before the wait has run: the result waits, nothing to carry out.
        assert!(jobs(won.effective_at - 1).is_empty());
        // The second it may be carried out: one job, once.
        let due = jobs(won.effective_at);
        assert_eq!(due.len(), 1, "{due:?}");
        assert_eq!(
            due[0].call,
            HelperCall::VoteCarryOut {
                vote: vote_addr(),
                ballot: 3
            }
        );
        assert_eq!(due[0].key, format!("vote-carry-out:{VOTE}:3"));
        assert!(!due[0].repeats);
        // Two time units later nobody has: the helper lets it go.
        let lapse_at = won.effective_at + LAPSE_UNITS * UNIT;
        assert_eq!(jobs(lapse_at).len(), 1);
        assert!(matches!(
            jobs(lapse_at)[0].call,
            HelperCall::VoteCarryOut { .. }
        ));
        let late = jobs(lapse_at + 1);
        assert_eq!(late.len(), 1, "{late:?}");
        assert_eq!(
            late[0].call,
            HelperCall::VoteLapse {
                vote: vote_addr(),
                ballot: 3
            }
        );
        assert_eq!(late[0].key, format!("vote-lapse:{VOTE}:3"));
        // A ballot that is already carried out, or lapsed, is terminal.
        for closed in ["carried", "lapsed"] {
            let mut b = won.clone();
            if closed == "carried" {
                b.carried_out_at = Some(won.effective_at);
            } else {
                b.lapsed = true;
                b.lapsed_at = Some(won.effective_at);
            }
            let (ledger, rows) = vote_ledger(&fx, block, Some(b));
            let jobs = plan_ledger(&key, &rows, &ledger, &ctx(block, u64::MAX / 2)).expect("plans");
            assert!(
                jobs.iter().all(|j| !matches!(
                    j.call,
                    HelperCall::VoteCarryOut { .. } | HelperCall::VoteLapse { .. }
                )),
                "{closed}: {jobs:?}"
            );
        }
    }

    /// The planner reads the frozen tallies when nobody recorded the result:
    /// a list with more than half of the cast is `moved` at `voteEnd`, and the
    /// carry-out job is made from that derived result, not from a record.
    #[test]
    fn the_planner_derives_the_ballots_result_when_nobody_recorded_it() {
        let fx = Fixture::load();
        let key = fx.projects["A"].key;
        let block = fx.head();
        let mut b = ballot(5, 1, 1_000);
        b.cast = 500 * ONE_SHARE;
        b.tallies.insert(0, 200 * ONE_SHARE);
        b.tallies.insert(1, 300 * ONE_SHARE);
        assert!(b.finished.is_none(), "no BallotFinished row exists");
        let (ledger, rows) = vote_ledger(&fx, block, Some(b.clone()));
        let jobs = plan_ledger(&key, &rows, &ledger, &ctx(block, b.effective_at))
            .expect("plans")
            .into_iter()
            .filter(|j| matches!(j.call, HelperCall::VoteCarryOut { .. }))
            .collect::<Vec<_>>();
        assert_eq!(jobs.len(), 1, "a moved result is carried out");
        assert_eq!(
            jobs[0].call,
            HelperCall::VoteCarryOut {
                vote: vote_addr(),
                ballot: 5
            }
        );
        // A ballot under its floor, or one nobody beat "keep" on, changes
        // nothing: no carry-out and no lapse job, at any time.
        for (cast, keep, list) in [
            (100 * ONE_SHARE, 0, 100 * ONE_SHARE),
            (500 * ONE_SHARE, 400 * ONE_SHARE, 100 * ONE_SHARE),
        ] {
            let mut quiet = ballot(6, 1, 1_000);
            quiet.cast = cast;
            quiet.tallies.insert(0, keep);
            quiet.tallies.insert(1, list);
            let (ledger, rows) = vote_ledger(&fx, block, Some(quiet));
            let jobs = plan_ledger(&key, &rows, &ledger, &ctx(block, u64::MAX / 2)).expect("plans");
            assert!(
                jobs.iter().all(|j| !matches!(
                    j.call,
                    HelperCall::VoteCarryOut { .. } | HelperCall::VoteLapse { .. }
                )),
                "{jobs:?}"
            );
        }
    }

    /// No vote contract, no vote job: a project whose pause row never came has
    /// neither a ballot nor a seat election to act on.
    #[test]
    fn no_vote_job_without_a_vote_contract() {
        let fx = Fixture::load();
        let key = fx.projects["A"].key;
        let block = fx.head();
        let (mut ledger, rows) = vote_ledger(&fx, block, Some(ballot(1, 1, 1_000)));
        ledger.contracts.council = Some(COUNCIL.to_owned());
        ledger.council.next_election = 1;
        ledger.contracts.pause = None;
        let jobs = plan_ledger(&key, &rows, &ledger, &ctx(block, u64::MAX / 2)).expect("plans");
        assert!(vote_jobs(&jobs).is_empty(), "{jobs:?}");
    }

    /// The bounds the helper holds the vote calls to, and its shorter pace on
    /// a test network: a quarter of the stand window when that is under ten
    /// minutes (COUNCIL-PLAN.md section 5.5 and V27).
    #[test]
    fn the_vote_calls_are_bounded_and_paced_by_the_stand_window() {
        assert_eq!(VOTE_JOBS_PER_PASS, 3, "at most 3 a pass over all projects");
        assert_eq!(VOTE_PER_PROJECT_PER_DAY, 6, "at most 6 a day per project");
        assert_eq!(
            LAPSE_UNITS, 2,
            "a won result lapses two time units after it was due"
        );
        // A real network: a day of 86,400 s, a stand window of a day; a quarter
        // of it is over ten minutes, so the pace is ten minutes.
        assert_eq!(vote_pace_secs(UNIT), 600);
        assert_eq!(vote_pace_secs_of_day(86_400), 600);
        // A test network with a 1,680 s unit: a day of 240 s, so the pace is
        // 60 s, a quarter of the stand window, not ten minutes.
        assert_eq!(vote_pace_secs(1_680), 60);
        assert_eq!(vote_pace_secs_of_day(240), 60);
        // A whole day of a second: still a quarter of it, and a day of zero (no
        // vote contract) keeps the ten minutes.
        assert_eq!(vote_pace_secs_of_day(4), 1);
        assert_eq!(vote_pace_secs_of_day(0), VOTE_PACE_SECS);
    }
}
