//! The checks of the `tasks` section (plan section 2.5, the A tests of 8.2): every
//! number the events rebuild is held to the contract's own view at the record's
//! block, every sum adds up over all the tasks, and a record that is wrong in
//! itself is refused. Each test breaks one thing and names the line that must say
//! so; with that rule switched off the line is missing and the test fails.

use std::sync::atomic::{AtomicUsize, Ordering};

use buzz_evm_allowance::abi::selector;
use serde_json::{json, Value};

use super::fixture::BookChain;
use super::ledger::Ledger;
use super::ledger_tasks::{LTask, TaskLedger, TaskState};
use super::numbers::{self, AsOf, Cadence};
use super::record::{self, Record};
use super::record_tests::{address_of, build_with, example, load, n, set_answer};
use super::source::ChainSource;
use super::views::{self, Views};
use super::views_table::TASK_OF;

fn word_of(v: u128) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[16..].copy_from_slice(&v.to_be_bytes());
    w
}

fn address_word(a: &str) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[12..].copy_from_slice(&address_of(a));
    w
}

fn error_of<T>(r: anyhow::Result<T>) -> String {
    format!("{:#}", r.err().expect("the build is refused"))
}

/// Change one word of the answer to `taskOf(serial)` (a copy of the chain).
fn with_task_word(
    chain: &BookChain,
    book: &[u8; 20],
    serial: u64,
    field: &str,
    change: impl Fn(&mut [u8]),
) -> BookChain {
    let mut copy = BookChain {
        block: chain.block,
        answers: chain.answers.clone(),
    };
    let mut data = selector("taskOf(uint64)").to_vec();
    data.extend_from_slice(&word_of(u128::from(serial)));
    let answer = copy
        .answers
        .get_mut(&(*book, data))
        .unwrap_or_else(|| panic!("taskOf({serial}) was not captured"));
    let at = TASK_OF
        .iter()
        .position(|(name, _)| *name == field)
        .expect("a field of the tuple");
    change(&mut answer[at * 32..at * 32 + 32]);
    copy
}

fn copy_of(chain: &BookChain) -> BookChain {
    BookChain {
        block: chain.block,
        answers: chain.answers.clone(),
    }
}

/// The views read honestly, and the ledger they belong to.
async fn honest(name: &str) -> (Ledger, AsOf, Views) {
    let (fx, ledger, as_of, chain) = load(name);
    let read = views::read(&chain, fx.launcher, &ledger, as_of.block, as_of.time)
        .await
        .expect("the honest answers read");
    (ledger, as_of, read)
}

fn build_of(ledger: &Ledger, as_of: &AsOf, read: &Views) -> anyhow::Result<Record> {
    numbers::build(ledger, as_of, read, &Cadence::default(), as_of.time + 1)
}

/// A2: a task row one unit off its view, in any field, publishes nothing, and the
/// message names the task, the field and both values.
#[tokio::test]
async fn a_task_row_one_unit_off_the_view_publishes_nothing() {
    let (fx, ledger, as_of, chain) = load("A_example");
    let book = address_of(ledger.contracts.tasks.as_deref().expect("a book"));
    build_with(&fx, &ledger, &as_of, &chain)
        .await
        .expect("the honest answers build");
    let mut tried = 0;
    // One paid in part, one that ran out with a note, one still taken.
    for serial in [2u64, 4, 6] {
        for (field, _) in TASK_OF {
            let off = with_task_word(&chain, &book, serial, field, |w| w[31] ^= 1);
            let text = error_of(build_with(&fx, &ledger, &as_of, &off).await);
            assert!(
                text.contains("nothing is published")
                    && text.contains(&format!("task {serial} {field}"))
                    && text.contains("events say")
                    && text.contains("the contract says"),
                "task {serial} {field} one unit off: {text}"
            );
            tried += 1;
        }
    }
    assert_eq!(tried, 3 * TASK_OF.len());
}

/// The whole tuple is covered: a field of `taskOf` that the checks do not name would be a
/// number nobody holds to the contract.
#[test]
fn every_field_of_the_task_tuple_has_a_name_the_checks_use() {
    let want = [
        "what",
        "payee",
        "state",
        "shareBps",
        "ringIdx",
        "takenBy",
        "announcedAt",
        "noticeEnd",
        "expiresAt",
        "takenAt",
        "deadline",
        "maxDollars",
        "locked",
        "stayer",
        "noteFace",
        "returned",
        "notesLeft",
    ];
    let have: Vec<&str> = TASK_OF.iter().map(|(name, _)| *name).collect();
    assert_eq!(have, want, "a new field in the book needs a check here");
}

/// The cap's room, the Treasury's next expiry and the open limit are held to their views.
#[tokio::test]
async fn the_cap_room_the_next_expiry_and_the_open_limit_are_held_to_the_contract() {
    let (fx, ledger, as_of, chain) = load("A_example");
    let book = address_of(ledger.contracts.tasks.as_deref().expect("a book"));
    let treasury = address_of(&ledger.contracts.treasury);
    let honest = build_with(&fx, &ledger, &as_of, &chain)
        .await
        .expect("builds");
    let tasks = honest.tasks.expect("a book");

    let mut room = copy_of(&chain);
    set_answer(
        &mut room,
        &book,
        "takeRoomBps()",
        &[],
        u128::from(tasks.cap.room_bps) + 1,
    );
    let text = error_of(build_with(&fx, &ledger, &as_of, &room).await);
    assert!(text.contains("takeRoomBps: events say"), "{text}");

    let mut next = copy_of(&chain);
    set_answer(
        &mut next,
        &treasury,
        "nextExpiry()",
        &[],
        u128::from(tasks.next_expiry.expect("a task is open")) + 1,
    );
    let text = error_of(build_with(&fx, &ledger, &as_of, &next).await);
    assert!(text.contains("nextExpiry: events say"), "{text}");

    let mut few = copy_of(&chain);
    set_answer(&mut few, &book, "MAX_OPEN()", &[], 2);
    let text = error_of(build_with(&fx, &ledger, &as_of, &few).await);
    assert!(text.contains("openCount is more than MAX_OPEN"), "{text}");
}

/// A4, and the buckets: the money set aside, the money held for notes, each task's claim and
/// notes against its face, and what was paid and returned must add up over every task the
/// ledger holds, not only the listed rows.
#[tokio::test]
async fn a_ledger_that_does_not_add_up_publishes_nothing_and_says_which_sum() {
    let (ledger, as_of, read) = honest("A_example").await;
    build_of(&ledger, &as_of, &read).expect("the honest ledger builds");
    type Tamper = fn(&mut Ledger);
    let cases: [(&str, Tamper, &str); 8] = [
        (
            "the money set aside",
            |l| l.tasks.tasks.get_mut(&6).expect("task 6").stayer += 1,
            "the running tasks' claims added up",
        ),
        (
            "the money held for notes",
            |l| l.tasks.tasks.get_mut(&4).expect("task 4").notes_left += 1,
            "notesOwed (note faces of open tasks",
        ),
        (
            "a claim and its notes against the amount set aside",
            |l| l.tasks.tasks.get_mut(&6).expect("task 6").note_face += 1,
            "set aside is the stayers' claim and the notes' face",
        ),
        (
            "the holders' notes against the face (a holder the record does not list)",
            |l| {
                l.tasks.notes.insert((9, format!("0x{:040x}", 0xaa)), 5);
            },
            "task 9 the holders' notes added up",
        ),
        (
            "paid plus returned",
            |l| l.tasks.tasks.get_mut(&2).expect("task 2").pay += 1,
            "task 2 paid plus returned is what was set aside",
        ),
        (
            "a payment on a task that did not end paid",
            |l| l.tasks.tasks.get_mut(&3).expect("task 3").pay += 1,
            "task 3 was paid though it did not end paid",
        ),
        (
            "the open rows against the open count",
            |l| l.tasks.open_count += 1,
            "tasks open rows",
        ),
        (
            "the next serial against the highest",
            |l| l.tasks.next_serial = 3,
            "tasks nextSerial",
        ),
    ];
    for (what, tamper, line) in cases {
        let mut broken = ledger.clone();
        tamper(&mut broken);
        let text = error_of(build_of(&broken, &as_of, &read));
        assert!(
            text.contains("nothing is published") && text.contains(line),
            "{what}: {text}"
        );
    }
}

/// The notes a record lists are the contract's own: a holder's note and the largest holder's claim
/// are held to `noteOf` and `claimableNote`.
#[tokio::test]
async fn a_note_or_a_claim_one_unit_off_its_view_publishes_nothing() {
    let (fx, ledger, as_of, chain) = load("A_example");
    let book = address_of(ledger.contracts.tasks.as_deref().expect("a book"));
    let (holder, face) = {
        let (h, f) = ledger
            .tasks
            .holders_of(4)
            .into_iter()
            .next()
            .expect("a note");
        (h.clone(), f)
    };
    let args = [word_of(4), address_word(&holder)];

    let mut note = copy_of(&chain);
    set_answer(&mut note, &book, "noteOf(uint64,address)", &args, face + 1);
    let text = error_of(build_with(&fx, &ledger, &as_of, &note).await);
    assert!(text.contains(&format!("task 4 note of {holder}")), "{text}");

    // The task ran out and returned all of what was set aside: the note's claim is its face.
    let mut claim = copy_of(&chain);
    set_answer(
        &mut claim,
        &book,
        "claimableNote(uint64,address)",
        &args,
        face + 1,
    );
    let text = error_of(build_with(&fx, &ledger, &as_of, &claim).await);
    assert!(
        text.contains(&format!("task 4 claimable note of {holder}")),
        "{text}"
    );
}

/// Events that name tasks of a book the Treasury never named are refused.
#[tokio::test]
async fn task_events_with_no_book_publish_nothing() {
    let (ledger, as_of, mut read) = honest("A_example").await;
    read.book = None;
    let text = error_of(build_of(&ledger, &as_of, &read));
    assert!(text.contains("never named a book"), "{text}");
}

// ----------------------------------------------------------- the record's own rules

fn parsed(v: Value) -> Record {
    serde_json::from_value(v).expect("the record still parses")
}

/// The row of serial `s` in a record's JSON.
fn row(v: &mut Value, serial: u64) -> &mut Value {
    v["tasks"]["list"]
        .as_array_mut()
        .expect("rows")
        .iter_mut()
        .find(|r| r["serial"] == json!(serial))
        .unwrap_or_else(|| panic!("task {serial} is in the example"))
}

fn amount_plus(v: &Value, one: i128) -> Value {
    json!((i128::try_from(n(v)).expect("fits") + one).to_string())
}

/// A14, A17: a record that is wrong in itself is refused, whatever the views said. Each case breaks
/// one thing in the example and names the line that must say so.
#[test]
fn a_record_the_task_rules_refuse_is_never_signed() {
    let base = example();
    assert_eq!(
        record::validate(&parsed(base.clone())),
        Vec::<String>::new()
    );
    type Break = fn(&mut Value);
    let cases: Vec<(&str, Break, &str)> = vec![
        (
            "the open count",
            |v| v["tasks"]["openCount"] = json!(2),
            "tasks.openCount is 2",
        ),
        (
            "open rows out of order",
            |v| v["tasks"]["list"].as_array_mut().expect("rows").swap(0, 1),
            "open rows by serial, lowest first",
        ),
        (
            "ended rows out of order",
            |v| v["tasks"]["list"].as_array_mut().expect("rows").swap(4, 5),
            "ended rows by serial, newest first",
        ),
        (
            "a serial the book never handed out",
            |v| row(v, 9)["serial"] = json!(99),
            "not between 1 and nextSerial",
        ),
        (
            "a serial twice among the open rows",
            |v| row(v, 7)["serial"] = json!(6),
            "none twice",
        ),
        (
            "next expiry",
            |v| v["tasks"]["nextExpiry"] = json!(1),
            "tasks.nextExpiry is not the earliest end",
        ),
        (
            "what a take would set aside",
            |v| row(v, 7)["atMostNow"] = json!("1"),
            "task 7: atMostNow is",
        ),
        (
            "what a take would set aside, on a task that cannot be taken",
            |v| row(v, 6)["atMostNow"] = json!("1"),
            "task 6: atMostNow is",
        ),
        (
            "notes where nothing is held",
            |v| row(v, 4)["notes"] = Value::Null,
            "notes are listed exactly when something is held",
        ),
        (
            "the notes' face",
            |v| row(v, 4)["notes"]["faceTotal"] = json!("1"),
            "notes.faceTotal is not its noteFace",
        ),
        (
            "what a claim pays",
            |v| row(v, 4)["notes"]["holders"][0]["claimable"] = json!("1"),
            "can claim 1 but the note's share",
        ),
        (
            "notes that do not add up to the face",
            |v| {
                let r = row(v, 4);
                r["notes"]["holders"][0]["face"] = json!("1");
            },
            "the notes listed add up to 1",
        ),
        (
            "a claim and notes against what was set aside",
            |v| {
                let one = amount_plus(&row(v, 6)["noteFace"], 1);
                row(v, 6)["noteFace"] = one;
            },
            "is not the stayers' claim",
        ),
        (
            "paid and returned against what was set aside",
            |v| {
                let one = amount_plus(&row(v, 2)["pay"], 1);
                row(v, 2)["pay"] = one;
            },
            "are not what was set aside",
        ),
        (
            "a take on an announced task",
            |v| row(v, 7)["takenBy"] = json!(format!("0x{:040x}", 0xbb)),
            "is announced but shows a take or money",
        ),
        (
            "a take with the wrong deadline",
            |v| {
                let d = row(v, 6)["deadline"].as_u64().expect("deadline");
                row(v, 6)["deadline"] = json!(d + 1);
                row(v, 6)["expiresAt"] = json!(d + 1);
            },
            "its take or deadline is wrong",
        ),
        (
            "a repeat that does not come after",
            |v| row(v, 8)["repeatOf"] = json!(8),
            "repeats a task that does not come before it",
        ),
        (
            "a repeat that does not say so",
            |v| row(v, 8)["repeatOf"] = Value::Null,
            "plans the record of task 2 again",
        ),
        (
            "the room under the cap",
            |v| v["tasks"]["cap"]["roomBps"] = json!(701),
            "used 300 and room 701 are not the cap",
        ),
        (
            "the dates the used share comes back",
            |v| {
                v["tasks"]["cap"]["frees"]
                    .as_array_mut()
                    .expect("frees")
                    .swap(0, 1)
            },
            "frees are not the dates the used share comes back",
        ),
        (
            "the used share against the takes of the rows",
            |v| row(v, 2)["capBps"] = json!(100),
            "usedBps is 300 but the takes of the listed rows",
        ),
        (
            "a date room comes back",
            |v| {
                let at = v["tasks"]["cap"]["frees"][0]["at"].as_u64().expect("at");
                v["tasks"]["cap"]["frees"][0]["at"] = json!(at + 1);
            },
            "frees are not the takes of the listed rows still in the window",
        ),
        (
            "the next date",
            |v| v["tasks"]["next"] = Value::Null,
            "tasks.next is not the earliest date",
        ),
        (
            "the window the cut keeps ended rows for",
            |v| v["tasks"]["cut"]["endedWithinSecs"] = json!(1),
            "tasks.cut.endedWithinSecs",
        ),
        (
            "the truncated flag",
            |v| v["tasks"]["truncated"] = json!(true),
            "tasks.truncated is not true exactly when the cut left something out",
        ),
        (
            "an ended row older than the cut keeps",
            |v| row(v, 9)["resolvedAt"] = json!(1),
            "an ended row older than the cut keeps",
        ),
        (
            "an ended row without its end",
            |v| row(v, 9)["resolvedAt"] = Value::Null,
            "an end time and transaction are given exactly",
        ),
        (
            "a value that is not hex",
            |v| row(v, 6)["what"] = json!("0x12"),
            "task 6 has a value that is not lower-case hex",
        ),
        (
            "a share above what the book allows",
            |v| row(v, 7)["shareBps"] = json!(501),
            "task 7 has a share, size or date outside",
        ),
        (
            "money held for notes against the listed rows",
            |v| {
                let one = amount_plus(&v["money"]["notesOwed"], 1);
                v["money"]["notesOwed"] = one.clone();
                v["ledger"]["notesOwed"] = one;
            },
            "but the listed rows hold",
        ),
    ];
    for (what, breaks, line) in cases {
        let mut v = base.clone();
        breaks(&mut v);
        let bad = record::validate(&parsed(v));
        assert!(
            bad.iter().any(|b| b.contains(line)),
            "{what}: no line says {line:?}: {bad:?}"
        );
    }
}

/// The tasks section is held to its rules in every block of the run the builder reads, not only
/// in the example.
#[tokio::test]
async fn every_book_of_the_run_builds_and_obeys_the_rules() {
    for book in [
        "A_example",
        "A_overdue",
        "A_stream",
        "A_live",
        "A_end",
        "B_pair",
        "B_end",
    ] {
        let built = super::record_tests::build_from(book)
            .await
            .unwrap_or_else(|e| panic!("{book}: {e:#}"));
        assert_eq!(
            record::validate(&built.record),
            Vec::<String>::new(),
            "{book}"
        );
        assert!(built.record.tasks.is_some(), "{book} has a book");
    }
}

// ------------------------------------------------------------- bounded work

/// A node that answers every view with an answer of the right length and counts the calls
/// by their selectors. Only `tasks()` has a real answer (the book the ledger names).
struct Counting {
    book: [u8; 20],
    by_selector: std::sync::Mutex<std::collections::BTreeMap<[u8; 4], usize>>,
    calls: AtomicUsize,
}

#[async_trait::async_trait]
impl ChainSource for Counting {
    async fn chain_id(&self) -> anyhow::Result<u64> {
        Ok(31337)
    }
    async fn head(&self) -> anyhow::Result<u64> {
        Ok(0)
    }
    async fn header(&self, _n: u64) -> anyhow::Result<Option<super::source::Header>> {
        Ok(None)
    }
    async fn logs(
        &self,
        _a: &[[u8; 20]],
        _t: &[super::word::Word],
        _f: u64,
        _to: u64,
    ) -> anyhow::Result<Vec<super::source::RawLog>> {
        Ok(Vec::new())
    }
    async fn eth_call(
        &self,
        _to: &[u8; 20],
        data: &[u8],
        _at: u64,
    ) -> anyhow::Result<Option<Vec<u8>>> {
        self.calls.fetch_add(1, Ordering::Relaxed);
        let sel: [u8; 4] = data[..4].try_into().expect("a selector");
        *self
            .by_selector
            .lock()
            .expect("lock")
            .entry(sel)
            .or_insert(0) += 1;
        let words = if sel == selector("taskOf(uint64)") {
            TASK_OF.len()
        } else if sel == selector("grantOf(uint256)") {
            8
        } else if sel == selector("agents(address)") || sel == selector("noticeFor(uint16)") {
            3
        } else {
            1
        };
        let mut answer = vec![0u8; 32 * words];
        if sel == selector("tasks()") {
            answer[12..32].copy_from_slice(&self.book);
        }
        Ok(Some(answer))
    }
}

/// T7: the views one project asks for are bounded whatever its history: at most 8 open rows and 32
/// ended ones, 20 note holders for each of 8 rows, one claim per such row, and the same twelve
/// calls of the book however many tasks it has had.
#[tokio::test]
async fn the_views_of_one_project_are_bounded_whatever_its_history() {
    let (fx, mut ledger, as_of, _) = load("A_example");
    // A book with the most history a test network can pile up: 8 open tasks, 200 ended ones, all with
    // notes still to claim, each note held by 30 accounts.
    let mut book = TaskLedger::new();
    let shell = |serial: u64, state: TaskState| LTask {
        serial,
        state,
        what: format!("0x{serial:064x}"),
        payee: None,
        max_dollars: 5_000_000,
        share_bps: 100,
        announced_at: 1,
        notice_end: 2,
        expires_at: 3,
        taken_by: None,
        taken_at: None,
        deadline: None,
        set_aside: 100,
        stayer: 0,
        note_face: 60,
        pay: 0,
        returned: 100,
        notes_left: 60,
        take_bps: 0,
        cap_given_back: 0,
        ring_idx: None,
        resolved_at: Some(as_of.time - 5),
        resolved_tx: None,
    };
    for serial in 1..=208u64 {
        let state = if serial > 200 {
            TaskState::Announced
        } else {
            TaskState::Returned
        };
        book.tasks.insert(serial, shell(serial, state));
        for h in 0..30u64 {
            book.notes.insert((serial, format!("0x{h:040x}")), 2);
        }
    }
    book.next_serial = 209;
    ledger.tasks = book;
    let source = Counting {
        book: address_of(ledger.contracts.tasks.as_deref().expect("a book")),
        by_selector: Default::default(),
        calls: AtomicUsize::new(0),
    };
    let read = views::read(&source, fx.launcher, &ledger, as_of.block, as_of.time)
        .await
        .expect("reads");
    let by = source.by_selector.lock().expect("lock");
    let count = |sig: &str| by.get(&selector(sig)).copied().unwrap_or(0);
    assert!(
        count("taskOf(uint64)") <= 8 + 32,
        "{}",
        count("taskOf(uint64)")
    );
    assert_eq!(
        count("taskOf(uint64)"),
        8 + 24,
        "the rows with notes fill 24 of 32"
    );
    assert_eq!(count("noteOf(uint64,address)"), 8 * 20);
    assert_eq!(count("claimableNote(uint64,address)"), 8);
    for once in [
        "openCount()",
        "nextSerial()",
        "windowSumBps()",
        "takeRoomBps()",
        "MAX_OPEN()",
        "MAX_SHARE_BPS()",
        "CAP_BPS()",
        "MIN_TASK()",
        "CAP_WINDOW_MULT()",
        "noticeFor(uint16)",
        "dueC(uint256)",
    ] {
        assert_eq!(count(once), 1, "{once} is asked once");
    }
    assert!(read.book.is_some());
}
