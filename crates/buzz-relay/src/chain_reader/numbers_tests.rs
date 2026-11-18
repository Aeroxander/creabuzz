//! The derived numbers against the worked examples of the milestone 4 report
//! (`contracts/next/test/RoundsWorked.t.sol`).

use super::*;
use serde_json::json;

const DAY: u64 = 86_400;
const T0: u64 = 1_700_000_000;
const DOLLAR: u128 = 1_000_000;
const PRICE: u128 = 3_000_000_000_000_000; // 3e15, the lowest price
const ALICE: &str = "0x00000000000000000000000000000000000000a1";
const BOB: &str = "0x00000000000000000000000000000000000000b0";
const FOUNDER: &str = "0x00000000000000000000000000000000000000f0";
const ROUNDS: &str = "0x0000000000000000000000000000000000000005";
const KEY: Word = [0xab; 32];
const AUCTION: &str = "0x00000000000000000000000000000000000000ac";

struct Chain {
    logs: Vec<LogRow>,
    block: u64,
    runners: Runners,
}

impl Chain {
    fn new() -> Self {
        let mut c = Self {
            logs: Vec::new(),
            block: 100,
            runners: Runners::default(),
        };
        c.push(T0, Role::Launcher, "ProjectLaunched", json!({
            "key": hex0x(&KEY), "projectId": hex0x(&[1u8; 32]), "founder": FOUNDER,
            "project": {"founder": FOUNDER, "shares": "0x0000000000000000000000000000000000000001",
                "treasury": "0x0000000000000000000000000000000000000002",
                "vester": "0x0000000000000000000000000000000000000003",
                "finisher": "0x0000000000000000000000000000000000000004", "rounds": ROUNDS,
                "launchedAt": T0.to_string()},
            "allocation": {}, "settings": {"stake": "0x00000000000000000000000000000000000000c0"},
        }));
        c
    }

    fn push(&mut self, time: u64, role: Role, event: &str, fields: Value) {
        self.block += 1;
        self.logs.push(LogRow {
            block: self.block,
            log_index: 0,
            time,
            role,
            address: [0u8; 20],
            event: event.to_owned(),
            fields,
        });
    }

    fn check_in(&mut self, t: u64) {
        self.push(t, Role::Treasury, "CheckedIn", json!({"by": FOUNDER}));
    }

    /// Open round `id` of `size` at `t`, at `price`.
    fn open(&mut self, t: u64, id: u64, size: u128, raised_before: u128, price: u128) {
        self.push(t, Role::Rounds, "RoundOpened", json!({"round": id.to_string(), "size": size.to_string(),
            "sharesPerRawDollar": price.to_string(), "opensAt": t.to_string(), "closesAt": (t + DAY).to_string()}));
        self.push(
            t,
            Role::Launcher,
            "RoundOpened",
            json!({"key": hex0x(&KEY), "rounds": ROUNDS,
            "round": id.to_string(), "size": size.to_string(), "cap": (10_000 * DOLLAR).to_string(),
            "raisedBefore": raised_before.to_string(), "sharesPerRawDollar": price.to_string()}),
        );
    }

    fn ask(&mut self, t: u64, id: u64, who: &str, total: u128) {
        self.push(
            t,
            Role::Rounds,
            "Asked",
            json!({"round": id.to_string(), "backer": who,
            "total": total.to_string(), "added": total.to_string()}),
        );
    }

    fn close(&mut self, t: u64, id: u64, asked: u128, accepted: u128, active: u64) {
        self.push(
            t,
            Role::Rounds,
            "RoundClosed",
            json!({"round": id.to_string(), "asked": asked.to_string(),
            "accepted": accepted.to_string(), "activeAtClose": active.to_string()}),
        );
    }

    /// Settle `who` for `acc` accepted at `price`, as `Rounds._settle` splits it.
    fn settle(&mut self, t: u64, id: u64, who: &str, ask: u128, acc: u128, price: u128) {
        let held = acc * 8200 / 10_000;
        let platform = acc * 300 / 10_000;
        self.push(t, Role::Rounds, "Settled", json!({"round": id.to_string(), "backer": who,
            "accepted": acc.to_string(), "returned": (ask - acc).to_string(), "shares": (acc * price).to_string(),
            "toPlatform": platform.to_string(), "toProject": (acc - platform - held).to_string(),
            "held": held.to_string()}));
        self.push(
            t,
            Role::Vester,
            "HeldGranted",
            json!({"round": id.to_string(), "backer": who,
            "amount": (acc * price).to_string()}),
        );
        self.push(t, Role::Shares, "Transfer", json!({"from": ROUNDS,
            "to": "0x0000000000000000000000000000000000000003", "value": (acc * price).to_string()}));
    }

    fn numbers(&self, time: u64) -> Value {
        let as_of = AsOf {
            chain_id: 31337,
            launcher: [0x11; 20],
            block: self.block,
            time,
            runners: self.runners.clone(),
        };
        derive(&KEY, &self.logs, &as_of)
            .expect("derives")
            .expect("launched")
    }
}

/// alice 2,400 and bob 100 at the lowest price, closed one day after the
/// check-in at launch (`test_worked_2500_SoloToBacked`).
fn worked_2500() -> (Chain, u64) {
    let mut c = Chain::new();
    c.check_in(T0);
    c.open(T0, 1, 10_000 * DOLLAR, 0, PRICE);
    c.ask(T0 + 60, 1, ALICE, 2_400 * DOLLAR);
    c.ask(T0 + 120, 1, BOB, 100 * DOLLAR);
    let close = T0 + DAY;
    c.close(close, 1, 2_500 * DOLLAR, 2_500 * DOLLAR, DAY);
    c.settle(close, 1, ALICE, 2_400 * DOLLAR, 2_400 * DOLLAR, PRICE);
    c.settle(close, 1, BOB, 100 * DOLLAR, 100 * DOLLAR, PRICE);
    (c, close)
}

fn refund_of(n: &Value, who: &str) -> (String, String) {
    let r = n["now"]["refunds"]
        .as_array()
        .expect("refunds")
        .iter()
        .find(|r| r["backer"] == who)
        .expect("a refund line");
    (
        r["refundable"].as_str().unwrap_or_default().to_owned(),
        r["per100"].as_str().unwrap_or_default().to_owned(),
    )
}

#[test]
fn worked_2500_day_0_and_day_45_with_check_ins_every_10_days() {
    let (mut c, close) = worked_2500();
    let day0 = c.numbers(close);
    assert_eq!(refund_of(&day0, BOB), ("77900000".into(), "77.90".into()));
    assert_eq!(day0["raised"]["total"], "2500000000");
    assert_eq!(day0["raised"]["cap"], "10000000000");
    assert_eq!(day0["raised"]["left"], "7500000000");
    assert_eq!(day0["stage"]["name"], "backed");
    assert_eq!(day0["stage"]["since"], close);
    assert_eq!(day0["eligible"], json!({"for": "team", "since": close}));
    assert_eq!(day0["rounds"][0]["projectPrice"], "333333.33");
    assert_eq!(day0["averagePrice"]["projectPrice"], "333333.33");
    assert_eq!(
        day0["averagePrice"]["sharesPerRawDollar"],
        PRICE.to_string()
    );
    assert_eq!(day0["rounds"][0]["backers"], 2);
    assert_eq!(day0["now"]["activeSeconds"], DAY);
    // 7.5M Shares are held for the two backers, none free.
    let holders = day0["holders"].as_array().expect("holders");
    assert_eq!(holders[0]["account"], ALICE);
    assert_eq!(holders[0]["held"], (2_400 * DOLLAR * PRICE).to_string());
    assert_eq!(holders[0]["free"], "0");
    assert_eq!(day0["holderCount"], 2);

    for day in [10, 20, 30, 40] {
        c.check_in(close + day * DAY);
    }
    let day45 = c.numbers(close + 45 * DAY);
    assert_eq!(refund_of(&day45, BOB), ("58639010".into(), "58.64".into()));
    assert_eq!(day45["now"]["activeSeconds"], DAY + 45 * DAY);
    assert_eq!(day45["now"]["quietSince"], Value::Null);
    assert_eq!(day45["clock"]["runsUntil"], close + 54 * DAY);
}

#[test]
fn without_check_ins_the_clock_stops_and_the_page_says_quiet_since() {
    let (c, close) = worked_2500();
    // The window ends 14 days after the check-in at launch: 13 days after the close.
    let later = c.numbers(close + 45 * DAY);
    let quiet = T0 + 14 * DAY;
    assert_eq!(later["now"]["quietSince"], quiet);
    assert_eq!(later["now"]["activeSeconds"], 14 * DAY);
    // The refund is the day-13 number, not the day-45 one.
    let elapsed = 13 * DAY as u128;
    let part = 82 * DOLLAR;
    let released = (part * elapsed).div_ceil(RELEASE);
    let unreleased = part - released;
    let paid = unreleased - (unreleased * 500).div_ceil(10_000);
    assert_eq!(refund_of(&later, BOB).0, paid.to_string());
    // The time-dependent part moved; the event-derived part did not.
    let earlier = c.numbers(close + 2 * DAY);
    assert_eq!(facts_of(&later), facts_of(&earlier));
    assert_ne!(without_as_of(&later), without_as_of(&earlier));
}

#[test]
fn a_pause_freezes_the_clock_and_a_wind_down_drops_the_fee_to_one_percent() {
    let (mut c, close) = worked_2500();
    c.push(
        close + 5 * DAY,
        Role::Treasury,
        "Paused",
        json!({"on": true}),
    );
    let paused = c.numbers(close + 9 * DAY);
    assert_eq!(paused["now"]["activeSeconds"], DAY + 5 * DAY);
    assert_eq!(paused["now"]["quietSince"], close + 5 * DAY);
    assert_eq!(paused["clock"]["runsUntil"], Value::Null);
    c.push(
        close + 9 * DAY,
        Role::Treasury,
        "Paused",
        json!({"on": false}),
    );
    let resumed = c.numbers(close + 10 * DAY);
    // Paused time is never paid back; the window still ends 14 days after the check-in.
    assert_eq!(resumed["now"]["activeSeconds"], DAY + 5 * DAY + DAY);

    c.push(
        close + 10 * DAY,
        Role::Treasury,
        "WoundDown",
        json!({"time": "0"}),
    );
    c.push(
        close + 10 * DAY,
        Role::Rounds,
        "WoundDown",
        json!({"time": "0"}),
    );
    let wound = c.numbers(close + 40 * DAY);
    let elapsed = 6 * DAY as u128;
    let unreleased = 82 * DOLLAR - (82 * DOLLAR * elapsed).div_ceil(RELEASE);
    let paid = unreleased - (unreleased * 100).div_ceil(10_000);
    assert_eq!(refund_of(&wound, BOB).0, paid.to_string());
    assert_eq!(wound["eligible"], Value::Null);
    assert_eq!(wound["noMarketFrom"], Value::Null);
    assert_eq!(wound["now"]["quietSince"], close + 10 * DAY);
}

#[test]
fn total_raised_is_the_sum_of_round_closed_accepted_not_of_settled() {
    // Three backers ask 3 + 3 + 3 dollars of a 7-dollar round: each gets
    // 3 * 7 / 9 = 2.333333 dollars rounded down, so the parts settle one raw
    // unit short of the accepted 7 dollars.
    let mut c = Chain::new();
    c.check_in(T0);
    c.open(T0, 1, 7 * DOLLAR, 0, PRICE);
    let backers = [ALICE, BOB, "0x00000000000000000000000000000000000000c3"];
    for b in backers {
        c.ask(T0 + 1, 1, b, 3 * DOLLAR);
    }
    c.close(T0 + DAY, 1, 9 * DOLLAR, 7 * DOLLAR, DAY);
    let part = 3 * DOLLAR * 7 / 9;
    for b in backers {
        c.settle(T0 + DAY, 1, b, 3 * DOLLAR, part, PRICE);
    }
    assert_eq!(3 * part, 7 * DOLLAR - 1);
    let n = c.numbers(T0 + DAY);
    assert_eq!(n["raised"]["total"], (7 * DOLLAR).to_string());
    assert_eq!(n["rounds"][0]["acceptedPercent"], "77.78");
    assert_eq!(n["rounds"][0]["settled"], 3);
}

#[test]
fn average_price_is_weighted_by_money_and_rounds_keep_their_own_price() {
    // 1,000 at 6,000,000 for the whole project, then 3,000 at 333,333.33.
    let six_m: u128 = 166_666_666_666_666;
    let mut c = Chain::new();
    c.check_in(T0);
    c.open(T0, 1, 10_000 * DOLLAR, 0, six_m);
    c.ask(T0, 1, ALICE, 1_000 * DOLLAR);
    c.close(T0 + DAY, 1, 1_000 * DOLLAR, 1_000 * DOLLAR, DAY);
    c.open(T0 + DAY, 2, 9_000 * DOLLAR, 1_000 * DOLLAR, PRICE);
    c.ask(T0 + DAY, 2, BOB, 3_000 * DOLLAR);
    c.close(T0 + 2 * DAY, 2, 3_000 * DOLLAR, 3_000 * DOLLAR, 2 * DAY);
    let n = c.numbers(T0 + 2 * DAY);
    assert_eq!(n["rounds"][0]["projectPrice"], "6000000.00");
    assert_eq!(n["rounds"][1]["projectPrice"], "333333.33");
    assert_eq!(n["raised"]["total"], (4_000 * DOLLAR).to_string());
    // 4,000 dollars bought 1,000 x 166,666,666,666,666 + 3,000 x 3e15 raw Shares.
    let sold = 1_000 * DOLLAR * six_m + 3_000 * DOLLAR * PRICE;
    let cents = 4_000 * DOLLAR * 100_000_000_000_000_000_000_000 / sold;
    assert_eq!(n["averagePrice"]["projectPrice"], hundredths(cents));
    assert_eq!(n["averagePrice"]["projectPrice"], "436363.63");
}

#[test]
fn stages_follow_the_launcher_rules() {
    let (mut c, close) = worked_2500();
    let pair = "0x00000000000000000000000000000000000000aa";
    c.push(
        close + DAY,
        Role::Launcher,
        "PairMade",
        json!({"key": hex0x(&KEY), "pair": pair,
        "first": FOUNDER, "second": ALICE}),
    );
    let team = c.numbers(close + DAY);
    assert_eq!(team["stage"]["name"], "team");
    assert_eq!(team["raised"]["cap"], "50000000000");
    assert_eq!(team["contracts"]["pair"], pair);
    assert_eq!(
        team["eligible"],
        json!({"for": "council", "since": close + DAY})
    );
    // The sale's settle opens the pool (Treasury.PoolOpened) and starts the
    // Vester's clock; Council waits for the sweep, which sets the Finisher's
    // stage to Done (review O1).
    c.push(
        close + 2 * DAY,
        Role::Finisher,
        "SaleOpenedBy",
        json!({"auction": AUCTION, "endBlock": "1", "attempt": "0"}),
    );
    let running = c.numbers(close + 2 * DAY);
    assert_eq!(
        running["noMarketFrom"],
        Value::Null,
        "not while a sale runs (O2)"
    );
    c.push(
        close + 3 * DAY,
        Role::Treasury,
        "PoolOpened",
        json!({"time": "0"}),
    );
    c.push(
        close + 3 * DAY,
        Role::Vester,
        "Started",
        json!({"time": "0"}),
    );
    assert_eq!(
        c.numbers(close + 3 * DAY)["stage"]["name"],
        "team",
        "Council waits for the sweep"
    );
    c.push(
        close + 3 * DAY,
        Role::Finisher,
        "Swept",
        json!({"auction": AUCTION, "sharesToTreasury": "0"}),
    );
    let council = c.numbers(close + 4 * DAY);
    assert_eq!(council["stage"]["name"], "council");
    assert_eq!(council["stage"]["openAt"], close + 3 * DAY + YEAR);
    assert_eq!(council["now"]["stage"], "council");
    assert_eq!(c.numbers(close + 3 * DAY + YEAR)["now"]["stage"], "open");
    assert_eq!(council["noMarketFrom"], Value::Null);
}

/// Review B1 / F4: the cap and the Team stage follow the current runner
/// (`Launcher.capOf(runner)`, `stageOf`), not "a Pair was ever made".
#[test]
fn a_pair_that_hands_the_seat_to_one_person_ends_team_and_the_bigger_cap() {
    let (mut c, close) = worked_2500();
    let pair = "0x00000000000000000000000000000000000000aa";
    let carol = "0x00000000000000000000000000000000000000cc";
    // makePair: the Pair takes the seat (RunnerChanged), then PairMade.
    c.push(
        close + DAY,
        Role::Treasury,
        "RunnerChanged",
        json!({"from": FOUNDER, "to": pair, "cut": "0"}),
    );
    c.push(
        close + DAY,
        Role::Launcher,
        "PairMade",
        json!({"key": hex0x(&KEY), "pair": pair, "first": FOUNDER, "second": ALICE}),
    );
    let team = c.numbers(close + DAY);
    assert_eq!(team["stage"]["name"], "team");
    assert_eq!(team["stage"]["since"], close + DAY);
    assert_eq!(team["raised"]["cap"], "50000000000");
    // The co-founder leaves: both signers hand the seat to Carol alone.
    c.push(
        close + 2 * DAY,
        Role::Treasury,
        "RunnerChanged",
        json!({"from": pair, "to": carol, "cut": "0"}),
    );
    let single = c.numbers(close + 2 * DAY);
    assert_eq!(single["treasury"]["runner"], carol);
    assert_eq!(single["stage"]["name"], "backed");
    assert_eq!(single["stage"]["since"], close);
    assert_eq!(single["raised"]["cap"], "10000000000");
    assert_eq!(single["raised"]["left"], "7500000000");
    assert_eq!(single["eligible"], json!({"for": "team", "since": close}));
    // The project's first Pair is still named.
    assert_eq!(single["contracts"]["pair"], pair);
}

/// `Launcher.isPair` is one list for the whole Launcher: a Pair made for
/// another project that takes this project's seat makes it Team as well.
#[test]
fn a_pair_made_for_another_project_counts_as_a_pair_runner() {
    let (mut c, close) = worked_2500();
    let other_pair = "0x00000000000000000000000000000000000000ee";
    c.push(
        close + DAY,
        Role::Treasury,
        "RunnerChanged",
        json!({"from": FOUNDER, "to": other_pair, "cut": "0"}),
    );
    assert_eq!(c.numbers(close + DAY)["stage"]["name"], "backed");
    c.runners.pairs.insert(other_pair.to_owned());
    let n = c.numbers(close + DAY);
    assert_eq!(n["stage"]["name"], "team");
    assert_eq!(n["raised"]["cap"], "50000000000");
    assert_eq!(n["contracts"]["pair"], Value::Null);
    // A registered Council runner counts too.
    c.runners.pairs.clear();
    c.runners.councils.insert(other_pair.to_owned());
    assert_eq!(c.numbers(close + DAY)["raised"]["cap"], "50000000000");
}

#[test]
fn a_refund_ends_the_position_and_cancelled_shares_leave_the_holder() {
    let (mut c, close) = worked_2500();
    c.push(
        close + DAY,
        Role::Rounds,
        "Refunded",
        json!({"round": "1", "backer": BOB,
        "unreleased": "0", "paid": "77000000", "toProject": "0", "toPlatform": "0", "shares": "0"}),
    );
    c.push(
        close + DAY,
        Role::Vester,
        "HeldCancelled",
        json!({"round": "1", "backer": BOB,
        "amount": (100 * DOLLAR * PRICE).to_string()}),
    );
    let n = c.numbers(close + 2 * DAY);
    assert_eq!(refund_of(&n, BOB), ("0".into(), "0.00".into()));
    assert_eq!(n["holderCount"], 1);
    assert_eq!(n["treasury"]["refundsPaid"], "77000000");
    // Total raised does not fall when money is taken back (refunds do not reopen the cap).
    assert_eq!(n["raised"]["total"], "2500000000");
}

#[test]
fn no_launch_no_numbers() {
    let as_of = AsOf {
        chain_id: 1,
        launcher: [0; 20],
        block: 1,
        time: 1,
        runners: Runners::default(),
    };
    assert!(derive(&KEY, &[], &as_of).expect("derives").is_none());
}

#[test]
fn prices_for_the_whole_project() {
    assert_eq!(
        project_price(3_000_000_000_000_000).as_deref(),
        Some("333333.33")
    );
    assert_eq!(
        project_price(20_000_000_000_000).as_deref(),
        Some("50000000.00")
    );
    assert_eq!(project_price(0), None);
}

#[test]
fn after_taking_out_some_held_shares_the_refund_covers_the_rest_and_then_ends() {
    // After the market, bob takes out half of his held Shares himself, so the
    // refund covers the other half (`Rounds.refundable`: part = held x still /
    // total). Once he takes that back, the grant's total drops to what he
    // claimed and nothing is left to take back.
    let (mut c, close) = worked_2500();
    let bob_shares = 100 * DOLLAR * PRICE;
    c.push(close + DAY, Role::Vester, "Started", json!({"time": "0"}));
    c.push(
        close + DAY,
        Role::Vester,
        "HeldClaimed",
        json!({"round": "1", "backer": BOB, "amount": (bob_shares / 2).to_string()}),
    );
    let at = close + 2 * DAY;
    let part = 82 * DOLLAR / 2;
    let unreleased = part - (part * 2 * DAY as u128).div_ceil(RELEASE);
    let paid = unreleased - (unreleased * 500).div_ceil(10_000);
    assert_eq!(refund_of(&c.numbers(at), BOB).0, paid.to_string());

    c.push(
        at,
        Role::Vester,
        "HeldCancelled",
        json!({"round": "1", "backer": BOB, "amount": (bob_shares / 2).to_string()}),
    );
    c.push(
        at,
        Role::Rounds,
        "Refunded",
        json!({"round": "1", "backer": BOB, "unreleased": unreleased.to_string(),
            "paid": paid.to_string(), "toProject": "0", "toPlatform": "0",
            "shares": (bob_shares / 2).to_string()}),
    );
    let n = c.numbers(at + DAY);
    assert_eq!(refund_of(&n, BOB), ("0".into(), "0.00".into()));
    let receipt = n["receipts"]
        .as_array()
        .expect("receipts")
        .iter()
        .find(|r| r["backer"] == BOB)
        .expect("bob's receipt");
    assert_eq!(receipt["sharesHeld"], "0");
    assert_eq!(receipt["refunded"]["paid"], paid.to_string());
}

#[test]
fn an_auction_holding_shares_for_sale_is_not_listed_as_a_holder() {
    let (mut c, close) = worked_2500();
    let auction = "0x00000000000000000000000000000000000000ac";
    c.push(close + DAY, Role::Launcher, "SaleOpened", json!({
        "key": hex0x(&KEY), "auction": auction, "runner": FOUNDER, "finisher": "0x0000000000000000000000000000000000000004",
        "minimum": "100000000000", "startBlock": "10", "endBlock": "20",
        "floorPriceQ96": "1", "tickSpacingQ96": "1"}));
    c.push(
        close + DAY,
        Role::Shares,
        "Transfer",
        json!({
        "from": "0x0000000000000000000000000000000000000002", "to": auction,
        "value": "250000000000000000000000000"}),
    );
    let n = c.numbers(close + DAY);
    assert_eq!(n["holderCount"], 2);
    assert_eq!(n["sale"]["auction"], auction);
}

/// Project zero (contracts commit fb0f84d75): the earlier backers' claim
/// contract holds its Vester grant for the people on its list, so it is not
/// listed as a holder; team pay from the budget is summed.
#[test]
fn project_zero_split_and_team_pay() {
    let (mut c, close) = worked_2500();
    let claim = "0x00000000000000000000000000000000000000c1";
    c.push(
        close,
        Role::Vester,
        "Granted",
        json!({"beneficiary": claim, "amount": "80000000000000000000000000"}),
    );
    c.push(
        close,
        Role::Launcher,
        "ProjectZeroSplit",
        json!({"key": hex0x(&KEY), "claim": claim,
        "fromBacking": "50000000000000000000000000", "fromFounder": "30000000000000000000000000",
        "teamBudget": "120000000000000000000000000"}),
    );
    c.push(
        close + DAY,
        Role::Treasury,
        "TeamPaid",
        json!({"to": ALICE,
        "amount": "1000000000000000000000000", "left": "119000000000000000000000000"}),
    );
    let n = c.numbers(close + DAY);
    assert_eq!(n["earlierBackers"]["claim"], claim);
    assert_eq!(
        n["earlierBackers"]["teamBudget"],
        "120000000000000000000000000"
    );
    assert_eq!(n["treasury"]["teamPaid"], "1000000000000000000000000");
    assert_eq!(
        n["treasury"]["teamBudgetLeft"],
        "119000000000000000000000000"
    );
    let listed: Vec<&Value> = n["holders"]
        .as_array()
        .expect("holders")
        .iter()
        .map(|h| &h["account"])
        .collect();
    assert!(!listed.contains(&&json!(claim)), "{listed:?}");
}

#[test]
fn a_long_list_is_cut_and_says_so() {
    let mut c = Chain::new();
    c.check_in(T0);
    c.open(T0, 1, 10_000 * DOLLAR, 0, PRICE);
    let backers: Vec<String> = (0..MAX_LISTED + 5)
        .map(|i| format!("0x{:040x}", 0x1000 + i))
        .collect();
    for b in &backers {
        c.ask(T0 + 1, 1, b, DOLLAR);
    }
    let total = DOLLAR * backers.len() as u128;
    c.close(T0 + DAY, 1, total, total, DAY);
    for b in &backers {
        c.settle(T0 + DAY, 1, b, DOLLAR, DOLLAR, PRICE);
    }
    let n = c.numbers(T0 + DAY);
    assert_eq!(n["receiptCount"], MAX_LISTED + 5);
    assert_eq!(n["receipts"].as_array().map(Vec::len), Some(MAX_LISTED));
    assert_eq!(
        n["now"]["refunds"].as_array().map(Vec::len),
        Some(MAX_LISTED)
    );
    assert_eq!(n["holders"].as_array().map(Vec::len), Some(MAX_LISTED));
    assert_eq!(n["truncated"], true);
    assert!(n.to_string().len() < 200 * 1024);
}

/// Review O1: an abandoned sale emits `Swept` too, but leaves the Finisher at
/// Abandoned, not Done, so the stage stays with the runner (Team here); a
/// failed sale never sweeps to Done either.
#[test]
fn an_abandoned_sale_is_not_council_and_shows_no_no_market_date() {
    let (mut c, close) = worked_2500();
    c.push(
        close + DAY,
        Role::Treasury,
        "RunnerChanged",
        json!({"from": FOUNDER, "to": "0x00000000000000000000000000000000000000aa", "cut": "0"}),
    );
    c.push(close + DAY, Role::Launcher, "PairMade", json!({"key": hex0x(&KEY), "pair": "0x00000000000000000000000000000000000000aa", "first": FOUNDER, "second": ALICE}));
    c.push(
        close + 2 * DAY,
        Role::Finisher,
        "SaleOpenedBy",
        json!({"auction": AUCTION, "endBlock": "1", "attempt": "0"}),
    );
    // Abandon: the Treasury's pool flag is set without PoolOpened, then the
    // Finisher emits Abandoned and Swept in the same transaction.
    c.push(
        close + 9 * DAY,
        Role::Treasury,
        "SaleAbandoned",
        json!({"time": "0"}),
    );
    c.push(
        close + 9 * DAY,
        Role::Vester,
        "Started",
        json!({"time": "0"}),
    );
    c.push(
        close + 9 * DAY,
        Role::Finisher,
        "Abandoned",
        json!({"auction": AUCTION, "toFloorOnly": "0", "split": "0"}),
    );
    c.push(
        close + 9 * DAY,
        Role::Finisher,
        "Swept",
        json!({"auction": AUCTION, "sharesToTreasury": "0"}),
    );
    let n = c.numbers(close + 10 * DAY);
    assert_eq!(n["stage"]["name"], "team");
    assert_eq!(n["stage"]["openAt"], Value::Null);
    assert_eq!(
        n["noMarketFrom"],
        Value::Null,
        "no market cannot be declared after an abandon (O2)"
    );
    assert_eq!(n["sale"]["abandonedAt"], close + 9 * DAY);
}

/// Review O2: a failed sale ends the running sale; "no market" may be
/// declared again (its date comes back).
#[test]
fn a_failed_sale_brings_the_no_market_date_back() {
    let (mut c, close) = worked_2500();
    let before = c.numbers(close + DAY)["noMarketFrom"].clone();
    assert!(before.is_u64());
    c.push(
        close + 2 * DAY,
        Role::Finisher,
        "SaleOpenedBy",
        json!({"auction": AUCTION, "endBlock": "1", "attempt": "0"}),
    );
    assert_eq!(c.numbers(close + 3 * DAY)["noMarketFrom"], Value::Null);
    c.push(
        close + 4 * DAY,
        Role::Finisher,
        "SaleFailed",
        json!({"auction": AUCTION, "retryBlock": "2"}),
    );
    let after = c.numbers(close + 5 * DAY);
    assert_eq!(after["noMarketFrom"], before);
    assert_eq!(after["stage"]["name"], "backed");
}

/// Project zero's claim contract is followed as counts and totals only: no
/// entry, holder, receiver or single amount reaches the public record, and an
/// account whose Shares came from the claim is not listed as a holder.
#[test]
fn earlier_backers_are_counts_and_totals_only() {
    let (mut c, close) = worked_2500();
    let claim = "0x00000000000000000000000000000000000000c1";
    let holders = [
        "0x00000000000000000000000000000000000000e1",
        "0x00000000000000000000000000000000000000e2",
        "0x00000000000000000000000000000000000000e3",
    ];
    let receiver = "0x00000000000000000000000000000000000000d1";
    c.push(
        close,
        Role::Launcher,
        "ProjectZeroSplit",
        json!({"key": hex0x(&KEY), "claim": claim, "fromBacking": "50", "fromFounder": "30",
        "teamBudget": "120"}),
    );
    c.push(
        close,
        Role::Earlier,
        "Bound",
        json!({"vester": "0x01", "treasury": "0x02"}),
    );
    for (i, h) in holders.iter().enumerate() {
        c.push(
            close + DAY,
            Role::Earlier,
            "Consented",
            json!({"entry": i.to_string(), "holder": h, "receiver": receiver,
            "amount": ((i + 1) * 100).to_string(), "textHash": "0x00"}),
        );
    }
    // Entry 1's consent is voided, with a new holder proposed and applied;
    // entry 2 gets a proposal that is cancelled.
    c.push(
        close + 2 * DAY,
        Role::Earlier,
        "Voided",
        json!({"entry": "1", "holder": holders[1], "evidence": "0x00"}),
    );
    c.push(close + 2 * DAY, Role::Earlier, "HolderProposed", json!({"entry": "1", "next": "0x00000000000000000000000000000000000000e9", "from": "0", "evidence": "0x00"}));
    c.push(close + 2 * DAY, Role::Earlier, "HolderProposed", json!({"entry": "2", "next": "0x00000000000000000000000000000000000000ea", "from": "0", "evidence": "0x00"}));
    c.push(
        close + 3 * DAY,
        Role::Earlier,
        "ReplacementCancelled",
        json!({"entry": "2", "by": holders[2]}),
    );
    c.push(close + 40 * DAY, Role::Earlier, "HolderReplaced", json!({"entry": "1", "next": "0x00000000000000000000000000000000000000e9", "holderVersion": "1"}));
    c.push(
        close + 40 * DAY,
        Role::Earlier,
        "TextPublished",
        json!({"version": "2", "textHash": "0x00", "summaryHash": "0x00"}),
    );
    c.push(
        close + 40 * DAY,
        Role::Earlier,
        "KeeperChanged",
        json!({"keeper": "0x03", "taken": false}),
    );
    c.push(
        close + 40 * DAY,
        Role::Earlier,
        "Delivered",
        json!({"entry": "0", "receiver": receiver, "amount": "7"}),
    );
    c.push(
        close + 40 * DAY,
        Role::Shares,
        "Transfer",
        json!({"from": claim, "to": receiver, "value": "7"}),
    );
    c.push(
        close + 41 * DAY,
        Role::Earlier,
        "ListClosed",
        json!({"open": "200"}),
    );
    c.push(
        close + 41 * DAY,
        Role::Earlier,
        "SentToReserve",
        json!({"amount": "200"}),
    );

    let n = c.numbers(close + 42 * DAY);
    let eb = &n["earlierBackers"];
    assert_eq!(eb["bound"], true);
    assert_eq!(eb["textVersion"], 2);
    assert_eq!(eb["consented"], json!({"count": 2, "total": "400"}));
    assert_eq!(eb["voidedCount"], 1);
    assert_eq!(eb["delivered"], json!({"count": 1, "total": "7"}));
    assert_eq!(
        eb["replacements"],
        json!({"pending": 0, "done": 1, "cancelled": 1})
    );
    assert_eq!(
        eb["listClosed"],
        json!({"at": close + 41 * DAY, "open": "200"})
    );
    assert_eq!(eb["sentToReserve"], "200");
    assert_eq!(eb["keeperChanges"], 1);
    assert_eq!(eb["receivers"], json!({"count": 1, "shares": "7"}));

    // No address but the claim's own, and no per-entry key, anywhere in it.
    let text = eb.to_string();
    for who in holders.iter().chain([&receiver]) {
        assert!(!text.contains(who), "{who} is in the record: {text}");
    }
    for k in ["\"entry\"", "\"holder\"", "\"receiver\"", "\"next\""] {
        assert!(!text.contains(k), "{k} is in the record: {text}");
    }
    let whole = n.to_string();
    assert!(!whole.contains(receiver), "the receiver is listed: {whole}");
}

/// The market side: an auction's bids, exits, claims and clearing price;
/// the pool's trades (the trader's signed amounts: here the Shares are the
/// pool's second token, since the fixture's dollar token sorts first); the
/// pool fees for this project's Treasury only; and the shared LiquidityHolder
/// and pool manager never listed as holders (review F8).
#[test]
fn bids_trades_and_pool_fees_are_added_up() {
    let (mut c, close) = worked_2500();
    let treasury = "0x0000000000000000000000000000000000000002";
    let manager = "0x00000000000000000000000000000000000000ee";
    let holder = "0x00000000000000000000000000000000000000ef";
    c.runners.shared.insert(manager.to_owned());
    c.runners.shared.insert(holder.to_owned());
    let t = close + DAY;
    c.push(
        t,
        Role::Auction,
        "TokensReceived",
        json!({"totalSupply": "250"}),
    );
    c.push(
        t,
        Role::Auction,
        "BidSubmitted",
        json!({"id": "1", "owner": ALICE, "priceQ96": "9", "amount": "300"}),
    );
    c.push(
        t,
        Role::Auction,
        "BidSubmitted",
        json!({"id": "2", "owner": BOB, "priceQ96": "9", "amount": "200"}),
    );
    c.push(
        t,
        Role::Auction,
        "ClearingPriceUpdated",
        json!({"blockNumber": "5", "clearingPriceQ96": "77"}),
    );
    c.push(
        t,
        Role::Auction,
        "BidExited",
        json!({"bidId": "2", "owner": BOB, "tokensFilled": "0", "currencyRefunded": "200"}),
    );
    c.push(
        t,
        Role::Auction,
        "TokensClaimed",
        json!({"bidId": "1", "owner": ALICE, "tokensFilled": "120"}),
    );
    // Shares bought (+90 Shares out, 30 dollars in), then sold (-40 Shares in, 12 dollars out).
    c.push(
        t,
        Role::PoolManager,
        "Swap",
        json!({"id": "0x01", "sender": ALICE, "amount0": "-30", "amount1": "90",
        "sqrtPriceX96": "1000", "liquidity": "5", "tick": "-12", "fee": "3000"}),
    );
    c.push(
        t,
        Role::PoolManager,
        "Swap",
        json!({"id": "0x01", "sender": BOB, "amount0": "12", "amount1": "-40",
        "sqrtPriceX96": "990", "liquidity": "5", "tick": "-13", "fee": "3000"}),
    );
    c.push(
        t,
        Role::Holder,
        "Collected",
        json!({"tokenId": "7", "treasury": treasury, "dollars": "10",
        "toPlatform": "3", "toProject": "7", "sharesBurned": "4"}),
    );
    c.push(
        t,
        Role::Holder,
        "Owed",
        json!({"token": "0x09", "to": treasury, "amount": "5"}),
    );
    c.push(t, Role::Holder, "Owed", json!({"token": "0x09", "to": "0x00000000000000000000000000000000000000aa", "amount": "50"}));
    c.push(
        t,
        Role::Holder,
        "OwedSent",
        json!({"token": "0x09", "to": treasury, "amount": "2"}),
    );
    c.push(
        t,
        Role::Shares,
        "Transfer",
        json!({"from": FOUNDER, "to": manager, "value": "1000"}),
    );
    c.push(
        t,
        Role::Shares,
        "Transfer",
        json!({"from": FOUNDER, "to": holder, "value": "1000"}),
    );

    let n = c.numbers(t);
    let bids = &n["bids"][0];
    assert_eq!(bids["count"], 2);
    assert_eq!(bids["amount"], "500");
    assert_eq!(bids["exited"], 1);
    assert_eq!(bids["refunded"], "200");
    assert_eq!(bids["sharesClaimed"], "120");
    assert_eq!(bids["clearingPriceQ96"], "77");
    assert_eq!(bids["sharesForSale"], "250");
    let pool = &n["pool"];
    assert_eq!(pool["trades"], 2);
    assert_eq!(pool["tradedDollars"], "42");
    assert_eq!(pool["sharesBought"], "90");
    assert_eq!(pool["sharesSold"], "40");
    assert_eq!(pool["tick"], "-13");
    assert_eq!(pool["fees"]["dollars"], "10");
    assert_eq!(pool["fees"]["sharesBurned"], "4");
    assert_eq!(pool["fees"]["owedToProject"], "3");
    let listed = n["holders"].to_string();
    assert!(
        !listed.contains(manager),
        "the pool manager is listed: {listed}"
    );
    assert!(
        !listed.contains(holder),
        "the LiquidityHolder is listed: {listed}"
    );
    assert!(
        !n["bids"].to_string().contains(ALICE),
        "no bidder in the bids"
    );
}
