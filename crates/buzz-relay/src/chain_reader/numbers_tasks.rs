//! The cross-checks of the `tasks` section against the contracts' own views
//! (plan section 2.5, RECORD-V2 section 10.5).
//!
//! The ledger rebuilt every task and every note from the book's events. Here
//! each number the views also give must be the same, at the one block the record
//! is true for, and the numbers that must add up (the money set aside, the money
//! held for notes, a task's claim and notes against its face) must add up over
//! **all** the tasks the ledger holds, not only the rows the record lists. A line
//! is added for each disagreement, naming the field and both values; the caller
//! fails the whole build on any line (C33): the previous record stays, and every
//! money field of the project freezes with it, which the app's age rules say.

use anyhow::{anyhow, Context};

use super::ledger::Ledger;
use super::ledger_tasks::{LTask, TaskState};
use super::record_tasks::contract_claim;
use super::views::{BookViews, TaskView, Views};
use super::word::hex0x;

/// One line of trouble: `what: events say X, the contract says Y`.
fn put(bad: &mut Vec<String>, what: impl AsRef<str>, events: impl ToString, view: impl ToString) {
    bad.push(format!(
        "{}: events say {}, the contract says {}",
        what.as_ref(),
        events.to_string(),
        view.to_string()
    ));
}

/// The fields of one task the ledger and `taskOf` must agree on, as
/// `(name, what the events say, what the contract says)`. Names are the
/// contract's own (`locked` is the amount set aside).
fn row_fields(k: &LTask, view: &TaskView) -> anyhow::Result<Vec<(&'static str, String, String)>> {
    let zero = hex0x(&[0u8; 20]);
    let text = |v: u128| v.to_string();
    Ok(vec![
        ("what", k.what.clone(), view.bytes32("what")?),
        (
            "payee",
            k.payee.clone().unwrap_or_else(|| zero.clone()),
            view.address("payee")?,
        ),
        (
            "state",
            text(u128::from(k.state.code())),
            text(view.uint("state")?),
        ),
        (
            "shareBps",
            text(u128::from(k.share_bps)),
            text(view.uint("shareBps")?),
        ),
        (
            "ringIdx",
            text(k.ring_idx.unwrap_or(0) as u128),
            text(view.uint("ringIdx")?),
        ),
        (
            "takenBy",
            k.taken_by.clone().unwrap_or_else(|| zero.clone()),
            view.address("takenBy")?,
        ),
        (
            "announcedAt",
            text(u128::from(k.announced_at)),
            text(view.uint("announcedAt")?),
        ),
        (
            "noticeEnd",
            text(u128::from(k.notice_end)),
            text(view.uint("noticeEnd")?),
        ),
        (
            "expiresAt",
            text(u128::from(k.expires_at)),
            text(view.uint("expiresAt")?),
        ),
        (
            "takenAt",
            text(u128::from(k.taken_at.unwrap_or(0))),
            text(view.uint("takenAt")?),
        ),
        (
            "deadline",
            text(u128::from(k.deadline.unwrap_or(0))),
            text(view.uint("deadline")?),
        ),
        (
            "maxDollars",
            text(k.max_dollars),
            text(view.uint("maxDollars")?),
        ),
        (
            "locked (set aside)",
            text(k.set_aside),
            text(view.uint("locked")?),
        ),
        (
            "stayer (the stayers' claim)",
            text(k.stayer),
            text(view.uint("stayer")?),
        ),
        ("noteFace", text(k.note_face), text(view.uint("noteFace")?)),
        ("returned", text(k.returned), text(view.uint("returned")?)),
        (
            "notesLeft",
            text(k.notes_left),
            text(view.uint("notesLeft")?),
        ),
    ])
}

/// Where the events and the book's views must agree and add up. Returns one
/// line per disagreement; empty when the project has no book and no task
/// events, or when everything agrees.
pub(super) fn cross_check(ledger: &Ledger, v: &Views, t: u64) -> anyhow::Result<Vec<String>> {
    let mut bad = Vec::new();
    let tl = &ledger.tasks;
    let Some(book) = v.book.as_ref() else {
        if !tl.tasks.is_empty() {
            bad.push("tasks: the events name tasks but the Treasury never named a book".into());
        }
        return Ok(bad);
    };

    // The counts, and the room the cap leaves.
    let open_rows = tl.tasks.values().filter(|k| k.state.is_open()).count() as u128;
    if open_rows != u128::from(tl.open_count) {
        put(&mut bad, "tasks open rows", open_rows, tl.open_count);
    }
    if u128::from(tl.open_count) > book.max_open {
        put(
            &mut bad,
            "tasks openCount is more than MAX_OPEN",
            tl.open_count,
            book.max_open,
        );
    }
    let top = tl.tasks.keys().next_back().copied().unwrap_or(0);
    if tl.next_serial != top + 1 {
        put(&mut bad, "tasks nextSerial", tl.next_serial, top + 1);
    }
    let span = book.cap_window_secs(ledger.unit)?;
    let room = book.cap_bps.saturating_sub(tl.window_sum(t, span));
    if room != book.take_room_bps {
        put(&mut bad, "takeRoomBps", room, book.take_room_bps);
    }
    let next_expiry = u128::from(tl.next_expiry().unwrap_or(0));
    if next_expiry != v.t("nextExpiry")? {
        put(&mut bad, "nextExpiry", next_expiry, v.t("nextExpiry")?);
    }

    // Each listed task, field by field.
    for (serial, view) in &book.tasks {
        let Some(k) = tl.tasks.get(serial) else {
            bad.push(format!(
                "task {serial} is in the book but its events were never read"
            ));
            continue;
        };
        for (name, events, said) in row_fields(k, view)? {
            if events != said {
                put(&mut bad, format!("task {serial} {name}"), events, said);
            }
        }
    }

    // The money buckets, over every task the ledger holds.
    let mut set_aside = 0u128;
    let mut held_for_notes = 0u128;
    for k in tl.tasks.values() {
        if k.state == TaskState::Taken {
            set_aside = set_aside
                .checked_add(k.stayer)
                .ok_or_else(|| anyhow!("the stayers' claims overflow"))?;
        }
        let held = if k.state.is_open() {
            k.note_face
        } else {
            k.notes_left
        };
        held_for_notes = held_for_notes
            .checked_add(held)
            .ok_or_else(|| anyhow!("the money held for notes overflows"))?;
    }
    if set_aside != v.t("locked")? {
        put(
            &mut bad,
            "locked (the running tasks' claims added up)",
            set_aside,
            v.t("locked")?,
        );
    }
    if held_for_notes != v.t("notesOwed")? {
        put(
            &mut bad,
            "notesOwed (note faces of open tasks and what is left for the notes of ended ones)",
            held_for_notes,
            v.t("notesOwed")?,
        );
    }

    // Each task adds up: C + N = L while taken; the holders' notes are the face;
    // an ended task paid and gave back what it set aside.
    for k in tl.tasks.values() {
        let serial = k.serial;
        if k.state == TaskState::Taken && k.stayer.checked_add(k.note_face) != Some(k.set_aside) {
            put(
                &mut bad,
                format!("task {serial} set aside is the stayers' claim and the notes' face"),
                format!("{} + {}", k.stayer, k.note_face),
                k.set_aside,
            );
        }
        let notes: u128 = tl
            .notes
            .range((serial, String::new())..)
            .take_while(|((s, _), _)| *s == serial)
            .map(|(_, face)| *face)
            .sum();
        if notes != k.note_face {
            put(
                &mut bad,
                format!("task {serial} the holders' notes added up"),
                notes,
                k.note_face,
            );
        }
        if !k.state.is_open() && k.state != TaskState::Cancelled && k.state != TaskState::Lapsed {
            if k.pay.checked_add(k.returned) != Some(k.set_aside) {
                put(
                    &mut bad,
                    format!("task {serial} paid plus returned is what was set aside"),
                    format!("{} + {}", k.pay, k.returned),
                    k.set_aside,
                );
            }
            if k.state != TaskState::Paid && k.pay != 0 {
                put(
                    &mut bad,
                    format!("task {serial} was paid though it did not end paid"),
                    k.pay,
                    0,
                );
            }
        }
    }

    notes_check(ledger, book, &mut bad)?;
    Ok(bad)
}

/// The listed holders' notes and the largest holder's claim of each row, against
/// `noteOf` and `claimableNote`.
fn notes_check(ledger: &Ledger, book: &BookViews, bad: &mut Vec<String>) -> anyhow::Result<()> {
    let tl = &ledger.tasks;
    for ((serial, holder), said) in &book.note_of {
        let events = tl
            .notes
            .get(&(*serial, holder.clone()))
            .copied()
            .unwrap_or(0);
        if events != *said {
            put(bad, format!("task {serial} note of {holder}"), events, said);
        }
    }
    for ((serial, holder), said) in &book.claimable {
        let k = tl
            .tasks
            .get(serial)
            .ok_or_else(|| anyhow!("task {serial} has a claim read but no events"))?;
        let face = tl
            .notes
            .get(&(*serial, holder.clone()))
            .copied()
            .unwrap_or(0);
        let events = contract_claim(k, face).with_context(|| format!("task {serial}'s claim"))?;
        if events != *said {
            put(
                bad,
                format!("task {serial} claimable note of {holder}"),
                events,
                said,
            );
        }
    }
    Ok(())
}
