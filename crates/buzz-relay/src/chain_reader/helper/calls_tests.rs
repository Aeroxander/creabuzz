//! The helper's call list is closed: what it can produce is exactly the
//! allow-list, and none of the calls that move a person's money by choice or
//! that a runner, a Pair or the Launcher's admin signs.

use std::collections::BTreeSet;

use buzz_evm_allowance::abi::selector;
use serde_json::json;

use super::*;

const R: [u8; 20] = [0x25; 20];
const T: [u8; 20] = [0x22; 20];
const F: [u8; 20] = [0x24; 20];
const V: [u8; 20] = [0x23; 20];
const H: [u8; 20] = [0x31; 20];
const E: [u8; 20] = [0x41; 20];
const BOB: [u8; 20] = [0xb0; 20];
const ALICE: [u8; 20] = [0xa1; 20];

/// One of every call. The match in `exhaustive` has no wildcard, so a new
/// variant does not compile until it is listed here too.
pub(crate) fn every_call() -> Vec<HelperCall> {
    vec![
        HelperCall::RoundsClose {
            rounds: R,
            round: 1,
        },
        HelperCall::RoundsSettleMany {
            rounds: R,
            round: 1,
            backers: vec![ALICE, BOB],
        },
        HelperCall::RoundsRelease {
            rounds: R,
            round: 1,
        },
        HelperCall::RoundsReturnUnsold { rounds: R },
        HelperCall::RoundsSweepFees { rounds: R },
        HelperCall::TreasurySweepFees { treasury: T },
        HelperCall::TreasuryRelease { treasury: T },
        HelperCall::FinisherOpenPool { finisher: F },
        HelperCall::FinisherSettle { finisher: F },
        HelperCall::FinisherSweep { finisher: F },
        HelperCall::FinisherAbandon { finisher: F },
        HelperCall::HolderCollect {
            holder: H,
            token_id: [7; 32],
        },
        HelperCall::VesterClaim {
            vester: V,
            beneficiary: BOB,
        },
        HelperCall::EarlierDeliverMany {
            claim: E,
            entries: vec![0, 3],
        },
    ]
}

fn exhaustive(call: &HelperCall) {
    match call {
        HelperCall::RoundsClose { .. }
        | HelperCall::RoundsSettleMany { .. }
        | HelperCall::RoundsRelease { .. }
        | HelperCall::RoundsReturnUnsold { .. }
        | HelperCall::RoundsSweepFees { .. }
        | HelperCall::TreasurySweepFees { .. }
        | HelperCall::TreasuryRelease { .. }
        | HelperCall::FinisherOpenPool { .. }
        | HelperCall::FinisherSettle { .. }
        | HelperCall::FinisherSweep { .. }
        | HelperCall::FinisherAbandon { .. }
        | HelperCall::HolderCollect { .. }
        | HelperCall::VesterClaim { .. }
        | HelperCall::EarlierDeliverMany { .. } => {}
    }
}

/// Calls the helper must never be able to send: a backer's held Shares, a
/// refund, a check-in, the runner's, the Pair's, the Launcher admin's and
/// founder's, a backer's ask, an earlier backer's consent and the keeper's,
/// and plain token moves.
pub(crate) const FORBIDDEN: &[&str] = &[
    "claimHeld(uint256,address)",
    "refund(uint256)",
    "checkIn()",
    "payTeam(address,uint256)",
    "spend(address,uint256)",
    "giveShares(address,uint256)",
    "handBack(uint256)",
    "takeSeat()",
    "propose(address,bytes)",
    "confirm(address,bytes,uint256)",
    "cancel(bytes32)",
    "openRound(bytes32,uint256)",
    "openAuction(bytes32,uint256)",
    "declareNoMarket(bytes32)",
    "windDown(bytes32)",
    "ask(uint256,uint256)",
    "lower(uint256,uint256)",
    "consent(uint256,address,uint256,bytes32,address,bytes32,uint256,bytes)",
    "voidConsent(uint256,address,bytes32)",
    "proposeHolder(uint256,address,bytes32)",
    "cancelHolder(uint256,uint256,bytes32)",
    "applyHolder(uint256)",
    "offerKeeper(address)",
    "takeKeeper()",
    "transfer(address,uint256)",
    "transferFrom(address,address,uint256)",
    "approve(address,uint256)",
];

pub(crate) fn selector_of(call: &HelperCall) -> [u8; 4] {
    let data = call.calldata();
    let mut s = [0u8; 4];
    s.copy_from_slice(&data[..4]);
    s
}

#[test]
fn the_calls_produce_exactly_the_allowed_selectors() {
    let calls = every_call();
    calls.iter().for_each(exhaustive);
    let produced: BTreeSet<[u8; 4]> = calls.iter().map(selector_of).collect();
    let allowed: BTreeSet<[u8; 4]> = ALLOWED.iter().map(|s| selector(s)).collect();
    assert_eq!(produced, allowed);
    // Each call's selector is its own signature's.
    for call in &calls {
        assert_eq!(
            selector_of(call),
            selector(call.signature()),
            "{}",
            call.name()
        );
    }
    let names: BTreeSet<&str> = calls.iter().map(HelperCall::name).collect();
    assert_eq!(names, NAMES.iter().copied().collect::<BTreeSet<_>>());
}

#[test]
fn no_call_moves_money_by_choice_or_signs_for_a_runner() {
    let produced: BTreeSet<[u8; 4]> = every_call().iter().map(selector_of).collect();
    for signature in FORBIDDEN {
        assert!(
            !produced.contains(&selector(signature)),
            "the helper can produce {signature}"
        );
        assert!(!ALLOWED.contains(signature), "{signature} is allowed");
    }
}

#[test]
fn stored_calls_read_back_and_unknown_ones_are_refused() {
    for call in every_call() {
        let back = HelperCall::parse(call.name(), call.target(), &call.args()).expect("parse");
        assert_eq!(back, call);
    }
    for (name, args) in [
        ("vester.claimHeld", json!({"round": 1, "backer": "0x00"})),
        ("rounds.refund", json!({"round": 1})),
        ("treasury.checkIn", json!({})),
        ("raw", json!({"data": "0x12345678"})),
    ] {
        let err = HelperCall::parse(name, R, &args).expect_err("unknown call");
        assert!(err.to_string().contains("unknown helper call"), "{err}");
    }
    assert!(HelperCall::parse("rounds.close", R, &json!({"round": "one"})).is_err());
    assert!(HelperCall::parse("vester.claim", V, &json!({"beneficiary": "0x12"})).is_err());
    assert!(HelperCall::parse("rounds.settleMany", R, &json!({"round": 1})).is_err());
}

#[test]
fn calldata_is_abi_encoded() {
    let settle = HelperCall::RoundsSettleMany {
        rounds: R,
        round: 1,
        backers: vec![ALICE, BOB],
    }
    .calldata();
    // selector, round, offset 0x40, length 2, two address words
    assert_eq!(settle.len(), 4 + 5 * 32);
    assert_eq!(&settle[..4], &selector("settleMany(uint256,address[])"));
    assert_eq!(settle[4 + 31], 1);
    assert_eq!(settle[4 + 32 + 31], 0x40);
    assert_eq!(settle[4 + 64 + 31], 2);
    assert_eq!(&settle[4 + 96 + 12..4 + 128], &ALICE);
    assert_eq!(&settle[4 + 128 + 12..], &BOB);

    let deliver = HelperCall::EarlierDeliverMany {
        claim: E,
        entries: vec![5],
    }
    .calldata();
    assert_eq!(deliver.len(), 4 + 3 * 32);
    assert_eq!(deliver[4 + 31], 0x20);
    assert_eq!(deliver[4 + 32 + 31], 1);
    assert_eq!(deliver[4 + 64 + 31], 5);

    let claim = HelperCall::VesterClaim {
        vester: V,
        beneficiary: BOB,
    }
    .calldata();
    assert_eq!(&claim[..4], &selector("claim(address)"));
    assert_eq!(&claim[4 + 12..], &BOB);
}
