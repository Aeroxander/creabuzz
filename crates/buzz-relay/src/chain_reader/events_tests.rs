//! Decoding tests. Topics are checked against the built artifacts in
//! `contracts/next/out`; the data below is real ABI encoding (`cast abi-encode`
//! of the event's non-indexed arguments, and logs captured from the anvil
//! real-server loop in `scripts/chain-loop-e2e.sh`).

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
        .expect("event in the catalog")
}

fn artifact_topics(contract: &str) -> Vec<(String, Word)> {
    fn canonical(input: &serde_json::Value) -> String {
        let ty = input["type"].as_str().unwrap_or_default();
        if ty == "tuple" {
            let inner: Vec<String> = input["components"]
                .as_array()
                .map(|c| c.iter().map(canonical).collect())
                .unwrap_or_default();
            format!("({})", inner.join(","))
        } else {
            ty.to_owned()
        }
    }
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(format!(
        "../../contracts/next/out/{contract}.sol/{contract}.json"
    ));
    let text = std::fs::read_to_string(&path).expect("built artifact");
    let json: serde_json::Value = serde_json::from_str(&text).expect("artifact json");
    json["abi"]
        .as_array()
        .expect("abi array")
        .iter()
        .filter(|item| item["type"] == "event")
        .map(|item| {
            let inputs: Vec<String> = item["inputs"]
                .as_array()
                .map(|i| i.iter().map(canonical).collect())
                .unwrap_or_default();
            let name = item["name"].as_str().unwrap_or_default().to_owned();
            let sig = format!("{name}({})", inputs.join(","));
            (name, keccak256(sig.as_bytes()))
        })
        .collect()
}

#[test]
fn the_catalog_matches_every_event_in_the_built_artifacts() {
    for (contract, role) in [
        ("Launcher", Role::Launcher),
        ("Rounds", Role::Rounds),
        ("Vester", Role::Vester),
        ("Treasury", Role::Treasury),
        ("Finisher", Role::Finisher),
        ("Pair", Role::Pair),
        ("ShareToken", Role::Shares),
    ] {
        let from_abi = artifact_topics(contract);
        for (name, topic) in &from_abi {
            if contract == "ShareToken" && name == "Approval" {
                continue; // allowances are not followed
            }
            let found = lookup(role, topic)
                .unwrap_or_else(|| panic!("{contract}.{name} is missing from the catalog"));
            assert_eq!(found.name, name.as_str());
        }
        for e in EVENTS.iter().filter(|e| e.role == role) {
            assert!(
                from_abi.iter().any(|(_, t)| *t == e.topic()),
                "{contract}.{} is not in the artifact (signature {})",
                e.name,
                e.signature()
            );
        }
    }
}

#[test]
fn topics_match_the_milestone_4_report() {
    let pinned = [
        (
            Role::Launcher,
            "RoundOpened",
            "0x06c75cbb2343c6c16b7dc4c07a0455c44baf40b91d81ae686bba265b237f2e44",
        ),
        (
            Role::Rounds,
            "RoundOpened",
            "0xeae4e388ff074a9a2b7c4b70ca3e14eea20bee144bfa34d3dfa79d5e0c9dc4a3",
        ),
        (
            Role::Launcher,
            "ProjectZeroNamed",
            "0x311fe7bf90a7bdeeb731fc3a6c2e1bfe77e45bd6018aac40d99db75229bf518c",
        ),
        (
            Role::Launcher,
            "ProjectLaunched",
            "0x193aa748f4b276a52da5e05f61ab6164894f41ddc2812dae87c59ca51436af9f",
        ),
        (
            Role::Rounds,
            "RoundClosed",
            "0xc0ad2a7160bc4519bfbe8233e3a9702a38f4d9fa32c47b78f1b0804f3b2d37f0",
        ),
        (
            Role::Rounds,
            "Settled",
            "0x39cc6e14628866c006b05882e332d29f2ee2215eaef437f5d037c9802f653307",
        ),
        (
            Role::Treasury,
            "Settled",
            "0x321f57f44af402708b8b3bad0bd10012cd568d8696946e26edeb86178bb7c27e",
        ),
        (
            Role::Finisher,
            "Settled",
            "0x6f072ff41a58c73c1f7253e82b3e50e1083b438aa76a962283c334bb6797d355",
        ),
        (
            Role::Finisher,
            "PoolOpened",
            "0xe9a25c34ac86fe4aec126181a0b2b256fcd8352220ea38e3a093742008d64076",
        ),
        (
            Role::Treasury,
            "PoolOpened",
            "0xdf5eab7aafa65f032281e56b9400db3c1d50c6a02c1c56cf936eb79e5748a9ab",
        ),
        (
            Role::Vester,
            "HeldClaimed",
            "0xbd517028d6379e5cdba42e5cb022d857d3c768b14b8717f94222ce09557fa1af",
        ),
    ];
    for (role, name, topic) in pinned {
        assert_eq!(hex0x(&def(role, name).topic()), topic, "{name}");
    }
}

#[test]
fn shared_topics_decode_by_the_emitting_role() {
    // FeesSwept and WoundDown have one topic in Rounds and Treasury; the role
    // decides which event it is, and an unknown pair is not decoded at all.
    let fees = def(Role::Rounds, "FeesSwept").topic();
    assert_eq!(fees, def(Role::Treasury, "FeesSwept").topic());
    assert_eq!(
        lookup(Role::Treasury, &fees).map(|e| e.role),
        Some(Role::Treasury)
    );
    assert!(lookup(Role::Vester, &fees).is_none());
    let rounds_opened = def(Role::Rounds, "RoundOpened").topic();
    assert!(lookup(Role::Launcher, &rounds_opened).is_none());
}

#[test]
fn rounds_settled_decodes_every_field() {
    // Settled(round 1, bob, accepted 100e6, returned 0, shares 3e23, 3e6, 15e6, 82e6)
    let e = def(Role::Rounds, "Settled");
    let bob = "0x00000000000000000000000000000000000000b0";
    let topics = [e.topic(), word_u(1), word_addr(bob)];
    let mut data = Vec::new();
    for v in [
        100_000_000u128,
        0,
        300_000_000_000_000_000_000_000,
        3_000_000,
        15_000_000,
        82_000_000,
    ] {
        data.extend_from_slice(&word_u(v));
    }
    let v = decode(e, &topics, &data).expect("decodes");
    assert_eq!(v["round"], "1");
    assert_eq!(v["backer"], bob);
    assert_eq!(v["accepted"], "100000000");
    assert_eq!(v["shares"], "300000000000000000000000");
    assert_eq!(v["held"], "82000000");
    // One topic short, or a word short, is refused rather than guessed.
    assert_eq!(decode(e, &topics[..2], &data), Err(DecodeError::Topics));
    assert_eq!(
        decode(e, &topics, &data[..data.len() - 1]),
        Err(DecodeError::Data)
    );
}

#[test]
fn refunded_decodes_the_worked_day_45_refund() {
    let e = def(Role::Rounds, "Refunded");
    let data = parse_bytes(
        "0x0000000000000000000000000000000000000000000000000000000003adda5a\
         00000000000000000000000000000000000000000000000000000000037ec2a2\
         000000000000000000000000000000000000000000000000000000000025ac93\
         0000000000000000000000000000000000000000000000000000000000096b25\
         000000000000000000000000000000000000000000003f870857a3e0e3800000",
    );
    let topics = [
        e.topic(),
        word_u(1),
        word_addr("0x00000000000000000000000000000000000000b0"),
    ];
    let v = decode(e, &topics, &data).expect("decodes");
    assert_eq!(v["unreleased"], "61725274");
    assert_eq!(v["paid"], "58639010");
    assert_eq!(v["shares"], "300000000000000000000000");
}

fn parse_bytes(text: &str) -> Vec<u8> {
    crate::chain_reader::word::parse_bytes(text).expect("hex")
}

#[test]
fn finisher_pool_opened_keeps_a_price_wider_than_u128() {
    let e = def(Role::Finisher, "PoolOpened");
    let data = parse_bytes(
        "0x1111111111111111111111111111111111111111111111111111111111111111\
         000000000000000000000000ffffffffffffffffffffffffffffffffffffffff\
         000000000000000000000000000000000000000000000000000000051f4d5c00\
         0000000000000000000000000000000000000000002d7eb3f96e070d97000000",
    );
    let topics = [
        e.topic(),
        word_addr("0x00000000000000000000000000000000000000ac"),
    ];
    let v = decode(e, &topics, &data).expect("decodes");
    assert_eq!(
        v["sqrtPriceX96"],
        "1461501637330902918203684832716283019655932542975"
    );
    assert_eq!(v["poolDollars"], "22000000000");
    assert_eq!(v["poolShares"], "55000000000000000000000000");
    assert_eq!(
        v["poolId"],
        "0x1111111111111111111111111111111111111111111111111111111111111111"
    );
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

#[test]
fn project_launched_decodes_its_three_structs() {
    let e = def(Role::Launcher, "ProjectLaunched");
    let founder = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
    let mut data = Vec::new();
    // project: founder, shares, treasury, vester, finisher, rounds, launchedAt
    data.extend_from_slice(&word_addr(founder));
    for a in ["01", "02", "03", "04", "05"] {
        data.extend_from_slice(&word_addr(&format!(
            "0x00000000000000000000000000000000000000{a}"
        )));
    }
    data.extend_from_slice(&word_u(1_700_000_000));
    // allocation
    for v in [250u128, 100, 200, 200, 100, 150] {
        data.extend_from_slice(&word_u(v * 1_000_000 * 1_000_000_000_000_000_000));
    }
    // settings: quote, platform, stake 0 (project zero), 500, 300, 15, 60, agentUsd, agentShares
    data.extend_from_slice(&word_addr("0x00000000000000000000000000000000000000d0"));
    data.extend_from_slice(&word_addr("0x00000000000000000000000000000000000000e0"));
    data.extend_from_slice(&[0u8; 32]);
    for v in [500u128, 300, 15, 60, 25_000_000, 1_000_000] {
        data.extend_from_slice(&word_u(v));
    }
    assert_eq!(data.len(), 22 * 32);
    let topics = [
        e.topic(),
        w(&format!("0x{}", "ab".repeat(32))),
        w(&format!("0x{}", "cd".repeat(32))),
        word_addr(founder),
    ];
    let v = decode(e, &topics, &data).expect("decodes");
    assert_eq!(v["founder"], founder);
    assert_eq!(
        v["project"]["rounds"],
        "0x0000000000000000000000000000000000000005"
    );
    assert_eq!(v["project"]["launchedAt"], "1700000000");
    assert_eq!(v["allocation"]["backing"], "150000000000000000000000000");
    assert_eq!(
        v["settings"]["stake"],
        "0x0000000000000000000000000000000000000000"
    );
    assert_eq!(v["settings"]["floorParts"], "60");
}

/// Logs exactly as anvil returned them in `scripts/chain-loop-e2e.sh` (the
/// contracts deployed from `contracts/next/out`), decoded by role and topic.
#[test]
fn logs_captured_from_the_anvil_loop_decode_to_the_round_s_numbers() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("src/chain_reader/testdata/anvil_logs.json");
    let logs: Vec<serde_json::Value> =
        serde_json::from_str(&std::fs::read_to_string(path).expect("fixture")).expect("json");
    let mut seen = Vec::new();
    for log in &logs {
        let role = Role::parse(log["role"].as_str().expect("role")).expect("known role");
        let topics: Vec<Word> = log["topics"]
            .as_array()
            .expect("topics")
            .iter()
            .map(|t| w(t.as_str().expect("topic")))
            .collect();
        let data = parse_bytes(log["data"].as_str().expect("data"));
        let event = lookup(role, &topics[0]).expect("a followed event");
        assert_eq!(event.name, log["event"].as_str().expect("event"));
        let v = decode(event, &topics, &data).expect("decodes");
        match (role, event.name) {
            (Role::Launcher, "ProjectLaunched") => {
                assert_eq!(v["allocation"]["backing"], "150000000000000000000000000");
                assert_eq!(
                    v["settings"]["stake"],
                    "0x000000000000000000000000000000000000057a"
                );
                assert_eq!(v["settings"]["exitFeeBps"], "500");
                assert_eq!(v["founder"], v["project"]["founder"]);
            }
            (Role::Launcher, "RoundOpened") => {
                assert_eq!(v["cap"], "10000000000");
                assert_eq!(v["size"], "10000000000");
                assert_eq!(v["sharesPerRawDollar"], "3000000000000000");
            }
            (Role::Rounds, "RoundClosed") => {
                assert_eq!(v["asked"], "2500000000");
                assert_eq!(v["accepted"], "2500000000");
            }
            (Role::Rounds, "Settled") => {
                let acc: u128 = v["accepted"]
                    .as_str()
                    .and_then(|s| s.parse().ok())
                    .expect("accepted");
                assert_eq!(v["held"], (acc * 8200 / 10_000).to_string());
                assert_eq!(v["shares"], (acc * 3_000_000_000_000_000).to_string());
            }
            (Role::Vester, "Granted") => assert_eq!(v["amount"], "200000000000000000000000000"),
            _ => {}
        }
        seen.push(event.name);
    }
    for name in [
        "ProjectLaunched",
        "RoundOpened",
        "RoundClosed",
        "Settled",
        "HeldGranted",
        "CheckedIn",
    ] {
        assert!(seen.contains(&name), "fixture lacks {name}");
    }
}
