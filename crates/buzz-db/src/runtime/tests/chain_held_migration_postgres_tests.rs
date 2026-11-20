//! Migration 0073 (the indexes of the held-for-a-window query and the ranking columns of the numbers table),
//! and the same facts in a database made from the desired-state schema in `schema/` (the shape `pgschema apply`
//! builds). There are no seed rows and no new table, so nothing in
//! `scripts/reconcile-schema-after-pgschema.sql` needs to follow.

use super::*;

/// The two indexes are there with the keys the window query reads, and the five ranking columns exist, are
/// nullable, and refuse a negative figure.
async fn assert_indexes_and_columns(pool: &PgPool) {
    for (index, table, columns) in [
        (
            "idx_chain_balance_changes_block",
            "chain_balance_changes",
            "(reader, project_key, token, block_number, log_index)",
        ),
        (
            "idx_chain_blocks_time",
            "chain_blocks",
            "(reader, block_time, number)",
        ),
    ] {
        let def: String = sqlx::query_scalar(
            "SELECT indexdef FROM pg_indexes WHERE tablename = $1 AND indexname = $2",
        )
        .bind(table)
        .bind(index)
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("the index {index} exists: {e}"));
        assert!(
            def.contains(columns),
            "{index} has the window query's key: {def}"
        );
    }
    let columns: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT column_name, data_type, is_nullable FROM information_schema.columns \
         WHERE table_name = 'chain_project_numbers' \
           AND column_name IN ('rank_money', 'rank_accounts', 'rank_window_secs', 'reached', 'launched_at') \
         ORDER BY column_name",
    )
    .fetch_all(pool)
    .await
    .expect("the columns");
    assert_eq!(
        columns,
        vec![
            (
                "launched_at".to_owned(),
                "bigint".to_owned(),
                "YES".to_owned()
            ),
            (
                "rank_accounts".to_owned(),
                "integer".to_owned(),
                "YES".to_owned()
            ),
            (
                "rank_money".to_owned(),
                "numeric".to_owned(),
                "YES".to_owned()
            ),
            (
                "rank_window_secs".to_owned(),
                "bigint".to_owned(),
                "YES".to_owned()
            ),
            ("reached".to_owned(), "boolean".to_owned(), "YES".to_owned()),
        ]
    );
    // A row with none of them (a record with no ranking row), and one with all, are accepted; a negative money
    // is not.
    let row = |extra: &str| {
        format!(
            "INSERT INTO chain_project_numbers (reader, project_key, source_block, facts_digest, content_digest, \
             event_id{}) VALUES ('r', decode(repeat('aa', 32), 'hex'), 1, decode(repeat('01', 32), 'hex'), \
             decode(repeat('02', 32), 'hex'), decode(repeat('03', 32), 'hex'){})",
            if extra.is_empty() {
                String::new()
            } else {
                ", rank_money, rank_accounts, rank_window_secs, reached, launched_at".to_owned()
            },
            extra
        )
    };
    sqlx::raw_sql(sqlx::AssertSqlSafe(row("")))
        .execute(pool)
        .await
        .expect("a row with no ranking columns");
    sqlx::raw_sql(sqlx::AssertSqlSafe(
        "DELETE FROM chain_project_numbers WHERE reader = 'r'".to_owned(),
    ))
    .execute(pool)
    .await
    .expect("clear");
    sqlx::raw_sql(sqlx::AssertSqlSafe(row(
        ", 5, 2, 2592000, true, 1800000000",
    )))
    .execute(pool)
    .await
    .expect("a row with the ranking columns");
    sqlx::raw_sql(sqlx::AssertSqlSafe(
        "DELETE FROM chain_project_numbers WHERE reader = 'r'".to_owned(),
    ))
    .execute(pool)
    .await
    .expect("clear");
    assert!(
        sqlx::raw_sql(sqlx::AssertSqlSafe(row(
            ", -1, 2, 2592000, true, 1800000000"
        )))
        .execute(pool)
        .await
        .is_err(),
        "a negative money is refused"
    );
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn migration_0073_adds_the_held_indexes_and_the_ranking_columns() {
    let admin = PgPool::connect(&admin_url().await).await.unwrap();
    let (pool, name) = create_scratch_db_through(&admin, "chain_held", Some(72)).await;
    let before: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM information_schema.columns \
         WHERE table_name = 'chain_project_numbers' AND column_name = 'rank_money'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(before, 0, "before 0073 the column does not exist");
    migration::run_migrations(&pool)
        .await
        .expect("migrate to the latest");
    assert_indexes_and_columns(&pool).await;
    drop_scratch_db(&admin, pool, &name).await;
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn a_database_made_from_the_desired_state_schema_has_the_held_indexes_and_columns() {
    let admin = PgPool::connect(&admin_url().await).await.unwrap();
    // An empty database: no migration runs, the desired-state files make it.
    let name = format!("chain_held_schema_{}", Uuid::new_v4().simple());
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
    assert_indexes_and_columns(&pool).await;
    drop_scratch_db(&admin, pool, &name).await;
}
