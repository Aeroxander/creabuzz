//! The sponsored-fee limit against a real database and a local stand-in for the operator's sponsor, through the real
//! handler. Ignored without infrastructure; run with
//! `cargo test -p buzz-relay --lib -- api::sponsor::postgres_tests --include-ignored --test-threads=1`.
//!
//! Each guard is switched off once and the test that names it fails: the exemption of exits (K8, K9), the three limits
//! (K1 to K3), the release when the upstream refuses (K4), the absent path (K5), the pins, the secrecy of the upstream (K7).

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::Response;
use serde_json::{json, Value};

use super::calldata::{self, Call};
use super::{sponsor, SponsorConfig, LIMIT_EXCEEDED, METHOD, NOT_ALLOWED};
use crate::handlers::room_support::{room_world_with, RoomWorld};

/// How the stand-in sponsor answers.
#[derive(Clone, Copy)]
enum Mode {
    Result,
    RpcError,
    ServerError,
}

struct Upstream {
    hits: Arc<AtomicUsize>,
    mode: Arc<Mutex<Mode>>,
    addr: std::net::SocketAddr,
    server: tokio::task::JoinHandle<()>,
}

impl Drop for Upstream {
    fn drop(&mut self) {
        self.server.abort();
    }
}

async fn upstream() -> Upstream {
    let hits = Arc::new(AtomicUsize::new(0));
    let mode = Arc::new(Mutex::new(Mode::Result));
    let (h, m) = (Arc::clone(&hits), Arc::clone(&mode));
    let app = axum::Router::new().fallback(move |body: axum::body::Bytes| {
        let (h, m) = (Arc::clone(&h), Arc::clone(&m));
        async move {
            h.fetch_add(1, Ordering::SeqCst);
            let id = serde_json::from_slice::<Value>(&body).ok().and_then(|v| v.get("id").cloned()).unwrap_or(Value::Null);
            let mode = *m.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            match mode {
                Mode::Result => (StatusCode::OK, axum::Json(json!({ "jsonrpc": "2.0", "id": id, "result": { "callGasLimit": "0x5208" } }))),
                Mode::RpcError => (StatusCode::OK, axum::Json(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32500, "message": "policy refused" } }))),
                Mode::ServerError => (StatusCode::INTERNAL_SERVER_ERROR, axum::Json(json!({ "error": "down" }))),
            }
        }
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    Upstream {
        hits,
        mode,
        addr,
        server,
    }
}

impl Upstream {
    fn url(&self) -> String {
        format!("http://{}/sponsor-upstream", self.addr)
    }
    fn hits(&self) -> usize {
        self.hits.load(Ordering::SeqCst)
    }
    fn answer(&self, mode: Mode) {
        *self
            .mode
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = mode;
    }
}

const TREASURY: [u8; 20] = [0x11; 20];

/// A world whose chain reader follows one Treasury and one Shares token, and whose sponsor is `configure`d.
async fn world(upstream_url: &str, configure: impl FnOnce(&mut SponsorConfig)) -> RoomWorld {
    let mut config = SponsorConfig::for_test(upstream_url);
    configure(&mut config);
    let w = room_world_with(true, move |c| c.sponsor = Some(config)).await;
    for (address, role) in [(TREASURY, "treasury"), ([0x22u8; 20], "shares")] {
        sqlx::query("INSERT INTO chain_contracts (reader, address, role, project_key, from_block) VALUES ($1, $2, $3, $4, 1)")
            .bind(&w.reader)
            .bind(address.as_slice())
            .bind(role)
            .bind(w.key.as_slice())
            .execute(w.state.db.pool())
            .await
            .expect("a followed contract");
    }
    w
}

fn text(address: &[u8; 20]) -> String {
    format!("0x{}", hex::encode(address))
}

fn call(to: [u8; 20], signature: &str) -> Call {
    let mut data = calldata::selector(signature).to_vec();
    data.extend_from_slice(&[0u8; 96]);
    Call {
        to,
        value: [0u8; 32],
        data,
    }
}

fn back() -> Vec<Call> {
    vec![call(TREASURY, "join(uint256,uint256,address)")]
}

fn exit() -> Vec<Call> {
    vec![call(TREASURY, calldata::LEAVE_SIGNATURE)]
}

fn body(sender: &[u8; 20], calls: &[Call]) -> Vec<u8> {
    json!({ "jsonrpc": "2.0", "id": 9, "method": METHOD, "params": [{
        "chainId": 31337,
        "userOp": { "sender": text(sender), "callData": format!("0x{}", hex::encode(calldata::encode(calls))) },
        "entryPointAddress": "0x0000000071727de22e5e9d8baf0edac6f37da032",
    }] })
    .to_string()
    .into_bytes()
}

/// A network of the test's own, so the per-address counts of one run never meet another's.
fn fresh_net() -> String {
    format!("10.{}.{}", rand::random::<u8>(), rand::random::<u8>())
}

fn new_sender() -> [u8; 20] {
    rand::random()
}

async fn ask(w: &RoomWorld, address: &str, bytes: Vec<u8>) -> (StatusCode, Value) {
    let mut headers = HeaderMap::new();
    headers.insert(
        "x-forwarded-for",
        HeaderValue::from_str(address).expect("header"),
    );
    let response: Response = sponsor(
        State(Arc::clone(&w.state)),
        headers,
        axum::body::Body::from(bytes),
    )
    .await;
    let status = response.status();
    let body = axum::body::to_bytes(response.into_body(), 1 << 20)
        .await
        .expect("body");
    (status, serde_json::from_slice(&body).unwrap_or(Value::Null))
}

fn refusal(answer: &(StatusCode, Value)) -> Option<&str> {
    answer.1["error"]["message"].as_str()
}

async fn used(w: &RoomWorld, key: &str) -> i64 {
    sqlx::query_scalar("SELECT coalesce(sum(count), 0)::bigint FROM sponsor_usage WHERE day = (now() AT TIME ZONE 'UTC')::date AND key = $1")
        .bind(key)
        .fetch_one(w.state.db.pool())
        .await
        .expect("count")
}

/// K1: a sender has `per_account_per_day` operations; the next is refused with a word the app knows; another sender is not
/// affected; nothing reaches the upstream for a refused one.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn k1_the_per_account_limit() {
    let net = fresh_net();
    let up = upstream().await;
    let w = world(&up.url(), |c| c.per_account_per_day = 3).await;
    let sender = new_sender();
    for _ in 0..3 {
        let answer = ask(&w, &format!("{net}.1"), body(&sender, &back())).await;
        assert!(answer.1.get("result").is_some(), "{answer:?}");
    }
    let refused = ask(&w, &format!("{net}.1"), body(&sender, &back())).await;
    assert_eq!(
        (refused.0, refusal(&refused)),
        (StatusCode::OK, Some(LIMIT_EXCEEDED))
    );
    assert_eq!(refused.1["id"], 9, "the id is echoed");
    assert_eq!(up.hits(), 3, "the refused one never reached the sponsor");
    assert!(
        ask(&w, &format!("{net}.1"), body(&new_sender(), &back()))
            .await
            .1
            .get("result")
            .is_some(),
        "another sender"
    );
}

/// K2: the whole server has `total_per_day` (a new passkey is a new account, so a per-account limit alone can be farmed).
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn k2_the_server_wide_limit() {
    let net = fresh_net();
    let up = upstream().await;
    let w = world(&up.url(), |c| c.total_per_day = 3).await;
    for i in 0..3 {
        let answer = ask(&w, &format!("{net}.{i}"), body(&new_sender(), &back())).await;
        assert!(answer.1.get("result").is_some(), "{answer:?}");
    }
    let refused = ask(&w, &format!("{net}.50"), body(&new_sender(), &back())).await;
    assert_eq!(refusal(&refused), Some(LIMIT_EXCEEDED));
    assert_eq!(up.hits(), 3);
}

/// K3: one client address has `per_ip_per_day`; another address is not affected.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn k3_the_per_address_limit() {
    let net = fresh_net();
    let up = upstream().await;
    let w = world(&up.url(), |c| c.per_ip_per_day = 2).await;
    let address = format!("{net}.1");
    for _ in 0..2 {
        assert!(ask(&w, &address, body(&new_sender(), &back()))
            .await
            .1
            .get("result")
            .is_some());
    }
    assert_eq!(
        refusal(&ask(&w, &address, body(&new_sender(), &back())).await),
        Some(LIMIT_EXCEEDED)
    );
    let other = format!("{}.1", fresh_net());
    assert!(ask(&w, &other, body(&new_sender(), &back()))
        .await
        .1
        .get("result")
        .is_some());
}

/// K4: a count is given back when the upstream refuses, fails, or cannot be reached; and the answer to the app is the
/// upstream's own (or a plain one).
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn k4_the_reservation_is_released_when_the_upstream_refuses_or_fails() {
    let net = fresh_net();
    let up = upstream().await;
    let w = world(&up.url(), |c| c.per_account_per_day = 2).await;
    let sender = new_sender();
    let key = format!("acct:{}", text(&sender));
    up.answer(Mode::RpcError);
    for _ in 0..4 {
        let answer = ask(&w, &format!("{net}.9"), body(&sender, &back())).await;
        assert_eq!(
            answer.1["error"]["message"], "policy refused",
            "the sponsor's own refusal reaches the app"
        );
        assert_eq!(used(&w, &key).await, 0, "given back");
    }
    up.answer(Mode::ServerError);
    let answer = ask(&w, &format!("{net}.9"), body(&sender, &back())).await;
    assert_eq!(answer.0, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(used(&w, &key).await, 0);
    // A sponsor that cannot be reached.
    let gone = world("http://127.0.0.1:1/never", |c| c.per_account_per_day = 2).await;
    let answer = ask(&gone, &format!("{net}.9"), body(&sender, &back())).await;
    assert_eq!(answer.0, StatusCode::BAD_GATEWAY);
    assert_eq!(used(&gone, &key).await, 0);
    // Success keeps the count.
    up.answer(Mode::Result);
    assert!(ask(&w, &format!("{net}.9"), body(&sender, &back()))
        .await
        .1
        .get("result")
        .is_some());
    assert_eq!(used(&w, &key).await, 1);
}

/// K5: with no upstream the path is absent (404 from the router); with one it exists.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn k5_without_an_upstream_the_path_is_absent() {
    use tower::ServiceExt;
    let request =
        |host: &str| {
            let mut request = axum::http::Request::builder()
                .method("POST")
                .uri("/sponsor")
                .header("host", host)
                .body(axum::body::Body::from("{}"))
                .expect("request");
            // The router's internal-only guard reads the peer's address; a request made in a test has none of its own.
            request.extensions_mut().insert(axum::extract::ConnectInfo(
                std::net::SocketAddr::from(([127, 0, 0, 1], 9)),
            ));
            request
        };
    let off = crate::test_support::test_state().await;
    assert!(off.config.sponsor.is_none());
    let host = format!("sponsor-off-{}.example", uuid::Uuid::new_v4().simple());
    off.db
        .ensure_configured_community(&host)
        .await
        .expect("community");
    let response = crate::router::build_router(off)
        .oneshot(request(&host))
        .await
        .expect("response");
    let status = response.status();
    let shown = axum::body::to_bytes(response.into_body(), 1 << 12)
        .await
        .unwrap_or_default();
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "the path does not exist: {}",
        String::from_utf8_lossy(&shown)
    );
    let up = upstream().await;
    let w = world(&up.url(), |_| {}).await;
    let on_host = format!("sponsor-on-{}.example", uuid::Uuid::new_v4().simple());
    w.state
        .db
        .ensure_configured_community(&on_host)
        .await
        .expect("community");
    let response = crate::router::build_router(Arc::clone(&w.state))
        .oneshot(request(&on_host))
        .await
        .expect("response");
    assert_eq!(
        response.status(),
        StatusCode::OK,
        "with an upstream the path answers (here: a refusal)"
    );
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 16)
        .await
        .expect("body");
    let value: Value = serde_json::from_slice(&bytes).expect("JSON-RPC");
    assert_eq!(value["error"]["message"], NOT_ALLOWED);
    assert_eq!(up.hits(), 0);
}

/// K7: the upstream's address is never in an answer or in what is printed.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn k7_the_upstreams_address_never_appears() {
    let net = fresh_net();
    let w = world("http://127.0.0.1:1/very-secret-key-4711", |c| {
        c.per_account_per_day = 1
    })
    .await;
    let sender = new_sender();
    let down = ask(&w, &format!("{net}.20"), body(&sender, &back())).await;
    let limit = {
        // Use the count the failed forward gave back, then spend it by a request the unreachable upstream cannot take.
        let w2 = world("http://127.0.0.1:1/very-secret-key-4711", |c| {
            c.per_account_per_day = 1
        })
        .await;
        sqlx::query("INSERT INTO sponsor_usage (day, key, count) VALUES ((now() AT TIME ZONE 'UTC')::date, $1, 1) ON CONFLICT (day, key) DO UPDATE SET count = 1")
            .bind(format!("acct:{}", text(&sender)))
            .execute(w2.state.db.pool())
            .await
            .expect("use the day");
        ask(&w2, &format!("{net}.20"), body(&sender, &back())).await
    };
    let pinned = ask(&w, &format!("{net}.20"), b"[]".to_vec()).await;
    for answer in [&down, &limit, &pinned] {
        let shown = answer.1.to_string();
        assert!(
            !shown.contains("very-secret-key-4711") && !shown.contains("127.0.0.1"),
            "{shown}"
        );
    }
    assert_eq!(refusal(&limit), Some(LIMIT_EXCEEDED));
    let config = w.state.config.sponsor.as_ref().expect("sponsor");
    assert!(!format!("{config:?}").contains("very-secret-key-4711"));
}

/// The pins through the handler: a method other than the one, a batch array, a body over 32 KB, another chain and a
/// target that is off the list are refused with "not allowed" and never reach the upstream.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn the_pins_hold_through_the_handler() {
    let net = fresh_net();
    let up = upstream().await;
    let w = world(&up.url(), |_| {}).await;
    let sender = new_sender();
    let good = body(&sender, &back());
    let mut other_method: Value = serde_json::from_slice(&good).expect("json");
    other_method["method"] = json!("eth_sendUserOperation");
    let batch = json!([serde_json::from_slice::<Value>(&good).expect("json")]);
    let mut huge = good.clone();
    huge.resize(super::BODY_MAX + 10, b' ');
    let mut other_chain: Value = serde_json::from_slice(&good).expect("json");
    other_chain["params"][0]["chainId"] = json!(1);
    let off_list = body(
        &sender,
        &[call([0x99; 20], "join(uint256,uint256,address)")],
    );
    for (what, request) in [
        ("another method", other_method.to_string().into_bytes()),
        ("a batch", batch.to_string().into_bytes()),
        ("a body over 32 KB", huge),
        ("another chain", other_chain.to_string().into_bytes()),
        ("a target off the list", off_list),
        ("nothing", Vec::new()),
    ] {
        let answer = ask(&w, &format!("{net}.30"), request).await;
        assert_eq!(
            (answer.0, refusal(&answer)),
            (StatusCode::OK, Some(NOT_ALLOWED)),
            "{what}"
        );
    }
    assert_eq!(up.hits(), 0);
}

/// K8: an exit is never counted against a person or the server and never refused by those limits, even with both used up;
/// it meets only the address cap.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn k8_an_exit_is_never_counted_or_refused_by_the_person_or_server_limit() {
    let net = fresh_net();
    let up = upstream().await;
    let w = world(&up.url(), |c| {
        c.per_account_per_day = 1;
        c.total_per_day = 1;
        c.exit_per_ip_per_day = 3;
    })
    .await;
    let sender = new_sender();
    let acct = format!("acct:{}", text(&sender));
    let all = format!("all:{}", w.reader);
    let address = format!("{net}.1");
    assert!(
        ask(&w, &address, body(&sender, &back()))
            .await
            .1
            .get("result")
            .is_some(),
        "the one allowed back"
    );
    assert_eq!(
        refusal(&ask(&w, &address, body(&sender, &back())).await),
        Some(LIMIT_EXCEEDED),
        "both limits are used up"
    );
    let before = (used(&w, &acct).await, used(&w, &all).await);
    assert_eq!(before, (1, 1));
    // Exits go through, one call or a batch of take outs, and count only against the address.
    let batch = vec![
        call(TREASURY, calldata::LEAVE_SIGNATURE),
        call(TREASURY, calldata::LEAVE_TEAM_SIGNATURE),
    ];
    for calls in [exit(), exit(), batch] {
        let answer = ask(&w, &address, body(&sender, &calls)).await;
        assert!(
            answer.1.get("result").is_some(),
            "an exit passes with both limits used up: {answer:?}"
        );
    }
    assert_eq!(
        (used(&w, &acct).await, used(&w, &all).await),
        before,
        "an exit counts against neither"
    );
    assert_eq!(used(&w, &format!("exit-ip:{address}")).await, 3);
    // The one limit an exit meets is its own address's.
    assert_eq!(
        refusal(&ask(&w, &address, body(&sender, &exit())).await),
        Some(LIMIT_EXCEEDED)
    );
    let other = format!("{net}.2");
    assert!(
        ask(&w, &other, body(&sender, &exit()))
            .await
            .1
            .get("result")
            .is_some(),
        "another address is not affected"
    );
    // An exit is a take out and nothing else: one other call in the batch makes it an ordinary operation again.
    let mixed = vec![
        call(TREASURY, calldata::LEAVE_SIGNATURE),
        call([0x22; 20], "approve(address,uint256)"),
    ];
    assert_eq!(
        refusal(&ask(&w, &other, body(&sender, &mixed)).await),
        Some(LIMIT_EXCEEDED)
    );
}

/// K9: ten requests naming a victim's `sender` with an ordinary call use up that sender's day and leave the victim's exit
/// working (the limit that stays, and the exemption that keeps leaving open).
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn k9_a_stranger_can_use_up_a_victims_day_but_never_the_victims_exit() {
    let net = fresh_net();
    let up = upstream().await;
    let w = world(&up.url(), |_| {}).await;
    let victim = new_sender();
    for i in 0..10 {
        let answer = ask(&w, &format!("{net}.{}", 100 + i), body(&victim, &back())).await;
        assert!(answer.1.get("result").is_some(), "{answer:?}");
    }
    let refused = ask(&w, &format!("{net}.200"), body(&victim, &back())).await;
    assert_eq!(
        refusal(&refused),
        Some(LIMIT_EXCEEDED),
        "the victim's ordinary day is used up"
    );
    let leaving = ask(&w, &format!("{net}.250"), body(&victim, &exit())).await;
    assert!(
        leaving.1.get("result").is_some(),
        "but the victim can still take their money out: {leaving:?}"
    );
}

/// The allow-list is read from the reader's own contract rows: a Treasury is an exit target and a holder pause is where
/// an exit may first take Shares back (`unpark`). Remove the `"pause"` arm of `read_allowed` and the pause is missing,
/// so a call sequence `[unpark, leave]` would no longer count as an exit on a live server.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn the_allow_list_has_the_treasuries_and_the_pauses_of_the_reader_and_no_others() {
    let state = crate::test_support::test_state().await;
    let pool = state.db.pool();
    let reader = format!("sponsor-allowed-{}", uuid::Uuid::new_v4().simple());
    let other = format!("sponsor-allowed-{}", uuid::Uuid::new_v4().simple());
    for (reader, address, role) in [
        (&reader, [0x11u8; 20], "treasury"),
        (&reader, [0x22u8; 20], "pause"),
        (&reader, [0x33u8; 20], "shares"),
        (&other, [0x44u8; 20], "pause"),
    ] {
        sqlx::query(
            "INSERT INTO chain_contracts (reader, address, role, project_key, from_block) VALUES ($1, $2, $3, NULL, 0)",
        )
        .bind(reader)
        .bind(address.as_slice())
        .bind(role)
        .execute(pool)
        .await
        .expect("a contract row");
    }
    let launcher = [0x99u8; 20];
    let allowed = super::read_allowed(pool, &reader, &launcher)
        .await
        .expect("the allow-list reads");
    assert_eq!(allowed.treasuries, vec![[0x11u8; 20]]);
    assert_eq!(allowed.pauses, vec![[0x22u8; 20]]);
    assert!(allowed.targets.contains(&launcher));
    for address in [[0x11u8; 20], [0x22u8; 20], [0x33u8; 20]] {
        assert!(allowed.targets.contains(&address));
    }
    assert!(
        !allowed.targets.contains(&[0x44u8; 20]),
        "another reader's contract is not this reader's"
    );
    // An unpark of that pause followed by a leave is the one exit that may begin with another call.
    let calls = [
        Call {
            to: [0x22u8; 20],
            value: [0u8; 32],
            data: {
                let mut data = calldata::selector(calldata::UNPARK_SIGNATURE).to_vec();
                data.extend_from_slice(&[0u8; 32]);
                data
            },
        },
        Call {
            to: [0x11u8; 20],
            value: [0u8; 32],
            data: {
                let mut data = calldata::selector(calldata::LEAVE_SIGNATURE).to_vec();
                data.extend_from_slice(&[0u8; 96]);
                data
            },
        },
    ];
    assert!(calldata::is_exit(
        &calls,
        &allowed.treasuries,
        &allowed.pauses
    ));
}

/// The Council round (COUNCIL-PLAN.md section 5.6): the Council the reader follows (`role` `council`, migration 0077) and
/// the vote contract (the project's pause) are both on the allow-list, so a passkey account's presses on them are ordinary
/// sponsored operations -- on the list by address, never exits -- and the exit rule is still `[unpark, leave]` with the
/// vote contract standing in for the pause. Remove the role from the list (or the migration's role) and the Council's
/// presses are refused here.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn the_allow_list_has_the_councils_and_the_vote_contract_of_the_reader() {
    let state = crate::test_support::test_state().await;
    let pool = state.db.pool();
    let reader = format!("sponsor-council-{}", uuid::Uuid::new_v4().simple());
    let treasury = [0x11u8; 20];
    let vote = [0x22u8; 20];
    let council = [0x55u8; 20];
    for (address, role) in [
        (treasury, "treasury"),
        (vote, "pause"),
        (council, "council"),
    ] {
        sqlx::query(
            "INSERT INTO chain_contracts (reader, address, role, project_key, from_block) VALUES ($1, $2, $3, NULL, 0)",
        )
        .bind(&reader)
        .bind(address.as_slice())
        .bind(role)
        .execute(pool)
        .await
        .expect("a contract row");
    }
    let allowed = super::read_allowed(pool, &reader, &[0x99u8; 20])
        .await
        .expect("the allow-list reads");
    assert!(
        allowed.targets.contains(&council),
        "the Council is followed"
    );
    assert_eq!(allowed.pauses, vec![vote], "the vote contract is the pause");
    // Every Council round press is an ordinary operation the sponsor lets through.
    for (to, signature) in [
        (vote, "stand(bytes32)"),
        (vote, "standList(address[5],bytes32)"),
        (vote, "openReplace(address[5],bytes32)"),
        (vote, "castVote(uint8)"),
        (council, "propose(address,bytes)"),
        (council, "agree(bytes32)"),
        (council, "withdraw(bytes32)"),
    ] {
        let parsed = super::classify(
            &body(&new_sender(), &[call(to, signature)]),
            31337,
            &allowed,
        )
        .unwrap_or_else(|_| panic!("{signature} is a followed contract's press"));
        assert!(!parsed.exit, "{signature} is not an exit");
    }
    // The exit rule is unchanged: `[unpark, leave]` is an exit against this vote contract and Treasury.
    let unpark = Call {
        to: vote,
        value: [0u8; 32],
        data: {
            let mut data = calldata::selector(calldata::UNPARK_SIGNATURE).to_vec();
            data.extend_from_slice(&[0u8; 32]);
            data
        },
    };
    let leave = Call {
        to: treasury,
        value: [0u8; 32],
        data: calldata::selector(calldata::LEAVE_SIGNATURE).to_vec(),
    };
    assert!(
        super::classify(
            &body(&new_sender(), &[unpark.clone(), leave]),
            31337,
            &allowed
        )
        .expect("passes")
        .exit,
        "a take out of parked Shares stays an exit with a ballot live"
    );
    assert!(
        !super::classify(&body(&new_sender(), &[unpark]), 31337, &allowed)
            .expect("passes")
            .exit,
        "an unpark alone counts like any other operation"
    );
}
