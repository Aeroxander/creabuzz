//! The `tasks` section of the project numbers record (step 2, RECORD-V2
//! section 10): the types, the cut (which rows and which note holders are
//! listed), and the numbers the section derives from its rows (`next`, `atMostNow`,
//! the cap).
//!
//! Every word, unit and bound is the plan's (`docs/next-version/STEP2-SERVER-APP-PLAN.md`
//! section 1): amounts are decimal strings of whole dollar units (6 decimals),
//! times unix seconds, counts and shares JSON integers, addresses and 32-byte
//! values lower-case `0x` text.

use std::collections::BTreeSet;

use anyhow::{anyhow, bail};
use serde::{Deserialize, Serialize};

use super::ledger::Ledger;
use super::ledger_tasks::{LTask, TaskLedger, TaskState};
use super::record::mul_div;
use super::views::{BookViews, Views};
use super::word::hex0x;

/// The most open tasks a book holds (`TaskBook.MAX_OPEN`).
pub const MAX_OPEN_ROWS: usize = 8;
/// The most ended rows a record lists.
pub const MAX_ENDED_ROWS: usize = 32;
/// The most ended rows listed because a leaver can still claim from them.
pub const MAX_NOTE_ROWS: usize = 24;
/// The most ended rows listed that moved nothing (cancelled and lapsed).
pub const MAX_QUIET_ROWS: usize = 4;
/// The rows whose note holders are listed.
pub const MAX_NOTE_HOLDER_ROWS: usize = 8;
/// The most note holders listed for one row.
pub const MAX_NOTE_HOLDERS: usize = 20;
/// The floor of the window in which an ended row is kept: 28 days.
pub const ENDED_FLOOR_SECS: u64 = 28 * 24 * 3_600;
/// The largest serial a record can carry as a JSON integer: 2^53.
pub const MAX_JSON_SERIAL: u64 = 1 << 53;
/// Parts of ten thousand.
const BPS: u128 = 10_000;

/// What the contracts allow a task.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct LimitsTasksRec {
    /// The most open tasks (`MAX_OPEN`).
    pub max_open: u64,
    /// The most one task may ask for, in ten-thousandths of the pot.
    pub max_share_bps: u64,
    /// The most that may be taken in any rolling window, in ten-thousandths.
    pub cap_bps: u64,
    /// The smallest task.
    pub min_task: String,
    /// The rolling window of the cap, in seconds.
    pub cap_window_secs: u64,
    /// How long a task can be taken after its notice, in seconds.
    pub take_window_secs: u64,
    /// How long after a take a task is due, in seconds.
    pub due_secs: u64,
}

/// One take counted in the cap, and when its room comes back.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FreeRec {
    /// When the take stops counting.
    pub at: u64,
    /// What it counts, in ten-thousandths of the pot.
    pub bps: u64,
}

/// The 28-day cap, settled at `asOf.time`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CapRec {
    /// The takes counted in the window now, less the pending give-back.
    pub used_bps: u64,
    /// The room left under the cap.
    pub room_bps: u64,
    /// When room comes back: oldest first, at most 16.
    pub frees: Vec<FreeRec>,
}

/// What can happen next, and when.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NextRec {
    /// When (always after `asOf.time`).
    pub at: u64,
    /// `can_be_taken`, `lapses`, `due` or `cap_room`.
    pub kind: NextKind,
    /// The task (0 for `cap_room`).
    pub serial: u64,
}

/// What the next date is about.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NextKind {
    /// An announced task's notice ends: from now on it can be taken.
    CanBeTaken,
    /// An announced task's take window ends: it lapses.
    Lapses,
    /// A taken task is due.
    Due,
    /// The oldest take counted in the cap stops counting.
    CapRoom,
}

/// A task's state in the record (`TaskBook.State` without `None`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStateRec {
    /// Announced.
    Announced,
    /// Taken.
    Taken,
    /// Paid, in full or in part.
    Paid,
    /// Sent back.
    Rejected,
    /// Ran out, or swept by a wind-down.
    Returned,
    /// Withdrawn.
    Cancelled,
    /// The take window ended.
    Lapsed,
}

impl From<TaskState> for TaskStateRec {
    fn from(s: TaskState) -> Self {
        match s {
            TaskState::Announced => Self::Announced,
            TaskState::Taken => Self::Taken,
            TaskState::Paid => Self::Paid,
            TaskState::Rejected => Self::Rejected,
            TaskState::Returned => Self::Returned,
            TaskState::Cancelled => Self::Cancelled,
            TaskState::Lapsed => Self::Lapsed,
        }
    }
}

/// One holder's note against a task.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NoteHolderRec {
    /// The holder.
    pub account: String,
    /// The face of their note.
    pub face: String,
    /// What a claim would pay now.
    pub claimable: String,
}

/// The notes against a task.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TaskNotesRec {
    /// The face of all the notes against the task.
    pub face_total: String,
    /// The holders listed (at most 20, largest first); empty when `holders_cut`.
    pub holders: Vec<NoteHolderRec>,
    /// True when the list is cut or not given for this row.
    pub holders_cut: bool,
}

/// One task.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TaskRowRec {
    /// The task's number, never reused.
    pub serial: u64,
    /// The hash tied to the team's task record (its event id).
    pub what: String,
    /// Who may take it; none when open to anyone.
    pub payee: Option<String>,
    /// Where it is on the network.
    pub state: TaskStateRec,
    /// The share of the pot it may ask for, in ten-thousandths.
    pub share_bps: u64,
    /// The most it may set aside.
    pub max_dollars: String,
    /// The most a take at `asOf.time` would set aside; only while it can be taken.
    pub at_most_now: Option<String>,
    /// When it was announced.
    pub announced_at: u64,
    /// The first second it can be taken.
    pub notice_end: u64,
    /// The end of the take window while announced; the deadline once taken.
    pub expires_at: u64,
    /// Who took it.
    pub taken_by: Option<String>,
    /// When it was taken.
    pub taken_at: Option<u64>,
    /// When it is due.
    pub deadline: Option<u64>,
    /// L: what the take moved out of the project's money.
    pub set_aside: String,
    /// C: the stayers' claim while taken.
    pub stayer_claim: String,
    /// N: the face of the notes against it.
    pub note_face: String,
    /// What the worker was paid.
    pub pay: String,
    /// What came back when it ended.
    pub returned: String,
    /// What is still held for the claims of its notes.
    pub notes_left: String,
    /// What this take still counts in the cap.
    pub cap_bps: u64,
    /// When it ended.
    pub resolved_at: Option<u64>,
    /// The transaction that ended it.
    pub resolved_tx: Option<String>,
    /// The earlier plan of the same task record this row repeats.
    pub repeat_of: Option<u64>,
    /// The notes against it.
    pub notes: Option<TaskNotesRec>,
}

/// What the cut left out.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CutRec {
    /// The most ended rows listed.
    pub max_ended: u64,
    /// Ended rows with no notes left are kept this long after they ended.
    pub ended_within_secs: u64,
    /// Ended rows that were eligible and did not fit.
    pub ended_dropped: u64,
    /// Rows with notes still to claim that did not fit.
    pub notes_rows_dropped: u64,
}

/// The project's tasks.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TasksRec {
    /// The project's task book.
    pub book: String,
    /// The block of `TasksReady`: the first block the book can have logs in.
    pub book_block: u64,
    /// The serial the next plan gets.
    pub next_serial: u64,
    /// Tasks announced or taken, not ended.
    pub open_count: u64,
    /// The earliest second an open task runs out.
    pub next_expiry: Option<u64>,
    /// What the contracts allow.
    pub limits: LimitsTasksRec,
    /// The 28-day cap.
    pub cap: CapRec,
    /// The next date something can happen.
    pub next: Option<NextRec>,
    /// The rows: open tasks first (serial ascending), then ended ones (serial descending).
    pub list: Vec<TaskRowRec>,
    /// What the cut left out.
    pub cut: CutRec,
    /// True when the cut left something out or a note list was cut.
    pub truncated: bool,
}

// ------------------------------------------------------------------ the cut

/// The ended rows a record lists, chosen from the ledger alone.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Selection {
    /// The open rows, by serial ascending.
    pub open: Vec<u64>,
    /// The ended rows, by serial descending.
    pub ended: Vec<u64>,
    /// Ended rows that were eligible and did not fit.
    pub ended_dropped: u64,
    /// Rows with notes still to claim that did not fit.
    pub notes_rows_dropped: u64,
    /// The window in which a row with no notes left is kept.
    pub ended_within: u64,
    /// For each listed row whose note holders are listed: the serials.
    pub holder_rows: BTreeSet<u64>,
}

/// What a row still has to claim: its held money once ended; its note face while
/// taken (the ranking of rows whose holders are listed).
fn still_to_claim(k: &LTask) -> u128 {
    if k.state.is_open() {
        k.note_face
    } else {
        k.notes_left
    }
}

/// Choose the rows (1.5): every open row; of the ended ones, first those with
/// notes still to be claimed (largest `notesLeft` first, then newest, at most
/// 24, whatever their age), then those that moved money within the window
/// (newest first), then at most 4 that moved nothing; 32 in all. Written
/// newest first.
pub fn select(book: &TaskLedger, now: u64, cap_window_secs: u64) -> Selection {
    let ended_within = cap_window_secs.max(ENDED_FLOOR_SECS);
    let tasks = &book.tasks;
    let open: Vec<u64> = tasks
        .values()
        .filter(|k| k.state.is_open())
        .map(|k| k.serial)
        .collect();
    let ended_all: Vec<&LTask> = tasks.values().filter(|k| !k.state.is_open()).collect();
    let recent = |k: &LTask| {
        k.resolved_at
            .is_some_and(|at| at.saturating_add(ended_within) > now)
    };

    // 1. money a leaver can still claim, whatever the age.
    let mut with_notes: Vec<&LTask> = ended_all
        .iter()
        .copied()
        .filter(|k| k.notes_left > 0)
        .collect();
    with_notes.sort_by(|a, b| {
        b.notes_left
            .cmp(&a.notes_left)
            .then(b.serial.cmp(&a.serial))
    });
    let notes_rows_dropped = with_notes.len().saturating_sub(MAX_NOTE_ROWS) as u64;
    let mut ended: Vec<u64> = with_notes
        .iter()
        .take(MAX_NOTE_ROWS)
        .map(|k| k.serial)
        .collect();

    // 2. rows that moved money, within the window, newest first.
    let mut moved: Vec<&LTask> = ended_all
        .iter()
        .copied()
        .filter(|k| k.notes_left == 0 && k.set_aside > 0 && recent(k))
        .collect();
    moved.sort_by_key(|k| std::cmp::Reverse(k.serial));
    let mut dropped = 0u64;
    for k in moved {
        if ended.len() < MAX_ENDED_ROWS {
            ended.push(k.serial);
        } else {
            dropped += 1;
        }
    }

    // 3. cancelled and lapsed rows (no money moved), within the window, at most 4.
    let mut quiet: Vec<&LTask> = ended_all
        .iter()
        .copied()
        .filter(|k| k.notes_left == 0 && k.set_aside == 0 && recent(k))
        .collect();
    quiet.sort_by_key(|k| std::cmp::Reverse(k.serial));
    let mut quiet_listed = 0;
    for k in quiet {
        if quiet_listed < MAX_QUIET_ROWS && ended.len() < MAX_ENDED_ROWS {
            ended.push(k.serial);
            quiet_listed += 1;
        } else {
            dropped += 1;
        }
    }
    ended.sort_unstable_by(|a, b| b.cmp(a));

    // The 8 rows with the most still to claim carry their note holders.
    let mut ranked: Vec<&LTask> = open
        .iter()
        .chain(ended.iter())
        .filter_map(|s| tasks.get(s))
        .filter(|k| still_to_claim(k) > 0)
        .collect();
    ranked.sort_by(|a, b| {
        still_to_claim(b)
            .cmp(&still_to_claim(a))
            .then(b.serial.cmp(&a.serial))
    });
    let holder_rows = ranked
        .iter()
        .take(MAX_NOTE_HOLDER_ROWS)
        .map(|k| k.serial)
        .collect();
    Selection {
        open,
        ended,
        ended_dropped: dropped,
        notes_rows_dropped,
        ended_within,
        holder_rows,
    }
}

impl Selection {
    /// The rows in the order the record lists them.
    pub fn serials(&self) -> impl Iterator<Item = u64> + '_ {
        self.open.iter().chain(self.ended.iter()).copied()
    }

    /// The `(serial, holder)` pairs whose note the views are asked for: for
    /// each row whose holders are listed, its first 20 holders.
    pub fn listed_holders(&self, book: &TaskLedger) -> Vec<(u64, String)> {
        self.holder_rows
            .iter()
            .flat_map(|serial| {
                book.holders_of(*serial)
                    .into_iter()
                    .take(MAX_NOTE_HOLDERS)
                    .map(move |(h, _)| (*serial, h.clone()))
            })
            .collect()
    }

    /// The `(serial, holder)` whose `claimableNote` is read: the largest holder
    /// of each listed row that has notes.
    pub fn largest_holders(&self, book: &TaskLedger) -> Vec<(u64, String)> {
        self.holder_rows
            .iter()
            .filter_map(|serial| {
                book.holders_of(*serial)
                    .first()
                    .map(|(h, _)| (*serial, (*h).clone()))
            })
            .collect()
    }
}

// ------------------------------------------------------------- the numbers

/// The most a take at the settled pot would set aside: the smaller of the
/// task's stated dollars and its stated share of the pot, rounded down
/// (`TaskBook.take`). Repeated here because no view gives it.
pub fn at_most_now(max_dollars: u128, share_bps: u16, pot: u128) -> anyhow::Result<u128> {
    let share = mul_div(pot, u128::from(share_bps), BPS)
        .ok_or_else(|| anyhow!("the share of the pot does not fit"))?;
    Ok(max_dollars.min(share))
}

/// The next date something can happen strictly after `now`, from the rows and
/// the first date room comes back in the cap: the earliest of a notice ending
/// (`can_be_taken`), a take window ending (`lapses`), a deadline (`due`) and
/// room (`cap_room`). Ties go in that order, then to the lowest serial.
pub fn next_date(ledger: &Ledger, now: u64, frees: &[FreeRec]) -> Option<NextRec> {
    let mut best: Option<(u64, u8, u64, NextKind)> = None;
    let mut offer = |at: u64, rank: u8, serial: u64, kind: NextKind| {
        if at > now && best.is_none_or(|b| (at, rank, serial) < (b.0, b.1, b.2)) {
            best = Some((at, rank, serial, kind));
        }
    };
    for k in ledger.tasks.open() {
        match k.state {
            TaskState::Announced => {
                offer(k.notice_end, 0, k.serial, NextKind::CanBeTaken);
                offer(k.expires_at, 1, k.serial, NextKind::Lapses);
            }
            TaskState::Taken => offer(
                k.deadline.unwrap_or(k.expires_at),
                2,
                k.serial,
                NextKind::Due,
            ),
            _ => {}
        }
    }
    if let Some(first) = frees.first() {
        offer(first.at, 3, 0, NextKind::CapRoom);
    }
    best.map(|(at, _, serial, kind)| NextRec { at, kind, serial })
}

// -------------------------------------------------------------- the section

fn small(v: u128, what: &str) -> anyhow::Result<u64> {
    u64::try_from(v).map_err(|_| anyhow!("{what} does not fit 64 bits"))
}

/// What a claim of a note of `face` against `k` would pay at `t`: nothing while
/// the task is open (a taken task past its deadline that nobody has settled
/// counts as ended: a claim settles first and pays the whole face, as the
/// settled pot counts what ran out as back); nothing when the task was paid in
/// full; otherwise the contract's own rounding of the share of what came back.
fn claimable_of(k: &LTask, face: u128, t: u64) -> anyhow::Result<u128> {
    if k.state.is_open() {
        let overdue = k.state == TaskState::Taken && k.expires_at <= t;
        return Ok(if overdue { face } else { 0 });
    }
    if k.returned == 0 || k.set_aside == 0 {
        return Ok(0);
    }
    mul_div(face, k.returned, k.set_aside)
        .ok_or_else(|| anyhow!("the claim on task {} does not fit", k.serial))
}

fn notes_of(
    ledger: &Ledger,
    k: &LTask,
    sel: &Selection,
    t: u64,
) -> anyhow::Result<Option<TaskNotesRec>> {
    if k.note_face == 0 && k.notes_left == 0 {
        return Ok(None);
    }
    let all = ledger.tasks.holders_of(k.serial);
    let listed = sel.holder_rows.contains(&k.serial);
    let mut holders = Vec::new();
    if listed {
        for (account, face) in all.iter().take(MAX_NOTE_HOLDERS) {
            holders.push(NoteHolderRec {
                account: (*account).clone(),
                face: face.to_string(),
                claimable: claimable_of(k, *face, t)?.to_string(),
            });
        }
    }
    Ok(Some(TaskNotesRec {
        face_total: k.note_face.to_string(),
        holders_cut: !listed || all.len() > MAX_NOTE_HOLDERS,
        holders,
    }))
}

fn row_of(
    ledger: &Ledger,
    k: &LTask,
    sel: &Selection,
    t: u64,
    pot: u128,
) -> anyhow::Result<TaskRowRec> {
    let at_most = (k.state == TaskState::Announced && t < k.expires_at)
        .then(|| at_most_now(k.max_dollars, k.share_bps, pot))
        .transpose()?;
    Ok(TaskRowRec {
        serial: k.serial,
        what: k.what.clone(),
        payee: k.payee.clone(),
        state: k.state.into(),
        share_bps: u64::from(k.share_bps),
        max_dollars: k.max_dollars.to_string(),
        at_most_now: at_most.map(|a| a.to_string()),
        announced_at: k.announced_at,
        notice_end: k.notice_end,
        expires_at: k.expires_at,
        taken_by: k.taken_by.clone(),
        taken_at: k.taken_at,
        deadline: k.deadline,
        set_aside: k.set_aside.to_string(),
        stayer_claim: k.stayer.to_string(),
        note_face: k.note_face.to_string(),
        pay: k.pay.to_string(),
        returned: k.returned.to_string(),
        notes_left: k.notes_left.to_string(),
        cap_bps: small(k.cap_bps(), "a take's share of the cap")?,
        resolved_at: k.resolved_at,
        resolved_tx: k.resolved_tx.map(|tx| hex0x(&tx)),
        repeat_of: ledger.tasks.repeat_of(k),
        notes: notes_of(ledger, k, sel, t)?,
    })
}

/// The limits the book's constants and `noticeFor(1)` give.
fn limits_of(book: &BookViews, unit: u64) -> anyhow::Result<LimitsTasksRec> {
    Ok(LimitsTasksRec {
        max_open: small(book.max_open, "MAX_OPEN")?,
        max_share_bps: small(book.max_share_bps, "MAX_SHARE_BPS")?,
        cap_bps: small(book.cap_bps, "CAP_BPS")?,
        min_task: book.min_task.to_string(),
        cap_window_secs: book.cap_window_secs(unit)?,
        take_window_secs: small(book.notice_for_one[1], "the take window")?,
        due_secs: small(book.notice_for_one[2], "the time to the deadline")?,
    })
}

/// The `tasks` section of the record at `t` with the settled pot `pot`, or
/// `None` for a project with no task book. The rows, the notes, the cap and
/// `next` come from the ledger (the events); the constants and the limits come
/// from the book's views.
pub fn build(ledger: &Ledger, v: &Views, t: u64, pot: u128) -> anyhow::Result<Option<TasksRec>> {
    let (Some(book), Some(addr), Some(book_block)) = (
        v.book.as_ref(),
        ledger.contracts.tasks.as_ref(),
        ledger.book_block,
    ) else {
        return Ok(None);
    };
    let book_ledger = &ledger.tasks;
    json_safe_serial(book_ledger.next_serial)?;
    let unit = ledger.unit;
    let limits = limits_of(book, unit)?;
    let span = limits.cap_window_secs;
    // The cap, settled: the takes counted now less the share the next settle
    // gives back for a taken task past its deadline.
    let counted = book_ledger.window_sum(t, span);
    let pending = book_ledger.pending_give_back(t, span);
    let used = counted
        .checked_sub(pending)
        .ok_or_else(|| anyhow!("the pending give-back is more than the cap's takes"))?;
    let used_bps = small(used, "the cap's used share")?;
    let room_bps = limits
        .cap_bps
        .checked_sub(used_bps)
        .ok_or_else(|| anyhow!("the cap's takes are more than the cap"))?;
    let frees: Vec<FreeRec> = book_ledger
        .frees(t, span)
        .into_iter()
        .map(|(at, bps)| {
            Ok(FreeRec {
                at,
                bps: small(bps, "a take's share")?,
            })
        })
        .collect::<anyhow::Result<_>>()?;
    let next = next_date(ledger, t, &frees);
    let selection = select(book_ledger, t, span);
    let mut list = Vec::new();
    for serial in selection.serials() {
        let k = book_ledger
            .tasks
            .get(&serial)
            .ok_or_else(|| anyhow!("task {serial} is listed but was never announced"))?;
        if !book.tasks.contains_key(&serial) {
            bail!("the views of task {serial} were not read");
        }
        list.push(row_of(ledger, k, &selection, t, pot)?);
    }
    let note_cut = list
        .iter()
        .any(|r| r.notes.as_ref().is_some_and(|n| n.holders_cut));
    let truncated = selection.ended_dropped > 0 || selection.notes_rows_dropped > 0 || note_cut;
    Ok(Some(TasksRec {
        book: addr.clone(),
        book_block,
        next_serial: book_ledger.next_serial,
        open_count: book_ledger.open_count,
        next_expiry: book_ledger.next_expiry(),
        limits,
        cap: CapRec {
            used_bps,
            room_bps,
            frees,
        },
        next,
        list,
        cut: CutRec {
            max_ended: MAX_ENDED_ROWS as u64,
            ended_within_secs: selection.ended_within,
            ended_dropped: selection.ended_dropped,
            notes_rows_dropped: selection.notes_rows_dropped,
        },
        truncated,
    }))
}

/// Check that a serial is one a JSON integer carries exactly.
pub fn json_safe_serial(next_serial: u64) -> anyhow::Result<()> {
    if next_serial > MAX_JSON_SERIAL {
        bail!("the book's serials passed 2^53: {next_serial}");
    }
    Ok(())
}

#[cfg(test)]
#[path = "record_tasks_tests.rs"]
mod tests;
