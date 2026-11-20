//! The ranking index's rule, the tie to a coordinate and what the index carries (the IX series of
//! `docs/next-version/STEP3-PLAN.md` section 9.2). The Postgres half is in `explore_postgres_tests.rs`.

use std::collections::BTreeMap;

use serde_json::Value;

use super::*;
use crate::chain_reader::record_tests::example;

fn row(key: u8, money: u128, accounts: u64, launched_at: u64) -> Row {
    Row {
        key: format!("0x{key:064x}"),
        coordinate: format!("37001:{key:064x}:project-{key}"),
        launched_at,
        window_secs: 2_592_000,
        money,
        accounts,
        reached: None,
    }
}

const AS_OF: AsOfRec = AsOfRec {
    block: 7,
    time: 1_800_000_000,
};

/// IX1: money first (most), then accounts (most), then the older launch, then the key.
#[test]
fn ix1_the_order_is_money_then_accounts_then_older_then_key() {
    let rows = vec![
        row(1, 500, 3, 100),
        row(2, 900, 1, 100),
        row(3, 500, 4, 100),
        row(4, 500, 3, 50),
        row(5, 500, 3, 50),
        row(6, 100, 99, 1),
    ];
    let index = explore_of(rows, AS_OF);
    let keys: Vec<u8> = index
        .entries
        .iter()
        .map(|e| u8::from_str_radix(&e.key[e.key.len() - 2..], 16).expect("key"))
        .collect();
    // 2 (most money); 3 (same money, more accounts); 4 then 5 (same, older; the key breaks the tie); 1 (younger); 6.
    assert_eq!(keys, vec![2, 3, 4, 5, 1, 6]);
    assert_eq!((index.seen, index.cut), (6, 0));
    assert_eq!((index.version, index.kind.as_str()), (1, "explore"));
}

/// IX1: a project with no money that stayed is not listed, and the order does not depend on the order of the rows.
#[test]
fn ix1_no_money_is_not_listed_and_the_order_ignores_the_input_order() {
    let rows = vec![row(1, 0, 50, 1), row(2, 10, 1, 1), row(3, 20, 1, 1)];
    let one = explore_of(rows.clone(), AS_OF);
    let mut reversed = rows;
    reversed.reverse();
    assert_eq!(one, explore_of(reversed, AS_OF));
    assert_eq!(one.entries.len(), 2, "the project with no money is absent");
    assert_eq!(one.seen, 2);
}

/// IX1: at most 20 entries; `seen` counts those that could be listed and `cut` those left out.
#[test]
fn ix1_at_most_twenty_entries_and_the_cut_is_counted() {
    let rows: Vec<Row> = (1..=45u8)
        .map(|k| row(k, u128::from(k) * 10, 1, 1))
        .collect();
    let index = explore_of(rows, AS_OF);
    assert_eq!(MAX_ENTRIES, 20);
    assert_eq!(index.entries.len(), 20);
    assert_eq!((index.seen, index.cut), (45, 25));
    assert_eq!(index.entries[0].money, "450", "the most money first");
    assert_eq!(index.entries[19].money, "260");
    let bytes = serde_json::to_vec(&index).expect("json").len();
    assert!(bytes < 6_000, "about 4 KB for 20 entries: {bytes}");
}

/// The tie: a row is kept only with a coordinate whose hash is the launch's `projectId`, whoever else claims the
/// key; a key whose launch is not read is left out.
#[test]
fn a_project_is_listed_only_with_the_coordinate_its_launch_names() {
    let stored = |key: u8| Stored {
        key: [key; 32],
        money: 10,
        accounts: 1,
        window_secs: 1,
        reached: None,
        launched_at: 1,
    };
    // A toy hash: the id of a coordinate is its text reversed.
    let id_of = |c: &str| c.chars().rev().collect::<String>();
    let claims = vec![
        ("37001:aa:honest".to_owned(), [1u8; 32]),
        ("37001:bb:thief".to_owned(), [1u8; 32]),
        ("37001:cc:other".to_owned(), [2u8; 32]),
    ];
    let ids = BTreeMap::from([
        ([1u8; 32], id_of("37001:aa:honest").to_uppercase()),
        ([2u8; 32], id_of("37001:zz:something-else")),
    ]);
    let rows = tie(vec![stored(1), stored(2), stored(3)], &claims, &ids, id_of);
    assert_eq!(rows.len(), 1);
    assert_eq!(
        rows[0].coordinate, "37001:aa:honest",
        "the thief's record claims the key and is not listed"
    );
}

/// IX4: no address, name or per-person figure in the index, and no price, pot, volume or join count.
#[test]
fn ix4_the_index_carries_nothing_about_a_person_and_no_price() {
    let index = explore_of(vec![row(1, 5, 2, 9), row(2, 6, 3, 8)], AS_OF);
    let v = serde_json::to_value(&index).expect("json");
    fn keys(v: &Value, out: &mut Vec<String>) {
        match v {
            Value::Object(m) => {
                for (k, v) in m {
                    out.push(k.clone());
                    keys(v, out);
                }
            }
            Value::Array(a) => a.iter().for_each(|v| keys(v, out)),
            _ => {}
        }
    }
    let mut names = Vec::new();
    keys(&v, &mut names);
    for forbidden in [
        "price", "pot", "volume", "joins", "tookOut", "net", "account", "address", "name",
        "holders",
    ] {
        assert!(
            !names.iter().any(|n| n == forbidden),
            "{forbidden} is in the index"
        );
    }
    let mut seen: Vec<String> = names;
    seen.sort();
    seen.dedup();
    assert_eq!(
        seen,
        [
            "a",
            "accounts",
            "asOf",
            "block",
            "cut",
            "entries",
            "key",
            "kind",
            "launchedAt",
            "money",
            "reached",
            "seen",
            "time",
            "version",
            "windowSecs"
        ]
    );
}

/// The columns kept beside a signed record are what its `held.rank`, `established` and `launchedAt` say: the
/// example's, and none at all when the record has no ranking row.
#[test]
fn the_columns_follow_the_record() {
    let v = example();
    let c = columns_of(&v);
    assert_eq!(
        c.money.map(|m| m.to_string()).as_deref(),
        v["held"]["rank"]["money"].as_str()
    );
    assert_eq!(c.accounts, v["held"]["rank"]["accounts"].as_u64());
    assert_eq!(c.window_secs, v["held"]["windows"]["rankSecs"].as_u64());
    assert_eq!(c.launched_at, v["launchedAt"].as_u64());
    assert_eq!(c.reached, v["established"]["reached"].as_bool());
    let mut none = v.clone();
    none["held"]["rank"] = Value::Null;
    assert_eq!(columns_of(&none), RankingColumns::default());
    none["held"] = Value::Null;
    assert_eq!(columns_of(&none), RankingColumns::default());
}
