//! The step 4 keys of the record (`pause`, `earlierGrants`, `team.earlierPool`, `team.earlierReserve`) against the second
//! real run of the contracts (`testdata/pot-run-pause.json`: both switches on, played by
//! `scripts/chain-reader-fixture.py --pause`), and against records made to break one rule at a time.
//!
//! The run is project `Z`: three backers, a holder who parks to the line, a Back that loses the line, the line reached
//! again, the warning day passing, two earlier-backer claims (invented rows), a plain transfer to the pause, an un-park
//! and a take-out. The books: `Z_armed` (armed, not yet paused), `Z_paused` (the pause is on, one row claimed) and
//! `Z_end` (nothing parked, two rows claimed).

use std::collections::BTreeSet;

use serde_json::{json, Value};

use super::events::{self, Role};
use super::fixture::{BookChain, Fixture};
use super::ledger::Ledger;
use super::numbers::{self, AsOf, Cadence};
use super::record::{self, Record};
use super::record_social::{SocialInput, SocialReport};
use super::record_step4;
use super::record_tests::Built;
use super::views;
use super::word::hex0x;

const EXAMPLE_PAUSE: &str =
    include_str!("../../../../docs/next-version/record-v2-example-pause.json");
/// Where the second example lives, for the test that writes it (`UPDATE_EXAMPLE=1`).
const EXAMPLE_PAUSE_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../docs/next-version/record-v2-example-pause.json"
);
/// One whole Share, in wei.
const ONE: u128 = 1_000_000_000_000_000_000;

fn load(name: &str) -> (Fixture, Ledger, AsOf, BookChain) {
    let fx = Fixture::load_pause();
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

/// Build the record at book `name` from `ledger` and `chain`, returning it with what the social report said.
async fn build_with(
    fx: &Fixture,
    ledger: &Ledger,
    as_of: &AsOf,
    chain: &BookChain,
) -> anyhow::Result<(Built, SocialReport)> {
    let read = views::read(chain, fx.launcher, ledger, as_of.block, as_of.time).await?;
    let rows = fx.rows("Z", as_of.block);
    let windows = super::record_social_tests::windows_of(&rows, ledger, as_of);
    let social = SocialInput {
        rows: &rows,
        held: Some((&windows.0, &windows.1)),
    };
    let (record, report) = numbers::build(
        ledger,
        as_of,
        &read,
        &Cadence::default(),
        as_of.time + 131,
        &social,
    )?;
    let value = serde_json::to_value(&record)?;
    Ok((Built { record, value }, report))
}

async fn build(name: &str) -> Built {
    let (fx, ledger, as_of, chain) = load(name);
    let (built, report) = build_with(&fx, &ledger, &as_of, &chain)
        .await
        .expect("the record builds");
    assert!(
        report.failed.is_empty(),
        "no key was left null: {:?}",
        report.failed
    );
    built
}

fn amount(v: &Value) -> u128 {
    v.as_str().expect("an amount").parse().expect("a number")
}

// ------------------------------------------------------------------------------------------ the run itself

/// Every event only a deployment with the switches on emits is in this run, and decodes.
#[test]
fn the_second_run_emits_every_switched_event_and_each_one_decodes() {
    let fx = Fixture::load_pause();
    let mut seen: BTreeSet<(&'static str, &'static str)> = BTreeSet::new();
    for (role, _, row) in fx.decoded() {
        let def = events::EVENTS
            .iter()
            .find(|e| e.role == role && e.name == row.event)
            .expect("an event of the table");
        seen.insert((role.as_str(), def.name));
    }
    for def in events::EVENTS {
        if super::fixture::only_with_the_switches_on(def.role, def.name) {
            assert!(
                seen.contains(&(def.role.as_str(), def.name)),
                "the second run never emitted {:?}.{}",
                def.role,
                def.name
            );
        }
    }
}

/// The ledger of the run: the Team supply counts the earlier pool, the claims add up, and each parker's
/// holding is the Shares they have, parked or not; the pause contract is nobody's holding.
#[test]
fn the_ledger_counts_the_earlier_pool_the_claims_and_parked_shares_as_holdings() {
    let (fx, ledger, _, _) = load("Z_paused");
    let pool = ledger
        .earlier_pool
        .expect("the launch funded an earlier pool");
    assert_eq!(pool, 3_540 * ONE + ONE / 2);
    assert_eq!(
        ledger.team,
        ledger.team_pool + pool,
        "the Team supply is the founder's pool and the earlier pool"
    );
    assert!(ledger.earlier_bound);
    assert_eq!(
        ledger.earlier_claimed,
        (1, 1_000 * ONE),
        "one row claimed by then"
    );
    // The holder who parked is still a holder of everything they put in: what they were minted less what they took out.
    let rows = fx.rows("Z", fx.book_block("Z_paused"));
    let who = fx.json["accounts"]["account2"].as_str().expect("account");
    let minted: u128 = rows
        .iter()
        .filter(|r| r.role == Role::Shares && r.event == "Transfer")
        .filter(|r| r.fields["to"] == who && r.fields["from"] == hex0x(&[0u8; 20]))
        .map(|r| {
            r.fields["value"]
                .as_str()
                .expect("value")
                .parse::<u128>()
                .expect("n")
        })
        .sum();
    let seen = &ledger.pause_seen;
    let parked = seen
        .parked_by
        .get(who)
        .copied()
        .expect("the holder has Shares parked");
    assert!(
        parked > 0 && parked == seen.parked_total,
        "one parker holds it all"
    );
    let holding = ledger
        .holders(&BTreeSet::new())
        .into_iter()
        .find(|h| h.account == who)
        .expect("the parker is a holder")
        .shares;
    assert_eq!(holding, minted, "parking took nothing from the holding");
    // The pause contract, which holds the parked Shares and one Share sent by a plain transfer, is no holder.
    let pause = ledger
        .contracts
        .pause
        .clone()
        .expect("the project has a pause");
    assert!(ledger
        .holders(&BTreeSet::new())
        .iter()
        .all(|h| h.account != pause));
    assert_eq!(
        ledger.shares_in_hands(),
        ledger.shares,
        "the holdings add up to the supply"
    );
}

// ------------------------------------------------------------------------------------------ the keys

#[tokio::test]
async fn the_pause_key_follows_the_run_armed_then_paused_then_lifted() {
    let armed = build("Z_armed").await.value;
    let p = &armed["pause"];
    assert_eq!(p["contract"], armed["contracts"]["pause"]);
    assert_eq!(p["lineDivisor"], 3);
    assert_eq!(p["dayLength"], 604_800 / 7);
    assert_eq!(p["paused"], false);
    assert!(p["armedAt"].is_u64() && p["since"].is_null());
    assert_eq!(
        p["pausesFrom"].as_u64().expect("a time"),
        p["armedAt"].as_u64().expect("a time") + 604_800 / 7
    );
    assert_eq!(p["parkerCount"], 1);
    assert_eq!(
        amount(&p["parkedTotal"]),
        amount(&p["line"]),
        "parked to the line exactly"
    );
    // The promise of a fresh record is the short one while the line is reached.
    assert_eq!(armed["refreshEverySecs"], 600);

    let paused = build("Z_paused").await.value;
    let p = &paused["pause"];
    assert_eq!(p["paused"], true);
    assert_eq!(
        p["since"], p["pausesFrom"],
        "it began when the warning day ended"
    );
    assert!(
        p["pausesFrom"].as_u64().expect("time") <= paused["asOf"]["time"].as_u64().expect("time")
    );

    let end = build("Z_end").await.value;
    let p = &end["pause"];
    assert_eq!(p["parkedTotal"], "0");
    assert_eq!(p["parkerCount"], 0);
    assert_eq!(p["paused"], false);
    assert!(p["armedAt"].is_null() && p["pausesFrom"].is_null() && p["since"].is_null());
}

#[tokio::test]
async fn the_pause_key_names_nobody_and_the_claim_key_lists_no_row() {
    let paused = build("Z_paused").await.value;
    let p = paused["pause"].as_object().expect("the pause");
    let keys: BTreeSet<&str> = p.keys().map(String::as_str).collect();
    assert_eq!(
        keys,
        BTreeSet::from([
            "contract",
            "parkedTotal",
            "line",
            "dayLength",
            "lineDivisor",
            "armedAt",
            "pausesFrom",
            "paused",
            "since",
            "parkerCount",
        ])
    );
    let e = paused["earlierGrants"].as_object().expect("the claim key");
    let keys: BTreeSet<&str> = e.keys().map(String::as_str).collect();
    assert_eq!(
        keys,
        BTreeSet::from([
            "contract",
            "bound",
            "root",
            "textHash",
            "total",
            "rows",
            "claimedRows",
            "claimedTotal",
            "clockSecs",
        ])
    );
    assert!(
        e.values().all(|v| !v.is_array() && !v.is_object()),
        "no list of rows or claims, only totals and counts"
    );
    // Every address in either key is a contract (the pause, the claim contract): never an account of a person.
    for key in [p, e] {
        let addresses: Vec<&str> = key
            .values()
            .filter_map(Value::as_str)
            .filter(|s| s.len() == 42 && s.starts_with("0x"))
            .collect();
        assert_eq!(
            addresses.len(),
            1,
            "one address, the contract: {addresses:?}"
        );
    }
}

#[tokio::test]
async fn the_claim_key_and_the_team_numbers_follow_the_claims() {
    let armed = build("Z_armed").await.value;
    let e = &armed["earlierGrants"];
    assert_eq!(e["bound"], true);
    assert_eq!(
        (e["rows"].as_u64(), e["claimedRows"].as_u64()),
        (Some(4), Some(1))
    );
    assert_eq!(amount(&e["total"]), 3_540 * ONE + ONE / 2);
    assert_eq!(amount(&e["claimedTotal"]), 1_000 * ONE);
    assert_eq!(e["clockSecs"], 365 * 86_400);
    let team = &armed["team"];
    assert_eq!(
        team["pool"],
        (10_000_000 * ONE).to_string(),
        "the founder's pool is as it was"
    );
    assert_eq!(team["earlierPool"], e["total"]);
    assert_eq!(amount(&team["earlierReserve"]), 2_540 * ONE + ONE / 2);
    // What the runner can grant leaves the reserve out.
    assert_eq!(
        amount(&team["ungranted"]),
        amount(&team["inVester"]) - amount(&team["promised"]) - amount(&team["earlierReserve"])
    );
    // The claimed grant is listed as any grant, protected.
    let grants = team["grants"].as_array().expect("grants");
    assert_eq!(grants.len(), 1);
    assert_eq!(grants[0]["kind"], "protected");
    assert_eq!(amount(&grants[0]["granted"]), 1_000 * ONE);

    let end = build("Z_end").await.value;
    assert_eq!(end["earlierGrants"]["claimedRows"], 2);
    assert_eq!(amount(&end["earlierGrants"]["claimedTotal"]), 3_500 * ONE);
    assert_eq!(amount(&end["team"]["earlierReserve"]), 40 * ONE + ONE / 2);
    assert_eq!(end["team"]["grants"].as_array().expect("grants").len(), 2);
}

/// A project of a deployment with the switches off has all four keys `null`, and an old record that has none of them
/// parses and reads back as `null`.
#[test]
fn a_project_without_the_things_has_null_keys_and_an_old_record_still_reads() {
    let example = super::record_tests::example();
    assert!(example["pause"].is_null() && example["earlierGrants"].is_null());
    assert!(
        example["team"]["earlierPool"].is_null() && example["team"]["earlierReserve"].is_null()
    );
    assert!(example["contracts"]["pause"].is_null());
    // A record signed before these keys existed has none of them: they read as null and it still validates.
    let mut old = example.clone();
    old.as_object_mut().expect("object").remove("pause");
    old.as_object_mut().expect("object").remove("earlierGrants");
    old["team"]
        .as_object_mut()
        .expect("object")
        .remove("earlierPool");
    old["team"]
        .as_object_mut()
        .expect("object")
        .remove("earlierReserve");
    old["contracts"]
        .as_object_mut()
        .expect("object")
        .remove("pause");
    let record: Record = serde_json::from_value(old).expect("an old record parses");
    assert!(record.pause.is_none() && record.earlier_grants.is_none());
    assert_eq!(record::validate(&record), Vec::<String>::new());
}

// ------------------------------------------------------------------------------------------ one key at a time

/// A pause that cannot be read leaves its key `null` and says why; nothing else in the record changes.
#[tokio::test]
async fn a_pause_that_cannot_be_read_is_null_and_the_rest_of_the_record_stands() {
    let (fx, ledger, as_of, mut chain) = load("Z_paused");
    let pause = hex_to_20(ledger.contracts.pause.as_deref().expect("a pause"));
    let before = {
        let (built, _) = build_with(&fx, &ledger, &as_of, &chain)
            .await
            .expect("builds");
        built.value
    };
    chain.answers.retain(|(to, _), _| *to != pause);
    let (built, report) = build_with(&fx, &ledger, &as_of, &chain)
        .await
        .expect("the record still builds");
    assert!(built.value["pause"].is_null());
    assert_eq!(report.failed.len(), 1, "{:?}", report.failed);
    assert!(
        report.failed[0].starts_with("pause: left null:"),
        "{:?}",
        report.failed
    );
    let mut want = before;
    want["pause"] = Value::Null;
    want["refreshEverySecs"] = built.value["refreshEverySecs"].clone();
    assert_eq!(
        built.value, want,
        "only the pause key and the promise of the next record changed"
    );
}

#[tokio::test]
async fn a_claim_contract_that_cannot_be_read_is_null_and_the_team_numbers_stand() {
    let (fx, ledger, as_of, mut chain) = load("Z_paused");
    let earlier = hex_to_20(
        ledger
            .contracts
            .earlier
            .as_deref()
            .expect("a claim contract"),
    );
    chain.answers.retain(|(to, _), _| *to != earlier);
    let (built, report) = build_with(&fx, &ledger, &as_of, &chain)
        .await
        .expect("the record still builds");
    assert!(built.value["earlierGrants"].is_null());
    assert!(report
        .failed
        .iter()
        .any(|l| l.starts_with("earlierGrants: left null:")));
    assert!(
        !built.value["team"]["earlierReserve"].is_null(),
        "the reserve is the Vester's own number and stands"
    );
}

/// The pause's own answer for `paused` is held against the rule worked out from its numbers: a contract that says
/// paused while the numbers say not (or the other way) leaves the key null. (Guard: `paused` in `pause_from`.)
#[tokio::test]
async fn a_pause_that_disagrees_with_its_own_numbers_is_null() {
    let (fx, ledger, as_of, mut chain) = load("Z_paused");
    let pause = hex_to_20(ledger.contracts.pause.as_deref().expect("a pause"));
    let state = state_call(&chain, pause);
    let answer = chain.answers.get_mut(&state).expect("the state answer");
    let last = answer.len() - 1;
    assert_eq!(answer[last], 1, "paused at this block");
    answer[last] = 0;
    let (built, report) = build_with(&fx, &ledger, &as_of, &chain)
        .await
        .expect("builds");
    assert!(built.value["pause"].is_null());
    assert!(
        report
            .failed
            .iter()
            .any(|l| l.contains("paused is false but its numbers give true")),
        "{:?}",
        report.failed
    );
}

/// The parked Shares the events add up to are held against the pause's own `parkedTotal`.
#[tokio::test]
async fn a_pause_whose_parked_total_is_not_what_the_events_add_up_to_is_null() {
    let (fx, mut ledger, as_of, chain) = load("Z_paused");
    ledger.pause_seen.parked_total += 1;
    let (built, report) = build_with(&fx, &ledger, &as_of, &chain)
        .await
        .expect("builds");
    assert!(built.value["pause"].is_null());
    assert!(
        report
            .failed
            .iter()
            .any(|l| l.contains("the events add up to")),
        "{:?}",
        report.failed
    );
}

/// The Vester's reserve is held against the pool the Launcher funded less what claims granted: a reserve that is not
/// that refuses the whole record (the Team Shares the runner can grant depend on it).
#[tokio::test]
async fn a_reserve_that_is_not_the_pool_less_the_claims_refuses_the_record() {
    let (fx, mut ledger, as_of, chain) = load("Z_paused");
    ledger.earlier_claimed.1 += ONE;
    let err = build_with(&fx, &ledger, &as_of, &chain)
        .await
        .expect_err("the events and the contract disagree");
    assert!(format!("{err:#}").contains("earlierReserve"), "{err:#}");
}

/// The Team supply of a project with an earlier pool is the founder's pool and the earlier pool: without the second
/// the ledger is short by the whole pool and the record is refused. (Guard: `EarlierPoolFunded` in the ledger.)
#[tokio::test]
async fn a_ledger_that_missed_the_earlier_pool_does_not_match_the_contracts() {
    let (fx, mut ledger, as_of, chain) = load("Z_paused");
    ledger.team = ledger.team_pool;
    let err = build_with(&fx, &ledger, &as_of, &chain)
        .await
        .expect_err("the Team supply is short");
    assert!(format!("{err:#}").contains("teamSupply"), "{err:#}");
}

/// `team.ungranted` leaves the earlier reserve out, and the record's own checks refuse one that does not. (Guard: the
/// reserve in `validate`.)
#[tokio::test]
async fn the_records_own_check_refuses_ungranted_shares_that_count_the_reserve() {
    let built = build("Z_paused").await;
    assert_eq!(record::validate(&built.record), Vec::<String>::new());
    let mut wrong = built.value.clone();
    let reserve = amount(&wrong["team"]["earlierReserve"]);
    wrong["team"]["ungranted"] = json!((amount(&wrong["team"]["ungranted"]) + reserve).to_string());
    let bad = record::validate(&serde_json::from_value(wrong).expect("parses"));
    assert!(
        bad.iter().any(|b| b.contains("team.ungranted")),
        "the reserve is not Team Shares anyone can grant: {bad:?}"
    );
    // A pause that says it is paused before it could be is refused by the checks too.
    let mut early = built.value.clone();
    early["pause"]["pausesFrom"] = json!(early["asOf"]["time"].as_u64().expect("time") + 10);
    early["pause"]["armedAt"] =
        json!(early["pause"]["pausesFrom"].as_u64().expect("time") - 86_400);
    early["pause"]["since"] = early["pause"]["pausesFrom"].clone();
    let bad = record::validate(&serde_json::from_value(early).expect("parses"));
    assert!(bad.iter().any(|b| b.contains("pause.paused")), "{bad:?}");
}

// ------------------------------------------------------------------------------------------ each rule of a key

/// The book's ledger, the views read at its block and the block's time (the real run, untouched).
async fn read_at(name: &str) -> (Ledger, views::Views, u64) {
    let (fx, ledger, as_of, chain) = load(name);
    let read = views::read(&chain, fx.launcher, &ledger, as_of.block, as_of.time)
        .await
        .expect("the views read");
    (ledger, read, as_of.time)
}

/// Every rule `pause_from` holds the contract's numbers to, one at a time: break it and the key is `null` with the
/// words that name the rule (and the rest of the record is signed, as RECORD-V2 section 13 says). Remove a rule from
/// `pause_from` and its row fails here; the unbroken book gives the key.
#[tokio::test]
async fn each_rule_of_the_pause_key_leaves_it_null_when_broken() {
    let (ledger, read, time) = read_at("Z_paused").await;
    let (rec, why) = record_step4::pause(&ledger, &read, time);
    assert!(
        rec.is_some() && why.is_none(),
        "the real run gives the key: {why:?}"
    );
    let backers = read.shares_supply;
    type Break = Box<dyn Fn(&mut Ledger, &mut views::PauseViews)>;
    let cases: Vec<(&str, &str, Break)> = vec![
        (
            "another contract's read",
            "not the one the Treasury named",
            Box::new(|_, p| p.address = "0x0000000000000000000000000000000000000001".into()),
        ),
        (
            "parked Shares the events do not add up to",
            "the events add up to",
            Box::new(|_, p| p.parked_total += 1),
        ),
        (
            "backer Shares the token does not say",
            "the Share token says",
            Box::new(|_, p| p.backer_shares += 1),
        ),
        (
            "more parked than there are backer Shares",
            "more than the",
            Box::new(move |l, p| {
                l.pause_seen.parked_total = backers + 1;
                p.parked_total = backers + 1;
            }),
        ),
        (
            "a divisor of one",
            "is outside",
            Box::new(|_, p| p.line_divisor = 1),
        ),
        (
            "a divisor of 101",
            "is outside",
            Box::new(|_, p| p.line_divisor = 101),
        ),
        (
            "a line that is not backers over the divisor",
            "give",
            Box::new(|_, p| p.line += 1),
        ),
        // The day rule's own words ("a seventh of the"): the pausesFrom rule says "warning period" too, so these cases move
        // pausesFrom with the day, and only the day rule can refuse them.
        (
            "a warning day that is not a seventh of the unit",
            "a seventh of the",
            Box::new(|_, p| {
                p.day += 1;
                p.pauses_from += 1;
            }),
        ),
        (
            "a warning day of nothing",
            "a seventh of the",
            Box::new(|_, p| {
                p.day = 0;
                p.pauses_from = p.armed_at;
            }),
        ),
        (
            "a warning day of nothing on a unit too short to have a seventh",
            "a seventh of the",
            Box::new(|l, p| {
                l.unit = 0;
                p.day = 0;
                p.pauses_from = p.armed_at;
            }),
        ),
        (
            "an armedAt the events do not say",
            "the events say it was armed",
            Box::new(|_, p| p.armed_at += 1),
        ),
        (
            "an armedAt after the block",
            "is after the block's time",
            Box::new(move |l, p| {
                l.pause_seen.armed_at = time + 1;
                p.armed_at = time + 1;
            }),
        ),
        (
            "a pausesFrom that is not armedAt plus the day",
            "pausesFrom is",
            Box::new(|_, p| p.pauses_from += 1),
        ),
        (
            "parked Shares with no parker",
            "accounts have",
            Box::new(|l, _| l.pause_seen.parked_by.clear()),
        ),
    ];
    for (what, words, broken) in cases {
        let (mut ledger, mut read, _) = (ledger.clone(), read.clone(), ());
        let mut p = read.pause.clone().expect("a pause").expect("read");
        broken(&mut ledger, &mut p);
        read.pause = Some(Ok(p));
        let (rec, why) = record_step4::pause(&ledger, &read, time);
        assert!(rec.is_none(), "{what}: the key should be null");
        let why = why.unwrap_or_default();
        assert!(
            why.contains(words),
            "{what}: left null for another reason: {why}"
        );
    }
}

/// The same for the claim key's rules.
#[tokio::test]
async fn each_rule_of_the_claim_key_leaves_it_null_when_broken() {
    let (ledger, read, _) = read_at("Z_paused").await;
    let (rec, why) = record_step4::earlier(&ledger, &read);
    assert!(
        rec.is_some() && why.is_none(),
        "the real run gives the key: {why:?}"
    );
    let other = "0x0000000000000000000000000000000000000002";
    type Break = Box<dyn Fn(&mut Ledger, &mut views::EarlierViews)>;
    let cases: Vec<(&str, &str, Break)> = vec![
        (
            "no earlier pool funded",
            "no earlier pool",
            Box::new(|l, _| l.earlier_pool = None),
        ),
        (
            "another claim contract",
            "not the one the Launcher named",
            Box::new(move |_, e| e.address = other.into()),
        ),
        (
            "a pool that is not the funded one",
            "the Launcher funded",
            Box::new(|_, e| e.total += 1),
        ),
        (
            "an empty pool",
            "is outside 1 to",
            Box::new(|l, e| {
                l.earlier_pool = Some(0);
                e.total = 0;
            }),
        ),
        (
            "a pool past its bound",
            "is outside 1 to",
            Box::new(|l, e| {
                l.earlier_pool = Some(record_step4::MAX_EARLIER_POOL + 1);
                e.total = record_step4::MAX_EARLIER_POOL + 1;
            }),
        ),
        (
            "a list with no rows",
            "rows is outside",
            Box::new(|_, e| e.rows = 0),
        ),
        (
            "a list with too many rows",
            "rows is outside",
            Box::new(|_, e| e.rows = u128::from(u32::MAX) + 1),
        ),
        (
            "more rows claimed than there are",
            "more than the list holds",
            Box::new(|_, e| e.claimed_rows = e.rows + 1),
        ),
        (
            "more claimed than the pool",
            "more than the list holds",
            Box::new(|_, e| e.claimed_total = e.total + 1),
        ),
        (
            "claims the events do not add up to",
            "the events add up to",
            Box::new(|l, _| l.earlier_claimed.1 += 1),
        ),
        (
            "bound to a Vester the events never bound",
            "events say bound is",
            Box::new(|l, _| l.earlier_bound = false),
        ),
        (
            "tied to a Vester that is not the project's",
            "not to the project's Vester",
            Box::new(move |_, e| e.vester = other.into()),
        ),
    ];
    for (what, words, broken) in cases {
        let (mut ledger, mut read) = (ledger.clone(), read.clone());
        let mut e = read
            .earlier
            .clone()
            .expect("a claim contract")
            .expect("read");
        broken(&mut ledger, &mut e);
        read.earlier = Some(Ok(e));
        let (rec, why) = record_step4::earlier(&ledger, &read);
        assert!(rec.is_none(), "{what}: the key should be null");
        let why = why.unwrap_or_default();
        assert!(
            why.contains(words),
            "{what}: left null for another reason: {why}"
        );
    }
}

/// A `Parked`, `Unparked` or `Observed` event of the pause that does not agree with what the events before it add up to
/// is an error, never a skip: the ledger refuses the whole read. (Guards: the sum check of `apply_park` and the
/// `Observed` check in the ledger.)
#[test]
fn a_pause_event_that_disagrees_with_the_events_before_it_is_refused() {
    let fx = Fixture::load_pause();
    let rows = fx.rows("Z", fx.book_block("Z_end"));
    assert!(Ledger::from_logs(&rows).is_ok(), "the real rows read");
    for (event, field, words) in [
        ("Parked", "parkedBy", "events add up to"),
        ("Parked", "parkedTotal", "events add up to"),
        ("Unparked", "parkedBy", "events add up to"),
        ("Unparked", "parkedTotal", "events add up to"),
        ("Observed", "parkedTotal", "the pause says"),
    ] {
        let mut broken = rows.clone();
        let row = broken
            .iter_mut()
            .find(|r| r.role == Role::Pause && r.event == event)
            .unwrap_or_else(|| panic!("the run holds a {event}"));
        let was = amount(&row.fields[field]);
        row.fields[field] = json!((was + 1).to_string());
        let err = Ledger::from_logs(&broken).expect_err(&format!("{event}.{field} is held"));
        assert!(
            format!("{err:#}").contains(words),
            "{event}.{field}: refused for another reason: {err:#}"
        );
    }
}

// ------------------------------------------------------------------------------------------ the second example

/// The second example is the server's own output for project `Z` at the block where the pause is on, byte for byte
/// (`UPDATE_EXAMPLE=1` rewrites it), and it parses with the server's types and passes its checks.
#[tokio::test]
async fn the_second_example_is_what_the_server_writes() {
    let built = build("Z_paused").await;
    let text = format!(
        "{}\n",
        serde_json::to_string_pretty(&built.record).expect("the record is written")
    );
    if std::env::var_os("UPDATE_EXAMPLE").is_some() {
        std::fs::write(EXAMPLE_PAUSE_PATH, &text).expect("the example is written");
    }
    let on_disk = std::fs::read_to_string(EXAMPLE_PAUSE_PATH).expect("the example is read");
    assert!(
        on_disk == text,
        "docs/next-version/record-v2-example-pause.json is not what the server writes at the pause block; \
         run the tests with UPDATE_EXAMPLE=1 to rewrite it"
    );
    let value: Value = serde_json::from_str(EXAMPLE_PAUSE).expect("the example is JSON");
    let record: Record = serde_json::from_value(value.clone()).expect("the example parses");
    assert_eq!(serde_json::to_value(&record).expect("written"), value);
    assert_eq!(record::validate(&record), Vec::<String>::new());
    assert_eq!(value["pause"]["paused"], true);
    assert_eq!(value["earlierGrants"]["claimedRows"], 1);
}

// ------------------------------------------------------------------------------------------ helpers

fn hex_to_20(text: &str) -> [u8; 20] {
    super::word::parse_fixed::<20>(text).expect("an address")
}

/// The `(contract, calldata)` of the pause's `state()` call in the book.
fn state_call(chain: &BookChain, pause: [u8; 20]) -> ([u8; 20], Vec<u8>) {
    let selector = buzz_evm_allowance::abi::selector("state()").to_vec();
    chain
        .answers
        .keys()
        .find(|(to, data)| *to == pause && *data == selector)
        .cloned()
        .expect("the book holds the pause's state()")
}
