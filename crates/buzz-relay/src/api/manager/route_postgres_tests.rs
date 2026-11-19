//! The manager's route through the real router, against a stand-in AI service that answers every call and counts them:
//! who may ask, the honesty envelope on the way out, and every money rule (prices set, the platform's tenth of fees,
//! "post weekly", the weekly allowance), each refusal before any call reaches the service. Ignored without
//! infrastructure; run with `cargo test -p buzz-relay --lib -- manager::route_postgres_tests -- --ignored`.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use base64::Engine;
use buzz_core::kind::{KIND_LAUNCH_RECORD, KIND_LAUNCH_UPDATE, KIND_PROFILE};
use nostr::{Event, EventBuilder, Keys, Kind, Tag, TagKind, Timestamp};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tower::ServiceExt;
use uuid::Uuid;

use super::MANAGER_DRAFT_PATH;
use crate::state::AppState;

/// A stand-in AI service: answers every call with `reply` as the model's words, and counts the calls.
async fn service(reply: &'static str) -> (String, Arc<AtomicUsize>) {
    service_answering(reply, "200 OK").await
}

/// The same, answering with any status line: a service that is down answers `503 Service Unavailable`.
async fn service_answering(
    reply: &'static str,
    status: &'static str,
) -> (String, Arc<AtomicUsize>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let url = format!(
        "http://{}/v1/chat/completions",
        listener.local_addr().expect("address")
    );
    let calls = Arc::new(AtomicUsize::new(0));
    let seen = calls.clone();
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            seen.fetch_add(1, Ordering::SeqCst);
            tokio::spawn(async move {
                let mut buffer = vec![0u8; 64 * 1024];
                let _ = socket.read(&mut buffer).await;
                let body = serde_json::json!({
                    "choices": [{ "message": { "content": reply } }],
                    "usage": { "prompt_tokens": 1000, "completion_tokens": 100 },
                })
                .to_string();
                let answer = format!(
                    "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(answer.as_bytes()).await;
            });
        }
    });
    (url, calls)
}

const REPLY: &str = r#"{"this_week":[{"text":"Test the lamps again.","from":["r1"]}],"what_happened":[{"text":"Tested 12 lamps, said to be worth 9000.","from":["r1"]},{"text":"Tested 12 lamps.","from":["r1"]}]}"#;

fn signed(keys: &Keys, kind: u32, tags: &[&[&str]], at: u64) -> Event {
    let tags: Vec<Tag> = tags
        .iter()
        .map(|fields| Tag::parse(fields.to_vec()).expect("tag"))
        .collect();
    EventBuilder::new(Kind::Custom(kind as u16), "{}")
        .tags(tags)
        .allow_self_tagging()
        .custom_created_at(Timestamp::from(at))
        .sign_with_keys(keys)
        .expect("sign")
}

/// A chain reader of this test's own (its launcher is random), so the fees it seeds are the only fees it reads.
fn reader() -> crate::chain_reader::ChainReaderConfig {
    let mut launcher = [0u8; 20];
    launcher.copy_from_slice(&Uuid::new_v4().as_bytes()[..16].repeat(2)[..20]);
    crate::chain_reader::ChainReaderConfig {
        rpc_url: "http://127.0.0.1:1".into(),
        chain_id: 31_337,
        launcher,
        start_block: 0,
        confirmations: 12,
        poll_secs: 12,
        refresh_secs: 3_600,
        log_range: 2_000,
        community_host: None,
        helper: None,
    }
}

struct World {
    state: Arc<AppState>,
    host: String,
    community: buzz_core::tenant::CommunityId,
    founder: Keys,
    coordinate: String,
    item: String,
    /// The record's date, as stored.
    created: u64,
}

/// A community with a project whose record is `age_days` old and one update of the founder's, `posted_days` ago.
async fn world(url: String, price: u64, per_week: u32, age_days: u64, posted_days: u64) -> World {
    world_with(url, price, per_week, age_days, posted_days, |llm| llm).await
}

async fn world_with(
    url: String,
    price: u64,
    per_week: u32,
    age_days: u64,
    posted_days: u64,
    adjust: impl FnOnce(crate::config::LlmConfig) -> crate::config::LlmConfig,
) -> World {
    let state = crate::test_support::test_state_with(move |config| {
        config.llm = Some(adjust(
            crate::config::LlmConfig::for_test(url, 100, 100)
                .priced_for_test(price, price, per_week),
        ));
        config.chain_reader = Some(reader());
    })
    .await;
    let host = format!("manager-{}.example", Uuid::new_v4().simple());
    let community = state
        .db
        .ensure_configured_community(&host)
        .await
        .expect("community")
        .id;
    let founder = Keys::generate();
    state
        .db
        .add_relay_member(community, &founder.public_key().to_hex(), "member", None)
        .await
        .expect("member");
    state
        .db
        .ensure_user(community, &founder.public_key().to_bytes())
        .await
        .expect("user row");
    let now = Timestamp::now().as_secs();
    let d = format!("lantern-{}", Uuid::new_v4().simple());
    // Stored directly: a record dated in the past cannot come in through the door, which refuses dates far from now.
    let record = signed(
        &founder,
        KIND_LAUNCH_RECORD,
        &[&["d", &d], &["name", "Lantern"]],
        now - age_days * 86_400,
    );
    state
        .db
        .insert_event(community, &record, None)
        .await
        .expect("record");
    let coordinate = format!("37001:{}:{d}", founder.public_key().to_hex());
    let update = signed(
        &founder,
        KIND_LAUNCH_UPDATE,
        &[
            &["a", &coordinate],
            &["update-kind", "weekly"],
            &["update-part", "done", "Tested 12 lamps"],
        ],
        now - posted_days * 86_400,
    );
    state
        .db
        .insert_event(community, &update, None)
        .await
        .expect("update");
    World {
        state,
        host,
        community,
        founder,
        coordinate,
        item: update.id.to_hex(),
        created: now - age_days * 86_400,
    }
}

/// Fees for the platform under `reader`'s rows, in raw dollar units.
async fn seed_fees_for(state: &AppState, reader: &str, raw_dollars: u64) {
    let pool = state.db.pool();
    let reader = reader.to_string();
    let now = i64::try_from(Timestamp::now().as_secs()).unwrap_or(0);
    sqlx::query(
        "INSERT INTO chain_blocks (reader, number, hash, parent_hash, block_time) VALUES ($1, 1, $2, $2, $3)",
    )
    .bind(&reader)
    .bind(vec![7u8; 32])
    .bind(now - 3600)
    .execute(pool)
    .await
    .expect("block");
    sqlx::query(
        "INSERT INTO chain_logs (reader, block_number, log_index, block_hash, tx_hash, address, role, project_key, \
         event, topics, data, decoded) VALUES ($1, 1, 0, $2, $2, $3, 'rounds', NULL, 'Settled', '{}', ''::bytea, $4)",
    )
    .bind(&reader)
    .bind(vec![7u8; 32])
    .bind(vec![1u8; 20])
    .bind(serde_json::json!({ "toPlatform": raw_dollars.to_string() }))
    .execute(pool)
    .await
    .expect("log");
}

/// Fees for the platform under the server's own chain reader, so a tenth of them covers many drafts.
async fn seed_fees(state: &AppState, raw_dollars: u64) {
    let reader = state
        .config
        .chain_reader
        .as_ref()
        .expect("a reader")
        .reader_id();
    seed_fees_for(state, &reader, raw_dollars).await;
}

async fn spent(w: &World) -> u128 {
    super::cost::platform_spent(w.state.db.pool(), w.community, chrono::Utc::now())
        .await
        .expect("spent")
}

async fn ask(w: &World, who: &Keys, body: serde_json::Value) -> (StatusCode, serde_json::Value) {
    let body = body.to_string();
    let url = format!("https://{}{MANAGER_DRAFT_PATH}", w.host);
    let payload = hex::encode(Sha256::digest(body.as_bytes()));
    let auth = EventBuilder::new(Kind::HttpAuth, "")
        .tags([
            Tag::parse(["u", url.as_str()]).expect("u"),
            Tag::parse(["method", "POST"]).expect("method"),
            Tag::parse(["payload", payload.as_str()]).expect("payload"),
            Tag::custom(TagKind::custom("nonce"), [Uuid::new_v4().to_string()]),
        ])
        .sign_with_keys(who)
        .expect("sign");
    let header_value = format!(
        "Nostr {}",
        base64::engine::general_purpose::STANDARD
            .encode(serde_json::to_string(&auth).expect("json"))
    );
    let response = crate::router::build_router(w.state.clone())
        .oneshot(
            Request::post(MANAGER_DRAFT_PATH)
                .header(header::HOST, w.host.clone())
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, header_value)
                .body(Body::from(body))
                .expect("request"),
        )
        .await
        .expect("response");
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
        .await
        .expect("body");
    (status, serde_json::from_slice(&bytes).unwrap_or_default())
}

fn draft_body(w: &World) -> serde_json::Value {
    serde_json::json!({
        "project": w.coordinate,
        "items": [w.item, "f".repeat(64)],
        "answers": ["Do I owe tax on the round?"],
        "facts": "- Lantern sells solar lamps.",
    })
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn the_founder_gets_a_draft_held_to_the_record_and_nobody_else_does() {
    let (url, calls) = service(REPLY).await;
    let w = world(url, 300, 5, 30, 3).await;
    seed_fees(&w.state, 1_000_000_000).await;
    let (status, answer) = ask(&w, &w.founder, draft_body(&w)).await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    assert_eq!(answer["this_week"][0]["text"], "Test the lamps again.");
    assert_eq!(answer["what_happened"].as_array().map(Vec::len), Some(1));
    assert_eq!(answer["what_happened"][0]["text"], "Tested 12 lamps.");
    assert_eq!(answer["what_happened"][0]["records"][0], w.item.as_str());
    assert_eq!(answer["blocked"], 1, "\"worth\" never reaches the founder");
    assert_eq!(
        answer["not_read"], 1,
        "an id that is not the project's record is not read"
    );
    assert_eq!(answer["needs_a_person"][0]["topic"], "tax");
    assert!(answer.get("next").is_none());
    assert!(answer["can_be_wrong"].as_str().is_some());
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    // The call's cost is counted against the platform's tenth of fees.
    let after_one = spent(&w).await;
    let llm = w.state.config.llm.as_ref().expect("llm");
    let worst = super::model::worst_cost(llm, super::MAX_REQUEST_BYTES).expect("priced");
    assert!(
        after_one > 0 && after_one < u128::from(worst),
        "what stays counted is the call's cost, not the worst cost set aside: {after_one}"
    );

    // A stranger, a worker agent the founder runs, and a manager agent someone else runs are all refused.
    let stranger = Keys::generate();
    let worker = Keys::generate();
    let manager = Keys::generate();
    let own = Keys::generate();
    for keys in [&stranger, &worker, &manager, &own] {
        w.state
            .db
            .add_relay_member(w.community, &keys.public_key().to_hex(), "member", None)
            .await
            .expect("member");
        w.state
            .db
            .ensure_user(w.community, &keys.public_key().to_bytes())
            .await
            .expect("user row");
    }
    let label = |agent: &Keys, operator: &Keys, role: Option<&str>| {
        let json =
            buzz_sdk::nip_oa::compute_auth_tag(operator, &agent.public_key(), "").expect("auth");
        let auth: Vec<String> = serde_json::from_str(&json).expect("tag");
        let auth: Vec<&str> = auth.iter().map(String::as_str).collect();
        let me = agent.public_key().to_hex();
        let mut tags: Vec<&[&str]> = vec![&auth];
        let agent_tag = ["agent", me.as_str()];
        tags.push(&agent_tag);
        let role_tag = ["agent-role", role.unwrap_or("")];
        if role.is_some() {
            tags.push(&role_tag);
        }
        signed(agent, KIND_PROFILE, &tags, Timestamp::now().as_secs())
    };
    w.state
        .db
        .insert_event(w.community, &label(&worker, &w.founder, None), None)
        .await
        .expect("worker label");
    w.state
        .db
        .set_agent_owner(
            w.community,
            &worker.public_key().to_bytes(),
            &w.founder.public_key().to_bytes(),
        )
        .await
        .expect("owner");
    w.state
        .db
        .insert_event(
            w.community,
            &label(&manager, &stranger, Some("manager")),
            None,
        )
        .await
        .expect("manager label");
    w.state
        .db
        .set_agent_owner(
            w.community,
            &manager.public_key().to_bytes(),
            &stranger.public_key().to_bytes(),
        )
        .await
        .expect("owner");
    for who in [&stranger, &worker, &manager] {
        let (status, answer) = ask(&w, who, draft_body(&w)).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{answer}");
        assert_eq!(answer["code"], "ai_manager_founder_only");
    }
    // The founder's own manager agent is let through.
    w.state
        .db
        .insert_event(w.community, &label(&own, &w.founder, Some("manager")), None)
        .await
        .expect("label");
    w.state
        .db
        .set_agent_owner(
            w.community,
            &own.public_key().to_bytes(),
            &w.founder.public_key().to_bytes(),
        )
        .await
        .expect("owner");
    let (status, answer) = ask(&w, &own, draft_body(&w)).await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    assert_eq!(
        calls.load(Ordering::SeqCst),
        2,
        "refusals never reach the service"
    );
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn every_money_rule_refuses_before_the_service_is_called() {
    // No prices: the spend cannot be measured.
    let (url, calls) = service(REPLY).await;
    let w = world(url, 0, 5, 30, 3).await;
    let (status, answer) = ask(&w, &w.founder, draft_body(&w)).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{answer}");
    assert_eq!(answer["code"], "ai_manager_unmetered");

    // A draft that could cost more than a tenth of every fee the platform ever took.
    let (url, calls_high) = service(REPLY).await;
    let w = world(url, 1_000_000_000_000_000, 5, 30, 3).await;
    let (status, answer) = ask(&w, &w.founder, draft_body(&w)).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{answer}");
    assert_eq!(answer["code"], "ai_manager_platform_cap");

    // Quiet for 20 days before any round closed: post weekly first.
    let (url, calls_quiet) = service(REPLY).await;
    let w = world(url, 300, 5, 30, 20).await;
    seed_fees(&w.state, 1_000_000_000).await;
    let (status, answer) = ask(&w, &w.founder, draft_body(&w)).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{answer}");
    assert_eq!(answer["code"], "ai_manager_post_weekly");
    assert!(answer["error"]
        .as_str()
        .is_some_and(|e| e.contains("weekly update")));

    // Two hosted drafts a week: the third is the founder's own key.
    let (url, calls_week) = service(REPLY).await;
    let w = world(url, 300, 2, 30, 3).await;
    seed_fees(&w.state, 1_000_000_000).await;
    for _ in 0..2 {
        let (status, answer) = ask(&w, &w.founder, draft_body(&w)).await;
        assert_eq!(status, StatusCode::OK, "{answer}");
    }
    let (status, answer) = ask(&w, &w.founder, draft_body(&w)).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{answer}");
    assert_eq!(answer["code"], "ai_manager_own_key");
    assert!(answer["error"]
        .as_str()
        .is_some_and(|e| e.contains("own AI key")));

    for (calls, expected) in [
        (calls, 0),
        (calls_high, 0),
        (calls_quiet, 0),
        (calls_week, 2),
    ] {
        assert_eq!(calls.load(Ordering::SeqCst), expected);
    }
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn no_fees_or_another_readers_fees_or_the_operators_ceiling_all_refuse() {
    // No fees at all in the last 90 days: the plan's tenth of nothing is nothing.
    let (url, calls) = service(REPLY).await;
    let w = world(url, 300, 5, 30, 3).await;
    let (status, answer) = ask(&w, &w.founder, draft_body(&w)).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{answer}");
    assert_eq!(answer["code"], "ai_manager_platform_cap");

    // Fees under another reader's name (a second or re-made reader) are not this server's fees.
    seed_fees_for(
        &w.state,
        &format!("other-{}", Uuid::new_v4().simple()),
        1_000_000_000,
    )
    .await;
    let (status, answer) = ask(&w, &w.founder, draft_body(&w)).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{answer}");
    assert_eq!(answer["code"], "ai_manager_platform_cap");
    assert_eq!(calls.load(Ordering::SeqCst), 0);

    // Plenty of (play) fees, and the operator's ceiling in real money below one draft's worst cost.
    let (url, calls_ceiling) = service(REPLY).await;
    let w = world_with(url, 300, 5, 30, 3, |llm| {
        llm.with_manager_ceiling_for_test(1)
    })
    .await;
    seed_fees(&w.state, 1_000_000_000_000).await;
    let (status, answer) = ask(&w, &w.founder, draft_body(&w)).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{answer}");
    assert_eq!(answer["code"], "ai_manager_platform_cap");
    assert_eq!(calls_ceiling.load(Ordering::SeqCst), 0);
    assert_eq!(spent(&w).await, 0, "a refusal sets nothing aside");
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_service_that_does_not_answer_costs_nothing_and_keeps_the_weeks_draft() {
    let (url, calls) = service_answering(REPLY, "503 Service Unavailable").await;
    let w = world(url, 300, 1, 30, 3).await;
    seed_fees(&w.state, 1_000_000_000).await;
    // One hosted draft a week, asked for three times against a service that is down: each is "try again later",
    // none is counted against the week, and nothing stays set aside.
    for _ in 0..3 {
        let (status, answer) = ask(&w, &w.founder, draft_body(&w)).await;
        assert_eq!(status, StatusCode::BAD_GATEWAY, "{answer}");
        assert_eq!(answer["code"], "ai_unavailable");
    }
    assert_eq!(calls.load(Ordering::SeqCst), 3);
    assert_eq!(spent(&w).await, 0);
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn drafts_asked_for_at_once_cannot_pass_the_week_or_the_cap_together() {
    // Three hosted drafts a week, eight asked for at once: exactly three are served.
    let (url, calls) = service(REPLY).await;
    let w = world(url, 300, 3, 30, 3).await;
    seed_fees(&w.state, 1_000_000_000).await;
    let asks = (0..8).map(|_| ask(&w, &w.founder, draft_body(&w)));
    let answers = futures_util::future::join_all(asks).await;
    let served = answers
        .iter()
        .filter(|(status, _)| *status == StatusCode::OK)
        .count();
    assert_eq!(served, 3, "{answers:?}");
    assert!(answers
        .iter()
        .filter(|(status, _)| *status != StatusCode::OK)
        .all(|(_, answer)| answer["code"] == "ai_manager_own_key"));
    assert_eq!(calls.load(Ordering::SeqCst), 3);

    // The money: a tenth of fees that covers two drafts at their worst cost, six set aside at once. Exactly two
    // pass, and the count is exactly two worst costs: never a third on a stale reading.
    let pool = w.state.db.pool();
    let now = chrono::Utc::now();
    let llm = w.state.config.llm.as_ref().expect("llm");
    let worst = super::model::worst_cost(llm, super::MAX_REQUEST_BYTES).expect("priced");
    let before = spent(&w).await;
    let fees = (before + u128::from(worst) * 2) * 10;
    let reserved =
        futures_util::future::join_all((0..6).map(|_| {
            super::cost::reserve_platform_spend(pool, w.community, worst, fees, None, now)
        }))
        .await;
    let passed = reserved
        .iter()
        .filter(|result| matches!(result, Ok(true)))
        .count();
    assert_eq!(passed, 2, "{reserved:?}");
    assert_eq!(spent(&w).await, before + u128::from(worst) * 2);
    // One of them cost 5 milli-cents in the end and the other never answered: the room they leave is real.
    super::cost::settle_platform_spend(pool, w.community, worst, 5, now)
        .await
        .expect("settle");
    super::cost::settle_platform_spend(pool, w.community, worst, 0, now)
        .await
        .expect("settle");
    assert_eq!(spent(&w).await, before + 5);
    assert!(
        super::cost::reserve_platform_spend(pool, w.community, worst, fees, None, now)
            .await
            .expect("reserve")
    );
}

/// What the shared daily AI pool has counted for this community: the accounts' calls and the community's total.
async fn pool_calls(w: &World) -> i64 {
    sqlx::query_scalar(
        "SELECT COALESCE(SUM(consumed), 0)::bigint FROM budget_consumption \
         WHERE community_id = $1 AND counter_type IN ('llm_calls', 'llm_calls_total')",
    )
    .bind(w.community.as_uuid())
    .fetch_one(w.state.db.pool())
    .await
    .expect("pool count")
}

/// The project's hosted drafts counted this week.
async fn weekly_drafts(w: &World) -> i64 {
    sqlx::query_scalar(
        "SELECT COALESCE(SUM(consumed), 0)::bigint FROM budget_consumption \
         WHERE community_id = $1 AND counter_type = 'manager_calls' AND subject = $2",
    )
    .bind(w.community.as_uuid())
    .bind(super::cost::project_subject(&w.coordinate))
    .fetch_one(w.state.db.pool())
    .await
    .expect("weekly count")
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_refusal_for_the_week_or_the_cap_never_uses_up_the_shared_ai_calls() {
    // The project's week is used up: every further ask is refused and counts nothing in the shared daily pool.
    let (url, calls) = service(REPLY).await;
    let w = world(url, 300, 1, 30, 3).await;
    seed_fees(&w.state, 1_000_000_000).await;
    let (status, answer) = ask(&w, &w.founder, draft_body(&w)).await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    let used = pool_calls(&w).await;
    assert_eq!(
        used, 2,
        "one served draft is one account call and one community call"
    );
    for _ in 0..3 {
        let (status, answer) = ask(&w, &w.founder, draft_body(&w)).await;
        assert_eq!(answer["code"], "ai_manager_own_key", "{answer}");
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    }
    assert_eq!(
        pool_calls(&w).await,
        used,
        "a refused draft used up nothing"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);

    // The platform has no fees to spend from: refused, and nothing counted anywhere.
    let (url, _) = service(REPLY).await;
    let w = world(url, 300, 5, 30, 3).await;
    for _ in 0..3 {
        let (_, answer) = ask(&w, &w.founder, draft_body(&w)).await;
        assert_eq!(answer["code"], "ai_manager_platform_cap", "{answer}");
    }
    assert_eq!(pool_calls(&w).await, 0);
    assert_eq!(weekly_drafts(&w).await, 0);
    assert_eq!(spent(&w).await, 0);

    // The account's own daily allowance is gone: the refusal gives back the week's draft and the money set aside.
    let (url, calls) = service(REPLY).await;
    let w = world_with(url, 300, 5, 30, 3, |llm| {
        llm.with_daily_caps_for_test(1, 100)
    })
    .await;
    seed_fees(&w.state, 1_000_000_000).await;
    let (status, answer) = ask(&w, &w.founder, draft_body(&w)).await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    let (week, money) = (weekly_drafts(&w).await, spent(&w).await);
    assert_eq!(week, 1);
    let (status, answer) = ask(&w, &w.founder, draft_body(&w)).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{answer}");
    assert_eq!(answer["code"], "ai_limit_account");
    assert_eq!(weekly_drafts(&w).await, week, "the draft was given back");
    assert_eq!(spent(&w).await, money, "the money set aside was given back");
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn one_project_has_one_weekly_count_however_its_founders_key_is_written() {
    let (url, calls) = service(REPLY).await;
    let w = world(url, 300, 1, 30, 3).await;
    seed_fees(&w.state, 1_000_000_000).await;
    let (status, answer) = ask(&w, &w.founder, draft_body(&w)).await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    // The same project with the founder's key in capitals is the same project: it has had its week.
    let mut shouted = draft_body(&w);
    let key = w.founder.public_key().to_hex();
    shouted["project"] = w.coordinate.replace(&key, &key.to_uppercase()).into();
    assert_ne!(shouted["project"], w.coordinate.as_str());
    let (status, answer) = ask(&w, &w.founder, shouted).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{answer}");
    assert_eq!(answer["code"], "ai_manager_own_key");
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(weekly_drafts(&w).await, 1);
}

/// A launch and a closed round in the chain reader's tables, for chain key `key`, launched for the record at
/// `launched_for` (the launch's `projectId` is the hash of that address).
async fn seed_launch_and_round(
    state: &AppState,
    key: [u8; 32],
    launched_for: &str,
    first_index: i32,
) {
    let reader = state
        .config
        .chain_reader
        .as_ref()
        .expect("a reader")
        .reader_id();
    let pool = state.db.pool();
    let now = i64::try_from(Timestamp::now().as_secs()).unwrap_or(0);
    sqlx::query(
        "INSERT INTO chain_blocks (reader, number, hash, parent_hash, block_time) VALUES ($1, 1, $2, $2, $3) \
         ON CONFLICT DO NOTHING",
    )
    .bind(&reader)
    .bind(vec![7u8; 32])
    .bind(now - 3600)
    .execute(pool)
    .await
    .expect("block");
    for (index, role, event, decoded) in [
        (
            first_index,
            "launcher",
            "ProjectLaunched",
            serde_json::json!({ "projectId": super::cost::project_id(launched_for) }),
        ),
        (
            first_index + 1,
            "rounds",
            "RoundClosed",
            serde_json::json!({ "accepted": "5000000" }),
        ),
    ] {
        sqlx::query(
            "INSERT INTO chain_logs (reader, block_number, log_index, block_hash, tx_hash, address, role, \
             project_key, event, topics, data, decoded) VALUES ($1, 1, $2, $3, $3, $4, $5, $6, $7, '{}', ''::bytea, $8)",
        )
        .bind(&reader)
        .bind(index)
        .bind(vec![7u8; 32])
        .bind(vec![1u8; 20])
        .bind(role)
        .bind(key.as_slice())
        .bind(event)
        .bind(decoded)
        .execute(pool)
        .await
        .expect("log");
    }
}

/// The founder saves the project's record again, naming `chain_key` as its launch, dated `at`.
async fn save_record_naming(w: &World, chain_key: &[u8; 32], at: u64) {
    let d = w.coordinate.rsplit(':').next().expect("d").to_string();
    let named = format!("0x{}", hex::encode(chain_key));
    let record = signed(
        &w.founder,
        KIND_LAUNCH_RECORD,
        &[&["d", &d], &["name", "Lantern"], &["chain-key", &named]],
        at,
    );
    w.state
        .db
        .insert_event(w.community, &record, None)
        .await
        .expect("record");
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn only_a_launch_made_for_this_record_counts_as_its_first_round() {
    // Quiet for 20 days on a 30-day-old project: post weekly first, unless its first round closed.
    let (url, calls) = service(REPLY).await;
    let w = world(url, 300, 5, 30, 20).await;
    seed_fees(&w.state, 1_000_000_000).await;

    // The record names a key whose launch and round are SOMEONE ELSE's project: borrowing it earns nothing.
    let borrowed = [3u8; 32];
    seed_launch_and_round(&w.state, borrowed, "37001:someone-else:their-project", 10).await;
    save_record_naming(&w, &borrowed, w.created + 1).await;
    let (status, answer) = ask(&w, &w.founder, draft_body(&w)).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{answer}");
    assert_eq!(answer["code"], "ai_manager_post_weekly");
    assert_eq!(calls.load(Ordering::SeqCst), 0);

    // The record names the key of a launch made for this very record, and its round closed: the allowance has begun.
    let own = [4u8; 32];
    seed_launch_and_round(&w.state, own, &w.coordinate, 20).await;
    save_record_naming(&w, &own, w.created + 2).await;
    let (status, answer) = ask(&w, &w.founder, draft_body(&w)).await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn saving_the_record_again_does_not_make_a_project_new_again() {
    // A record made yesterday is a new project: a draft is free before any weekly update.
    let (url, calls) = service(REPLY).await;
    let w = world(url, 300, 5, 1, 20).await;
    seed_fees(&w.state, 1_000_000_000).await;
    let (status, answer) = ask(&w, &w.founder, draft_body(&w)).await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    // That was its first ask. Say it was 20 days ago, then save the record again so its own date is fresh: the
    // project asked first 20 days ago, so it is not new, and with no weekly update it is told to post one.
    let pool = w.state.db.pool();
    sqlx::query(
        "UPDATE budget_consumption SET consumed = consumed - 20 * 86400 \
         WHERE community_id = $1 AND subject = $2 AND counter_type = 'manager_first_seen'",
    )
    .bind(w.community.as_uuid())
    .bind(super::cost::project_subject(&w.coordinate))
    .execute(pool)
    .await
    .expect("first seen");
    let d = w.coordinate.rsplit(':').next().expect("d").to_string();
    let record = signed(
        &w.founder,
        KIND_LAUNCH_RECORD,
        &[
            &["d", &d],
            &["name", "Lantern"],
            &["team", &"a".repeat(64), "helper"],
        ],
        Timestamp::now().as_secs(),
    );
    w.state
        .db
        .insert_event(w.community, &record, None)
        .await
        .expect("record");
    let (status, answer) = ask(&w, &w.founder, draft_body(&w)).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{answer}");
    assert_eq!(answer["code"], "ai_manager_post_weekly");
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}
