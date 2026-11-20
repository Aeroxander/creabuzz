//! The task ledger against the real run (`testdata/pot-run.json`), and on rows
//! made by hand where the run has no such path.
//!
//! The run plays a task announced and withdrawn, one taken and paid in part, one
//! open task taken by a stranger and sent back, one that runs out and is returned
//! by someone else's take-out, one whose take window passes, the same task record
//! planned twice, and three tasks still open at the example block (see
//! `scripts/chain-reader-fixture.py`).

use serde_json::{json, Value};

use super::*;
use crate::chain_reader::events::Role;
use crate::chain_reader::fixture::{BookChain, Fixture};
use crate::chain_reader::ledger::Ledger;
use crate::chain_reader::views_table::TASK_OF;

fn fx() -> Fixture {
    Fixture::load()
}

fn ledger_at(fx: &Fixture, project: &str, block: u64) -> Ledger {
    Ledger::from_logs(&fx.rows(project, block))
        .expect("the rows read")
        .expect("the project is launched")
}

/// A word as the node gives it: 64 hex digits.
fn uint_word(v: u128) -> String {
    format!("{v:064x}")
}

fn address_word(a: &str) -> String {
    format!("{:0>64}", a.trim_start_matches("0x"))
}

/// The 17 words `taskOf` gives for `k`, as the ledger holds the task.
fn expected_words(k: &LTask) -> Vec<String> {
    let zero = "0x0000000000000000000000000000000000000000";
    let words: Vec<(&str, String)> = vec![
        ("what", k.what.trim_start_matches("0x").to_owned()),
        ("payee", address_word(k.payee.as_deref().unwrap_or(zero))),
        ("state", uint_word(u128::from(k.state.code()))),
        ("shareBps", uint_word(u128::from(k.share_bps))),
        ("ringIdx", uint_word(k.ring_idx.unwrap_or(0) as u128)),
        (
            "takenBy",
            address_word(k.taken_by.as_deref().unwrap_or(zero)),
        ),
        ("announcedAt", uint_word(u128::from(k.announced_at))),
        ("noticeEnd", uint_word(u128::from(k.notice_end))),
        ("expiresAt", uint_word(u128::from(k.expires_at))),
        ("takenAt", uint_word(u128::from(k.taken_at.unwrap_or(0)))),
        ("deadline", uint_word(u128::from(k.deadline.unwrap_or(0)))),
        ("maxDollars", uint_word(k.max_dollars)),
        ("locked", uint_word(k.set_aside)),
        ("stayer", uint_word(k.stayer)),
        ("noteFace", uint_word(k.note_face)),
        ("returned", uint_word(k.returned)),
        ("notesLeft", uint_word(k.notes_left)),
    ];
    // The order is the build's, not this list's: place each word by the generated table.
    TASK_OF
        .iter()
        .map(|(name, _)| {
            words
                .iter()
                .find(|(n, _)| n == name)
                .unwrap_or_else(|| panic!("the test has no word for taskOf.{name}"))
                .1
                .clone()
        })
        .collect()
}

fn answer_words(answer: &str) -> Vec<String> {
    let body = answer.trim_start_matches("0x");
    (0..body.len() / 64)
        .map(|i| body[i * 64..(i + 1) * 64].to_owned())
        .collect()
}

/// A1: the ledger the book's events rebuild equals the contracts' own views for every
/// task, every holder's note, the counts and the buckets, after every block of the run
/// that changed a project.
#[test]
fn the_ledger_from_the_logs_equals_the_views_for_every_task_after_every_block_of_the_fixture() {
    let fx = fx();
    let mut compared_tasks = 0;
    let mut compared_notes = 0;
    for name in ["A", "B"] {
        for snap in fx.json["snapshots"][name].as_array().expect("snapshots") {
            let block = snap["block"].as_u64().expect("block");
            let l = ledger_at(&fx, name, block);
            let v = &snap["views"];
            let at = format!("project {name}, block {block}");
            assert_eq!(
                l.tasks.open_count.to_string(),
                v["openCount"].as_str().expect("openCount"),
                "{at}: open tasks"
            );
            assert_eq!(
                l.tasks.next_serial.to_string(),
                v["nextSerial"].as_str().expect("nextSerial"),
                "{at}: next serial"
            );
            assert_eq!(
                l.tasks
                    .window_sum(fx.time_of(block), fx.cap_window_secs())
                    .to_string(),
                v["windowSumBps"].as_str().expect("windowSumBps"),
                "{at}: the 28-day sum of takes"
            );
            let views = v["tasks"].as_object().expect("tasks");
            assert_eq!(
                views.len() as u64 + 1,
                l.tasks.next_serial,
                "{at}: every serial has an answer"
            );
            for (serial, answer) in views {
                let k = &l.tasks.tasks[&serial.parse::<u64>().expect("serial")];
                let got = expected_words(k);
                let want = answer_words(answer.as_str().expect("an answer"));
                assert_eq!(
                    want.len(),
                    TASK_OF.len(),
                    "{at}: taskOf has {} words",
                    TASK_OF.len()
                );
                for (i, (name, _)) in TASK_OF.iter().enumerate() {
                    assert_eq!(got[i], want[i], "{at}: task {serial}, {name}");
                }
                compared_tasks += 1;
            }
            // Notes: every note the view shows is the ledger's, and the ledger holds no more
            // (for the accounts the run can write a note to).
            let notes = v["notes"].as_object().expect("notes");
            for (key, face) in notes {
                let (serial, holder) = key.split_once(':').expect("serial:holder");
                let ours = l
                    .tasks
                    .notes
                    .get(&(serial.parse().expect("serial"), holder.to_owned()))
                    .copied()
                    .unwrap_or(0);
                assert_eq!(
                    ours.to_string(),
                    face.as_str().expect("face"),
                    "{at}: the note of {holder} against task {serial}"
                );
                compared_notes += 1;
            }
            let held: Vec<_> = l
                .tasks
                .notes
                .iter()
                .filter(|((_, h), _)| {
                    [
                        &fx.json["accounts"]["account2"],
                        &fx.json["accounts"]["account3"],
                        &fx.json["accounts"]["account5"],
                        &fx.json["accounts"]["account1"],
                    ]
                    .iter()
                    .any(|a| a.as_str() == Some(h.as_str()))
                })
                .collect();
            assert_eq!(
                held.len(),
                notes.len(),
                "{at}: the ledger holds a note the view does not"
            );
        }
    }
    assert!(
        compared_tasks > 100,
        "{compared_tasks} task answers were compared"
    );
    assert!(compared_notes > 5, "{compared_notes} notes were compared");
}

fn by_state(l: &Ledger, state: TaskState) -> Vec<&LTask> {
    l.tasks
        .tasks
        .values()
        .filter(|k| k.state == state)
        .collect()
}

/// A7: a take that ended with nothing paid gives its share back to the cap, a take that was
/// paid (even in part) keeps it. The same ledger that passes A1 says so.
#[test]
fn the_cap_window_sum_gives_back_a_take_that_ended_unpaid_and_keeps_a_paid_one() {
    let fx = fx();
    let l = ledger_at(&fx, "A", fx.head());
    let paid = by_state(&l, TaskState::Paid);
    assert_eq!(paid.len(), 1, "the run pays one task, in part");
    assert!(paid[0].pay > 0 && paid[0].returned > 0, "paid in part");
    assert_eq!(paid[0].cap_given_back, 0);
    assert!(paid[0].cap_bps() > 0 && paid[0].cap_bps() == paid[0].take_bps);
    for state in [TaskState::Rejected, TaskState::Returned] {
        let ended = by_state(&l, state);
        assert!(!ended.is_empty(), "the run has a {state:?} task");
        for k in ended {
            assert!(k.take_bps > 0, "it was taken");
            assert_eq!(
                k.cap_given_back, k.take_bps,
                "{state:?}: its whole share is given back"
            );
            assert_eq!(k.cap_bps(), 0);
        }
    }
    for k in by_state(&l, TaskState::Cancelled)
        .into_iter()
        .chain(by_state(&l, TaskState::Lapsed))
    {
        assert_eq!((k.take_bps, k.set_aside, k.cap_given_back), (0, 0, 0));
    }
    // Inside its 28 days the window counts the paid take; at the second a window later it does not.
    let (taken, span) = (paid[0].taken_at.expect("taken"), fx.cap_window_secs());
    assert!(l.tasks.window_sum(taken + 1, span) >= paid[0].cap_bps());
    assert_eq!(
        l.tasks.window_sum(taken + span - 1, span) - l.tasks.window_sum(taken + span, span),
        paid[0].cap_bps(),
        "its share leaves the window exactly a window after the take"
    );
}

/// A8: the dates room comes back add up to the share used, and the share a taken task past its
/// deadline will give back at the next settle is already out of both.
#[test]
fn the_ring_frees_list_adds_up_to_the_used_share() {
    let fx = fx();
    for (name, block, expect_pending) in [
        ("A_example", fx.book_block("A_example"), false),
        ("A_overdue", fx.book_block("A_overdue"), true),
    ] {
        let l = ledger_at(&fx, "A", block);
        let (t, span) = (fx.time_of(block), fx.cap_window_secs());
        let counted = l.tasks.window_sum(t, span);
        let pending = l.tasks.pending_give_back(t, span);
        assert_eq!(
            pending > 0,
            expect_pending,
            "{name}: a take waits to be given back"
        );
        let frees = l.tasks.frees(t, span);
        assert!(frees.len() <= RING);
        assert_eq!(
            frees.iter().map(|(_, bps)| *bps).sum::<u128>(),
            counted - pending,
            "{name}: the list adds up to the used share"
        );
        // Oldest first, and each room comes back a window after its take.
        assert!(
            frees.windows(2).all(|w| w[0].0 <= w[1].0),
            "{name}: oldest first"
        );
        assert!(
            frees.iter().all(|(at, _)| *at > t),
            "{name}: all still in the future"
        );
    }
    // The block where the task had run out and nobody had settled: the pending give-back is that
    // task's whole take, and it is the difference the next settle makes to the view.
    let block = fx.book_block("A_overdue");
    let l = ledger_at(&fx, "A", block);
    let (t, span) = (fx.time_of(block), fx.cap_window_secs());
    let overdue: Vec<&LTask> = l
        .tasks
        .tasks
        .values()
        .filter(|k| k.state == TaskState::Taken && k.expires_at <= t)
        .collect();
    assert_eq!(overdue.len(), 1, "one task has run out and is still taken");
    assert_eq!(l.tasks.pending_give_back(t, span), overdue[0].take_bps);
    // The next snapshot (the take-out that settled it) shows exactly that window.
    let next = fx.json["snapshots"]["A"]
        .as_array()
        .expect("snapshots")
        .iter()
        .find(|s| s["block"].as_u64().expect("block") > block)
        .expect("a later snapshot");
    let settled = l.tasks.window_sum(t, span) - l.tasks.pending_give_back(t, span);
    assert_eq!(
        settled.to_string(),
        next["views"]["windowSumBps"].as_str().expect("the sum"),
        "the used share is what the settle then gives"
    );
}

/// A3: the same task record planned twice marks the later row a repeat of the earlier, and a plan
/// that ended unpaid binds nothing.
#[test]
fn the_same_what_planned_twice_marks_the_later_row_repeat_of_the_earlier() {
    let fx = fx();
    let l = ledger_at(&fx, "A", fx.book_block("A_example"));
    let tasks = &l.tasks.tasks;
    let paid = by_state(&l, TaskState::Paid)[0];
    let repeats: Vec<&LTask> = tasks.values().filter(|k| k.what == paid.what).collect();
    assert_eq!(
        repeats.len(),
        2,
        "the run plans the paid task's record twice"
    );
    let later = repeats
        .iter()
        .find(|k| k.serial != paid.serial)
        .expect("the second plan");
    assert_eq!(later.state, TaskState::Announced);
    assert_eq!(l.tasks.repeat_of(later), Some(paid.serial));
    assert_eq!(
        l.tasks.repeat_of(paid),
        None,
        "the earlier plan is not a repeat"
    );
    // No other row repeats anything.
    for k in tasks.values() {
        if k.serial != later.serial {
            assert_eq!(l.tasks.repeat_of(k), None, "task {}", k.serial);
        }
    }
    // A plan that ended unpaid binds nothing: with the first plan gone (sent back), the second binds.
    let mut synthetic = TaskLedger::new();
    for (serial, state) in [
        (1, TaskState::Rejected),
        (2, TaskState::Announced),
        (3, TaskState::Announced),
    ] {
        let mut k = (*later).clone();
        k.serial = serial;
        k.state = state;
        synthetic.tasks.insert(serial, k);
        synthetic
            .whats
            .entry(later.what.clone())
            .or_default()
            .push(serial);
    }
    assert_eq!(synthetic.repeat_of(&synthetic.tasks[&1]), None);
    assert_eq!(
        synthetic.repeat_of(&synthetic.tasks[&2]),
        None,
        "the rejected plan binds nothing"
    );
    assert_eq!(synthetic.repeat_of(&synthetic.tasks[&3]), Some(2));
}

// ----------------------------------------------------- rows made by hand

struct Hand {
    time: u64,
    index: u32,
}

impl Hand {
    fn row(&mut self, role: Role, event: &str, fields: Value) -> LogRow {
        self.index += 1;
        LogRow {
            block: u64::from(self.index),
            log_index: 0,
            time: self.time,
            tx: [self.index as u8; 32],
            role,
            address: [0xb0; 20],
            event: event.to_owned(),
            fields,
        }
    }
}

fn announced(serial: u64, what: &str) -> Value {
    json!({"serial": serial.to_string(), "what": what, "payee": "0x0000000000000000000000000000000000000000",
           "maxDollars": "400000000", "shareBps": "100", "announcedAt": "1000", "noticeEnd": "2000",
           "expiresAt": "3000", "openAfter": "1"})
}

/// A4: the sum of every holder's notes equals the face of the notes against the task, and a task
/// paid in full has none (its notes are void: the ledger drops them).
#[test]
fn the_sum_of_every_holders_notes_equals_the_notes_face_and_a_task_paid_in_full_has_none() {
    // The real run, at the end and at the example block: every task's holders add up to its face.
    let fx = fx();
    for block in [fx.book_block("A_example"), fx.head()] {
        let l = ledger_at(&fx, "A", block);
        for k in l.tasks.tasks.values() {
            let sum: u128 = l.tasks.holders_of(k.serial).iter().map(|(_, f)| *f).sum();
            assert_eq!(sum, k.note_face, "task {} at block {block}", k.serial);
        }
    }
    // By hand: two holders, then the task is paid in full.
    let (who_a, who_b) = (
        "0x00000000000000000000000000000000000000a1",
        "0x00000000000000000000000000000000000000a2",
    );
    let mut h = Hand {
        time: 1500,
        index: 0,
    };
    let mut book = TaskLedger::new();
    let taken = json!({"serial": "1", "takenBy": who_a, "amount": "100", "takeBps": "50", "takenAt": "2001",
                       "deadline": "9000", "windowSumBpsAfter": "50", "openAfter": "1"});
    let minted = |holder: &str, part: &str, stayer: &str, face: &str| json!({"serial": "1", "holder": holder, "part": part, "stayerAfter": stayer, "noteFaceAfter": face});
    let resolved = |state: &str, pay: &str, returned: &str, pool: &str, face: &str| {
        json!({"serial": "1", "state": state, "pay": pay, "returned": returned, "notesPool": pool, "potPart": "0",
               "noteFaceAfter": face, "openAfter": "0", "capGivenBack": "0"})
    };
    for (event, fields) in [
        ("TaskAnnounced", announced(1, "0x11")),
        ("TaskTaken", taken),
        ("NoteMinted", minted(who_a, "30", "70", "30")),
        ("NoteMinted", minted(who_b, "20", "50", "50")),
    ] {
        let row = h.row(Role::Tasks, event, fields);
        assert!(book.apply(&row).expect("applies"));
    }
    assert_eq!(
        book.holders_of(1).iter().map(|(_, f)| *f).sum::<u128>(),
        book.tasks[&1].note_face
    );
    assert_eq!(
        book.holders_of(1)[0],
        (&who_a.to_owned(), 30),
        "largest first"
    );
    // Paid in full: nothing comes back, the notes are void and the ledger holds none.
    let row = h.row(
        Role::Tasks,
        "TaskResolved",
        resolved("3", "100", "0", "0", "0"),
    );
    book.apply(&row).expect("applies");
    assert!(
        book.holders_of(1).is_empty(),
        "a task paid in full has no notes"
    );
    assert_eq!(book.tasks[&1].note_face, 0);
    assert_eq!(book.tasks[&1].state, TaskState::Paid);
    assert_eq!((book.tasks[&1].pay, book.tasks[&1].returned), (100, 0));
}

/// A row that does not read as its event says, or an event out of order, is an error and never
/// skipped: a ledger that missed an event would sign a wrong number.
#[test]
fn a_book_event_that_does_not_fit_is_an_error() {
    let mut h = Hand {
        time: 1500,
        index: 0,
    };
    let mut book = TaskLedger::new();
    // A take of a task never announced.
    let taken = json!({"serial": "7", "takenBy": "0x00000000000000000000000000000000000000a1", "amount": "100",
                       "takeBps": "50", "takenAt": "2001", "deadline": "9000", "windowSumBpsAfter": "50", "openAfter": "1"});
    let row = h.row(Role::Tasks, "TaskTaken", taken);
    assert!(book.apply(&row).is_err());
    // A task announced twice.
    let row = h.row(Role::Tasks, "TaskAnnounced", announced(1, "0x11"));
    book.apply(&row).expect("applies");
    let row = h.row(Role::Tasks, "TaskAnnounced", announced(1, "0x11"));
    assert!(book.apply(&row).is_err());
    // A field that is not a number.
    let mut broken = announced(2, "0x22");
    broken["maxDollars"] = json!("lots");
    let row = h.row(Role::Tasks, "TaskAnnounced", broken);
    assert!(book.apply(&row).is_err());
    // A note against a task that is not taken.
    let row = h.row(
        Role::Tasks,
        "NoteMinted",
        json!({"serial": "1", "holder": "0x00000000000000000000000000000000000000a1", "part": "5", "stayerAfter": "0", "noteFaceAfter": "5"}),
    );
    assert!(book.apply(&row).is_err());
}

/// `the_task_tuple_is_the_forge_abi` (A12): the generated table of `taskOf`'s fields is the ABI
/// forge wrote, field by field, in order, and every field is one word.
#[test]
fn the_task_tuple_is_the_forge_abi() {
    let abi: Value = serde_json::from_str(include_str!("testdata/pot-abi.json")).expect("JSON");
    assert_eq!(abi["view"], "TaskBook.taskOf(uint64)");
    let fields = abi["fields"].as_array().expect("fields");
    assert_eq!(
        fields.len(),
        TASK_OF.len(),
        "the table has the ABI's number of fields"
    );
    for (i, (name, ty)) in TASK_OF.iter().enumerate() {
        assert_eq!(fields[i]["name"], *name, "field {i}");
        assert_eq!(fields[i]["type"], *ty, "field {i}");
        assert!(
            !ty.contains('[') && !ty.starts_with("tuple") && *ty != "bytes" && *ty != "string",
            "field {name} is one word"
        );
    }
}

/// The cap's window the tests assume (four units) is what the book says.
#[test]
fn a_book_says_the_cap_window_is_four_units() {
    let fx = fx();
    let (project, chain) = BookChain::load(&fx, "A_example");
    let book = fx.projects[&project].tasks;
    let answer = chain
        .answers
        .get(&(
            book,
            buzz_evm_allowance::abi::selector("CAP_WINDOW_MULT()").to_vec(),
        ))
        .expect("the book answers CAP_WINDOW_MULT");
    assert_eq!(answer.last().copied(), Some(4));
    assert_eq!(answer.len(), 32);
}
