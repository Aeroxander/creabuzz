//! Production-seam tests for anonymous P2P signaling (`BUZZ_P2P_SIGNALING=1`).
//!
//! An unauthenticated socket may take part in Trystero-style rendezvous, but
//! only through the allowlist in [`crate::p2p_signaling`]: it must not be able
//! to subscribe to channel-less presence (kind 20001 — every member's pubkey
//! and online state), write presence for throwaway keys, hold unbounded
//! subscriptions, or flood EVENTs. Each test drives the real `handle_req` /
//! `handle_event` on a connection that never authenticated.
//!
//! Run with `cargo test -p buzz-relay --lib p2p_anon -- --include-ignored`
//! (needs `DATABASE_URL` and `REDIS_URL`).

use std::collections::HashMap;
use std::sync::atomic::AtomicU8;
use std::sync::Arc;

use axum::extract::ws::Message;
use buzz_core::kind::{KIND_PRESENCE_UPDATE, KIND_STREAM_MESSAGE};
use buzz_core::TenantContext;
use nostr::{Alphabet, EventBuilder, Filter, Keys, Kind, SingleLetterTag, Tag};
use serde_json::Value;
use tokio::sync::{mpsc, Mutex};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::connection::{AuthState, ConnectionState};
use crate::p2p_signaling::P2pSignalingPolicy;
use crate::state::AppState;

/// A kind Trystero could derive for some topic: ephemeral, not a Buzz kind.
const TRYSTERO_KIND: u16 = 25_321;

struct Rig {
    state: Arc<AppState>,
    tenant: TenantContext,
}

async fn rig(max_subscriptions: usize, frames_per_minute: u32) -> Rig {
    let state = crate::test_support::test_state_with(|config| {
        config.p2p_signaling = true;
        config.p2p_signaling_policy = P2pSignalingPolicy::from_values(
            None,
            Some(&max_subscriptions.to_string()),
            Some(&frames_per_minute.to_string()),
        )
        .expect("test policy");
    })
    .await;
    let host = format!("p2p-anon-{}.example", Uuid::new_v4().simple());
    let community = state
        .db
        .ensure_configured_community(&host)
        .await
        .expect("create community")
        .id;
    Rig {
        state,
        tenant: TenantContext::resolved(community, host),
    }
}

/// A connection that never authenticated, registered so live fan-out can
/// reach it.
fn anonymous_connection(rig: &Rig) -> (Arc<ConnectionState>, mpsc::Receiver<Message>) {
    let (send_tx, rx) = mpsc::channel(256);
    let (ctrl_tx, _ctrl_rx) = mpsc::channel(4);
    let conn_id = Uuid::new_v4();
    let backpressure = Arc::new(AtomicU8::new(0));
    let subscriptions = Arc::new(Mutex::new(HashMap::new()));
    rig.state.conn_manager.register(
        conn_id,
        send_tx.clone(),
        ctrl_tx.clone(),
        None,
        CancellationToken::new(),
        rig.tenant.community(),
        Arc::clone(&backpressure),
        Arc::clone(&subscriptions),
        3,
    );
    let conn = ConnectionState {
        conn_id,
        tenant: rig.tenant.clone(),
        remote_addr: "203.0.113.9:4242".parse().expect("socket addr"),
        auth_state: std::sync::Mutex::new(AuthState::Pending {
            challenge: "challenge".to_string(),
            started_at: std::time::Instant::now(),
        }),
        subscriptions,
        send_tx,
        ctrl_tx,
        terminal_ctrl_tx: tokio::sync::mpsc::channel(1).0,
        cancel: CancellationToken::new(),
        backpressure_count: backpressure,
        grace_limit: 3,
        nip_fi_assertion: None,
        session_deadline: None,
        nip_fi_gate: crate::nip_fi_gate::SessionAdmissionGate::off_mode(CancellationToken::new()),
    };
    (Arc::new(conn), rx)
}

fn drain(rx: &mut mpsc::Receiver<Message>) -> Vec<Value> {
    let mut frames = Vec::new();
    while let Ok(Message::Text(text)) = rx.try_recv() {
        frames.push(serde_json::from_str(&text).expect("relay frame is JSON"));
    }
    frames
}

fn topic_filter(kind: u16, topic: &str) -> Filter {
    Filter::new()
        .kind(Kind::Custom(kind))
        .custom_tag(SingleLetterTag::lowercase(Alphabet::X), topic)
}

async fn req(rig: &Rig, conn: &Arc<ConnectionState>, sub: &str, filters: Vec<Filter>) {
    let before_ids = vec![None; filters.len()];
    super::req::handle_req(
        sub.to_string(),
        filters,
        before_ids,
        Arc::clone(conn),
        Arc::clone(&rig.state),
    )
    .await;
}

/// The terminal frame of a REQ: `("EOSE"|"CLOSED", reason)`.
fn outcome(frames: &[Value]) -> (String, String) {
    let last = frames.last().expect("REQ produced no frames");
    (
        last[0].as_str().unwrap_or_default().to_string(),
        last.get(2)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
    )
}

fn signed(keys: &Keys, kind: u16, tags: Vec<Tag>, content: &str) -> nostr::Event {
    EventBuilder::new(Kind::Custom(kind), content)
        .tags(tags)
        .sign_with_keys(keys)
        .expect("sign")
}

fn x_tag(topic: &str) -> Tag {
    Tag::parse(["x", topic]).expect("x tag")
}

fn ok_frame(frames: &[Value], event: &nostr::Event) -> (bool, String) {
    let frame = frames
        .iter()
        .find(|f| f[0] == "OK" && f[1] == event.id.to_hex().as_str())
        .unwrap_or_else(|| panic!("no OK for event; frames: {frames:?}"));
    (
        frame[2].as_bool().expect("accepted flag"),
        frame[3].as_str().unwrap_or_default().to_string(),
    )
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn anonymous_req_cannot_subscribe_to_presence_or_wide_filters() {
    let rig = rig(4, 1000).await;
    let keys = Keys::generate();
    let wide: Vec<(&str, Vec<Filter>)> = vec![
        (
            "presence with a topic",
            vec![topic_filter(KIND_PRESENCE_UPDATE as u16, "t")],
        ),
        (
            "bare presence",
            vec![Filter::new().kind(Kind::Custom(KIND_PRESENCE_UPDATE as u16))],
        ),
        (
            "any ephemeral kind without a topic",
            vec![Filter::new().kind(Kind::Custom(TRYSTERO_KIND))],
        ),
        (
            "stored kind",
            vec![topic_filter(KIND_STREAM_MESSAGE as u16, "t")],
        ),
        (
            "authors",
            vec![topic_filter(TRYSTERO_KIND, "t").author(keys.public_key())],
        ),
        (
            "presence hidden in a second filter",
            vec![
                topic_filter(TRYSTERO_KIND, "t"),
                topic_filter(KIND_PRESENCE_UPDATE as u16, "t"),
            ],
        ),
    ];
    for (label, filters) in wide {
        let (conn, mut rx) = anonymous_connection(&rig);
        req(&rig, &conn, "s", filters).await;
        let frames = drain(&mut rx);
        let (kind, reason) = outcome(&frames);
        assert_eq!(kind, "CLOSED", "{label}: must be refused: {frames:?}");
        assert!(reason.starts_with("auth-required"), "{label}: {reason}");
        assert!(
            frames.iter().all(|f| f[0] != "EVENT"),
            "{label}: no events may be delivered"
        );
        assert!(
            conn.subscriptions.lock().await.is_empty(),
            "{label}: nothing may be registered"
        );
    }
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn anonymous_req_for_a_signaling_topic_is_admitted() {
    let rig = rig(4, 1000).await;
    let (conn, mut rx) = anonymous_connection(&rig);
    req(
        &rig,
        &conn,
        "s",
        vec![topic_filter(TRYSTERO_KIND, "room-1")],
    )
    .await;
    assert_eq!(outcome(&drain(&mut rx)).0, "EOSE");
    assert_eq!(conn.subscriptions.lock().await.len(), 1);
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn anonymous_subscriptions_are_capped_per_connection() {
    let rig = rig(2, 1000).await;
    let (conn, mut rx) = anonymous_connection(&rig);
    for sub in ["a", "b"] {
        req(&rig, &conn, sub, vec![topic_filter(TRYSTERO_KIND, sub)]).await;
        assert_eq!(outcome(&drain(&mut rx)).0, "EOSE", "sub {sub}");
    }
    req(&rig, &conn, "c", vec![topic_filter(TRYSTERO_KIND, "c")]).await;
    let (kind, reason) = outcome(&drain(&mut rx));
    assert_eq!(
        (kind.as_str(), reason.as_str()),
        ("CLOSED", "error: too many subscriptions"),
        "the third standing subscription must be refused"
    );
    assert_eq!(conn.subscriptions.lock().await.len(), 2);

    // Replacing an existing subscription id is not a new subscription.
    req(&rig, &conn, "a", vec![topic_filter(TRYSTERO_KIND, "a2")]).await;
    assert_eq!(outcome(&drain(&mut rx)).0, "EOSE");
    assert_eq!(conn.subscriptions.lock().await.len(), 2);

    // The cap is per connection.
    let (other, mut other_rx) = anonymous_connection(&rig);
    req(&rig, &other, "c", vec![topic_filter(TRYSTERO_KIND, "c")]).await;
    assert_eq!(outcome(&drain(&mut other_rx)).0, "EOSE");
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn anonymous_req_frames_are_rate_limited_per_connection() {
    let rig = rig(64, 3).await;
    let (conn, mut rx) = anonymous_connection(&rig);
    for attempt in 0..3 {
        req(&rig, &conn, "s", vec![topic_filter(TRYSTERO_KIND, "t")]).await;
        assert_eq!(
            outcome(&drain(&mut rx)).0,
            "EOSE",
            "REQ {attempt} is within budget"
        );
    }
    req(&rig, &conn, "s", vec![topic_filter(TRYSTERO_KIND, "t")]).await;
    let (kind, reason) = outcome(&drain(&mut rx));
    assert_eq!(kind, "CLOSED");
    assert!(reason.starts_with("rate-limited"), "{reason}");
    let (fresh, mut fresh_rx) = anonymous_connection(&rig);
    req(&rig, &fresh, "s", vec![topic_filter(TRYSTERO_KIND, "t")]).await;
    assert_eq!(
        outcome(&drain(&mut fresh_rx)).0,
        "EOSE",
        "budget is per connection"
    );
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn anonymous_presence_events_are_rejected_and_never_reach_member_state() {
    let rig = rig(4, 1000).await;
    let (conn, mut rx) = anonymous_connection(&rig);
    let throwaway = Keys::generate();

    // A member-side observer subscribed to presence (as a real client would).
    let member = Keys::generate();
    let (observer, mut observer_rx) = anonymous_connection(&rig);
    *observer.auth_state.lock().expect("auth state lock") = AuthState::Authenticated(buzz_auth::AuthContext {
        pubkey: member.public_key(),
        scopes: vec![],
        channel_ids: None,
        auth_method: buzz_auth::AuthMethod::Nip42,
        agent_owner_pubkey: None,
    });
    rig.state
        .conn_manager
        .set_authenticated_pubkey(observer.conn_id, member.public_key().to_bytes().to_vec());
    req(
        &rig,
        &observer,
        "presence",
        vec![Filter::new().kind(Kind::Custom(KIND_PRESENCE_UPDATE as u16))],
    )
    .await;
    assert_eq!(outcome(&drain(&mut observer_rx)).0, "EOSE");

    for tags in [vec![], vec![x_tag("t")]] {
        let event = signed(&throwaway, KIND_PRESENCE_UPDATE as u16, tags, "online");
        super::event::handle_event(event.clone(), Arc::clone(&conn), Arc::clone(&rig.state)).await;
        let (accepted, message) = ok_frame(&drain(&mut rx), &event);
        assert!(!accepted, "anonymous presence must be rejected");
        assert!(message.starts_with("auth-required"), "{message}");
    }

    assert_eq!(
        rig.state
            .pubsub
            .get_presence(&rig.tenant, &throwaway.public_key())
            .await
            .expect("read presence"),
        None,
        "an anonymous key must never get a presence entry"
    );
    assert!(
        drain(&mut observer_rx).iter().all(|f| f[0] != "EVENT"),
        "members must never see anonymous presence"
    );
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn anonymous_events_outside_the_allowlist_shape_are_rejected() {
    let rig = rig(4, 1000).await;
    let (conn, mut rx) = anonymous_connection(&rig);
    let keys = Keys::generate();
    let cases = [
        (
            "stored kind",
            signed(&keys, KIND_STREAM_MESSAGE as u16, vec![x_tag("t")], "hi"),
        ),
        ("no topic", signed(&keys, TRYSTERO_KIND, vec![], "{}")),
        (
            "channel-scoped",
            signed(
                &keys,
                TRYSTERO_KIND,
                vec![
                    x_tag("t"),
                    Tag::parse(["h", &Uuid::new_v4().to_string()]).unwrap(),
                ],
                "{}",
            ),
        ),
        (
            "observer frame",
            signed(
                &keys,
                buzz_core::kind::KIND_AGENT_OBSERVER_FRAME as u16,
                vec![x_tag("t")],
                "{}",
            ),
        ),
    ];
    for (label, event) in cases {
        super::event::handle_event(event.clone(), Arc::clone(&conn), Arc::clone(&rig.state)).await;
        let (accepted, message) = ok_frame(&drain(&mut rx), &event);
        assert!(!accepted, "{label} must be rejected (got: {message})");
    }
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn anonymous_signaling_round_trips_and_events_are_rate_limited() {
    let rig = rig(4, 2).await;
    let (subscriber, mut subscriber_rx) = anonymous_connection(&rig);
    req(
        &rig,
        &subscriber,
        "room",
        vec![topic_filter(TRYSTERO_KIND, "room-1")],
    )
    .await;
    assert_eq!(outcome(&drain(&mut subscriber_rx)).0, "EOSE");

    let (publisher, mut publisher_rx) = anonymous_connection(&rig);
    let keys = Keys::generate();
    let mut accepted = Vec::new();
    for attempt in 0..3 {
        let event = signed(
            &keys,
            TRYSTERO_KIND,
            vec![x_tag("room-1")],
            &format!("offer-{attempt}"),
        );
        super::event::handle_event(
            event.clone(),
            Arc::clone(&publisher),
            Arc::clone(&rig.state),
        )
        .await;
        accepted.push(ok_frame(&drain(&mut publisher_rx), &event));
    }
    assert_eq!(
        accepted[0],
        (true, String::new()),
        "within budget: {accepted:?}"
    );
    assert_eq!(
        accepted[1],
        (true, String::new()),
        "within budget: {accepted:?}"
    );
    assert!(
        !accepted[2].0,
        "third event exceeds the budget of 2/min: {accepted:?}"
    );
    assert!(accepted[2].1.starts_with("rate-limited"), "{accepted:?}");

    let delivered: Vec<String> = drain(&mut subscriber_rx)
        .iter()
        .filter(|f| f[0] == "EVENT")
        .map(|f| f[2]["content"].as_str().unwrap_or_default().to_string())
        .collect();
    assert_eq!(
        delivered,
        vec!["offer-0", "offer-1"],
        "the topic subscriber receives exactly the admitted events"
    );
}
