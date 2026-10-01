//! Postgres adapter for the NIP-ORG authority resolver.
//!
//! [`buzz_core::org_grant`] holds the pure R1 authority rules (anchoring,
//! candidate selection, grant-chain verification, budget/review authority)
//! behind the [`OrgGraphSource`] trait. This module is the thin async glue:
//! it answers the resolver's questions from the `events` and `relay_members`
//! tables, always scoped to one community, and never picks "the newest row"
//! itself — it returns every candidate for a coordinate (bounded) and lets the
//! resolver choose the one that satisfies the authority rule.
//!
//! All reads run on the writer (`Authorization` operation): an authority
//! decision must not be made from a lagging replica.

use buzz_core::org_grant::{
    canonical_node_is_resolvable, holds_canonical_seat, holds_canonical_seat_in_any,
    parse_stored_grant, parse_stored_node, OrgAuthorityError, OrgGraphSource, SeatKind,
    StoredOrgGrant, StoredOrgNode, MAX_ORG_CANDIDATES,
};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::error::{DbError, Result};
use crate::observability;
use crate::Db;
use buzz_core::CommunityId;

const KIND_ORG_NODE: i32 = buzz_core::kind::KIND_ORG_NODE as i32;
const KIND_ORG_GRANT: i32 = buzz_core::kind::KIND_ORG_GRANT as i32;

/// Candidate rows fetched per coordinate. Equal to the resolver's own cap so
/// the SQL `LIMIT` and the in-memory truncation agree.
const CANDIDATE_LIMIT: i64 = MAX_ORG_CANDIDATES as i64;

/// The org graph of one community, read from Postgres.
///
/// Cheap to construct (borrows the pool); build one per authority decision.
#[derive(Debug, Clone, Copy)]
pub struct PgOrgGraph<'a> {
    pool: &'a PgPool,
    community_id: Uuid,
}

impl<'a> PgOrgGraph<'a> {
    /// Graph reader for `community_id` over `pool`.
    pub fn new(pool: &'a PgPool, community_id: Uuid) -> Self {
        Self { pool, community_id }
    }

    /// Distinct node ids (`d` tags) whose org-node record set has SOME
    /// surviving version listing `pubkey` in the JSON array `field`
    /// (`"agentSeats"` or `"holders"`). This is only a bounded candidate
    /// enumeration: whether the seat COUNTS is decided by the canonical
    /// node's content (see [`holds_canonical_seat_in_any`]). The membership
    /// test runs inside nested `CASE`s so the JSON cast and array expansion
    /// only ever run on JSON-object node rows (SQL does not promise `AND`
    /// short-circuiting). Bounded to 32 node ids — one seat question never
    /// scans the whole org chart.
    async fn node_ids_mentioning(&self, pubkey: &str, field: &'static str) -> Result<Vec<String>> {
        let mut conn =
            observability::acquire_writer(self.pool, observability::WriterOperation::Authorization)
                .await?;
        let rows: Vec<(String,)> = sqlx::query_as(
            r#"
            SELECT DISTINCT d_tag
            FROM events
            WHERE community_id = $1
              AND kind = $2
              AND deleted_at IS NULL
              AND channel_id IS NULL
              AND d_tag IS NOT NULL
              AND CASE
                    WHEN kind = $2 AND content IS JSON OBJECT THEN
                      CASE
                        WHEN jsonb_typeof(content::jsonb -> $3) = 'array' THEN
                          EXISTS (
                            SELECT 1
                            FROM jsonb_array_elements_text(content::jsonb -> $3) AS s(v)
                            WHERE lower(s.v) = $4
                          )
                        ELSE false
                      END
                    ELSE false
                  END
            LIMIT 32
            "#,
        )
        .bind(self.community_id)
        .bind(KIND_ORG_NODE)
        .bind(field)
        .bind(pubkey.to_ascii_lowercase())
        .fetch_all(&mut *conn)
        .await?;
        Ok(rows.into_iter().map(|(d,)| d).collect())
    }

    /// Whether `pubkey` occupies an `agentSeats` slot in the CANONICAL org
    /// node of any node id whose record set ever listed them — i.e. is seated
    /// as an AGENT, not a human.
    ///
    /// Seated agents are excluded from human-only authority such as signing
    /// counted reviews (NIP-ORG reviewer rule). The seat must be in the
    /// anchored, admin-first canonical version of the node
    /// (`buzz_core::org_grant::canonical_node`): a stale holder-authored copy
    /// that still lists the agent must not keep them privileged after an
    /// admin (or an emergency-stop republish) unseated them canonically.
    pub async fn is_seated_agent(&self, pubkey: &str) -> Result<bool> {
        let ds = self.node_ids_mentioning(pubkey, "agentSeats").await?;
        holds_canonical_seat_in_any(self, &ds, pubkey, SeatKind::Agent)
            .await
            .map_err(map_org_err)
    }

    /// Whether `pubkey` occupies an `agentSeats` or `holders` slot of the
    /// CANONICAL org node whose `d` tag is `node_id` — i.e. holds a seat in
    /// that specific team node (the wiki team-scope anchor, `t: team:<node>`).
    ///
    /// Same trust rule as [`is_seated_agent`]: only the canonical version's
    /// content counts; stale copies grant nothing.
    pub async fn holds_node_seat(&self, node_id: &str, pubkey: &str) -> Result<bool> {
        holds_canonical_seat(self, node_id, pubkey, SeatKind::Any)
            .await
            .map_err(map_org_err)
    }

    /// Whether `pubkey` is listed in the `holders` array of the CANONICAL
    /// version of any org node of this community — i.e. is a human seat
    /// holder anywhere in the org chart. Used to admit authority holders
    /// publishing on an agent's behalf (the distillation loop runs under the
    /// human runner's key). Stale copies' `holders` lists do not count.
    pub async fn holds_any_seat(&self, pubkey: &str) -> Result<bool> {
        let ds = self.node_ids_mentioning(pubkey, "holders").await?;
        holds_canonical_seat_in_any(self, &ds, pubkey, SeatKind::Holder)
            .await
            .map_err(map_org_err)
    }

    /// Whether the org node `node_id` resolves to a canonical anchored
    /// record — the "team node exists" question behind wiki team scoping.
    /// A page scoped to a node that does not resolve has no resolvable team
    /// and falls back to open editing (any member may edit).
    pub async fn node_is_resolvable(&self, node_id: &str) -> Result<bool> {
        canonical_node_is_resolvable(self, node_id)
            .await
            .map_err(map_org_err)
    }
}

/// Seat questions return plain [`DbError`]s so existing call sites keep
/// their error shape: a store failure propagates as-is, and a walk that
/// exceeded the lookup budget propagates as an access error — never as an
/// implicit "no seat".
fn map_org_err(e: OrgAuthorityError<DbError>) -> DbError {
    match e {
        OrgAuthorityError::Source(db) => db,
        OrgAuthorityError::Denied(d) => DbError::AccessDenied(d.to_string()),
    }
}

/// One raw candidate row: `(event id hex, author hex, created_at secs, content)`.
struct RawRow {
    event_id: String,
    author: String,
    created_at: u64,
    content: String,
}

fn raw_rows(rows: Vec<sqlx::postgres::PgRow>) -> Result<Vec<RawRow>> {
    rows.into_iter()
        .map(|row| {
            let created_at: i64 = row.try_get("created_at")?;
            Ok(RawRow {
                event_id: row.try_get("event_id")?,
                author: row.try_get("author")?,
                created_at: created_at.max(0) as u64,
                content: row.try_get("content")?,
            })
        })
        .collect::<std::result::Result<Vec<_>, sqlx::Error>>()
        .map_err(DbError::from)
}

impl OrgGraphSource for PgOrgGraph<'_> {
    type Error = DbError;

    async fn is_community_admin(&self, pubkey: &str) -> Result<bool> {
        let mut conn =
            observability::acquire_writer(self.pool, observability::WriterOperation::Authorization)
                .await?;
        let row = sqlx::query(
            "SELECT 1 FROM relay_members \
             WHERE community_id = $1 AND pubkey = $2 AND role IN ('owner', 'admin')",
        )
        .bind(self.community_id)
        .bind(pubkey)
        .fetch_optional(&mut *conn)
        .await?;
        Ok(row.is_some())
    }

    async fn node_candidates(&self, d: &str) -> Result<Vec<StoredOrgNode>> {
        let mut conn =
            observability::acquire_writer(self.pool, observability::WriterOperation::Authorization)
                .await?;
        let rows = sqlx::query(
            r#"
            SELECT encode(id, 'hex') AS event_id,
                   encode(pubkey, 'hex') AS author,
                   EXTRACT(EPOCH FROM created_at)::bigint AS created_at,
                   content
            FROM events
            WHERE community_id = $1
              AND kind = $2
              AND d_tag = $3
              AND deleted_at IS NULL
              AND channel_id IS NULL
            ORDER BY created_at DESC, id ASC
            LIMIT $4
            "#,
        )
        .bind(self.community_id)
        .bind(KIND_ORG_NODE)
        .bind(d)
        .bind(CANDIDATE_LIMIT)
        .fetch_all(&mut *conn)
        .await?;
        Ok(raw_rows(rows)?
            .into_iter()
            .filter_map(|r| parse_stored_node(&r.author, r.created_at, &r.event_id, d, &r.content))
            .collect())
    }

    async fn nodes_held_by(&self, pubkey: &str) -> Result<Vec<StoredOrgNode>> {
        let mut conn =
            observability::acquire_writer(self.pool, observability::WriterOperation::Authorization)
                .await?;
        // `holders` membership is tested inside nested CASEs so the JSON
        // cast and array expansion only ever run on JSON-object node rows
        // (SQL does not promise AND short-circuiting).
        let rows = sqlx::query(
            r#"
            SELECT encode(id, 'hex') AS event_id,
                   encode(pubkey, 'hex') AS author,
                   EXTRACT(EPOCH FROM created_at)::bigint AS created_at,
                   d_tag,
                   content
            FROM events
            WHERE community_id = $1
              AND kind = $2
              AND d_tag IS NOT NULL
              AND deleted_at IS NULL
              AND channel_id IS NULL
              AND CASE
                    WHEN kind = $2 AND content IS JSON OBJECT THEN
                      CASE
                        WHEN jsonb_typeof(content::jsonb -> 'holders') = 'array' THEN
                          EXISTS (
                            SELECT 1
                            FROM jsonb_array_elements_text(content::jsonb -> 'holders') AS h(v)
                            WHERE lower(h.v) = $3
                          )
                        ELSE false
                      END
                    ELSE false
                  END
            ORDER BY created_at DESC, id ASC
            LIMIT $4
            "#,
        )
        .bind(self.community_id)
        .bind(KIND_ORG_NODE)
        .bind(pubkey)
        .bind(CANDIDATE_LIMIT)
        .fetch_all(&mut *conn)
        .await?;
        let mut out = Vec::new();
        for row in rows {
            let created_at: i64 = row.try_get("created_at")?;
            let d: String = row.try_get("d_tag")?;
            let event_id: String = row.try_get("event_id")?;
            let author: String = row.try_get("author")?;
            let content: String = row.try_get("content")?;
            if let Some(node) =
                parse_stored_node(&author, created_at.max(0) as u64, &event_id, &d, &content)
            {
                out.push(node);
            }
        }
        Ok(out)
    }

    async fn grant_candidates(&self, d: &str) -> Result<Vec<StoredOrgGrant>> {
        let mut conn =
            observability::acquire_writer(self.pool, observability::WriterOperation::Authorization)
                .await?;
        let rows = sqlx::query(
            r#"
            SELECT encode(id, 'hex') AS event_id,
                   encode(pubkey, 'hex') AS author,
                   EXTRACT(EPOCH FROM created_at)::bigint AS created_at,
                   content
            FROM events
            WHERE community_id = $1
              AND kind = $2
              AND d_tag = $3
              AND deleted_at IS NULL
              AND channel_id IS NULL
            ORDER BY created_at DESC, id ASC
            LIMIT $4
            "#,
        )
        .bind(self.community_id)
        .bind(KIND_ORG_GRANT)
        .bind(d)
        .bind(CANDIDATE_LIMIT)
        .fetch_all(&mut *conn)
        .await?;
        Ok(raw_rows(rows)?
            .into_iter()
            .filter_map(|r| parse_stored_grant(&r.author, r.created_at, &r.event_id, d, &r.content))
            .collect())
    }
}

impl Db {
    /// The org graph of `community` for R1 authority decisions
    /// (anchoring, grant chains, budget and review authority).
    pub fn org_graph(&self, community: CommunityId) -> PgOrgGraph<'_> {
        PgOrgGraph::new(&self.pool, *community.as_uuid())
    }
}
