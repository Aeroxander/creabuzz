//! Production-seam tests for the admin-only read gate on the kind:48001 audit
//! chain (`buzz_core::kind::ADMIN_ONLY_KINDS`).
//!
//! The chain records an entry for every persistent event — including gift wraps
//! and private-channel activity — with actor pubkeys and channel ids, so it
//! must be readable only by the community owner/admin. Each test drives a real
//! handler (`handle_req`, `handle_count`, live fan-out) against Postgres with a
//! plain member and an admin/owner, and asserts on the frames that reach the
//! connection. The admin arm is what makes them falsifiable in both
//! directions: removing the gate fails the member assertions, and an
//! over-eager gate fails the admin assertions.
//!
//! Run with `cargo test -p buzz-relay --lib read_gate -- --include-ignored`
//! (needs `DATABASE_URL` and `REDIS_URL`).

use std::collections::HashMap;
use std::sync::atomic::AtomicU8;
use std::sync::Arc;

use axum::extract::ws::Message;
use buzz_core::kind::{KIND_AUDIT_ENTRY, KIND_TEXT_NOTE};
use buzz_core::{CommunityId, StoredEvent, TenantContext};
use nostr::{EventBuilder, EventId, Filter, Keys, Kind};
use serde_json::Value;
use tokio::sync::{mpsc, Mutex, RwLock};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::connection::{AuthState, ConnectionState};
use crate::state::AppState;

struct World {
    state: Arc<AppState>,
    tenant: TenantContext,
    community: CommunityId,
    owner: Keys,
    admin: Keys,
    member: Keys,
    audit_id: EventId,
    note_id: EventId,
}

async fn world() -> World {
    let state = crate::test_support::test_state().await;
    let host = format!("audit-gate-{}.example", Uuid::new_v4().simple());
    let community = state
        .db
        .ensure_configured_community(&host)
        .await
        .expect("create community")
        .id;
    let tenant = TenantContext::resolved(community, host);

    let (owner, admin, member) = (Keys::generate(), Keys::generate(), Keys::generate());
    for (keys, role) in [(&owner, "owner"), (&admin, "admin"), (&member, "member")] {
        state
            .db
            .add_relay_member(community, &keys.public_key().to_hex(), role, None)
            .await
            .expect("add relay member");
    }

    // The relay signs its own audit envelope; the content carries what the
    // real chain carries: an actor pubkey and a (private) channel id.
    let audit = EventBuilder::new(
        Kind::Custom(KIND_AUDIT_ENTRY as u16),
        format!(
            r#"{{"action":"event_created","actor_pubkey":"{}","detail":{{"channel_id":"{}"}}}}"#,
            member.public_key().to_hex(),
            Uuid::new_v4()
        ),
    )
    .sign_with_keys(&state.relay_keypair)
    .expect("sign audit entry");
    // The note is OLDER than the audit entry, so an audit row that merely
    // survived to a post-filter would consume a `limit: 1` page and starve it.
    let note = EventBuilder::new(Kind::Custom(KIND_TEXT_NOTE as u16), "an ordinary note")
        .custom_created_at(nostr::Timestamp::from(
            nostr::Timestamp::now().as_secs() - 30,
        ))
        .sign_with_keys(&member)
        .expect("sign note");
    for event in [&audit, &note] {
        state
            .db
            .insert_event(community, event, None)
            .await
            .expect("store event");
    }

    World {
        state,
        tenant,
        community,
        owner,
        admin,
        member,
        audit_id: audit.id,
        note_id: note.id,
    }
}

fn connection(world: &World, keys: &Keys) -> (Arc<ConnectionState>, mpsc::Receiver<Message>) {
    let (send_tx, rx) = mpsc::channel(256);
    let (ctrl_tx, _ctrl_rx) = mpsc::channel(4);
    let conn = ConnectionState {
        conn_id: Uuid::new_v4(),
        tenant: world.tenant.clone(),
        remote_addr: "127.0.0.1:4242".parse().expect("socket addr"),
        auth_state: RwLock::new(AuthState::Authenticated(buzz_auth::AuthContext {
            pubkey: keys.public_key(),
            scopes: vec![],
            channel_ids: None,
            auth_method: buzz_auth::AuthMethod::Nip42,
            agent_owner_pubkey: None,
        })),
        subscriptions: Arc::new(Mutex::new(HashMap::new())),
        send_tx,
        ctrl_tx,
        cancel: CancellationToken::new(),
        backpressure_count: Arc::new(AtomicU8::new(0)),
        grace_limit: 3,
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

/// Event ids delivered by a REQ, asserting it terminated with EOSE.
async fn req_event_ids(world: &World, who: &Keys, filters: Vec<Filter>) -> Vec<String> {
    let (conn, mut rx) = connection(world, who);
    let before_ids = vec![None; filters.len()];
    super::req::handle_req(
        "audit-gate".to_string(),
        filters,
        before_ids,
        conn,
        Arc::clone(&world.state),
    )
    .await;
    let frames = drain(&mut rx);
    assert_eq!(
        frames.last().map(|f| f[0].clone()),
        Some(Value::from("EOSE")),
        "REQ must complete with EOSE, not an error: {frames:?}"
    );
    frames
        .iter()
        .filter(|f| f[0] == "EVENT")
        .map(|f| f[2]["id"].as_str().expect("event id").to_string())
        .collect()
}

async fn count(world: &World, who: &Keys, filters: Vec<Filter>) -> u64 {
    let (conn, mut rx) = connection(world, who);
    super::count::handle_count(
        "audit-gate".to_string(),
        filters,
        conn,
        Arc::clone(&world.state),
    )
    .await;
    let frames = drain(&mut rx);
    let frame = frames.last().expect("COUNT reply");
    assert_eq!(
        frame[0], "COUNT",
        "COUNT must answer with a count: {frames:?}"
    );
    frame[2]["count"].as_u64().expect("count value")
}

fn audit_kind() -> Kind {
    Kind::Custom(KIND_AUDIT_ENTRY as u16)
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn req_for_audit_entries_returns_nothing_to_a_plain_member() {
    let w = world().await;

    assert!(
        req_event_ids(&w, &w.member, vec![Filter::new().kind(audit_kind())])
            .await
            .is_empty(),
        "a member must not read the audit chain by kind"
    );
    assert!(
        req_event_ids(&w, &w.member, vec![Filter::new().id(w.audit_id)])
            .await
            .is_empty(),
        "nor by a kindless id lookup"
    );
    let mixed = req_event_ids(
        &w,
        &w.member,
        vec![Filter::new()
            .kinds([audit_kind(), Kind::Custom(KIND_TEXT_NOTE as u16)])
            .limit(1)],
    )
    .await;
    assert_eq!(
        mixed,
        vec![w.note_id.to_hex()],
        "a mixed-kind filter still serves the note (audit rows must not starve the page)"
    );
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn req_for_audit_entries_returns_them_to_the_owner_and_admins() {
    let w = world().await;
    for who in [&w.admin, &w.owner] {
        assert_eq!(
            req_event_ids(&w, who, vec![Filter::new().kind(audit_kind())]).await,
            vec![w.audit_id.to_hex()],
            "owner/admin must read the chain (the desktop audit view depends on it)"
        );
        assert_eq!(
            req_event_ids(&w, who, vec![Filter::new().id(w.audit_id)]).await,
            vec![w.audit_id.to_hex()]
        );
    }
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn count_of_audit_entries_is_zero_for_members_and_exact_for_admins() {
    let w = world().await;
    let filter = || vec![Filter::new().kind(audit_kind())];
    assert_eq!(
        count(&w, &w.member, filter()).await,
        0,
        "a member's COUNT must not reveal that audit entries exist"
    );
    assert_eq!(count(&w, &w.admin, filter()).await, 1);
    assert_eq!(count(&w, &w.owner, filter()).await, 1);

    // A mixed-kind COUNT must agree with what the reader may see: the member's
    // count excludes the chain, the admin's includes it.
    let mixed = || vec![Filter::new().kinds([audit_kind(), Kind::Custom(KIND_TEXT_NOTE as u16)])];
    assert_eq!(count(&w, &w.member, mixed()).await, 1, "the note only");
    assert_eq!(
        count(&w, &w.admin, mixed()).await,
        2,
        "exactly the audit entry separates the admin's view from the member's"
    );
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn live_fanout_of_audit_entries_reaches_only_owner_and_admin_connections() {
    let w = world().await;
    let state = &w.state;

    // (label, keys, filter) — the member also holds a kindless subscription,
    // which would match every live event including the audit entry.
    let subscriptions = [
        ("admin", &w.admin, Filter::new().kind(audit_kind())),
        ("owner", &w.owner, Filter::new().kind(audit_kind())),
        (
            "member-by-kind",
            &w.member,
            Filter::new().kind(audit_kind()),
        ),
        ("member-kindless", &w.member, Filter::new()),
    ];
    let mut receivers = Vec::new();
    for (label, keys, filter) in subscriptions {
        let conn_id = Uuid::new_v4();
        let (tx, rx) = mpsc::channel(16);
        let (ctrl_tx, _ctrl_rx) = mpsc::channel(4);
        state.conn_manager.register(
            conn_id,
            tx,
            ctrl_tx,
            None,
            CancellationToken::new(),
            w.community,
            Arc::new(AtomicU8::new(0)),
            Arc::new(Mutex::new(HashMap::new())),
            3,
        );
        state
            .conn_manager
            .set_authenticated_pubkey(conn_id, keys.public_key().to_bytes().to_vec());
        state.sub_registry.register_scoped(
            w.community,
            conn_id,
            format!("sub-{label}"),
            vec![filter],
            None,
        );
        receivers.push((label, rx));
    }

    let audit = StoredEvent::new(
        EventBuilder::new(audit_kind(), r#"{"action":"event_created"}"#)
            .sign_with_keys(&state.relay_keypair)
            .expect("sign live audit entry"),
        None,
    );
    super::event::fan_out_event_to_local_subscribers(state, w.community, &audit).await;

    for (label, mut rx) in receivers {
        let delivered = drain(&mut rx)
            .iter()
            .any(|frame| frame[0] == "EVENT" && frame[2]["kind"] == KIND_AUDIT_ENTRY);
        let expected = matches!(label, "admin" | "owner");
        assert_eq!(
            delivered, expected,
            "live audit delivery to `{label}` must be {expected}"
        );
    }
}
