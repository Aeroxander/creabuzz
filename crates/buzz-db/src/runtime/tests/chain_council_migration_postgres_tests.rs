//! Migration 0077 (the Council role, the helper's four vote calls and the two vote alerts), on a database migrated
//! through 0076 and then to the latest, and on a database made from the desired-state schema (the shape `pgschema
//! apply` builds). The schema has no seed rows for these tables, so nothing in
//! `scripts/reconcile-schema-after-pgschema.sql` follows.

use super::*;

/// 20 bytes as a Postgres hex literal expression.
fn bytes20(fill: &str) -> String {
    format!("decode(repeat('{fill}', 20), 'hex')")
}

/// 32 bytes as a Postgres hex literal expression.
fn bytes32(fill: &str) -> String {
    format!("decode(repeat('{fill}', 32), 'hex')")
}

async fn accepted(pool: &PgPool, sql: String) -> bool {
    sqlx::raw_sql(sqlx::AssertSqlSafe(sql))
        .execute(pool)
        .await
        .is_ok()
}

async fn contract(pool: &PgPool, reader: &str, fill: &str, role: &str) -> bool {
    accepted(
        pool,
        format!(
            "INSERT INTO chain_contracts (reader, address, role, from_block) \
             VALUES ('{reader}', {}, '{role}', 3)",
            bytes20(fill)
        ),
    )
    .await
}

async fn job(pool: &PgPool, reader: &str, key: &str, call: &str) -> bool {
    accepted(
        pool,
        format!(
            "INSERT INTO chain_helper_jobs (reader, job_key, call, target, args, due_block) \
             VALUES ('{reader}', '{key}', '{call}', {}, '{{}}', 1)",
            bytes20("d1")
        ),
    )
    .await
}

async fn alert(pool: &PgPool, reader: &str, kind: &str) -> bool {
    accepted(
        pool,
        format!(
            "INSERT INTO web_push_alerts (reader, project_key, serial, kind, block_number) \
             VALUES ('{reader}', {}, 1, '{kind}', 1)",
            bytes32("e1")
        ),
    )
    .await
}

/// A Council is a role the reader may follow, the four vote calls are calls the helper may store, and a vote and a
/// moved alert are kinds the alert maker may write; a made-up role, call or kind is still refused.
async fn assert_council_and_vote(pool: &PgPool, reader: &str) {
    assert!(
        contract(pool, reader, "c1", "council").await,
        "a project's Council is a role the reader may follow"
    );
    assert!(
        !contract(pool, reader, "c2", "gate").await,
        "a made-up role is still refused"
    );
    for (n, call) in [
        ("openSeats", "vote.openSeats"),
        ("finish", "vote.finish"),
        ("carryOut", "vote.carryOut"),
        ("lapse", "vote.lapse"),
    ] {
        assert!(
            job(pool, reader, n, call).await,
            "{call} is a call the helper may store"
        );
    }
    assert!(
        !job(pool, reader, "replace", "vote.openReplace").await,
        "opening a replace vote is a holder's press, never a stored call"
    );
    assert!(
        !job(pool, reader, "stand", "vote.stand").await,
        "standing is a person's press, never a stored call"
    );
    assert!(
        alert(pool, reader, "vote").await,
        "a vote alert is a kind the alert maker may write"
    );
    assert!(
        alert(pool, reader, "moved").await,
        "a moved alert is a kind the alert maker may write"
    );
    assert!(
        !alert(pool, reader, "claim").await,
        "a made-up alert kind is still refused"
    );
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn migration_0077_lets_the_reader_follow_a_council_and_the_helper_act_on_a_ballot() {
    let admin = PgPool::connect(&admin_url().await).await.unwrap();
    let (pool, name) = create_scratch_db_through(&admin, "chain_council", Some(76)).await;
    assert!(
        !contract(&pool, "r0", "c0", "council").await,
        "before 0077 the role does not exist"
    );
    assert!(
        !job(&pool, "r0", "finish0", "vote.finish").await,
        "before 0077 the call does not exist"
    );
    assert!(
        !alert(&pool, "r0", "vote").await,
        "before 0077 the alert kind does not exist"
    );
    migration::run_migrations(&pool)
        .await
        .expect("migrate to the latest");
    assert_council_and_vote(&pool, "r1").await;
    drop_scratch_db(&admin, pool, &name).await;
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn a_database_made_from_the_desired_state_schema_allows_the_council_role_and_the_vote_calls_and_kinds(
) {
    let admin = PgPool::connect(&admin_url().await).await.unwrap();
    // An empty database: no migration runs, the desired-state files make it.
    let name = format!("chain_council_schema_{}", Uuid::new_v4().simple());
    sqlx::query(sqlx::AssertSqlSafe(format!("CREATE DATABASE {name}")))
        .execute(&admin)
        .await
        .expect("create scratch db");
    let base = admin_url().await;
    let url = format!("{}/{}", &base[..base.rfind('/').expect("path")], name);
    let pool = PgPool::connect(&url).await.expect("connect scratch db");
    sqlx::raw_sql(sqlx::AssertSqlSafe(
        crate::test_support::desired_state_schema_sql(),
    ))
    .execute(&pool)
    .await
    .expect("the desired-state schema applies");
    assert_council_and_vote(&pool, "r1").await;
    drop_scratch_db(&admin, pool, &name).await;
}
