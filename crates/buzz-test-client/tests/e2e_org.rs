//! End-to-end integration tests for the NIP-ORG plane (kinds 37010-37014).
//!
//! These tests require a running relay. By default they are `#[ignore]` so
//! `cargo test` passes without infra. Run with:
//!
//! ```text
//! cargo test --test e2e_org -- --ignored
//! ```
//!
//! Override the relay URL with `RELAY_URL` (default ws://localhost:3000).

use std::time::Duration;

use buzz_test_client::BuzzTestClient;
use nostr::{EventBuilder, Filter, Kind, Keys, Tag};
use uuid::Uuid;

fn relay_url() -> String {
    std::env::var("RELAY_URL").unwrap_or_else(|_| "ws://localhost:3000".to_string())
}

fn sub_id(name: &str) -> String {
    format!("e2e-org-{name}-{}", Uuid::new_v4())
}

const KIND_ORG_NODE: u16 = 37010;
const KIND_ORG_GRANT: u16 = 37011;
const KIND_ORG_BUDGET: u16 = 37012;
const TIMEOUT: Duration = Duration::from_secs(10);

fn org_node_event(keys: &Keys, d: &str, name: &str, parent: Option<&str>, holders: Vec<&str>) -> nostr::Event {
    let mut content = serde_json::json!({
        "v": 1,
        "name": name,
        "kind": "role",
    });
    if let Some(p) = parent {
        content["parent"] = serde_json::Value::String(p.into());
    }
    if !holders.is_empty() {
        content["holders"] = serde_json::Value::Array(holders.iter().map(|h| serde_json::Value::String((*h).into())).collect());
    }
    let mut tags = vec![Tag::parse(["d", d]).unwrap()];
    let mut builder = EventBuilder::new(Kind::Custom(KIND_ORG_NODE), content.to_string());
    // EventBuilder with tags
    for t in tags.drain(..) {
        builder = builder.tag(t);
    }
    builder.sign_with_keys(keys).expect("sign org node")
}

fn org_grant_event(keys: &Keys, d: &str, grantee: &str, via: &str, verbs: Vec<&str>, parent_grant: Option<&str>) -> nostr::Event {
    let mut content = serde_json::json!({
        "v": 1,
        "issuer": keys.public_key().to_hex(),
        "grantee": grantee,
        "via": via,
        "verbs": verbs,
        "revoked": false,
    });
    if let Some(pg) = parent_grant {
        content["parentGrant"] = serde_json::Value::String(pg.into());
    }
    let builder = EventBuilder::new(Kind::Custom(KIND_ORG_GRANT), content.to_string())
        .tag(Tag::parse(["d", d]).unwrap())
        .tag(Tag::parse(["p", grantee]).unwrap());
    builder.sign_with_keys(keys).expect("sign org grant")
}

async fn e2e_db_pool() -> sqlx::Pool<sqlx::Postgres> {
    let database_url = std::env::var("DATABASE_URL").unwrap_or_else(|_| {
        "postgres://buzz:buzz_dev@localhost:5432/buzz".to_string() // sadscan:disable np.postgres.1
    });
    sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .connect(&database_url)
        .await
        .expect("connect to e2e Postgres")
}

async fn ensure_test_community(host: &str) -> Uuid {
    let pool = e2e_db_pool().await;
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO communities (id, host)          VALUES ($1, $2)          ON CONFLICT (lower(host)) DO NOTHING",
    )
    .bind(id)
    .bind(host)
    .execute(&pool)
    .await
    .unwrap_or_else(|e| panic!("seed community {host}: {e}"));

    sqlx::query_scalar("SELECT id FROM communities WHERE lower(host) = lower($1)")
        .bind(host)
        .fetch_one(&pool)
        .await
        .unwrap_or_else(|e| panic!("lookup community {host}: {e}"))
}

async fn seed_relay_owner(keys: &Keys) {
    let url = relay_url();
    let host = url.trim_start_matches("ws://").split(':').next().unwrap_or("localhost");
    let pool = e2e_db_pool().await;
    let community_id = ensure_test_community(host).await;
    sqlx::query(
        "INSERT INTO relay_members (community_id, pubkey, role, added_by)          VALUES ($1, $2, 'owner', NULL)          ON CONFLICT (community_id, pubkey) DO UPDATE          SET role = 'owner', updated_at = now()",
    )
    .bind(community_id)
    .bind(keys.public_key().to_hex())
    .execute(&pool)
    .await
    .unwrap_or_else(|e| panic!("seed relay owner: {e}"));
}

async fn collect(
    client: &mut BuzzTestClient,
    sid: &str,
) -> Vec<nostr::Event> {
    let mut out = Vec::new();
    loop {
        match client.recv_event(TIMEOUT).await {
            Ok(buzz_test_client::RelayMessage::Event {
                subscription_id,
                event,
            }) if subscription_id == sid => out.push(*event),
            Ok(buzz_test_client::RelayMessage::Eose { subscription_id }) if subscription_id == sid => break,
            Ok(_) => continue,
            Err(_) => break,
        }
    }
    out
}

#[tokio::test]
#[ignore]
async fn org_node_lifecycle_lww_and_readback() {
    let keys = Keys::generate();
    let mut c = BuzzTestClient::connect(&relay_url(), &keys).await.expect("connect");
    let d = format!("n-{}", Uuid::new_v4());
    let e1 = org_node_event(&keys, &d, "Root", None, vec![]);
    let ok = c.send_event(e1).await.expect("publish node");
    assert!(ok.accepted, "root node must be accepted");

    // Replacement with same d (NIP-33 LWW): newer content wins. Wait a beat
    // so created_at strictly increases (ties are read-model-ambiguous).
    tokio::time::sleep(Duration::from_millis(1100)).await;
    let e2 = org_node_event(&keys, &d, "Root v2", None, vec![]);
    let ok2 = c.send_event(e2).await.expect("publish replacement");
    assert!(ok2.accepted);

    let sid = sub_id("readback");
    let filter = Filter::new()
        .kind(Kind::Custom(KIND_ORG_NODE))
        .author(keys.public_key())
        .custom_tags(nostr::SingleLetterTag::lowercase(nostr::Alphabet::D), [d.as_str()]);
    c.subscribe(&sid, vec![filter]).await.expect("subscribe");
    let events = collect(&mut c, &sid).await;
    let name = events
        .iter()
        .max_by_key(|e| e.created_at)
        .and_then(|e| serde_json::from_str::<serde_json::Value>(&e.content).ok())
        .and_then(|v| v.get("name").and_then(|n| n.as_str()).map(String::from));
    assert_eq!(name.as_deref(), Some("Root v2"), "LWW must deliver the newer node");
    c.close_subscription(&sid).await.ok();
}

#[tokio::test]
#[ignore]
async fn org_budget_invalid_window_rejected_over_ws() {
    let keys = Keys::generate();
    let mut c = BuzzTestClient::connect(&relay_url(), &keys).await.expect("connect");
    let d = format!("b-{}", Uuid::new_v4());
    let content = serde_json::json!({
        "v": 1,
        "subject": keys.public_key().to_hex(),
        "window": "fortnight",
        "limits": { "runs": 5 },
        "onExceed": "require-approval",
    })
    .to_string();
    let event = EventBuilder::new(Kind::Custom(KIND_ORG_BUDGET), content)
        .tag(Tag::parse(["d", &d]).unwrap())
        .sign_with_keys(&keys)
        .expect("sign budget");
    let ok = c.send_event(event).await.expect("publish budget");
    assert!(!ok.accepted, "unknown window must be rejected");
    assert!(
        ok.message.contains("window"),
        "rejection must name the problem: {}",
        ok.message
    );
}

#[tokio::test]
#[ignore]
async fn org_p_gate_requires_kinds() {
    let keys = Keys::generate();
    let mut c = BuzzTestClient::connect(&relay_url(), &keys).await.expect("connect");
    let sid = sub_id("p-gate");
    // REQ without kinds must be rejected (p-gate) or return nothing — assert no EOSE loop hang.
    c.subscribe(&sid, vec![Filter::new()]).await.expect("subscribe");
    let events = collect(&mut c, &sid).await;
    assert!(
        events.is_empty(),
        "unscoped read must not return org data ({} events)",
        events.len()
    );
}

#[tokio::test]
#[ignore]
async fn org_binding_requires_root_holder_or_owner() {
    let owner = Keys::generate();
    seed_relay_owner(&owner).await;
    let stranger = Keys::generate();

    // Root node authored by owner, holder = stranger (as a member).
    let d = format!("root-{}", Uuid::new_v4());
    let root = org_node_event(&owner, &d, "Root", None, vec![stranger.public_key().to_hex().as_str()]);
    let mut oc = BuzzTestClient::connect(&relay_url(), &owner).await.expect("owner connect");
    let ok = oc.send_event(root).await.expect("publish root");
    assert!(ok.accepted);

    // Stranger (a holder) may bind.
    let binding = serde_json::json!({
        "v": 1,
        "name": "Root",
        "kind": "role",
        "holders": [stranger.public_key().to_hex()],
        "onchain": {
            "chain": "eip155:31337",
            "dao": "0x5fbdb2315678afecb367f032d93f642f64180aa3",
            "boundAt": 1_789_870_800u64,
        },
    })
    .to_string();
    let bind_event = EventBuilder::new(Kind::Custom(KIND_ORG_NODE), binding)
        .tag(Tag::parse(["d", &d]).unwrap())
        .sign_with_keys(&stranger)
        .expect("sign binding");
    let mut sc = BuzzTestClient::connect(&relay_url(), &stranger).await.expect("holder connect");
    let okb = sc.send_event(bind_event).await.expect("holder bind");
    assert!(okb.accepted, "a holder must be able to bind the root they hold");

    // A completely unrelated signer must be rejected.
    let other = Keys::generate();
    let bind2 = serde_json::json!({
        "v": 1,
        "name": "Root",
        "kind": "role",
        "holders": [stranger.public_key().to_hex()],
        "onchain": {
            "chain": "eip155:31337",
            "dao": "0x5fbdb2315678afecb367f032d93f642f64180aa3",
            "boundAt": 1_789_870_800u64,
        },
    })
    .to_string();
    let bind_event2 = EventBuilder::new(Kind::Custom(KIND_ORG_NODE), bind2)
        .tag(Tag::parse(["d", &d]).unwrap())
        .sign_with_keys(&other)
        .expect("sign other");
    let mut oc2 = BuzzTestClient::connect(&relay_url(), &other).await.expect("other connect");
    let okc = oc2.send_event(bind_event2).await.expect("other bind");
    assert!(!okc.accepted, "an unrelated signer must not bind the root");
    assert!(okc.message.contains("restricted"), "got: {}", okc.message);
}
