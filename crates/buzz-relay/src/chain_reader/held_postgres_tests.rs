//! The held-for-a-window query against real Postgres (the H4, H8, H9 and H10 tests of
//! `docs/archive/STEP3-PLAN.md` section 9.2). Ignored without a database; run with
//! `cargo test -p buzz-relay --lib chain_reader::held_postgres_tests -- --include-ignored --test-threads=1`.
//!
//! Each test makes a scratch database holding only the two tables the query reads, created from the
//! repository's own table files (`schema/tables/public/chain_blocks.sql` and `chain_balance_changes.sql`, so a
//! change to their indexes shows here), and drops it at the end.

use std::collections::BTreeSet;

use serde_json::Value;
use sqlx::PgPool;
use uuid::Uuid;

use super::fixture::Fixture;
use super::held::{self, Change, Limits, Run, WindowRaw, WINDOW_SQL};
use super::scan_postgres_tests::{read_all, setup, stored_record};

const BLOCKS_SQL: &str = include_str!("../../../../schema/tables/public/chain_blocks.sql");
const CHANGES_SQL: &str =
    include_str!("../../../../schema/tables/public/chain_balance_changes.sql");

struct Scratch {
    admin: PgPool,
    pool: PgPool,
    name: String,
}

impl Scratch {
    async fn new() -> Self {
        let base = crate::test_support::database_url();
        let admin = PgPool::connect(&base).await.expect("connect Postgres");
        let name = format!("held_{}", Uuid::new_v4().simple());
        sqlx::query(sqlx::AssertSqlSafe(format!("CREATE DATABASE {name}")))
            .execute(&admin)
            .await
            .expect("create the scratch database");
        let url = format!("{}/{}", &base[..base.rfind('/').expect("a path")], name);
        let pool = PgPool::connect(&url)
            .await
            .expect("connect the scratch database");
        for sql in [BLOCKS_SQL, CHANGES_SQL] {
            sqlx::raw_sql(sqlx::AssertSqlSafe(sql.to_owned()))
                .execute(&pool)
                .await
                .expect("the table files apply");
        }
        Self { admin, pool, name }
    }

    async fn drop(self) {
        self.pool.close().await;
        let _ = sqlx::query(sqlx::AssertSqlSafe(format!(
            "DROP DATABASE IF EXISTS {} WITH (FORCE)",
            self.name
        )))
        .execute(&self.admin)
        .await;
    }

    /// A block at `number` whose time is `time`.
    async fn block(&self, reader: &str, number: i64, time: i64) {
        sqlx::query(
            "INSERT INTO chain_blocks (reader, number, hash, parent_hash, block_time) \
             VALUES ($1, $2, decode(repeat('01', 32), 'hex'), decode(repeat('02', 32), 'hex'), $3) \
             ON CONFLICT DO NOTHING",
        )
        .bind(reader)
        .bind(number)
        .bind(time)
        .execute(&self.pool)
        .await
        .expect("a block");
    }

    /// A change of `delta` Shares of the project `key` by the account `account` (a byte repeated 20 times).
    async fn change(
        &self,
        reader: &str,
        key: u8,
        block: i64,
        index: i32,
        account: u8,
        delta: i128,
    ) {
        sqlx::query(
            "INSERT INTO chain_balance_changes (reader, block_number, log_index, account, project_key, delta, token) \
             VALUES ($1, $2, $3, decode(repeat($4, 20), 'hex'), decode(repeat($5, 32), 'hex'), $6::numeric, 'shares')",
        )
        .bind(reader)
        .bind(block)
        .bind(index)
        .bind(format!("{account:02x}"))
        .bind(format!("{key:02x}"))
        .bind(delta.to_string())
        .execute(&self.pool)
        .await
        .expect("a change");
    }
}

fn key(byte: u8) -> [u8; 32] {
    [byte; 32]
}

fn who(byte: u8) -> String {
    format!("0x{}", format!("{byte:02x}").repeat(20))
}

async fn count(
    db: &Scratch,
    reader: &str,
    key_byte: u8,
    final_block: u64,
    start: u64,
    limits: Limits,
) -> WindowRaw {
    held::held_input(&db.pool, reader, &key(key_byte), final_block, start, limits)
        .await
        .expect("the query runs")
}

/// H4: exactly the cap of rows gives a value, one more makes the window cut (never a smaller number); the same
/// for accounts.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn h4_a_window_over_its_caps_is_cut_in_the_database() {
    let db = Scratch::new().await;
    let limits = Limits {
        rows_max: 4,
        accounts_max: 3,
    };
    for n in 1..=6 {
        db.block("r", n, 100 + n * 10).await;
    }
    // Four changes of two accounts: at the row cap.
    for n in 1..=4i64 {
        db.change("r", 1, n, 0, 1 + (n % 2) as u8, 1).await;
    }
    assert!(
        matches!(
            count(&db, "r", 1, 10, 0, limits).await,
            WindowRaw::Counted(_)
        ),
        "at the cap"
    );
    // A fifth: over it.
    db.change("r", 1, 5, 0, 1, 1).await;
    assert_eq!(
        count(&db, "r", 1, 10, 0, limits).await,
        WindowRaw::Cut,
        "one over the cap"
    );
    // The fifth is outside the window (a start after block 5's time): back under the cap.
    assert!(matches!(
        count(&db, "r", 1, 10, 150, limits).await,
        WindowRaw::Counted(_)
    ));
    // Accounts: four distinct accounts over a cap of three, with few rows.
    for (n, account) in [(1i64, 11u8), (2, 12), (3, 13), (4, 14)] {
        db.change("r", 2, n, 0, account, 1).await;
    }
    let wide = Limits {
        rows_max: 100,
        accounts_max: 3,
    };
    assert_eq!(
        count(&db, "r", 2, 10, 0, wide).await,
        WindowRaw::Cut,
        "four accounts over a cap of three"
    );
    assert!(matches!(
        count(&db, "r", 2, 10, 0, Limits { rows_max: 100, accounts_max: 4 }).await,
        WindowRaw::Counted(runs) if runs.len() == 4
    ));
    db.drop().await;
}

/// H8: only rows at or below the final block are read; a change at the window's very start is part of the start
/// balance, not of the window; a change taken back (a rollback deletes its rows) is gone from the figure.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn h8_the_query_reads_only_final_rows_and_the_window_starts_after_its_time() {
    let db = Scratch::new().await;
    for (n, time) in [(1, 1_000), (2, 2_000), (3, 3_000), (4, 4_000)] {
        db.block("r", n, time).await;
    }
    db.change("r", 1, 1, 0, 1, 50).await; // at time 1000
    db.change("r", 1, 2, 0, 1, -20).await; // at time 2000
    db.change("r", 1, 3, 0, 1, 5).await; // at time 3000
    db.change("r", 1, 4, 0, 1, 7).await; // above the final block below
    let run = |raw: WindowRaw| match raw {
        WindowRaw::Counted(mut m) => m.remove(&who(1)),
        WindowRaw::Cut => panic!("not cut"),
    };
    // The final block is 3: the change at block 4 is not final and is not read.
    let got = run(count(&db, "r", 1, 3, 1_500, Limits::default()).await).expect("moved");
    assert_eq!(
        got,
        Run {
            total: -15,
            lowest_run: -20
        }
    );
    // A window that starts exactly at a change's time does not hold it (its block is not later).
    let got = run(count(&db, "r", 1, 3, 2_000, Limits::default()).await).expect("moved");
    assert_eq!(
        got,
        Run {
            total: 5,
            lowest_run: 5
        }
    );
    // A window that starts after the last change has no moves.
    assert!(run(count(&db, "r", 1, 3, 3_000, Limits::default()).await).is_none());
    // Another project's rows and another reader's rows are not read.
    db.change("r", 2, 3, 1, 1, 1_000).await;
    db.block("other", 3, 3_000).await;
    db.change("other", 1, 3, 0, 1, 1_000).await;
    let got = run(count(&db, "r", 1, 3, 1_500, Limits::default()).await).expect("moved");
    assert_eq!(
        got,
        Run {
            total: -15,
            lowest_run: -20
        }
    );
    // A rollback past block 3 deletes its rows, and the figure follows.
    sqlx::query("DELETE FROM chain_balance_changes WHERE reader = 'r' AND block_number >= 3")
        .execute(&db.pool)
        .await
        .expect("a rollback");
    let got = run(count(&db, "r", 1, 3, 1_500, Limits::default()).await).expect("moved");
    assert_eq!(
        got,
        Run {
            total: -20,
            lowest_run: -20
        }
    );
    db.drop().await;
}

/// H10: the query's per-account figures equal the pure walk over the same rows, and so do the lowest balances
/// they give, on random sequences of transfers (some in the same block, some at the window's start).
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn h10_the_query_equals_the_pure_walk_on_random_rows() {
    let db = Scratch::new().await;
    let mut state: u64 = 0x9e37_79b9_7f4a_7c15;
    let mut next = |bound: u64| {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        state % bound
    };
    for round in 0..40 {
        let reader = format!("h10-{round}");
        let mut balance = [100i128; 6];
        let mut all: Vec<(i64, Change)> = Vec::new();
        // The mint happened long before every window.
        for (a, b) in balance.iter().enumerate() {
            db.block(&reader, 0, 0).await;
            db.change(&reader, 1, 0, 0, 1 + a as u8, *b).await;
        }
        // Transfers in chain order: the block number never goes down, and a block may hold several.
        let (mut block, mut index) = (1i64, 0i32);
        for _ in 0..(3 + next(25)) {
            let step = next(3) as i64; // 0: the same block as the last transfer
            if step == 0 && !all.is_empty() {
                index += 1;
            } else {
                block += step.max(1);
                index = 0;
            }
            let time = 1_000 + block * 10;
            let (from, to) = (next(6) as usize, next(6) as usize);
            if from == to || balance[from] == 0 {
                continue;
            }
            let amount = 1 + i128::from(next(balance[from] as u64));
            balance[from] -= amount;
            balance[to] += amount;
            db.block(&reader, block, time).await;
            for (account, delta) in [(from, -amount), (to, amount)] {
                db.change(&reader, 1, block, index, 1 + account as u8, delta)
                    .await;
                all.push((
                    time,
                    Change {
                        block: block as u64,
                        log_index: index as u32,
                        account: who(1 + account as u8),
                        delta,
                    },
                ));
            }
        }
        // Rows in chain order, as the query reads them.
        all.sort_by_key(|(_, c)| (c.block, c.log_index));
        let start = 1_000 + next(80) * 10; // sometimes exactly a block's time
        let inside: Vec<Change> = all
            .iter()
            .filter(|(time, _)| *time as u64 > start)
            .map(|(_, c)| c.clone())
            .collect();
        let want = held::walk(&inside, Limits::default());
        let got = held::held_input(&db.pool, &reader, &key(1), 100, start, Limits::default())
            .await
            .expect("the query runs");
        assert_eq!(got, want, "round {round}, window starting at {start}");
        let (WindowRaw::Counted(got), WindowRaw::Counted(want)) = (got, want) else {
            panic!("not cut");
        };
        let now: std::collections::BTreeMap<String, u128> = balance
            .iter()
            .enumerate()
            .map(|(a, b)| (who(1 + a as u8), *b as u128))
            .collect();
        let a = held::lowest(&got, now.iter(), &BTreeSet::new()).expect("fits");
        let b = held::lowest(&want, now.iter(), &BTreeSet::new()).expect("fits");
        assert_eq!(a, b, "round {round}");
        assert!(a.shares <= now.values().sum::<u128>());
    }
    db.drop().await;
}

/// H11: an account below the floor is not counted: 200 one-wei transfers to fresh addresses do not push a window
/// over its cap of accounts (the same rows with no floor do), the honest holders' figures are what they were, and a
/// window over the cap of rows is cut even when every account in it is below the floor.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn h11_accounts_below_the_floor_do_not_cut_a_window() {
    let db = Scratch::new().await;
    let reader = "h11";
    let limits = Limits {
        rows_max: 10_000,
        accounts_max: 50,
    };
    for n in 0..=201 {
        db.block(reader, n, 100 + n * 10).await;
    }
    // Three holders, minted long before the window.
    for account in 1..=3u8 {
        db.change(reader, 1, 0, i32::from(account), account, 1_000)
            .await;
    }
    // Inside the window: holder 2 sends holder 3 five, and holder 1 sends one wei to each of 200 fresh addresses.
    db.change(reader, 1, 1, 0, 2, -5).await;
    db.change(reader, 1, 1, 1, 3, 5).await;
    for n in 0..200i64 {
        let dust = 10 + u8::try_from(n).expect("a byte");
        db.change(reader, 1, 2 + n, 0, 1, -1).await;
        db.change(reader, 1, 2 + n, 1, dust, 1).await;
    }
    let start = 100;
    // No floor: 203 accounts moved, over the cap of 50: the window is cut (this is the attack).
    assert_eq!(
        held::held_input(&db.pool, reader, &key(1), 201, start, limits)
            .await
            .expect("runs"),
        WindowRaw::Cut,
        "without a floor, one-wei transfers cut the window"
    );
    // With a floor of ten wei: only the three holders are counted, and their figures are exact.
    let WindowRaw::Counted(runs) =
        held::held_input_above(&db.pool, reader, &key(1), 201, start, limits, 10)
            .await
            .expect("runs")
    else {
        panic!("with the floor the window is counted");
    };
    assert_eq!(
        runs.keys().cloned().collect::<Vec<_>>(),
        [who(1), who(2), who(3)]
    );
    assert_eq!(runs[&who(1)].total, -200);
    assert_eq!(runs[&who(2)].total, -5);
    assert_eq!(runs[&who(3)].total, 5);
    // A floor of exactly one wei counts the fresh addresses (a balance equal to the floor counts).
    assert_eq!(
        held::held_input_above(&db.pool, reader, &key(1), 201, start, limits, 1)
            .await
            .expect("runs"),
        WindowRaw::Cut,
        "an account at the floor counts"
    );
    // The cap of rows still holds when no account in the window reaches the floor: two dust accounts that pass
    // one wei back and forth fifty times.
    db.change(reader, 2, 0, 0, 60, 1).await;
    for n in 0..50i64 {
        let (from, to) = if n % 2 == 0 { (60u8, 61u8) } else { (61, 60) };
        db.change(reader, 2, 1 + n, 0, from, -1).await;
        db.change(reader, 2, 1 + n, 1, to, 1).await;
    }
    let small = Limits {
        rows_max: 20,
        accounts_max: 50,
    };
    assert_eq!(
        held::held_input_above(&db.pool, reader, &key(2), 201, start, small, 10)
            .await
            .expect("runs"),
        WindowRaw::Cut,
        "rows over the cap cut the window whatever the accounts hold"
    );
    assert_eq!(
        held::held_input_above(&db.pool, reader, &key(2), 201, start, Limits::default(), 10)
            .await
            .expect("runs"),
        WindowRaw::Counted(Default::default()),
        "under the cap, accounts that never reach the floor are simply not counted"
    );
    db.drop().await;
}

/// The nodes of a JSON plan.
fn nodes<'a>(plan: &'a Value, out: &mut Vec<&'a Value>) {
    out.push(plan);
    if let Some(children) = plan.get("Plans").and_then(Value::as_array) {
        for child in children {
            nodes(child, out);
        }
    }
}

/// What the window query does on a big table, from `EXPLAIN (ANALYZE)`: the rows its scan of the project's
/// changes returned and the way it scanned.
async fn scan_of(
    db: &Scratch,
    reader: &str,
    key_byte: u8,
    final_block: i64,
    start: i64,
    limits: Limits,
) -> (i64, String, String) {
    let sql = format!("EXPLAIN (ANALYZE, FORMAT JSON) {WINDOW_SQL}");
    let plan: Value = sqlx::query_scalar(sqlx::AssertSqlSafe(sql))
        .bind(reader)
        .bind(key(key_byte).as_slice())
        .bind(final_block)
        .bind(start)
        .bind(i64::try_from(limits.rows_max).expect("cap"))
        .bind(i64::try_from(limits.accounts_max).expect("cap"))
        .bind("0")
        .fetch_one(&db.pool)
        .await
        .expect("explain analyze");
    let mut all = Vec::new();
    nodes(&plan[0]["Plan"], &mut all);
    let scan = all
        .iter()
        .find(|n| n["Relation Name"] == "chain_balance_changes" && n["Alias"] == "c")
        .unwrap_or_else(|| panic!("the plan reads the changes: {plan}"));
    (
        scan["Actual Rows"].as_i64().expect("rows")
            * scan["Actual Loops"].as_i64().expect("loops").max(1),
        scan["Node Type"].as_str().expect("type").to_owned(),
        scan["Index Name"].as_str().unwrap_or("").to_owned(),
    )
}

/// H9: the bound is real. A table of one million changes of other projects and 5,000 of this one, spread over a
/// million blocks: the scan reads only this project's rows from the window's first block on, through the index
/// made for it, and stops at the cap (the `LIMIT` sits before the running sum). The test is falsifiable: it fails
/// when the `LIMIT` is moved after the running sum or the block lower bound is taken out of the query.
#[tokio::test]
#[ignore = "requires Postgres and Redis (and about 300 MB of disk for a moment)"]
async fn h9_the_bound_is_real_on_a_table_of_a_million_rows() {
    let db = Scratch::new().await;
    let reader = "r9";
    // One million blocks, one second apart, and a change in each for one of seven other projects.
    sqlx::query(
        "INSERT INTO chain_blocks (reader, number, hash, parent_hash, block_time) \
         SELECT $1, g, decode(repeat('01', 32), 'hex'), decode(repeat('02', 32), 'hex'), g \
         FROM generate_series(1, 1000000) g",
    )
    .bind(reader)
    .execute(&db.pool)
    .await
    .expect("blocks");
    sqlx::query(
        "INSERT INTO chain_balance_changes (reader, block_number, log_index, account, project_key, delta, token) \
         SELECT $1, g, 0, decode(lpad(to_hex(g % 997), 40, '0'), 'hex'), decode(lpad(to_hex(g % 7), 64, '0'), 'hex'), 1, 'shares' \
         FROM generate_series(1, 1000000) g",
    )
    .bind(reader)
    .execute(&db.pool)
    .await
    .expect("other projects' changes");
    // This project (key aa..aa): 5,000 changes, one every 200 blocks, of 20 accounts.
    sqlx::query(
        "INSERT INTO chain_balance_changes (reader, block_number, log_index, account, project_key, delta, token) \
         SELECT $1, g * 200, 1, decode(lpad(to_hex(g % 20 + 1000), 40, '0'), 'hex'), decode(repeat('aa', 32), 'hex'), 1, 'shares' \
         FROM generate_series(1, 5000) g",
    )
    .bind(reader)
    .execute(&db.pool)
    .await
    .expect("this project's changes");
    sqlx::query("ANALYZE chain_blocks")
        .execute(&db.pool)
        .await
        .expect("analyze");
    sqlx::query("ANALYZE chain_balance_changes")
        .execute(&db.pool)
        .await
        .expect("analyze");

    let limits = Limits {
        rows_max: 4_000,
        accounts_max: 20_000,
    };
    // A window of the last 200,000 blocks: 1,000 of this project's 5,000 rows are inside it. The scan returns
    // those and no row from before the window's first block (a table scan, or a read of the project's whole
    // history, would return 5,000 or go through other projects' rows).
    let (rows, node, index) = scan_of(&db, reader, 0xaa, 1_000_000, 800_000, limits).await;
    assert_eq!(
        (rows, node.as_str(), index.as_str()),
        (1_000, "Index Scan", "idx_chain_balance_changes_block"),
        "the scan reads this project's rows from the window's first block on, through its index"
    );
    let raw = count(&db, reader, 0xaa, 1_000_000, 800_000, limits).await;
    assert!(
        matches!(raw, WindowRaw::Counted(ref runs) if runs.len() == 20),
        "the window is counted"
    );

    // A window that holds all 5,000 rows against a cap of 1,000: the scan stops after the cap and one more.
    let small = Limits {
        rows_max: 1_000,
        accounts_max: 20_000,
    };
    let (rows, node, _) = scan_of(&db, reader, 0xaa, 1_000_000, 0, small).await;
    assert_eq!(
        rows, 1_001,
        "the LIMIT sits before the running sum: cap + 1 rows are read, not 5,000"
    );
    assert_eq!(node, "Index Scan");
    assert_eq!(
        count(&db, reader, 0xaa, 1_000_000, 0, small).await,
        WindowRaw::Cut
    );

    // The window's first block is found in one index step, not by reading the blocks of the window.
    let plan: Value = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "EXPLAIN (ANALYZE, FORMAT JSON) {WINDOW_SQL}"
    )))
    .bind(reader)
    .bind(key(0xaa).as_slice())
    .bind(1_000_000i64)
    .bind(800_000i64)
    .bind(4_000i64)
    .bind(20_000i64)
    .bind("0")
    .fetch_one(&db.pool)
    .await
    .expect("explain analyze");
    let mut all = Vec::new();
    nodes(&plan[0]["Plan"], &mut all);
    let blocks = all
        .iter()
        .find(|n| n["Relation Name"] == "chain_blocks")
        .expect("the plan reads the blocks");
    assert_eq!(blocks["Index Name"], "idx_chain_blocks_time");
    assert!(
        blocks["Actual Rows"].as_i64().expect("rows") <= 2,
        "the window's first block is found from the first block or two of the index, not by reading the window's 800,000: {}",
        blocks["Actual Rows"]
    );
    db.drop().await;
}

/// X1 over the whole path: the record the reader signs from rows it stored itself (the held figures counted by the
/// SQL of [`WINDOW_SQL`] over `chain_balance_changes`, the rest from the stored logs) carries the same four social
/// keys as the pure build over the run's rows in memory, for both projects. The two paths share nothing but the
/// rule.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn the_signed_records_social_keys_equal_the_pure_builds_for_both_projects() {
    let fx = Fixture::load();
    let (reader, chain, _state) = setup(&fx).await;
    chain.serve_books(&fx, &["A_end", "B_end"]);
    read_all(&reader, &chain).await;
    for (name, book) in [("A", "A_end"), ("B", "B_end")] {
        let signed = stored_record(&reader, &fx.projects[name].key).await;
        let built = super::record_tests::build_from(book).await.expect("builds");
        for key in ["held", "feed", "streaks", "established"] {
            assert!(
                !signed[key].is_null(),
                "{name}: {key} is signed with figures"
            );
            assert_eq!(signed[key], built.value[key], "{name}: {key}");
        }
    }
}

/// The reader's own path: 20,001 one-wei transfers to fresh addresses, inside both windows of a project, leave its
/// signed `held` and `established` with figures (the reader counts only accounts that hold what a smallest Back
/// buys). The same rows with no floor cut the windows, which the test shows first so that it is the floor that is
/// tested and not the placement of the rows.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_crowd_of_one_wei_transfers_leaves_a_signed_record_its_held_figures() {
    let fx = Fixture::load();
    let (reader, chain, _state) = setup(&fx).await;
    chain.serve_books(&fx, &["A_end", "B_end"]);
    let key = fx.projects["A"].key;
    let block = i64::try_from(fx.head() - 3).expect("block");
    sqlx::query(
        "INSERT INTO chain_balance_changes (reader, block_number, log_index, account, project_key, delta, token) \
         SELECT $1, $2, 100000 + g, decode(lpad(to_hex(10000000 + g), 40, '0'), 'hex'), $3, 1, 'shares' \
         FROM generate_series(1, $4) g",
    )
    .bind(reader.reader_id())
    .bind(block)
    .bind(key.as_slice())
    .bind(i64::try_from(held::HELD_ACCOUNTS_MAX).expect("cap") + 1)
    .execute(reader.state.db.pool())
    .await
    .expect("one-wei transfers");
    read_all(&reader, &chain).await;
    let signed = stored_record(&reader, &key).await;
    let rank_secs = signed["held"]["windows"]["rankSecs"]
        .as_u64()
        .expect("a window");
    let as_of = (
        signed["asOf"]["block"].as_u64().expect("block"),
        signed["asOf"]["time"].as_u64().expect("time"),
    );
    assert_eq!(
        held::held_input(
            reader.state.db.pool(),
            reader.reader_id(),
            &key,
            as_of.0,
            as_of.1.saturating_sub(rank_secs),
            Limits::default()
        )
        .await
        .expect("the query runs"),
        WindowRaw::Cut,
        "with no floor these rows cut the ranking window"
    );
    assert!(
        !signed["held"]["rank"].is_null() && !signed["held"]["badge"].is_null(),
        "with the floor the signed record has its figures: {}",
        signed["held"]
    );
}
