//! Relay-side wiki governance: team-scope stickiness (kind 44001), agent-wiki
//! authority (44002), the delete-semantics split, and corrections (44003).
//!
//! The DB-backed tests drive the REAL seams — `ingest_event` and
//! `handle_a_tag_deletion` — so each is a mutation oracle: removing the
//! corresponding enforcement call site fails the test that names it. They are
//! ignored without infrastructure; run with
//! `cargo test -p buzz-relay --lib -- wiki_enforcement -- --ignored`.

use std::sync::Arc;

use buzz_auth::Scope;
use buzz_core::tenant::TenantContext;
use nostr::{EventBuilder, Keys, Kind, Tag};
use uuid::Uuid;

use super::ingest::{ingest_event, validate_wiki_correction_envelope, IngestAuth, IngestError};
use super::side_effects::{handle_a_tag_deletion, validate_standard_deletion_event};
use crate::state::AppState;

const KIND_WIKI_PAGE: u32 = buzz_core::kind::KIND_WIKI_PAGE;
const KIND_AGENT_WIKI_PAGE: u32 = buzz_core::kind::KIND_AGENT_WIKI_PAGE;
const KIND_WIKI_CORRECTION: u32 = buzz_core::kind::KIND_WIKI_CORRECTION;

fn t(kind: &str, value: &str) -> Tag {
    Tag::parse([kind, value]).expect("parse tag")
}

fn signed(kind: u32, keys: &Keys, content: &str, tags: Vec<Tag>) -> nostr::Event {
    EventBuilder::new(Kind::Custom(kind as u16), content)
        .tags(tags)
        .sign_with_keys(keys)
        .expect("sign event")
}

fn wiki_revision(keys: &Keys, d: &str, content: &str, team: Option<&str>) -> nostr::Event {
    let mut tags = vec![t("d", d)];
    if let Some(node) = team {
        tags.push(t("t", &format!("team:{node}")));
    }
    signed(KIND_WIKI_PAGE, keys, content, tags)
}

fn correction(keys: &Keys, slug: &str, content: &str) -> nostr::Event {
    signed(
        KIND_WIKI_CORRECTION,
        keys,
        content,
        vec![
            t("d", &format!("correction-for-{slug}")),
            t("t", &format!("correction-for:{slug}")),
        ],
    )
}

fn deletion(keys: &Keys, a_coordinate: &str) -> nostr::Event {
    signed(5, keys, "", vec![t("a", a_coordinate)])
}

fn deletion_with_purge(keys: &Keys, a_coordinate: &str) -> nostr::Event {
    signed(5, keys, "", vec![t("a", a_coordinate), t("purge", "1")])
}

// ---- pure envelope tests (no infrastructure) ------------------------------

#[test]
fn wiki_correction_envelope_accepts_pinned_shape() {
    let keys = Keys::generate();
    let ev = correction(&keys, "governance", "typo in line 2");
    assert!(validate_wiki_correction_envelope(&ev).is_ok());
}

#[test]
fn wiki_correction_envelope_rejects_missing_mismatched_or_bare_d() {
    let keys = Keys::generate();
    let missing_t = signed(
        KIND_WIKI_CORRECTION,
        &keys,
        "x",
        vec![t("d", "correction-for-governance")],
    );
    assert!(
        validate_wiki_correction_envelope(&missing_t)
            .unwrap_err()
            .contains("must carry a `t` tag shaped `correction-for:<slug>`"),
        "a correction without its pinned `t` tag must be rejected"
    );
    let wrong_slug = signed(
        KIND_WIKI_CORRECTION,
        &keys,
        "x",
        vec![
            t("d", "correction-for-governance"),
            t("t", "correction-for:other"),
        ],
    );
    assert!(validate_wiki_correction_envelope(&wrong_slug).is_err());
    let bare_slug = signed(
        KIND_WIKI_CORRECTION,
        &keys,
        "x",
        vec![t("d", "governance"), t("t", "correction-for:governance")],
    );
    assert!(validate_wiki_correction_envelope(&bare_slug)
        .unwrap_err()
        .contains("`d` tag must be shaped `correction-for-<slug>`"));
}

// ---- Postgres helpers (mirrors org_grant_enforcement's pg recipe) ----------

async fn pg_pool() -> (sqlx::PgPool, Uuid) {
    let database_url = crate::test_support::database_url();
    let pool = sqlx::PgPool::connect(&database_url)
        .await
        .expect("connect wiki governance test database");
    let db = buzz_db::Db::from_pool(pool.clone());
    db.migrate().await.expect("migrate test database");
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO communities (id, host) VALUES ($1, $2)")
        .bind(id)
        .bind(format!("wiki-gov-{id}.test"))
        .execute(&pool)
        .await
        .expect("insert community");
    (pool, id)
}

async fn pg_cleanup(pool: &sqlx::PgPool, community: Uuid) {
    sqlx::query("DELETE FROM event_mentions WHERE community_id = $1")
        .bind(community)
        .execute(pool)
        .await
        .expect("cleanup event mentions");
    sqlx::query("DELETE FROM audit_log WHERE community_id = $1")
        .bind(community)
        .execute(pool)
        .await
        .expect("cleanup audit log");
    sqlx::query("DELETE FROM events WHERE community_id = $1")
        .bind(community)
        .execute(pool)
        .await
        .expect("cleanup events");
    sqlx::query("DELETE FROM relay_members WHERE community_id = $1")
        .bind(community)
        .execute(pool)
        .await
        .expect("cleanup relay members");
    sqlx::query("DELETE FROM communities WHERE id = $1")
        .bind(community)
        .execute(pool)
        .await
        .expect("delete community");
}

async fn app_state(pool: &sqlx::PgPool) -> Arc<AppState> {
    let database_url = crate::test_support::database_url();
    let mut config = crate::config::Config::from_env().expect("config");
    config.database_url = database_url;
    config.redis_url = "redis://127.0.0.1:6379".to_string();
    config.relay_url = "wss://wiki-governance.test".to_string();

    let redis_pool = deadpool_redis::Config::from_url(&config.redis_url)
        .create_pool(Some(deadpool_redis::Runtime::Tokio1))
        .expect("redis pool");
    let pubsub = Arc::new(
        buzz_pubsub::PubSubManager::new(&config.redis_url, redis_pool.clone())
            .await
            .expect("pubsub manager"),
    );
    let audit = None::<buzz_audit::AuditService>;
    let auth = buzz_auth::AuthService::new(config.auth.clone());
    let search = buzz_search::SearchService::new(pool.clone());
    let workflow_engine = Arc::new(buzz_workflow::WorkflowEngine::new(
        buzz_db::Db::from_pool(pool.clone()),
        buzz_workflow::WorkflowConfig::default(),
    ));
    let media_storage = buzz_media::MediaStorage::new(&config.media).expect("media storage");
    let (state, _audit_shutdown) = crate::state::AppState::new(
        config,
        buzz_db::Db::from_pool(pool.clone()),
        redis_pool,
        audit,
        pubsub,
        auth,
        search,
        workflow_engine,
        Keys::generate(),
        media_storage,
    );
    Arc::new(state)
}

fn tenant_for(community: Uuid) -> TenantContext {
    TenantContext::resolved(
        buzz_core::CommunityId::from_uuid(community),
        format!("wiki-gov-{community}.test"),
    )
}

async fn ingest(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    event: nostr::Event,
) -> Result<crate::handlers::ingest::IngestResult, IngestError> {
    let auth = IngestAuth::Nip42 {
        pubkey: event.pubkey,
        scopes: vec![Scope::MessagesWrite],
        channel_ids: None,
        conn_id: Uuid::new_v4(),
    };
    ingest_event(state, tenant, event, auth).await
}

fn expect_rejection(
    result: Result<crate::handlers::ingest::IngestResult, IngestError>,
    needle: &str,
    context: &str,
) {
    match result {
        Err(IngestError::Rejected(msg)) => assert!(
            msg.contains(needle),
            "{context}: expected {needle:?} in {msg:?}"
        ),
        Err(other) => panic!("{context}: expected Rejected, got {other:?}"),
        Ok(_) => panic!("{context}: expected rejection, event was accepted"),
    }
}

async fn seed_member(pool: &sqlx::PgPool, community: Uuid, keys: &Keys, role: &str) {
    sqlx::query(
        "INSERT INTO relay_members (community_id, pubkey, role) VALUES ($1, $2, $3) \
         ON CONFLICT DO NOTHING",
    )
    .bind(community)
    .bind(keys.public_key().to_hex())
    .bind(role)
    .execute(pool)
    .await
    .expect("seed member");
}

/// Seed one raw org node (kind 37010) VERSION with `agentSeats`/`holders` —
/// the org graph the wiki team-scope and agent-wiki rules read. Only the
/// CANONICAL (anchored, admin-first) version's seats count, so tests that
/// want a granted seat seed an admin-authored version (or one anchored
/// through an admin-held parent); `created_at_secs` orders competing
/// versions (newest admin-authored wins) and `parent` anchors a
/// non-admin-authored copy through an admin-held root.
#[allow(clippy::too_many_arguments)]
async fn seed_node_version(
    pool: &sqlx::PgPool,
    community: Uuid,
    node_id: &str,
    author_hex: &str,
    agent_seats: &[&str],
    holders: &[&str],
    parent: Option<&str>,
    created_at_secs: i64,
) {
    let mut event_id = [0u8; 32];
    event_id[..16].copy_from_slice(Uuid::new_v4().as_bytes());
    event_id[16..].copy_from_slice(Uuid::new_v4().as_bytes());
    let author = hex::decode(author_hex).expect("author hex");
    let mut body = serde_json::json!({"agentSeats": agent_seats, "holders": holders});
    if let Some(parent) = parent {
        body["parent"] = serde_json::json!(parent);
    }
    sqlx::query(
        "INSERT INTO events (community_id, id, pubkey, created_at, kind, tags, content, sig, d_tag) \
         VALUES ($1, $2, $3, to_timestamp($4), $5, $6, $7, $8, $9)",
    )
    .bind(community)
    .bind(event_id.as_slice())
    .bind(author.as_slice())
    .bind(created_at_secs)
    .bind(buzz_core::kind::KIND_ORG_NODE as i32)
    .bind(serde_json::json!([["d", node_id]]))
    .bind(body.to_string())
    .bind([2u8; 64])
    .bind(node_id)
    .execute(pool)
    .await
    .expect("insert team node");
}

/// Seed a raw org node (kind 37010) authored by the community owner/admin —
/// anchored and canonical, so its seats actually count. Seed the admin
/// member first. Stale/competing versions are seeded with
/// [`seed_node_version`].
async fn seed_team_node(
    pool: &sqlx::PgPool,
    community: Uuid,
    node_id: &str,
    agent_seats: &[&str],
    holders: &[&str],
) {
    let admin_hex: (String,) = sqlx::query_as(
        "SELECT pubkey FROM relay_members \
         WHERE community_id = $1 AND role IN ('owner', 'admin') LIMIT 1",
    )
    .bind(community)
    .fetch_one(pool)
    .await
    .expect("seed the admin member before seeding team nodes");
    let now = chrono::Utc::now().timestamp();
    seed_node_version(
        pool,
        community,
        node_id,
        &admin_hex.0,
        agent_seats,
        holders,
        None,
        now,
    )
    .await
}

/// Seed a raw kind:44001 revision row straight into `events` — for histories
/// the ingest enforcement would never allow (imported/conflicting data).
async fn seed_wiki_revision_row(
    pool: &sqlx::PgPool,
    community: Uuid,
    d: &str,
    author_hex: &str,
    scope: Option<&str>,
    created_at_secs: i64,
) {
    let mut event_id = [0u8; 32];
    event_id[..16].copy_from_slice(Uuid::new_v4().as_bytes());
    event_id[16..].copy_from_slice(Uuid::new_v4().as_bytes());
    let author = hex::decode(author_hex).expect("author hex");
    let mut tags = vec![serde_json::json!(["d", d])];
    if let Some(node) = scope {
        tags.push(serde_json::json!(["t", format!("team:{node}")]));
    }
    sqlx::query(
        "INSERT INTO events (community_id, id, pubkey, created_at, kind, tags, content, sig, d_tag) \
         VALUES ($1, $2, $3, to_timestamp($4), $5, $6, $7, $8, $9)",
    )
    .bind(community)
    .bind(event_id.as_slice())
    .bind(author.as_slice())
    .bind(created_at_secs)
    .bind(KIND_WIKI_PAGE as i32)
    .bind(serde_json::Value::Array(tags))
    .bind("imported revision")
    .bind([2u8; 64])
    .bind(d)
    .execute(pool)
    .await
    .expect("insert wiki revision row");
}

// ---- item 1: sticky team scope -------------------------------------------

/// Mutation oracle: remove the `enforce_wiki_page_scope` call site in
/// `ingest_event_inner` and both revisions below are accepted.
#[tokio::test]
#[ignore = "requires migrated Postgres + Redis"]
async fn team_scoped_page_rejects_dropping_or_changing_scope() {
    let (pool, community) = pg_pool().await;
    let state = app_state(&pool).await;
    let tenant = tenant_for(community);

    let admin = Keys::generate();
    let seated = Keys::generate();
    seed_member(&pool, community, &admin, "admin").await;
    seed_member(&pool, community, &seated, "member").await;
    let seated_hex = seated.public_key().to_hex();
    seed_team_node(&pool, community, "eng", &[&seated_hex], &[]).await;

    let d = "handbook";
    ingest(&state, &tenant, wiki_revision(&admin, d, "v1", Some("eng")))
        .await
        .expect("admin may scope a page to a team");

    let dropped = ingest(&state, &tenant, wiki_revision(&seated, d, "v2", None)).await;
    expect_rejection(
        dropped,
        "may not drop its `t: team:<node-id>` tag",
        "tag-dropping revision",
    );

    let changed = ingest(
        &state,
        &tenant,
        wiki_revision(&seated, d, "v2", Some("sales")),
    )
    .await;
    expect_rejection(
        changed,
        "may not change its `t: team:<node-id>` team",
        "scope-changing revision",
    );

    pg_cleanup(&pool, community).await;
}

/// Mutation oracle: remove the seat check in `require_wiki_team_authority`
/// and the non-seat member's revision is accepted.
#[tokio::test]
#[ignore = "requires migrated Postgres + Redis"]
async fn team_scoped_page_rejects_non_seat_member_and_accepts_admin() {
    let (pool, community) = pg_pool().await;
    let state = app_state(&pool).await;
    let tenant = tenant_for(community);

    let admin = Keys::generate();
    let member = Keys::generate();
    seed_member(&pool, community, &admin, "admin").await;
    seed_member(&pool, community, &member, "member").await;
    seed_team_node(&pool, community, "eng", &[], &[]).await;

    let d = "handbook";
    ingest(&state, &tenant, wiki_revision(&admin, d, "v1", Some("eng")))
        .await
        .expect("admin may scope a page to a team");

    let rejected = ingest(
        &state,
        &tenant,
        wiki_revision(&member, d, "v2", Some("eng")),
    )
    .await;
    expect_rejection(
        rejected,
        "requires a seat in team eng or community admin/owner",
        "non-seat member on a team page",
    );

    ingest(&state, &tenant, wiki_revision(&admin, d, "v2", Some("eng")))
        .await
        .expect("admin is accepted on a team page");

    pg_cleanup(&pool, community).await;
}

// ---- item 3(a) + item 1 restore ------------------------------------------

/// Mutation oracle: restore `tombstone_wiki_page_by_slug` to the content-strip
/// variant (or reset the sticky scope on delete) and this fails.
#[tokio::test]
#[ignore = "requires migrated Postgres + Redis"]
async fn author_delete_tombstones_but_restores_via_authorized_editor() {
    let (pool, community) = pg_pool().await;
    let state = app_state(&pool).await;
    let tenant = tenant_for(community);

    let admin = Keys::generate();
    let author = Keys::generate();
    let member = Keys::generate();
    seed_member(&pool, community, &admin, "admin").await;
    seed_member(&pool, community, &author, "member").await;
    seed_member(&pool, community, &member, "member").await;
    let author_hex = author.public_key().to_hex();
    seed_team_node(&pool, community, "eng", &[&author_hex], &[]).await;

    let d = "handbook";
    ingest(
        &state,
        &tenant,
        wiki_revision(&admin, d, "secret contents", Some("eng")),
    )
    .await
    .expect("seed scoped page");
    ingest(
        &state,
        &tenant,
        wiki_revision(&author, d, "secret contents", Some("eng")),
    )
    .await
    .expect("seat holder edits the scoped page");

    // Author delete = restorable tombstone.
    let del = deletion(&author, &format!("44001:{author_hex}:{d}"));
    validate_standard_deletion_event(&tenant, &del, &state)
        .await
        .expect("an author may delete the page");
    handle_a_tag_deletion(&tenant, &del, &state)
        .await
        .expect("author delete");

    let (live, kept): (i64, Option<String>) = sqlx::query_as(
        "SELECT count(*) FILTER (WHERE deleted_at IS NULL), \
                (array_agg(content) FILTER (WHERE content <> ''))[1] \
         FROM events WHERE community_id = $1 AND kind = $2 AND d_tag = $3",
    )
    .bind(community)
    .bind(KIND_WIKI_PAGE as i32)
    .bind(d)
    .fetch_one(&pool)
    .await
    .expect("read tombstoned page");
    assert_eq!(live, 0, "tombstoned page must be hidden from queries");
    assert_eq!(
        kept.as_deref(),
        Some("secret contents"),
        "an author delete must NOT strip content"
    );

    // The scope is sticky through the tombstone: no open-copy restore.
    let rejected = ingest(&state, &tenant, wiki_revision(&member, d, "restored", None)).await;
    expect_rejection(
        rejected,
        "may not drop its `t: team:<node-id>` tag",
        "unscoped restore by a plain member",
    );

    // An authorized editor restores the page with one new revision.
    ingest(
        &state,
        &tenant,
        wiki_revision(&author, d, "restored contents", Some("eng")),
    )
    .await
    .expect("authorized editor restores the page");
    let live_after: (i64,) = sqlx::query_as(
        "SELECT count(*) FROM events WHERE community_id = $1 AND kind = $2 AND d_tag = $3 \
         AND deleted_at IS NULL",
    )
    .bind(community)
    .bind(KIND_WIKI_PAGE as i32)
    .bind(d)
    .fetch_one(&pool)
    .await
    .expect("count live revisions");
    assert!(live_after.0 > 0, "restore must make the page live again");

    pg_cleanup(&pool, community).await;
}

// ---- item 2: agent wiki authority -----------------------------------------

/// Mutation oracle: remove the `enforce_agent_wiki_authority` call site and
/// the plain member's 44002 page is accepted.
#[tokio::test]
#[ignore = "requires migrated Postgres + Redis"]
async fn agent_wiki_requires_seated_agent_or_authority_holder() {
    let (pool, community) = pg_pool().await;
    let state = app_state(&pool).await;
    let tenant = tenant_for(community);

    let member = Keys::generate();
    let agent = Keys::generate();
    let admin = Keys::generate();
    let holder = Keys::generate();
    seed_member(&pool, community, &member, "member").await;
    seed_member(&pool, community, &admin, "admin").await;
    seed_member(&pool, community, &holder, "member").await;
    let agent_hex = agent.public_key().to_hex();
    let holder_hex = holder.public_key().to_hex();
    seed_team_node(&pool, community, "bots", &[&agent_hex], &[]).await;
    seed_team_node(&pool, community, "team", &[], &[&holder_hex]).await;

    let d = "default/standup";
    let page = |keys: &Keys| {
        signed(
            KIND_AGENT_WIKI_PAGE,
            keys,
            "# Standup",
            vec![t("d", d), t("model", "test-model")],
        )
    };

    let rejected = ingest(&state, &tenant, page(&member)).await;
    expect_rejection(
        rejected,
        "agent wiki pages require a seated agent signer",
        "plain member's 44002",
    );

    ingest(&state, &tenant, page(&agent))
        .await
        .expect("a seated agent is accepted");
    ingest(&state, &tenant, page(&admin))
        .await
        .expect("a community admin (distill runner) is accepted");
    ingest(&state, &tenant, page(&holder))
        .await
        .expect("a seat holder (distill runner) is accepted");

    pg_cleanup(&pool, community).await;
}

// ---- item 3(a): purge is explicit intent, not role ------------------------

/// Mutation oracle: drop the purge-tag gate (purge on the admin ROLE again,
/// or let an author's marker through) and the matrix below fails. The
/// contract: any delete marker without `["purge","1"]` is a RESTORABLE
/// tombstone (content preserved) — even an admin/owner's; `["purge","1"]`
/// from an admin/owner strips content + FTS; authors can never purge.
#[tokio::test]
#[ignore = "requires migrated Postgres + Redis"]
async fn purge_requires_explicit_tag_and_admin_role() {
    let (pool, community) = pg_pool().await;
    let state = app_state(&pool).await;
    let tenant = tenant_for(community);

    let author = Keys::generate();
    let admin = Keys::generate();
    seed_member(&pool, community, &author, "member").await;
    seed_member(&pool, community, &admin, "admin").await;
    let author_hex = author.public_key().to_hex();

    let seed = |slug: &'static str, content: &'static str| {
        wiki_revision(&author, slug, content, None)
    };

    // (1) author + no purge = restorable tombstone, content intact.
    ingest(&state, &tenant, seed("keep-me", "leaked secret one"))
        .await
        .expect("seed keep-me page");
    let del = deletion(&author, &format!("44001:{author_hex}:keep-me"));
    handle_a_tag_deletion(&tenant, &del, &state)
        .await
        .expect("author delete");
    let kept: (String,) = sqlx::query_as(
        "SELECT content FROM events WHERE community_id = $1 AND kind = $2 AND d_tag = $3",
    )
    .bind(community)
    .bind(KIND_WIKI_PAGE as i32)
    .bind("keep-me")
    .fetch_one(&pool)
    .await
    .expect("read kept content");
    assert_eq!(kept.0, "leaked secret one", "author delete must not strip");

    // (2) admin + no purge = STILL a restorable tombstone, content intact.
    ingest(&state, &tenant, seed("tombstone-me", "leaked secret two"))
        .await
        .expect("seed tombstone-me page");
    let del = deletion(&admin, &format!("44001:{author_hex}:tombstone-me"));
    validate_standard_deletion_event(&tenant, &del, &state)
        .await
        .expect("an admin may delete any page");
    handle_a_tag_deletion(&tenant, &del, &state)
        .await
        .expect("admin delete without purge tag");
    let kept: (String,) = sqlx::query_as(
        "SELECT content FROM events WHERE community_id = $1 AND kind = $2 AND d_tag = $3",
    )
    .bind(community)
    .bind(KIND_WIKI_PAGE as i32)
    .bind("tombstone-me")
    .fetch_one(&pool)
    .await
    .expect("read admin tombstone");
    assert_eq!(
        kept.0, "leaked secret two",
        "an admin delete WITHOUT the purge tag must keep content"
    );

    // (3) admin + ["purge","1"] = permanent content-strip purge (+ FTS gone).
    ingest(&state, &tenant, seed("purge-me", "leaked secret three"))
        .await
        .expect("seed purge-me page");
    let del = deletion_with_purge(&admin, &format!("44001:{author_hex}:purge-me"));
    validate_standard_deletion_event(&tenant, &del, &state)
        .await
        .expect("an admin may purge any page");
    handle_a_tag_deletion(&tenant, &del, &state)
        .await
        .expect("admin purge");
    let (stripped, fts_hits): (i64, i64) = sqlx::query_as(
        "SELECT count(*) FILTER (WHERE content = ''), \
                count(*) FILTER (WHERE search_tsv @@ plainto_tsquery('english', 'secret three')) \
         FROM events WHERE community_id = $1 AND kind = $2 AND d_tag = $3",
    )
    .bind(community)
    .bind(KIND_WIKI_PAGE as i32)
    .bind("purge-me")
    .fetch_one(&pool)
    .await
    .expect("read purged page");
    assert_eq!(stripped, 1, "an explicit purge must strip content");
    assert_eq!(fts_hits, 0, "an explicit purge must purge full-text search");

    // (4) author + ["purge","1"] = rejected: authors can never purge.
    ingest(&state, &tenant, seed("nope", "leaked secret four"))
        .await
        .expect("seed nope page");
    let del = deletion_with_purge(&author, &format!("44001:{author_hex}:nope"));
    let err = validate_standard_deletion_event(&tenant, &del, &state)
        .await
        .expect_err("an author's purge marker must be rejected");
    assert!(
        err.to_string()
            .contains("only a community admin/owner may purge"),
        "unexpected error: {err}"
    );

    pg_cleanup(&pool, community).await;
}

// ---- item 3(c): corrections are per-author --------------------------------

/// Mutation oracle: widen the correction arm to the slug (like the 44001
/// page-wide rule) and bob's correction dies with alice's.
#[tokio::test]
#[ignore = "requires migrated Postgres + Redis"]
async fn correction_deletion_touches_only_the_signers_own_coordinate() {
    let (pool, community) = pg_pool().await;
    let state = app_state(&pool).await;
    let tenant = tenant_for(community);

    let alice = Keys::generate();
    let bob = Keys::generate();
    seed_member(&pool, community, &alice, "member").await;
    seed_member(&pool, community, &bob, "member").await;
    let alice_hex = alice.public_key().to_hex();
    let bob_hex = bob.public_key().to_hex();

    ingest(
        &state,
        &tenant,
        correction(&alice, "governance", "alice correction"),
    )
    .await
    .expect("alice publishes a correction");
    ingest(
        &state,
        &tenant,
        correction(&bob, "governance", "bob correction"),
    )
    .await
    .expect("bob publishes a correction");

    // Alice may not delete bob's correction coordinate.
    let forged = deletion(
        &alice,
        &format!("44003:{bob_hex}:correction-for-governance"),
    );
    let err = validate_standard_deletion_event(&tenant, &forged, &state)
        .await
        .expect_err("deleting someone else's correction must fail");
    assert!(
        err.to_string().contains("must be event author"),
        "unexpected error: {err}"
    );

    // Alice deletes her own coordinate: only her rows tombstone.
    let own = deletion(
        &alice,
        &format!("44003:{alice_hex}:correction-for-governance"),
    );
    validate_standard_deletion_event(&tenant, &own, &state)
        .await
        .expect("a member may delete their own correction");
    handle_a_tag_deletion(&tenant, &own, &state)
        .await
        .expect("delete own correction");

    let (alice_live, bob_live): (i64, i64) = sqlx::query_as(
        "SELECT count(*) FILTER (WHERE pubkey = $2 AND deleted_at IS NULL), \
                count(*) FILTER (WHERE pubkey = $3 AND deleted_at IS NULL) \
         FROM events WHERE community_id = $1 AND kind = $4 AND d_tag = $5",
    )
    .bind(community)
    .bind(hex::decode(&alice_hex).expect("alice hex"))
    .bind(hex::decode(&bob_hex).expect("bob hex"))
    .bind(KIND_WIKI_CORRECTION as i32)
    .bind("correction-for-governance")
    .fetch_one(&pool)
    .await
    .expect("read corrections");
    assert_eq!(alice_live, 0, "alice's correction must be tombstoned");
    assert_eq!(bob_live, 1, "bob's correction must be untouched");

    pg_cleanup(&pool, community).await;
}

// ---- item 4: canonical-node seat routing ----------------------------------

/// Mutation oracle: answer `is_seated_agent`/`holds_node_seat` from "any
/// surviving node row" again and the stale copy below re-grants the seat.
/// Only the CANONICAL node version's seats count.
#[tokio::test]
#[ignore = "requires migrated Postgres + Redis"]
async fn stale_node_copy_grants_no_seats_but_canonical_version_does() {
    let (pool, community) = pg_pool().await;
    let state = app_state(&pool).await;
    let tenant = tenant_for(community);

    let admin = Keys::generate();
    let holder = Keys::generate();
    let stale_agent = Keys::generate();
    let seated_agent = Keys::generate();
    let member = Keys::generate();
    seed_member(&pool, community, &admin, "admin").await;
    seed_member(&pool, community, &holder, "member").await;
    seed_member(&pool, community, &member, "member").await;
    let admin_hex = admin.public_key().to_hex();
    let holder_hex = holder.public_key().to_hex();
    let stale_hex = stale_agent.public_key().to_hex();
    let seated_hex = seated_agent.public_key().to_hex();

    let now = chrono::Utc::now().timestamp();
    // Root (admin-authored) holds `holder`; both `eng` versions below are
    // therefore ANCHORED — the stale copy is a real competitor, excluded
    // only by the canonical (admin-first) rule.
    seed_node_version(&pool, community, "root", &admin_hex, &[], &[&holder_hex], None, now).await;
    // Canonical `eng` (admin-authored): seats `seated_agent`.
    seed_node_version(
        &pool, community, "eng", &admin_hex, &[&seated_hex], &[], None, now,
    )
    .await;
    // Stale holder-authored copy (anchored through `root`) still lists
    // `stale_agent` — it must grant NOTHING.
    seed_node_version(
        &pool,
        community,
        "eng",
        &holder_hex,
        &[&stale_hex],
        &[],
        Some("root"),
        now - 100,
    )
    .await;

    let page = |keys: &Keys, slug: &str| {
        signed(
            KIND_AGENT_WIKI_PAGE,
            keys,
            "# Standup",
            vec![t("d", slug), t("model", "test-model")],
        )
    };

    let rejected = ingest(&state, &tenant, page(&stale_agent, "default/stale")).await;
    expect_rejection(
        rejected,
        "agent wiki pages require a seated agent signer",
        "agent named only by a stale node copy",
    );

    ingest(&state, &tenant, page(&seated_agent, "default/canonical"))
        .await
        .expect("the canonical version's seat grants");

    pg_cleanup(&pool, community).await;
}

/// Mutation oracle: pick the stale/newest-any version as canonical and the
/// second ingest below is accepted. The emergency stop — the operator
/// republishing their OWN node without the seat — must unseat the agent even
/// though the seat-listing row survives.
#[tokio::test]
#[ignore = "requires migrated Postgres + Redis"]
async fn emergency_stop_republish_unseats_agents() {
    let (pool, community) = pg_pool().await;
    let state = app_state(&pool).await;
    let tenant = tenant_for(community);

    let admin = Keys::generate();
    let agent = Keys::generate();
    seed_member(&pool, community, &admin, "admin").await;
    let admin_hex = admin.public_key().to_hex();
    let agent_hex = agent.public_key().to_hex();

    let now = chrono::Utc::now().timestamp();
    // Operator's original node seats the agent...
    seed_node_version(
        &pool,
        community,
        "eng",
        &admin_hex,
        &[&agent_hex],
        &[],
        None,
        now - 200,
    )
    .await;

    let page = |keys: &Keys, slug: &str| {
        signed(
            KIND_AGENT_WIKI_PAGE,
            keys,
            "# Standup",
            vec![t("d", slug), t("model", "test-model")],
        )
    };
    ingest(&state, &tenant, page(&agent, "default/before"))
        .await
        .expect("a seated agent publishes");

    // ...then republishes their own node without the seat (emergency stop).
    // The old row survives but is stale: access must be gone.
    seed_node_version(&pool, community, "eng", &admin_hex, &[], &[], None, now).await;

    let rejected = ingest(&state, &tenant, page(&agent, "default/after")).await;
    expect_rejection(
        rejected,
        "agent wiki pages require a seated agent signer",
        "agent unseated by the operator's republish",
    );

    pg_cleanup(&pool, community).await;
}

// ---- item 5: admin re-scope / unscope / conflict settlement ----------------

/// Mutation oracle: keep the sticky rule unconditional (reject admin
/// re-scope) and the re-scope/unscope steps below fail.
#[tokio::test]
#[ignore = "requires migrated Postgres + Redis"]
async fn admin_may_rescope_and_unscope_team_pages() {
    let (pool, community) = pg_pool().await;
    let state = app_state(&pool).await;
    let tenant = tenant_for(community);

    let admin = Keys::generate();
    let member = Keys::generate();
    let eng_seat = Keys::generate();
    let sales_seat = Keys::generate();
    seed_member(&pool, community, &admin, "admin").await;
    seed_member(&pool, community, &member, "member").await;
    seed_member(&pool, community, &eng_seat, "member").await;
    seed_member(&pool, community, &sales_seat, "member").await;
    let eng_hex = eng_seat.public_key().to_hex();
    let sales_hex = sales_seat.public_key().to_hex();
    seed_team_node(&pool, community, "eng", &[&eng_hex], &[]).await;
    seed_team_node(&pool, community, "sales", &[&sales_hex], &[]).await;

    let d = "handbook";
    ingest(&state, &tenant, wiki_revision(&admin, d, "v1", Some("eng")))
        .await
        .expect("admin scopes the page");

    let rejected = ingest(&state, &tenant, wiki_revision(&member, d, "v2", Some("eng"))).await;
    expect_rejection(
        rejected,
        "requires a seat in team eng or community admin/owner",
        "member without a seat on a team page",
    );

    // Admin RE-SCOPES eng -> sales, overriding stickiness.
    ingest(&state, &tenant, wiki_revision(&admin, d, "v2", Some("sales")))
        .await
        .expect("admin re-scopes the page");

    let rejected = ingest(&state, &tenant, wiki_revision(&eng_seat, d, "v3", Some("sales"))).await;
    expect_rejection(
        rejected,
        "requires a seat in team sales or community admin/owner",
        "old team's seat after a re-scope",
    );
    ingest(&state, &tenant, wiki_revision(&sales_seat, d, "v3", Some("sales")))
        .await
        .expect("the new team's seat edits");

    // Admin UNSCOPES the page (drops the tag); it becomes open again.
    ingest(&state, &tenant, wiki_revision(&admin, d, "v4", None))
        .await
        .expect("admin unscopes the page");
    ingest(&state, &tenant, wiki_revision(&member, d, "v5", None))
        .await
        .expect("any member edits an unscoped page");

    pg_cleanup(&pool, community).await;
}

/// Mutation oracle: freeze conflicting pages for admins too (or let
/// non-admins through) and this fails. Non-admins stay rejected while the
/// history disagrees; an admin revision SETTLES it — its tag becomes the
/// page scope and normal rules resume.
#[tokio::test]
#[ignore = "requires migrated Postgres + Redis"]
async fn conflicting_scope_history_settles_with_admin_revision() {
    let (pool, community) = pg_pool().await;
    let state = app_state(&pool).await;
    let tenant = tenant_for(community);

    let admin = Keys::generate();
    let eng_seat = Keys::generate();
    let sales_seat = Keys::generate();
    let plain = Keys::generate();
    seed_member(&pool, community, &admin, "admin").await;
    seed_member(&pool, community, &eng_seat, "member").await;
    seed_member(&pool, community, &sales_seat, "member").await;
    seed_member(&pool, community, &plain, "member").await;
    let eng_hex = eng_seat.public_key().to_hex();
    let sales_hex = sales_seat.public_key().to_hex();
    seed_team_node(&pool, community, "eng", &[&eng_hex], &[]).await;
    seed_team_node(&pool, community, "sales", &[&sales_hex], &[]).await;

    // Imported/conflicting history the ingest rules would never allow.
    let now = chrono::Utc::now().timestamp();
    let d = "frozen";
    seed_wiki_revision_row(&pool, community, d, &eng_hex, Some("eng"), now - 200).await;
    seed_wiki_revision_row(&pool, community, d, &sales_hex, Some("sales"), now - 100).await;

    let rejected = ingest(&state, &tenant, wiki_revision(&plain, d, "v", Some("eng"))).await;
    expect_rejection(
        rejected,
        "conflicting `t: team:` scopes",
        "non-admin on a conflicting page",
    );

    // The admin settles the conflict on `sales`.
    ingest(&state, &tenant, wiki_revision(&admin, d, "settled", Some("sales")))
        .await
        .expect("admin settles the scope");
    ingest(&state, &tenant, wiki_revision(&sales_seat, d, "v2", Some("sales")))
        .await
        .expect("the settled team's seat edits");
    let rejected = ingest(&state, &tenant, wiki_revision(&eng_seat, d, "v3", Some("eng"))).await;
    expect_rejection(
        rejected,
        "may not change its `t: team:<node-id>` team",
        "other team after settlement",
    );
    let rejected = ingest(&state, &tenant, wiki_revision(&plain, d, "v4", None)).await;
    expect_rejection(
        rejected,
        "may not drop its `t: team:<node-id>` tag",
        "tag drop after settlement",
    );

    pg_cleanup(&pool, community).await;
}

/// Mutation oracle: keep rejecting edits when the team node does not resolve
/// (the dead button) and the middle ingests below fail. The CONTRACT: a page
/// with NO resolvable team in history counts as unscoped — any member edits.
#[tokio::test]
#[ignore = "requires migrated Postgres + Redis"]
async fn unresolvable_team_page_falls_back_to_open_editing() {
    let (pool, community) = pg_pool().await;
    let state = app_state(&pool).await;
    let tenant = tenant_for(community);

    let admin = Keys::generate();
    let member = Keys::generate();
    let eng_seat = Keys::generate();
    seed_member(&pool, community, &admin, "admin").await;
    seed_member(&pool, community, &member, "member").await;
    seed_member(&pool, community, &eng_seat, "member").await;
    let eng_hex = eng_seat.public_key().to_hex();
    seed_team_node(&pool, community, "eng", &[&eng_hex], &[]).await;

    let d = "ghosted";
    ingest(&state, &tenant, wiki_revision(&admin, d, "v1", Some("ghost")))
        .await
        .expect("admin scopes to a team node");
    ingest(&state, &tenant, wiki_revision(&member, d, "v2", Some("ghost")))
        .await
        .expect("no resolvable team: any member edits (stale tag kept)");
    ingest(&state, &tenant, wiki_revision(&member, d, "v3", None))
        .await
        .expect("no resolvable team: any member edits (tag dropped)");

    // Naming a DIFFERENT team is still a governance act for that team.
    let rejected = ingest(&state, &tenant, wiki_revision(&member, d, "v4", Some("eng"))).await;
    expect_rejection(
        rejected,
        "requires a seat in team eng or community admin/owner",
        "re-scoping a ghost page to a real team without a seat",
    );

    pg_cleanup(&pool, community).await;
}

// ---- item 5(b): scope-gated delete ----------------------------------------

/// Mutation oracle: fall back to the author rule on scoped pages and the
/// first delete below is accepted. On a scoped page only that team's
/// canonical seats/admins may delete — authors of pre-scope revisions lose
/// the right.
#[tokio::test]
#[ignore = "requires migrated Postgres + Redis"]
async fn team_scoped_page_delete_requires_team_seat() {
    let (pool, community) = pg_pool().await;
    let state = app_state(&pool).await;
    let tenant = tenant_for(community);

    let admin = Keys::generate();
    let author = Keys::generate();
    let seated = Keys::generate();
    seed_member(&pool, community, &admin, "admin").await;
    seed_member(&pool, community, &author, "member").await;
    seed_member(&pool, community, &seated, "member").await;
    let author_hex = author.public_key().to_hex();
    let seated_hex = seated.public_key().to_hex();
    seed_team_node(&pool, community, "eng", &[&seated_hex], &[]).await;

    let d = "handbook";
    // The page starts unscoped (author writes it), then gets scoped to eng.
    ingest(&state, &tenant, wiki_revision(&author, d, "v1", None))
        .await
        .expect("any member writes an unscoped page");
    ingest(&state, &tenant, wiki_revision(&admin, d, "v2", Some("eng")))
        .await
        .expect("admin scopes the page");

    // The pre-scope author loses the delete right.
    let del = deletion(&author, &format!("44001:{author_hex}:{d}"));
    let err = validate_standard_deletion_event(&tenant, &del, &state)
        .await
        .expect_err("a pre-scope author may not delete a team page");
    assert!(
        err.to_string()
            .contains("requires a seat in team eng or community admin/owner"),
        "unexpected error: {err}"
    );

    // The team's seat may delete.
    let del = deletion(&seated, &format!("44001:{author_hex}:{d}"));
    validate_standard_deletion_event(&tenant, &del, &state)
        .await
        .expect("a team seat may delete the scoped page");
    handle_a_tag_deletion(&tenant, &del, &state)
        .await
        .expect("seat delete");

    pg_cleanup(&pool, community).await;
}

// ---- item 5(c): include_deleted listing ------------------------------------

/// Mutation oracle: leave the `deleted_at` predicate unconditional (or drop
/// the kind fence) and the assertions below fail. `include_deleted: true` on
/// a wiki-page query lists tombstoned rows with their preserved content.
#[tokio::test]
#[ignore = "requires migrated Postgres + Redis"]
async fn include_deleted_query_lists_tombstoned_wiki_rows() {
    let (pool, community) = pg_pool().await;
    let state = app_state(&pool).await;
    let tenant = tenant_for(community);

    let author = Keys::generate();
    seed_member(&pool, community, &author, "member").await;
    let author_hex = author.public_key().to_hex();

    ingest(
        &state,
        &tenant,
        wiki_revision(&author, "recently", "gone but remembered", None),
    )
    .await
    .expect("seed page");
    let del = deletion(&author, &format!("44001:{author_hex}:recently"));
    validate_standard_deletion_event(&tenant, &del, &state)
        .await
        .expect("author may delete their page");
    handle_a_tag_deletion(&tenant, &del, &state)
        .await
        .expect("tombstone");

    let db = buzz_db::Db::from_pool(pool.clone());
    let mut query = buzz_db::EventQuery::for_community(buzz_core::CommunityId::from_uuid(
        community,
    ));
    query.kinds = Some(vec![KIND_WIKI_PAGE as i32]);
    query.d_tag = Some("recently".to_string());

    let live = db.query_events(&query).await.expect("plain query");
    assert!(
        live.is_empty(),
        "tombstoned rows are hidden from ordinary queries"
    );

    query.include_deleted_wiki = true;
    let deleted = db
        .query_events(&query)
        .await
        .expect("include_deleted query");
    assert_eq!(deleted.len(), 1, "include_deleted lists the tombstone");
    assert_eq!(
        deleted[0].event.content, "gone but remembered",
        "tombstones preserve content so a republished revision restores the page"
    );

    pg_cleanup(&pool, community).await;
}

// ---- pure scope state machine (no infrastructure) --------------------------

/// Mutation oracle for the settlement machine: untagged non-admin revisions
/// must not unset a scope, admin revisions always express the page scope,
/// and a non-admin disagreement freezes until an admin settles it.
#[test]
fn page_scope_state_machine_settles_and_freezes() {
    use crate::handlers::ingest::effective_page_scope;
    use buzz_db::event::WikiScopeRevision;

    fn rev(scope: Option<&str>, admin: bool) -> WikiScopeRevision {
        WikiScopeRevision {
            created_at: 0,
            author_is_admin: admin,
            scope: scope.map(|node| format!("team:{node}")),
        }
    }
    let s = |node: &str| Some(node.to_string());

    assert_eq!(effective_page_scope(&[]), (None, false));
    // The first scope tag establishes the scope (the scoping act).
    assert_eq!(
        effective_page_scope(&[rev(None, false), rev(Some("eng"), false)]),
        (s("eng"), false)
    );
    // An untagged non-admin revision never unsets a scope (sticky).
    assert_eq!(
        effective_page_scope(&[rev(Some("eng"), false), rev(None, false)]),
        (s("eng"), false)
    );
    // Admin/owner revisions express the page scope: re-scope and unscope.
    assert_eq!(
        effective_page_scope(&[rev(Some("eng"), false), rev(Some("sales"), true)]),
        (s("sales"), false)
    );
    assert_eq!(
        effective_page_scope(&[rev(Some("eng"), true), rev(None, true)]),
        (None, false)
    );
    // A non-admin scope disagreement freezes the page...
    assert_eq!(
        effective_page_scope(&[rev(Some("eng"), false), rev(Some("sales"), false)]),
        (s("eng"), true)
    );
    // ...until an admin revision settles it: its tag becomes the scope...
    assert_eq!(
        effective_page_scope(&[
            rev(Some("eng"), false),
            rev(Some("sales"), false),
            rev(Some("sales"), true)
        ]),
        (s("sales"), false)
    );
    // ...and an admin settling WITHOUT a tag unscopes the page entirely.
    assert_eq!(
        effective_page_scope(&[
            rev(Some("eng"), false),
            rev(Some("sales"), false),
            rev(None, true)
        ]),
        (None, false)
    );
}
