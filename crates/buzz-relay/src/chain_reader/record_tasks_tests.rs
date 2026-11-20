//! The `tasks` section: the cut of rows and note holders, the dates, the amount a take sets
//! aside, and the size of the worst record. Rows are made by hand where a run cannot reach the
//! case (thirty-three withdrawn tasks, a book with the most the cut allows).

use serde_json::Value;

use super::*;
use crate::chain_reader::fixture::Fixture;
use crate::chain_reader::ledger::{Ledger, LogRow};
use crate::chain_reader::ledger_tasks::{LTask, TaskLedger, TaskState};
use crate::chain_reader::record::{Record, MAX_AGENTS, MAX_GRANTS, MAX_HOLDERS};

const UNIT: u64 = 604_800;
const WINDOW: u64 = 4 * UNIT;

fn task(serial: u64, state: TaskState) -> LTask {
    LTask {
        serial,
        state,
        what: format!("0x{serial:064x}"),
        payee: Some("0x00000000000000000000000000000000000000a1".to_owned()),
        max_dollars: 400_000_000,
        share_bps: 100,
        announced_at: 1_000,
        notice_end: 2_000,
        expires_at: 3_000,
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
    }
}

/// An ended task that moved money: `notes_left` is still held for the claims of its notes.
fn moved(serial: u64, state: TaskState, ended: u64, notes_left: u128) -> LTask {
    let mut k = task(serial, state);
    k.set_aside = 100_000_000;
    k.returned = 100_000_000;
    k.notes_left = notes_left;
    k.note_face = notes_left;
    k.resolved_at = Some(ended);
    k
}

fn withdrawn(serial: u64, ended: u64) -> LTask {
    let mut k = task(serial, TaskState::Cancelled);
    k.resolved_at = Some(ended);
    k
}

fn book_of(tasks: Vec<LTask>) -> TaskLedger {
    let mut book = TaskLedger::new();
    for k in tasks {
        book.next_serial = book.next_serial.max(k.serial + 1);
        book.tasks.insert(k.serial, k);
    }
    book
}

const NOW: u64 = 1_000 * 86_400;

/// A11: the rows with money still to claim come first whatever their age, and thirty-three cheap
/// withdrawn tasks cannot push a leaver's note out of the list.
#[test]
fn the_ended_rows_keep_every_row_with_notes_first_and_33_cancelled_tasks_cannot_push_a_note_out() {
    let mut tasks = vec![
        // A task that ended a year ago and still holds money for a note: always listed.
        moved(1, TaskState::Returned, NOW - 365 * 86_400, 5_000),
        // Another that ended long ago with nothing left to claim: aged out, not counted as dropped.
        moved(2, TaskState::Paid, NOW - 200 * 86_400, 0),
    ];
    for i in 0..33 {
        tasks.push(withdrawn(10 + i, NOW - 3_600 - i));
    }
    let book = book_of(tasks);
    let sel = select(&book, NOW, WINDOW);
    assert!(
        sel.ended.contains(&1),
        "the old task with a note to claim is listed"
    );
    assert!(
        !sel.ended.contains(&2),
        "an old task with nothing to claim is not"
    );
    let withdrawn_listed = sel.ended.iter().filter(|s| **s >= 10).count();
    // The plan says "at most 4": a literal, so that moving the constant fails here.
    assert_eq!(withdrawn_listed, 4, "at most four rows that moved nothing");
    assert_eq!(MAX_QUIET_ROWS, 4);
    assert_eq!(sel.ended_dropped, 29, "the cut says how many it left out");
    assert_eq!(sel.notes_rows_dropped, 0);
    // Newest serial first.
    assert!(sel.ended.windows(2).all(|w| w[0] > w[1]));
    // More rows with notes than the cap: the smallest are left out and counted.
    let many: Vec<LTask> = (1..=30)
        .map(|i| {
            moved(
                i,
                TaskState::Returned,
                NOW - 86_400 * i,
                1_000 + u128::from(i),
            )
        })
        .collect();
    let sel = select(&book_of(many), NOW, WINDOW);
    assert_eq!(sel.ended.len(), MAX_NOTE_ROWS);
    assert_eq!(sel.notes_rows_dropped, 30 - MAX_NOTE_ROWS as u64);
    let kept: std::collections::BTreeSet<u64> = sel.ended.iter().copied().collect();
    assert!(
        (7..=30).all(|s| kept.contains(&s)) && (1..7).all(|s| !kept.contains(&s)),
        "the largest notes stay (here the highest serials hold the most)"
    );
}

/// A11: an ended row is kept for the window and not a second longer: 28 days to the second (the cap's window here is
/// exactly 28 days, so the floor and the window agree).
#[test]
fn an_ended_row_is_kept_for_28_days_to_the_second() {
    const DAYS_28: u64 = 28 * 86_400;
    assert_eq!(WINDOW, DAYS_28);
    let book = book_of(vec![
        moved(1, TaskState::Paid, NOW - DAYS_28, 0),
        moved(2, TaskState::Paid, NOW - DAYS_28 + 1, 0),
        withdrawn(3, NOW - DAYS_28),
        withdrawn(4, NOW - DAYS_28 + 1),
    ]);
    let sel = select(&book, NOW, WINDOW);
    assert_eq!(
        sel.ended,
        vec![4, 2],
        "the rows that ended a second inside the window are listed, those that ended exactly 28 days ago are not"
    );
    assert_eq!(sel.ended_within, DAYS_28);
}

/// A9: `atMostNow` is for a task that can still be taken: an announced one before its take window ends. At the very
/// second it ends, the next settle lapses it and the field is gone.
#[tokio::test]
async fn at_most_now_stops_at_the_second_a_take_window_ends() {
    let (_, ledger, as_of, chain) = crate::chain_reader::record_tests::load("A_example");
    let open = ledger
        .tasks
        .tasks
        .values()
        .find(|k| k.state == TaskState::Announced)
        .expect("the example has an announced task");
    let (serial, expires_at) = (open.serial, open.expires_at);
    let read = crate::chain_reader::views::read(
        &chain,
        Fixture::load().launcher,
        &ledger,
        as_of.block,
        as_of.time,
    )
    .await
    .expect("the honest answers read");
    let row_at = |t: u64| -> Option<String> {
        let section = build(&ledger, &read, t, 10_000_000_000)
            .expect("builds")
            .expect("a book");
        section
            .list
            .iter()
            .find(|row| row.serial == serial)
            .expect("the task is listed")
            .at_most_now
            .clone()
    };
    assert!(
        row_at(expires_at - 1).is_some(),
        "one second before the end"
    );
    assert_eq!(row_at(expires_at), None, "at the second it ends");
    assert_eq!(row_at(expires_at + 1), None, "after it");
}

/// A11: the cut says how many rows it left out, and what falls in each part of it.
#[test]
fn the_cut_says_how_many_rows_it_left_out() {
    // 40 rows that moved money within the window and none with notes: 32 fit.
    let tasks: Vec<LTask> = (1..=40)
        .map(|i| moved(i, TaskState::Paid, NOW - 86_400 - i, 0))
        .collect();
    let sel = select(&book_of(tasks), NOW, WINDOW);
    assert_eq!(sel.ended.len(), MAX_ENDED_ROWS);
    assert_eq!(sel.ended_dropped, 8);
    assert_eq!(sel.ended[0], 40, "the newest first");
    assert_eq!(
        sel.ended_within,
        ENDED_FLOOR_SECS.max(WINDOW),
        "the window floor is 28 days"
    );
    // A longer cap window keeps ended rows longer.
    let sel = select(&book_of(vec![]), NOW, 90 * 86_400);
    assert_eq!(sel.ended_within, 90 * 86_400);
    // Open rows are always listed, serial ascending, and the cut never touches them.
    let mut open = vec![task(3, TaskState::Announced), task(1, TaskState::Taken)];
    open.push(moved(2, TaskState::Paid, NOW - 5, 0));
    let sel = select(&book_of(open), NOW, WINDOW);
    assert_eq!(sel.open, vec![1, 3]);
    assert_eq!(sel.ended, vec![2]);
}

/// The note holders listed: for the eight rows with the most still to claim, twenty each, largest
/// first; the others carry none and say so.
#[test]
fn note_holders_are_listed_for_eight_rows_and_twenty_holders_each() {
    let mut book = book_of(
        (1..=10)
            .map(|i| moved(i, TaskState::Returned, NOW - 100, 1_000 * u128::from(i)))
            .collect(),
    );
    for serial in 1..=10u64 {
        for h in 0..25u64 {
            book.notes
                .insert((serial, format!("0x{h:040x}")), 1_000 + u128::from(h));
        }
    }
    let sel = select(&book, NOW, WINDOW);
    assert_eq!(sel.holder_rows.len(), MAX_NOTE_HOLDER_ROWS);
    assert!(
        sel.holder_rows.contains(&10)
            && !sel.holder_rows.contains(&1)
            && !sel.holder_rows.contains(&2),
        "the rows with the most still to claim"
    );
    let holders = sel.listed_holders(&book);
    assert_eq!(holders.len(), MAX_NOTE_HOLDER_ROWS * MAX_NOTE_HOLDERS);
    assert_eq!(sel.largest_holders(&book).len(), MAX_NOTE_HOLDER_ROWS);
    // Largest face first within a row.
    let first_row: Vec<&String> = holders
        .iter()
        .filter(|(s, _)| *s == 10)
        .map(|(_, h)| h)
        .collect();
    assert_eq!(first_row[0], &format!("0x{:040x}", 24));
}

/// A9: the amount a take sets aside is the smaller of the stated dollars and the stated share of the
/// settled pot, rounded down: every real take of the run set aside exactly what `atMostNow` says.
#[test]
fn the_amount_a_take_sets_aside_is_the_at_most_now_formula_at_the_settled_pot() {
    let fx = Fixture::load();
    let rows = fx.rows("A", fx.head());
    let mut checked = 0;
    let announced: std::collections::BTreeMap<String, &LogRow> = rows
        .iter()
        .filter(|r| r.event == "TaskAnnounced")
        .map(|r| (r.fields["serial"].as_str().expect("serial").to_owned(), r))
        .collect();
    for take in rows
        .iter()
        .filter(|r| r.event == "TaskMoney" && r.fields["kind"] == "1")
    {
        let serial = take.fields["serial"].as_str().expect("serial");
        let plan = announced[serial];
        let amount: u128 = take.fields["amount"]
            .as_str()
            .expect("amount")
            .parse()
            .expect("number");
        let pot_after: u128 = take.fields["potAfter"]
            .as_str()
            .expect("pot")
            .parse()
            .expect("number");
        // The pot the take saw, settled, is what was left plus what was set aside.
        let pot = pot_after + amount;
        let max: u128 = plan.fields["maxDollars"]
            .as_str()
            .expect("max")
            .parse()
            .expect("number");
        let share: u16 = plan.fields["shareBps"]
            .as_str()
            .expect("share")
            .parse()
            .expect("number");
        assert_eq!(
            at_most_now(max, share, pot).expect("fits"),
            amount,
            "task {serial}: the take set aside what atMostNow says"
        );
        checked += 1;
    }
    assert!(checked >= 4, "{checked} takes were checked");
    // The share is the binding limit for some and the stated dollars for others in this run or the
    // formula would be half tested: check both ways by hand.
    assert_eq!(
        at_most_now(400_000_000, 100, 10_000_000_000).expect("fits"),
        100_000_000
    );
    assert_eq!(
        at_most_now(400_000_000, 500, 100_000_000_000).expect("fits"),
        400_000_000
    );
}

/// The next date: the earliest of a notice ending, a window ending, a deadline and room coming back,
/// strictly after now; ties in that order, then the lowest serial.
#[test]
fn the_next_date_is_the_earliest_and_ties_go_in_a_fixed_order() {
    let mut a = task(1, TaskState::Announced);
    a.notice_end = 5_000;
    a.expires_at = 9_000;
    let mut b = task(2, TaskState::Taken);
    b.deadline = Some(5_000);
    b.expires_at = 5_000;
    let book = book_of(vec![a, b]);
    let mut ledger = Ledger::from_logs(&Fixture::load().rows("A", Fixture::load().head()))
        .expect("reads")
        .expect("launched");
    ledger.tasks = book;
    let frees = [FreeRec {
        at: 5_000,
        bps: 100,
    }];
    // At the same second: a notice ending, a deadline and room: the notice first.
    let next = next_date(&ledger, 4_999, &frees).expect("a date");
    assert_eq!(
        (next.at, next.kind, next.serial),
        (5_000, NextKind::CanBeTaken, 1)
    );
    // Past it: the next is later; none is in the past.
    let next = next_date(&ledger, 5_000, &frees).expect("a date");
    assert_eq!(
        (next.at, next.kind, next.serial),
        (9_000, NextKind::Lapses, 1)
    );
    assert!(
        next_date(&ledger, 9_000, &[]).is_none(),
        "nothing left to happen"
    );
    let next = next_date(
        &ledger,
        100,
        &[FreeRec { at: 50, bps: 1 }, FreeRec { at: 5_000, bps: 1 }],
    );
    assert_eq!(
        next.map(|n| n.kind),
        Some(NextKind::CanBeTaken),
        "a past free date is not next"
    );
}

#[test]
fn a_serial_past_2_to_the_53_fails_the_build() {
    assert!(json_safe_serial(MAX_JSON_SERIAL).is_ok());
    assert!(json_safe_serial(MAX_JSON_SERIAL + 1).is_err());
}

fn full_row(serial: u64, note_holders: usize) -> TaskRowRec {
    let big = "9".repeat(30);
    TaskRowRec {
        serial,
        what: format!("0x{}", "f".repeat(64)),
        payee: Some(format!("0x{}", "e".repeat(40))),
        state: TaskStateRec::Returned,
        share_bps: 500,
        max_dollars: big.clone(),
        at_most_now: Some(big.clone()),
        announced_at: 1_803_000_000,
        notice_end: 1_803_000_000,
        expires_at: 1_803_000_000,
        taken_by: Some(format!("0x{}", "d".repeat(40))),
        taken_at: Some(1_803_000_000),
        deadline: Some(1_803_000_000),
        set_aside: big.clone(),
        stayer_claim: big.clone(),
        note_face: big.clone(),
        pay: big.clone(),
        returned: big.clone(),
        notes_left: big.clone(),
        cap_bps: 500,
        resolved_at: Some(1_803_000_000),
        resolved_tx: Some(format!("0x{}", "c".repeat(64))),
        repeat_of: Some(1),
        notes: Some(TaskNotesRec {
            face_total: big.clone(),
            holders: (0..note_holders)
                .map(|_| NoteHolderRec {
                    account: format!("0x{}", "b".repeat(40)),
                    face: big.clone(),
                    claimable: big.clone(),
                })
                .collect(),
            holders_cut: true,
        }),
    }
}

/// A11: the largest record the cuts allow, with 200 holders, 200 grants, 50 agents and a full task
/// list, stays under 300 KB (the plan's bound; the frame is 512 KB).
#[test]
fn the_worst_record_is_under_300_kb() {
    let text = include_str!("../../../../docs/next-version/record-v2-example.json");
    let mut record: Record = serde_json::from_str(text).expect("the example parses");
    let holder = record.holders[0].clone();
    record.holders = vec![holder; MAX_HOLDERS];
    let grant = record.team.grants[0].clone();
    record.team.grants = vec![grant; MAX_GRANTS];
    let agent_text = serde_json::to_value(&record.agents).expect("agents");
    let agent = agent_text
        .get(0)
        .cloned()
        .map(|a| serde_json::from_value(a).expect("an agent"))
        .unwrap_or_else(|| super::super::record::AgentRec {
            agent: format!("0x{}", "a".repeat(40)),
            live: true,
            usd_cap: "9".repeat(30),
            team_cap: "9".repeat(30),
            usd_used: "9".repeat(30),
            team_used: "9".repeat(30),
        });
    record.agents = vec![agent; MAX_AGENTS];
    let mut tasks = record.tasks.take().expect("a book");
    let mut rows = Vec::new();
    for serial in 1..=(MAX_OPEN_ROWS + MAX_ENDED_ROWS) as u64 {
        // Twenty holders for each of the eight rows that carry them, none for the rest.
        rows.push(full_row(
            serial,
            if serial <= 8 { MAX_NOTE_HOLDERS } else { 0 },
        ));
    }
    tasks.list = rows;
    tasks.cap.frees = (0..16)
        .map(|i| FreeRec {
            at: 1_803_000_000 + i,
            bps: 500,
        })
        .collect();
    record.tasks = Some(tasks);
    let size = serde_json::to_string(&record).expect("written").len();
    assert!(size < 300_000, "the worst record is {size} bytes");
    assert!(size > 100_000, "and the test is not empty: {size} bytes");
    let _ = Value::Null;
}
