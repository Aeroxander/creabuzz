//! The admin API's `Origin` rule: the admin origin, or, for a signed staff
//! member only, one of this deployment's own community hosts (the web app's
//! escalated-reports list). The community lookup needs PostgreSQL, so those
//! tests are `#[ignore]`d and run in the PostgreSQL lane.

use axum::{
    body::Body,
    http::{header, Request, StatusCode},
};
use tower::ServiceExt;

use super::super::postgres_tests::{
    disabled_mode_state, make_nostr_auth, nip98_state_with_real_pool, test_operator_keys,
};
use super::super::router;
use crate::test_support::database_url;

async fn community_host(pool: &sqlx::PgPool) -> String {
    let host = format!("origin-{}.example", uuid::Uuid::new_v4().simple());
    buzz_db::Db::from_pool(pool.clone())
        .ensure_configured_community(&host)
        .await
        .expect("create test community");
    host
}

fn probe_from(keys: &nostr::Keys, origin: &str) -> Request<Body> {
    Request::builder()
        .uri("/probe")
        .header(header::HOST, "admin.example")
        .header(header::ORIGIN, origin)
        .header(header::AUTHORIZATION, make_nostr_auth(keys, "/probe"))
        .body(Body::empty())
        .expect("request")
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn staff_may_call_from_a_community_of_this_deployment() {
    let pool = sqlx::PgPool::connect(&database_url()).await.expect("db");
    let host = community_host(&pool).await;
    let state = nip98_state_with_real_pool(pool).await;
    let response = router(state)
        .oneshot(probe_from(
            &test_operator_keys(),
            &format!("https://{host}"),
        ))
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::OK);
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn a_community_origin_needs_its_own_scheme_and_a_known_host() {
    let pool = sqlx::PgPool::connect(&database_url()).await.expect("db");
    let host = community_host(&pool).await;
    let state = nip98_state_with_real_pool(pool).await;
    for origin in [
        format!("http://{host}"),
        "https://not-a-community.example".to_string(),
        format!("https://{host}/path"),
    ] {
        let response = router(state.clone())
            .oneshot(probe_from(&test_operator_keys(), &origin))
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::FORBIDDEN, "{origin}");
    }
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn someone_who_is_not_staff_is_refused_from_a_community_origin() {
    let pool = sqlx::PgPool::connect(&database_url()).await.expect("db");
    let host = community_host(&pool).await;
    let state = nip98_state_with_real_pool(pool).await;
    let response = router(state)
        .oneshot(probe_from(
            &nostr::Keys::generate(),
            &format!("https://{host}"),
        ))
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn disabled_mode_keeps_the_admin_origin_alone() {
    let pool = sqlx::PgPool::connect(&database_url()).await.expect("db");
    let host = community_host(&pool).await;
    let state = disabled_mode_state().await;
    let response = router(state)
        .oneshot(
            Request::builder()
                .uri("/reports")
                .header(header::HOST, "admin.example")
                .header(header::ORIGIN, format!("https://{host}"))
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}
