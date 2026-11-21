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
        HelperCall::TreasurySettleTasks {
            treasury: T,
            expiry: 1_800_000_000,
        },
        HelperCall::TreasuryApplyRate { treasury: T },
        HelperCall::VesterExecute {
            vester: T,
            grant: 3,
        },
        HelperCall::VesterBurnAfterWindDown {
            vester: T,
            grant: 7,
        },
    ]
}

fn exhaustive(call: &HelperCall) {
    match call {
        HelperCall::TreasuryCollectFees { .. }
        | HelperCall::TreasurySettle { .. }
        | HelperCall::TreasurySettleTasks { .. }
        | HelperCall::TreasuryApplyRate { .. }
        | HelperCall::VesterExecute { .. }
        | HelperCall::VesterBurnAfterWindDown { .. } => {}
    }
}

/// Calls the helper must never be able to send: the check-in (the runner's
/// sign of life), a take-out, a refund, a draw from the allowance, a claim of
/// Team Shares for a member, joining, granting, announcing a forfeit, proposing
/// or lowering the rate, the door, the seat, a wind-down, the burn of Team
/// Shares nobody was granted, the agents, a Pair's calls, the Launcher admin's,
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
    "burnUngrantedAfterWindDown()",
    "proposeRate(uint32)",
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
    // The task book's seven calls (step 2): a task that ran out is returned by
    // a plain `settle()`, never by one of these.
    "announceTask(bytes32,address,uint256,uint16)",
    "takeTask(uint64,uint256)",
    "acceptTask(uint64,uint256)",
    "rejectTask(uint64)",
    "cancelTask(uint64)",
    "returnTask(uint64)",
    "claimNote(uint64,address)",
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
    // Each call's selector is its own signature's; the Vester's two take one
    // number (the grant), the other three none.
    for call in &calls {
        assert_eq!(
            selector_of(call),
            selector(call.signature()),
            "{}",
            call.name()
        );
        let takes_grant = call.signature().ends_with("(uint256)");
        assert_eq!(
            call.calldata().len(),
            if takes_grant { 36 } else { 4 },
            "{}",
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
    // These five are the only ones, and they are the ones nobody's money waits on.
    assert_eq!(
        ALLOWED,
        [
            "collectFees()",
            "settle()",
            "applyRate()",
            "execute(uint256)",
            "burnAfterWindDown(uint256)"
        ]
    );
    // Ending a project is a person's press, also once the quiet time has passed.
    assert!(FORBIDDEN.contains(&"windDown()"));
    assert!(FORBIDDEN.contains(&"burnUngrantedAfterWindDown()"));
}

/// The grant's id is one 32-byte number after the selector, and a stored job
/// reads back to the same call; a stored job without a number ends instead of
/// sending a call on grant zero.
#[test]
fn the_two_vester_calls_carry_the_grant_as_one_number_and_read_back() {
    let call = HelperCall::VesterExecute {
        vester: T,
        grant: 0x0102,
    };
    let data = call.calldata();
    assert_eq!(&data[..4], selector("execute(uint256)").as_slice());
    assert_eq!(data[4..34], [0u8; 30]);
    assert_eq!((data[34], data[35]), (0x01, 0x02));
    assert_eq!(call.args(), json!({ "grant": 258u64 }));
    for bad in [json!({}), json!({"grant": "3"}), json!({"grant": -1})] {
        for name in ["vester.execute", "vester.burnAfterWindDown"] {
            assert!(HelperCall::parse(name, T, &bad).is_err(), "{name} {bad}");
        }
    }
    assert_eq!(
        HelperCall::parse("vester.burnAfterWindDown", T, &json!({"grant": 7})).expect("reads"),
        HelperCall::VesterBurnAfterWindDown {
            vester: T,
            grant: 7
        }
    );
}

/// The three optional calls are the ones held to the tighter rule, and only
/// those: the limit on failed attempts cannot be raised above it by a setting.
#[test]
fn the_optional_calls_have_the_tighter_attempt_limit() {
    for call in every_call() {
        let optional = matches!(
            call,
            HelperCall::TreasuryApplyRate { .. }
                | HelperCall::VesterExecute { .. }
                | HelperCall::VesterBurnAfterWindDown { .. }
        );
        assert_eq!(is_optional(call.name()), optional, "{}", call.name());
        assert_eq!(
            max_attempts_for(call.name(), 8),
            if optional { MAX_OPTIONAL_ATTEMPTS } else { 8 },
            "{}",
            call.name()
        );
    }
    // A setting below the limit is kept.
    assert_eq!(max_attempts_for("vester.execute", 2), 2);
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

/// The settle for a task that ran out is the same `settle()` under the same
/// stored name (the database's list is closed); only its stored arguments tell
/// it from the settle of arrived outside money, and a stored argument that is
/// not a second ends the job instead of sending something else.
#[test]
fn the_settle_of_a_task_is_settle_and_nothing_else() {
    let call = HelperCall::TreasurySettleTasks {
        treasury: T,
        expiry: 1_804_807_401,
    };
    assert_eq!(call.name(), "treasury.settle");
    assert_eq!(call.signature(), "settle()");
    assert_eq!(call.calldata(), selector("settle()").to_vec());
    assert_eq!(call.target(), T);
    assert_eq!(call.args(), json!({ "taskExpiry": 1_804_807_401u64 }));
    assert_eq!(
        HelperCall::parse("treasury.settle", T, &call.args()).expect("reads back"),
        call
    );
    // Without the argument it is the other settle.
    assert_eq!(
        HelperCall::parse("treasury.settle", T, &json!({})).expect("reads back"),
        HelperCall::TreasurySettle { treasury: T }
    );
    for bad in [json!("soon"), json!(-1), json!(1.5), json!(null)] {
        let err = HelperCall::parse("treasury.settle", T, &json!({ "taskExpiry": bad }))
            .expect_err("a stored expiry that is not a second");
        assert!(err.to_string().contains("not a second"), "{err}");
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
        ("treasury.windDown", json!({})),
        ("raw", json!({"data": "0x12345678"})),
    ] {
        let err = HelperCall::parse(name, T, &args).expect_err("unknown call");
        assert!(err.to_string().contains("unknown helper call"), "{err}");
    }
}
