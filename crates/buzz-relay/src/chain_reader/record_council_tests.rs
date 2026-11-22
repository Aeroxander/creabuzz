//! The Council runner's record keys (`record_council.rs`) against the third real run (`testdata/pot-run-council.json`,
//! played by `scripts/chain-reader-fixture.py --council`): the runner kind and seats, the Council block, the vote rule
//! from the contract's own constants, the phases, the derived result, no voter row, and each guard failing on its own.

use std::collections::BTreeSet;

use serde_json::{json, Value};

use super::fixture::{BookChain, Fixture};
use super::ledger::Ledger;
use super::numbers::{self, AsOf, Cadence};
use super::record::{self, Record};
use super::record_social::{SocialInput, SocialReport};
use super::record_tests::Built;
use super::views::{self, Views};
use super::word::{hex0x, word_to_u128};

const EXAMPLE_COUNCIL: &str =
    include_str!("../../../../docs/next-version/record-v2-example-council.json");
/// Where the third example lives, for the test that writes it (`UPDATE_EXAMPLE=1`).
const EXAMPLE_COUNCIL_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../docs/next-version/record-v2-example-council.json"
);

fn load(name: &str) -> (Fixture, Ledger, AsOf, BookChain) {
    let fx = Fixture::load_council();
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

async fn build_with(
    fx: &Fixture,
    ledger: &Ledger,
    as_of: &AsOf,
    chain: &BookChain,
) -> anyhow::Result<(Built, SocialReport)> {
    let read = views::read(chain, fx.launcher, ledger, as_of.block, as_of.time).await?;
    let rows = fx.rows("C", as_of.block);
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
    build_with(&fx, &ledger, &as_of, &chain)
        .await
        .expect("the record builds")
        .0
}

async fn read_of(name: &str) -> (Fixture, Ledger, AsOf, BookChain, Views) {
    let (fx, ledger, as_of, chain) = load(name);
    let read = views::read(&chain, fx.launcher, &ledger, as_of.block, as_of.time)
        .await
        .expect("the views read");
    (fx, ledger, as_of, chain, read)
}

fn answer_uint(chain: &BookChain, to: [u8; 20], signature: &str) -> u128 {
    let data = buzz_evm_allowance::abi::selector(signature).to_vec();
    let bytes = chain
        .answers
        .get(&(to, data))
        .unwrap_or_else(|| panic!("the book holds no answer for {signature}"));
    word_to_u128(&bytes[..32]).expect("a number")
}

fn answer_uint_any(chain: &BookChain, signature: &str) -> u128 {
    let data = buzz_evm_allowance::abi::selector(signature).to_vec();
    let (_, bytes) = chain
        .answers
        .iter()
        .find(|((_, d), _)| d.starts_with(&data))
        .unwrap_or_else(|| panic!("the book holds no answer for {signature}"));
    word_to_u128(&bytes[..32]).expect("a number")
}

// ------------------------------------------------------------------------------------------ the fixture

/// The third run is the deployment with the Council on: a Council runner, a replace vote carried out, and a seat
/// election whose result waits with nobody having pressed `finish`.
#[tokio::test]
async fn the_third_run_builds_a_council_runner_and_a_waiting_ballot() {
    let built = build("C_waiting").await;
    let r = &built.record;
    assert_eq!(r.runner.kind.as_deref(), Some("council"));
    assert_eq!(r.runner.seats, Some(5));
    assert!(!r.runner.is_pair);
    let council = r
        .council
        .as_ref()
        .expect("a Council runner has a Council block");
    assert_eq!(council.seats.len(), 5);
    assert_eq!(council.needed, 3);
    assert_eq!(council.generation, 0);
    assert_eq!(
        council.seats.iter().filter(|s| s.account.is_some()).count(),
        5
    );
    assert_eq!(council.waiting.count, 0);
    assert!(council.waiting.kinds.is_empty());
    let vote = r
        .vote
        .as_ref()
        .expect("a HolderVote project has a vote block");
    assert_eq!(
        vote.contract,
        r.contracts.pause.clone().expect("contracts.pause")
    );
    let open = vote.open.as_ref().expect("a ballot is open");
    assert_eq!(open.kind, "seats");
    assert_eq!(
        open.phase, "waiting",
        "the example is after voteEnd, in the wait"
    );
    assert_eq!(
        open.result.as_ref().map(|x| x.outcome.as_str()),
        Some("seated")
    );
    assert_eq!(
        open.result.as_ref().map(|x| x.winners.clone()),
        Some(vec![1, 2])
    );
    assert_eq!(
        open.result.as_ref().map(|x| x.recorded),
        Some(false),
        "nobody pressed finish: the reader derived it"
    );
    assert!(open.carried_out_at.is_none());
    // The winner unparked the day after the vote ended: the cast is above what is parked now, and the vote is signed.
    let paused = r.pause.as_ref().expect("the pause block");
    assert!(
        open.cast.parse::<u128>().expect("cast")
            > paused.parked_total.parse::<u128>().expect("parked"),
        "the example is the unpark-after-the-end block"
    );
    // The tallesties add up and the rule is the contract's.
    let sum: u128 = open
        .options
        .iter()
        .map(|o| o.tally.parse::<u128>().expect("a tally"))
        .sum();
    assert_eq!(sum, open.cast.parse::<u128>().expect("cast"));
    assert_eq!(vote.rule.seats, 5);
    assert_eq!(vote.rule.needed, 3);
    assert_eq!(vote.next.seats_at, Some(council.next_election));
    // Established counts the five seats.
    assert_eq!(
        r.established.as_ref().map(|e| e.two_signers),
        Some(true),
        "a Council of five is run by more than one account"
    );
}

/// The phases, from the four times: standing, voting, waiting (after `voteEnd`, with no `BallotFinished`), and no open
/// ballot once the ballot has been carried out.
#[tokio::test]
async fn every_phase_of_the_run_is_what_the_times_say() {
    let standing = build("C_replace_open").await;
    let open = standing
        .record
        .vote
        .as_ref()
        .and_then(|v| v.open.as_ref())
        .expect("an open ballot");
    assert_eq!(open.kind, "replace");
    assert_eq!(open.phase, "standing");
    assert!(open.result.is_none(), "no result before voteEnd");

    let voting = build("C_replace_vote").await;
    let open = voting
        .record
        .vote
        .as_ref()
        .and_then(|v| v.open.as_ref())
        .expect("an open ballot");
    assert_eq!(open.phase, "voting");
    assert!(open.result.is_none());
    // The moved votes and the Fell are in the tallies (absolute, no voter).
    let sum: u128 = open
        .options
        .iter()
        .map(|o| o.tally.parse::<u128>().expect("a tally"))
        .sum();
    assert_eq!(sum, open.cast.parse::<u128>().expect("cast"));

    let carried = build("C_replace_carried").await;
    assert_eq!(carried.record.runner.kind.as_deref(), Some("council"));
    assert!(
        carried
            .record
            .vote
            .as_ref()
            .and_then(|v| v.open.as_ref())
            .is_none(),
        "the carried-out ballot is not open"
    );

    let seat_open = build("C_seat_open").await;
    let open = seat_open
        .record
        .vote
        .as_ref()
        .and_then(|v| v.open.as_ref())
        .expect("an open ballot");
    assert_eq!(open.kind, "seats");
    assert_eq!(open.phase, "standing");

    let seat_vote = build("C_seat_vote").await;
    let open = seat_vote
        .record
        .vote
        .as_ref()
        .and_then(|v| v.open.as_ref())
        .expect("an open ballot");
    assert_eq!(open.phase, "voting");

    let waiting = build("C_waiting").await;
    assert_eq!(
        waiting
            .record
            .vote
            .as_ref()
            .and_then(|v| v.open.as_ref())
            .map(|o| o.phase.as_str()),
        Some("waiting")
    );
    let end = build("C_end").await;
    assert_eq!(
        end.record
            .vote
            .as_ref()
            .and_then(|v| v.open.as_ref())
            .map(|o| o.phase.as_str()),
        Some("waiting"),
        "the example's last block is still inside the wait"
    );
}

/// The record's `vote.rule` is the built contract's constants, every one of them (COUNCIL-PLAN.md section 5.2): the
/// answers the fixture captured by asking the real chain are the contract's.
#[tokio::test]
async fn the_vote_rule_is_the_built_contracts_constants() {
    let (fx, ledger, as_of, chain, read) = read_of("C_waiting").await;
    let built = build_with(&fx, &ledger, &as_of, &chain)
        .await
        .expect("builds")
        .0;
    let rule = &built.record.vote.as_ref().expect("a vote").rule;
    let pause = ledger.contracts.pause.as_ref().expect("a pause");
    let pause_addr = super::word::parse_fixed::<20>(pause).expect("an address");
    let unit = built.record.unit;
    let day = answer_uint(&chain, pause_addr, "day()");
    assert_eq!(
        u128::from(rule.stand_secs),
        answer_uint(&chain, pause_addr, "STAND_DAYS()") * day
    );
    assert_eq!(
        u128::from(rule.vote_secs),
        answer_uint(&chain, pause_addr, "VOTE_DAYS()") * day
    );
    assert_eq!(
        u128::from(rule.wait_secs),
        answer_uint_any(&chain, "noticeFor(uint16)")
    );
    assert_eq!(
        u128::from(rule.floor_divisor),
        answer_uint(&chain, pause_addr, "LINE_DIVISOR()")
    );
    assert_eq!(
        u128::from(rule.open_divisor),
        answer_uint(&chain, pause_addr, "OPEN_DIVISOR()")
    );
    assert_eq!(
        u128::from(rule.stand_divisor),
        answer_uint(&chain, pause_addr, "STAND_DIVISOR()")
    );
    assert_eq!(
        u128::from(rule.cooldown_secs),
        answer_uint(&chain, pause_addr, "COOLDOWN_UNITS()") * u128::from(unit)
    );
    assert_eq!(
        u128::from(rule.seats_every_secs),
        answer_uint_any(&chain, "ELECTION_UNITS()") * u128::from(unit)
    );
    assert_eq!(
        u128::from(rule.proposal_ttl_secs),
        answer_uint_any(&chain, "PROPOSAL_UNITS()") * u128::from(unit)
    );
    assert_eq!(
        u128::from(rule.needed),
        answer_uint_any(&chain, "THRESHOLD()")
    );
    assert_eq!(u128::from(rule.seats), answer_uint_any(&chain, "SEATS()"));
    assert_eq!(
        u128::from(rule.max_lists),
        answer_uint(&chain, pause_addr, "MAX_LISTS()")
    );
    assert_eq!(
        u128::from(rule.max_people),
        answer_uint(&chain, pause_addr, "MAX_PEOPLE()")
    );
    assert_eq!(
        rule.min_vote.parse::<u128>().expect("minVote"),
        answer_uint(&chain, pause_addr, "MIN_VOTE()")
    );
    // The same numbers the views read for this build: a record is never a mix of two sources.
    let vote_views = read
        .vote
        .as_ref()
        .expect("a vote read")
        .as_ref()
        .expect("read");
    assert_eq!(rule.stand_secs, views_stand(&vote_views));
    let _ = as_of;
}

fn views_stand(v: &super::views::VoteViews) -> u64 {
    u64::try_from(v.stand_days * u128::from(v.day)).expect("a time")
}

// ------------------------------------------------------------------------------------------ the guards

/// The tally-add-up check: one option's tally one unit off the cast total signs `vote: null` and says why.
#[tokio::test]
async fn a_tally_that_does_not_add_up_to_the_cast_signs_vote_null() {
    let (_, mut ledger, as_of, _, read) = read_of("C_waiting").await;
    let ballot = ledger.vote.ballots.get_mut(&2).expect("ballot 2");
    let option = 0u8;
    *ballot.tallies.entry(option).or_insert(0) += 1;
    let (vote, why) = super::record_council::vote(&ledger, &read, as_of.time);
    assert!(vote.is_none(), "a miscounted tally must not be signed");
    let why = why.unwrap_or_default();
    assert!(why.contains("add up to"), "{why}");
}

/// The `cast <= parkedTotal` limit is only while the vote runs: the same lowering passes at the wait's block, and the
/// unpark-after-the-end example still signs (the guard made unconditional would fail the named example test).
#[tokio::test]
async fn the_cast_limit_on_parked_shares_stops_at_vote_end() {
    for (name, should_pass) in [("C_seat_vote", false), ("C_waiting", true)] {
        let (_, ledger, as_of, _, mut read) = read_of(name).await;
        let vote = read.vote.as_mut().expect("a vote read");
        let vote = vote.as_mut().expect("read");
        vote.parked_total = 1;
        let (built, why) = super::record_council::vote(&ledger, &read, as_of.time);
        assert_eq!(
            built.is_some(),
            should_pass,
            "{name}: the cast-limit guard is time-scoped: {why:?}"
        );
        if !should_pass {
            assert!(why
                .unwrap_or_default()
                .contains("parked while its vote runs"));
        }
    }
}

/// The `effectiveAt` check: a wait that is not the Treasury's `noticeFor(500)` signs `vote: null`.
#[tokio::test]
async fn a_wait_that_is_not_the_treasurys_notice_signs_vote_null() {
    let (_, ledger, as_of, _, mut read) = read_of("C_waiting").await;
    read.vote
        .as_mut()
        .expect("a vote")
        .as_mut()
        .expect("read")
        .wait_secs += 1;
    let (vote, why) = super::record_council::vote(&ledger, &read, as_of.time);
    assert!(vote.is_none());
    assert!(why.unwrap_or_default().contains("waits"));
}

/// The derived-result check: a recorded `BallotFinished` that disagrees with the frozen tallies signs `vote: null`,
/// even though the record would otherwise be sound.
#[tokio::test]
async fn a_recorded_result_that_differs_from_the_frozen_tallies_signs_vote_null() {
    let (_, mut ledger, as_of, _, read) = read_of("C_waiting").await;
    let cast = ledger.vote.ballots[&2].cast;
    ledger.vote.ballots.get_mut(&2).expect("ballot 2").finished =
        Some(super::ledger_council::Finished {
            outcome: 3,
            winner: 1,
            winner_b: 0,
            cast_total: cast,
        });
    let (vote, why) = super::record_council::vote(&ledger, &read, as_of.time);
    assert!(vote.is_none());
    assert!(why.unwrap_or_default().contains("recorded as"));
}

/// The planted-voter filter: the ledger keeps no voter, so a `Voted` row's account and weight cannot reach the record.
/// Changing both leaves the signed keys byte for byte the same, and no voter's address is in the vote block.
#[tokio::test]
async fn a_voters_address_and_amount_reach_no_record() {
    let (fx, ledger, as_of, chain) = load("C_waiting");
    let before = build_with(&fx, &ledger, &as_of, &chain)
        .await
        .expect("builds")
        .0;
    // Plant the payer's address and a made-up weight on every Voted row.
    let mut rows = fx.rows("C", as_of.block);
    let planted = hex0x(&[0xEEu8; 20]);
    for row in rows.iter_mut().filter(|r| r.event == "Voted") {
        row.fields["who"] = json!(planted);
        row.fields["weight"] = json!("4242424242424242");
    }
    let mut planted_ledger = Ledger::from_logs(&rows)
        .expect("the rows read")
        .expect("launched");
    planted_ledger
        .set_balances(
            &std::collections::HashMap::new(),
            &std::collections::HashMap::new(),
        )
        .expect("balances");
    // The vote keys are built from the ledger alone; the balances only feed holders, so compare the vote keys.
    let read = views::read(&chain, fx.launcher, &ledger, as_of.block, as_of.time)
        .await
        .expect("the views read");
    let (one, _) = super::record_council::vote(&ledger, &read, as_of.time);
    let (two, _) = super::record_council::vote(&planted_ledger, &read, as_of.time);
    assert_eq!(
        serde_json::to_value(&one).expect("vote"),
        serde_json::to_value(&two).expect("vote"),
        "a voter's address and amount never reach the vote key"
    );
    let text = serde_json::to_string(&before.value["vote"]).expect("text");
    assert!(!text.contains(&planted), "no planted voter address");
    assert!(!text.contains("4242424242424242"), "no per-voter amount");
    // And no field of the vote block is a list of voters: options are candidates; there is no `who`.
    assert!(!text.contains("\"who\""));
    let mut seen: BTreeSet<String> = BTreeSet::new();
    for option in before.value["vote"]["open"]["options"]
        .as_array()
        .expect("options")
    {
        seen.insert(option["kind"].as_str().expect("kind").to_owned());
    }
    assert!(seen.contains("keep") || seen.contains("person"));
}

// ------------------------------------------------------------------------------------------ the third example

/// The third example is the server's own output for project `C` at the waiting block, byte for byte
/// (`UPDATE_EXAMPLE=1` rewrites it), and it parses with the server's types and passes its checks.
#[tokio::test]
async fn the_third_example_is_what_the_server_writes() {
    let built = build("C_waiting").await;
    let text = format!(
        "{}\n",
        serde_json::to_string_pretty(&built.record).expect("the record is written")
    );
    if std::env::var_os("UPDATE_EXAMPLE").is_some() {
        std::fs::write(EXAMPLE_COUNCIL_PATH, &text).expect("the example is written");
    }
    let on_disk = std::fs::read_to_string(EXAMPLE_COUNCIL_PATH).expect("the example is read");
    assert!(
        on_disk == text,
        "docs/next-version/record-v2-example-council.json is not what the server writes at the waiting block; \
         run the tests with UPDATE_EXAMPLE=1 to rewrite it"
    );
    let value: Value = serde_json::from_str(EXAMPLE_COUNCIL).expect("the example is JSON");
    let record: Record = serde_json::from_value(value.clone()).expect("the example parses");
    assert_eq!(serde_json::to_value(&record).expect("written"), value);
    assert_eq!(record::validate(&record), Vec::<String>::new());
    assert_eq!(value["runner"]["kind"], "council");
    assert_eq!(value["vote"]["open"]["phase"], "waiting");
    assert_eq!(value["vote"]["open"]["result"]["recorded"], false);
}
