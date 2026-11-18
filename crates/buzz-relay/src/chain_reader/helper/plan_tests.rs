//! The builder, on hand-made final logs: what is due when, and that nothing it
//! produces is outside the allow-list.

use std::collections::BTreeSet;

use serde_json::{json, Value};

use super::*;
use crate::chain_reader::helper::calls::tests::{selector_of, FORBIDDEN};
use crate::chain_reader::helper::calls::{ALLOWED, NAMES};
use buzz_evm_allowance::abi::selector;

const T0: u64 = 1_700_000_000;
const ROUNDS: &str = "0x2525252525252525252525252525252525252525";
const TREASURY: &str = "0x2222222222222222222222222222222222222222";
const VESTER: &str = "0x2323232323232323232323232323232323232323";
const FINISHER: &str = "0x2424242424242424242424242424242424242424";
const FOUNDER: &str = "0xf0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0";
const ALICE: &str = "0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
const BOB: &str = "0xb0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0";
const CAROL: &str = "0xc0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0";
const CLAIM: &str = "0xe1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1";
const AUCTION: &str = "0xa0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0";

fn row(block: u64, time: u64, role: Role, event: &str, fields: Value) -> LogRow {
    LogRow {
        block,
        log_index: 0,
        time,
        role,
        address: [0; 20],
        event: event.into(),
        fields,
    }
}

fn launch() -> LogRow {
    row(
        0,
        T0,
        Role::Launcher,
        "ProjectLaunched",
        json!({"project": {"founder": FOUNDER, "shares": "0x2121212121212121212121212121212121212121",
            "treasury": TREASURY, "vester": VESTER, "finisher": FINISHER, "rounds": ROUNDS}}),
    )
}

fn opened(block: u64, round: u64, opens: u64) -> LogRow {
    row(
        block,
        opens,
        Role::Rounds,
        "RoundOpened",
        json!({"round": round.to_string(), "closesAt": (opens + DAY).to_string()}),
    )
}

fn asked(block: u64, round: u64, who: &str, total: u128) -> LogRow {
    row(
        block,
        T0 + 10,
        Role::Rounds,
        "Asked",
        json!({"round": round.to_string(), "backer": who, "total": total.to_string()}),
    )
}

fn closed(block: u64, round: u64, time: u64, accepted: u128) -> LogRow {
    row(
        block,
        time,
        Role::Rounds,
        "RoundClosed",
        json!({"round": round.to_string(), "accepted": accepted.to_string()}),
    )
}

fn settled(block: u64, round: u64, who: &str) -> LogRow {
    row(
        block,
        T0 + DAY,
        Role::Rounds,
        "Settled",
        json!({"round": round.to_string(), "backer": who}),
    )
}

fn ctx(block: u64, time: u64) -> PlanContext {
    PlanContext {
        block,
        time,
        batch: 40,
    }
}

fn names(jobs: &[Job]) -> Vec<&'static str> {
    jobs.iter().map(|j| j.call.name()).collect()
}

const KEY: Word = [0x4b; 32];

#[test]
fn a_round_is_closed_once_its_day_has_passed_and_not_after_it_closed() {
    let mut logs = vec![launch(), opened(1, 1, T0), asked(2, 1, BOB, 100)];
    let early = plan(&KEY, &logs, &[], &ctx(2, T0 + DAY - 1)).expect("plan");
    assert!(early.is_empty(), "{early:?}");
    let due = plan(&KEY, &logs, &[], &ctx(3, T0 + DAY)).expect("plan");
    assert_eq!(names(&due), ["rounds.close"]);
    assert_eq!(due[0].due_block, 1, "due because of the RoundOpened row");
    assert!(!due[0].repeats);
    logs.push(closed(4, 1, T0 + DAY, 100));
    let after = plan(&KEY, &logs, &[], &ctx(5, T0 + DAY + 20)).expect("plan");
    assert!(!names(&after).contains(&"rounds.close"));
}

#[test]
fn settle_lists_only_backers_still_waiting_with_a_non_zero_ask() {
    let mut logs = vec![
        launch(),
        opened(1, 1, T0),
        asked(2, 1, ALICE, 100),
        asked(2, 1, BOB, 50),
        asked(2, 1, CAROL, 70),
        // Carol lowered her ask to nothing: settle would revert for her.
        row(
            3,
            T0 + 20,
            Role::Rounds,
            "AskLowered",
            json!({"round": "1", "backer": CAROL, "total": "0"}),
        ),
        closed(4, 1, T0 + DAY, 150),
    ];
    let jobs = plan(&KEY, &logs, &[], &ctx(5, T0 + DAY + 1)).expect("plan");
    let settle: Vec<&Job> = jobs
        .iter()
        .filter(|j| j.call.name() == "rounds.settleMany")
        .collect();
    assert_eq!(settle.len(), 1);
    let HelperCall::RoundsSettleMany { backers, round, .. } = &settle[0].call else {
        panic!("not a settle");
    };
    assert_eq!(*round, 1);
    let want: Vec<[u8; 20]> = [ALICE, BOB]
        .iter()
        .filter_map(|a| parse_fixed::<20>(a))
        .collect();
    assert_eq!(backers, &want);
    assert_eq!(settle[0].due_block, 4);

    // Bob refunded (a refund settles him first): only Alice is left.
    logs.push(settled(6, 1, BOB));
    let jobs = plan(&KEY, &logs, &[], &ctx(7, T0 + DAY + 2)).expect("plan");
    let HelperCall::RoundsSettleMany { backers, .. } = &jobs
        .iter()
        .find(|j| j.call.name() == "rounds.settleMany")
        .expect("settle")
        .call
    else {
        panic!("not a settle");
    };
    assert_eq!(backers.len(), 1);

    // Batches of at most `batch` backers, each its own job.
    let mut many = vec![launch(), opened(1, 1, T0)];
    for i in 0..5u8 {
        many.push(asked(2, 1, &hex0x(&[i + 1; 20]), 10));
    }
    many.push(closed(3, 1, T0 + DAY, 50));
    let small = PlanContext {
        batch: 2,
        ..ctx(4, T0 + DAY + 1)
    };
    let jobs = plan(&KEY, &many, &[], &small).expect("plan");
    let sizes: Vec<usize> = jobs
        .iter()
        .filter_map(|j| match &j.call {
            HelperCall::RoundsSettleMany { backers, .. } => Some(backers.len()),
            _ => None,
        })
        .collect();
    assert_eq!(sizes, [2, 2, 1]);
    let keys: BTreeSet<&str> = jobs.iter().map(|j| j.key.as_str()).collect();
    assert_eq!(keys.len(), jobs.len(), "keys are unique");
}

#[test]
fn releases_and_sweeps_repeat_weekly() {
    let logs = vec![
        launch(),
        opened(1, 1, T0),
        asked(2, 1, BOB, 100),
        closed(3, 1, T0 + DAY, 100),
        settled(4, 1, BOB),
    ];
    let before = plan(&KEY, &logs, &[], &ctx(5, T0 + DAY + WEEK - 1)).expect("plan");
    assert!(!names(&before).contains(&"rounds.release"));
    assert!(names(&before).contains(&"rounds.sweepFees"));
    let one = plan(&KEY, &logs, &[], &ctx(9, T0 + DAY + WEEK)).expect("plan");
    let two = plan(&KEY, &logs, &[], &ctx(19, T0 + DAY + 2 * WEEK)).expect("plan");
    let key_of = |jobs: &[Job]| {
        jobs.iter()
            .find(|j| j.call.name() == "rounds.release")
            .map(|j| (j.key.clone(), j.repeats))
            .expect("release")
    };
    let (k1, r1) = key_of(&one);
    let (k2, _) = key_of(&two);
    assert!(r1);
    assert_ne!(k1, k2, "a new job each week");
}

#[test]
fn plain_grants_are_claimed_and_held_shares_never() {
    let mut logs = vec![
        launch(),
        row(
            0,
            T0,
            Role::Vester,
            "Granted",
            json!({"beneficiary": FOUNDER, "amount": "1"}),
        ),
        row(
            0,
            T0,
            Role::Launcher,
            "ProjectZeroSplit",
            json!({"claim": CLAIM}),
        ),
        row(
            0,
            T0,
            Role::Vester,
            "Granted",
            json!({"beneficiary": CLAIM, "amount": "1"}),
        ),
        opened(1, 1, T0),
        asked(2, 1, BOB, 100),
        closed(3, 1, T0 + DAY, 100),
        settled(4, 1, BOB),
        row(
            4,
            T0 + DAY,
            Role::Vester,
            "HeldGranted",
            json!({"round": "1", "backer": BOB, "amount": "1"}),
        ),
    ];
    // Before the clock starts, nothing is claimed.
    let jobs = plan(&KEY, &logs, &[], &ctx(5, T0 + DAY + 1)).expect("plan");
    assert!(!names(&jobs).contains(&"vester.claim"));
    logs.push(row(
        6,
        T0 + 2 * DAY,
        Role::Vester,
        "Started",
        json!({"time": "1"}),
    ));
    let jobs = plan(&KEY, &logs, &[], &ctx(7, T0 + 2 * DAY)).expect("plan");
    let claimed: Vec<[u8; 20]> = jobs
        .iter()
        .filter_map(|j| match &j.call {
            HelperCall::VesterClaim { beneficiary, .. } => Some(*beneficiary),
            _ => None,
        })
        .collect();
    assert_eq!(claimed, vec![parse_fixed::<20>(FOUNDER).expect("addr")]);
    // The claim contract's agreed entries are delivered in chunks of entries.
    let delivers: Vec<&Job> = jobs
        .iter()
        .filter(|j| j.call.name() == "earlier.deliverMany")
        .collect();
    assert_eq!(delivers.len(), 2, "64 entries in chunks of 40");
    assert!(delivers
        .iter()
        .all(|j| j.call.target() == parse_fixed::<20>(CLAIM).expect("addr")));
}

#[test]
fn a_sale_is_finished_after_its_last_block_and_abandoned_only_when_due() {
    let sale = row(
        10,
        T0,
        Role::Finisher,
        "SaleOpenedBy",
        json!({"auction": AUCTION, "endBlock": "100", "attempt": "0"}),
    );
    let mut logs = vec![launch(), sale];
    assert!(plan(&KEY, &logs, &[], &ctx(100, T0))
        .expect("plan")
        .is_empty());
    let jobs = plan(&KEY, &logs, &[], &ctx(101, T0)).expect("plan");
    assert_eq!(
        names(&jobs),
        ["finisher.openPool", "finisher.settle", "finisher.sweep"]
    );
    let late = plan(&KEY, &logs, &[], &ctx(100 + ABANDON_DELAY_BLOCKS, T0)).expect("plan");
    assert!(names(&late).contains(&"finisher.abandon"));
    // Once settled, abandon is never due; once swept, nothing is.
    logs.push(row(
        102,
        T0,
        Role::Finisher,
        "Settled",
        json!({"auction": AUCTION}),
    ));
    let jobs = plan(&KEY, &logs, &[], &ctx(100 + ABANDON_DELAY_BLOCKS, T0)).expect("plan");
    assert_eq!(names(&jobs), ["finisher.openPool", "finisher.sweep"]);
    logs.push(row(
        103,
        T0,
        Role::Finisher,
        "Swept",
        json!({"auction": AUCTION}),
    ));
    let jobs = plan(&KEY, &logs, &[], &ctx(200, T0)).expect("plan");
    assert!(jobs.iter().all(|j| !j.call.name().starts_with("finisher.")));
}

/// Every call the builder makes, over logs holding every situation it knows
/// (held grants, refunds, sales, the earlier backers, hand-backs, pool
/// positions), is on the allow-list and none is forbidden; Vester claims go
/// only to plain grants.
#[test]
fn the_builder_never_produces_a_forbidden_call() {
    let logs = vec![
        launch(),
        row(
            0,
            T0,
            Role::Vester,
            "Granted",
            json!({"beneficiary": FOUNDER, "amount": "1"}),
        ),
        row(
            0,
            T0,
            Role::Launcher,
            "ProjectZeroSplit",
            json!({"claim": CLAIM}),
        ),
        opened(1, 1, T0),
        asked(2, 1, BOB, 100),
        asked(2, 1, ALICE, 100),
        closed(3, 1, T0 + DAY, 200),
        settled(4, 1, BOB),
        row(
            4,
            T0,
            Role::Vester,
            "HeldGranted",
            json!({"round": "1", "backer": BOB, "amount": "1"}),
        ),
        row(
            5,
            T0,
            Role::Rounds,
            "Refunded",
            json!({"round": "1", "backer": BOB}),
        ),
        row(
            6,
            T0,
            Role::Treasury,
            "HandedBack",
            json!({"holder": ALICE}),
        ),
        row(7, T0, Role::Treasury, "PoolOpened", json!({"time": "1"})),
        row(7, T0, Role::Treasury, "Settled", json!({"amount": "1"})),
        row(
            8,
            T0,
            Role::Finisher,
            "SaleOpenedBy",
            json!({"auction": AUCTION, "endBlock": "9"}),
        ),
        row(9, T0, Role::Vester, "Started", json!({"time": "1"})),
    ];
    let positions = [Position {
        holder: [0x31; 20],
        token_id: [9; 32],
        block: 8,
    }];
    let jobs = plan(&KEY, &logs, &positions, &ctx(60_000, T0 + 30 * DAY)).expect("plan");
    let allowed: BTreeSet<[u8; 4]> = ALLOWED.iter().map(|s| selector(s)).collect();
    let made: BTreeSet<&str> = jobs.iter().map(|j| j.call.name()).collect();
    // The fixture reaches every call the builder knows.
    assert_eq!(
        made,
        NAMES
            .iter()
            .copied()
            .filter(|n| *n != "rounds.close")
            .collect()
    );
    for job in &jobs {
        let s = selector_of(&job.call);
        assert!(allowed.contains(&s), "{} is not allowed", job.call.name());
        for f in FORBIDDEN {
            assert_ne!(s, selector(f), "{} is forbidden", job.call.name());
        }
        if let HelperCall::VesterClaim { beneficiary, .. } = &job.call {
            assert_eq!(hex0x(beneficiary), FOUNDER, "only plain grants are claimed");
        }
        assert!(job.due_block <= 60_000, "built from final rows only");
    }
}
