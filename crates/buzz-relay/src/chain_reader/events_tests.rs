//! Decoding tests. The table of events is generated from the contracts/pot
//! build; `testdata/pot-events.json` holds what that build reported (names,
//! parameters and the topics forge itself computed), so these tests need no
//! local forge build. Real logs from a run of the contracts are decoded in
//! `ledger_tests.rs`.

use super::*;
use crate::chain_reader::word::parse_fixed;

fn w(hex_text: &str) -> Word {
    parse_fixed::<32>(hex_text).expect("32-byte hex")
}

fn word_u(value: u128) -> Word {
    let mut out = [0u8; 32];
    out[16..].copy_from_slice(&value.to_be_bytes());
    out
}

fn word_addr(addr_hex: &str) -> Word {
    let a = parse_fixed::<20>(addr_hex).expect("address");
    let mut out = [0u8; 32];
    out[12..].copy_from_slice(&a);
    out
}

fn def(role: Role, name: &str) -> &'static EventDef {
    EVENTS
        .iter()
        .find(|e| e.role == role && e.name == name)
        .expect("event in the table")
}

/// The contracts' events as recorded from the contracts/pot build by
/// `node scripts/chain-reader-events.mjs` (its `--check` compares the file with
/// a fresh build).
const RECORDED: &str = include_str!("testdata/pot-events.json");

fn role_of(name: &str) -> Role {
    Role::parse(&name.to_lowercase()).expect("a role name")
}

/// One recorded parameter against the table's, recursively: name, indexed
/// flag and canonical type.
fn same_param(recorded: &serde_json::Value, ours: &Param) {
    let name = recorded["name"].as_str().expect("name");
    assert_eq!(ours.name, name);
    assert_eq!(
        ours.indexed,
        recorded["indexed"].as_bool().unwrap_or(false),
        "{name}: indexed"
    );
    let mut ty = String::new();
    type_name(&ours.ty, &mut ty);
    assert_eq!(ty, recorded["type"].as_str().expect("type"), "{name}: type");
    if let (Ty::Tuple(fields), Some(components)) = (&ours.ty, recorded["components"].as_array()) {
        assert_eq!(fields.len(), components.len(), "{name}: fields");
        for (c, f) in components.iter().zip(fields.iter()) {
            same_param(c, f);
        }
    }
}

/// The table is the forge build: every recorded event is in the table under
/// each role of its contract with the same parameters, its topic (recomputed
/// here from the signature) is the one forge reported, and the table holds
/// nothing the build does not.
#[test]
fn the_table_is_the_forge_build() {
    let recorded: serde_json::Value = serde_json::from_str(RECORDED).expect("recorded events");
    let mut count = 0;
    for (contract, entry) in recorded["contracts"].as_object().expect("contracts") {
        for role_name in entry["roles"].as_array().expect("roles") {
            let role = role_of(role_name.as_str().expect("role"));
            let events = entry["events"].as_array().expect("events");
            for e in events {
                let name = e["name"].as_str().expect("name");
                let topic = w(e["topic"].as_str().expect("topic"));
                let found = lookup(role, &topic)
                    .unwrap_or_else(|| panic!("{contract}.{name} is missing from the table"));
                assert_eq!(found.name, name);
                assert_eq!(
                    found.signature(),
                    e["signature"].as_str().expect("signature")
                );
                assert_eq!(found.topic(), topic, "{contract}.{name}: topic");
                let inputs = e["inputs"].as_array().expect("inputs");
                assert_eq!(
                    found.params.len(),
                    inputs.len(),
                    "{contract}.{name}: parameters"
                );
                for (input, ours) in inputs.iter().zip(found.params.iter()) {
                    same_param(input, ours);
                }
                count += 1;
            }
            let names: Vec<&str> = events
                .iter()
                .map(|e| e["name"].as_str().expect("name"))
                .collect();
            for ours in EVENTS.iter().filter(|e| e.role == role) {
                assert!(
                    names.contains(&ours.name),
                    "{contract}.{} is in the table but not in the build",
                    ours.name
                );
            }
        }
    }
    assert_eq!(count, EVENTS.len(), "every table entry was checked once");
    assert_eq!(count, 42, "the build names 42 (role, event) pairs");
}

/// A few topics pinned from forge's own output (`forge inspect <contract>
/// events`), so a change in how the signature is built cannot move every
/// topic and the recorded file together unseen.
#[test]
fn topics_are_pinned_from_forge() {
    let pinned = [
        (
            Role::Treasury,
            "Joined",
            "0xa6151d7755e344f44b5b40269d1766228a3923bda179c6728f25b759d5c07389",
        ),
        (
            Role::Treasury,
            "Left",
            "0x538a058604cf1e13ee31eb7b67028132b218cc709262d8802fb72c1e3e97723c",
        ),
        (
            Role::Treasury,
            "CheckedIn",
            "0xf1e30dce1d1c086ac415fc8c8307356d2352cecbf408b81b332c3980eb5a7cea",
        ),
        (
            Role::Launcher,
            "ProjectLaunched",
            "0xe97a1fa0f012be422e8933585be37d533a884869e3fda6cc204c3a616d15ca4f",
        ),
        (
            Role::Launcher,
            "PairMade",
            "0xf4054ab4627b2a70f20619d603381659a88dd1b5164a61d82e14a70b8ad22f78",
        ),
    ];
    for (role, name, topic) in pinned {
        assert_eq!(hex0x(&def(role, name).topic()), topic, "{name}");
    }
}

/// The Launcher and the Treasury each emit a `WoundDown`, with different
/// fields; the two Share tokens are one code and share one `Transfer` topic.
/// The role decides which event a log is, and an unknown pair is not decoded
/// at all.
#[test]
fn shared_names_and_topics_decode_by_the_emitting_role() {
    let launcher = def(Role::Launcher, "WoundDown");
    let treasury = def(Role::Treasury, "WoundDown");
    assert_ne!(launcher.topic(), treasury.topic());
    assert!(lookup(Role::Launcher, &treasury.topic()).is_none());
    assert!(lookup(Role::Vester, &treasury.topic()).is_none());
    let shares = def(Role::Shares, "Transfer");
    let team = def(Role::Team, "Transfer");
    assert_eq!(shares.topic(), team.topic());
    assert_eq!(
        lookup(Role::Team, &shares.topic()).map(|e| e.role),
        Some(Role::Team)
    );
    // The dollar's own Transfer is the same topic again, and not a project role.
    assert_eq!(def(Role::Dollar, "Transfer").topic(), shares.topic());
    // Allowances are not read.
    assert!(EVENTS.iter().all(
        |e| !(matches!(e.role, Role::Shares | Role::Team | Role::Dollar) && e.name == "Approval")
    ));
}

#[test]
fn joined_decodes_every_field() {
    // Joined(who, to, paid 100e6, fee 2e6, shares 98e18, credit 98e6, pot 98e6, paidIn 98e6, shares 98e18)
    let e = def(Role::Treasury, "Joined");
    let who = "0x00000000000000000000000000000000000000b0";
    let to = "0x00000000000000000000000000000000000000b1";
    let topics = [e.topic(), word_addr(who), word_addr(to)];
    let mut data = Vec::new();
    for v in [
        100_000_000u128,
        2_000_000,
        98_000_000_000_000_000_000,
        98_000_000,
        98_000_000,
        98_000_000,
        98_000_000_000_000_000_000,
    ] {
        data.extend_from_slice(&word_u(v));
    }
    let v = decode(e, &topics, &data).expect("decodes");
    assert_eq!(v["who"], who);
    assert_eq!(v["to"], to);
    assert_eq!(v["paid"], "100000000");
    assert_eq!(v["fee"], "2000000");
    assert_eq!(v["potAfter"], "98000000");
    assert_eq!(v["sharesAfter"], "98000000000000000000");
    // One topic short, or a word short, is refused rather than guessed.
    assert_eq!(decode(e, &topics[..2], &data), Err(DecodeError::Topics));
    assert_eq!(
        decode(e, &topics, &data[..data.len() - 1]),
        Err(DecodeError::Data)
    );
}

/// The Treasury's `WoundDown` has a non-indexed field before its indexed
/// one: the order of the parameters is not the order of the topics.
#[test]
fn a_wind_down_decodes_its_data_around_its_indexed_field() {
    let e = def(Role::Treasury, "WoundDown");
    let by = "0x00000000000000000000000000000000000000f1";
    let mut data = Vec::new();
    for v in [1u128, 1_795_000_000, 735_000] {
        data.extend_from_slice(&word_u(v));
    }
    let v = decode(e, &[e.topic(), word_addr(by)], &data).expect("decodes");
    assert_eq!(v["kind"], "1");
    assert_eq!(v["by"], by);
    assert_eq!(v["time"], "1795000000");
    assert_eq!(v["boxReturned"], "735000");
}

#[test]
fn project_launched_decodes_its_three_structs() {
    let e = def(Role::Launcher, "ProjectLaunched");
    let founder = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
    let mut data = Vec::new();
    // project: founder, shares, team, treasury, vester, launchedAt
    data.extend_from_slice(&word_addr(founder));
    for a in ["01", "02", "03", "04"] {
        data.extend_from_slice(&word_addr(&format!(
            "0x00000000000000000000000000000000000000{a}"
        )));
    }
    data.extend_from_slice(&word_u(1_700_000_000));
    // terms: ratePpm, teamPool
    data.extend_from_slice(&word_u(1000));
    data.extend_from_slice(&word_u(10_000_000 * 1_000_000_000_000_000_000));
    // platform: quote, platform, feeBps, unit, agentUsd
    data.extend_from_slice(&word_addr("0x00000000000000000000000000000000000000d0"));
    data.extend_from_slice(&word_addr("0x00000000000000000000000000000000000000e0"));
    for v in [200u128, 604_800, 25_000_000] {
        data.extend_from_slice(&word_u(v));
    }
    assert_eq!(data.len(), 13 * 32);
    let topics = [
        e.topic(),
        w(&format!("0x{}", "ab".repeat(32))),
        w(&format!("0x{}", "cd".repeat(32))),
        word_addr(founder),
    ];
    let v = decode(e, &topics, &data).expect("decodes");
    assert_eq!(v["founder"], founder);
    assert_eq!(
        v["project"]["team"],
        "0x0000000000000000000000000000000000000002"
    );
    assert_eq!(
        v["project"]["vester"],
        "0x0000000000000000000000000000000000000004"
    );
    assert_eq!(v["project"]["launchedAt"], "1700000000");
    assert_eq!(v["terms"]["ratePpm"], "1000");
    assert_eq!(v["terms"]["teamPool"], "10000000000000000000000000");
    assert_eq!(v["platform"]["feeBps"], "200");
    assert_eq!(v["platform"]["unit"], "604800");
}

#[test]
fn pair_proposed_decodes_its_dynamic_bytes() {
    let e = def(Role::Pair, "Proposed");
    let data = parse_bytes(
        "0x00000000000000000000000000000000000000000000000000000000000000aa\
         0000000000000000000000000000000000000000000000000000000000000060\
         0000000000000000000000000000000000000000000000000000000000000007\
         0000000000000000000000000000000000000000000000000000000000000006\
         6cd5141d01020000000000000000000000000000000000000000000000000000",
    );
    let topics = [
        e.topic(),
        word_u(9),
        word_addr("0x00000000000000000000000000000000000000a1"),
    ];
    let v = decode(e, &topics, &data).expect("decodes");
    assert_eq!(v["target"], "0x00000000000000000000000000000000000000aa");
    assert_eq!(v["data"], "0x6cd5141d0102");
    assert_eq!(v["nonce"], "7");
    // A bytes offset that points past the data is refused.
    let mut bad = data.clone();
    bad[63] = 0xa0;
    assert_eq!(decode(e, &topics, &bad), Err(DecodeError::Data));
}

fn parse_bytes(text: &str) -> Vec<u8> {
    crate::chain_reader::word::parse_bytes(text).expect("hex")
}
