//! Migration 0071 (the task book's role and the partial index on its rows), and
//! the same two facts in a database made from the desired-state schema in
//! `schema/` (the shape `pgschema apply` builds). The schema has no seed
//! rows for these tables, so nothing in
//! `scripts/reconcile-schema-after-pgschema.sql` needs to follow.

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

/// The role list says `tasks` and still refuses a made-up role; the partial index
/// is there and only covers the books' rows.
async fn assert_role_and_index(pool: &PgPool, reader: &str) {
    let book = bytes20("c1");
    assert!(
        accepted(
            pool,
            format!(
                "INSERT INTO chain_contracts (reader, address, role, from_block) \
                 VALUES ('{reader}', {book}, 'tasks', 3)"
            )
        )
        .await,
        "a task book is a role the reader may follow"
    );
    assert!(
        !accepted(
            pool,
            format!(
                "INSERT INTO chain_contracts (reader, address, role, from_block) \
                 VALUES ('{reader}', {}, 'task', 3)",
                bytes20("c2")
            )
        )
        .await,
        "a made-up role is still refused"
    );
    let def: String = sqlx::query_scalar(
        "SELECT indexdef FROM pg_indexes WHERE tablename = 'chain_logs' AND indexname = 'idx_chain_logs_tasks'",
    )
    .fetch_one(pool)
    .await
    .expect("the index on the books' rows exists");
    assert!(
        def.contains("(reader, project_key, block_number)")
            && def.contains("WHERE (role = 'tasks'"),
        "the index is partial on the books' rows: {def}"
    );
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn migration_0071_lets_the_reader_follow_a_task_book_and_indexes_its_rows() {
    let admin = PgPool::connect(&admin_url().await).await.unwrap();
    let (pool, name) = create_scratch_db_through(&admin, "chain_tasks", Some(70)).await;
    assert!(
        !accepted(
            &pool,
            format!(
                "INSERT INTO chain_contracts (reader, address, role, from_block) VALUES ('r0', {}, 'tasks', 3)",
                bytes20("c0")
            )
        )
        .await,
        "before 0071 the role does not exist"
    );
    migration::run_migrations(&pool)
        .await
        .expect("migrate to the latest");
    assert_role_and_index(&pool, "r1").await;
    drop_scratch_db(&admin, pool, &name).await;
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn a_database_made_from_the_desired_state_schema_allows_tasks_and_has_the_index() {
    let admin = PgPool::connect(&admin_url().await).await.unwrap();
    // An empty database: no migration runs, the desired-state files make it.
    let name = format!("chain_tasks_schema_{}", Uuid::new_v4().simple());
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
    assert_role_and_index(&pool, "r1").await;
    drop_scratch_db(&admin, pool, &name).await;
}
