//! NIP-ORG grant-chain enforcement — opt-in relay-side ingest gate.
//!
//! NIP-ORG "Relay behavior": grant-chain verification is **opt-in and
//! scoped**. With `ORG_GRANT_ENFORCEMENT=off` (the default) this module is
//! never invoked and kind:37011 org grants are stored and forwarded exactly
//! as before. With `ORG_GRANT_ENFORCEMENT=on`, ingest of a kind:37011 grant
//! verifies, before acceptance:
//!
//! 1. **Attenuation** — every verb the grant carries is entailed by some
//!    verb of each ancestor along its `parentGrant` chain (walked through
//!    the event store, bounded by [`buzz_core::org_grant::MAX_GRANT_CHAIN_DEPTH`]
//!    hops; a cycle is rejected).
//! 2. **Root standing** — a root grant's verbs are entailed by the
//!    `scope.canGrant` of the org node (kind:37010, fetched by its `via`)
//!    the issuer acts through.
//! 3. **Expiry** — no link in the chain (including the incoming grant) is
//!    expired at ingest time.
//!
//! Two additional fail-closed continuity checks bind the chain to its
//! authors (NIP-ORG addresses grants by `(issuer, 37011, d)`):
//!
//! - the incoming event's signer must equal its `content.issuer`, and each
//!   stored ancestor's author must equal its `content.issuer`;
//! - a non-root grant's issuer must equal its parent grant's `grantee` —
//!   you can only chain from authority that was delegated *to you*.
//!
//! **Fail closed.** A grant whose chain cannot be fully verified is
//! rejected, never stored as verified: a missing parent grant or org node,
//! a malformed stored record, or a database lookup error all reject the
//! ingest (lookup errors surface as `IngestError::Internal`, which is an
//! error reply, not a silent accept). Revocations (`"revoked": true`) skip
//! verification — a revocation only removes authority, so it is always
//! admissible; the next grant that names the revoked one fails here.
//!
//! Enforcement scope: kind:37011 only. A survey of the kind registry found
//! no other kind carrying a delegated-authority claim (NIP-OA `auth` tags
//! are provenance, not authority — NIP-ORG design rule 4), so nothing else
//! is gated.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use buzz_core::kind::{KIND_ORG_GRANT, KIND_ORG_NODE};
use buzz_core::org_grant::{
    verify_grant_chain, GrantChainError, OrgGrantContent, OrgScope, ResolvedGrant, ResolvedOrgNode,
    MAX_GRANT_CHAIN_DEPTH,
};
use buzz_core::tenant::TenantContext;
use chrono::Utc;
use nostr::Event;
use serde::Deserialize;

use crate::handlers::ingest::IngestError;
use crate::state::AppState;

/// Org-node content fields the chain check needs. Parsed leniently —
/// unknown fields are ignored — but seat and scope fields default to
/// empty, which fails closed (an unparseable or empty node never grants
/// standing).
#[derive(Debug, Deserialize)]
struct NodeContent {
    /// Human seat holders (64-hex pubkeys). Absent → none.
    #[serde(default)]
    holders: Vec<String>,
    /// Agent seat holders (NIP-OA keys, 64-hex). Absent → none.
    #[serde(default)]
    agent_seats: Vec<String>,
    /// Delegation scope. Absent → empty `canGrant` (no standing).
    #[serde(default)]
    scope: OrgScope,
}

/// Extract the single `d` tag value from an event.
///
/// The org envelope validation upstream guarantees exactly one bounded `d`
/// tag for kind:37011; a missing tag here is a defensive reject.
fn d_tag_of(event: &Event) -> Result<String, IngestError> {
    event
        .tags
        .iter()
        .find(|t| t.as_slice().first() == Some(&"d".to_string()))
        .and_then(|t| t.as_slice().get(1).map(|v| v.to_string()))
        .ok_or_else(|| IngestError::Rejected("invalid: org grant must carry a `d` tag".into()))
}

/// Lowercase-compare two 64-hex pubkeys.
fn hex_eq(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
}

/// Fetch the latest stored event of `kind` with `d` tag `d` in `community`.
///
/// Org kinds are global-only (NIP-ORG "Relay behavior"), so the lookup is
/// community-scoped and global-only; NIP-33 replacement means the newest
/// row wins. Bounded with `LIMIT 1`. Soft-deleted rows are excluded by the
/// store.
async fn fetch_by_d(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    kind: u32,
    d: &str,
) -> Result<Option<Event>, IngestError> {
    let mut q = buzz_db::EventQuery::for_community(tenant.community());
    q.kinds = Some(vec![kind as i32]);
    q.d_tag = Some(d.to_string());
    q.global_only = true;
    q.limit = Some(1);
    let rows = state
        .db
        .query_events_for_event_write(&q)
        .await
        .map_err(|e| {
            IngestError::Internal(format!(
                "error: db error fetching org event (kind {kind}, d {d}): {e}"
            ))
        })?;
    Ok(rows.into_iter().next().map(|stored| stored.event))
}

/// Parse a stored kind:37011 event into a [`ResolvedGrant`].
///
/// The author check binds the stored row to its claimed issuer: NIP-ORG
/// addresses grants by `(issuer, 37011, d)`, so a stored grant whose
/// author is not its `content.issuer` is corrupt or forged and fails the
/// chain (reject, never verify).
fn stored_grant(stored: &Event) -> Result<ResolvedGrant, IngestError> {
    let content: OrgGrantContent = serde_json::from_str(&stored.content).map_err(|e| {
        IngestError::Rejected(format!(
            "restricted: stored parent grant content is not a valid org grant: {e}"
        ))
    })?;
    let author_hex = stored.pubkey.to_hex();
    if !hex_eq(&author_hex, &content.issuer) {
        return Err(IngestError::Rejected(format!(
            "restricted: stored parent grant {} author does not match its issuer",
            content.issuer
        )));
    }
    let d = stored
        .tags
        .iter()
        .find(|t| t.as_slice().first() == Some(&"d".to_string()))
        .and_then(|t| t.as_slice().get(1))
        .map(|s| s.to_string())
        .ok_or_else(|| {
            IngestError::Rejected("restricted: stored parent grant has no `d` tag".into())
        })?;
    Ok(ResolvedGrant {
        d,
        issuer: content.issuer,
        grantee: content.grantee,
        via: content.via,
        verbs: content.verbs,
        parent_grant: content.parent_grant,
        expires: content.expires,
        revoked: content.revoked,
    })
}

/// Parse a stored kind:37010 event into a [`ResolvedOrgNode`].
fn stored_node(stored: &Event) -> Result<ResolvedOrgNode, IngestError> {
    let content: NodeContent = serde_json::from_str(&stored.content).map_err(|e| {
        IngestError::Rejected(format!(
            "restricted: stored org node content is not a valid org node: {e}"
        ))
    })?;
    let d = stored
        .tags
        .iter()
        .find(|t| t.as_slice().first() == Some(&"d".to_string()))
        .and_then(|t| t.as_slice().get(1))
        .map(|s| s.to_string())
        .ok_or_else(|| {
            IngestError::Rejected("restricted: stored org node has no `d` tag".into())
        })?;
    Ok(ResolvedOrgNode {
        d,
        holders: content.holders,
        agent_seats: content.agent_seats,
        scope: content.scope,
    })
}

/// Reject helper for a failed chain verification.
fn chain_error(err: GrantChainError) -> IngestError {
    IngestError::Rejected(format!(
        "restricted: org grant chain verification failed: {err}"
    ))
}

/// Enforce the grant chain for an incoming kind:37011 event.
///
/// Called from the ingest pipeline only when `ORG_GRANT_ENFORCEMENT=on`.
/// See the module docs for the full contract.
pub(crate) async fn enforce_grant_chain(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    event: &Event,
) -> Result<(), IngestError> {
    let content: OrgGrantContent = serde_json::from_str(&event.content).map_err(|e| {
        IngestError::Rejected(format!(
            "invalid: org grant content must be a valid org grant object: {e}"
        ))
    })?;

    // A revocation republication only removes authority — admit it without
    // chain verification so revocation is always possible. Its effect is
    // enforced when the next grant that names this `d` fails here.
    if content.revoked {
        return Ok(());
    }

    // The signer must be the claimed issuer (grants are addressed by
    // `(issuer, 37011, d)`); a signed grant naming someone else as issuer
    // is a forgery attempt, not a delegation.
    let author_hex = event.pubkey.to_hex();
    if !hex_eq(&author_hex, &content.issuer) {
        return Err(IngestError::Rejected(
            "restricted: org grant `issuer` must be the event author".into(),
        ));
    }

    let grant_d = d_tag_of(event)?;

    // Collect the chain: the incoming grant plus each ancestor, bounded by
    // the depth cap, with cycle detection during collection so a cycle
    // reports as one instead of exhausting the bound.
    let mut grants: HashMap<String, ResolvedGrant> = HashMap::new();
    let mut nodes: HashMap<String, ResolvedOrgNode> = HashMap::new();

    let seed = ResolvedGrant {
        d: grant_d.clone(),
        issuer: content.issuer,
        grantee: content.grantee,
        via: content.via,
        verbs: content.verbs,
        parent_grant: content.parent_grant,
        expires: content.expires,
        revoked: content.revoked,
    };
    grants.insert(grant_d.clone(), seed.clone());

    // The incoming grant's own `via` node is part of the verification set
    // (root standing checks the issuer's seat in it), so fetch it up front.
    let seed_via = seed.via.clone();
    match fetch_by_d(state, tenant, KIND_ORG_NODE, &seed_via).await? {
        Some(stored) => {
            nodes.insert(seed_via, stored_node(&stored)?);
        }
        None => {
            return Err(chain_error(GrantChainError::NodeNotFound(seed_via)));
        }
    }

    let mut visited: HashSet<String> = HashSet::new();
    visited.insert(grant_d.clone());
    let mut current = seed;
    while let Some(parent_d) = current.parent_grant.clone() {
        if !visited.insert(parent_d.clone()) {
            return Err(chain_error(GrantChainError::CircularChain(parent_d)));
        }
        if visited.len() > MAX_GRANT_CHAIN_DEPTH + 1 {
            return Err(chain_error(GrantChainError::ChainDepthExceeded(parent_d)));
        }
        let Some(stored) = fetch_by_d(state, tenant, KIND_ORG_GRANT, &parent_d).await? else {
            return Err(chain_error(GrantChainError::ParentGrantNotFound(parent_d)));
        };
        let parent = stored_grant(&stored)?;

        // Continuity: authority only chains from what was delegated to you.
        if !hex_eq(&parent.grantee, &current.issuer) {
            return Err(IngestError::Rejected(format!(
                "restricted: org grant issuer {} is not the grantee of parent grant {}",
                current.issuer, parent_d
            )));
        }

        let via = parent.via.clone();
        grants.insert(parent_d.clone(), parent.clone());
        current = parent;
        if !nodes.contains_key(&via) {
            match fetch_by_d(state, tenant, KIND_ORG_NODE, &via).await? {
                Some(stored) => {
                    nodes.insert(via.clone(), stored_node(&stored)?);
                }
                None => {
                    return Err(chain_error(GrantChainError::NodeNotFound(via)));
                }
            }
        }
    }

    verify_grant_chain(
        &grant_d,
        Utc::now().timestamp().max(0) as u64,
        &grants,
        &nodes,
    )
    .map_err(chain_error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use buzz_auth::Scope;
    use nostr::{EventBuilder, Keys, Kind, Tag};
    use uuid::Uuid;

    // -- Postgres helpers (mirrors budget_enforcement's pg recipe) ----------

    async fn pg_pool() -> (sqlx::PgPool, uuid::Uuid) {
        let database_url = crate::test_support::database_url();
        let pool = sqlx::PgPool::connect(&database_url)
            .await
            .expect("connect grant enforcement test database");
        let db = buzz_db::Db::from_pool(pool.clone());
        db.migrate().await.expect("migrate test database");
        let id = uuid::Uuid::new_v4();
        sqlx::query("INSERT INTO communities (id, host) VALUES ($1, $2)")
            .bind(id)
            .bind(format!("org-grant-{id}.test"))
            .execute(&pool)
            .await
            .expect("insert community");
        (pool, id)
    }

    async fn pg_cleanup(pool: &sqlx::PgPool, community: uuid::Uuid) {
        sqlx::query("DELETE FROM event_mentions WHERE community_id = $1")
            .bind(community)
            .execute(pool)
            .await
            .expect("delete event mentions");
        sqlx::query("DELETE FROM audit_log WHERE community_id = $1")
            .bind(community)
            .execute(pool)
            .await
            .expect("delete audit log");
        sqlx::query("DELETE FROM events WHERE community_id = $1")
            .bind(community)
            .execute(pool)
            .await
            .expect("delete events");
        sqlx::query("DELETE FROM communities WHERE id = $1")
            .bind(community)
            .execute(pool)
            .await
            .expect("delete community");
    }

    /// Build a real `AppState` on the test pool with the grant-enforcement
    /// flag set to `enabled`, mirroring `budget_enforcement`'s recipe.
    async fn pg_app_state(pool: &sqlx::PgPool, enabled: bool) -> Option<Arc<AppState>> {
        let database_url = crate::test_support::database_url();
        let mut config = crate::config::Config::from_env().ok()?;
        config.database_url = database_url;
        config.redis_url = "redis://127.0.0.1:6379".to_string();
        config.relay_url = "wss://org-grant-enforcement.test".to_string();
        config.org_grant_enforcement = enabled;

        let redis_pool = deadpool_redis::Config::from_url(&config.redis_url)
            .create_pool(Some(deadpool_redis::Runtime::Tokio1))
            .ok()?;
        let pubsub = Arc::new(
            buzz_pubsub::PubSubManager::new(&config.redis_url, redis_pool.clone())
                .await
                .ok()?,
        );
        let audit = None::<buzz_audit::AuditService>;
        let auth = buzz_auth::AuthService::new(config.auth.clone());
        let search = buzz_search::SearchService::new(pool.clone());
        let workflow_engine = Arc::new(buzz_workflow::WorkflowEngine::new(
            buzz_db::Db::from_pool(pool.clone()),
            buzz_workflow::WorkflowConfig::default(),
        ));
        let media_storage = buzz_media::MediaStorage::new(&config.media).ok()?;
        let (state, _audit_shutdown) = crate::state::AppState::new(
            config,
            buzz_db::Db::from_pool(pool.clone()),
            redis_pool,
            audit,
            pubsub,
            auth,
            search,
            workflow_engine,
            nostr::Keys::generate(),
            media_storage,
        );
        Some(Arc::new(state))
    }

    fn tenant_for(community: uuid::Uuid) -> TenantContext {
        TenantContext::resolved(
            buzz_core::CommunityId::from_uuid(community),
            format!("org-grant-{community}.test"),
        )
    }

    /// Insert a stored org event row (kind 37010/37011) with the given
    /// author pubkey bytes, tags, and JSON content — the same raw-row
    /// recipe the budget enforcement tests use.
    async fn pg_insert_org_event(
        pool: &sqlx::PgPool,
        community: uuid::Uuid,
        kind: u32,
        author: &[u8; 32],
        tags: serde_json::Value,
        content: serde_json::Value,
    ) {
        // The events table keeps the NIP-33 `d` in its own column (the
        // parameterized-replacement index reads it); the store's
        // `insert_event` derives it from the tags, and this raw-row helper
        // mirrors that. `d_tag_value` always puts the pair first.
        let d = tags[0][1].as_str().expect("d tag value").to_string();
        let mut event_id = [0u8; 32];
        event_id[..16].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
        event_id[16..].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
        sqlx::query(
            "INSERT INTO events (community_id, id, pubkey, created_at, kind, tags, content, sig, d_tag)
             VALUES ($1, $2, $3, now(), $4, $5, $6, $7, $8)",
        )
        .bind(community)
        .bind(event_id.as_slice())
        .bind(author.as_slice())
        .bind(kind as i32)
        .bind(tags)
        .bind(content.to_string())
        .bind([2u8; 64])
        .bind(d)
        .execute(pool)
        .await
        .expect("insert org event");
    }

    fn d_tag_value(d: &str) -> serde_json::Value {
        serde_json::json!([["d", d]])
    }

    fn node_content_json(holders: &[&str], can_grant: &[&str]) -> serde_json::Value {
        serde_json::json!({
            "v": 1,
            "name": "node",
            "kind": "role",
            "holders": holders,
            "agentSeats": [],
            "scope": { "readBelow": true, "assignBelow": true, "canGrant": can_grant },
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn grant_content_json(
        issuer: &str,
        grantee: &str,
        via: &str,
        verbs: &[&str],
        parent_grant: Option<&str>,
        expires: Option<u64>,
        revoked: bool,
    ) -> serde_json::Value {
        let mut json = serde_json::json!({
            "v": 1,
            "issuer": issuer,
            "grantee": grantee,
            "via": via,
            "verbs": verbs,
            "revoked": revoked,
        });
        if let Some(p) = parent_grant {
            json["parentGrant"] = serde_json::json!(p);
        }
        if let Some(e) = expires {
            json["expires"] = serde_json::json!(e);
        }
        json
    }

    /// Sign a real kind:37011 event as `keys` — the incoming event the
    /// ingest gate sees.
    fn incoming_grant_event(keys: &Keys, content: serde_json::Value, d: &str) -> nostr::Event {
        EventBuilder::new(Kind::Custom(KIND_ORG_GRANT as u16), content.to_string())
            .tags([Tag::parse(["d", d]).expect("d tag")])
            .sign_with_keys(keys)
            .expect("sign incoming grant")
    }

    /// Drive the REAL ingest path (the same `ingest_event` seam WebSocket
    /// and HTTP both feed) so the flag branch in `ingest.rs` is exercised,
    /// not just the gate function.
    async fn ingest(
        state: &Arc<AppState>,
        tenant: &TenantContext,
        event: nostr::Event,
    ) -> Result<crate::handlers::ingest::IngestResult, crate::handlers::ingest::IngestError> {
        let auth = crate::handlers::ingest::IngestAuth::Nip42 {
            pubkey: event.pubkey,
            scopes: vec![Scope::MessagesWrite],
            channel_ids: None,
            conn_id: Uuid::new_v4(),
        };
        crate::handlers::ingest::ingest_event(state, tenant, event, auth).await
    }

    /// Seed the standard two-node, one-root-grant graph used by the
    /// rejection tests: node `cto` (issuer A, canGrant spend:100000),
    /// node `eng` (grantee B seated), root grant `g1` (A grants B
    /// spend:100000 via cto).
    async fn seed_widening_fixture(
        pool: &sqlx::PgPool,
        community: uuid::Uuid,
    ) -> (Keys, Keys, Keys) {
        let a = Keys::generate();
        let b = Keys::generate();
        let c = Keys::generate();
        let a_hex = a.public_key().to_hex();
        let b_hex = b.public_key().to_hex();
        pg_insert_org_event(
            pool,
            community,
            KIND_ORG_NODE,
            &a.public_key().to_bytes(),
            d_tag_value("cto"),
            node_content_json(&[&a_hex], &["spend:100000"]),
        )
        .await;
        pg_insert_org_event(
            pool,
            community,
            KIND_ORG_NODE,
            &b.public_key().to_bytes(),
            d_tag_value("eng"),
            node_content_json(&[&b_hex], &["read"]),
        )
        .await;
        pg_insert_org_event(
            pool,
            community,
            KIND_ORG_GRANT,
            &a.public_key().to_bytes(),
            d_tag_value("g1"),
            grant_content_json(&a_hex, &b_hex, "cto", &["spend:100000"], None, None, false),
        )
        .await;
        (a, b, c)
    }

    const KIND_ORG_NODE: u32 = buzz_core::kind::KIND_ORG_NODE;
    const KIND_ORG_GRANT: u32 = buzz_core::kind::KIND_ORG_GRANT;

    fn expect_rejection(
        result: Result<crate::handlers::ingest::IngestResult, crate::handlers::ingest::IngestError>,
        needle: &str,
        context: &str,
    ) {
        match result {
            Err(crate::handlers::ingest::IngestError::Rejected(msg)) => assert!(
                msg.contains(needle),
                "{context}: expected rejection mentioning \"{needle}\", got: {msg}"
            ),
            Err(other) => panic!("{context}: expected Rejected, got {other:?}"),
            Ok(r) => panic!("{context}: expected rejection, got accepted={}", r.accepted),
        }
    }

    /// Enforcement ON rejects a grant that widens its parent's scope
    /// (spend:200000 under a spend:100000 root), through the real ingest
    /// path. The event must NOT be stored.
    #[tokio::test]
    #[ignore = "requires migrated Postgres + Redis"]
    async fn enforcement_on_rejects_widening_chain() {
        let (pool, community) = pg_pool().await;
        let tenant = tenant_for(community);
        let (_a, b, _c) = seed_widening_fixture(&pool, community).await;
        let Some(state) = pg_app_state(&pool, true).await else {
            pg_cleanup(&pool, community).await;
            eprintln!("skipping: could not build AppState (config/media unavailable)");
            return;
        };

        let b_hex = b.public_key().to_hex();
        let c_hex = Keys::generate().public_key().to_hex();
        let event = incoming_grant_event(
            &b,
            grant_content_json(
                &b_hex,
                &c_hex,
                "eng",
                &["spend:200000"],
                Some("g1"),
                None,
                false,
            ),
            "g2",
        );
        let result = ingest(&state, &tenant, event).await;
        expect_rejection(result, "not entailed", "widening grant must be rejected");
        let stored: i64 = sqlx::query_scalar("SELECT count(*) FROM events WHERE community_id = $1 AND kind = 37011 AND tags @> $2::jsonb")
            .bind(community)
            .bind(d_tag_value("g2"))
            .fetch_one(&pool)
            .await
            .expect("count g2 rows");
        assert_eq!(stored, 0, "rejected grant must not be stored");

        pg_cleanup(&pool, community).await;
    }

    /// Enforcement ON rejects a chain whose parent link is expired at
    /// ingest time, even though attenuation holds.
    #[tokio::test]
    #[ignore = "requires migrated Postgres + Redis"]
    async fn enforcement_on_rejects_expired_link() {
        let (pool, community) = pg_pool().await;
        let tenant = tenant_for(community);
        let a = Keys::generate();
        let b = Keys::generate();
        let c = Keys::generate();
        let a_hex = a.public_key().to_hex();
        let b_hex = b.public_key().to_hex();
        let c_hex = c.public_key().to_hex();
        pg_insert_org_event(
            &pool,
            community,
            KIND_ORG_NODE,
            &a.public_key().to_bytes(),
            d_tag_value("cto"),
            node_content_json(&[&a_hex], &["spend:100000"]),
        )
        .await;
        pg_insert_org_event(
            &pool,
            community,
            KIND_ORG_NODE,
            &b.public_key().to_bytes(),
            d_tag_value("eng"),
            node_content_json(&[&b_hex], &["read"]),
        )
        .await;
        // Parent grant expired an hour ago.
        let expired = (chrono::Utc::now() - chrono::Duration::hours(1)).timestamp() as u64;
        pg_insert_org_event(
            &pool,
            community,
            KIND_ORG_GRANT,
            &a.public_key().to_bytes(),
            d_tag_value("g1"),
            grant_content_json(
                &a_hex,
                &b_hex,
                "cto",
                &["spend:100000"],
                None,
                Some(expired),
                false,
            ),
        )
        .await;
        let Some(state) = pg_app_state(&pool, true).await else {
            pg_cleanup(&pool, community).await;
            eprintln!("skipping: could not build AppState (config/media unavailable)");
            return;
        };

        // Attenuation holds (50000 ≤ 100000) — only expiry fails.
        let event = incoming_grant_event(
            &b,
            grant_content_json(
                &b_hex,
                &c_hex,
                "eng",
                &["spend:50000"],
                Some("g1"),
                None,
                false,
            ),
            "g2",
        );
        let result = ingest(&state, &tenant, event).await;
        expect_rejection(
            result,
            "expired",
            "chain with expired link must be rejected",
        );

        pg_cleanup(&pool, community).await;
    }

    /// Enforcement ON rejects a root grant whose verbs are not covered by
    /// the issuer's org node `scope.canGrant`.
    #[tokio::test]
    #[ignore = "requires migrated Postgres + Redis"]
    async fn enforcement_on_rejects_root_without_standing() {
        let (pool, community) = pg_pool().await;
        let tenant = tenant_for(community);
        let a = Keys::generate();
        let b_hex = Keys::generate().public_key().to_hex();
        let a_hex = a.public_key().to_hex();
        // Node grants standing for `read` only.
        pg_insert_org_event(
            &pool,
            community,
            KIND_ORG_NODE,
            &a.public_key().to_bytes(),
            d_tag_value("cto"),
            node_content_json(&[&a_hex], &["read"]),
        )
        .await;
        let Some(state) = pg_app_state(&pool, true).await else {
            pg_cleanup(&pool, community).await;
            eprintln!("skipping: could not build AppState (config/media unavailable)");
            return;
        };

        let event = incoming_grant_event(
            &a,
            grant_content_json(&a_hex, &b_hex, "cto", &["spend:100000"], None, None, false),
            "g-root",
        );
        let result = ingest(&state, &tenant, event).await;
        expect_rejection(
            result,
            "standing",
            "root grant without canGrant standing must be rejected",
        );

        pg_cleanup(&pool, community).await;
    }

    /// Enforcement OFF (the default) accepts the exact same widening
    /// grant through the same real ingest path — store-and-forward,
    /// byte-identical to a relay with no grant logic.
    #[tokio::test]
    #[ignore = "requires migrated Postgres + Redis"]
    async fn enforcement_off_accepts_the_same_widening_grant() {
        let (pool, community) = pg_pool().await;
        let tenant = tenant_for(community);
        let (_a, b, _c) = seed_widening_fixture(&pool, community).await;
        let Some(state) = pg_app_state(&pool, false).await else {
            pg_cleanup(&pool, community).await;
            eprintln!("skipping: could not build AppState (config/media unavailable)");
            return;
        };

        let b_hex = b.public_key().to_hex();
        let c_hex = Keys::generate().public_key().to_hex();
        let event = incoming_grant_event(
            &b,
            grant_content_json(
                &b_hex,
                &c_hex,
                "eng",
                &["spend:200000"],
                Some("g1"),
                None,
                false,
            ),
            "g2",
        );
        let result = ingest(&state, &tenant, event)
            .await
            .expect("with enforcement off the same event must be accepted");
        assert!(result.accepted);

        pg_cleanup(&pool, community).await;
    }

    /// Fail closed: a chain whose parent grant is missing from the store
    /// is rejected, never verified.
    #[tokio::test]
    #[ignore = "requires migrated Postgres + Redis"]
    async fn enforcement_on_rejects_missing_parent_grant() {
        let (pool, community) = pg_pool().await;
        let tenant = tenant_for(community);
        let b = Keys::generate();
        let b_hex = b.public_key().to_hex();
        let c_hex = Keys::generate().public_key().to_hex();
        let Some(state) = pg_app_state(&pool, true).await else {
            pg_cleanup(&pool, community).await;
            eprintln!("skipping: could not build AppState (config/media unavailable)");
            return;
        };

        let event = incoming_grant_event(
            &b,
            grant_content_json(&b_hex, &c_hex, "eng", &["read"], Some("nope"), None, false),
            "g2",
        );
        let result = ingest(&state, &tenant, event).await;
        expect_rejection(result, "not found", "missing parent grant must be rejected");

        pg_cleanup(&pool, community).await;
    }

    /// Fail closed: a circular `parentGrant` chain is rejected.
    #[tokio::test]
    #[ignore = "requires migrated Postgres + Redis"]
    async fn enforcement_on_rejects_circular_chain() {
        let (pool, community) = pg_pool().await;
        let tenant = tenant_for(community);
        let a = Keys::generate();
        let b = Keys::generate();
        let a_hex = a.public_key().to_hex();
        let b_hex = b.public_key().to_hex();
        pg_insert_org_event(
            &pool,
            community,
            KIND_ORG_NODE,
            &a.public_key().to_bytes(),
            d_tag_value("cto"),
            node_content_json(&[&a_hex, &b_hex], &["read"]),
        )
        .await;
        // g1 (A→B) already names g2 — which is the event being submitted.
        pg_insert_org_event(
            &pool,
            community,
            KIND_ORG_GRANT,
            &a.public_key().to_bytes(),
            d_tag_value("g1"),
            grant_content_json(&a_hex, &b_hex, "cto", &["read"], Some("g2"), None, false),
        )
        .await;
        let Some(state) = pg_app_state(&pool, true).await else {
            pg_cleanup(&pool, community).await;
            eprintln!("skipping: could not build AppState (config/media unavailable)");
            return;
        };

        let event = incoming_grant_event(
            &b,
            grant_content_json(&b_hex, &a_hex, "cto", &["read"], Some("g1"), None, false),
            "g2",
        );
        let result = ingest(&state, &tenant, event).await;
        expect_rejection(result, "circular", "circular chain must be rejected");

        pg_cleanup(&pool, community).await;
    }

    /// The walk is bounded: a chain one hop past
    /// [`buzz_core::org_grant::MAX_GRANT_CHAIN_DEPTH`] is rejected even
    /// though every link attenuates and the graph is acyclic.
    #[tokio::test]
    #[ignore = "requires migrated Postgres + Redis"]
    async fn enforcement_on_rejects_chain_beyond_depth_cap() {
        let (pool, community) = pg_pool().await;
        let tenant = tenant_for(community);
        use buzz_core::org_grant::MAX_GRANT_CHAIN_DEPTH;

        // Three seat holders cycle as issuer→grantee so every continuity
        // check holds along the chain.
        let p: Vec<Keys> = (0..3).map(|_| Keys::generate()).collect();
        let hexes: Vec<String> = p.iter().map(|k| k.public_key().to_hex()).collect();
        pg_insert_org_event(
            &pool,
            community,
            KIND_ORG_NODE,
            &p[0].public_key().to_bytes(),
            d_tag_value("cto"),
            node_content_json(&[&hexes[0], &hexes[1], &hexes[2]], &["read"]),
        )
        .await;

        // Seeds s0..s{cap}: s_i chains from s_{i-1}; the last seed names a
        // parent that does not exist, so the walk must hit the depth cap
        // before it hits the missing-parent error.
        let count = MAX_GRANT_CHAIN_DEPTH + 1; // 33 seeds
        for i in 0..count {
            let issuer = &p[i % 3];
            let grantee = &hexes[(i + 1) % 3];
            let parent = if i == 0 {
                None
            } else {
                Some(format!("s{}", i - 1))
            };
            pg_insert_org_event(
                &pool,
                community,
                KIND_ORG_GRANT,
                &issuer.public_key().to_bytes(),
                d_tag_value(&format!("s{i}")),
                grant_content_json(
                    &hexes[i % 3],
                    grantee,
                    "cto",
                    &["read"],
                    parent.as_deref(),
                    None,
                    false,
                ),
            )
            .await;
        }
        let Some(state) = pg_app_state(&pool, true).await else {
            pg_cleanup(&pool, community).await;
            eprintln!("skipping: could not build AppState (config/media unavailable)");
            return;
        };

        let issuer = &p[count % 3];
        let event = incoming_grant_event(
            issuer,
            grant_content_json(
                &hexes[count % 3],
                &hexes[(count + 1) % 3],
                "cto",
                &["read"],
                Some(&format!("s{}", count - 1)),
                None,
                false,
            ),
            "g-in",
        );
        let result = ingest(&state, &tenant, event).await;
        expect_rejection(
            result,
            "depth",
            "chain beyond the depth cap must be rejected",
        );

        pg_cleanup(&pool, community).await;
    }

    /// Positive control: enforcement ON admits a fully valid two-level
    /// attenuating chain — the gate is not a blanket reject.
    #[tokio::test]
    #[ignore = "requires migrated Postgres + Redis"]
    async fn enforcement_on_accepts_valid_chain() {
        let (pool, community) = pg_pool().await;
        let tenant = tenant_for(community);
        let (_a, b, _c) = seed_widening_fixture(&pool, community).await;
        let Some(state) = pg_app_state(&pool, true).await else {
            pg_cleanup(&pool, community).await;
            eprintln!("skipping: could not build AppState (config/media unavailable)");
            return;
        };

        let b_hex = b.public_key().to_hex();
        let c_hex = Keys::generate().public_key().to_hex();
        let event = incoming_grant_event(
            &b,
            grant_content_json(
                &b_hex,
                &c_hex,
                "eng",
                &["spend:50000"],
                Some("g1"),
                None,
                false,
            ),
            "g2",
        );
        let result = ingest(&state, &tenant, event)
            .await
            .expect("valid attenuating chain must be admitted");
        assert!(result.accepted);

        pg_cleanup(&pool, community).await;
    }

    /// A revocation republication (`"revoked": true`) is always admitted —
    /// it only removes authority — even with no chain in the store.
    #[tokio::test]
    #[ignore = "requires migrated Postgres + Redis"]
    async fn enforcement_on_admits_revocation_republication() {
        let (pool, community) = pg_pool().await;
        let tenant = tenant_for(community);
        let a = Keys::generate();
        let a_hex = a.public_key().to_hex();
        let b_hex = Keys::generate().public_key().to_hex();
        let Some(state) = pg_app_state(&pool, true).await else {
            pg_cleanup(&pool, community).await;
            eprintln!("skipping: could not build AppState (config/media unavailable)");
            return;
        };

        let event = incoming_grant_event(
            &a,
            grant_content_json(&a_hex, &b_hex, "cto", &["read"], None, None, true),
            "g1",
        );
        let result = ingest(&state, &tenant, event)
            .await
            .expect("revocation republication must be admitted");
        assert!(result.accepted);

        pg_cleanup(&pool, community).await;
    }

    /// A signed grant naming someone else as `issuer` is rejected before
    /// any chain walk — grants are addressed by `(issuer, 37011, d)`.
    #[tokio::test]
    #[ignore = "requires migrated Postgres + Redis"]
    async fn enforcement_on_rejects_issuer_not_author() {
        let (pool, community) = pg_pool().await;
        let tenant = tenant_for(community);
        let a = Keys::generate();
        let a_hex = a.public_key().to_hex();
        pg_insert_org_event(
            &pool,
            community,
            KIND_ORG_NODE,
            &a.public_key().to_bytes(),
            d_tag_value("cto"),
            node_content_json(&[&a_hex], &["read"]),
        )
        .await;
        let Some(state) = pg_app_state(&pool, true).await else {
            pg_cleanup(&pool, community).await;
            eprintln!("skipping: could not build AppState (config/media unavailable)");
            return;
        };

        // Signed by `b` but claims `a` as issuer.
        let b = Keys::generate();
        let event = incoming_grant_event(
            &b,
            grant_content_json(
                &a_hex,
                &b.public_key().to_hex(),
                "cto",
                &["read"],
                None,
                None,
                false,
            ),
            "g-forge",
        );
        let result = ingest(&state, &tenant, event).await;
        expect_rejection(result, "issuer", "issuer/author mismatch must be rejected");

        pg_cleanup(&pool, community).await;
    }
}
