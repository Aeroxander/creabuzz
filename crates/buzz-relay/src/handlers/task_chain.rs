//! A team's task record tied to its task on the network (the "plan"), and what the relay refuses when they disagree.
//!
//! The relay is not the chain and never pretends to be: it reads only what the chain reader has stored in
//! `chain_logs`, and it judges a record only against a plan it can see there. Its refusals are the early, honest ones;
//! the app reads the chain itself before it offers any payment.
//!
//! # The tie
//!
//! - The plan's `what` is the **id of the task record** (the signed `task-part = task` event), so nobody can change a
//!   task record after it is planned.
//! - The plan of a task record is its **lowest-serial** row that is announced, taken or paid. A plan that ended unpaid
//!   (withdrawn, lapsed, sent back, ran out) binds nothing, and a later row with the same `what` is a repeat. A row
//!   that is past its end but that nobody has settled yet counts as ended for this choice too, so a live later plan
//!   of the same record is the one that binds (and when no plan is live, the over one is still the plan, so a take of
//!   it is refused with words). A paid row binds for ever.
//! - The wallet a worker is paid to is the one they name under their own signature, in `task-pay-to`, on a `take` (a
//!   task open to anyone) or on the `accept` step (a task that names its helper). The plan's `payee` and the chain's
//!   `takenBy` must be it: a `take` and an `accept` are held to the plan's payee when it names one, and a `confirm`
//!   of a paid plan is held to the wallet the worker named, so the team cannot pay another wallet and record it as
//!   the worker's pay.
//!
//! # What is refused
//!
//! Only steps whose task has a plan (see [`decide_chain`] for each step's words). Where there is no plan, no reader, or
//! the reader has not read the project's launch yet, nothing changes: tasks without a plan work as they always did, and
//! a take is let through while the reader lags (a lenient window that can never make the app pay wrongly). The one step
//! that is not lenient is `confirm` (the team says the work was accepted and paid): while the reader has not read the
//! project's launch it is asked to try again. A lookup that fails is a server fault and refuses the write: an outage
//! never lets a record past a check.
//!
//! A plan whose end (announced: when its take window closes; taken: its deadline) is at or before the newest block the
//! reader has stored is **over** here, because the next settle ends it; a plan nobody has settled yet must not block
//! the team's `cancel` for ever. A plan that is over and not paid binds nothing for `confirm` and `cancel`; a `take`
//! of it is refused with words, as the chain would refuse it.

use std::sync::Arc;

use buzz_core::tenant::CommunityId;
use nostr::Event;
use serde_json::Value;
use sqlx::{PgPool, Row};

use super::ingest::IngestError;
use super::launch_update_authority::{internal, TaskPart};
use crate::api::manager::cost::project_id;
use crate::state::AppState;

/// Said on a `take` of a planned task that names no wallet to be paid to.
pub(crate) const NAME_WALLET: &str =
    "invalid: this task is planned on the network: name the wallet you will take it with";
/// Said when the wallet a record names is not the one the plan names.
pub(crate) const OTHER_WALLET: &str = "invalid: the plan on the network names another wallet";
/// Said on a `take` when the plan is already taken by another wallet.
pub(crate) const TAKEN_ELSEWHERE: &str =
    "restricted: this task is already taken on the network by another wallet";
/// Said on a `take` when the plan has been paid or its time has run out.
pub(crate) const PLAN_ENDED: &str = "restricted: this task's plan has ended on the network";
/// Said on a `confirm` the server cannot judge yet: ask again soon.
pub(crate) const NOT_SEEN_YET: &str =
    "retry: the network has not shown this payment to the server yet; try again in a minute";
/// Said on a `confirm` of a plan that nobody has set money aside for.
pub(crate) const PAY_FIRST: &str = "invalid: pay it on the network first, then record it";
/// Said on a `confirm` that names no payment, or another one than the one that paid the plan.
pub(crate) const NOT_THAT_PAYMENT: &str = "invalid: that is not the payment that paid this task";
/// Said on a `confirm` of a plan that the network paid to a wallet the worker never named.
pub(crate) const PAID_ELSEWHERE: &str =
    "invalid: the network paid another wallet than the one the worker named";
/// Said on a `cancel` while the plan still holds the task on the network.
pub(crate) const WITHDRAW_FIRST: &str =
    "invalid: withdraw or send back the money on the network first";

/// The most announced rows with one `what` that are judged: a task record is planned once, and a team that announces
/// it again and again (each costs it gas) cannot make a take read an unbounded list. A record with more is not
/// guessed at: the lookup fails, which refuses the write (a server fault, never a rule switched off by a long list).
const PLANS_READ: i64 = 64;

/// The announced rows of one task record (`$3`: its id as `0x` hex, lower case), by serial. Served by the partial index
/// `idx_chain_logs_task_what` (migration 0072).
pub(crate) const ANNOUNCED_SQL: &str =
    "SELECT decoded FROM chain_logs WHERE reader = $1 AND project_key = $2 \
         AND role = 'tasks' AND event = 'TaskAnnounced' AND lower(decoded->>'what') = $3 \
     ORDER BY (decoded->>'serial')::numeric LIMIT $4";
/// The takes and resolutions of the plans found (`$3`: their serials as decimal text), in chain order. Served by the
/// partial index `idx_chain_logs_task_serial` (migration 0072).
pub(crate) const LATER_SQL: &str =
    "SELECT event, decoded, tx_hash FROM chain_logs WHERE reader = $1 \
         AND project_key = $2 AND role = 'tasks' AND event IN ('TaskTaken', 'TaskResolved') \
         AND decoded->>'serial' = ANY($3) ORDER BY block_number, log_index";
/// The time of the reader's newest stored block (through the primary key, never a scan of every block).
pub(crate) const AS_OF_SQL: &str =
    "SELECT block_time FROM chain_blocks WHERE reader = $1 ORDER BY number DESC LIMIT 1";

/// Where a plan is on the network, as far as its stored rows say.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PlanState {
    /// Announced, not taken.
    Announced,
    /// Taken: money is set aside.
    Taken,
    /// Paid in full or in part.
    Paid,
}

/// The plan of a task record, as the reader's rows say.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Plan {
    /// Its number in the project's task book.
    pub(crate) serial: u64,
    /// Where it is.
    pub(crate) state: PlanState,
    /// Who may take it (lower-case `0x` address); `None` when it is open to anyone.
    pub(crate) payee: Option<String>,
    /// Who took it (lower-case `0x` address).
    pub(crate) taken_by: Option<String>,
    /// The end of its take window while announced, its deadline once taken (unix seconds).
    pub(crate) ends_at: u64,
    /// The transaction that paid it (32 bytes), once paid.
    pub(crate) paid_tx: Option<[u8; 32]>,
    /// The newest block time the reader has stored for the chain (unix seconds).
    pub(crate) as_of: u64,
}

impl Plan {
    /// Whether the plan is over: paid, or past its end at the reader's newest block (the next settle ends it).
    pub(crate) fn is_over(&self) -> bool {
        self.state == PlanState::Paid || self.ends_at <= self.as_of
    }
}

/// What the reader's rows say about the plan of a task record.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ChainLookup {
    /// No chain reader is configured on this server.
    NoReader,
    /// The reader has not stored this project's launch yet.
    NotRead,
    /// The project is read and has no plan for this task record (or its record names another project's launch).
    Absent,
    /// The task record's plan.
    Plan(Plan),
}

/// The chain key a project record names (`chain-key`: `0x` and 64 hex digits), if it does.
pub(crate) fn chain_key_of(record: &Event) -> Option<[u8; 32]> {
    record.tags.iter().find_map(|tag| match tag.as_slice() {
        [name, value, ..] if name == "chain-key" => value
            .strip_prefix("0x")
            .and_then(|digits| hex::decode(digits).ok())
            .and_then(|bytes| <[u8; 32]>::try_from(bytes).ok()),
        _ => None,
    })
}

/// A number the reader stored as a decimal string.
fn number(row: &Value, name: &str) -> Result<u64, sqlx::Error> {
    row.get(name)
        .and_then(Value::as_str)
        .and_then(|text| text.parse().ok())
        .ok_or_else(|| sqlx::Error::Decode(format!("a stored task row has no `{name}`").into()))
}

/// An address the reader stored, lower case; `None` for the zero address.
fn address(row: &Value, name: &str) -> Option<String> {
    row.get(name)
        .and_then(Value::as_str)
        .map(str::to_lowercase)
        .filter(|text| text.trim_start_matches("0x").bytes().any(|b| b != b'0'))
}

/// One stored row of a task after its announcement: `(event, decoded, tx_hash)`, in chain order.
pub(crate) type LaterRow = (String, Value, Vec<u8>);

/// The plan among `announced` rows (oldest serial first), given the rows that came after them.
///
/// The plan is the lowest-serial row that is announced, taken or paid. A row's state is the last of its own events:
/// `TaskTaken` takes it, `TaskResolved` ends it (state 3 is paid; 4 to 7 ended unpaid). A row that is not paid and is
/// past its end at `as_of` is over: the next settle ends it, so a later row that is still live binds instead. When
/// every row that has not ended is over, the lowest of them is the plan (a take of it is refused with words). A paid
/// row binds whatever its age.
pub(crate) fn plan_of(
    announced: &[Value],
    later: &[LaterRow],
    as_of: u64,
) -> Result<Option<Plan>, sqlx::Error> {
    let mut first_over: Option<Plan> = None;
    for row in announced {
        let serial = number(row, "serial")?;
        let mut plan = Plan {
            serial,
            state: PlanState::Announced,
            payee: address(row, "payee"),
            taken_by: None,
            ends_at: number(row, "expiresAt")?,
            paid_tx: None,
            as_of,
        };
        let mut ended = false;
        for (event, decoded, tx) in later {
            if number(decoded, "serial")? != serial {
                continue;
            }
            match event.as_str() {
                "TaskTaken" => {
                    plan.state = PlanState::Taken;
                    plan.taken_by = address(decoded, "takenBy");
                    plan.ends_at = number(decoded, "deadline")?;
                }
                "TaskResolved" => match number(decoded, "state")? {
                    3 => {
                        plan.state = PlanState::Paid;
                        plan.paid_tx = <[u8; 32]>::try_from(tx.as_slice()).ok();
                    }
                    _ => ended = true,
                },
                _ => {}
            }
        }
        if ended {
            continue;
        }
        if !plan.is_over() || plan.state == PlanState::Paid {
            return Ok(Some(plan));
        }
        first_over.get_or_insert(plan);
    }
    Ok(first_over)
}

/// Read the plan of the task record `what` of the project the record names, from the reader's rows.
///
/// The project's launch must be in the rows and must carry `project_id` (the hash of the project record's address):
/// a record that names another project's key, or a launch made for someone else's record, ties nothing (`Absent`).
/// The book's rows are read through the partial index of migration 0071 (`role = 'tasks'`), so a `take` never scans
/// a project's whole history.
pub(crate) async fn chain_task_of(
    pool: &PgPool,
    reader: Option<&str>,
    chain_key: &[u8; 32],
    project_id: &str,
    what: &[u8; 32],
) -> Result<ChainLookup, sqlx::Error> {
    let Some(reader) = reader else {
        return Ok(ChainLookup::NoReader);
    };
    let launched = sqlx::query_scalar::<_, Option<String>>(
        "SELECT lower(decoded->>'projectId') FROM chain_logs WHERE reader = $1 AND project_key = $2 \
             AND role = 'launcher' AND event = 'ProjectLaunched' ORDER BY block_number, log_index LIMIT 1",
    )
    .bind(reader)
    .bind(chain_key.as_slice())
    .fetch_optional(pool)
    .await?
    .flatten();
    let Some(launched) = launched else {
        return Ok(ChainLookup::NotRead);
    };
    if launched != project_id.to_lowercase() {
        return Ok(ChainLookup::Absent);
    }
    let announced: Vec<Value> = sqlx::query_scalar(ANNOUNCED_SQL)
        .bind(reader)
        .bind(chain_key.as_slice())
        .bind(format!("0x{}", hex::encode(what)))
        .bind(PLANS_READ + 1)
        .fetch_all(pool)
        .await?;
    if i64::try_from(announced.len()).is_ok_and(|read| read > PLANS_READ) {
        return Err(sqlx::Error::Decode(
            format!("the task record has more than {PLANS_READ} plans announced").into(),
        ));
    }
    if announced.is_empty() {
        return Ok(ChainLookup::Absent);
    }
    let serials: Vec<String> = announced
        .iter()
        .map(|row| number(row, "serial").map(|serial| serial.to_string()))
        .collect::<Result<_, _>>()?;
    let later: Vec<LaterRow> = sqlx::query(LATER_SQL)
        .bind(reader)
        .bind(chain_key.as_slice())
        .bind(&serials)
        .fetch_all(pool)
        .await?
        .into_iter()
        .map(|row| {
            Ok((
                row.try_get::<String, _>("event")?,
                row.try_get::<Value, _>("decoded")?,
                row.try_get::<Vec<u8>, _>("tx_hash")?,
            ))
        })
        .collect::<Result<_, sqlx::Error>>()?;
    let as_of: Option<i64> = sqlx::query_scalar(AS_OF_SQL)
        .bind(reader)
        .fetch_optional(pool)
        .await?;
    let as_of = u64::try_from(as_of.unwrap_or(0)).unwrap_or(0);
    Ok(plan_of(&announced, &later, as_of)?.map_or(ChainLookup::Absent, ChainLookup::Plan))
}

/// What the record says that the plan is held against: the wallet it names (`task-pay-to`) and the payment it names
/// (`task-paid`), both lower case.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct StepNames {
    /// The wallet the worker is paid to.
    pub(crate) pay_to: Option<String>,
    /// The transaction that paid the task.
    pub(crate) paid: Option<String>,
    /// The wallet the task's worker named under their own signature on the task's `take` and `accept` steps, when
    /// they named one (two different ones read as none). Not in the record being written: [`enforce`] reads it for
    /// a `confirm` of a paid plan.
    pub(crate) worker_pay_to: Option<String>,
}

impl StepNames {
    /// The first `task-pay-to` and `task-paid` tags of `event`, lower case.
    pub(crate) fn of(event: &Event) -> Self {
        let first = |wanted: &str| {
            event.tags.iter().find_map(|tag| match tag.as_slice() {
                [name, value, ..] if name == wanted => Some(value.to_lowercase()),
                _ => None,
            })
        };
        Self {
            pay_to: first("task-pay-to"),
            paid: first("task-paid"),
            worker_pay_to: None,
        }
    }
}

/// Whether a step must be held against the plan at all (the others never are: they move no money, and the network
/// has its own deadline).
fn is_judged(part: TaskPart, names: &StepNames) -> bool {
    match part {
        TaskPart::Take | TaskPart::Confirm | TaskPart::Cancel => true,
        // An accept says nothing about a wallet unless it names one.
        TaskPart::Accept => names.pay_to.is_some(),
        _ => false,
    }
}

/// Decide a step against what the reader says about its task's plan. The words are constants; the app reads their
/// prefixes (`retry:` ask again soon, `invalid:`, `restricted:`) and never shows one.
///
/// | step | refused when |
/// |---|---|
/// | `take` | the plan is over; no `task-pay-to`; the plan names another wallet; it is taken by another wallet |
/// | `accept` naming a wallet | the plan names another wallet |
/// | `confirm` | no payment has paid the plan: `retry:` while it is taken or not read, `invalid:` before it is taken, when the named payment is not the one that paid it, or when the network paid a wallet the worker did not name |
/// | `cancel` | the plan is announced or taken and not over |
///
/// A lookup that finds no plan (`NoReader`, `Absent`) refuses nothing; `NotRead` refuses only a `confirm`.
pub(crate) fn decide_chain(
    part: TaskPart,
    names: &StepNames,
    lookup: &ChainLookup,
) -> Result<(), &'static str> {
    let plan = match lookup {
        ChainLookup::NoReader | ChainLookup::Absent => return Ok(()),
        ChainLookup::NotRead if part == TaskPart::Confirm => return Err(NOT_SEEN_YET),
        ChainLookup::NotRead => return Ok(()),
        ChainLookup::Plan(plan) => plan,
    };
    let over = plan.is_over();
    let names_other_wallet =
        |wallet: &str| plan.payee.as_deref().is_some_and(|payee| payee != wallet);
    match part {
        TaskPart::Take => {
            if over {
                return Err(PLAN_ENDED);
            }
            let Some(wallet) = names.pay_to.as_deref() else {
                return Err(NAME_WALLET);
            };
            // Taken already is said before the plan's own wallet is: the task is gone, whatever it names.
            if plan.state == PlanState::Taken && plan.taken_by.as_deref() != Some(wallet) {
                return Err(TAKEN_ELSEWHERE);
            }
            if names_other_wallet(wallet) {
                return Err(OTHER_WALLET);
            }
            Ok(())
        }
        TaskPart::Accept => match names.pay_to.as_deref() {
            Some(wallet) if names_other_wallet(wallet) => Err(OTHER_WALLET),
            _ => Ok(()),
        },
        TaskPart::Confirm => match plan.state {
            PlanState::Paid => {
                let paid_by = plan.paid_tx.map(|tx| format!("0x{}", hex::encode(tx)));
                if names.paid.is_none() || names.paid != paid_by {
                    return Err(NOT_THAT_PAYMENT);
                }
                // The money went to the wallet that took the plan: it must be the one the worker named.
                match (names.worker_pay_to.as_deref(), plan.taken_by.as_deref()) {
                    (Some(named), Some(taker)) if named == taker => Ok(()),
                    _ => Err(PAID_ELSEWHERE),
                }
            }
            // Ended unpaid by its time: it binds nothing, and the record is a step 1 record.
            _ if over => Ok(()),
            PlanState::Taken => Err(NOT_SEEN_YET),
            PlanState::Announced => Err(PAY_FIRST),
        },
        TaskPart::Cancel if !over => Err(WITHDRAW_FIRST),
        _ => Ok(()),
    }
}

/// The step being written: which one, the task record it names (the plan's `what`) and the account that does the task.
#[derive(Clone, Copy, Debug)]
pub(crate) struct StepOn<'a> {
    /// The step.
    pub(crate) part: TaskPart,
    /// The id of the task record it names.
    pub(crate) task_id: &'a [u8; 32],
    /// The account that does the task (hex), when it has one.
    pub(crate) worker: Option<&'a str>,
}

/// Hold a task step against its plan on the network, with the reader's rows.
///
/// `project_record` is the project's stored record (it names the chain key), `coordinate` its address, `event` the step
/// being written and `step` which step it is (see [`StepOn`]). Runs after the signer is judged. No reader, no chain key, or a step that moves no money
/// leaves the record as it was; a read that fails refuses the write.
pub(crate) async fn enforce(
    state: &Arc<AppState>,
    community: CommunityId,
    project_record: &Event,
    coordinate: &str,
    event: &Event,
    step: StepOn<'_>,
) -> Result<(), IngestError> {
    let StepOn {
        part,
        task_id,
        worker,
    } = step;
    let mut names = StepNames::of(event);
    if !is_judged(part, &names) {
        return Ok(());
    }
    let reader = state
        .config
        .chain_reader
        .as_ref()
        .map(|reader| reader.reader_id());
    let Some(key) = chain_key_of(project_record) else {
        return Ok(());
    };
    let lookup = chain_task_of(
        state.db.pool(),
        reader.as_deref(),
        &key,
        &project_id(coordinate),
        task_id,
    )
    .await
    .map_err(|e| internal("reading the task's plan on the network", e))?;
    // Only a confirm of a plan the network has paid is held to the worker's own wallet.
    if let (TaskPart::Confirm, ChainLookup::Plan(plan), Some(worker)) = (part, &lookup, worker) {
        if plan.state == PlanState::Paid {
            names.worker_pay_to =
                super::task_takes::stored_pay_to(state, community, task_id, worker).await?;
        }
    }
    decide_chain(part, &names, &lookup).map_err(|reason| {
        if reason.starts_with("restricted:") {
            IngestError::AuthFailed(reason.into())
        } else {
            IngestError::Rejected(reason.into())
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const WALLET: &str = "0x00000000000000000000000000000000000000aa";
    const OTHER: &str = "0x00000000000000000000000000000000000000bb";
    const TX: [u8; 32] = [7; 32];

    fn plan(state: PlanState, payee: Option<&str>) -> Plan {
        Plan {
            serial: 3,
            state,
            payee: payee.map(str::to_owned),
            taken_by: (state != PlanState::Announced).then(|| WALLET.to_owned()),
            ends_at: 2_000,
            paid_tx: (state == PlanState::Paid).then_some(TX),
            as_of: 1_000,
        }
    }

    fn names(pay_to: Option<&str>, paid: Option<&str>) -> StepNames {
        StepNames {
            pay_to: pay_to.map(str::to_owned),
            paid: paid.map(str::to_owned),
            worker_pay_to: None,
        }
    }

    /// A confirm that names `paid` and whose worker named `wallet`.
    fn confirm_names(paid: &str, wallet: Option<&str>) -> StepNames {
        StepNames {
            worker_pay_to: wallet.map(str::to_owned),
            ..names(None, Some(paid))
        }
    }

    fn judged(part: TaskPart, names: &StepNames, plan: Plan) -> Result<(), &'static str> {
        decide_chain(part, names, &ChainLookup::Plan(plan))
    }

    #[test]
    fn a_take_of_a_planned_task_names_the_plans_wallet() {
        let open = plan(PlanState::Announced, Some(WALLET));
        assert_eq!(
            judged(TaskPart::Take, &names(Some(WALLET), None), open.clone()),
            Ok(())
        );
        assert_eq!(
            judged(TaskPart::Take, &names(Some(OTHER), None), open.clone()),
            Err(OTHER_WALLET)
        );
        assert_eq!(
            judged(TaskPart::Take, &names(None, None), open),
            Err(NAME_WALLET)
        );
        // A plan that names nobody is open to any wallet, but a wallet must still be named.
        let anyone = plan(PlanState::Announced, None);
        assert_eq!(
            judged(TaskPart::Take, &names(Some(OTHER), None), anyone.clone()),
            Ok(())
        );
        assert_eq!(
            judged(TaskPart::Take, &names(None, None), anyone),
            Err(NAME_WALLET)
        );
    }

    #[test]
    fn a_take_is_refused_when_the_plan_is_taken_by_another_wallet_or_over() {
        let taken = plan(PlanState::Taken, None);
        assert_eq!(
            judged(TaskPart::Take, &names(Some(OTHER), None), taken.clone()),
            Err(TAKEN_ELSEWHERE)
        );
        assert_eq!(
            judged(TaskPart::Take, &names(Some(WALLET), None), taken),
            Ok(())
        );
        let paid = plan(PlanState::Paid, Some(WALLET));
        assert_eq!(
            judged(TaskPart::Take, &names(Some(WALLET), None), paid),
            Err(PLAN_ENDED)
        );
        let late = Plan {
            as_of: 2_000,
            ..plan(PlanState::Announced, Some(WALLET))
        };
        assert_eq!(
            judged(TaskPart::Take, &names(Some(WALLET), None), late),
            Err(PLAN_ENDED)
        );
    }

    #[test]
    fn an_accept_that_names_a_wallet_agrees_with_the_plan() {
        let planned = plan(PlanState::Announced, Some(WALLET));
        assert_eq!(
            judged(
                TaskPart::Accept,
                &names(Some(WALLET), None),
                planned.clone()
            ),
            Ok(())
        );
        assert_eq!(
            judged(TaskPart::Accept, &names(Some(OTHER), None), planned.clone()),
            Err(OTHER_WALLET)
        );
        // An accept that names none is not held against the plan, and one with a plan that names nobody agrees.
        assert_eq!(
            judged(TaskPart::Accept, &names(None, None), planned),
            Ok(())
        );
        assert_eq!(
            judged(
                TaskPart::Accept,
                &names(Some(OTHER), None),
                plan(PlanState::Announced, None)
            ),
            Ok(())
        );
    }

    #[test]
    fn a_confirm_of_a_planned_task_needs_the_payment_that_paid_it() {
        let right = format!("0x{}", hex::encode(TX));
        let wrong = format!("0x{}", hex::encode([8u8; 32]));
        let paid = plan(PlanState::Paid, Some(WALLET));
        assert_eq!(
            judged(
                TaskPart::Confirm,
                &confirm_names(&right, Some(WALLET)),
                paid.clone()
            ),
            Ok(())
        );
        assert_eq!(
            judged(
                TaskPart::Confirm,
                &confirm_names(&wrong, Some(WALLET)),
                paid.clone()
            ),
            Err(NOT_THAT_PAYMENT)
        );
        assert_eq!(
            judged(TaskPart::Confirm, &names(None, None), paid),
            Err(NOT_THAT_PAYMENT)
        );
        assert_eq!(
            judged(
                TaskPart::Confirm,
                &names(None, Some(&right)),
                plan(PlanState::Taken, None)
            ),
            Err(NOT_SEEN_YET)
        );
        assert_eq!(
            judged(
                TaskPart::Confirm,
                &names(None, Some(&right)),
                plan(PlanState::Announced, None)
            ),
            Err(PAY_FIRST)
        );
        // A plan that ran out unpaid binds nothing: the record is a step 1 record.
        let ran_out = Plan {
            as_of: 2_000,
            ..plan(PlanState::Taken, None)
        };
        assert_eq!(
            judged(TaskPart::Confirm, &names(None, Some(&right)), ran_out),
            Ok(())
        );
    }

    /// Review fix: the right payment is not enough. The network paid the wallet that took the plan, and the worker
    /// must have named that wallet; a team that planned its own wallet as the payee cannot record the pay as the
    /// worker's.
    #[test]
    fn a_confirm_of_a_paid_plan_needs_the_wallet_the_worker_named() {
        let right = format!("0x{}", hex::encode(TX));
        let paid = plan(PlanState::Paid, Some(WALLET));
        assert_eq!(
            judged(
                TaskPart::Confirm,
                &confirm_names(&right, Some(OTHER)),
                paid.clone()
            ),
            Err(PAID_ELSEWHERE),
            "the worker named another wallet than the one paid"
        );
        assert_eq!(
            judged(
                TaskPart::Confirm,
                &confirm_names(&right, None),
                paid.clone()
            ),
            Err(PAID_ELSEWHERE),
            "the worker named none (or two different ones)"
        );
        // A paid plan whose taker is unknown (the zero address) cannot match any wallet.
        let nobody = Plan {
            taken_by: None,
            ..paid
        };
        assert_eq!(
            judged(
                TaskPart::Confirm,
                &confirm_names(&right, Some(WALLET)),
                nobody
            ),
            Err(PAID_ELSEWHERE)
        );
    }

    #[test]
    fn a_cancel_waits_for_the_network_unless_the_plan_is_over() {
        for state in [PlanState::Announced, PlanState::Taken] {
            assert_eq!(
                judged(TaskPart::Cancel, &names(None, None), plan(state, None)),
                Err(WITHDRAW_FIRST),
                "{state:?}"
            );
            let over = Plan {
                as_of: 2_000,
                ..plan(state, None)
            };
            assert_eq!(
                judged(TaskPart::Cancel, &names(None, None), over),
                Ok(()),
                "{state:?}"
            );
        }
        assert_eq!(
            judged(
                TaskPart::Cancel,
                &names(None, None),
                plan(PlanState::Paid, None)
            ),
            Ok(())
        );
    }

    #[test]
    fn nothing_is_refused_without_a_plan_and_only_a_confirm_waits_for_a_launch_not_yet_read() {
        for lookup in [ChainLookup::NoReader, ChainLookup::Absent] {
            for part in [
                TaskPart::Take,
                TaskPart::Confirm,
                TaskPart::Cancel,
                TaskPart::Accept,
            ] {
                assert_eq!(decide_chain(part, &names(None, None), &lookup), Ok(()));
            }
        }
        assert_eq!(
            decide_chain(TaskPart::Confirm, &names(None, None), &ChainLookup::NotRead),
            Err(NOT_SEEN_YET)
        );
        for part in [TaskPart::Take, TaskPart::Cancel, TaskPart::Accept] {
            assert_eq!(
                decide_chain(part, &names(None, None), &ChainLookup::NotRead),
                Ok(())
            );
        }
    }

    #[test]
    fn the_steps_that_move_no_money_are_never_judged() {
        for part in [
            TaskPart::Task,
            TaskPart::SendBack,
            TaskPart::Grant,
            TaskPart::Evidence,
            TaskPart::MoreTime,
            TaskPart::GiveUp,
        ] {
            assert!(!is_judged(part, &names(None, None)), "{part:?}");
            assert_eq!(
                judged(
                    part,
                    &names(None, None),
                    plan(PlanState::Taken, Some(WALLET))
                ),
                Ok(())
            );
        }
        assert!(!is_judged(TaskPart::Accept, &names(None, None)));
        assert!(is_judged(TaskPart::Accept, &names(Some(WALLET), None)));
    }

    fn announced(serial: u64, payee: &str) -> Value {
        serde_json::json!({
            "serial": serial.to_string(),
            "what": "0xaa",
            "payee": payee,
            "expiresAt": "5000",
        })
    }

    fn taken(serial: u64, by: &str) -> LaterRow {
        (
            "TaskTaken".into(),
            serde_json::json!({ "serial": serial.to_string(), "takenBy": by, "deadline": "9000" }),
            vec![1; 32],
        )
    }

    fn resolved(serial: u64, state: u8, tx: u8) -> LaterRow {
        (
            "TaskResolved".into(),
            serde_json::json!({ "serial": serial.to_string(), "state": state.to_string() }),
            vec![tx; 32],
        )
    }

    #[test]
    fn the_plan_is_the_lowest_serial_row_that_is_announced_taken_or_paid() {
        let zero = "0x0000000000000000000000000000000000000000";
        let rows = [
            announced(2, WALLET),
            announced(5, zero),
            announced(9, WALLET),
        ];
        // Serial 2 withdrawn: the next live one binds; a plan nobody may take is open to anyone.
        let found = plan_of(&rows, &[resolved(2, 6, 1)], 100)
            .expect("rows")
            .expect("a plan");
        assert_eq!(
            (found.serial, found.state, found.payee.clone()),
            (5, PlanState::Announced, None)
        );
        // Serial 2 taken, then paid: it binds, and the later rows are repeats.
        let found = plan_of(
            &rows,
            &[taken(2, WALLET), resolved(2, 3, 4), announced_later_noise()],
            100,
        )
        .expect("rows")
        .expect("a plan");
        assert_eq!((found.serial, found.state), (2, PlanState::Paid));
        assert_eq!(found.paid_tx, Some([4; 32]));
        assert_eq!(found.taken_by.as_deref(), Some(WALLET));
        // Every row ended unpaid (sent back, ran out, withdrawn, lapsed): no plan.
        let ended = [resolved(2, 4, 1), resolved(5, 5, 1), resolved(9, 7, 1)];
        assert_eq!(plan_of(&rows, &ended, 100).expect("rows"), None);
        // A row that does not read is an error, never skipped.
        let broken = [serde_json::json!({ "serial": "x" })];
        assert!(plan_of(&broken, &[], 100).is_err());
    }

    /// Review fix: a plan that is past its end but that nobody has settled must not hide a live later plan of the same
    /// record. A paid plan binds whatever its age, and when no plan is live the over one is still the plan.
    #[test]
    fn a_plan_past_its_end_does_not_hide_a_live_later_plan_of_the_same_record() {
        // Serial 1 is announced with its window ended at 5000 (nobody settled it); serial 2 is live until 9000.
        let mut late = announced(2, WALLET);
        late["expiresAt"] = serde_json::json!("9000");
        let rows = [announced(1, WALLET), late];
        let live = plan_of(&rows, &[], 6_000).expect("rows").expect("a plan");
        assert_eq!((live.serial, live.state), (2, PlanState::Announced));
        assert!(!live.is_over());
        // Before the end of serial 1 it is the plan, as the lowest serial.
        let first = plan_of(&rows, &[], 4_000).expect("rows").expect("a plan");
        assert_eq!(first.serial, 1);
        // Once both are past their ends, the lowest is still the plan (a take of it is refused with words).
        let both = plan_of(&rows, &[], 9_000).expect("rows").expect("a plan");
        assert_eq!((both.serial, both.is_over()), (1, true));
        // Serial 1 taken, its deadline (9000) ahead: it binds. Past the deadline with nobody settled: over, so a repeat
        // that is still live (serial 2, window to 20000) binds instead.
        let mut longer = announced(2, WALLET);
        longer["expiresAt"] = serde_json::json!("20000");
        let rows_long = [announced(1, WALLET), longer];
        let taken_late = [taken(1, WALLET)];
        let found = plan_of(&rows_long, &taken_late, 7_000)
            .expect("rows")
            .expect("a plan");
        assert_eq!((found.serial, found.state), (1, PlanState::Taken));
        let found = plan_of(&rows_long, &taken_late, 9_000)
            .expect("rows")
            .expect("a plan");
        assert_eq!((found.serial, found.state), (2, PlanState::Announced));
        // A paid serial 1 binds for ever, however old.
        let paid = [taken(1, WALLET), resolved(1, 3, 4)];
        let found = plan_of(&rows, &paid, 100_000)
            .expect("rows")
            .expect("a plan");
        assert_eq!((found.serial, found.state), (1, PlanState::Paid));
        // A row that ended unpaid is skipped whatever the time.
        let ended = [resolved(1, 6, 1)];
        let found = plan_of(&rows, &ended, 100).expect("rows").expect("a plan");
        assert_eq!(found.serial, 2);
    }

    /// A row of another event that a query for plans never returns; it is ignored if it did.
    fn announced_later_noise() -> LaterRow {
        (
            "NoteMinted".into(),
            serde_json::json!({ "serial": "2" }),
            vec![0; 32],
        )
    }

    #[test]
    fn the_chain_key_is_read_from_the_project_record() {
        let key = format!("0x{}", "ab".repeat(32));
        let keys = nostr::Keys::generate();
        let record = |tags: Vec<nostr::Tag>| {
            nostr::EventBuilder::new(nostr::Kind::Custom(37001), "")
                .tags(tags)
                .sign_with_keys(&keys)
                .expect("sign")
        };
        let named = record(vec![
            nostr::Tag::parse(["chain-key", key.as_str()]).expect("tag")
        ]);
        assert_eq!(chain_key_of(&named), Some([0xab; 32]));
        assert_eq!(chain_key_of(&record(vec![])), None);
        let short = record(vec![nostr::Tag::parse(["chain-key", "0xab"]).expect("tag")]);
        assert_eq!(chain_key_of(&short), None);
    }
}
