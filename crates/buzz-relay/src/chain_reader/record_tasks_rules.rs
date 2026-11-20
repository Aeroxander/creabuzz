//! The rules a record's `tasks` section must pass on its own, before it is
//! signed (RECORD-V2 section 10.5): what a reader of the signed record can redo
//! from the record alone. The cross-checks against the contracts' views are in
//! `numbers_tasks`; these catch a record that is wrong in itself, whatever the
//! views said.
//!
//! Every rule names what it found. A section whose rows were cut (the record says
//! so in `cut`) is checked as far as the listed rows allow: a sum over the listed
//! rows is then a floor, not the whole.

use anyhow::anyhow;

use super::ledger_tasks::RING;
use super::record::{amount, is_hex, mul_div, Record};
use super::record_tasks::{
    FreeRec, NextKind, NextRec, TaskRowRec, TaskStateRec, ENDED_FLOOR_SECS, MAX_ENDED_ROWS,
    MAX_JSON_SERIAL, MAX_NOTE_HOLDERS, MAX_NOTE_HOLDER_ROWS, MAX_NOTE_ROWS, MAX_OPEN_ROWS,
    MAX_QUIET_ROWS,
};

/// Parts of ten thousand.
const BPS: u128 = 10_000;

fn is_open(s: TaskStateRec) -> bool {
    matches!(s, TaskStateRec::Announced | TaskStateRec::Taken)
}

fn is_live_plan(s: TaskStateRec) -> bool {
    matches!(
        s,
        TaskStateRec::Announced | TaskStateRec::Taken | TaskStateRec::Paid
    )
}

/// A row's amounts, read once.
struct Amounts {
    max: u128,
    set_aside: u128,
    stayer: u128,
    note_face: u128,
    pay: u128,
    returned: u128,
    notes_left: u128,
}

fn amounts(k: &TaskRowRec) -> anyhow::Result<Amounts> {
    let a = |text: &str, name: &str| amount(text, &format!("task {} {name}", k.serial));
    Ok(Amounts {
        max: a(&k.max_dollars, "maxDollars")?,
        set_aside: a(&k.set_aside, "setAside")?,
        stayer: a(&k.stayer_claim, "stayerClaim")?,
        note_face: a(&k.note_face, "noteFace")?,
        pay: a(&k.pay, "pay")?,
        returned: a(&k.returned, "returned")?,
        notes_left: a(&k.notes_left, "notesLeft")?,
    })
}

/// The next date something can happen strictly after `now`, redone from the
/// open rows and the cap's dates: the earliest of a notice ending, a take window
/// ending, a deadline and room coming back; ties in that order, then the lowest
/// serial (the same rule the builder follows, written again from the rows).
fn next_of_rows(rows: &[TaskRowRec], frees: &[FreeRec], now: u64) -> Option<NextRec> {
    let mut best: Option<(u64, u8, u64, NextKind)> = None;
    let mut offer = |at: u64, rank: u8, serial: u64, kind: NextKind| {
        if at > now && best.is_none_or(|b| (at, rank, serial) < (b.0, b.1, b.2)) {
            best = Some((at, rank, serial, kind));
        }
    };
    for k in rows {
        match k.state {
            TaskStateRec::Announced => {
                offer(k.notice_end, 0, k.serial, NextKind::CanBeTaken);
                offer(k.expires_at, 1, k.serial, NextKind::Lapses);
            }
            TaskStateRec::Taken => offer(
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

/// The task section's own rules. Pushes one line per broken rule.
pub(super) fn check(r: &Record, bad: &mut Vec<String>) -> anyhow::Result<()> {
    let Some(tasks) = &r.tasks else {
        return Ok(());
    };
    let mut rule = |ok: bool, what: String| {
        if !ok {
            bad.push(what);
        }
    };
    let now = r.as_of.time;
    let pot = amount(&r.money.pot, "money.pot")?;
    let notes_owed = amount(&r.money.notes_owed, "money.notesOwed")?;
    let lim = &tasks.limits;
    let cut = &tasks.cut;
    let rows = &tasks.list;

    // The list: open rows first by serial, then ended rows newest first; no
    // serial twice; every serial one the book has handed out.
    let open: Vec<&TaskRowRec> = rows.iter().filter(|k| is_open(k.state)).collect();
    let ended: Vec<&TaskRowRec> = rows.iter().filter(|k| !is_open(k.state)).collect();
    rule(
        rows.iter().take(open.len()).all(|k| is_open(k.state)),
        "tasks.list lists the open rows first".into(),
    );
    rule(
        open.windows(2).all(|w| w[0].serial < w[1].serial),
        "tasks.list lists the open rows by serial, lowest first, none twice".into(),
    );
    rule(
        ended.windows(2).all(|w| w[0].serial > w[1].serial),
        "tasks.list lists the ended rows by serial, newest first, none twice".into(),
    );
    rule(
        rows.iter()
            .all(|k| k.serial >= 1 && k.serial < tasks.next_serial && k.serial <= MAX_JSON_SERIAL),
        format!(
            "tasks.list has a serial that is not between 1 and nextSerial {}",
            tasks.next_serial
        ),
    );
    rule(
        open.len() as u64 == tasks.open_count,
        format!(
            "tasks.openCount is {} but {} open rows are listed",
            tasks.open_count,
            open.len()
        ),
    );
    rule(
        tasks.open_count <= lim.max_open && open.len() <= MAX_OPEN_ROWS,
        format!("more than {} tasks are open", lim.max_open),
    );
    rule(
        ended.len() <= MAX_ENDED_ROWS && cut.max_ended == MAX_ENDED_ROWS as u64,
        "tasks lists more ended rows than its cut allows".into(),
    );
    rule(
        tasks.next_expiry == open.iter().map(|k| k.expires_at).min(),
        "tasks.nextExpiry is not the earliest end of an open row".into(),
    );

    // Each row on its own.
    for k in rows {
        let s = k.serial;
        let m = amounts(k)?;
        let taken_fields = k.taken_by.is_some() && k.taken_at.is_some() && k.deadline.is_some();
        let no_take = k.taken_by.is_none() && k.taken_at.is_none() && k.deadline.is_none();
        let untouched = m.set_aside == 0
            && m.stayer == 0
            && m.note_face == 0
            && m.pay == 0
            && m.returned == 0
            && m.notes_left == 0;
        rule(
            is_hex(&k.what, 32)
                && k.payee.as_deref().is_none_or(|p| is_hex(p, 20))
                && k.taken_by.as_deref().is_none_or(|p| is_hex(p, 20))
                && k.resolved_tx.as_deref().is_none_or(|p| is_hex(p, 32)),
            format!("task {s} has a value that is not lower-case hex"),
        );
        rule(
            (1..=lim.max_share_bps).contains(&k.share_bps)
                && m.max >= amount(&lim.min_task, "tasks.limits.minTask")?
                && k.announced_at <= k.notice_end
                && k.notice_end <= k.expires_at,
            format!("task {s} has a share, size or date outside what the book allows"),
        );
        rule(
            k.cap_bps <= lim.cap_bps,
            format!("task {s} counts more in the cap than the cap"),
        );
        rule(
            k.resolved_at.is_some() != is_open(k.state)
                && k.resolved_at.is_some() == k.resolved_tx.is_some(),
            format!(
                "task {s}: an end time and transaction are given exactly for a task that has ended"
            ),
        );
        rule(
            k.resolved_at.is_none_or(|at| at >= k.announced_at),
            format!("task {s} ended before it was announced"),
        );
        match k.state {
            TaskStateRec::Announced => rule(
                no_take && untouched && k.cap_bps == 0 && k.notes.is_none(),
                format!("task {s} is announced but shows a take or money"),
            ),
            TaskStateRec::Cancelled | TaskStateRec::Lapsed => rule(
                no_take && untouched && k.cap_bps == 0 && k.notes.is_none(),
                format!("task {s} ended without a take but shows a take or money"),
            ),
            TaskStateRec::Taken => {
                rule(
                    taken_fields
                        && k.deadline == Some(k.expires_at)
                        && k.taken_at.map(|at| at.saturating_add(lim.due_secs)) == k.deadline,
                    format!("task {s} is taken but its take or deadline is wrong"),
                );
                rule(
                    m.stayer.checked_add(m.note_face) == Some(m.set_aside) && m.set_aside > 0,
                    format!(
                        "task {s}: what was set aside {} is not the stayers' claim {} and the notes' face {}",
                        m.set_aside, m.stayer, m.note_face
                    ),
                );
                rule(
                    m.pay == 0 && m.returned == 0 && m.notes_left == 0,
                    format!("task {s} is taken but shows a payment or a return"),
                );
            }
            TaskStateRec::Paid | TaskStateRec::Rejected | TaskStateRec::Returned => {
                rule(
                    taken_fields && m.set_aside > 0 && m.stayer == 0,
                    format!("task {s} ended after a take but its take or claim is wrong"),
                );
                rule(
                    m.pay.checked_add(m.returned) == Some(m.set_aside)
                        && (k.state == TaskStateRec::Paid || m.pay == 0),
                    format!(
                        "task {s}: paid {} and returned {} are not what was set aside {}",
                        m.pay, m.returned, m.set_aside
                    ),
                );
            }
        }
        rule(
            k.repeat_of
                .is_none_or(|first| first < s && is_live_plan(k.state)),
            format!("task {s} repeats a task that does not come before it, or is not a live plan"),
        );
        // What a take sets aside now: for a task that can still be taken.
        let can_be_taken = k.state == TaskStateRec::Announced && now < k.expires_at;
        let at_most = if can_be_taken {
            let share = mul_div(pot, u128::from(k.share_bps), BPS)
                .ok_or_else(|| anyhow!("task {s}: the share of the pot does not fit"))?;
            Some(m.max.min(share).to_string())
        } else {
            None
        };
        rule(
            k.at_most_now == at_most,
            format!(
                "task {s}: atMostNow is {:?} but the smaller of its dollars and its share of the pot is {:?}",
                k.at_most_now, at_most
            ),
        );
        // Its notes.
        let any_notes = m.note_face != 0 || m.notes_left != 0;
        rule(
            k.notes.is_some() == any_notes,
            format!("task {s}: notes are listed exactly when something is held for them"),
        );
        if let Some(n) = &k.notes {
            let face_total = amount(&n.face_total, "notes.faceTotal")?;
            rule(
                face_total == m.note_face,
                format!("task {s}: notes.faceTotal is not its noteFace"),
            );
            rule(
                n.holders.len() <= MAX_NOTE_HOLDERS,
                format!("task {s} lists more note holders than the cut allows"),
            );
            let mut sum = 0u128;
            let mut in_order = true;
            let mut previous: Option<(u128, &str)> = None;
            for h in &n.holders {
                let face = amount(&h.face, "notes.holders.face")?;
                let claimable = amount(&h.claimable, "notes.holders.claimable")?;
                sum = sum.saturating_add(face);
                rule(
                    is_hex(&h.account, 20),
                    format!("task {s}: note holder {} is not lower-case hex", h.account),
                );
                if let Some((f, a)) = previous {
                    in_order &= f > face || (f == face && a < h.account.as_str());
                }
                previous = Some((face, h.account.as_str()));
                // What a claim pays now: nothing while the task is open (all of it
                // once a taken task has run out), nothing for a task paid in full,
                // otherwise the share of what came back.
                let overdue = k.state == TaskStateRec::Taken && k.expires_at <= now;
                let want = if is_open(k.state) {
                    if overdue {
                        face
                    } else {
                        0
                    }
                } else if m.returned == 0 || m.set_aside == 0 {
                    0
                } else {
                    mul_div(face, m.returned, m.set_aside)
                        .ok_or_else(|| anyhow!("task {s}: a claim does not fit"))?
                };
                rule(
                    claimable == want,
                    format!(
                        "task {s}: {} can claim {claimable} but the note's share of what came back is {want}",
                        h.account
                    ),
                );
            }
            rule(
                in_order,
                format!("task {s}: note holders are not largest first, then by address"),
            );
            rule(
                sum <= face_total && (n.holders_cut || sum == face_total),
                format!("task {s}: the notes listed add up to {sum}, not the face {face_total}"),
            );
            rule(
                !n.holders_cut || n.holders.is_empty() || n.holders.len() == MAX_NOTE_HOLDERS,
                format!("task {s}: a cut note list is empty (not given) or full"),
            );
        }
    }

    // The same task record planned twice: the lowest live plan of a record binds
    // and every later live row of it names a plan that comes first.
    for k in rows.iter().filter(|k| is_live_plan(k.state)) {
        let first = rows
            .iter()
            .filter(|o| is_live_plan(o.state) && o.what == k.what)
            .map(|o| o.serial)
            .min();
        if let Some(first) = first.filter(|f| *f < k.serial) {
            rule(
                k.repeat_of.is_some_and(|r| r <= first),
                format!(
                    "task {} plans the record of task {first} again but says so by {:?}",
                    k.serial, k.repeat_of
                ),
            );
        }
    }

    // The notes at most 8 rows list holders for.
    rule(
        rows.iter()
            .filter(|k| k.notes.as_ref().is_some_and(|n| !n.holders_cut))
            .count()
            <= MAX_NOTE_HOLDER_ROWS,
        "more rows than the cut allows list their note holders".into(),
    );

    // The money held for notes: the listed rows give all of it unless the cut
    // left a row out.
    let mut held = 0u128;
    for k in rows {
        let m = amounts(k)?;
        held = held.saturating_add(if is_open(k.state) {
            m.note_face
        } else {
            m.notes_left
        });
    }
    rule(
        if cut.notes_rows_dropped == 0 {
            held == notes_owed
        } else {
            held <= notes_owed
        },
        format!(
            "money.notesOwed is {notes_owed} but the listed rows hold {held} for their notes (cut: {} rows left out)",
            cut.notes_rows_dropped
        ),
    );

    // The cap: the room is what is left; the dates add up to the used share; and the
    // takes of the listed rows give both.
    let cap = &tasks.cap;
    rule(
        cap.used_bps.checked_add(cap.room_bps) == Some(lim.cap_bps),
        format!(
            "tasks.cap: used {} and room {} are not the cap {}",
            cap.used_bps, cap.room_bps, lim.cap_bps
        ),
    );
    rule(
        cap.frees.len() <= RING
            && cap.frees.windows(2).all(|w| w[0].at <= w[1].at)
            && cap.frees.iter().all(|f| f.at > now && f.bps > 0)
            && cap.frees.iter().map(|f| f.bps).sum::<u64>() == cap.used_bps,
        "tasks.cap.frees are not the dates the used share comes back, oldest first, adding up to it".into(),
    );
    let mut takes: Vec<(u64, u64, u64)> = rows
        .iter()
        .filter(|k| k.cap_bps > 0)
        .filter_map(|k| {
            let at = k.taken_at?;
            let due = k.state == TaskStateRec::Taken && k.deadline.is_some_and(|d| d <= now);
            (at.saturating_add(lim.cap_window_secs) > now && !due).then_some((
                at.saturating_add(lim.cap_window_secs),
                k.serial,
                k.cap_bps,
            ))
        })
        .collect();
    takes.sort_unstable();
    let from_rows: u64 = takes.iter().map(|t| t.2).sum();
    let whole = cut.ended_dropped == 0 && cut.notes_rows_dropped == 0;
    rule(
        if whole {
            from_rows == cap.used_bps
        } else {
            from_rows <= cap.used_bps
        },
        format!(
            "tasks.cap.usedBps is {} but the takes of the listed rows still in the window are {from_rows}",
            cap.used_bps
        ),
    );
    if whole {
        let dates: Vec<(u64, u64)> = takes.iter().map(|t| (t.0, t.2)).collect();
        rule(
            dates == cap.frees.iter().map(|f| (f.at, f.bps)).collect::<Vec<_>>(),
            "tasks.cap.frees are not the takes of the listed rows still in the window".into(),
        );
    }

    // The next date.
    let open_rows: Vec<TaskRowRec> = open.iter().map(|k| (*k).clone()).collect();
    rule(
        tasks.next == next_of_rows(&open_rows, &cap.frees, now),
        "tasks.next is not the earliest date something can happen".into(),
    );

    // The cut says what it did.
    rule(
        cut.ended_within_secs == lim.cap_window_secs.max(ENDED_FLOOR_SECS),
        "tasks.cut.endedWithinSecs is not the longer of the cap's window and 28 days".into(),
    );
    let with_notes = ended
        .iter()
        .filter(|k| amount(&k.notes_left, "notesLeft").is_ok_and(|n| n > 0))
        .count();
    let quiet = ended
        .iter()
        .filter(|k| matches!(k.state, TaskStateRec::Cancelled | TaskStateRec::Lapsed))
        .count();
    rule(
        with_notes <= MAX_NOTE_ROWS && quiet <= MAX_QUIET_ROWS,
        "tasks lists more ended rows with notes, or that moved nothing, than the cut allows".into(),
    );
    rule(
        ended.iter().all(|k| {
            let kept_for_notes = amount(&k.notes_left, "notesLeft").is_ok_and(|n| n > 0);
            kept_for_notes
                || k.resolved_at
                    .is_some_and(|at| at.saturating_add(cut.ended_within_secs) > now)
        }),
        "tasks lists an ended row older than the cut keeps, with nothing left to claim".into(),
    );
    let note_cut = rows
        .iter()
        .any(|k| k.notes.as_ref().is_some_and(|n| n.holders_cut));
    rule(
        tasks.truncated == (cut.ended_dropped > 0 || cut.notes_rows_dropped > 0 || note_cut),
        "tasks.truncated is not true exactly when the cut left something out".into(),
    );
    Ok(())
}
