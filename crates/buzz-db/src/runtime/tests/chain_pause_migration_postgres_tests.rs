//! Migration 0076 (the holder pause's role, the helper's `pause.poke` and the index of the box payments' check), on a database migrated through 0075 and
//! then to the latest, and on a database made from the desired-state schema (the shape `pgschema apply` builds). The
//! schema has no seed rows for these tables, so nothing in `scripts/reconcile-schema-after-pgschema.sql` follows.

use super::*;

/// 20 bytes as a Postgres hex literal expression.
fn bytes20(fill: &str) -> String {
    format!("decode(repeat('{fill}', 20), 'hex')")
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

/// A holder pause and the claim contract are roles the reader may follow, `pause.poke` is a call the helper may
/// store, and a made-up role or call is still refused.
async fn assert_pause_and_earlier(pool: &PgPool, reader: &str) {
    assert!(
        contract(pool, reader, "c1", "pause").await,
        "a holder pause is a role the reader may follow"
    );
    assert!(
        contract(pool, reader, "c2", "earlier").await,
        "the claim contract is a role the reader may follow"
    );
    assert!(
        !contract(pool, reader, "c3", "gate").await,
        "a made-up role is still refused"
    );
    assert!(
        job(pool, reader, "poke", "pause.poke").await,
        "poke is a call the helper may store"
    );
    assert!(
        !job(pool, reader, "park", "pause.park").await,
        "parking is a person's press, never a stored call"
    );
    assert!(
        !job(pool, reader, "claim", "earlier.claim").await,
        "claiming is a person's press, never a stored call"
    );
    let def: String = sqlx::query_scalar(
        "SELECT indexdef FROM pg_indexes WHERE tablename = 'chain_logs' AND indexname = 'idx_chain_logs_box_draws'",
    )
    .fetch_one(pool)
    .await
    .expect("the index on the draws exists");
    assert!(
        def.contains("(reader, project_key, tx_hash)") && def.contains("AllowanceDrawn"),
        "the index is partial on the draws: {def}"
    );
    let def: String = sqlx::query_scalar(
        "SELECT indexdef FROM pg_indexes WHERE tablename = 'chain_logs' AND indexname = 'idx_chain_logs_agent_set'",
    )
    .fetch_one(pool)
    .await
    .expect("the index on the helper rows exists");
    assert!(
        def.contains("AgentSet") && def.contains("agent"),
        "the index is partial on the helper rows: {def}"
    );
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn migration_0076_lets_the_reader_follow_a_pause_and_the_helper_poke_it() {
    let admin = PgPool::connect(&admin_url().await).await.unwrap();
    let (pool, name) = create_scratch_db_through(&admin, "chain_pause", Some(75)).await;
    assert!(
        !contract(&pool, "r0", "c0", "pause").await,
        "before 0076 the role does not exist"
    );
    assert!(
        !job(&pool, "r0", "poke0", "pause.poke").await,
        "before 0076 the call does not exist"
    );
    migration::run_migrations(&pool)
        .await
        .expect("migrate to the latest");
    assert_pause_and_earlier(&pool, "r1").await;
    drop_scratch_db(&admin, pool, &name).await;
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn a_database_made_from_the_desired_state_schema_allows_the_pause_role_and_call() {
    let admin = PgPool::connect(&admin_url().await).await.unwrap();
    // An empty database: no migration runs, the desired-state files make it.
    let name = format!("chain_pause_schema_{}", Uuid::new_v4().simple());
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
    assert_pause_and_earlier(&pool, "r1").await;
    drop_scratch_db(&admin, pool, &name).await;
}
