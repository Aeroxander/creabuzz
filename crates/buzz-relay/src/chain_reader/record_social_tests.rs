//! The social keys of the record (`held`, `feed`, `streaks`, `established`), built from the real run's rows and
//! from rows made for one rule at a time. The H, F, S, E, V and X series of `docs/next-version/STEP3-PLAN.md`
//! section 9.2; the Postgres half of H is in `held_postgres_tests.rs`.

use std::collections::BTreeSet;

use serde_json::{json, Value};

use super::events::Role;
use super::held::{self, Change, Held, Limits, Window, WindowRaw};
use super::ledger::{Ledger, LogRow};
use super::numbers::AsOf;
use super::record::{self, Record};
use super::record_social::{
    self, badge_secs, rank_secs, EstablishedRec, SocialInput, FEED_HOURS, FEED_ITEMS,
};
use super::record_tests::{build_from, example};
use super::word::hex0x;

const UNIT: u64 = 604_800;
const HOUR: u64 = UNIT / 168;
const ZERO: &str = "0x0000000000000000000000000000000000000000";

// ------------------------------------------------------------------------------------------ helpers

/// The balance changes of a project's backer Shares, read from its `Transfer` rows, with the time of each.
pub(super) fn changes_of(rows: &[LogRow]) -> Vec<(u64, Change)> {
    let mut out = Vec::new();
    for row in rows
        .iter()
        .filter(|r| r.role == Role::Shares && r.event == "Transfer")
    {
        let text = |name: &str| row.fields[name].as_str().expect("a field").to_owned();
        let (from, to) = (text("from"), text("to"));
        let value: i128 = text("value").parse().expect("an amount");
        if from == to {
            continue;
        }
        for (account, delta) in [(from, -value), (to, value)] {
            if account != ZERO {
                out.push((
                    row.time,
                    Change {
                        block: row.block,
                        log_index: row.log_index,
                        account,
                        delta,
                    },
                ));
            }
        }
    }
    out
}

/// The rank window and the badge window counted from the rows in memory, as the query counts them in Postgres.
pub(super) fn windows_of(rows: &[LogRow], ledger: &Ledger, as_of: &AsOf) -> (Window, Window) {
    let excluded = ledger.excluded(&BTreeSet::from([hex0x(&as_of.launcher)]));
    let all = changes_of(rows);
    let count = |secs: u64| {
        let start = as_of.time.saturating_sub(secs);
        let inside: Vec<Change> = all
            .iter()
            .filter(|(time, _)| *time > start)
            .map(|(_, c)| c.clone())
            .collect();
        match held::walk(&inside, Limits::default()) {
            WindowRaw::Cut => Window::Cut,
            WindowRaw::Counted(runs) => Window::Counted(
                held::lowest(&runs, ledger.shares_balances(), &excluded).expect("the rows fit"),
            ),
        }
    };
    (
        count(rank_secs(ledger.unit)),
        count(badge_secs(ledger.unit)),
    )
}

fn change(block: u64, account: &str, delta: i128) -> Change {
    Change {
        block,
        log_index: 0,
        account: account.to_owned(),
        delta,
    }
}

fn who(n: u8) -> String {
    format!("0x{n:040x}")
}

/// `lowest` over a made-up set of changes: `now` are the balances now.
fn lowest_of(changes: &[Change], now: &[(String, u128)]) -> Held {
    let WindowRaw::Counted(runs) = held::walk(changes, Limits::default()) else {
        panic!("not cut");
    };
    held::lowest(&runs, now.iter().map(|(a, b)| (a, b)), &BTreeSet::new())
        .expect("the moves fit the balances")
}

fn row(time: u64, role: Role, event: &str, fields: Value) -> LogRow {
    LogRow {
        block: time,
        log_index: 0,
        time,
        tx: [0; 32],
        role,
        address: [0; 20],
        event: event.to_owned(),
        fields,
    }
}

fn joined(time: u64, paid: u64, fee: u64) -> LogRow {
    row(
        time,
        Role::Treasury,
        "Joined",
        json!({ "paid": paid.to_string(), "fee": fee.to_string() }),
    )
}

fn left(time: u64, cash: u64) -> LogRow {
    row(
        time,
        Role::Treasury,
        "Left",
        json!({ "cash": cash.to_string() }),
    )
}

fn checked_in(time: u64) -> LogRow {
    row(
        time,
        Role::Treasury,
        "CheckedIn",
        json!({ "time": time.to_string() }),
    )
}

/// Half an hour into an hour of the feed, so that a row a few seconds before it is in the same hour.
const AS_OF: u64 = 1_800_000_000 + 1_800;

// ------------------------------------------------------------------------------------------ held

/// H1: an account that held 40, dipped to 10 and came back to 40 counts 10: the lowest, not the end.
#[test]
fn h1_a_dip_inside_the_window_counts_not_the_balance_at_the_end() {
    let a = who(1);
    let held = lowest_of(
        &[change(10, &a, -30), change(11, &a, 30)],
        &[(a.clone(), 40)],
    );
    assert_eq!(held.shares, 10);
    // A dip inside one block counts too: the running sum steps through every log of it.
    let b = who(2);
    let held = lowest_of(
        &[
            Change {
                block: 5,
                log_index: 0,
                account: b.clone(),
                delta: -25,
            },
            Change {
                block: 5,
                log_index: 1,
                account: b.clone(),
                delta: 25,
            },
        ],
        &[(b, 40)],
    );
    assert_eq!(
        held.shares, 15,
        "the intermediate state inside one block counts"
    );
}

/// H1: an account that bought its Shares inside the window counts nothing of them; one that sold some counts
/// what it kept; an account with no move held its balance the whole time.
#[test]
fn h1_late_buyers_count_nothing_and_sellers_count_what_they_kept() {
    let (late, seller, steady, sold_out) = (who(1), who(2), who(3), who(4));
    let held = lowest_of(
        &[
            change(1, &late, 40),
            change(2, &seller, -10),
            change(3, &sold_out, -30),
        ],
        &[(late, 40), (seller, 20), (steady, 40), (sold_out, 0)],
    );
    // late: 0; seller: 30 at the start, 20 at the end; steady: 40; the account that emptied itself holds nothing now.
    assert_eq!(held.shares, 20 + 40);
    assert_eq!(held.lowest, vec![40, 20]);
}

/// Moves that do not fit the balance (the stored rows disagree with each other) are an error, never a number: an
/// account that holds 10 now and received 50 in the window would have started below zero.
#[test]
fn h1_moves_that_do_not_fit_the_balance_are_an_error_and_not_a_number() {
    let a = who(1);
    let balances = [(a.clone(), 10u128)];
    for deltas in [vec![50i128], vec![20, -5]] {
        let changes: Vec<Change> = deltas
            .iter()
            .enumerate()
            .map(|(i, d)| change(i as u64, &a, *d))
            .collect();
        let WindowRaw::Counted(runs) = held::walk(&changes, Limits::default()) else {
            panic!("not cut");
        };
        let err = held::lowest(
            &runs,
            balances.iter().map(|(a, b)| (a, b)),
            &BTreeSet::new(),
        )
        .expect_err("the moves do not fit a balance of 10");
        assert!(
            format!("{err:#}").contains("its balance now is 10"),
            "{err:#}"
        );
    }
}

/// H2: moving Shares between accounts never raises the total held for a window, and a shorter window never
/// holds less than a longer one. Random sequences of transfers.
#[test]
fn h2_moving_shares_around_never_raises_the_held_total_and_a_longer_window_never_holds_more() {
    // A small deterministic generator: the test must not depend on a crate's seed.
    let mut state: u64 = 0x2545_f491_4f6c_dd1d;
    let mut next = |bound: u64| {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        state % bound
    };
    for _ in 0..200 {
        let accounts: Vec<String> = (1..=5u8).map(who).collect();
        let mut balances = vec![100u128; accounts.len()];
        let start_total: u128 = balances.iter().sum();
        let mut changes: Vec<Change> = Vec::new();
        let moves = 1 + next(12);
        for block in 0..moves {
            let (from, to) = (next(5) as usize, next(5) as usize);
            if from == to || balances[from] == 0 {
                continue;
            }
            let amount = 1 + u128::from(next(balances[from] as u64));
            balances[from] -= amount;
            balances[to] += amount;
            changes.push(change(block, &accounts[from], -(amount as i128)));
            changes.push(change(block, &accounts[to], amount as i128));
        }
        let now: Vec<(String, u128)> = accounts.iter().cloned().zip(balances).collect();
        let whole = lowest_of(&changes, &now);
        // The same moves, but only the later half is inside the window (a shorter window): each account's
        // balance at the shorter window's start is its balance now less the later half's moves.
        let half = changes.len() / 2;
        let shorter = lowest_of(&changes[half..], &now);
        assert!(
            whole.shares <= shorter.shares,
            "a longer window holds no more"
        );
        assert!(
            whole.shares <= start_total,
            "moving Shares around cannot make more of them"
        );
        let supply: u128 = now.iter().map(|(_, b)| *b).sum();
        assert_eq!(supply, start_total, "the moves conserve the supply");
        assert!(shorter.shares <= supply);
    }
}

/// H3: at a window of zero the lowest balances are the balances: the held total is the supply less what the
/// excluded accounts hold.
#[test]
fn h3_held_at_zero_window_is_the_supply() {
    let (a, b, vault) = (who(1), who(2), who(9));
    let now = [(a, 70u128), (b, 30), (vault.clone(), 5)];
    let WindowRaw::Counted(runs) = held::walk(&[], Limits::default()) else {
        panic!("an empty window is counted");
    };
    let held = held::lowest(
        &runs,
        now.iter().map(|(a, b)| (a, b)),
        &BTreeSet::from([vault]),
    )
    .expect("nothing moved");
    assert_eq!(
        held.shares, 100,
        "the supply less the 5 an excluded account holds"
    );
}

/// H3 on the real run: every account that holds, at a zero window, counts all it holds.
#[tokio::test]
async fn h3_on_the_run_a_zero_window_holds_the_whole_supply_of_holders() {
    let built = build_from("A_example").await.expect("builds");
    let (_, ledger, as_of, _) = super::record_tests::load("A_example");
    let excluded = ledger.excluded(&BTreeSet::from([hex0x(&as_of.launcher)]));
    let supply = built
        .record
        .shares
        .backers
        .parse::<u128>()
        .expect("a number");
    let in_excluded: u128 = ledger
        .shares_balances()
        .filter(|(a, _)| excluded.contains(*a))
        .map(|(_, v)| *v)
        .sum();
    let zero =
        held::lowest(&Default::default(), ledger.shares_balances(), &excluded).expect("fits");
    assert_eq!(zero.shares, supply - in_excluded);
}

/// A window over either cap is cut, never a smaller number: exactly the cap of rows gives a value, one more
/// gives none; the same for accounts.
#[test]
fn h4_a_window_over_its_cap_is_cut_and_one_at_the_cap_is_not() {
    let limits = Limits {
        rows_max: 4,
        accounts_max: 2,
    };
    let rows = |n: usize| -> Vec<Change> {
        (0..n)
            .map(|i| change(i as u64, &who(1 + (i % 2) as u8), 1))
            .collect()
    };
    assert!(matches!(
        held::walk(&rows(4), limits),
        WindowRaw::Counted(_)
    ));
    assert_eq!(held::walk(&rows(5), limits), WindowRaw::Cut);
    let three_accounts: Vec<Change> = (1..=3).map(|n| change(1, &who(n), 1)).collect();
    assert_eq!(held::walk(&three_accounts, limits), WindowRaw::Cut);
    assert!(matches!(
        held::walk(&three_accounts[..2], limits),
        WindowRaw::Counted(_)
    ));
}

/// H4/V2: a cut window makes only its own key null; the other window stands, and nothing else changes.
#[tokio::test]
async fn h4_a_cut_window_nulls_that_windows_figures_only() {
    let (fx, ledger, as_of, chain) = super::record_tests::load("A_example");
    let read = super::views::read(&chain, fx.launcher, &ledger, as_of.block, as_of.time)
        .await
        .expect("reads");
    let (project, _) = super::fixture::BookChain::load(&fx, "A_example");
    let rows = fx.rows(&project, as_of.block);
    let (rank, badge) = windows_of(&rows, &ledger, &as_of);
    for (r, b, rank_is, badge_is) in [
        (Window::Cut, badge.clone(), false, true),
        (rank.clone(), Window::Cut, true, false),
    ] {
        let (record, report) = super::numbers::build(
            &ledger,
            &as_of,
            &read,
            &Default::default(),
            as_of.time + 1,
            &SocialInput {
                rows: &rows,
                held: Some((&r, &b)),
            },
        )
        .expect("builds");
        let held = record.held.expect("held stands");
        assert_eq!(held.rank.is_some(), rank_is);
        assert_eq!(held.badge.is_some(), badge_is);
        assert_eq!(report.cut, 1);
        assert!(report.failed.is_empty(), "a cut is not a failure");
        let est = record.established.expect("established stands");
        assert_eq!(
            est.reached.is_some(),
            badge_is,
            "reached needs the badge window"
        );
    }
}

/// H5: the badge from its inputs: reached; below 60 percent; fewer than 10 accounts; a Pair with one signer twice.
#[test]
fn h5_the_badge_rule_on_its_inputs() {
    let pair = |a: &str, b: &str| record::RunnerRec {
        address: who(0xaa),
        is_pair: true,
        signers: Some([a.to_owned(), b.to_owned()]),
    };
    let held = |bps: u64, accounts: u64| record_social::HeldRec {
        windows: record_social::WindowsRec {
            rank_secs: rank_secs(UNIT),
            badge_secs: badge_secs(UNIT),
        },
        rank: None,
        badge: Some(record_social::BadgeRec {
            shares: "1".into(),
            bps,
        }),
        counted_accounts: accounts,
    };
    let two = pair(&who(1), &who(2));
    let reached = |bps, accounts, runner: &record::RunnerRec| {
        record_social::established_of(Some(&held(bps, accounts)), runner, UNIT).reached
    };
    assert_eq!(reached(6200, 12, &two), Some(true));
    assert_eq!(reached(5800, 12, &two), Some(false), "below 60 percent");
    assert_eq!(
        reached(6000, 12, &two),
        Some(true),
        "exactly 60 percent counts"
    );
    assert_eq!(
        reached(6200, 9, &two),
        Some(false),
        "fewer than 10 accounts"
    );
    assert_eq!(reached(6200, 10, &two), Some(true), "exactly 10 counts");
    assert_eq!(
        reached(6200, 12, &pair(&who(1), &who(1))),
        Some(false),
        "one signer twice"
    );
    assert_eq!(
        reached(6200, 12, &pair(&who(1), ZERO)),
        Some(false),
        "a zero signer"
    );
    let alone = record::RunnerRec {
        address: who(1),
        is_pair: false,
        signers: None,
    };
    assert_eq!(reached(6200, 12, &alone), Some(false), "not a Pair");
    // No badge window: no verdict, never "no".
    let mut cut = held(6200, 12);
    cut.badge = None;
    let e = record_social::established_of(Some(&cut), &two, UNIT);
    assert_eq!((e.held_bps, e.reached), (None, None));
    // No held at all: no inputs, no verdict.
    let e = record_social::established_of(None, &two, UNIT);
    assert_eq!((e.held_bps, e.accounts, e.reached), (None, None, None));
    assert!(e.two_signers);
}

/// H6 and H7: `rank.money` is what the Shares would get at the record's own per-Share figure, and an account
/// whose lowest balance is worth less than the smallest Back is not counted.
#[test]
fn h6_h7_money_is_the_shares_at_the_leave_value_and_small_accounts_do_not_count() {
    let one = 1_000_000_000_000_000_000u128;
    let held = Held {
        shares: 3 * one + one / 2,
        lowest: vec![3 * one, one / 2],
    };
    // 0.25 dollar a Share, the smallest Back 1 dollar: the three Shares are worth 0.75, the half 0.125.
    let rec = record_social::held_of(
        &Window::Counted(held.clone()),
        &Window::Counted(held),
        10 * one,
        250_000,
        1_000_000,
        0,
        UNIT,
    )
    .expect("builds");
    let rank = rec.rank.expect("rank");
    assert_eq!(rank.money, "875000");
    assert_eq!(rank.accounts, 0, "neither account holds a dollar's worth");
    assert_eq!(rank.bps, 3500);
    // At a figure that makes the 3 Shares worth 1.5 dollars, one account counts.
    let held = Held {
        shares: 3 * one + one / 2,
        lowest: vec![3 * one, one / 2],
    };
    let rec = record_social::held_of(
        &Window::Counted(held),
        &Window::Cut,
        10 * one,
        500_000,
        1_000_000,
        0,
        UNIT,
    )
    .expect("builds");
    assert_eq!(rec.rank.expect("rank").accounts, 1);
    assert!(rec.badge.is_none());
}

/// The real run: the example's held figures obey their own checks and carry no address.
#[tokio::test]
async fn the_example_held_stands_on_the_runs_rows() {
    let built = build_from("A_example").await.expect("builds");
    let held = built.record.held.as_ref().expect("held is there");
    let rank = held.rank.as_ref().expect("rank");
    let badge = held.badge.as_ref().expect("badge");
    let supply: u128 = built.record.shares.backers.parse().expect("a number");
    assert!(badge.shares.parse::<u128>().expect("n") <= rank.shares.parse::<u128>().expect("n"));
    assert!(rank.shares.parse::<u128>().expect("n") <= supply);
    assert_eq!(held.windows.rank_secs, 30 * (UNIT / 7));
    assert_eq!(held.windows.badge_secs, 13 * UNIT);
}

// ------------------------------------------------------------------------------------------ feed

fn feed(rows: &[LogRow]) -> record_social::FeedRec {
    record_social::feed_of(rows, AS_OF, UNIT).expect("builds")
}

/// F1: 48 buckets, aligned, quiet hours present as zeros, the last holds the record's time.
#[test]
fn f1_there_are_48_aligned_hours_and_the_last_holds_the_time() {
    let f = feed(&[]);
    assert_eq!(FEED_HOURS, 48);
    assert_eq!(f.hours.len(), 48);
    assert_eq!(f.bucket_secs, HOUR);
    assert!(f.hours.iter().all(|h| h.at % HOUR == 0));
    assert!(f.hours.windows(2).all(|w| w[1].at == w[0].at + HOUR));
    let last = f.hours.last().expect("an hour");
    assert!(last.at <= AS_OF && AS_OF < last.at + HOUR);
    assert!(f
        .hours
        .iter()
        .all(|h| h.joins == 0 && h.took_out == 0 && h.net.amount == "0"));
    // A time exactly on an hour's start belongs to the new hour, which is then the last.
    let on_the_hour = (AS_OF / HOUR + 1) * HOUR;
    let g = record_social::feed_of(&[], on_the_hour, UNIT).expect("builds");
    assert_eq!(g.hours.last().expect("an hour").at, on_the_hour);
}

/// F2: rounding is half up on the bucket's net: one 40-dollar join reads even; exactly 50 rounds up; the sum of
/// a bucket is rounded once, never each event.
#[test]
fn f2_the_net_is_rounded_once_per_hour_half_up() {
    let at = AS_OF - 10;
    let dollars = |d: u64| d * 1_000_000;
    let hour_of = |rows: &[LogRow]| {
        feed(rows)
            .hours
            .into_iter()
            .find(|h| h.joins + h.took_out > 0)
            .expect("an hour with something in it")
    };
    let one = hour_of(&[joined(at, dollars(40), 0)]);
    assert_eq!(
        (one.joins, one.net.dir, one.net.amount.as_str()),
        (1, record_social::NetDir::Even, "0")
    );
    let fifty = hour_of(&[joined(at, dollars(50), 0)]);
    assert_eq!(
        (fifty.net.dir, fifty.net.amount.as_str()),
        (record_social::NetDir::In, "100000000")
    );
    let below = hour_of(&[joined(at, dollars(50) - 1, 0)]);
    assert_eq!(below.net.dir, record_social::NetDir::Even);
    // Three joins of 40: each alone rounds to nothing, together 120 rounds to 100.
    let three = hour_of(&[
        joined(at, dollars(40), 0),
        joined(at, dollars(40), 0),
        joined(at, dollars(40), 0),
    ]);
    assert_eq!((three.joins, three.net.amount.as_str()), (3, "100000000"));
    // The fee is not money that stayed: net in is paid less the fee.
    let fee = hour_of(&[joined(at, dollars(1000), dollars(20))]);
    assert_eq!(fee.net.amount, "1000000000", "980 dollars rounds to 1000");
    // A take-out is money out: 300 in, 120 out is 180 in, rounded to 200.
    let both = hour_of(&[joined(at, dollars(300), 0), left(at, dollars(120))]);
    assert_eq!(
        (
            both.joins,
            both.took_out,
            both.net.dir,
            both.net.amount.as_str()
        ),
        (1, 1, record_social::NetDir::In, "200000000")
    );
    // More out than in reads "out" with the absolute amount.
    let out = hour_of(&[left(at, dollars(400))]);
    assert_eq!(
        (out.net.dir, out.net.amount.as_str()),
        (record_social::NetDir::Out, "400000000")
    );
    // A join and a take-out of the same size is even: two counts and no money.
    let wash = hour_of(&[joined(at, dollars(900), 0), left(at, dollars(900))]);
    assert_eq!(
        (wash.joins, wash.took_out, wash.net.dir),
        (1, 1, record_social::NetDir::Even)
    );
}

/// F3: the feed carries exactly the keys the plan lists: no volume, no money in and out apart, no per-event row.
#[test]
fn f3_the_feeds_keys_are_exactly_the_listed_ones() {
    let f = feed(&[
        joined(AS_OF - 10, 400_000_000, 0),
        left(AS_OF - 10, 100_000_000),
    ]);
    let v = serde_json::to_value(&f).expect("json");
    let keys = |v: &Value| -> BTreeSet<String> {
        v.as_object().expect("object").keys().cloned().collect()
    };
    assert_eq!(
        keys(&v),
        ["bucketSecs", "cut", "hours", "items", "roundTo"]
            .map(String::from)
            .into_iter()
            .collect()
    );
    assert_eq!(
        keys(&v["hours"][47]),
        ["at", "joins", "net", "tookOut"]
            .map(String::from)
            .into_iter()
            .collect()
    );
    assert_eq!(
        keys(&v["hours"][47]["net"]),
        ["amount", "dir"].map(String::from).into_iter().collect()
    );
    assert_eq!(v["roundTo"], "100000000");
}

/// F4: a take-out by a Team Share holder counts as a take-out, with equal weight.
#[test]
fn f4_a_team_take_out_counts_like_any_other() {
    let team = row(
        AS_OF - 5,
        Role::Treasury,
        "TeamLeft",
        json!({ "cash": "250000000" }),
    );
    let f = feed(&[left(AS_OF - 5, 250_000_000), team]);
    let last = f.hours.last().expect("an hour");
    assert_eq!(last.took_out, 2);
    assert_eq!(last.net.dir, record_social::NetDir::Out);
    assert_eq!(last.net.amount, "500000000");
}

/// F6: the six kinds only, dates (the notice's end for a planned task, the deadline for a taken one), newest first,
/// the cut of 30, and what is older than 28 days is out.
#[test]
fn f6_items_are_the_six_kinds_newest_first_with_a_cut() {
    let task = |time: u64, event: &str, fields: Value| row(time, Role::Tasks, event, fields);
    let rows = vec![
        // Older than 28 days: never an item.
        checked_in(AS_OF - 29 * 86_400),
        task(
            AS_OF - 100,
            "TaskAnnounced",
            json!({"serial": "3", "noticeEnd": "1800000500"}),
        ),
        task(
            AS_OF - 90,
            "TaskTaken",
            json!({"serial": "3", "deadline": "1800900000"}),
        ),
        task(
            AS_OF - 80,
            "TaskResolved",
            json!({"serial": "3", "state": "3"}),
        ),
        task(
            AS_OF - 70,
            "TaskResolved",
            json!({"serial": "2", "state": "4"}),
        ),
        task(
            AS_OF - 60,
            "TaskResolved",
            json!({"serial": "4", "state": "5"}),
        ),
        task(
            AS_OF - 50,
            "TaskResolved",
            json!({"serial": "5", "state": "7"}),
        ),
        task(
            AS_OF - 40,
            "TaskResolved",
            json!({"serial": "6", "state": "6"}),
        ),
        checked_in(AS_OF - 30),
        // Not items: a rate raise and a wind-down are said on the money screens already.
        row(
            AS_OF - 20,
            Role::Treasury,
            "RateProposed",
            json!({"ppm": "1500"}),
        ),
        row(
            AS_OF - 10,
            Role::Treasury,
            "WoundDown",
            json!({"kind": "1"}),
        ),
    ];
    let f = feed(&rows);
    use record_social::ItemKind::*;
    let kinds: Vec<_> = f.items.iter().map(|i| i.kind).collect();
    assert_eq!(
        kinds,
        vec![
            Update,
            TaskWithdrawn,
            TaskEnded,
            TaskEnded,
            TaskEnded,
            TaskPaid,
            TaskTaken,
            TaskPlanned
        ]
    );
    assert!(
        f.items.windows(2).all(|w| w[0].at >= w[1].at),
        "newest first"
    );
    let planned = f.items.last().expect("an item");
    assert_eq!(
        (planned.serial, planned.date),
        (Some(3), Some(1_800_000_500))
    );
    let taken = &f.items[6];
    assert_eq!((taken.serial, taken.date), (Some(3), Some(1_800_900_000)));
    assert_eq!((f.items[0].serial, f.items[0].date), (None, None));
    assert_eq!(f.cut, 0);
    // More than 30 in the window: the newest 30 stay and the rest are counted.
    let many: Vec<LogRow> = (0..40u64).map(|i| checked_in(AS_OF - 1_000 + i)).collect();
    let f = feed(&many);
    assert_eq!(FEED_ITEMS, 30);
    assert_eq!(f.items.len(), 30);
    assert_eq!(f.cut, 10);
    assert_eq!(f.items[0].at, AS_OF - 1_000 + 39);
}

/// F5: no address-shaped string and no per-account figure anywhere in the four new keys, on the example and on a
/// record of 200 holders.
#[tokio::test]
async fn f5_the_four_keys_carry_no_address_and_no_per_account_figure() {
    fn walk(v: &Value, path: &str) {
        match v {
            Value::Object(m) => m.iter().for_each(|(k, v)| walk(v, &format!("{path}.{k}"))),
            Value::Array(a) => a.iter().for_each(|v| walk(v, path)),
            Value::String(s) => {
                assert!(
                    !s.starts_with("0x"),
                    "{path}: an address-shaped string in the social keys: {s}"
                );
                assert!(s.len() < 40, "{path}: a long string");
            }
            _ => {}
        }
    }
    let built = build_from("A_example").await.expect("builds");
    for key in ["held", "feed", "streaks", "established"] {
        assert!(!built.value[key].is_null(), "{key} is in the example");
        walk(&built.value[key], key);
    }
    // And with 200 holders: still no account in any of them (only counts and sums).
    let many: Vec<u128> = (1..=200u128)
        .map(|n| n * 1_000_000_000_000_000_000)
        .collect();
    let held = Held {
        shares: many.iter().sum(),
        lowest: many,
    };
    let rec = record_social::held_of(
        &Window::Counted(held.clone()),
        &Window::Counted(held),
        u128::MAX / 4,
        1,
        1,
        200,
        UNIT,
    )
    .expect("builds");
    walk(&serde_json::to_value(rec).expect("json"), "held-of-200");
}

// ------------------------------------------------------------------------------------------ streaks

fn weeks(rows: &[LogRow], as_of: u64, launched: u64) -> (u64, u64, Option<u64>) {
    let s = record_social::streaks_of(rows, as_of, UNIT, launched).expect("builds");
    (s.updates.weeks, s.updates.longest, s.updates.last_at)
}

/// S1 to S4: launch-aligned windows; the open window being empty does not end the run, a closed empty one does;
/// two passes inside one window agree; a project that checks in every ten days shows fewer weeks; the longest run.
#[test]
fn s1_to_s4_streaks_are_launch_aligned_and_do_not_slide() {
    let launched = 1_000_000;
    let at = |week: u64, plus: u64| launched + week * UNIT + plus;
    // Check-ins in weeks 1, 2, 3 and 5; the record is at week 6, the open window, with none yet.
    let rows: Vec<LogRow> = [1, 2, 3, 5]
        .iter()
        .map(|w| checked_in(at(*w, 100)))
        .collect();
    let now = at(6, 10);
    assert_eq!(weeks(&rows, now, launched), (1, 3, Some(at(5, 100))));
    // The open window with a check-in counts: weeks 5 and 6.
    let mut with_open = rows.clone();
    with_open.push(checked_in(at(6, 5)));
    assert_eq!(weeks(&with_open, now, launched).0, 2);
    // Week 4 was empty and closed: it ended the run of weeks 1 to 3.
    assert_eq!(weeks(&rows, at(5, 500), launched).0, 1);
    // Two passes inside one window give the same value (a sliding anchor would flap).
    for secs in [0, 1, UNIT / 2, UNIT - 1] {
        assert_eq!(
            weeks(&rows, at(6, secs), launched),
            weeks(&rows, at(6, 0), launched)
        );
    }
    // Every ten days: windows of seven days miss some, so the run is shorter than the project's age.
    let ten_days: Vec<LogRow> = (1..=8)
        .map(|i| checked_in(launched + i * 10 * 86_400))
        .collect();
    // They fall in weeks 1, 2, 4, 5, 7, 8, 10 and 11 of the project's life (day 10 is in week 1, day 20 in week 2,
    // day 30 in week 4, and so on): runs of two, never longer, although the project checked in 8 times in 80 days.
    let (w, longest, _) = weeks(&ten_days, launched + 80 * 86_400 + 5, launched);
    assert_eq!((w, longest), (2, 2), "ten-day check-ins are not weekly");
    // No check-in: nothing, and no last time.
    assert_eq!(weeks(&[], now, launched), (0, 0, None));
}

// ------------------------------------------------------------------------------------------ established, validate

/// E1 to E4: the constants in the record are the server's; `held: null` gives `reached: null`.
#[tokio::test]
async fn e1_to_e4_the_rule_ships_in_the_record_and_a_missing_held_gives_no_verdict() {
    let built = build_from("A_example").await.expect("builds");
    let e: EstablishedRec = built.record.established.expect("established");
    assert_eq!(e.rule.min_held_bps, 6_000);
    assert_eq!(e.rule.min_accounts, 10);
    assert_eq!(
        e.rule.held_secs,
        built.record.held.as_ref().expect("held").windows.badge_secs
    );
    assert_eq!(
        e.accounts,
        Some(built.record.held.expect("held").counted_accounts)
    );
}

/// V1: `validate` refuses a record whose `reached` contradicts its inputs, and one whose feed is not what it says.
#[tokio::test]
async fn v1_validate_refuses_a_verdict_that_contradicts_its_inputs() {
    let built = build_from("A_example").await.expect("builds");
    assert_eq!(record::validate(&built.record), Vec::<String>::new());
    let mut r: Record = built.record.clone();
    let e = r.established.as_mut().expect("established");
    e.reached = Some(!e.reached.expect("a verdict"));
    let bad = record::validate(&r);
    assert!(bad.iter().any(|b| b.contains("established")), "{bad:?}");
    // A feed whose net is not a multiple of the step, an hour out of line, a serial on an update.
    let mut r = built.record.clone();
    r.feed.as_mut().expect("feed").hours[3].net.amount = "5".into();
    assert!(record::validate(&r).iter().any(|b| b.contains("feed")));
    let mut r = built.record.clone();
    r.feed.as_mut().expect("feed").hours[3].at += 1;
    assert!(record::validate(&r).iter().any(|b| b.contains("feed")));
    // A streak longer than its longest, a held badge above its rank.
    let mut r = built.record.clone();
    r.streaks.as_mut().expect("streaks").updates.weeks = 99;
    assert!(record::validate(&r).iter().any(|b| b.contains("streaks")));
    let mut r = built.record.clone();
    let held = r.held.as_mut().expect("held");
    held.badge.as_mut().expect("badge").shares = (u128::MAX / 2).to_string();
    assert!(record::validate(&r).iter().any(|b| b.contains("held")));
}

/// V2: a failing social check nulls that key only: the money fields and the other keys are signed.
#[tokio::test]
async fn v2_a_failing_check_nulls_that_key_and_nothing_else() {
    let (fx, ledger, as_of, chain) = super::record_tests::load("A_example");
    let read = super::views::read(&chain, fx.launcher, &ledger, as_of.block, as_of.time)
        .await
        .expect("reads");
    let (project, _) = super::fixture::BookChain::load(&fx, "A_example");
    let mut rows = fx.rows(&project, as_of.block);
    let windows = windows_of(&rows, &ledger, &as_of);
    let build = |rows: &[LogRow]| {
        super::numbers::build(
            &ledger,
            &as_of,
            &read,
            &Default::default(),
            as_of.time + 1,
            &SocialInput {
                rows,
                held: Some((&windows.0, &windows.1)),
            },
        )
        .expect("builds")
    };
    let (good, report) = build(&rows);
    assert!(report.failed.is_empty());
    // A Joined row that charges more fee than it took in cannot be a bucket's money: the feed is null.
    let at = as_of.time - 60;
    rows.push(joined(at, 10, 20));
    let (bad, report) = build(&rows);
    assert!(bad.feed.is_none(), "the feed that failed is null");
    assert_eq!(report.failed.len(), 1, "{:?}", report.failed);
    assert!(report.failed[0].starts_with("feed not published"));
    // Everything else, the money included, is what it was.
    let (mut a, mut b) = (
        serde_json::to_value(&good).expect("json"),
        serde_json::to_value(&bad).expect("json"),
    );
    for v in [&mut a, &mut b] {
        v.as_object_mut().expect("object").remove("feed");
    }
    assert_eq!(a, b, "only the feed changed");
}

/// V2 (the second function): a feed or a streak that is sound in itself but is not what the rows say is caught by the
/// recount from the rows, which the record alone cannot do: a back more in an hour, an hour's net moved by a whole
/// step, an item changed, a last check-in a second off.
#[tokio::test]
async fn v2_the_recount_from_the_rows_catches_what_the_record_alone_cannot() {
    let built = build_from("A_example").await.expect("builds");
    let (fx, _, as_of, _) = super::record_tests::load("A_example");
    let (project, _) = super::fixture::BookChain::load(&fx, "A_example");
    let rows = fx.rows(&project, as_of.block);
    assert!(record_social::check_feed_rows(&built.record, &rows).is_ok());
    assert!(record_social::check_streaks_rows(&built.record, &rows).is_ok());
    let tampered = |change: &dyn Fn(&mut Record)| {
        let mut r = built.record.clone();
        change(&mut r);
        assert_eq!(
            record::validate(&r),
            Vec::<String>::new(),
            "the record alone finds nothing wrong with it"
        );
        r
    };
    // One back more in the last hour (the record's own checks do not count backs).
    let r = tampered(&|r| r.feed.as_mut().expect("feed").hours[47].joins += 1);
    assert!(
        record_social::check_feed_rows(&r, &rows).is_err(),
        "a back more"
    );
    // An hour's net moved by a whole rounding step: still a multiple of it, still `in`.
    let r = tampered(&|r| {
        let hour = &mut r.feed.as_mut().expect("feed").hours[10];
        hour.net.dir = record_social::NetDir::In;
        hour.net.amount = "100000000".into();
    });
    assert!(
        record_social::check_feed_rows(&r, &rows).is_err(),
        "an hour's net"
    );
    // An item's task number changed.
    let r = tampered(&|r| {
        let items = &mut r.feed.as_mut().expect("feed").items;
        let task = items
            .iter_mut()
            .find(|i| i.serial.is_some())
            .expect("a task item");
        task.serial = task.serial.map(|s| s + 100);
    });
    assert!(
        record_social::check_feed_rows(&r, &rows).is_err(),
        "an item"
    );
    // The last check-in a second early (still a time the clock knows).
    let r = tampered(&|r| {
        let u = &mut r.streaks.as_mut().expect("streaks").updates;
        u.last_at = u.last_at.map(|t| t - 1);
    });
    assert!(
        record_social::check_streaks_rows(&r, &rows).is_err(),
        "the last check-in"
    );
}

/// V3: a held that could not be read at all (a database error) is `null` and the record is still built.
#[tokio::test]
async fn v3_held_that_could_not_be_read_is_null_and_the_record_stands() {
    let (fx, ledger, as_of, chain) = super::record_tests::load("A_example");
    let read = super::views::read(&chain, fx.launcher, &ledger, as_of.block, as_of.time)
        .await
        .expect("reads");
    let (record, report) = super::numbers::build(
        &ledger,
        &as_of,
        &read,
        &Default::default(),
        as_of.time + 1,
        &SocialInput::empty(),
    )
    .expect("builds");
    assert!(record.held.is_none());
    assert_eq!(report.failed.len(), 1);
    let e = record
        .established
        .expect("established is there, with no inputs");
    assert_eq!((e.held_bps, e.accounts, e.reached), (None, None, None));
    // The key is in the written record as null, never missing, never zero.
    let v = serde_json::to_value(&record).expect("json");
    assert!(v["held"].is_null() && v.as_object().expect("object").contains_key("held"));
}

/// V4: the four keys do not make the server sign again: they are out of the digest of facts.
#[test]
fn v4_facts_of_strips_the_four_keys() {
    let mut v = example();
    let before = super::numbers::facts_of(&v);
    for key in ["held", "feed", "streaks", "established"] {
        assert!(before.get(key).is_none(), "{key} is not in the digest");
        v[key] = json!({"anything": 1});
    }
    assert_eq!(super::numbers::facts_of(&v), before);
    // A real field still moves the digest.
    v["totals"]["joined"] = json!("1");
    assert_ne!(super::numbers::facts_of(&v), before);
}

/// X1: the example is the server's own output, and it carries the four keys.
#[test]
fn x1_the_example_has_the_four_keys_with_figures() {
    let v = example();
    for key in ["held", "feed", "streaks", "established"] {
        assert!(v[key].is_object(), "{key} is in the example");
    }
    assert_eq!(
        v["feed"]["hours"].as_array().expect("hours").len(),
        FEED_HOURS
    );
}
