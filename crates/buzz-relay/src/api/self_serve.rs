//! Self-serve communities: anyone with a signing key can start a community of their own.
//!
//! `POST /self-serve/communities`, NIP-98 signed by the person who will own it, body `{ "name": "acme" }`, creates
//! `acme.<BUZZ_SELF_SERVE_COMMUNITY_DOMAIN>` with the signer as its owner, and answers with the address to connect to.
//! `GET /self-serve/communities` says whether this deployment offers it and under which domain, so a client can show
//! the option (and a preview of the address) only where it will work.
//!
//! ## Why this is not the operator endpoint
//!
//! `POST /operator/communities` is for deployment operators and lives behind a configured allowlist. Here the signer is
//! anybody, so everything an operator would be trusted for is bounded instead:
//!
//! - **Off by default.** Without `BUZZ_SELF_SERVE_COMMUNITY_DOMAIN` the route answers 404 and nothing else happens.
//! - **The name is the only input.** The host is always `<name>.<configured domain>`, so a caller can never mint a host
//!   outside the domain the operator chose, and the name is checked against length, character and reserved-word rules.
//! - **Create-only.** It shares the operator path's atomic "host row + owner row" transaction and refuses an existing
//!   host, so a create race can never hand someone else's community to a new owner.
//! - **Bounded.** A per-signer cap on attempts, a deployment-wide cap on creations per hour (a key costs nothing to
//!   make, so a per-person cap alone would not stop a script), and the existing per-owner community limit.
//! - **Fail closed.** The signed request is verified against `RELAY_OPERATOR_API_ORIGIN`, never the inbound `Host`, and
//!   its event id is recorded so a captured request cannot be replayed.
//!
//! It runs before any tenant exists for the caller, so like the operator routes it does no tenant resolution.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::Json,
};
use serde::Deserialize;
use serde_json::Value;

use crate::handlers::community_provisioning::{
    community_host_for_slug, create_community_for_owner, normalize_slug, validate_slug,
    MAX_SLUG_LEN, MIN_SLUG_LEN,
};
use crate::state::AppState;

use super::{api_error, bridge, internal_error, operator};

const PATH: &str = "/self-serve/communities";
const REPLAY_SCOPE: &str = "self-serve-communities";

/// How long the creation caps count over.
const WINDOW: Duration = Duration::from_secs(3_600);
/// Attempts (successful or not) one signing key may make in a window. A taken name counts, so the endpoint is not a free
/// way to find out which names exist.
const ATTEMPTS_PER_SIGNER: u32 = 20;
/// Distinct signing keys remembered; a hard bound because keys cost nothing to make.
const SIGNER_CACHE_CAPACITY: u64 = 10_000;

/// The caps on self-serve creation, kept in memory for one process.
///
/// Both counters expire on their own and the per-signer one has a hard capacity, so the limiter cannot itself become an
/// unbounded-memory problem when a caller generates keys. They are per process: behind a load balancer the real ceiling
/// is the cap times the number of servers, which is the same trade the invite-claim limiter makes.
pub struct SelfServeLimiter {
    attempts: moka::sync::Cache<[u8; 32], Arc<AtomicU32>>,
    created: moka::sync::Cache<(), Arc<AtomicU32>>,
}

impl Default for SelfServeLimiter {
    fn default() -> Self {
        Self::new()
    }
}

impl SelfServeLimiter {
    /// A limiter with the production window.
    pub fn new() -> Self {
        Self::with_window(WINDOW)
    }

    fn with_window(window: Duration) -> Self {
        Self {
            attempts: moka::sync::Cache::builder()
                .max_capacity(SIGNER_CACHE_CAPACITY)
                .time_to_live(window)
                .build(),
            created: moka::sync::Cache::builder()
                .max_capacity(1)
                .time_to_live(window)
                .build(),
        }
    }

    /// Count one attempt by `signer`. False once they are over their cap for the window.
    fn allow_attempt(&self, signer: &[u8; 32]) -> bool {
        let counter = self
            .attempts
            .get_with(*signer, || Arc::new(AtomicU32::new(0)));
        counter.fetch_add(1, Ordering::Relaxed) < ATTEMPTS_PER_SIGNER
    }

    /// Take one of the deployment's creations for this window. False when none are left. Give it back with
    /// [`Self::release`] if the creation did not happen.
    fn reserve(&self, max: u32) -> bool {
        let counter = self.created.get_with((), || Arc::new(AtomicU32::new(0)));
        if counter.fetch_add(1, Ordering::Relaxed) < max {
            true
        } else {
            counter.fetch_sub(1, Ordering::Relaxed);
            false
        }
    }

    fn release(&self) {
        if let Some(counter) = self.created.get(&()) {
            // Saturating: the window may have rolled over since the reservation.
            let _ =
                counter.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| n.checked_sub(1));
        }
    }
}

fn coded(status: StatusCode, code: &str, message: &str) -> (StatusCode, Json<Value>) {
    (
        status,
        Json(serde_json::json!({ "error": message, "code": code })),
    )
}

/// The WebSocket address of a new host, with the scheme the management origin uses (`https` → `wss`).
fn websocket_url(origin: &str, host: &str) -> String {
    let scheme = if origin.starts_with("https://") {
        "wss"
    } else {
        "ws"
    };
    format!("{scheme}://{host}")
}

/// `GET /self-serve/communities`: is this offered here, and under which domain.
pub async fn status(State(state): State<Arc<AppState>>) -> Json<Value> {
    match state.config.self_serve_community_domain.as_deref() {
        Some(domain) => Json(serde_json::json!({
            "enabled": true,
            "domain": domain,
            "min_name_length": MIN_SLUG_LEN,
            "max_name_length": MAX_SLUG_LEN,
        })),
        None => Json(serde_json::json!({ "enabled": false })),
    }
}

#[derive(Debug, Deserialize)]
struct CreateRequest {
    name: String,
    /// Who may join: `"open"` (the default: anyone with the address) or `"invite_only"` (members only, from the first
    /// moment, so a team's community never has a window in which strangers can read it).
    #[serde(default)]
    access: Option<String>,
}

/// `POST /self-serve/communities`: make a community of the signer's own.
pub async fn create(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Result<(StatusCode, Json<Value>), (StatusCode, Json<Value>)> {
    let domain = state
        .config
        .self_serve_community_domain
        .as_deref()
        .ok_or_else(|| {
            coded(
                StatusCode::NOT_FOUND,
                "not_enabled",
                "Creating communities is not turned on for this server.",
            )
        })?;
    let origin = state
        .config
        .relay_operator_api_origin
        .as_deref()
        .ok_or_else(|| internal_error("management origin is not configured"))?;

    // Who is asking: a NIP-98 signature over exactly this method, URL and body, never replayed.
    let url = format!("{origin}{PATH}");
    let bridge::VerifiedBridgeAuth {
        pubkey,
        event_id_bytes,
        ..
    } = bridge::verify_nip98_exempt_operator(&headers, "POST", &url, Some(&body))?;
    operator::check_replay_in_scope(&state, REPLAY_SCOPE, event_id_bytes).await?;

    if !state.self_serve_limiter.allow_attempt(&pubkey.to_bytes()) {
        return Err(coded(
            StatusCode::TOO_MANY_REQUESTS,
            "too_many_attempts",
            "Too many tries. Wait a while and try again.",
        ));
    }

    let request: CreateRequest = serde_json::from_slice(&body).map_err(|_| {
        api_error(
            StatusCode::BAD_REQUEST,
            "Send the name as {\"name\": \"...\"}.",
        )
    })?;
    let invite_only = match request.access.as_deref() {
        None | Some("open") => false,
        Some("invite_only") => true,
        Some(_) => {
            return Err(coded(
                StatusCode::BAD_REQUEST,
                "access_unknown",
                "Choose \"open\" or \"invite_only\" for who can join.",
            ))
        }
    };
    let name = normalize_slug(&request.name);
    validate_slug(&name)
        .map_err(|problem| coded(StatusCode::BAD_REQUEST, problem.code(), problem.message()))?;
    let host = community_host_for_slug(&name, domain).map_err(|_| {
        coded(
            StatusCode::BAD_REQUEST,
            "name_bad_characters",
            "That name cannot be used.",
        )
    })?;

    if !state
        .self_serve_limiter
        .reserve(state.config.self_serve_max_per_hour)
    {
        return Err(coded(
            StatusCode::TOO_MANY_REQUESTS,
            "creation_busy",
            "This server is making a lot of communities right now. Try again in a little while.",
        ));
    }

    match create_community_for_owner(&state, &host, &pubkey.to_hex(), invite_only).await {
        Ok(created) => Ok((
            StatusCode::CREATED,
            Json(serde_json::json!({
                "community_id": created.community_id,
                "host": created.host,
                "url": websocket_url(origin, &created.host),
                "owner_pubkey": created.owner_pubkey,
                "access": if invite_only { "invite_only" } else { "open" },
            })),
        )),
        Err(message) => {
            state.self_serve_limiter.release();
            if message == "community already exists" {
                Err(coded(
                    StatusCode::CONFLICT,
                    "name_taken",
                    "That name is taken. Pick another.",
                ))
            } else if message.starts_with("limit_reached:") {
                Err(coded(
                    StatusCode::CONFLICT,
                    "limit_reached",
                    "You have reached the most communities one person can own.",
                ))
            } else {
                tracing::error!(error = %message, host = %host, "self-serve community creation failed");
                Err(internal_error("creating the community failed"))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_signer_gets_a_fixed_number_of_attempts_per_window() {
        let limiter = SelfServeLimiter::new();
        let me = [7u8; 32];
        for _ in 0..ATTEMPTS_PER_SIGNER {
            assert!(limiter.allow_attempt(&me));
        }
        assert!(
            !limiter.allow_attempt(&me),
            "the next attempt is over the cap"
        );
        // Someone else is unaffected.
        assert!(limiter.allow_attempt(&[8u8; 32]));
    }

    #[test]
    fn attempts_come_back_when_the_window_rolls_over() {
        let limiter = SelfServeLimiter::with_window(Duration::from_millis(20));
        let me = [9u8; 32];
        for _ in 0..ATTEMPTS_PER_SIGNER {
            assert!(limiter.allow_attempt(&me));
        }
        assert!(!limiter.allow_attempt(&me));
        std::thread::sleep(Duration::from_millis(50));
        limiter.attempts.run_pending_tasks();
        assert!(limiter.allow_attempt(&me));
    }

    #[test]
    fn the_deployment_wide_cap_is_shared_by_everyone() {
        let limiter = SelfServeLimiter::new();
        assert!(limiter.reserve(2));
        assert!(limiter.reserve(2));
        assert!(!limiter.reserve(2), "a third creation this hour is refused");
        assert!(
            !limiter.reserve(2),
            "and a refusal does not eat into the count"
        );
    }

    #[test]
    fn a_creation_that_did_not_happen_gives_its_place_back() {
        let limiter = SelfServeLimiter::new();
        assert!(limiter.reserve(1));
        assert!(!limiter.reserve(1));
        limiter.release();
        assert!(limiter.reserve(1));
    }

    #[test]
    fn a_cap_of_zero_means_no_creation_at_all() {
        let limiter = SelfServeLimiter::new();
        assert!(!limiter.reserve(0));
    }

    #[test]
    fn releasing_with_nothing_reserved_does_not_underflow() {
        let limiter = SelfServeLimiter::new();
        limiter.release();
        assert!(limiter.reserve(1));
        assert!(!limiter.reserve(1));
    }

    #[test]
    fn the_websocket_address_follows_the_management_origin() {
        assert_eq!(
            websocket_url("https://creaton.example", "acme.creaton.example"),
            "wss://acme.creaton.example"
        );
        assert_eq!(
            websocket_url("http://localhost:3000", "acme.localhost:3000"),
            "ws://acme.localhost:3000"
        );
    }
}

#[cfg(test)]
mod postgres_tests {
    use std::{
        collections::HashSet,
        sync::{Arc, Mutex},
    };

    use axum::{
        body::{to_bytes, Body},
        http::{header, Request, StatusCode},
    };
    use base64::Engine;
    use nostr::{EventBuilder, Keys, Kind, Tag};
    use serde_json::Value;
    use sha2::{Digest, Sha256};
    use tower::ServiceExt;
    use uuid::Uuid;

    use crate::router::build_router;
    use crate::state::AppState;

    const INGRESS_HOST: &str = "selfserve-ingress.example";
    const DOMAIN: &str = "selfserve.example";

    struct AlwaysFreshReplayGuard;

    impl buzz_auth::Nip98ReplayGuard for AlwaysFreshReplayGuard {
        fn try_mark_in_scope<'a>(
            &'a self,
            _scope: &'a str,
            _event_id: &'a nostr::EventId,
            _ttl_secs: u64,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<bool, buzz_auth::AuthError>> + Send + 'a>,
        > {
            Box::pin(async { Ok(true) })
        }
    }

    struct SeenOnceReplayGuard(Mutex<HashSet<[u8; 32]>>);

    impl buzz_auth::Nip98ReplayGuard for SeenOnceReplayGuard {
        fn try_mark_in_scope<'a>(
            &'a self,
            _scope: &'a str,
            event_id: &'a nostr::EventId,
            _ttl_secs: u64,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<bool, buzz_auth::AuthError>> + Send + 'a>,
        > {
            let inserted = self
                .0
                .lock()
                .expect("replay set")
                .insert(*event_id.as_bytes());
            Box::pin(async move { Ok(inserted) })
        }
    }

    fn nip98_auth_header(keys: &Keys, url: &str, method: &str, body: Option<&[u8]>) -> String {
        let mut tags = vec![
            Tag::parse(["u", url]).expect("u tag"),
            Tag::parse(["method", method]).expect("method tag"),
        ];
        if let Some(body) = body {
            let hash: [u8; 32] = Sha256::digest(body).into();
            tags.push(Tag::parse(["payload", hex::encode(hash).as_str()]).expect("payload tag"));
        }
        let event = EventBuilder::new(Kind::HttpAuth, "")
            .tags(tags)
            .sign_with_keys(keys)
            .expect("sign NIP-98 event");
        let json = serde_json::to_string(&event).expect("serialize NIP-98 event");
        format!(
            "Nostr {}",
            base64::engine::general_purpose::STANDARD.encode(json.as_bytes())
        )
    }

    /// A relay state on the dev database with self-serve on under [`DOMAIN`], unless `configure` turns it off.
    async fn test_state(
        replay: Arc<dyn buzz_auth::Nip98ReplayGuard>,
        configure: impl FnOnce(&mut crate::config::Config),
    ) -> Option<Arc<AppState>> {
        let mut config = crate::config::Config::for_test();
        config.database_url = crate::test_support::database_url();
        config.redis_url = "redis://127.0.0.1:1".to_string();
        config.relay_url = "wss://tenant.example".to_string();
        config.relay_operator_api_origin = Some(format!("http://{INGRESS_HOST}"));
        config.self_serve_community_domain = Some(DOMAIN.to_string());
        config.self_serve_max_per_hour = 1_000;
        configure(&mut config);

        let pool = sqlx::PgPool::connect(&crate::test_support::database_url())
            .await
            .ok()?;
        let db = buzz_db::Db::from_pool(pool.clone());
        let redis_pool = deadpool_redis::Config::from_url(&config.redis_url)
            .create_pool(Some(deadpool_redis::Runtime::Tokio1))
            .ok()?;
        let pubsub = Arc::new(
            buzz_pubsub::PubSubManager::new(&config.redis_url, redis_pool.clone())
                .await
                .ok()?,
        );
        let audit = buzz_audit::AuditService::new(pool.clone());
        let auth = buzz_auth::AuthService::new(config.auth.clone());
        let search = buzz_search::SearchService::new(pool.clone());
        let workflow_engine = Arc::new(buzz_workflow::WorkflowEngine::new(
            db.clone(),
            buzz_workflow::WorkflowConfig::default(),
        ));
        let media_storage = buzz_media::MediaStorage::new(&config.media).ok()?;
        let (mut state, _audit_shutdown) = AppState::new(
            config,
            db,
            redis_pool,
            audit,
            pubsub,
            auth,
            search,
            workflow_engine,
            Keys::generate(),
            media_storage,
        );
        state.nip98_replay = replay;
        Some(Arc::new(state))
    }

    async fn fresh_state(configure: impl FnOnce(&mut crate::config::Config)) -> Arc<AppState> {
        test_state(Arc::new(AlwaysFreshReplayGuard), configure)
            .await
            .expect("requires reachable Postgres and relay test state")
    }

    /// A name no other test (or earlier run) has used.
    fn unique_name() -> String {
        format!("t{}", &Uuid::new_v4().simple().to_string()[..20])
    }

    async fn read_json(response: axum::response::Response) -> Value {
        let bytes = to_bytes(response.into_body(), 1024 * 1024)
            .await
            .expect("read response body");
        serde_json::from_slice(&bytes).expect("response JSON")
    }

    async fn send(
        state: Arc<AppState>,
        method: &str,
        auth: Option<String>,
        body: Option<String>,
    ) -> axum::response::Response {
        let mut request = Request::builder()
            .method(method)
            .uri("/self-serve/communities")
            .header(header::HOST, INGRESS_HOST);
        if let Some(auth) = auth {
            request = request.header(header::AUTHORIZATION, auth);
        }
        if body.is_some() {
            request = request.header(header::CONTENT_TYPE, "application/json");
        }
        build_router(state)
            .oneshot(
                request
                    .body(body.map_or_else(Body::empty, Body::from))
                    .expect("request"),
            )
            .await
            .expect("response")
    }

    async fn create(state: Arc<AppState>, keys: &Keys, name: &str) -> axum::response::Response {
        create_with(state, keys, serde_json::json!({ "name": name })).await
    }

    async fn create_with(
        state: Arc<AppState>,
        keys: &Keys,
        request: Value,
    ) -> axum::response::Response {
        let body = request.to_string();
        let url = format!("http://{INGRESS_HOST}/self-serve/communities");
        let auth = nip98_auth_header(keys, &url, "POST", Some(body.as_bytes()));
        send(state, "POST", Some(auth), Some(body)).await
    }

    async fn exists(state: &AppState, host: &str) -> bool {
        state
            .db
            .lookup_community_by_host_for_management(host)
            .await
            .expect("lookup")
            .is_some()
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn anyone_can_create_a_community_and_becomes_its_owner() {
        let state = fresh_state(|_| {}).await;
        let owner = Keys::generate();
        let name = unique_name();

        let response = create(state.clone(), &owner, &name).await;
        assert_eq!(response.status(), StatusCode::CREATED);
        let json = read_json(response).await;
        let host = format!("{name}.{DOMAIN}");
        assert_eq!(json["host"], host);
        assert_eq!(json["url"], format!("ws://{host}"));
        assert_eq!(json["owner_pubkey"], owner.public_key().to_hex());
        assert!(exists(&state, &host).await);

        let owned = state
            .db
            .list_communities_owned_by(&owner.public_key().to_hex())
            .await
            .expect("list owned");
        assert!(owned.communities.iter().any(|c| c.host == host));
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn a_name_that_is_taken_is_refused_and_its_owner_keeps_it() {
        let state = fresh_state(|_| {}).await;
        let first = Keys::generate();
        let second = Keys::generate();
        let name = unique_name();
        assert_eq!(
            create(state.clone(), &first, &name).await.status(),
            StatusCode::CREATED
        );

        let response = create(state.clone(), &second, &name).await;
        assert_eq!(response.status(), StatusCode::CONFLICT);
        assert_eq!(read_json(response).await["code"], "name_taken");

        let host = format!("{name}.{DOMAIN}");
        let theirs = state
            .db
            .list_communities_owned_by(&second.public_key().to_hex())
            .await
            .expect("list owned");
        assert!(theirs.communities.iter().all(|c| c.host != host));
        let mine = state
            .db
            .list_communities_owned_by(&first.public_key().to_hex())
            .await
            .expect("list owned");
        assert!(mine.communities.iter().any(|c| c.host == host));
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn when_it_is_not_turned_on_nothing_is_created() {
        let state = fresh_state(|c| c.self_serve_community_domain = None).await;
        let name = unique_name();
        let response = create(state.clone(), &Keys::generate(), &name).await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(read_json(response).await["code"], "not_enabled");
        assert!(!exists(&state, &format!("{name}.{DOMAIN}")).await);

        let status = send(state, "GET", None, None).await;
        assert_eq!(status.status(), StatusCode::OK);
        assert_eq!(read_json(status).await["enabled"], false);
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn the_status_says_where_communities_are_made() {
        let state = fresh_state(|_| {}).await;
        let response = send(state, "GET", None, None).await;
        assert_eq!(response.status(), StatusCode::OK);
        let json = read_json(response).await;
        assert_eq!(json["enabled"], true);
        assert_eq!(json["domain"], DOMAIN);
        assert_eq!(json["min_name_length"], 3);
        assert_eq!(json["max_name_length"], 32);
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn a_request_that_is_not_signed_for_exactly_this_is_refused() {
        let state = fresh_state(|_| {}).await;
        let keys = Keys::generate();
        let name = unique_name();
        let host = format!("{name}.{DOMAIN}");
        let body = serde_json::json!({ "name": name }).to_string();
        let url = format!("http://{INGRESS_HOST}/self-serve/communities");

        // No signature.
        let r = send(state.clone(), "POST", None, Some(body.clone())).await;
        assert_eq!(r.status(), StatusCode::UNAUTHORIZED);
        // Signed for another origin.
        let other = nip98_auth_header(
            &keys,
            "http://elsewhere.example/self-serve/communities",
            "POST",
            Some(body.as_bytes()),
        );
        let r = send(state.clone(), "POST", Some(other), Some(body.clone())).await;
        assert_eq!(r.status(), StatusCode::UNAUTHORIZED);
        // Signed for another method.
        let wrong_method = nip98_auth_header(&keys, &url, "GET", Some(body.as_bytes()));
        let r = send(
            state.clone(),
            "POST",
            Some(wrong_method),
            Some(body.clone()),
        )
        .await;
        assert_eq!(r.status(), StatusCode::UNAUTHORIZED);
        // Signed over a different body: the name cannot be swapped after signing.
        let other_body = serde_json::json!({ "name": "somethingelse" }).to_string();
        let swapped = nip98_auth_header(&keys, &url, "POST", Some(other_body.as_bytes()));
        let r = send(state.clone(), "POST", Some(swapped), Some(body)).await;
        assert_eq!(r.status(), StatusCode::UNAUTHORIZED);

        assert!(
            !exists(&state, &host).await,
            "none of them may have created anything"
        );
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn a_captured_request_cannot_be_sent_again() {
        let state = test_state(
            Arc::new(SeenOnceReplayGuard(Mutex::new(HashSet::new()))),
            |_| {},
        )
        .await
        .expect("requires reachable Postgres and relay test state");
        let keys = Keys::generate();
        let name = unique_name();
        let body = serde_json::json!({ "name": name }).to_string();
        let url = format!("http://{INGRESS_HOST}/self-serve/communities");
        let auth = nip98_auth_header(&keys, &url, "POST", Some(body.as_bytes()));

        let first = send(
            state.clone(),
            "POST",
            Some(auth.clone()),
            Some(body.clone()),
        )
        .await;
        assert_eq!(first.status(), StatusCode::CREATED);
        let again = send(state, "POST", Some(auth), Some(body)).await;
        assert_eq!(again.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn names_that_break_the_rules_are_refused_with_a_reason_and_create_nothing() {
        let state = fresh_state(|_| {}).await;
        let keys = Keys::generate();
        for (name, code) in [
            ("ab", "name_too_short"),
            ("a".repeat(33).as_str(), "name_too_long"),
            ("has_underscore", "name_bad_characters"),
            ("has.dot", "name_bad_characters"),
            ("-leading", "name_edge_hyphen"),
            ("xn--sneaky", "name_lookalike"),
            ("login", "name_reserved"),
            ("www", "name_reserved"),
        ] {
            let response = create(state.clone(), &keys, name).await;
            assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{name}");
            let json = read_json(response).await;
            assert_eq!(json["code"], code, "{name}");
            assert!(!exists(&state, &format!("{name}.{DOMAIN}")).await, "{name}");
        }
    }

    /// A client reads who owns a community from the published member list. A server that does not require membership
    /// used to publish none, so a creator's own client could not tell they were the owner and refused owner-only actions.
    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn the_creators_role_is_published_even_when_membership_is_not_required() {
        let state = fresh_state(|c| c.require_relay_membership = false).await;
        let owner = Keys::generate();
        let name = unique_name();
        let response = create(state.clone(), &owner, &name).await;
        assert_eq!(response.status(), StatusCode::CREATED);
        let community = buzz_core::CommunityId::from_uuid(
            read_json(response).await["community_id"]
                .as_str()
                .and_then(|id| id.parse().ok())
                .expect("community id"),
        );

        let list = state
            .db
            .query_events(&buzz_db::event::EventQuery {
                kinds: Some(vec![buzz_core::kind::KIND_NIP43_MEMBERSHIP_LIST as i32]),
                global_only: true,
                limit: Some(1),
                ..buzz_db::event::EventQuery::for_community(community)
            })
            .await
            .expect("query membership list")
            .into_iter()
            .next()
            .expect("a membership list was published");
        let owner_hex = owner.public_key().to_hex();
        assert!(
            list.event.tags.iter().any(|tag| {
                let v = tag.as_slice();
                v.first().is_some_and(|x| x == "member")
                    && v.get(1).is_some_and(|x| *x == owner_hex)
                    && v.get(2).is_some_and(|x| x == "owner")
            }),
            "the list must name the creator as owner"
        );
    }

    /// What a community's creator gets when they say nothing about who may join: an open one. When they ask for
    /// invite-only, a stranger is refused by the same check every way in shares, the creator is not, and the answer
    /// says so.
    /// Mutation: default `invite_only` to true in the handler → RED.
    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn a_new_community_is_open_unless_the_creator_asks_for_invite_only() {
        use crate::api::relay_members::{check_relay_membership_authoritative, MembershipDecision};

        let state = fresh_state(|c| c.require_relay_membership = false).await;
        let owner = Keys::generate();
        let stranger = Keys::generate();
        let community_of = |json: &Value| {
            buzz_core::CommunityId::from_uuid(
                json["community_id"]
                    .as_str()
                    .and_then(|id| id.parse().ok())
                    .expect("community id"),
            )
        };
        let decision = |community, keys: &Keys| {
            let state = state.clone();
            let pubkey = keys.public_key().to_bytes();
            async move {
                check_relay_membership_authoritative(&state, community, &pubkey, None, None)
                    .await
                    .expect("membership check")
            }
        };

        let silent = create(state.clone(), &owner, &unique_name()).await;
        assert_eq!(silent.status(), StatusCode::CREATED);
        let silent = read_json(silent).await;
        assert_eq!(silent["access"], "open");
        assert_eq!(
            decision(community_of(&silent), &stranger).await,
            MembershipDecision::OpenRelay
        );

        let private = create_with(
            state.clone(),
            &owner,
            serde_json::json!({ "name": unique_name(), "access": "invite_only" }),
        )
        .await;
        assert_eq!(private.status(), StatusCode::CREATED);
        let private = read_json(private).await;
        assert_eq!(private["access"], "invite_only");
        assert_eq!(
            decision(community_of(&private), &stranger).await,
            MembershipDecision::Denied
        );
        assert_eq!(
            decision(community_of(&private), &owner).await,
            MembershipDecision::Member,
            "the creator is the owner and always gets in"
        );
    }

    /// An unknown word for who may join is refused, and creates nothing. Guessing "closed" must never silently make a
    /// community that is open.
    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn an_unknown_access_choice_is_refused_and_creates_nothing() {
        let state = fresh_state(|_| {}).await;
        let name = unique_name();
        let response = create_with(
            state.clone(),
            &Keys::generate(),
            serde_json::json!({ "name": name, "access": "closed" }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(read_json(response).await["code"], "access_unknown");
        assert!(!exists(&state, &format!("{name}.{DOMAIN}")).await);
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn what_was_typed_is_trimmed_and_lowercased() {
        let state = fresh_state(|_| {}).await;
        let name = unique_name();
        let response = create(
            state.clone(),
            &Keys::generate(),
            &format!("  {}  ", name.to_uppercase()),
        )
        .await;
        assert_eq!(response.status(), StatusCode::CREATED);
        assert!(exists(&state, &format!("{name}.{DOMAIN}")).await);
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn the_hourly_cap_stops_a_script_that_makes_new_keys() {
        let state = fresh_state(|c| c.self_serve_max_per_hour = 1).await;
        let (a, b) = (unique_name(), unique_name());
        assert_eq!(
            create(state.clone(), &Keys::generate(), &a).await.status(),
            StatusCode::CREATED
        );

        // A different key, a different name, the same hour: refused, and nothing made.
        let response = create(state.clone(), &Keys::generate(), &b).await;
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(read_json(response).await["code"], "creation_busy");
        assert!(!exists(&state, &format!("{b}.{DOMAIN}")).await);
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn a_refused_name_does_not_use_up_the_hourly_cap() {
        let state = fresh_state(|c| c.self_serve_max_per_hour = 1).await;
        let taken = unique_name();
        let owner = Keys::generate();
        assert_eq!(
            create(state.clone(), &owner, &taken).await.status(),
            StatusCode::CREATED
        );
        // The cap of one is now used. Make room by releasing through a failed creation on a fresh state:
        let state = fresh_state(|c| c.self_serve_max_per_hour = 1).await;
        let other = Keys::generate();
        // A taken name fails after reserving a place, and must give it back.
        assert_eq!(
            create(state.clone(), &other, &taken).await.status(),
            StatusCode::CONFLICT
        );
        let free = unique_name();
        assert_eq!(
            create(state.clone(), &other, &free).await.status(),
            StatusCode::CREATED
        );
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn one_key_cannot_keep_guessing_names() {
        let state = fresh_state(|_| {}).await;
        let keys = Keys::generate();
        for _ in 0..super::ATTEMPTS_PER_SIGNER {
            let response = create(state.clone(), &keys, "ab").await;
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        }
        let response = create(state.clone(), &keys, &unique_name()).await;
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(read_json(response).await["code"], "too_many_attempts");
    }
}
