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
use super::views;

const EXAMPLE: &str = include_str!("../../../../docs/next-version/record-v2-example.json");

fn example() -> Value {
    serde_json::from_str(EXAMPLE).expect("the example is JSON")
}

fn n(v: &Value) -> u128 {
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
    door["door"]["openNow"] = json!(false);
    assert!(!record::validate(&serde_json::from_value(door).expect("parses")).is_empty());
    let mut shut = value;
    shut["version"] = json!(3);
    assert!(serde_json::from_value::<Record>(shut)
        .map(|r| !record::validate(&r).is_empty())
        .unwrap_or(true));
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
        rate_ppm: allowance["ratePpm"].as_u64().expect("rate") as u32,
        unit: t(&r["unit"]),
        pot: n(&l["pot"]),
        box_: n(&l["box"]),
        arriving: n(&l["arriving"]),
        active_seconds: u128::from(t(&l["activeSeconds"])),
    };
    let settled = record::roll_forward(as_of, &stored).expect("settles");
    assert_eq!(settled.pot, n(&money["pot"]));
    assert_eq!(settled.box_, n(&allowance["box"]));
    assert_eq!(settled.arriving, n(&money["arriving"]));
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
}

// ------------------------------------------------------ the builder, real run

struct Built {
    record: Record,
    value: Value,
}

async fn build_from(name: &str) -> anyhow::Result<Built> {
    let (fx, ledger, as_of, chain) = load(name);
    let read = views::read(&chain, fx.launcher, &ledger, as_of.block).await?;
    let record = numbers::build(
        &ledger,
        &as_of,
        &read,
        &Cadence::default(),
        as_of.time + 131,
    )?;
    let value = serde_json::to_value(&record)?;
    Ok(Built { record, value })
}

fn load(name: &str) -> (Fixture, Ledger, AsOf, BookChain) {
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
    let err = views::read(&chain, fx.launcher, &ledger, as_of.block)
        .await
        .expect_err("a missing answer fails the read");
    assert!(format!("{err:#}").contains("no captured answer"), "{err:#}");
    // The node cannot serve the block asked for.
    let (_, chain) = BookChain::load(&fx, "A_live");
    let err = views::read(&chain, fx.launcher, &ledger, as_of.block + 1)
        .await
        .expect_err("another block is not served");
    assert!(format!("{err:#}").contains("cannot serve"), "{err:#}");
}

/// Change the answer to the call named by `sig` (and `args`) to `word`.
fn set_answer(chain: &mut BookChain, to: &[u8; 20], sig: &str, args: &[[u8; 32]], word: u128) {
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

async fn build_with(
    fx: &Fixture,
    ledger: &Ledger,
    as_of: &AsOf,
    chain: &BookChain,
) -> anyhow::Result<Record> {
    let read = views::read(chain, fx.launcher, ledger, as_of.block).await?;
    numbers::build(ledger, as_of, &read, &Cadence::default(), as_of.time + 1)
}

fn address_of(text: &str) -> [u8; 20] {
    super::word::parse_fixed::<20>(text).expect("address")
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
        (vec!["team", "grantCount"], json!(4)),
        (vec!["door", "switchOn"], json!(false)),
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
