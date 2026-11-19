//! The helper's call list is closed: what it can produce is exactly the
//! allow-list, and none of the calls that move a person's money by choice or
//! that a runner, a Pair or the Launcher's admin signs, and never a check-in,
//! a take-out, a refund, a draw or a claim for anyone.

use std::collections::BTreeSet;

use buzz_evm_allowance::abi::selector;
use serde_json::json;

use super::*;

const T: [u8; 20] = [0x22; 20];

/// One of every call. The match in `exhaustive` has no wildcard, so a new
/// variant does not compile until it is listed here too.
pub(crate) fn every_call() -> Vec<HelperCall> {
    vec![
        HelperCall::TreasuryCollectFees { treasury: T },
        HelperCall::TreasurySettle { treasury: T },
    ]
}

fn exhaustive(call: &HelperCall) {
    match call {
        HelperCall::TreasuryCollectFees { .. } | HelperCall::TreasurySettle { .. } => {}
    }
}

/// Calls the helper must never be able to send: the check-in (the runner's
/// sign of life), a take-out, a refund, a draw from the allowance, a claim of
/// Team Shares for a member, joining, granting, forfeits, the rate, the door,
/// the seat, a wind-down, the agents, a Pair's calls, the Launcher admin's,
/// and plain token moves. Each of these is a call of contracts/pot.
pub(crate) const FORBIDDEN: &[&str] = &[
    "checkIn(bytes32)",
    "leave(uint256,uint256,address)",
    "leaveTeam(uint256,uint256,address)",
    "join(uint256,uint256,address)",
    "draw(address,uint256)",
    "claim(uint256)",
    "grantTeam(address,uint256)",
    "announceForfeit(uint256)",
    "execute(uint256)",
    "burnAfterWindDown(uint256)",
    "burnUngrantedAfterWindDown()",
    "proposeRate(uint32)",
    "applyRate()",
    "setRate(uint32)",
    "setDoor(bool)",
    "setAgent(address,uint128,uint128)",
    "authoriseAgent(address)",
    "revokeAgent(address)",
    "handOver(address,bool)",
    "takeSeat()",
    "windDown()",
    "windDown(bytes32)",
    "markWoundDown()",
    "addRevenue(uint256)",
    "makePair(bytes32,address)",
    "propose(address,bytes)",
    "confirm(address,bytes,uint256)",
    "cancel(bytes32)",
    "setSettings((address,address,uint16,uint32,uint128))",
    "transferAdmin(address)",
    "acceptAdmin()",
    "transfer(address,uint256)",
    "transferFrom(address,address,uint256)",
    "approve(address,uint256)",
    "transferAndCall(address,uint256,bytes)",
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
    // Each call's selector is its own signature's, and takes no arguments.
    for call in &calls {
        assert_eq!(
            selector_of(call),
            selector(call.signature()),
            "{}",
            call.name()
        );
        assert_eq!(
            call.calldata().len(),
            4,
            "{} takes no arguments",
            call.name()
        );
    }
    let names: BTreeSet<&str> = calls.iter().map(HelperCall::name).collect();
    assert_eq!(names, NAMES.iter().copied().collect::<BTreeSet<_>>());
}

/// Removing the rule must fail a test: this walks the whole forbidden list
/// against what the helper can produce AND against its allow-list, so adding
/// any of these calls to either fails here.
#[test]
fn no_call_moves_money_by_choice_checks_in_or_signs_for_a_runner() {
    let produced: BTreeSet<[u8; 4]> = every_call().iter().map(selector_of).collect();
    for signature in FORBIDDEN {
        assert!(
            !produced.contains(&selector(signature)),
            "the helper can produce {signature}"
        );
        assert!(!ALLOWED.contains(signature), "{signature} is allowed");
    }
    // The two it may send are the only two, and they are the ones nobody's money waits on.
    assert_eq!(ALLOWED, ["collectFees()", "settle()"]);
}

/// The forbidden list names real functions of contracts/pot (an entry that is
/// no function would protect nothing): each one is in the compiled ABIs.
#[test]
fn every_forbidden_call_is_a_real_function_of_the_contracts() {
    let events = include_str!("../testdata/pot-events.json");
    // The events file is the ABI listing's sibling; the functions are read from
    // the contracts' own build output when it is present (a fresh clone has none).
    let _ = events;
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../contracts/pot/out");
    if !root.exists() {
        return;
    }
    let mut functions = BTreeSet::new();
    for contract in [
        "Treasury",
        "Vester",
        "Launcher",
        "Pair",
        "ShareToken",
        "PlayDollar",
    ] {
        let path = root.join(format!("{contract}.sol/{contract}.json"));
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let json: serde_json::Value = serde_json::from_str(&text).expect("an ABI file");
        for item in json["abi"].as_array().into_iter().flatten() {
            if item["type"] != "function" {
                continue;
            }
            fn ty(p: &serde_json::Value) -> String {
                let t = p["type"].as_str().unwrap_or_default();
                match t.strip_prefix("tuple") {
                    Some(rest) => format!(
                        "({}){rest}",
                        p["components"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .map(ty)
                            .collect::<Vec<_>>()
                            .join(",")
                    ),
                    None => t.to_owned(),
                }
            }
            let inputs: Vec<String> = item["inputs"]
                .as_array()
                .into_iter()
                .flatten()
                .map(ty)
                .collect();
            functions.insert(format!(
                "{}({})",
                item["name"].as_str().unwrap_or_default(),
                inputs.join(",")
            ));
        }
    }
    if functions.is_empty() {
        return;
    }
    for signature in FORBIDDEN {
        assert!(
            functions.contains(*signature),
            "{signature} is not a function of the contracts"
        );
    }
    for signature in ALLOWED {
        assert!(
            functions.contains(signature),
            "{signature} is not a function of the contracts"
        );
    }
}

#[test]
fn stored_calls_read_back_and_unknown_ones_are_refused() {
    for call in every_call() {
        let back = HelperCall::parse(call.name(), call.target(), &call.args()).expect("parse");
        assert_eq!(back, call);
    }
    // Every call of the old contracts, and every call this helper must never send, is refused.
    for (name, args) in [
        ("rounds.close", json!({"round": 1})),
        ("finisher.openPool", json!({})),
        ("vester.claim", json!({"beneficiary": "0x00"})),
        ("treasury.checkIn", json!({})),
        ("treasury.draw", json!({})),
        ("treasury.leave", json!({})),
        ("raw", json!({"data": "0x12345678"})),
    ] {
        let err = HelperCall::parse(name, T, &args).expect_err("unknown call");
        assert!(err.to_string().contains("unknown helper call"), "{err}");
    }
}
