//! NIP-ORG authority gates at ingest (kinds:37010 nodes, 37011 grants).
//!
//! The rules themselves live, pure and I/O-free, in
//! [`buzz_core::org_grant`]; the Postgres reads live in
//! `buzz_db::store::org_graph` behind the `OrgGraphSource` trait. This module
//! is the ingest glue: it builds the community's [`PgOrgGraph`] and maps an
//! authority decision onto an [`IngestError`].
//!
//! # Who may write the graph (always on)
//!
//! [`validate_org_node_publication`] applies the R1 authority anchor to every
//! kind:37010 write, independent of `ORG_GRANT_ENFORCEMENT`: the community
//! owner/admin may publish any node; anyone else only a **child** of an
//! anchored node they hold a seat in, with a `canGrant` no wider than the
//! parent's, and never under an id another author already uses. Nodes,
//! grants and budgets are *referenced* by bare `d`, so without this a member
//! could shadow a legitimate node by publishing a newer record for the same
//! id.
//!
//! # Grant chains (default on, `ORG_GRANT_ENFORCEMENT=off` to disable)
//!
//! [`enforce_grant_chain`] verifies an incoming kind:37011 grant before
//! acceptance:
//!
//! 1. the signer is the claimed `issuer`;
//! 2. every `parentGrant` resolves **by signer** (stored author == its own
//!    `issuer`, grantee == the child's issuer), never to a same-`d` decoy;
//! 3. every `via` resolves to an **anchored** node the link's issuer holds a
//!    seat in;
//! 4. attenuation, root standing, expiry and revocation hold along the chain.
//!
//! **Fail closed.** A chain that cannot be fully verified is rejected; a
//! database error is an error reply ([`IngestError::Internal`]), never an
//! implicit allow. Revocations (`"revoked": true`) are always admissible — a
//! revocation only removes authority.
//!
//! Equity records (`"type": "equity"`, the Project Board's ownership stake,
//! `verbs: []`) record a percentage, not a capability; they are exempt from
//! chain verification and authority views ignore them.

use std::sync::Arc;

use buzz_core::org_grant::{
    check_node_publication, is_equity_grant_content, parse_stored_node, verify_incoming_grant,
    OrgAuthorityError, OrgGrantContent, ResolvedGrant,
};
use buzz_core::tenant::TenantContext;
use chrono::Utc;
use nostr::Event;

use crate::handlers::ingest::IngestError;
use crate::state::AppState;

/// Extract the single `d` tag value from an event.
///
/// The org envelope validation upstream guarantees exactly one bounded `d`
/// tag for the org kinds; a missing tag here is a defensive reject.
fn d_tag_of(event: &Event) -> Result<String, IngestError> {
    event
        .tags
        .iter()
        .find(|t| t.as_slice().first() == Some(&"d".to_string()))
        .and_then(|t| t.as_slice().get(1).map(|v| v.to_string()))
        .ok_or_else(|| IngestError::Rejected("invalid: org event must carry a `d` tag".into()))
}

/// Map a failed authority decision onto an ingest error.
///
/// A denial is a rejection (`restricted:`); a store failure is an internal
/// error, never an implicit allow or deny (Review-Proven Rule 1).
pub(crate) fn authority_ingest_error(
    err: OrgAuthorityError<buzz_db::DbError>,
    what: &str,
) -> IngestError {
    match err {
        OrgAuthorityError::Source(e) => IngestError::Internal(format!(
            "error: db error resolving org authority for {what}: {e}"
        )),
        OrgAuthorityError::Denied(denial) => IngestError::Rejected(format!("restricted: {denial}")),
    }
}

/// Enforce the grant chain for an incoming kind:37011 event.
///
/// Called from the ingest pipeline when `ORG_GRANT_ENFORCEMENT` is on (the
/// default). See the module docs for the full contract.
pub(crate) async fn enforce_grant_chain(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    event: &Event,
) -> Result<(), IngestError> {
    let raw: serde_json::Value = serde_json::from_str(&event.content).map_err(|e| {
        IngestError::Rejected(format!(
            "invalid: org grant content must be a valid org grant object: {e}"
        ))
    })?;

    // Ownership stakes are records, not delegations.
    if is_equity_grant_content(&raw) {
        return Ok(());
    }

    let content: OrgGrantContent = serde_json::from_value(raw).map_err(|e| {
        IngestError::Rejected(format!(
            "invalid: org grant content must be a valid org grant object: {e}"
        ))
    })?;

    let incoming = ResolvedGrant {
        d: d_tag_of(event)?,
        issuer: content.issuer.to_ascii_lowercase(),
        grantee: content.grantee.to_ascii_lowercase(),
        via: content.via,
        verbs: content.verbs,
        parent_grant: content.parent_grant,
        expires: content.expires,
        revoked: content.revoked,
    };

    let graph = state.db.org_graph(tenant.community());
    verify_incoming_grant(
        &graph,
        &event.pubkey.to_hex(),
        incoming,
        Utc::now().timestamp().max(0) as u64,
    )
    .await
    .map_err(|e| authority_ingest_error(e, "org grant"))
}

/// Enforce the R1 authority anchor on an incoming kind:37010 node: the
/// owner/admin, or a holder of an anchored parent seat (with a scope no wider
/// than the parent's and an id nobody else uses). Always on.
pub(crate) async fn validate_org_node_publication(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    event: &Event,
) -> Result<(), IngestError> {
    let d = d_tag_of(event)?;
    let author_hex = event.pubkey.to_hex();
    let node = parse_stored_node(
        &author_hex,
        event.created_at.as_secs(),
        &event.id.to_hex(),
        &d,
        &event.content,
    )
    .ok_or_else(|| {
        IngestError::Rejected("invalid: org node content is not a valid org node".into())
    })?;

    let graph = state.db.org_graph(tenant.community());
    check_node_publication(
        &graph,
        &author_hex,
        &d,
        node.parent.as_deref(),
        &node.node.scope.can_grant,
    )
    .await
    .map_err(|e| authority_ingest_error(e, "org node"))
}

/// NIP-ORG onchain binding authority (kind:37010).
///
/// The `onchain` field on an org node binds the org root to a DAO (see
/// NIP-ORG "Opt-in onchain binding"). That is a governance act, so it is
/// restricted at ingest regardless of `ORG_GRANT_ENFORCEMENT`:
///
/// - only a **root** node may carry it (a binding on a subordinate seat
///   would claim authority over a subtree its author may not speak for);
/// - only the community **owner** or one of the root node's **holders**
///   may author it — the same trust boundary the budget publication rule
///   draws (author = subject or owner).
///
/// A malformed `onchain` object is rejected rather than stored dead: a
/// binding the clients cannot read is worse than none. Returns the
/// rejection message when publication is not allowed.
#[allow(clippy::question_mark)] // absent field (None) and non-object field (Some(error)) differ
pub(crate) fn org_node_binding_error(
    content: &serde_json::Value,
    author_hex: &str,
    author_role: Option<&str>,
) -> Option<String> {
    // Absent `onchain` -> nothing to validate. Present but not an object ->
    // reject rather than store a binding the clients cannot read.
    let Some(onchain) = content.get("onchain") else {
        return None;
    };
    let Some(binding) = onchain.as_object() else {
        return Some("org node content `onchain` must be an object".into());
    };

    // Root only: a bound node must not itself report a parent.
    let has_parent = content
        .get("parent")
        .and_then(|p| p.as_str())
        .is_some_and(|p| !p.is_empty());
    if has_parent {
        return Some("restricted: only the org root node may carry an `onchain` binding".into());
    }

    let chain = binding.get("chain").and_then(|c| c.as_str());
    let dao = binding.get("dao").and_then(|d| d.as_str());
    let bound_at = binding.get("boundAt").and_then(|b| b.as_u64());
    let (Some(chain), Some(dao), Some(bound_at)) = (chain, dao, bound_at) else {
        return Some(
            "org node content `onchain` must carry non-empty `chain`, `dao`, and numeric `boundAt`"
                .into(),
        );
    };
    if chain.trim().is_empty() || dao.trim().is_empty() {
        return Some("org node content `onchain` chain and dao must be non-empty".into());
    }
    if bound_at == 0 {
        return Some("org node content `onchain` boundAt must be a positive unix timestamp".into());
    }

    let holder = content
        .get("holders")
        .and_then(|h| h.as_array())
        .map(|holders| {
            holders
                .iter()
                .filter_map(|h| h.as_str())
                .any(|h| h.eq_ignore_ascii_case(author_hex))
        })
        .unwrap_or(false);
    if holder {
        return None;
    }
    if author_role == Some("owner") {
        return None;
    }
    Some(
        "restricted: an org onchain binding may only be published by a root node holder or the community owner"
            .into(),
    )
}

/// Validate a kind:37010 org node that carries an `onchain` binding at
/// ingest: shape plus the publication-authority rule (root holder or
/// community owner). Nodes without an `onchain` field are untouched.
pub(crate) async fn validate_org_node_binding(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    event: &nostr::Event,
) -> Result<(), IngestError> {
    let content: serde_json::Value = serde_json::from_str(&event.content).map_err(|e| {
        IngestError::Rejected(format!("invalid: org node content must be valid JSON: {e}"))
    })?;
    if content.get("onchain").is_none() {
        return Ok(());
    }

    let author_hex = event.pubkey.to_hex();
    let author_holds = content
        .get("holders")
        .and_then(|h| h.as_array())
        .map(|holders| {
            holders
                .iter()
                .filter_map(|h| h.as_str())
                .any(|h| h.eq_ignore_ascii_case(&author_hex))
        })
        .unwrap_or(false);
    if author_holds {
        // Holders are trusted for their own root; still run the shape rule.
        if let Some(msg) = org_node_binding_error(&content, &author_hex, Some("owner")) {
            return Err(IngestError::Rejected(msg));
        }
        return Ok(());
    }

    let author_role = state
        .db
        .get_relay_member(tenant.community(), &author_hex)
        .await
        .map_err(|e| {
            IngestError::Internal(format!("error: db error checking binding author: {e}"))
        })?
        .map(|m| m.role);
    if let Some(msg) = org_node_binding_error(&content, &author_hex, author_role.as_deref()) {
        return Err(IngestError::Rejected(msg));
    }
    Ok(())
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
        sqlx::query("DELETE FROM relay_members WHERE community_id = $1")
            .bind(community)
            .execute(pool)
            .await
            .expect("delete relay members");
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
        // R1 anchor: a root node (no `parent`) is only anchored when its
        // author is the community owner/admin, so the fixture's root authors
        // are seated as admins. Child nodes stay unanchored unless their
        // parent chain reaches one.
        if kind == KIND_ORG_NODE && content.get("parent").is_none_or(|p| p.is_null()) {
            sqlx::query(
                "INSERT INTO relay_members (community_id, pubkey, role) VALUES ($1, $2, 'admin') \
                 ON CONFLICT DO NOTHING",
            )
            .bind(community)
            .bind(hex::encode(author))
            .execute(pool)
            .await
            .expect("seat fixture admin");
        }
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

    // -- org node onchain binding authority --------------------------------

    fn binding_content(holders: &[&str], parent: Option<&str>) -> serde_json::Value {
        let mut v = serde_json::json!({
            "v": 1,
            "name": "Founder",
            "kind": "role",
            "holders": holders,
            "onchain": {
                "chain": "eip155:31337",
                "dao": "0x5fbdb2315678afecb367f032d93f642f64180aa3",
                "boundAt": 1_789_870_800u64,
            },
        });
        if let Some(parent) = parent {
            v["parent"] = serde_json::Value::String(parent.into());
        }
        v
    }

    #[test]
    fn binding_by_root_holder_is_allowed() {
        let author = "aa00000000000000000000000000000000000000000000000000000000000001";
        let content = binding_content(&[author], None);
        assert!(org_node_binding_error(&content, author, None).is_none());
    }

    #[test]
    fn binding_by_community_owner_is_allowed() {
        let author = "aa00000000000000000000000000000000000000000000000000000000000001";
        let holder = "bb00000000000000000000000000000000000000000000000000000000000002";
        let content = binding_content(&[holder], None);
        assert!(org_node_binding_error(&content, author, Some("owner")).is_none());
    }

    #[test]
    fn binding_by_unrelated_member_is_rejected() {
        let holder = "bb00000000000000000000000000000000000000000000000000000000000002";
        let author = "cc00000000000000000000000000000000000000000000000000000000000003";
        let content = binding_content(&[holder], None);
        let err = org_node_binding_error(&content, author, Some("member"));
        assert!(err.is_some_and(|e| e.contains("root node holder or the community owner")));
    }

    #[test]
    fn binding_on_a_subordinate_node_is_rejected() {
        let author = "aa00000000000000000000000000000000000000000000000000000000000001";
        let content = binding_content(&[author], Some("founder"));
        let err = org_node_binding_error(&content, author, Some("owner"));
        assert!(err.is_some_and(|e| e.contains("only the org root node")));
    }

    #[test]
    fn malformed_binding_is_rejected_even_for_holders() {
        let author = "aa00000000000000000000000000000000000000000000000000000000000001";
        let mut content = binding_content(&[author], None);
        content["onchain"] = serde_json::json!({ "chain": "eip155:31337" });
        let err = org_node_binding_error(&content, author, None);
        assert!(err.is_some_and(|e| e.contains("dao")));
    }

    #[test]
    fn non_object_binding_is_rejected() {
        let author = "aa00000000000000000000000000000000000000000000000000000000000001";
        let mut content = binding_content(&[author], None);
        content["onchain"] = serde_json::json!("0xdeadbeef");
        let err = org_node_binding_error(&content, author, Some("owner"));
        assert!(err.is_some_and(|e| e.contains("must be an object")));
    }

    #[test]
    fn zero_bound_at_is_rejected() {
        let author = "aa00000000000000000000000000000000000000000000000000000000000001";
        let mut content = binding_content(&[author], None);
        content["onchain"]["boundAt"] = serde_json::json!(0);
        let err = org_node_binding_error(&content, author, None);
        assert!(err.is_some_and(|e| e.contains("boundAt")));
    }

    #[test]
    fn node_without_onchain_is_untouched() {
        let author = "aa00000000000000000000000000000000000000000000000000000000000001";
        let content = serde_json::json!({ "v": 1, "name": "CTO", "kind": "role" });
        assert!(org_node_binding_error(&content, author, None).is_none());
    }

    // ── ingest-level authority tests (R1) ─────────────────────────────────
    //
    // These drive the real `ingest_event` seam so each guard in `ingest.rs`
    // and this module is bound: delete the guard and a test here fails.

    /// Delete everything a test community owns: every table with a foreign key
    /// to `communities`, retried until foreign keys between them clear.
    async fn pg_cleanup_all(pool: &sqlx::PgPool, community: uuid::Uuid) {
        // The only interpolated value is a UUID generated by this test.
        sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
            r#"
            DO $$
            DECLARE r record; pass int;
            BEGIN
              FOR pass IN 1..6 LOOP
                FOR r IN SELECT DISTINCT conrelid::regclass AS t FROM pg_constraint
                         WHERE confrelid = 'communities'::regclass AND contype = 'f'
                LOOP
                  BEGIN
                    EXECUTE format('DELETE FROM %s WHERE community_id = %L', r.t, '{community}');
                  EXCEPTION WHEN foreign_key_violation THEN NULL;
                  END;
                END LOOP;
              END LOOP;
              DELETE FROM communities WHERE id = '{community}';
            END $$;
            "#
        )))
        .execute(pool)
        .await
        .expect("clean the test community");
    }

    async fn pg_seat_admin(pool: &sqlx::PgPool, community: uuid::Uuid, keys: &Keys) {
        sqlx::query(
            "INSERT INTO relay_members (community_id, pubkey, role) VALUES ($1, $2, 'admin')              ON CONFLICT DO NOTHING",
        )
        .bind(community)
        .bind(keys.public_key().to_hex())
        .execute(pool)
        .await
        .expect("seat admin");
    }

    fn signed_node_event(
        keys: &Keys,
        d: &str,
        parent: Option<&str>,
        holders: &[&str],
        can_grant: &[&str],
    ) -> nostr::Event {
        let mut content = node_content_json(holders, can_grant);
        if let Some(p) = parent {
            content["parent"] = serde_json::json!(p);
        }
        EventBuilder::new(Kind::Custom(KIND_ORG_NODE as u16), content.to_string())
            .tags([
                Tag::parse(["d", d]).expect("d tag"),
                Tag::parse(["name", "node"]).expect("name tag"),
            ])
            .sign_with_keys(keys)
            .expect("sign node")
    }

    async fn stored_count(pool: &sqlx::PgPool, community: uuid::Uuid, kind: i32, d: &str) -> i64 {
        sqlx::query_scalar(
            "SELECT count(*) FROM events WHERE community_id = $1 AND kind = $2 AND d_tag = $3",
        )
        .bind(community)
        .bind(kind)
        .bind(d)
        .fetch_one(pool)
        .await
        .expect("count stored events")
    }

    /// Only the owner/admin may publish a root node; a member's attempt is
    /// refused and nothing is stored.
    #[tokio::test]
    #[ignore = "requires migrated Postgres + Redis"]
    async fn ingest_refuses_a_root_node_from_a_member_and_admits_the_admin() {
        let (pool, community) = pg_pool().await;
        let tenant = tenant_for(community);
        let (admin, member) = (Keys::generate(), Keys::generate());
        pg_seat_admin(&pool, community, &admin).await;
        let Some(state) = pg_app_state(&pool, true).await else {
            pg_cleanup_all(&pool, community).await;
            return;
        };
        let member_hex = member.public_key().to_hex();

        let refused = ingest(
            &state,
            &tenant,
            signed_node_event(&member, "root", None, &[&member_hex], &["read"]),
        )
        .await;
        expect_rejection(refused, "root org node", "a member cannot publish a root");
        assert_eq!(stored_count(&pool, community, 37010, "root").await, 0);

        let admitted = ingest(
            &state,
            &tenant,
            signed_node_event(&admin, "root", None, &[&member_hex], &["read"]),
        )
        .await
        .expect("the admin may publish the root");
        assert!(admitted.accepted);

        pg_cleanup_all(&pool, community).await;
    }

    /// A seat holder may publish a child of their node, but cannot reuse an id
    /// the admin already holds, and cannot widen the parent's canGrant.
    #[tokio::test]
    #[ignore = "requires migrated Postgres + Redis"]
    async fn ingest_holds_seat_holders_to_their_own_subtree() {
        let (pool, community) = pg_pool().await;
        let tenant = tenant_for(community);
        let (admin, member) = (Keys::generate(), Keys::generate());
        let member_hex = member.public_key().to_hex();
        // Admin-authored root (holders: the member) and a second admin node.
        for (d, holders) in [("root", vec![member_hex.as_str()]), ("cto", vec![])] {
            pg_insert_org_event(
                &pool,
                community,
                KIND_ORG_NODE,
                &admin.public_key().to_bytes(),
                d_tag_value(d),
                node_content_json(&holders, &["task:create"]),
            )
            .await;
        }
        pg_seat_admin(&pool, community, &admin).await;
        let Some(state) = pg_app_state(&pool, true).await else {
            pg_cleanup_all(&pool, community).await;
            return;
        };

        let squat = signed_node_event(
            &member,
            "cto",
            Some("root"),
            &[&member_hex],
            &["task:create"],
        );
        expect_rejection(
            ingest(&state, &tenant, squat).await,
            "already used by another author",
            "a member cannot shadow the admin's node id",
        );

        let wide = signed_node_event(&member, "wide", Some("root"), &[&member_hex], &["spend:5"]);
        expect_rejection(
            ingest(&state, &tenant, wide).await,
            "scope widens",
            "a child cannot delegate more than its parent",
        );

        let child = signed_node_event(
            &member,
            "sub",
            Some("root"),
            &[&member_hex],
            &["task:create"],
        );
        assert!(
            ingest(&state, &tenant, child)
                .await
                .expect("a holder may publish a child within scope")
                .accepted
        );

        // An outsider with no seat cannot hang a node under the same root.
        let outsider = Keys::generate();
        let orphan = signed_node_event(&outsider, "intruder", Some("root"), &[], &[]);
        expect_rejection(
            ingest(&state, &tenant, orphan).await,
            "not anchored",
            "a non-holder cannot attach under an anchored node",
        );

        pg_cleanup_all(&pool, community).await;
    }

    /// Equity records are ownership stakes, not delegations: exempt from chain
    /// verification. The same body without the marker is judged as a grant and
    /// refused.
    #[tokio::test]
    #[ignore = "requires migrated Postgres + Redis"]
    async fn ingest_exempts_equity_records_but_not_plain_grants() {
        let (pool, community) = pg_pool().await;
        let tenant = tenant_for(community);
        let (admin, member) = (Keys::generate(), Keys::generate());
        pg_insert_org_event(
            &pool,
            community,
            KIND_ORG_NODE,
            &admin.public_key().to_bytes(),
            d_tag_value("root"),
            node_content_json(&[&admin.public_key().to_hex()], &["read"]),
        )
        .await;
        pg_seat_admin(&pool, community, &admin).await;
        let Some(state) = pg_app_state(&pool, true).await else {
            pg_cleanup_all(&pool, community).await;
            return;
        };
        let member_hex = member.public_key().to_hex();
        let other = Keys::generate().public_key().to_hex();
        let body = grant_content_json(&member_hex, &other, "root", &[], None, None, false);

        // The member holds no seat in `root`: as a plain grant this is refused.
        expect_rejection(
            ingest(
                &state,
                &tenant,
                incoming_grant_event(&member, body.clone(), "stake-plain"),
            )
            .await,
            "not seated",
            "without the marker it is a delegation from someone with no standing",
        );

        let mut equity = body;
        equity["type"] = serde_json::json!("equity");
        assert!(
            ingest(
                &state,
                &tenant,
                incoming_grant_event(&member, equity, "stake-equity")
            )
            .await
            .expect("an equity record needs no chain")
            .accepted
        );

        pg_cleanup_all(&pool, community).await;
    }

    /// A same-`d` decoy signed by someone with no seat cannot displace or hijack
    /// the legitimate parent grant: the chain resolves by who signed it.
    #[tokio::test]
    #[ignore = "requires migrated Postgres + Redis"]
    async fn ingest_resolves_parent_grants_by_signer_not_by_id() {
        let (pool, community) = pg_pool().await;
        let tenant = tenant_for(community);
        let (_a, b, c) = seed_widening_fixture(&pool, community).await;
        // The decoy: attacker `c` publishes a newer `g1` naming `b` as grantee.
        pg_insert_org_event(
            &pool,
            community,
            KIND_ORG_GRANT,
            &c.public_key().to_bytes(),
            d_tag_value("g1"),
            grant_content_json(
                &c.public_key().to_hex(),
                &b.public_key().to_hex(),
                "cto",
                &["spend:999999"],
                None,
                None,
                false,
            ),
        )
        .await;
        let Some(state) = pg_app_state(&pool, true).await else {
            pg_cleanup_all(&pool, community).await;
            return;
        };
        let b_hex = b.public_key().to_hex();
        let target = Keys::generate().public_key().to_hex();

        // Within the legitimate g1 (spend:100000): admitted despite the decoy.
        let ok = incoming_grant_event(
            &b,
            grant_content_json(
                &b_hex,
                &target,
                "eng",
                &["spend:50000"],
                Some("g1"),
                None,
                false,
            ),
            "g2",
        );
        assert!(
            ingest(&state, &tenant, ok)
                .await
                .expect("the legitimate chain still verifies")
                .accepted
        );

        // Beyond the legitimate g1 but inside the decoy's claim: still refused.
        let too_wide = incoming_grant_event(
            &b,
            grant_content_json(
                &b_hex,
                &target,
                "eng",
                &["spend:500000"],
                Some("g1"),
                None,
                false,
            ),
            "g3",
        );
        // The reported reason depends on which same-second candidate is tried
        // first (the decoy's "not seated" or the real chain's "not entailed"),
        // so assert the refusal and that nothing was stored, not the wording.
        expect_rejection(
            ingest(&state, &tenant, too_wide).await,
            "restricted",
            "the decoy's wider scope must not be adopted",
        );
        assert_eq!(stored_count(&pool, community, 37011, "g3").await, 0);

        pg_cleanup_all(&pool, community).await;
    }

    /// Agent chat is metered by the community default budget at the ingest
    /// seam (kind 9); a human's chat is never metered.
    #[tokio::test]
    #[ignore = "requires migrated Postgres + Redis"]
    async fn ingest_meters_agent_chat_but_never_human_chat() {
        let (pool, community) = pg_pool().await;
        let tenant = tenant_for(community);
        let (owner, agent, human) = (Keys::generate(), Keys::generate(), Keys::generate());
        for k in [&owner, &agent, &human] {
            sqlx::query(
                "INSERT INTO users (community_id, pubkey) VALUES ($1, $2) ON CONFLICT DO NOTHING",
            )
            .bind(community)
            .bind(k.public_key().to_bytes().as_slice())
            .execute(&pool)
            .await
            .expect("insert user");
        }
        sqlx::query(
            "UPDATE users SET agent_owner_pubkey = $3 WHERE community_id = $1 AND pubkey = $2",
        )
        .bind(community)
        .bind(agent.public_key().to_bytes().as_slice())
        .bind(owner.public_key().to_bytes().as_slice())
        .execute(&pool)
        .await
        .expect("register agent");
        pg_seat_admin(&pool, community, &owner).await;
        // Default budget: one chat message per day.
        pg_insert_org_event_raw(
            &pool,
            community,
            37012,
            &owner.public_key().to_bytes(),
            serde_json::json!([["d", "default-agents"]]),
            serde_json::json!({
                "v": 1, "subject": "*", "window": "day",
                "limits": { "messages": 1 }, "onExceed": "reject",
            }),
        )
        .await;
        let Some(state) = pg_app_state(&pool, true).await else {
            pg_cleanup_all(&pool, community).await;
            return;
        };
        let channel = uuid::Uuid::new_v4();
        let creator = owner.public_key().to_bytes().to_vec();
        state
            .db
            .create_channel_with_id(
                buzz_core::CommunityId::from_uuid(community),
                channel,
                &format!("ch-{}", channel.simple()),
                buzz_db::channel::ChannelType::Stream,
                buzz_db::channel::ChannelVisibility::Open,
                None,
                &creator,
                None,
            )
            .await
            .expect("channel");
        for k in [&agent, &human] {
            state
                .db
                .add_member(
                    buzz_core::CommunityId::from_uuid(community),
                    channel,
                    &k.public_key().to_bytes(),
                    buzz_core::channel::MemberRole::Member,
                    Some(&creator),
                )
                .await
                .expect("member");
        }

        let say = |keys: &Keys, text: &str| {
            EventBuilder::new(Kind::Custom(9), text)
                .tags([Tag::parse(["h", &channel.to_string()]).expect("h tag")])
                .sign_with_keys(keys)
                .expect("sign chat")
        };
        assert!(
            ingest(&state, &tenant, say(&agent, "first"))
                .await
                .expect("the agent's first message is within the default budget")
                .accepted
        );
        expect_rejection(
            ingest(&state, &tenant, say(&agent, "second")).await,
            "messages limit 1",
            "the default budget must bind an agent's chat",
        );
        for i in 0..3 {
            assert!(
                ingest(&state, &tenant, say(&human, &format!("human {i}")))
                    .await
                    .expect("humans are never metered")
                    .accepted
            );
        }

        pg_cleanup_all(&pool, community).await;
    }

    /// Raw event row for kinds the store recipe above does not cover.
    async fn pg_insert_org_event_raw(
        pool: &sqlx::PgPool,
        community: uuid::Uuid,
        kind: i32,
        author: &[u8; 32],
        tags: serde_json::Value,
        content: serde_json::Value,
    ) {
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
        .bind(kind)
        .bind(tags)
        .bind(content.to_string())
        .bind([2u8; 64])
        .bind(d)
        .execute(pool)
        .await
        .expect("insert raw event");
    }
}
