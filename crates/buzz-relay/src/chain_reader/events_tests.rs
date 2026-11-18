//! Decoding tests. Topics are checked against the events recorded from the
//! `contracts/next` build (`testdata/next-events.json`); the data below is real ABI encoding (`cast abi-encode`
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

/// The contracts' events as recorded from the contracts/next build by
/// `node scripts/chain-reader-events.mjs` (its `--check` compares the file with
/// a fresh build), so this test needs no local forge build.
const RECORDED: &str = include_str!("testdata/next-events.json");

#[test]
fn the_catalog_matches_every_recorded_event() {
    let recorded: serde_json::Value = serde_json::from_str(RECORDED).expect("recorded events");
    for (contract, role) in [
        ("Launcher", Role::Launcher),
        ("Rounds", Role::Rounds),
        ("Vester", Role::Vester),
        ("Treasury", Role::Treasury),
        ("Finisher", Role::Finisher),
        ("Pair", Role::Pair),
        ("ShareToken", Role::Shares),
        ("EarlierBackers", Role::Earlier),
        ("ContinuousClearingAuction", Role::Auction),
        ("LiquidityHolder", Role::Holder),
        ("PoolManager", Role::PoolManager),
    ] {
        let signatures: Vec<&str> = recorded[contract]
            .as_array()
            .unwrap_or_else(|| panic!("{contract} is not recorded"))
            .iter()
            .map(|s| s.as_str().expect("a signature"))
            .collect();
        for sig in &signatures {
            let name = sig.split('(').next().unwrap_or_default();
            let found = lookup(role, &keccak256(sig.as_bytes()))
                .unwrap_or_else(|| panic!("{contract}.{sig} is missing from the catalog"));
            assert_eq!(found.name, name);
        }
        for e in EVENTS.iter().filter(|e| e.role == role) {
            assert!(
                signatures.contains(&e.signature().as_str()),
                "{contract}.{} is not recorded (signature {})",
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

/// Project zero's earlier backers and team budget (contracts commit fb0f84d75);
/// data from `cast abi-encode`, topics from `cast sig-event`.
#[test]
fn project_zero_split_and_team_pay_decode() {
    let key = word_u(0x5a);
    let claim = word_addr("0x00000000000000000000000000000000000000c1");
    let split = def(Role::Launcher, "ProjectZeroSplit");
    assert_eq!(
        split.topic(),
        w("0x830e4e799b68e9b2f364f19dff8e7afff7779b6e99eb8ceba2db7186d98375b6")
    );
    let v = decode(
        split,
        &[split.topic(), key, claim],
        &parse_bytes(
            "0x000000000000000000000000000000000000000000295be96e64066972000000\
             00000000000000000000000000000000000000000018d0bf423c03d8de000000\
             0000000000000000000000000000000000000000006342fd08f00f6378000000",
        ),
    )
    .expect("decodes");
    assert_eq!(v["claim"], "0x00000000000000000000000000000000000000c1");
    assert_eq!(v["fromBacking"], "50000000000000000000000000");
    assert_eq!(v["fromFounder"], "30000000000000000000000000");
    assert_eq!(v["teamBudget"], "120000000000000000000000000");

    let named = def(Role::Launcher, "EarlierBackersNamed");
    assert_eq!(
        named.topic(),
        w("0xac205200a39ccb31c844250943a590c6937cc2bf540a5383be72e128313e842b")
    );
    let v = decode(
        named,
        &[named.topic(), key, claim],
        &parse_bytes("0x000000000000000000000000000000000000000000295be96e64066972000000"),
    )
    .expect("decodes");
    assert_eq!(v["keepBacking"], "50000000000000000000000000");

    let paid = def(Role::Treasury, "TeamPaid");
    assert_eq!(
        paid.topic(),
        w("0x00daf0fab740e97e239cdb322620013afbbda09282525c5039d3a6c7441845ed")
    );
    let v = decode(
        paid,
        &[
            paid.topic(),
            word_addr("0x00000000000000000000000000000000000000cc"),
        ],
        &parse_bytes(
            "0x00000000000000000000000000000000000000000000d3c21bcecceda1000000\
             000000000000000000000000000000000000000000626f3aed214275d7000000",
        ),
    )
    .expect("decodes");
    assert_eq!(v["to"], "0x00000000000000000000000000000000000000cc");
    assert_eq!(v["amount"], "1000000000000000000000000");
    assert_eq!(v["left"], "119000000000000000000000000");
    // One topic short is refused.
    assert!(decode(paid, &[paid.topic()], &[0u8; 64]).is_err());
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

/// The pool manager's `Swap` carries signed amounts and tick (two's
/// complement); data from `cast abi-encode`, topic from `cast sig-event`.
#[test]
fn a_pool_swap_decodes_with_its_signs() {
    let swap = def(Role::PoolManager, "Swap");
    assert_eq!(
        swap.topic(),
        w("0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f")
    );
    let v = decode(
        swap,
        &[
            swap.topic(),
            word_u(0x77),
            word_addr("0x00000000000000000000000000000000000000b0"),
        ],
        &parse_bytes(
            "0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffffe363c80\
             000000000000000000000000000000000000000000000000000000000000005a\
             0000000000000000000000000000000000000001000000000000000000000000\
             0000000000000000000000000000000000000000000000000000000000000005\
             fffffffffffffffffffffffffffffffffffffffffffffffffffffffffff27618\
             0000000000000000000000000000000000000000000000000000000000000bb8",
        ),
    )
    .expect("decodes");
    assert_eq!(v["amount0"], "-30000000");
    assert_eq!(v["amount1"], "90");
    assert_eq!(v["sqrtPriceX96"], "79228162514264337593543950336");
    assert_eq!(v["tick"], "-887272");
    assert_eq!(v["fee"], "3000");
}
