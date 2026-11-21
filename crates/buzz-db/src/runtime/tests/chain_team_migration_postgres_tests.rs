//! Migration 0070 on a database that holds what the reader kept before it:
//! the Team token stored as a backer Shares contract, Team Share balances under
//! a derived key, and the helper's calls under the names of the old contracts.
//! The data is built with the old shape (a scratch database migrated through
//! 0069), then the rest of the migrations run.

use super::*;

/// 32 bytes as a Postgres hex literal expression.
fn bytes32(fill: &str) -> String {
    format!("decode(repeat('{fill}', 32), 'hex')")
}

/// 20 bytes as a Postgres hex literal expression.
fn bytes20(fill: &str) -> String {
    format!("decode(repeat('{fill}', 20), 'hex')")
}

async fn run(pool: &PgPool, sql: String) {
    sqlx::raw_sql(sqlx::AssertSqlSafe(sql))
        .execute(pool)
        .await
        .expect("seed the old-shaped rows");
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn migration_0070_gives_the_team_token_its_role_balances_their_token_and_the_helper_its_names(
) {
    let admin = PgPool::connect(&admin_url().await).await.unwrap();
    let (pool, name) = create_scratch_db_through(&admin, "chain_team", Some(69)).await;

    let (key, derived) = (bytes32("11"), bytes32("22"));
    let (shares, team, launcher) = (bytes20("a1"), bytes20("a2"), bytes20("a3"));
    let (alice, bob) = (bytes20("b1"), bytes20("b2"));
    let zero = "0x0000000000000000000000000000000000000000".to_owned();
    let hex = |fill: &str| format!("0x{}", fill.repeat(20));
    let transfer = |from: &str, to: &str, value: &str| {
        format!(r#"{{"from":"{from}","to":"{to}","value":"{value}"}}"#)
    };
    let log = |block: i32,
               index: i32,
               address: &str,
               role: &str,
               project: &str,
               event: &str,
               decoded: String| {
        format!(
            "INSERT INTO chain_logs (reader, block_number, log_index, block_hash, tx_hash, address, role, \
                 project_key, event, topics, data, decoded) \
             VALUES ('r1', {block}, {index}, {h}, {h}, {address}, '{role}', {project}, '{event}', \
                 ARRAY[]::bytea[], ''::bytea, '{decoded}'::jsonb);",
            h = bytes32("99"),
        )
    };
    let mut seed = String::new();
    // The launch row names the Team token; both tokens were stored as 'shares'.
    seed += &log(
        2,
        0,
        &launcher,
        "launcher",
        &key,
        "ProjectLaunched",
        format!(r#"{{"project":{{"team":"{}"}}}}"#, hex("a2")),
    );
    seed += &format!(
        "INSERT INTO chain_contracts (reader, address, role, project_key, from_block) VALUES \
            ('r1', {shares}, 'shares', {key}, 2), ('r1', {team}, 'shares', {key}, 2), \
            ('r1', {launcher}, 'launcher', NULL, 0);"
    );
    // Backer Shares: alice gets 100.
    seed += &log(
        5,
        0,
        &shares,
        "shares",
        &key,
        "Transfer",
        transfer(&zero, &hex("b1"), "100"),
    );
    // Team Shares: alice gets 50, then gives 20 to bob (both kept under the derived key), then bob gives 5
    // back (a Transfer the old reader never made a change for).
    for (block, from, to, value) in [
        (6, zero.clone(), hex("b1"), "50"),
        (7, hex("b1"), hex("b2"), "20"),
        (8, hex("b2"), hex("b1"), "5"),
    ] {
        seed += &log(
            block,
            0,
            &team,
            "team",
            &key,
            "Transfer",
            transfer(&from, &to, value),
        );
    }
    seed += &format!(
        "INSERT INTO chain_balance_changes (reader, block_number, log_index, account, project_key, delta) VALUES \
            ('r1', 5, 0, {alice}, {key}, 100), \
            ('r1', 6, 0, {alice}, {derived}, 50), \
            ('r1', 7, 0, {alice}, {derived}, -20), ('r1', 7, 0, {bob}, {derived}, 20);
         INSERT INTO chain_balances (reader, project_key, account, balance) VALUES \
            ('r1', {key}, {alice}, 100), ('r1', {derived}, {alice}, 30), ('r1', {derived}, {bob}, 20);"
    );
    // The helper: a reader with a Team token, one without (the old contracts' history).
    seed += &format!(
        "INSERT INTO chain_helper_jobs (reader, job_key, call, target, args, due_block) VALUES \
            ('r1', 'fees:a', 'treasury.sweepFees', {launcher}, '{{}}', 1), \
            ('r1', 'settle:a', 'treasury.release', {launcher}, '{{}}', 1), \
            ('r2', 'fees:old', 'treasury.sweepFees', {launcher}, '{{}}', 1), \
            ('r2', 'rounds:old', 'rounds.close', {launcher}, '{{}}', 1);"
    );
    run(&pool, seed).await;

    migration::run_migrations(&pool)
        .await
        .expect("migrate to the latest");

    // 1. The Team token has its own role; the backer Shares keep theirs.
    let roles: Vec<(String, String)> = sqlx::query_as(
        "SELECT encode(address, 'hex'), role FROM chain_contracts WHERE reader = 'r1' ORDER BY role",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        roles,
        vec![
            ("a3".repeat(20), "launcher".to_owned()),
            ("a1".repeat(20), "shares".to_owned()),
            ("a2".repeat(20), "team".to_owned()),
        ]
    );

    // 2. Change rows: real project key and a token; the missing Transfer is filled in.
    let changes: Vec<(i64, String, String, String, String)> = sqlx::query_as(
        "SELECT block_number, encode(project_key, 'hex'), token, encode(account, 'hex'), delta::text \
         FROM chain_balance_changes WHERE reader = 'r1' ORDER BY block_number, delta",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    let k = "11".repeat(32);
    let (a, b) = ("b1".repeat(20), "b2".repeat(20));
    assert_eq!(
        changes,
        vec![
            (5, k.clone(), "shares".into(), a.clone(), "100".into()),
            (6, k.clone(), "team".into(), a.clone(), "50".into()),
            (7, k.clone(), "team".into(), a.clone(), "-20".into()),
            (7, k.clone(), "team".into(), b.clone(), "20".into()),
            (8, k.clone(), "team".into(), b.clone(), "-5".into()),
            (8, k.clone(), "team".into(), a.clone(), "5".into()),
        ]
    );
    // ... and every balance is the sum of its changes, under the real key.
    let balances: Vec<(String, String, String, String)> = sqlx::query_as(
        "SELECT encode(project_key, 'hex'), token, encode(account, 'hex'), balance::text \
         FROM chain_balances WHERE reader = 'r1' ORDER BY token, account",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        balances,
        vec![
            (k.clone(), "shares".into(), a.clone(), "100".into()),
            (k.clone(), "team".into(), a.clone(), "35".into()),
            (k.clone(), "team".into(), b.clone(), "15".into()),
        ],
        "no balance is left under the derived key"
    );

    // 3. The helper: the reader that follows the new contracts has the new names, the old
    // contracts' history keeps its own.
    let jobs: Vec<(String, String)> =
        sqlx::query_as("SELECT reader, call FROM chain_helper_jobs ORDER BY reader, call")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(
        jobs,
        vec![
            ("r1".into(), "treasury.collectFees".into()),
            ("r1".into(), "treasury.settle".into()),
            ("r2".into(), "rounds.close".into()),
            ("r2".into(), "treasury.sweepFees".into()),
        ]
    );

    // The closed lists and the new column say what the code now writes, and still refuse the rest.
    let accepted = |sql: String| {
        let pool = pool.clone();
        async move {
            sqlx::raw_sql(sqlx::AssertSqlSafe(sql))
                .execute(&pool)
                .await
                .is_ok()
        }
    };
    assert!(
        accepted(format!(
            "INSERT INTO chain_contracts (reader, address, role, from_block) VALUES ('r3', {launcher}, 'team', 0)"
        ))
        .await
    );
    assert!(
        !accepted(format!(
            "INSERT INTO chain_contracts (reader, address, role, from_block) VALUES ('r3', {shares}, 'teams', 0)"
        ))
        .await
    );
    assert!(
        !accepted(format!(
            "INSERT INTO chain_balances (reader, project_key, token, account, balance) \
             VALUES ('r3', {key}, 'both', {alice}, 1)"
        ))
        .await
    );
    // The same account holds both tokens of one project: two rows, no clash.
    assert!(
        accepted(format!(
            "INSERT INTO chain_balances (reader, project_key, token, account, balance) VALUES \
                ('r3', {key}, 'shares', {alice}, 1), ('r3', {key}, 'team', {alice}, 2)"
        ))
        .await
    );
    assert!(
        accepted(format!(
            "INSERT INTO chain_helper_jobs (reader, job_key, call, target, args, due_block) \
             VALUES ('r3', 'k', 'treasury.collectFees', {launcher}, '{{}}', 1)"
        ))
        .await
    );
    assert!(
        !accepted(format!(
            "INSERT INTO chain_helper_jobs (reader, job_key, call, target, args, due_block) \
             VALUES ('r3', 'k2', 'treasury.draw', {launcher}, '{{}}', 1)"
        ))
        .await
    );
    // Migration 0075: the three more calls anyone may make are written by the helper; ending a
    // project (`Treasury.windDown()`) is a person's press and is never a stored call.
    for (n, call) in [
        "treasury.applyRate",
        "vester.execute",
        "vester.burnAfterWindDown",
    ]
    .into_iter()
    .enumerate()
    {
        assert!(
            accepted(format!(
                "INSERT INTO chain_helper_jobs (reader, job_key, call, target, args, due_block) \
                 VALUES ('r3', 'more{n}', '{call}', {launcher}, '{{}}', 1)"
            ))
            .await,
            "{call} is a call the helper may store"
        );
    }
    assert!(
        !accepted(format!(
            "INSERT INTO chain_helper_jobs (reader, job_key, call, target, args, due_block) \
             VALUES ('r3', 'k3', 'treasury.windDown', {launcher}, '{{}}', 1)"
        ))
        .await
    );

    drop_scratch_db(&admin, pool, &name).await;
}
