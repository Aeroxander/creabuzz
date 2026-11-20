//! A project's task book, rebuilt from its events alone.
//!
//! This is the reader's port of `contracts/pot/test/helpers/TaskLedger.sol`,
//! which a ledger of events passes after every step of a 500-step random run
//! and of a scripted walk that reaches every path. Every event of the book
//! carries the numbers the contract leaves behind (`openAfter`,
//! `noteFaceAfter`, `notesLeftAfter`, `stayerAfter`, `capGivenBack`), so nothing
//! here recomputes a task's money from other fields: it keeps what the events
//! say, one "after" snapshot per event. A row that does not read as its event
//! says is an error, never skipped.
//!
//! The 28-day cap is the contract's own ring of the last 16 takes
//! (`TaskBook._takes`), kept place by place so that a take given back is cleared
//! where the contract clears it.
//!
//! Memory is bounded by outstanding notes, not by history: a holder's note is
//! dropped when it is claimed, and a task's notes are dropped when the task was
//! paid in full (its notes are void). The per-task numbers stay.

use std::collections::BTreeMap;

use anyhow::{anyhow, bail, Context};

use super::ledger::LogRow;
use super::word::hex0x;

/// The places in the cap's ring of takes (`TaskBook.RING`).
pub const RING: usize = 16;

/// Where a task is (`TaskBook.State`, without `None`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TaskState {
    /// Announced, not taken.
    Announced,
    /// Taken, money set aside.
    Taken,
    /// Paid in full or in part.
    Paid,
    /// Sent back by the runner: nothing paid.
    Rejected,
    /// Ran out (or was swept by a wind-down): nothing paid.
    Returned,
    /// Withdrawn before a take.
    Cancelled,
    /// The take window ended with no take.
    Lapsed,
}

impl TaskState {
    /// The state a contract code names (`TaskBook.State`: 1 Announced to 7
    /// Lapsed). Zero (`None`) is not a state a row can be in.
    pub fn from_code(code: u128) -> Option<Self> {
        Some(match code {
            1 => Self::Announced,
            2 => Self::Taken,
            3 => Self::Paid,
            4 => Self::Rejected,
            5 => Self::Returned,
            6 => Self::Cancelled,
            7 => Self::Lapsed,
            _ => return None,
        })
    }

    /// The contract's code.
    pub fn code(self) -> u8 {
        match self {
            Self::Announced => 1,
            Self::Taken => 2,
            Self::Paid => 3,
            Self::Rejected => 4,
            Self::Returned => 5,
            Self::Cancelled => 6,
            Self::Lapsed => 7,
        }
    }

    /// Announced or taken: counted in the book's open count.
    pub fn is_open(self) -> bool {
        matches!(self, Self::Announced | Self::Taken)
    }

    /// Announced, taken or paid: a plan that binds its task record
    /// (`repeatOf`).
    pub fn is_live_plan(self) -> bool {
        matches!(self, Self::Announced | Self::Taken | Self::Paid)
    }
}

/// One task, as the book's events tell it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LTask {
    /// The task's number, never reused.
    pub serial: u64,
    /// Where it is.
    pub state: TaskState,
    /// The hash tied to the team's task record (lower-case `0x` text, 32 bytes).
    pub what: String,
    /// Who may take it; `None` when open to anyone.
    pub payee: Option<String>,
    /// The most it may set aside.
    pub max_dollars: u128,
    /// The share of the pot it may ask for, in ten-thousandths.
    pub share_bps: u16,
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
    /// When it is due (set at the take).
    pub deadline: Option<u64>,
    /// L: what the take moved out of the pot.
    pub set_aside: u128,
    /// C: the stayers' claim while taken.
    pub stayer: u128,
    /// N: the face of the notes against it.
    pub note_face: u128,
    /// What the worker was paid.
    pub pay: u128,
    /// What came back when it ended.
    pub returned: u128,
    /// What is still held for the claims of its notes.
    pub notes_left: u128,
    /// The take's share in the cap when it was taken (ten-thousandths).
    pub take_bps: u128,
    /// What the take no longer counts in the cap.
    pub cap_given_back: u128,
    /// The ring place of its take.
    pub ring_idx: Option<usize>,
    /// The block time of the event that ended it.
    pub resolved_at: Option<u64>,
    /// The transaction that ended it.
    pub resolved_tx: Option<[u8; 32]>,
}

impl LTask {
    /// What this take still counts in the cap: its share less what was given
    /// back (zero when it was never taken).
    pub fn cap_bps(&self) -> u128 {
        self.take_bps.saturating_sub(self.cap_given_back)
    }
}

/// One place of the cap's ring (`TaskBook._takes[i]`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RingSlot {
    /// The take's time (zero for a place never used).
    pub at: u64,
    /// What the take still counts, in ten-thousandths of the pot at the take.
    pub bps: u128,
    /// The task the take was for (zero for a place never used).
    pub serial: u64,
}

/// A project's tasks as its book's events tell them.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TaskLedger {
    /// Every task ever announced, by serial.
    pub tasks: BTreeMap<u64, LTask>,
    /// What each holder holds against a task: only notes still to be claimed
    /// (a claimed or void note is dropped).
    pub notes: BTreeMap<(u64, String), u128>,
    /// The cap's ring of takes.
    pub ring: [RingSlot; RING],
    /// The next place a take is written to.
    pub take_idx: usize,
    /// The serials that share a `what`, in announce order.
    pub whats: BTreeMap<String, Vec<u64>>,
    /// Open tasks (announced or taken), as the last event said.
    pub open_count: u64,
    /// The serial the next announce gets.
    pub next_serial: u64,
}

fn text<'a>(row: &'a LogRow, name: &str) -> anyhow::Result<&'a str> {
    row.fields
        .get(name)
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| anyhow!("{}.{name} is missing or not text", row.event))
}

fn num(row: &LogRow, name: &str) -> anyhow::Result<u128> {
    text(row, name)?
        .parse::<u128>()
        .with_context(|| format!("{}.{name} is not an amount", row.event))
}

fn small(row: &LogRow, name: &str) -> anyhow::Result<u64> {
    u64::try_from(num(row, name)?).with_context(|| format!("{}.{name} is too large", row.event))
}

fn sub(a: u128, b: u128, what: &str) -> anyhow::Result<u128> {
    a.checked_sub(b)
        .ok_or_else(|| anyhow!("{what} would go below zero ({a} less {b})"))
}

fn add(a: u128, b: u128, what: &str) -> anyhow::Result<u128> {
    a.checked_add(b)
        .ok_or_else(|| anyhow!("{what} is too large"))
}

impl TaskLedger {
    /// An empty book: no task yet, the first serial is 1.
    pub fn new() -> Self {
        Self {
            next_serial: 1,
            ..Self::default()
        }
    }

    fn task(&mut self, row: &LogRow) -> anyhow::Result<&mut LTask> {
        let serial = small(row, "serial")?;
        self.tasks.get_mut(&serial).ok_or_else(|| {
            anyhow!(
                "{} names task {serial}, which was never announced",
                row.event
            )
        })
    }

    /// Count one event of the book. Returns whether the event is one the book
    /// ledger counts.
    pub fn apply(&mut self, row: &LogRow) -> anyhow::Result<bool> {
        match row.event.as_str() {
            "TaskAnnounced" => self.announced(row)?,
            "TaskTaken" => self.taken(row)?,
            "TaskResolved" => self.resolved(row)?,
            "NoteMinted" => self.minted(row)?,
            "NoteClaimed" => self.claimed(row)?,
            _ => return Ok(false),
        }
        Ok(true)
    }

    fn announced(&mut self, row: &LogRow) -> anyhow::Result<()> {
        let serial = small(row, "serial")?;
        if self.tasks.contains_key(&serial) {
            bail!("task {serial} was announced twice");
        }
        let zero = hex0x(&[0u8; 20]);
        let payee = text(row, "payee")?.to_owned();
        let what = text(row, "what")?.to_owned();
        let share = num(row, "shareBps")?;
        let task = LTask {
            serial,
            state: TaskState::Announced,
            what: what.clone(),
            payee: (payee != zero).then_some(payee),
            max_dollars: num(row, "maxDollars")?,
            share_bps: u16::try_from(share).context("TaskAnnounced.shareBps")?,
            announced_at: small(row, "announcedAt")?,
            notice_end: small(row, "noticeEnd")?,
            expires_at: small(row, "expiresAt")?,
            taken_by: None,
            taken_at: None,
            deadline: None,
            set_aside: 0,
            stayer: 0,
            note_face: 0,
            pay: 0,
            returned: 0,
            notes_left: 0,
            take_bps: 0,
            cap_given_back: 0,
            ring_idx: None,
            resolved_at: None,
            resolved_tx: None,
        };
        self.tasks.insert(serial, task);
        self.whats.entry(what).or_default().push(serial);
        self.open_count = num(row, "openAfter")?
            .try_into()
            .context("TaskAnnounced.openAfter")?;
        self.next_serial = add(u128::from(serial), 1, "the next serial")?
            .try_into()
            .context("the next serial")?;
        Ok(())
    }

    fn taken(&mut self, row: &LogRow) -> anyhow::Result<()> {
        let serial = small(row, "serial")?;
        let amount = num(row, "amount")?;
        let bps = num(row, "takeBps")?;
        let at = small(row, "takenAt")?;
        let deadline = small(row, "deadline")?;
        let taker = text(row, "takenBy")?.to_owned();
        let open: u64 = num(row, "openAfter")?
            .try_into()
            .context("TaskTaken.openAfter")?;
        let idx = self.take_idx;
        {
            let k = self.task(row)?;
            if k.state != TaskState::Announced {
                bail!("task {serial} was taken but it was not announced");
            }
            k.state = TaskState::Taken;
            k.taken_by = Some(taker);
            k.taken_at = Some(at);
            k.deadline = Some(deadline);
            k.expires_at = deadline;
            k.set_aside = amount;
            k.stayer = amount;
            k.note_face = 0;
            k.take_bps = bps;
            k.ring_idx = Some(idx);
        }
        self.ring[idx] = RingSlot { at, bps, serial };
        self.take_idx = (idx + 1) % RING;
        self.open_count = open;
        Ok(())
    }

    fn resolved(&mut self, row: &LogRow) -> anyhow::Result<()> {
        let serial = small(row, "serial")?;
        let code = num(row, "state")?;
        let state = TaskState::from_code(code)
            .filter(|s| !s.is_open())
            .ok_or_else(|| anyhow!("task {serial} ended in state {code}, which is not an end"))?;
        let (pay, returned, pool) = (
            num(row, "pay")?,
            num(row, "returned")?,
            num(row, "notesPool")?,
        );
        let face = num(row, "noteFaceAfter")?;
        let open: u64 = num(row, "openAfter")?
            .try_into()
            .context("TaskResolved.openAfter")?;
        let given = num(row, "capGivenBack")?;
        let ring_idx = {
            let k = self.task(row)?;
            if !k.state.is_open() {
                bail!("task {serial} ended twice");
            }
            k.state = state;
            // The stayers' claim ends with the task; the notes keep what was held for them.
            k.stayer = 0;
            k.pay = pay;
            k.returned = returned;
            k.notes_left = pool;
            k.note_face = face;
            k.cap_given_back = given;
            k.resolved_at = Some(row.time);
            k.resolved_tx = Some(row.tx);
            k.ring_idx
        };
        self.open_count = open;
        if given != 0 {
            // A task that ended with nothing paid gives its take back to the 28-day cap.
            let idx = ring_idx
                .ok_or_else(|| anyhow!("task {serial} gave back a take it never had in the cap"))?;
            let slot = &mut self.ring[idx];
            slot.bps = sub(slot.bps, given, "a take in the cap")?;
        }
        if face == 0 {
            // Paid in full (or every note gone): no note of this task can be claimed.
            self.notes.retain(|(s, _), _| *s != serial);
        }
        Ok(())
    }

    fn minted(&mut self, row: &LogRow) -> anyhow::Result<()> {
        let serial = small(row, "serial")?;
        let holder = text(row, "holder")?.to_owned();
        let part = num(row, "part")?;
        let stayer = num(row, "stayerAfter")?;
        let face = num(row, "noteFaceAfter")?;
        {
            let k = self.task(row)?;
            if k.state != TaskState::Taken {
                bail!("a note was written against task {serial}, which is not taken");
            }
            k.stayer = stayer;
            k.note_face = face;
        }
        let entry = self.notes.entry((serial, holder)).or_insert(0);
        *entry = add(*entry, part, "a holder's note")?;
        Ok(())
    }

    fn claimed(&mut self, row: &LogRow) -> anyhow::Result<()> {
        let serial = small(row, "serial")?;
        let holder = text(row, "holder")?.to_owned();
        let face = num(row, "noteFaceAfter")?;
        let left = num(row, "notesLeftAfter")?;
        {
            let k = self.task(row)?;
            k.note_face = face;
            k.notes_left = left;
        }
        self.notes.remove(&(serial, holder));
        Ok(())
    }

    // ------------------------------------------------------------ the cap

    /// The takes counted in the cap at `t`: those whose place still holds a
    /// share and that are not older than `span` (`TaskBook._windowSum`). This is
    /// what the view `windowSumBps()` returns at `t`.
    pub fn window_sum(&self, t: u64, span: u64) -> u128 {
        self.ring
            .iter()
            .filter(|s| s.at.saturating_add(span) > t)
            .map(|s| s.bps)
            .sum()
    }

    /// The share the next settle gives back at `t`: the take of every taken task
    /// whose deadline has passed and whose place in the ring still holds that
    /// take, if the take is still counted at `t`. A taken task past its deadline
    /// is ended unpaid by the next settle (`TaskBook.expireDue`), which gives its
    /// whole share back.
    pub fn pending_give_back(&self, t: u64, span: u64) -> u128 {
        self.pending_slots(t, span)
            .into_iter()
            .map(|i| self.ring[i].bps)
            .sum()
    }

    /// The ring places the next settle at `t` gives back.
    fn pending_slots(&self, t: u64, span: u64) -> Vec<usize> {
        self.tasks
            .values()
            .filter(|k| k.state == TaskState::Taken && k.expires_at <= t)
            .filter_map(|k| {
                let idx = k.ring_idx?;
                let slot = &self.ring[idx];
                (slot.at == k.taken_at.unwrap_or(0) && slot.at.saturating_add(span) > t)
                    .then_some(idx)
            })
            .collect()
    }

    /// The takes still counted at `t` that will stay counted after the next
    /// settle, oldest first: `(when the room comes back, share)`. Places that
    /// hold nothing and the pending give-back are left out, so the shares add up
    /// to `window_sum(t) - pending_give_back(t)`.
    pub fn frees(&self, t: u64, span: u64) -> Vec<(u64, u128)> {
        let pending = self.pending_slots(t, span);
        let mut live: Vec<(u64, u64, u128)> = self
            .ring
            .iter()
            .enumerate()
            .filter(|(i, s)| s.bps != 0 && s.at.saturating_add(span) > t && !pending.contains(i))
            .map(|(_, s)| (s.at, s.serial, s.bps))
            .collect();
        live.sort();
        live.into_iter()
            .map(|(at, _, bps)| (at.saturating_add(span), bps))
            .collect()
    }

    // ------------------------------------------------------------- the rows

    /// The earliest second an open task runs out (the end of a take window or a
    /// deadline); `None` when none is open (`Treasury.nextExpiry()`, zero when
    /// none).
    pub fn next_expiry(&self) -> Option<u64> {
        self.tasks
            .values()
            .filter(|k| k.state.is_open())
            .map(|k| k.expires_at)
            .min()
    }

    /// The tasks that are open (announced or taken), by serial.
    pub fn open(&self) -> impl Iterator<Item = &LTask> {
        self.tasks.values().filter(|k| k.state.is_open())
    }

    /// The serial of the earlier plan of the same task record that this row is a
    /// repeat of: the lowest serial with this `what` that is announced, taken or
    /// paid, when it is smaller than the row's own. `None` for a row that is not
    /// itself a live plan (a plan that ended unpaid binds nothing).
    pub fn repeat_of(&self, k: &LTask) -> Option<u64> {
        if !k.state.is_live_plan() {
            return None;
        }
        self.whats
            .get(&k.what)?
            .iter()
            .copied()
            .filter(|s| self.tasks.get(s).is_some_and(|t| t.state.is_live_plan()))
            .min()
            .filter(|first| *first < k.serial)
    }

    /// Every holder's note against `serial`, largest first, then by address.
    pub fn holders_of(&self, serial: u64) -> Vec<(&String, u128)> {
        let mut out: Vec<(&String, u128)> = self
            .notes
            .range((serial, String::new())..)
            .take_while(|((s, _), _)| *s == serial)
            .map(|((_, h), v)| (h, *v))
            .collect();
        out.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));
        out
    }
}

#[cfg(test)]
#[path = "ledger_tasks_tests.rs"]
mod tests;
