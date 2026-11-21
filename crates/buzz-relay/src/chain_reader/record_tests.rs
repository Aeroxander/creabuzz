//! The record (version 2) against the spec's one example file and against
//! the real run of the contracts.
//!
//! - The example (`docs/next-version/record-v2-example.json`) parses with the
//!   server's own types and writes back exactly; the rules of RECORD-V2
//!   section 7.3 hold for it; the server's own checks accept it and refuse a
//!   copy with `money.pot` raised by one unit.
//! - The builder, fed the real chain's answers (`books` in the run, taken by
//!   `scripts/chain-reader-fixture.py`) and the ledger the events rebuild,
//!   produces a record with exactly the example's fields and types, and the
//!   numbers the contracts gave.
//! - A failed or mismatched read is an error, never a record.

use std::collections::BTreeSet;

use serde_json::{json, Value};

use super::fixture::{BookChain, Fixture};
use super::ledger::Ledger;
use super::numbers::{self, AsOf, Cadence};
use super::record::{self, mul_div, Record};
use super::record_social::{SocialInput, SocialReport};
use super::record_tasks;
use super::views;

const EXAMPLE: &str = include_str!("../../../../docs/next-version/record-v2-example.json");
/// Where the example lives, for the test that writes it (`UPDATE_EXAMPLE=1`).
const EXAMPLE_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../docs/next-version/record-v2-example.json"
);

pub(super) fn example() -> Value {
    serde_json::from_str(EXAMPLE).expect("the example is JSON")
}

pub(super) fn n(v: &Value) -> u128 {
    v.as_str().expect("an amount").parse().expect("a number")
}

fn t(v: &Value) -> u64 {
    v.as_u64().expect("a time")
}

// ------------------------------------------------------------ the example file

#[test]
fn the_example_parses_with_the_servers_own_types_and_writes_back_exactly() {
    let value = example();
    let record: Record =
        serde_json::from_value(value.clone()).expect("the example parses with the server's types");
    assert_eq!(
        serde_json::to_value(&record).expect("written"),
        value,
        "a field the example has and the server's types lack (or the other way) would show here"
    );
    // An unknown field, or a missing one, is refused: the types are the spec.
    let mut extra = value.clone();
    extra["surprise"] = json!(1);
    assert!(serde_json::from_value::<Record>(extra).is_err());
    let mut missing = value;
    missing.as_object_mut().expect("object").remove("limits");
    assert!(serde_json::from_value::<Record>(missing).is_err());
}

#[test]
fn the_server_accepts_the_example_and_refuses_it_with_a_pot_one_unit_too_high() {
    let value = example();
    let record: Record = serde_json::from_value(value.clone()).expect("parses");
    assert_eq!(record::validate(&record), Vec::<String>::new());

    let mut raised = value.clone();
    raised["money"]["pot"] = json!((n(&value["money"]["pot"]) + 1).to_string());
    let bad = record::validate(&serde_json::from_value(raised).expect("parses"));
    assert!(
        bad.iter().any(|b| b.contains("money.pot")),
        "a pot one unit too high must be named: {bad:?}"
    );

    // Each other number the checks stand on is held too.
    for (path, change) in [
        (("allowance", "box"), 1u128),
        (("money", "arriving"), 1),
        (("money", "held"), u128::MAX),
        (("totals", "drawn"), 1),
        (("team", "promised"), 1),
        (("shares", "teamCounted"), 1),
    ] {
        let mut v = value.clone();
        let old = n(&v[path.0][path.1]);
        let new = if change == u128::MAX {
            old - 1
        } else {
            old + change
        };
        v[path.0][path.1] = json!(new.to_string());
        let bad = record::validate(&serde_json::from_value(v).expect("parses"));
        assert!(!bad.is_empty(), "{path:?} changed by one must be refused");
    }
    let mut wrong_state = value.clone();
    wrong_state["quiet"]["state"] = json!("dormant");
    assert!(!record::validate(&serde_json::from_value(wrong_state).expect("parses")).is_empty());
    let mut door = value.clone();
    door["door"]["openNow"] = json!(!value["door"]["openNow"].as_bool().expect("flag"));
    assert!(!record::validate(&serde_json::from_value(door).expect("parses")).is_empty());
    let mut shut = value;
    shut["version"] = json!(3);
    assert!(serde_json::from_value::<Record>(shut)
        .map(|r| !record::validate(&r).is_empty())
        .unwrap_or(true));
}

/// A14: the example is the server's own output for the run's project A at one named block,
/// byte for byte. `UPDATE_EXAMPLE=1` rewrites it (and the next build of the tests reads the new file).
#[tokio::test]
async fn the_example_is_what_the_server_writes() {
    let built = build_from("A_example").await.expect("builds");
    let text = format!(
        "{}\n",
        serde_json::to_string_pretty(&built.record).expect("the record is written")
    );
    if std::env::var_os("UPDATE_EXAMPLE").is_some() {
        std::fs::write(EXAMPLE_PATH, &text).expect("the example is written");
    }
    let on_disk = std::fs::read_to_string(EXAMPLE_PATH).expect("the example is read");
    assert!(
        on_disk == text,
        "docs/next-version/record-v2-example.json is not what the server writes at the example block; \
         run the tests with UPDATE_EXAMPLE=1 to rewrite it"
    );
    // The tasks section is there, with rows in each state the run plays.
    let rows = built.value["tasks"]["list"].as_array().expect("rows");
    let states: BTreeSet<&str> = rows
        .iter()
        .map(|r| r["state"].as_str().expect("state"))
        .collect();
    for want in [
        "announced",
        "taken",
        "paid",
        "rejected",
        "returned",
        "cancelled",
        "lapsed",
    ] {
        assert!(
            states.contains(want),
            "the example shows a {want} task: {states:?}"
        );
    }
}

/// RECORD-V2 section 7.3, item by item, on the example, with the contracts'
/// integer formulas. This checks the file; the formulas are not production code.
#[test]
fn the_example_obeys_every_rule_of_section_7_3() {
    let r = example();
    let (money, shares, worth, allowance) =
        (&r["money"], &r["shares"], &r["value"], &r["allowance"]);

    // 1. Types.
    assert_eq!(r["version"], 2);
    fn walk(v: &Value, path: &str) {
        match v {
            Value::Object(map) => map
                .iter()
                .for_each(|(k, v)| walk(v, &format!("{path}.{k}"))),
            Value::Array(items) => items.iter().for_each(|v| walk(v, path)),
            Value::String(s) if s.starts_with("0x") => {
                assert!(s == &s.to_lowercase(), "{path}: not lower-case");
            }
            Value::String(s) => {
                let amount_like = !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
                assert!(
                    amount_like
                        || matches!(
                            s.as_str(),
                            "normal"
                                | "protected"
                                | "live"
                                | "announced"
                                | "closed"
                                | "active"
                                | "quiet"
                                | "dormant"
                                | "may_wind_down"
                                | "wound_down"
                                | "taken"
                                | "paid"
                                | "rejected"
                                | "returned"
                                | "cancelled"
                                | "lapsed"
                                | "can_be_taken"
                                | "lapses"
                                | "due"
                                | "cap_room"
                                // The words of the feed (step 3): the way an hour's money went and what an item says.
                                | "in"
                                | "out"
                                | "even"
                                | "task_planned"
                                | "task_taken"
                                | "task_paid"
                                | "task_ended"
                                | "task_withdrawn"
                                | "update"
                        ),
                    "{path}: {s:?} is neither an amount nor a word of the record"
                );
            }
            Value::Number(num) => {
                assert!(num.is_u64(), "{path}: a time or count is a whole number")
            }
            _ => {}
        }
    }
    walk(&r, "");
    let as_of = t(&r["asOf"]["time"]);
    assert!(t(&r["launchedAt"]) <= as_of && as_of <= t(&r["builtAt"]));

    // 2 and 3. The roll-forward from the ledger block, and the box cap.
    let l = &r["ledger"];
    let stored = record::Stored {
        last_settle: t(&l["lastSettle"]),
        active_end: t(&r["clock"]["activeUntil"]),
        arrival_end: l["arrivalEnd"].as_u64().unwrap_or(0),
        arrival_start: t(&l["arrivalStart"]),
        arrival_total: n(&l["arrivalTotal"]),
        rate_ppm: allowance["ratePpm"].as_u64().expect("rate") as u32,
        unit: t(&r["unit"]),
        pot: n(&l["pot"]),
        box_: n(&l["box"]),
        arriving: n(&l["arriving"]),
        active_seconds: u128::from(t(&l["activeSeconds"])),
        locked: n(&l["locked"]),
        due_c: r["tasks"]["list"].as_array().map_or(0, |rows| {
            rows.iter()
                .filter(|row| row["state"] == "taken" && t(&row["deadline"]) <= as_of)
                .map(|row| n(&row["stayerClaim"]))
                .sum()
        }),
    };
    let settled = record::roll_forward(as_of, &stored).expect("settles");
    assert_eq!(settled.pot, n(&money["pot"]));
    assert_eq!(settled.box_, n(&allowance["box"]));
    assert_eq!(settled.arriving, n(&money["arriving"]));
    assert_eq!(settled.locked, n(&money["locked"]));
    assert_eq!(
        settled.active_seconds,
        u128::from(t(&r["clock"]["activeSeconds"]))
    );
    let (pot, paid_in) = (n(&money["pot"]), n(&money["paidIn"]));
    let (box_, arriving) = (n(&allowance["box"]), n(&money["arriving"]));
    assert_eq!(
        mul_div(pot + box_, u128::from(stored.rate_ppm) * 7, 1_000_000),
        Some(n(&allowance["boxCap"]))
    );

    // 4. What one Share is worth.
    let (b, g) = (n(&shares["backers"]), n(&shares["teamCounted"]));
    let a1 = pot.min(paid_in);
    let one = 1_000_000_000_000_000_000u128;
    assert_eq!(
        n(&worth["leaveValue"]),
        mul_div(one, a1, b).expect("fits") + mul_div(one, pot - a1, b + g).expect("fits")
    );
    assert_eq!(
        n(&worth["teamValue"]),
        mul_div(one, pot.saturating_sub(paid_in), b + g).expect("fits")
    );

    // 5. What the Treasury holds, and where every dollar went.
    let (fees_owed, locked, notes) = (
        n(&money["feesOwed"]),
        n(&money["locked"]),
        n(&money["notesOwed"]),
    );
    assert_eq!(
        n(&money["held"]),
        pot + box_ + arriving + fees_owed + locked + notes
    );
    let totals = &r["totals"];
    assert_eq!(
        n(&totals["joined"]) + n(&totals["outside"]),
        n(&totals["fees"])
            + n(&totals["tookOut"])
            + n(&totals["drawn"])
            + n(&totals["paidToWorkers"])
            + n(&totals["noteClaims"])
            + pot
            + box_
            + arriving
            + locked
            + notes
    );

    // 6. Team Shares.
    let team = &r["team"];
    assert_eq!(n(&team["inHands"]) + n(&team["inVester"]), g);
    assert_eq!(
        n(&team["ungranted"]),
        n(&team["inVester"]) - n(&team["promised"])
    );

    // 7. Not truncated: the lists add up.
    assert_eq!(r["truncated"], false);
    let holders = r["holders"].as_array().expect("holders");
    assert_eq!(holders.iter().map(|h| n(&h["shares"])).sum::<u128>(), b);
    assert_eq!(
        holders.iter().map(|h| n(&h["teamShares"])).sum::<u128>(),
        n(&team["inHands"])
    );
    assert_eq!(
        holders.iter().filter(|h| n(&h["shares"]) != 0).count() as u64,
        t(&r["holderCount"])
    );
    assert_eq!(
        holders.iter().filter(|h| n(&h["teamShares"]) != 0).count() as u64,
        t(&r["teamHolderCount"])
    );

    // 8. Grants.
    let (limits, unit) = (&r["limits"], t(&r["unit"]));
    let active = t(&r["clock"]["activeSeconds"]);
    let (cliff_units, vest_units) = (t(&limits["cliffUnits"]), t(&limits["vestUnits"]));
    let (mut owed, mut burn) = (0u128, 0u128);
    for grant in team["grants"].as_array().expect("grants") {
        let (keeps, claimed, vested) = (
            n(&grant["keeps"]),
            n(&grant["claimed"]),
            n(&grant["vested"]),
        );
        assert_eq!(n(&grant["claimable"]), vested - claimed);
        let forfeit = grant["forfeit"].as_object().map_or(0, |f| n(&f["amount"]));
        owed += keeps - claimed + forfeit;
        burn += forfeit;
        if grant["state"] == "live" {
            let start = t(&grant["startActive"]);
            let elapsed = active.saturating_sub(start);
            let want = if elapsed < cliff_units * unit {
                0
            } else {
                mul_div(
                    keeps,
                    u128::from(elapsed.min(vest_units * unit)),
                    u128::from(vest_units * unit),
                )
                .expect("fits")
            };
            assert_eq!(vested, want, "grant {} vested", grant["id"]);
            let cliff = &grant["cliff"];
            assert_eq!(cliff["passed"], elapsed >= cliff_units * unit);
            let left = (start + cliff_units * unit).saturating_sub(active);
            assert_eq!(
                cliff["endsAtIfActive"].as_u64(),
                (left > 0).then_some(as_of + left)
            );
            let full = (start + vest_units * unit).saturating_sub(active);
            assert_eq!(
                grant["fullyVestedAtIfActive"].as_u64(),
                (full > 0).then_some(as_of + full)
            );
        } else {
            assert_eq!(
                vested, keeps,
                "an announced or closed grant has all of what it keeps vested"
            );
        }
    }
    assert_eq!(owed, n(&team["promised"]));
    assert_eq!(burn, n(&shares["announcedBurn"]));

    // 9. The quiet scale.
    let (quiet, clock) = (&r["quiet"], &r["clock"]);
    let last = t(&clock["lastCheckIn"]);
    assert_eq!(t(&quiet["quietFrom"]), t(&clock["activeUntil"]));
    assert_eq!(
        t(&quiet["quietFrom"]),
        last + t(&limits["checkInWindowUnits"]) * unit
    );
    assert_eq!(
        t(&quiet["windableFrom"]),
        last + t(&limits["windDownUnits"]) * unit
    );
    assert_eq!(t(&quiet["dormantFrom"]), last + 13 * unit);
    let word = record::quiet_state(
        as_of,
        t(&quiet["quietFrom"]),
        t(&quiet["dormantFrom"]),
        t(&quiet["windableFrom"]),
    );
    assert_eq!(quiet["state"], serde_json::to_value(word).expect("word"));
    let door = &r["door"];
    assert_eq!(
        door["openNow"].as_bool().expect("flag"),
        door["switchOn"].as_bool().expect("flag") && as_of < t(&door["shutsAt"])
    );

    // 10. The rate raise, and the end of the arriving money.
    let pending = &allowance["pending"];
    assert_eq!(
        t(&pending["applicableAt"]),
        t(&pending["proposedAt"]) + unit
    );
    assert!(t(&money["arrivalEnd"]) > as_of);

    // 11. The task queue (step 2), by the contracts' rules, from the example alone.
    let tasks = &r["tasks"];
    let rows = tasks["list"].as_array().expect("rows");
    let lim = &tasks["limits"];
    let (serials, mut seen): (Vec<u64>, BTreeSet<u64>) = (
        rows.iter().map(|row| t(&row["serial"])).collect(),
        BTreeSet::new(),
    );
    assert!(
        serials.iter().all(|s| seen.insert(*s)),
        "serials are unique"
    );
    let open: Vec<&Value> = rows
        .iter()
        .filter(|row| matches!(row["state"].as_str(), Some("announced" | "taken")))
        .collect();
    assert_eq!(
        open.len() as u64,
        t(&tasks["openCount"]),
        "the open rows are the open count"
    );
    assert!(open.len() as u64 <= t(&lim["maxOpen"]));
    assert!(t(&tasks["nextSerial"]) > *serials.iter().max().expect("a row"));
    // Open rows first by serial, then ended rows newest first.
    let (open_part, ended_part) = rows.split_at(open.len());
    assert!(open_part
        .windows(2)
        .all(|w| t(&w[0]["serial"]) < t(&w[1]["serial"])));
    assert!(ended_part
        .windows(2)
        .all(|w| t(&w[0]["serial"]) > t(&w[1]["serial"])));
    let window = t(&lim["capWindowSecs"]);
    let mut used = 0u128;
    let mut next: Option<(u64, u8, u64)> = None;
    for row in rows {
        let (state, set_aside) = (row["state"].as_str().expect("state"), n(&row["setAside"]));
        let (stayer, note_face) = (n(&row["stayerClaim"]), n(&row["noteFace"]));
        let (pay, returned) = (n(&row["pay"]), n(&row["returned"]));
        assert!(
            row["repeatOf"]
                .as_u64()
                .is_none_or(|first| first < t(&row["serial"])),
            "a repeat points at an earlier plan"
        );
        match state {
            "taken" => assert_eq!(set_aside, stayer + note_face, "C + N == L while taken"),
            "paid" => assert_eq!(
                pay + returned,
                set_aside,
                "pay plus what came back is what was set aside"
            ),
            "rejected" | "returned" => assert_eq!((pay, returned), (0, set_aside)),
            "announced" | "cancelled" | "lapsed" => {
                assert_eq!(
                    (set_aside, stayer, note_face, pay, returned),
                    (0, 0, 0, 0, 0)
                )
            }
            other => panic!("a state the spec does not know: {other}"),
        }
        if state == "announced" && as_of < t(&row["expiresAt"]) {
            let most = n(&row["maxDollars"])
                .min(mul_div(pot, u128::from(t(&row["shareBps"])), 10_000).expect("fits"));
            assert_eq!(row["atMostNow"].as_str(), Some(most.to_string().as_str()));
        } else {
            assert!(
                row["atMostNow"].is_null(),
                "atMostNow only while a take is possible"
            );
        }
        // The cap: a take counts while it is inside the window, unless it is a taken task past
        // its deadline (the next settle ends it unpaid and gives its share back).
        let cap_bps = u128::from(t(&row["capBps"]));
        if let Some(at) = row["takenAt"].as_u64() {
            let pending = state == "taken" && t(&row["deadline"]) <= as_of;
            if at + window > as_of && !pending {
                used += cap_bps;
            }
        }
        // The notes: the holders add up to the face unless the list is cut.
        if let Some(notes) = row["notes"].as_object() {
            assert_eq!(n(&notes["faceTotal"]), note_face);
            let holders = notes["holders"].as_array().expect("holders");
            if notes["holdersCut"] == false {
                assert_eq!(
                    holders.iter().map(|h| n(&h["face"])).sum::<u128>(),
                    note_face
                );
            }
            for h in holders {
                let want = if matches!(state, "announced" | "taken") {
                    0
                } else {
                    mul_div(n(&h["face"]), returned, set_aside).expect("fits")
                };
                assert_eq!(n(&h["claimable"]), want, "what a claim would pay");
            }
        } else {
            assert_eq!(note_face, 0, "a row with notes says so");
        }
        // The next date, redone.
        let mut offer = |at: u64, rank: u8, serial: u64| {
            if at > as_of && next.is_none_or(|b| (at, rank, serial) < b) {
                next = Some((at, rank, serial));
            }
        };
        match state {
            "announced" => {
                offer(t(&row["noticeEnd"]), 0, t(&row["serial"]));
                offer(t(&row["expiresAt"]), 1, t(&row["serial"]));
            }
            "taken" => offer(t(&row["deadline"]), 2, t(&row["serial"])),
            _ => {}
        }
    }
    let cap = &tasks["cap"];
    assert_eq!(
        u128::from(t(&cap["usedBps"])),
        used,
        "the takes counted in the window"
    );
    assert_eq!(t(&cap["usedBps"]) + t(&cap["roomBps"]), t(&lim["capBps"]));
    let frees = cap["frees"].as_array().expect("frees");
    assert!(frees.len() <= 16);
    assert_eq!(
        frees.iter().map(|f| u128::from(t(&f["bps"]))).sum::<u128>(),
        used,
        "the dates room comes back add up to what is used"
    );
    assert!(frees.windows(2).all(|w| t(&w[0]["at"]) <= t(&w[1]["at"])));
    if let Some(first) = frees.first() {
        let at = t(&first["at"]);
        if at > as_of && next.is_none_or(|b| (at, 3, 0) < b) {
            next = Some((at, 3, 0));
        }
    }
    let want_next = next.map(|(at, rank, serial)| {
        let kind = ["can_be_taken", "lapses", "due", "cap_room"][rank as usize];
        json!({"at": at, "kind": kind, "serial": serial})
    });
    assert_eq!(
        tasks["next"],
        want_next.unwrap_or(Value::Null),
        "what happens next"
    );
    // The money: what is set aside is the stayers' claims of the taken rows still running.
    let running: u128 = rows
        .iter()
        .filter(|row| row["state"] == "taken" && t(&row["deadline"]) > as_of)
        .map(|row| n(&row["stayerClaim"]))
        .sum();
    assert_eq!(
        running,
        n(&money["locked"]),
        "money.locked is what the running tasks hold"
    );
    // Notes owed: the face of the notes against open tasks plus what is left to claim on ended ones.
    let held: u128 = rows
        .iter()
        .map(|row| {
            if matches!(row["state"].as_str(), Some("announced" | "taken")) {
                n(&row["noteFace"])
            } else {
                n(&row["notesLeft"])
            }
        })
        .sum();
    assert_eq!(
        held,
        n(&money["notesOwed"]),
        "money.notesOwed is what is held for the notes"
    );
}

// ------------------------------------------------------ the builder, real run

#[derive(Debug)]
pub(super) struct Built {
    pub(super) record: Record,
    pub(super) value: Value,
}

pub(super) async fn build_from(name: &str) -> anyhow::Result<Built> {
    let (fx, ledger, as_of, chain) = load(name);
    let read = views::read(&chain, fx.launcher, &ledger, as_of.block, as_of.time).await?;
    let (project, _) = BookChain::load(&fx, name);
    let rows = fx.rows(&project, as_of.block);
    let windows = super::record_social_tests::windows_of(&rows, &ledger, &as_of);
    let social = SocialInput {
        rows: &rows,
        held: Some((&windows.0, &windows.1)),
    };
    let (record, report) = numbers::build(
        &ledger,
        &as_of,
        &read,
        &Cadence::default(),
        as_of.time + 131,
        &social,
    )?;
    assert_eq!(
        report,
        SocialReport::default(),
        "the example's social keys all build and pass their checks"
    );
    let value = serde_json::to_value(&record)?;
    Ok(Built { record, value })
}

pub(super) fn load(name: &str) -> (Fixture, Ledger, AsOf, BookChain) {
    let fx = Fixture::load();
    let (project, chain) = BookChain::load(&fx, name);
    let ledger = Ledger::from_logs(&fx.rows(&project, chain.block))
        .expect("the rows read")
        .expect("the project is launched");
    let as_of = AsOf {
        chain_id: 31337,
        launcher: fx.launcher,
        block: chain.block,
        time: fx.time_of(chain.block),
    };
    (fx, ledger, as_of, chain)
}

/// The fields of `got` and `want` (the same names at every level, the same
/// JSON types); a null on either side stands for "none", and what lies under
/// it is not compared.
fn shape_differences(got: &Value, want: &Value, path: &str, out: &mut Vec<String>) {
    match (got, want) {
        (Value::Null, _) | (_, Value::Null) => {}
        (Value::Object(g), Value::Object(w)) => {
            for key in g.keys().chain(w.keys()).collect::<BTreeSet<_>>() {
                match (g.get(key), w.get(key)) {
                    (Some(g), Some(w)) => shape_differences(g, w, &format!("{path}.{key}"), out),
                    (Some(_), None) => {
                        out.push(format!("{path}.{key} is in the record, not in the example"))
                    }
                    (None, Some(_)) => {
                        out.push(format!("{path}.{key} is in the example, not in the record"))
                    }
                    (None, None) => {}
                }
            }
        }
        (Value::Array(g), Value::Array(w)) => {
            // Every item the record has is shaped like some item the example has.
            for item in g {
                let mut best: Option<Vec<String>> = None;
                for model in w {
                    let mut diff = Vec::new();
                    shape_differences(item, model, &format!("{path}[]"), &mut diff);
                    if best.as_ref().is_none_or(|b| diff.len() < b.len()) {
                        best = Some(diff);
                    }
                }
                out.extend(best.unwrap_or_default());
            }
        }
        (Value::String(_), Value::String(_))
        | (Value::Number(_), Value::Number(_))
        | (Value::Bool(_), Value::Bool(_)) => {}
        _ => out.push(format!("{path}: the record has {got}, the example {want}")),
    }
}

#[tokio::test]
async fn the_reader_fed_the_run_writes_the_examples_fields_and_types() {
    let want = example();
    for book in ["A_live", "B_pair", "A_end", "B_end"] {
        let built = build_from(book)
            .await
            .unwrap_or_else(|e| panic!("{book}: {e:#}"));
        let mut diff = Vec::new();
        shape_differences(&built.value, &want, "", &mut diff);
        assert!(diff.is_empty(), "{book}: {diff:?}");
        assert!(record::validate(&built.record).is_empty(), "{book}");
        // Every key of the example is in the record at the top level too.
        let keys = |v: &Value| {
            v.as_object()
                .expect("object")
                .keys()
                .cloned()
                .collect::<BTreeSet<_>>()
        };
        assert_eq!(keys(&built.value), keys(&want), "{book}: top-level fields");
    }
}

#[tokio::test]
async fn a_live_project_shows_what_the_contracts_gave() {
    let built = build_from("A_live").await.expect("builds");
    let (r, v) = (&built.record, &built.value);
    assert_eq!(r.version, 2);
    assert!(r.play_money, "a local chain is a test network");
    assert_eq!(r.quiet.state, record::QuietState::Active);
    assert!(r.door.open_now && r.door.switch_on);
    assert_eq!(r.refresh_every_secs, 600, "the allowance is accruing");
    // The rate raise of day 100 is waiting; the runner is one person.
    let pending = r.allowance.pending.expect("a raise is waiting");
    assert_eq!(pending.rate_ppm, 1500);
    assert_eq!(pending.applicable_at, pending.proposed_at + r.unit);
    assert!(!r.runner.is_pair && r.runner.signers.is_none() && r.contracts.pair.is_none());
    // The member's own exit of day 99 is announced, with the notice running.
    let announced: Vec<_> = r
        .team
        .grants
        .iter()
        .filter(|g| g.state == record::GrantStateRec::Announced)
        .collect();
    assert_eq!(announced.len(), 1);
    let forfeit = announced[0].forfeit.as_ref().expect("a forfeit");
    assert!(forfeit.by_member);
    assert!(forfeit.burn_at > r.as_of.time, "the notice has not run out");
    // The agent set on day 102 is live and has drawn.
    let agent = r.agents.iter().find(|a| a.live).expect("a live agent");
    assert_eq!(agent.usd_used, "5000000");
    // Outside money is still arriving, so its end is named.
    assert_ne!(r.money.arriving, "0");
    assert!(r.money.arrival_end.expect("an end") > r.as_of.time);
    assert_eq!(v["money"]["arriving"], json!(r.money.arriving));
    // The founder's first grant is past its cliff; a grant made later is not.
    let cliffs: Vec<bool> = r
        .team
        .grants
        .iter()
        .filter_map(|g| g.cliff.map(|c| c.passed))
        .collect();
    assert!(
        cliffs.contains(&true) && cliffs.contains(&false),
        "{cliffs:?}"
    );
    assert!(r.first_backed_at.is_some());
}

#[tokio::test]
async fn a_pair_runs_project_b_and_a_wound_down_project_has_the_wound_down_shape() {
    let b = build_from("B_pair").await.expect("builds");
    assert!(b.record.runner.is_pair);
    let signers = b.record.runner.signers.clone().expect("two signers");
    assert_ne!(signers[0], signers[1]);
    assert_eq!(
        b.record.contracts.pair.as_deref(),
        Some(b.record.runner.address.as_str())
    );
    let forfeit = b
        .record
        .team
        .grants
        .iter()
        .find_map(|g| g.forfeit.as_ref())
        .expect("a forfeit announced by the Pair");
    assert!(!forfeit.by_member, "both signers announced it");

    for end in ["A_end", "B_end"] {
        let e = build_from(end).await.expect("builds");
        let r = &e.record;
        assert_eq!(r.quiet.state, record::QuietState::WoundDown, "{end}");
        assert!(r.wind_down.is_some());
        assert_eq!(r.quiet.since, r.wind_down.expect("wound").at);
        assert!(r.clock.active_until.is_none() && r.door.shuts_at.is_none() && !r.door.open_now);
        assert!(r.quiet.next.is_none() && r.quiet.quiet_from.is_none());
        assert_eq!(
            (r.allowance.box_.as_str(), r.allowance.box_cap.as_str()),
            ("0", "0")
        );
        assert_eq!(r.refresh_every_secs, 3600, "nothing is accruing");
    }
}

#[tokio::test]
async fn the_record_names_the_block_it_is_true_for_and_carries_the_launch_facts() {
    let (fx, ledger, as_of, _) = load("A_live");
    let built = build_from("A_live").await.expect("builds");
    assert_eq!(built.record.as_of.block, as_of.block);
    assert_eq!(built.record.as_of.time, as_of.time);
    assert_eq!(built.record.built_at, as_of.time + 131);
    assert_eq!(built.record.key, ledger.key);
    assert_eq!(built.record.launcher, super::word::hex0x(&fx.launcher));
    assert_eq!(built.record.launched_at, ledger.launched_at);
    assert_eq!(built.record.contracts.treasury, ledger.contracts.treasury);
}

// ---------------------------------------------------- errors, never a record

#[tokio::test]
async fn a_failed_read_is_an_error_and_never_a_record() {
    let (fx, ledger, as_of, mut chain) = load("A_live");
    // One answer missing: the node could not serve it.
    let key = (
        address_of(&ledger.contracts.treasury),
        buzz_evm_allowance::abi::selector("pot()").to_vec(),
    );
    assert!(chain.answers.remove(&key).is_some());
    let err = views::read(&chain, fx.launcher, &ledger, as_of.block, as_of.time)
        .await
        .expect_err("a missing answer fails the read");
    assert!(format!("{err:#}").contains("no captured answer"), "{err:#}");
    // The node cannot serve the block asked for.
    let (_, chain) = BookChain::load(&fx, "A_live");
    let err = views::read(&chain, fx.launcher, &ledger, as_of.block + 1, as_of.time)
        .await
        .expect_err("another block is not served");
    assert!(format!("{err:#}").contains("cannot serve"), "{err:#}");
}

/// Change the answer to the call named by `sig` (and `args`) to `word`.
pub(super) fn set_answer(
    chain: &mut BookChain,
    to: &[u8; 20],
    sig: &str,
    args: &[[u8; 32]],
    word: u128,
) {
    let mut data = buzz_evm_allowance::abi::selector(sig).to_vec();
    for a in args {
        data.extend_from_slice(a);
    }
    let answer = chain
        .answers
        .get_mut(&(*to, data))
        .unwrap_or_else(|| panic!("{sig} was not captured"));
    let mut w = vec![0u8; 32];
    w[16..].copy_from_slice(&word.to_be_bytes());
    *answer = w;
}

pub(super) async fn build_with(
    fx: &Fixture,
    ledger: &Ledger,
    as_of: &AsOf,
    chain: &BookChain,
) -> anyhow::Result<Record> {
    let read = views::read(chain, fx.launcher, ledger, as_of.block, as_of.time).await?;
    numbers::build(
        ledger,
        as_of,
        &read,
        &Cadence::default(),
        as_of.time + 1,
        &SocialInput::empty(),
    )
    .map(|(record, _)| record)
}

pub(super) fn address_of(text: &str) -> [u8; 20] {
    super::word::parse_fixed::<20>(text).expect("address")
}

/// The raise waiting is read from the Treasury and checked against the events:
/// a rate that does not fit 32 bits, or a different one, publishes nothing
/// (it never becomes zero or a wrapped number).
#[tokio::test]
async fn a_pending_rate_that_is_oversized_or_different_publishes_nothing() {
    let (fx, ledger, as_of, chain) = load("A_live");
    let waiting = ledger.pending_rate.expect("the book has a raise waiting");
    let treasury = address_of(&ledger.contracts.treasury);
    for wrong in [
        u128::from(waiting.ppm) + (1u128 << 32), // does not fit 32 bits
        u128::from(waiting.ppm) + 1,
        0,
    ] {
        let mut tampered = BookChain {
            block: chain.block,
            answers: chain.answers.clone(),
        };
        set_answer(&mut tampered, &treasury, "pendingRatePpm()", &[], wrong);
        let err = build_with(&fx, &ledger, &as_of, &tampered)
            .await
            .expect_err("refused");
        let text = format!("{err:#}");
        assert!(
            text.contains("nothing is published") && text.contains("pending rate"),
            "{wrong}: {text}"
        );
    }
}

#[tokio::test]
async fn a_view_that_disagrees_with_the_events_publishes_nothing_and_names_both_numbers() {
    let (fx, ledger, as_of, chain) = load("A_live");
    let treasury = address_of(&ledger.contracts.treasury);
    // The contract says the stored pot is one unit higher than the events add up to.
    let real = ledger.pot;
    let mut tampered = BookChain {
        block: chain.block,
        answers: chain.answers.clone(),
    };
    set_answer(&mut tampered, &treasury, "pot()", &[], real + 1);
    let err = build_with(&fx, &ledger, &as_of, &tampered)
        .await
        .expect_err("refused");
    let text = format!("{err:#}");
    assert!(
        text.contains("nothing is published") && text.contains("pot"),
        "{text}"
    );
    assert!(
        text.contains(&real.to_string()) && text.contains(&(real + 1).to_string()),
        "{text}"
    );

    // The settled box cap is the contract's own: one unit off is refused.
    let mut cap = BookChain {
        block: chain.block,
        answers: chain.answers.clone(),
    };
    let view_cap = {
        let ok = build_with(&fx, &ledger, &as_of, &chain)
            .await
            .expect("builds");
        ok.allowance.box_cap.parse::<u128>().expect("amount")
    };
    set_answer(&mut cap, &treasury, "boxCap()", &[], view_cap + 1);
    let err = build_with(&fx, &ledger, &as_of, &cap)
        .await
        .expect_err("refused");
    assert!(format!("{err:#}").contains("boxCap"), "{err:#}");

    // So is active time, and the Treasury's own stored time.
    let mut active = BookChain {
        block: chain.block,
        answers: chain.answers.clone(),
    };
    let now = build_with(&fx, &ledger, &as_of, &chain)
        .await
        .expect("builds")
        .clock
        .active_seconds;
    set_answer(
        &mut active,
        &treasury,
        "activeNow()",
        &[],
        u128::from(now) + 1,
    );
    let err = build_with(&fx, &ledger, &as_of, &active)
        .await
        .expect_err("refused");
    assert!(format!("{err:#}").contains("activeNow"), "{err:#}");
}

#[tokio::test]
async fn a_treasury_holding_less_than_it_owes_publishes_nothing() {
    // Every number agrees with the events, but the dollar balance is short: the
    // record's own checks (not the ledger's) refuse it.
    let (fx, ledger, as_of, mut chain) = load("A_live");
    let mut treasury_word = [0u8; 32];
    treasury_word[12..].copy_from_slice(&address_of(&ledger.contracts.treasury));
    set_answer(
        &mut chain,
        &address_of(&ledger.contracts.dollar),
        "balanceOf(address)",
        &[treasury_word],
        1,
    );
    let err = build_with(&fx, &ledger, &as_of, &chain)
        .await
        .expect_err("refused");
    let text = format!("{err:#}");
    assert!(
        text.contains("fails its own checks") && text.contains("holds 1"),
        "{text}"
    );
}

#[tokio::test]
async fn a_ledger_that_missed_an_event_publishes_nothing() {
    let fx = Fixture::load();
    let (project, chain) = BookChain::load(&fx, "A_live");
    let mut rows = fx.rows(&project, chain.block);
    // Lose one join: the events no longer add up to the contract's numbers.
    let at = rows
        .iter()
        .position(|r| r.event == "Joined")
        .expect("a join");
    rows.remove(at);
    let ledger = Ledger::from_logs(&rows).expect("reads").expect("launched");
    let as_of = AsOf {
        chain_id: 31337,
        launcher: fx.launcher,
        block: chain.block,
        time: fx.time_of(chain.block),
    };
    let err = build_with(&fx, &ledger, &as_of, &chain)
        .await
        .expect_err("refused");
    assert!(format!("{err:#}").contains("disagree"), "{err:#}");
}

// ------------------------------------------------ what counts as a change

#[test]
fn only_events_change_the_facts_and_time_changes_what_is_shown() {
    let base = example();
    let facts = |v: &Value| numbers::facts_of(v);
    let shown = |v: &Value| numbers::without_as_of(v);

    // A later block with nothing new: the clock and the numbers that move with it.
    let mut later = base.clone();
    later["asOf"] = json!({"block": 99, "time": 1795099999u64});
    later["builtAt"] = json!(1795100100u64);
    later["money"]["pot"] = json!("7322810999");
    later["allowance"]["box"] = json!("43974999");
    later["value"]["leaveValue"] = json!("10059");
    later["team"]["grants"][2]["cliff"]["endsAtIfActive"] = json!(1799841999u64);
    later["clock"]["activeSeconds"] = json!(9158499u64);
    later["quiet"]["state"] = json!("quiet");
    later["refreshEverySecs"] = json!(3600);
    assert_eq!(facts(&base), facts(&later), "time alone changes no fact");
    assert_ne!(
        shown(&base),
        shown(&later),
        "but it changes what a reader sees"
    );
    assert_eq!(
        shown(&base),
        shown(&{
            let mut same = base.clone();
            same["builtAt"] = json!(1u64);
            same["asOf"]["time"] = json!(2u64);
            same
        }),
        "builtAt and asOf are not what is shown"
    );

    // An event: a join, a check-in, a new grant, a door switch.
    for (path, value) in [
        (vec!["totals", "joined"], json!("7000000001")),
        (vec!["clock", "lastCheckIn"], json!(1795003201u64)),
        (
            vec!["team", "grantCount"],
            json!(base["team"]["grantCount"].as_u64().expect("count") + 1),
        ),
        (
            vec!["door", "switchOn"],
            json!(!base["door"]["switchOn"].as_bool().expect("flag")),
        ),
        (vec!["allowance", "ratePpm"], json!(1200)),
        (vec!["money", "feesOwed"], json!("1")),
    ] {
        let mut changed = base.clone();
        let mut at = &mut changed;
        for key in &path[..path.len() - 1] {
            at = &mut at[*key];
        }
        at[path[path.len() - 1]] = value;
        assert_ne!(facts(&base), facts(&changed), "{path:?} is a fact");
    }
}

/// Rows of project `name` up to `block` with the newest `event` row's `field`
/// raised by one unit.
fn rows_with_one_unit_more(
    fx: &Fixture,
    name: &str,
    block: u64,
    event: &str,
    field: &str,
) -> Option<Vec<super::ledger::LogRow>> {
    let mut rows = fx.rows(name, block);
    let row = rows.iter_mut().rev().find(|r| r.event == event)?;
    let now: u128 = row.fields[field].as_str()?.parse().ok()?;
    row.fields[field] = Value::String((now + 1).to_string());
    Some(rows)
}

/// An event value one unit off, in a sum that no single view checks, is never
/// signed: the totals identity and the cross-checks refuse it. The honest rows
/// build, and each of these events is in the run (the test would otherwise
/// check nothing).
#[tokio::test]
async fn an_event_value_one_unit_off_is_never_signed_into_a_record() {
    let fx = Fixture::load();
    let (project, chain) = BookChain::load(&fx, "A_live");
    let as_of = AsOf {
        chain_id: 31337,
        launcher: fx.launcher,
        block: chain.block,
        time: fx.time_of(chain.block),
    };
    let build_rows = |rows: Vec<super::ledger::LogRow>| {
        let (fx, chain, as_of) = (&fx, &chain, &as_of);
        async move {
            let ledger = Ledger::from_logs(&rows)?.expect("launched");
            build_with(fx, &ledger, as_of, chain).await
        }
    };
    build_rows(fx.rows(&project, chain.block))
        .await
        .expect("the honest rows build");
    let mut tried = 0;
    let mut accepted = Vec::new();
    for (event, field) in [
        ("Left", "cash"),
        ("TeamLeft", "cash"),
        ("AllowanceDrawn", "amount"),
        ("Joined", "paid"),
        ("RevenueAdded", "amount"),
        ("GrantClaimed", "amount"),
        ("GrantMade", "startActive"),
        ("FeesCollected", "amount"),
    ] {
        let Some(rows) = rows_with_one_unit_more(&fx, &project, chain.block, event, field) else {
            continue;
        };
        tried += 1;
        if build_rows(rows).await.is_ok() {
            accepted.push(format!("{event}.{field}"));
        }
    }
    assert!(tried >= 4, "only {tried} of the events are in the run");
    assert!(
        accepted.is_empty(),
        "a hostile event value one unit off was signed into a record: {accepted:?}"
    );
}

// ---------------------------------------------------------- step 2: the stream and the tasks

/// One account of the contract's stream: what a settle at `t` does to the stored numbers, by the
/// formula the step 2 contracts use (`new_formula`) or the one step 1 used (`false`). No allowance
/// accrues (rate zero), so only the stream moves.
fn settle_stream(t: u64, s: &record::Stored, new_formula: bool) -> record::Stored {
    let mut s = *s;
    if s.arriving != 0 {
        let released = if t >= s.arrival_end {
            s.arriving
        } else if new_formula {
            let target = mul_div(
                s.arrival_total,
                u128::from(t - s.arrival_start),
                u128::from(s.arrival_end - s.arrival_start),
            )
            .expect("fits");
            target.saturating_sub(s.arrival_total - s.arriving)
        } else {
            mul_div(
                s.arriving,
                u128::from(t - s.last_settle),
                u128::from(s.arrival_end - s.last_settle),
            )
            .expect("fits")
        };
        s.arriving -= released;
        s.pot += released;
    }
    s.last_settle = t;
    s
}

/// What a second payment does to the stream (`Treasury.addRevenue`): the new stream starts now with
/// what had not arrived and the new money, and ends at the weighted time.
fn add_outside(t: u64, s: &record::Stored, x: u128) -> record::Stored {
    let mut s = settle_stream(t, s, true);
    let old = s.arriving;
    s.arrival_end = if old == 0 {
        t + s.unit
    } else {
        let rem = u128::from(s.arrival_end - t);
        let end = (old * rem + x * u128::from(s.unit)).div_ceil(old + x);
        t + u64::try_from(end).expect("fits")
    };
    s.arrival_start = t;
    s.arrival_total = old + x;
    s.arriving = old + x;
    s
}

/// A5b: settling every second gives what settling once gives, with outside money mid-stream, a
/// second payment merged into it, and a settle inside. The step 1 formula fails the same test.
#[test]
fn settling_every_second_gives_the_pot_settling_once_gives() {
    let base = record::Stored {
        last_settle: 1_000,
        active_end: 0,
        arrival_end: 0,
        arrival_start: 0,
        arrival_total: 0,
        rate_ppm: 0,
        unit: 700,
        pot: 5_000_000_000,
        box_: 0,
        arriving: 0,
        active_seconds: 0,
        locked: 0,
        due_c: 0,
    };
    // Outside money at 1,000; a second payment merges into it at 1,300.
    let first = add_outside(1_000, &base, 3_000_000_001);
    let merged = add_outside(1_300, &first, 1_000_000_007);
    for end in [1_150u64, 1_299, 1_300, 1_301, 1_650, 1_999, 2_100, 2_500] {
        let from = if end < 1_300 { &first } else { &merged };
        let once = record::roll_forward(end, from).expect("settles");
        for new_formula in [true, false] {
            // Settle at every second from the stream's own start, then read the numbers at `end`.
            let mut s = *from;
            let begin = from.last_settle;
            for t in (begin + 1)..=end {
                s = settle_stream(t, &s, new_formula);
            }
            if new_formula {
                assert_eq!(
                    (s.pot, s.arriving),
                    (once.pot, once.arriving),
                    "settling every second and settling once agree at {end}"
                );
            }
        }
    }
    // The step 1 formula (`arriving x (t - last) / (end - last)`) does not: settled every second it
    // releases less than the stream's own line, so the money is held back.
    let (mut old, mut new) = (merged, merged);
    for t in 1_301..=1_700 {
        old = settle_stream(t, &old, false);
        new = settle_stream(t, &new, true);
    }
    assert_ne!(old.pot, new.pot, "the step 1 formula gives another pot");
    assert!(old.pot < new.pot, "and holds money back");
}

/// A5: a block where a task has run out and nobody has settled. The record's `money.pot` and
/// `money.locked` are what a settle at that time gives: the run-out task's claim is back in the pot,
/// and out of `locked`. The contract's own settled views agree (`leaveValue`, `boxCap`).
#[tokio::test]
async fn a_run_out_task_is_returned_in_the_settled_pot_and_locked() {
    let built = build_from("A_overdue").await.expect("builds");
    let (r, v) = (&built.record, &built.value);
    let tasks = r.tasks.as_ref().expect("a book");
    let over: Vec<_> = tasks
        .list
        .iter()
        .filter(|row| {
            row.state == record_tasks::TaskStateRec::Taken
                && row.deadline.is_some_and(|d| d <= r.as_of.time)
        })
        .collect();
    assert_eq!(
        over.len(),
        1,
        "one task has run out and is still taken in the book"
    );
    let claim: u128 = over[0].stayer_claim.parse().expect("amount");
    assert!(claim > 0);
    let (stored_pot, stored_locked) = (n(&v["ledger"]["pot"]), n(&v["ledger"]["locked"]));
    assert_eq!(
        n(&v["money"]["locked"]),
        stored_locked - claim,
        "locked is what the running tasks hold"
    );
    // The pot is the stored pot rolled forward (allowance, arrival) plus the claim, last.
    assert!(
        n(&v["money"]["pot"]) > stored_pot,
        "outside money arrived and the claim came back"
    );
    let settled_without_return = {
        let (fx, ledger, as_of, mut chain) = load("A_overdue");
        let book = address_of(ledger.contracts.tasks.as_deref().expect("a book"));
        // A chain where the book says nothing ran out (`dueC` = 0): the pot is one claim lower.
        let mut when = [0u8; 32];
        when[24..].copy_from_slice(&as_of.time.to_be_bytes());
        set_answer(&mut chain, &book, "dueC(uint256)", &[when], 0);
        let read = views::read(&chain, fx.launcher, &ledger, as_of.block, as_of.time)
            .await
            .expect("reads");
        // The contract's own settled views still include the claim, so a record that leaves it out
        // is refused (A6, below); here only the roll-forward is compared.
        let stored = record::Stored {
            last_settle: r.ledger.last_settle,
            active_end: r.clock.active_until.unwrap_or(0),
            arrival_end: r.ledger.arrival_end.unwrap_or(0),
            arrival_start: r.ledger.arrival_start,
            arrival_total: n(&v["ledger"]["arrivalTotal"]),
            rate_ppm: r.allowance.rate_ppm,
            unit: r.unit,
            pot: stored_pot,
            box_: n(&v["ledger"]["box"]),
            arriving: n(&v["ledger"]["arriving"]),
            active_seconds: u128::from(r.ledger.active_seconds),
            locked: stored_locked,
            due_c: read.book.as_ref().expect("a book").due_c,
        };
        record::roll_forward(r.as_of.time, &stored)
            .expect("settles")
            .pot
    };
    assert_eq!(n(&v["money"]["pot"]) - claim, settled_without_return);
    // The contract's own settled `leaveValue()` is made from the same pot.
    assert_leave_value_is_made_from_the_pot(v);
}

/// A6: the box cap check holds with a returned task, and a record that drops the return is refused.
#[tokio::test]
async fn the_box_cap_check_still_holds_with_a_returned_task_and_fails_when_the_return_is_dropped() {
    build_from("A_overdue")
        .await
        .expect("the honest numbers build");
    let (fx, ledger, as_of, mut chain) = load("A_overdue");
    let book = address_of(ledger.contracts.tasks.as_deref().expect("a book"));
    let mut when = [0u8; 32];
    when[24..].copy_from_slice(&as_of.time.to_be_bytes());
    set_answer(&mut chain, &book, "dueC(uint256)", &[when], 0);
    let err = build_with(&fx, &ledger, &as_of, &chain)
        .await
        .expect_err("a pot without the run-out task's money is refused");
    let text = format!("{err:#}");
    assert!(text.contains("boxCap"), "{text}");
}

/// A5c: the cap numbers of a block where a taken task has run out and nobody settled are what a settle
/// then gives: its whole share is out of `usedBps` and out of `frees`, and the room is its share larger.
#[tokio::test]
async fn the_cap_numbers_free_the_share_of_a_taken_task_past_its_deadline() {
    let built = build_from("A_overdue").await.expect("builds");
    let r = &built.record;
    let tasks = r.tasks.as_ref().expect("a book");
    let over = tasks
        .list
        .iter()
        .find(|row| {
            row.state == record_tasks::TaskStateRec::Taken
                && row.deadline.is_some_and(|d| d <= r.as_of.time)
        })
        .expect("a task has run out");
    assert!(
        over.cap_bps > 0,
        "its take is still counted as the contract stores it"
    );
    let (load_fx, ledger, as_of, chain) = load("A_overdue");
    let read = views::read(&chain, load_fx.launcher, &ledger, as_of.block, as_of.time)
        .await
        .expect("reads");
    let view_sum = read.book.as_ref().expect("a book").window_sum_bps;
    assert_eq!(
        u128::from(tasks.cap.used_bps) + u128::from(over.cap_bps),
        view_sum,
        "the view counts the share the next settle gives back"
    );
    assert_eq!(
        tasks.cap.used_bps + tasks.cap.room_bps,
        tasks.limits.cap_bps
    );
    assert_eq!(
        tasks
            .cap
            .frees
            .iter()
            .map(|f| u128::from(f.bps))
            .sum::<u128>(),
        u128::from(tasks.cap.used_bps),
        "the dates add up to the used share, without the given-back take"
    );
    // With the pending give-back switched off the numbers would be the view's own.
    let counted = ledger
        .tasks
        .window_sum(as_of.time, tasks.limits.cap_window_secs);
    assert_eq!(counted, view_sum);
}

/// A project whose `TasksReady` row is not among the stored ones has `tasks: null`, and its record is
/// otherwise exactly the record it would have: the book's rows are not its own and the reader never asks
/// a book for views.
#[tokio::test]
async fn a_project_with_no_tasks_ready_has_tasks_null() {
    // Project B never plans a task: with its `TasksReady` row gone it is a project with no book.
    let fx = Fixture::load();
    let (project, chain) = BookChain::load(&fx, "B_pair");
    let rows: Vec<_> = fx
        .rows(&project, chain.block)
        .into_iter()
        .filter(|r| r.event != "TasksReady")
        .collect();
    let ledger = Ledger::from_logs(&rows).expect("reads").expect("launched");
    assert!(ledger.contracts.tasks.is_none() && ledger.tasks.tasks.is_empty());
    let as_of = AsOf {
        chain_id: 31337,
        launcher: fx.launcher,
        block: chain.block,
        time: fx.time_of(chain.block),
    };
    // A chain that has no book to answer: every book view is removed from the answers.
    let mut chain = chain;
    let book = fx.projects[&project].tasks;
    chain.answers.retain(|(to, _), _| *to != book);
    let record = build_with(&fx, &ledger, &as_of, &chain)
        .await
        .expect("builds");
    assert!(record.tasks.is_none());
    let value = serde_json::to_value(&record).expect("written");
    assert!(value["tasks"].is_null(), "the key is there and null");
    assert!(record::validate(&record).is_empty());
}

/// A17: a book the Treasury does not name is never followed into a record.
#[tokio::test]
async fn a_tasks_book_that_differs_from_the_treasurys_publishes_nothing() {
    let (fx, ledger, as_of, mut chain) = load("A_example");
    let treasury = address_of(&ledger.contracts.treasury);
    let selector = buzz_evm_allowance::abi::selector("tasks()").to_vec();
    let mut other = vec![0u8; 32];
    other[12..].copy_from_slice(&[0x77; 20]);
    *chain
        .answers
        .get_mut(&(treasury, selector))
        .expect("tasks() was captured") = other;
    let err = build_with(&fx, &ledger, &as_of, &chain)
        .await
        .expect_err("a different book is refused");
    assert!(format!("{err:#}").contains("task book"), "{err:#}");
}

/// A14: the example is refused with a row one unit off where a check stands on it: a running task's
/// claim, which the money set aside is made of.
#[test]
fn the_server_accepts_the_example_and_refuses_it_with_a_row_one_unit_off() {
    let value = example();
    let record: Record = serde_json::from_value(value.clone()).expect("parses");
    assert_eq!(record::validate(&record), Vec::<String>::new());
    let mut off = value.clone();
    let rows = off["tasks"]["list"].as_array_mut().expect("rows");
    let running = rows
        .iter_mut()
        .find(|r| r["state"] == "taken")
        .expect("a running task");
    let claim = n(&running["stayerClaim"]);
    running["stayerClaim"] = json!((claim + 1).to_string());
    let bad = record::validate(&serde_json::from_value(off).expect("parses"));
    assert!(
        bad.iter().any(|b| b.contains("money.locked")),
        "a claim one unit off must be named: {bad:?}"
    );
    // A task past its deadline whose claim is not returned: money.locked then disagrees with the
    // stored numbers worked forward.
    let mut late = value.clone();
    let rows = late["tasks"]["list"].as_array_mut().expect("rows");
    let running = rows
        .iter_mut()
        .find(|r| r["state"] == "taken")
        .expect("running");
    running["deadline"] = json!(t(&value["asOf"]["time"]) - 1);
    let bad = record::validate(&serde_json::from_value(late).expect("parses"));
    assert!(
        !bad.is_empty(),
        "a deadline in the past without the return is refused"
    );
}

/// A13: the record is kept fresh while a task is open, and a heartbeat when nothing moves. Only a task's
/// phase moving with the clock does not sign a new record.
#[tokio::test]
async fn refresh_is_600_while_a_task_is_open_and_3600_after() {
    let cadence = Cadence::default();
    // The rule, by each condition alone.
    assert_eq!(numbers::refresh_every(&cadence, false, false, false), 3_600);
    assert_eq!(numbers::refresh_every(&cadence, true, false, false), 600);
    assert_eq!(numbers::refresh_every(&cadence, false, true, false), 600);
    assert_eq!(
        numbers::refresh_every(&cadence, false, false, true),
        600,
        "a task is open"
    );
    // A record never promises more than the settings allow (half a day), whatever the cadence says.
    let wide = Cadence {
        active_secs: 100_000,
        idle_secs: 200_000,
    };
    assert_eq!(numbers::refresh_every(&wide, false, false, true), 43_200);
    assert_eq!(numbers::refresh_every(&wide, false, false, false), 43_200);
    // The run: tasks open at the example block, none at the end of the run.
    let open = build_from("A_example").await.expect("builds");
    assert!(open.record.tasks.as_ref().expect("a book").open_count > 0);
    assert_eq!(open.record.refresh_every_secs, 600);
    let end = build_from("A_end").await.expect("builds");
    assert_eq!(end.record.tasks.as_ref().expect("a book").open_count, 0);
    assert_eq!(
        end.record.refresh_every_secs, 3_600,
        "nothing moves after the last task ended"
    );
}

#[test]
fn a_task_phase_change_alone_does_not_resign() {
    let base = example();
    let facts = |v: &Value| numbers::facts_of(v);
    // What moves with the clock: a notice that ended and the room it left, the amount a take would set
    // aside, the date that comes next, and the money set aside once a task ran out.
    let mut later = base.clone();
    let rows = later["tasks"]["list"].as_array_mut().expect("rows");
    let announced = rows
        .iter_mut()
        .find(|r| r["state"] == "announced")
        .expect("an announced task");
    announced["atMostNow"] = json!("1");
    later["tasks"]["cap"]["usedBps"] = json!(1);
    later["tasks"]["cap"]["roomBps"] = json!(999);
    later["tasks"]["next"] = json!({"at": 1, "kind": "due", "serial": 1});
    later["money"]["locked"] = json!("1");
    assert_eq!(
        facts(&base),
        facts(&later),
        "the clock alone re-signs nothing"
    );
    // What an event changes: a task's state, the open count, a take in the cap's list.
    for (path, value) in [
        (vec!["tasks", "openCount"], json!(0)),
        (vec!["tasks", "nextSerial"], json!(11)),
        (vec!["tasks", "cap", "frees"], json!([])),
        (vec!["tasks", "list"], json!([])),
        (vec!["totals", "paidToWorkers"], json!("1")),
    ] {
        let mut changed = base.clone();
        let mut at = &mut changed;
        for key in &path[..path.len() - 1] {
            at = &mut at[*key];
        }
        at[path[path.len() - 1]] = value;
        assert_ne!(facts(&base), facts(&changed), "{path:?} is a fact");
    }
}

/// What the contract's settled `leaveValue()` is made of: the record's pot.
fn assert_leave_value_is_made_from_the_pot(v: &Value) {
    let (pot, paid_in) = (n(&v["money"]["pot"]), n(&v["money"]["paidIn"]));
    let (b, g) = (n(&v["shares"]["backers"]), n(&v["shares"]["teamCounted"]));
    let a1 = pot.min(paid_in);
    let one = 1_000_000_000_000_000_000u128;
    assert_eq!(
        n(&v["value"]["leaveValue"]),
        mul_div(one, a1, b).expect("fits") + mul_div(one, pot - a1, b + g).expect("fits"),
        "the contract's settled leave value is the one the record's pot gives"
    );
}

/// A block inside the merged stream, a day after the last settle, where no Treasury call settled it. What has
/// arrived since is only in the contract's formula (on the stream's own start and total), and the record's pot
/// is the one the contract's own settled views (`boxCap`, `leaveValue`) are made from.
#[tokio::test]
async fn the_arrival_formula_is_the_contracts_with_a_settle_inside_the_stream() {
    let built = build_from("A_stream").await.expect("builds");
    let (r, v) = (&built.record, &built.value);
    assert!(
        r.ledger.arrival_start < r.ledger.last_settle && r.ledger.last_settle < r.as_of.time,
        "the stream began, was settled, and time has passed since: {} {} {}",
        r.ledger.arrival_start,
        r.ledger.last_settle,
        r.as_of.time
    );
    assert_ne!(r.money.arriving, "0");
    assert!(
        r.money.arrival_end.is_some_and(|e| e > r.as_of.time),
        "still inside the stream"
    );
    assert!(
        n(&v["money"]["pot"]) > n(&v["ledger"]["pot"]),
        "money arrived since the last settle"
    );
    assert_leave_value_is_made_from_the_pot(v);
}

/// A5b, exact, on the real chain: at every settle the run made, the stored numbers the ledger held just before
/// it, worked forward to the settle's time by `roll_forward`, are exactly the numbers the contract's own
/// `Settled` event says it left (pot, box, arriving money, active seconds): the stream with its start and total,
/// the allowance, and the claims of the tasks that ran out. The step 1 arrival formula differs by a few units at
/// some of them (it rounds the time since the last settle, not the stream), so a record built on it would be
/// signed with a pot a few units off that no view tells apart.
#[test]
fn every_settle_of_the_run_is_what_the_roll_forward_gives_from_the_state_before_it() {
    let fx = Fixture::load();
    let rows = fx.rows("A", fx.head());
    let mut checked = 0;
    let mut released_mid_stream = 0;
    for (i, row) in rows.iter().enumerate() {
        if row.role != super::events::Role::Treasury || row.event != "Settled" {
            continue;
        }
        let before = Ledger::from_logs(&rows[..i])
            .expect("reads")
            .expect("launched");
        let t: u64 = row.fields["time"]
            .as_str()
            .expect("time")
            .parse()
            .expect("number");
        let active_end = if before.wind_down.is_some() {
            0
        } else {
            before.last_check_in + 2 * before.unit
        };
        let due_c: u128 = before
            .tasks
            .tasks
            .values()
            .filter(|k| k.state == super::ledger_tasks::TaskState::Taken && k.expires_at <= t)
            .map(|k| k.stayer)
            .sum();
        let stored = record::Stored {
            last_settle: before.last_settle,
            active_end,
            arrival_end: before.arrival_end,
            arrival_start: before.arrival_start,
            arrival_total: before.arrival_total,
            rate_ppm: before.rate_ppm,
            unit: before.unit,
            pot: before.pot,
            box_: before.box_,
            arriving: before.arriving,
            active_seconds: before.active_seconds,
            locked: before.locked,
            due_c,
        };
        let got = record::roll_forward(t, &stored).expect("settles");
        let at = format!("the settle of block {} (time {t})", row.block);
        assert_eq!(got.pot.to_string(), row.fields["potAfter"], "{at}: pot");
        assert_eq!(got.box_.to_string(), row.fields["boxAfter"], "{at}: box");
        assert_eq!(
            got.arriving.to_string(),
            row.fields["arrivingAfter"],
            "{at}: arriving"
        );
        assert_eq!(
            got.active_seconds.to_string(),
            row.fields["activeSecondsAfter"],
            "{at}: active seconds"
        );
        checked += 1;
        if before.arriving != 0 && row.fields["released"] != "0" && t < before.arrival_end {
            released_mid_stream += 1;
        }
    }
    assert!(checked > 20, "{checked} settles were compared");
    assert!(
        released_mid_stream >= 3,
        "{released_mid_stream} settles released outside money inside a stream"
    );
}
