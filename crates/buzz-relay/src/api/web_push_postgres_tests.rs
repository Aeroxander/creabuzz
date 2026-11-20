//! The subscription paths against a real database, through the handlers: each needs a signed request, a bad subscription
//! writes nothing, the cap holds, a person removes their own devices, and a server with push off answers "not switched
//! on". Ignored without infrastructure; run with
//! `cargo test -p buzz-relay --lib -- api::web_push::postgres_tests --include-ignored --test-threads=1`.

use std::sync::Arc;

use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use base64::engine::general_purpose::{STANDARD as B64_STD, URL_SAFE_NO_PAD as B64};
use base64::Engine;
use nostr::{EventBuilder, JsonUtil, Keys, Kind, Tag};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::{delete, put, PATH};
use crate::state::AppState;
use crate::web_push::store::endpoint_hash;
use crate::web_push::test_support::{config_for, StandIn};

/// A state with push on (or off), and a community to call it as.
async fn server(on: bool) -> (Arc<AppState>, String, uuid::Uuid) {
    let extra = vec!["127.0.0.1:34999".to_owned()];
    let state = crate::test_support::test_state_with(move |c| {
        c.web_push = on.then(|| config_for(extra));
    })
    .await;
    let host = format!("push-api-{}.example", Uuid::new_v4().simple());
    let id = state
        .db
        .ensure_configured_community(&host)
        .await
        .expect("community")
        .id;
    (state, host, *id.as_uuid())
}

/// The headers of a request signed by `keys` (NIP-98), unless `signed` is false.
fn headers(
    state: &AppState,
    host: &str,
    keys: &Keys,
    method: &str,
    body: &[u8],
    signed: bool,
) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert("host", HeaderValue::from_str(host).expect("host"));
    if signed {
        let scheme = if state.config.relay_url.starts_with("wss://") {
            "https"
        } else {
            "http"
        };
        // A nonce, so two requests of one second with one body are two requests (an event's id is its content's hash).
        let mut tags = vec![
            Tag::parse(["u", &format!("{scheme}://{host}{PATH}")]).expect("tag"),
            Tag::parse(["method", method]).expect("tag"),
            Tag::parse(["nonce", &Uuid::new_v4().to_string()]).expect("tag"),
        ];
        if !body.is_empty() {
            tags.push(Tag::parse(["payload", &hex::encode(Sha256::digest(body))]).expect("tag"));
        }
        let event = EventBuilder::new(Kind::HttpAuth, "")
            .tags(tags)
            .sign_with_keys(keys)
            .expect("sign");
        headers.insert(
            "authorization",
            HeaderValue::from_str(&format!("Nostr {}", B64_STD.encode(event.as_json())))
                .expect("header"),
        );
    }
    headers
}

fn subscription(endpoint: &str, device: &crate::web_push::test_support::Device) -> Vec<u8> {
    serde_json::json!({
        "endpoint": endpoint,
        "keys": { "p256dh": B64.encode(device.p256dh), "auth": B64.encode(device.auth) },
    })
    .to_string()
    .into_bytes()
}

async fn rows(state: &AppState, community: uuid::Uuid, keys: &Keys) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM web_push_subscriptions WHERE community_id = $1 AND pubkey = $2",
    )
    .bind(community)
    .bind(keys.public_key().to_bytes().as_slice())
    .fetch_one(state.db.pool())
    .await
    .expect("count")
}

async fn call(
    state: &Arc<AppState>,
    host: &str,
    keys: &Keys,
    method: &str,
    body: Vec<u8>,
    signed: bool,
) -> StatusCode {
    let h = headers(state, host, keys, method, &body, signed);
    let bytes = axum::body::Bytes::from(body);
    let response = if method == "PUT" {
        put(State(Arc::clone(state)), h, bytes).await
    } else {
        delete(State(Arc::clone(state)), h, bytes).await
    };
    response.status()
}

/// P3 (the paths): with push off both paths answer "not switched on" and write nothing, even for a signed request.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn p3_a_server_with_push_off_answers_not_switched_on() {
    let (state, host, community) = server(false).await;
    let stand_in = StandIn::start(vec![]).await;
    let (keys, device) = (Keys::generate(), stand_in.device());
    let body = subscription(&device.endpoint, &device);
    assert_eq!(
        call(&state, &host, &keys, "PUT", body, true).await,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(&state, &host, &keys, "DELETE", Vec::new(), true).await,
        StatusCode::NOT_FOUND
    );
    assert_eq!(rows(&state, community, &keys).await, 0);
}

/// P6: the paths need a signed request; a signed one keeps and removes; a repeated request is a replay.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn p6_the_paths_need_a_signed_request_and_a_person_removes_their_own_devices() {
    let (state, host, community) = server(true).await;
    let stand_in = StandIn::start(vec![]).await;
    let (alice, bob) = (Keys::generate(), Keys::generate());
    let (one, two) = (stand_in.device(), stand_in.device());
    // The stand-in's host is the one the operator listed in `server` only when the port matches; use the config's own.
    let extra = state
        .config
        .web_push
        .as_ref()
        .expect("on")
        .extra_hosts
        .clone();
    assert_eq!(extra, vec!["127.0.0.1:34999".to_owned()]);
    let listed = |device: &crate::web_push::test_support::Device| {
        device
            .endpoint
            .replace(&stand_in.addr.to_string(), "127.0.0.1:34999")
    };
    // Unsigned: refused, nothing written.
    assert_eq!(
        call(
            &state,
            &host,
            &alice,
            "PUT",
            subscription(&listed(&one), &one),
            false
        )
        .await,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call(&state, &host, &alice, "DELETE", Vec::new(), false).await,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(rows(&state, community, &alice).await, 0);
    // Signed: kept.
    assert_eq!(
        call(
            &state,
            &host,
            &alice,
            "PUT",
            subscription(&listed(&one), &one),
            true
        )
        .await,
        StatusCode::OK
    );
    assert_eq!(
        call(
            &state,
            &host,
            &alice,
            "PUT",
            subscription(&listed(&two), &two),
            true
        )
        .await,
        StatusCode::OK
    );
    assert_eq!(
        call(
            &state,
            &host,
            &bob,
            "PUT",
            subscription(&listed(&one), &one),
            true
        )
        .await,
        StatusCode::OK
    );
    assert_eq!(
        (
            rows(&state, community, &alice).await,
            rows(&state, community, &bob).await
        ),
        (2, 1)
    );
    // A request signed for another body is not this body: the payload hash binds it.
    let tampered = {
        let signed_for = subscription(&listed(&one), &one);
        let h = headers(&state, &host, &alice, "PUT", &signed_for, true);
        put(
            State(Arc::clone(&state)),
            h,
            axum::body::Bytes::from(subscription(&listed(&two), &two)),
        )
        .await
        .status()
    };
    assert_eq!(tampered, StatusCode::UNAUTHORIZED);
    // A signed request cannot be played twice.
    let body = subscription(&listed(&one), &one);
    let h = headers(&state, &host, &alice, "PUT", &body, true);
    assert_eq!(
        put(
            State(Arc::clone(&state)),
            h.clone(),
            axum::body::Bytes::from(body.clone())
        )
        .await
        .status(),
        StatusCode::OK
    );
    assert_eq!(
        put(State(Arc::clone(&state)), h, axum::body::Bytes::from(body))
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    // Removing one device by its address, then all of one's own; Bob's stay.
    let by_address = serde_json::json!({ "endpoint": listed(&one) })
        .to_string()
        .into_bytes();
    assert_eq!(
        call(&state, &host, &alice, "DELETE", by_address, true).await,
        StatusCode::OK
    );
    assert_eq!(rows(&state, community, &alice).await, 1);
    assert_eq!(
        call(&state, &host, &alice, "DELETE", Vec::new(), true).await,
        StatusCode::OK
    );
    assert_eq!(
        (
            rows(&state, community, &alice).await,
            rows(&state, community, &bob).await
        ),
        (0, 1)
    );
    let kept: Vec<u8> = sqlx::query_scalar(
        "SELECT endpoint_hash FROM web_push_subscriptions WHERE community_id = $1 AND pubkey = $2",
    )
    .bind(community)
    .bind(bob.public_key().to_bytes().as_slice())
    .fetch_one(state.db.pool())
    .await
    .expect("bob's");
    assert_eq!(kept, endpoint_hash(&listed(&one)).to_vec());
}

/// P4: every bad subscription is refused at the path and writes nothing; P5: the cap holds through the path.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn p4_and_p5_a_bad_subscription_writes_nothing_and_the_cap_holds_through_the_path() {
    let (state, host, community) = server(true).await;
    let stand_in = StandIn::start(vec![]).await;
    let keys = Keys::generate();
    let device = stand_in.device();
    let good = "https://fcm.googleapis.com/fcm/send/abc";
    for bad in [
        "http://fcm.googleapis.com/x",
        "https://user:pw@fcm.googleapis.com/x",
        "https://example.com/x",
        "https://127.0.0.1:35000/x",
        "https://169.254.169.254/x",
    ] {
        let status = call(
            &state,
            &host,
            &keys,
            "PUT",
            subscription(bad, &device),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{bad}");
    }
    let mut off_curve = device.clone();
    off_curve.p256dh[64] ^= 1;
    assert_eq!(
        call(
            &state,
            &host,
            &keys,
            "PUT",
            subscription(good, &off_curve),
            true
        )
        .await,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        rows(&state, community, &keys).await,
        0,
        "nothing was written"
    );
    // The cap: the operator's default is 5; the sixth address pushes the first out.
    let capped = Keys::generate();
    for i in 0..6 {
        let status = call(
            &state,
            &host,
            &capped,
            "PUT",
            subscription(&format!("https://fcm.googleapis.com/fcm/send/{i}"), &device),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{i}");
    }
    assert_eq!(rows(&state, community, &capped).await, 5);
}

/// The information document carries the public half of the key only when push is on, and `smartAccountLinks` whenever a
/// chain reader is configured.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn the_information_document_says_webpush_only_when_on_and_whether_phone_links_can_be_checked()
{
    let served = |on: bool, reader: bool, rpc: bool| async move {
        let config = config_for(Vec::new());
        let expected = config.vapid.public_base64url();
        let state = crate::test_support::test_state_with(move |c| {
            c.web_push = on.then_some(config);
            c.chain_reader = reader.then(crate::web_push::test_support::reader_config);
            c.evm_auth = rpc.then(|| crate::config::EvmAuthConfig {
                chain_id: Some(31337),
                erc6492_validator: None,
                rpc_url: Some("http://127.0.0.1:1".to_owned()),
                enforce_attestation: false,
            });
        })
        .await;
        let host = format!("info-{}.example", Uuid::new_v4().simple());
        (
            serde_json::to_value(crate::nip11::nip11_document(&state, &host).await).expect("JSON"),
            expected,
        )
    };
    let (off, _) = served(false, false, false).await;
    assert!(
        off.get("webPush").is_none() && off.get("smartAccountLinks").is_none(),
        "{off}"
    );
    let (on, key) = served(true, true, false).await;
    assert_eq!(on["webPush"], serde_json::json!({ "publicKey": key }));
    assert_eq!(
        on["smartAccountLinks"], false,
        "a reader with no chain connection for phone links says so"
    );
    assert_eq!(B64.decode(key).expect("base64url").len(), 65);
    let (linked, _) = served(false, true, true).await;
    assert!(linked.get("webPush").is_none());
    assert_eq!(linked["smartAccountLinks"], true);
}

/// I3 (the path): on a server that reads the chain, an account with no linked wallet is refused with a sentence and
/// writes nothing; one that linked a wallet keeps its device.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn i3_on_a_server_that_reads_the_chain_only_an_account_with_a_linked_wallet_keeps_a_device() {
    let pw = crate::web_push::test_support::push_world().await;
    let (state, host, community) = (
        Arc::clone(&pw.w.state),
        pw.w.tenant.host().to_owned(),
        *pw.w.tenant.community().as_uuid(),
    );
    let device = pw.stand_in.device();
    let body = subscription(&device.endpoint, &device);
    let stranger = pw.w.account().await;
    assert_eq!(
        call(&state, &host, &stranger, "PUT", body.clone(), true).await,
        StatusCode::FORBIDDEN,
        "an account with no linked wallet keeps no device"
    );
    assert_eq!(rows(&state, community, &stranger).await, 0);
    let holder = pw.w.account().await;
    pw.w.link(&holder, 3, 3_600).await.expect("the link");
    assert_eq!(
        call(&state, &host, &holder, "PUT", body, true).await,
        StatusCode::OK
    );
    assert_eq!(rows(&state, community, &holder).await, 1);
}
