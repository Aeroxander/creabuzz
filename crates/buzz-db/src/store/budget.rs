//! NIP-ORG budget enforcement — windowed consumption counters.
//!
//! The relay enforces budgets it can observe (event-kind ceilings, run
//! counts). Spend ceilings are enforced at the value layer (ACP harness
//! signing path, or onchain for DAO-bound budgets).
//!
//! Budget events are kind:37012 parameterized-replaceable records whose JSON
//! content keys are camelCase per `docs/nips/NIP-ORG.md`:
//! `{ subject, window, limits: { spend, runs, tasks: { create, approve } }, onExceed }`.
//! A budget applies to an agent when `content.subject` equals the agent's
//! 64-hex pubkey (case-insensitive).

use buzz_datastore_tracing::datastore_span;
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::error::{DbError, Result};
use crate::Db;
use buzz_core::CommunityId;

/// Upper bound on budget events examined per lookup.
///
/// Budgets are small, community-level records; 100 far exceeds any realistic
/// org's distinct budget count. The bound is deliberate, not silent: a
/// community exceeding it must consolidate (budgets are NIP-33 replaceable,
/// so superseded ones stop accumulating only per (pubkey, d) coordinate) —
/// see the enforcement-side doc comment on the same constant.
pub const BUDGET_LOOKUP_CAP: i64 = 100;

/// One applicable budget event returned by [`budget_enforcement_lookup`].
#[derive(Debug, Clone)]
pub struct BudgetEvent {
    /// Raw JSON content of the kind:37012 event.
    pub content: String,
    /// `onExceed` policy, defaulting to `"require-approval"`.
    pub on_exceed: String,
    /// Event id (hex) of the kind:37012 record, for audit references.
    pub event_id_hex: String,
}

/// Look up budget events for a given agent pubkey.
///
/// Returns each budget whose `content.subject` equals the agent's hex
/// pubkey (case-insensitive). The caller parses `content` to extract
/// limits and window type.
///
/// The query intentionally cannot mis-bind parameters: it selects the
/// community's kind:37012 rows by plain equality and matches `subject` in
/// Rust by JSON field, never through array containment against JSONB.
pub async fn budget_enforcement_lookup(
    pool: &PgPool,
    community_id: Uuid,
    agent_pubkey_hex: &str,
) -> Result<Vec<BudgetEvent>> {
    let rows = sqlx::query(
        r#"
        SELECT encode(id, 'hex') AS event_id, content
        FROM events
        WHERE community_id = $1
          AND kind = 37012
          AND deleted_at IS NULL
        ORDER BY created_at DESC
        LIMIT $2
        "#,
    )
    .bind(community_id)
    .bind(BUDGET_LOOKUP_CAP)
    .fetch_all(pool)
    .await?;

    let agent = agent_pubkey_hex.to_ascii_lowercase();
    let mut results = Vec::new();
    for row in rows {
        let content: String = row.get("content");
        let parsed: serde_json::Value = match serde_json::from_str(&content) {
            Ok(v) => v,
            // A malformed budget must not crash the lookup; enforcement
            // simply cannot see it. Ingest validation rejects malformed
            // budget content before it is stored.
            Err(_) => continue,
        };
        let subject_matches = parsed
            .get("subject")
            .and_then(|s| s.as_str())
            .is_some_and(|s| s.eq_ignore_ascii_case(&agent));
        if !subject_matches {
            continue;
        }
        let on_exceed: String = parsed
            .get("onExceed")
            .and_then(|o| o.as_str())
            .map(String::from)
            .unwrap_or_else(|| "require-approval".into());
        results.push(BudgetEvent {
            content,
            on_exceed,
            event_id_hex: row.get("event_id"),
        });
    }
    Ok(results)
}

/// Deterministic per-window contribution outcome counts for one contributor,
/// consumed by budget ladder evaluation (NIP-ORG § Performance-linked
/// autonomy). Only the newest row per action (`d_tag`) counts — kind:37013
/// is parameterized-replaceable, so superseded versions must not inflate
/// the tally. Records with a `reviewStatus` other than `accepted` /
/// `rejected` (e.g. `pending`) count as neither.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ContributionOutcomeCounts {
    /// `reviewStatus: "accepted"` records in the window.
    pub accepted: u64,
    /// `reviewStatus: "rejected"` records in the window.
    pub rejected: u64,
}

/// Count accepted/rejected contribution records for one contributor within
/// a window. `dimensions` filters to records carrying at least one of the
/// named dimensions (empty slice = no dimension filter).
pub async fn count_contribution_outcomes(
    pool: &PgPool,
    community_id: Uuid,
    subject_pubkey_hex: &str,
    window_start: chrono::DateTime<chrono::Utc>,
    dimensions: &[String],
) -> Result<ContributionOutcomeCounts> {
    // jsonb `?|` needs a text[] operand; build it once.
    let dims: Vec<String> = dimensions.to_vec();
    let sql = if dims.is_empty() {
        r#"
        SELECT
          COUNT(*) FILTER (WHERE st = 'accepted')::bigint AS accepted,
          COUNT(*) FILTER (WHERE st = 'rejected')::bigint AS rejected
        FROM (
          SELECT DISTINCT ON (d_tag) (content::jsonb->>'reviewStatus') AS st
          FROM events
          WHERE community_id = $1
            AND kind = 37013
            AND deleted_at IS NULL
            AND pubkey = decode($2, 'hex')
            AND d_tag IS NOT NULL
            AND created_at >= $3
          ORDER BY d_tag, created_at DESC
        ) latest
        "#
    } else {
        r#"
        SELECT
          COUNT(*) FILTER (WHERE st = 'accepted')::bigint AS accepted,
          COUNT(*) FILTER (WHERE st = 'rejected')::bigint AS rejected
        FROM (
          SELECT DISTINCT ON (d_tag) (content::jsonb->>'reviewStatus') AS st
          FROM events
          WHERE community_id = $1
            AND kind = 37013
            AND deleted_at IS NULL
            AND pubkey = decode($2, 'hex')
            AND d_tag IS NOT NULL
            AND created_at >= $3
            AND content::jsonb->'dimensions' ?| $4
          ORDER BY d_tag, created_at DESC
        ) latest
        "#
    };

    let mut query = sqlx::query(sql)
        .bind(community_id)
        .bind(subject_pubkey_hex.to_ascii_lowercase())
        .bind(window_start);
    if !dims.is_empty() {
        query = query.bind(dims);
    }
    let row = query.fetch_one(pool).await?;

    Ok(ContributionOutcomeCounts {
        accepted: row.get::<i64, _>("accepted").max(0) as u64,
        rejected: row.get::<i64, _>("rejected").max(0) as u64,
    })
}

/// Check whether a budget subject has hit its limit for a counter type
/// within the current window.
///
/// Returns `Ok(true)` if the subject is under the limit, `Ok(false)` if
/// at or over the limit.
pub async fn check_budget_consumption(
    pool: &PgPool,
    community_id: Uuid,
    subject: &str,
    counter_type: &str,
    window_start: chrono::DateTime<chrono::Utc>,
    limit: i64,
) -> Result<bool> {
    let row = sqlx::query(
        r#"
        SELECT COALESCE(SUM(consumed), 0)::bigint AS total
        FROM budget_consumption
        WHERE community_id = $1
          AND subject = $2
          AND counter_type = $3
          AND window_start >= $4
        "#,
    )
    .bind(community_id)
    .bind(subject)
    .bind(counter_type)
    .bind(window_start)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| DbError::NotFound("budget consumption query returned no row".into()))?;

    let total: i64 = row.get("total");
    Ok(total < limit)
}

/// Atomically increment a budget counter for the current window.
///
/// Uses an UPSERT so concurrent increments are safe. Returns the
/// post-increment consumption value.
pub async fn increment_budget_consumption(
    pool: &PgPool,
    community_id: Uuid,
    subject: &str,
    counter_type: &str,
    window_start: chrono::DateTime<chrono::Utc>,
    amount: i64,
) -> Result<i64> {
    let row = sqlx::query(
        r#"
        INSERT INTO budget_consumption (community_id, subject, counter_type, window_start, consumed, updated_at)
        VALUES ($1, $2, $3, $4, $5, now())
        ON CONFLICT (community_id, subject, counter_type, window_start)
        DO UPDATE SET consumed = budget_consumption.consumed + $5,
                      updated_at = now()
        RETURNING consumed
        "#,
    )
    .bind(community_id)
    .bind(subject)
    .bind(counter_type)
    .bind(window_start)
    .bind(amount)
    .fetch_one(pool)
    .await?;

    Ok(row.get("consumed"))
}

/// Parameters for a durable budget approval request.
pub struct CreateBudgetApprovalParams<'a> {
    /// Budgeted agent pubkey (64-hex, lowercase).
    pub subject: &'a str,
    /// Counter that exceeded its limit (e.g. `"runs"`).
    pub counter_type: &'a str,
    /// Start of the window the counter was consumed in.
    pub window_start: chrono::DateTime<chrono::Utc>,
    /// The limit that was hit.
    pub limit_value: i64,
    /// Kind:37012 budget event id (hex), when the enforcing budget is known.
    pub budget_event_id: Option<&'a str>,
    /// Pre-hashed approval token (see
    /// [`crate::workflow::approval_token_hash_hex`]).
    pub token_hash: &'a [u8],
    /// When the request expires unanswered.
    pub expires_at: chrono::DateTime<chrono::Utc>,
}

/// Persist (or refresh) the durable budget approval request row.
///
/// This is the recovery record for a budget overrun routed to human
/// approval: the row is written before any best-effort kind:46010
/// notification, so a lost notification never loses the request.
///
/// At most one **pending** row exists per
/// `(community_id, subject, counter_type, window_start)` — repeated overrun
/// attempts refresh its expiry instead of growing the table without bound.
/// Returns the stored token hash (the new one on first insert, the existing
/// one on refresh), which the caller embeds in the kind:46010 notification.
pub async fn create_budget_approval(
    pool: &PgPool,
    community_id: CommunityId,
    params: CreateBudgetApprovalParams<'_>,
) -> Result<Vec<u8>> {
    let row = sqlx::query(
        r#"
        INSERT INTO budget_approvals
            (community_id, token, subject, counter_type, window_start, limit_value,
             budget_event_id, status, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8)
        ON CONFLICT (community_id, subject, counter_type, window_start)
            WHERE status = 'pending'
        DO UPDATE SET expires_at = EXCLUDED.expires_at
        RETURNING token
        "#,
    )
    .bind(community_id.as_uuid())
    .bind(params.token_hash)
    .bind(params.subject)
    .bind(params.counter_type)
    .bind(params.window_start)
    .bind(params.limit_value)
    .bind(params.budget_event_id)
    .bind(params.expires_at)
    .fetch_one(pool)
    .await?;

    Ok(row.get("token"))
}

/// A stored budget approval request.
#[derive(Debug, Clone)]
pub struct BudgetApprovalRecord {
    /// Hashed approval token (the row's key component).
    pub token_hash: Vec<u8>,
    /// Budgeted agent pubkey hex.
    pub subject: String,
    /// Counter that exceeded its limit.
    pub counter_type: String,
    /// Window the counter was consumed in.
    pub window_start: chrono::DateTime<chrono::Utc>,
    /// The limit that was hit.
    pub limit_value: i64,
    /// Kind:37012 budget event id (hex), when known.
    pub budget_event_id: Option<String>,
    /// Pending / granted / denied / expired.
    pub status: String,
    /// When the request expires unanswered.
    pub expires_at: chrono::DateTime<chrono::Utc>,
    /// When the request was recorded.
    pub created_at: chrono::DateTime<chrono::Utc>,
    /// Pubkey of the owner who granted/denied, once resolved.
    pub approver: Option<Vec<u8>>,
    /// Free-text note attached at resolution.
    pub note: Option<String>,
    /// When the request was granted (granted rows only).
    pub granted_at: Option<chrono::DateTime<chrono::Utc>>,
    /// When the request was denied (denied rows only).
    pub denied_at: Option<chrono::DateTime<chrono::Utc>>,
}

/// Fetch a budget approval row by its stored (already-hashed) token.
pub async fn get_budget_approval_by_stored_hash(
    pool: &PgPool,
    community_id: CommunityId,
    token_hash: &[u8],
) -> Result<BudgetApprovalRecord> {
    let row = sqlx::query(
        r#"
        SELECT token, subject, counter_type, window_start, limit_value,
               budget_event_id, status::text AS status, expires_at, created_at,
               approver_pubkey, note, granted_at, denied_at
        FROM budget_approvals
        WHERE community_id = $1 AND token = $2
        "#,
    )
    .bind(community_id.as_uuid())
    .bind(token_hash)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| DbError::NotFound("budget approval (hashed token)".to_string()))?;

    Ok(BudgetApprovalRecord {
        token_hash: row.try_get("token")?,
        subject: row.try_get("subject")?,
        counter_type: row.try_get("counter_type")?,
        window_start: row.try_get("window_start")?,
        limit_value: row.try_get("limit_value")?,
        budget_event_id: row.try_get("budget_event_id")?,
        status: row.try_get("status")?,
        expires_at: row.try_get("expires_at")?,
        created_at: row.try_get("created_at")?,
        approver: row.try_get("approver_pubkey")?,
        note: row.try_get("note")?,
        granted_at: row.try_get("granted_at")?,
        denied_at: row.try_get("denied_at")?,
    })
}

/// The resolution a community owner applied to a pending budget approval.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BudgetApprovalDecision {
    /// Forgive the overrun that created the request: exactly one more unit
    /// of the counter may be consumed beyond the limit within the same
    /// window. The counter is NOT rolled back — consumption stays truthful
    /// — and once the counter reaches the effective limit again, the next
    /// overrun raises a fresh pending request.
    Granted,
    /// Refuse the overrun request. The counter is not rolled back and no
    /// tolerance is recorded, so the subject stays at or over the limit.
    /// The next overrun raises a fresh pending request: the partial unique
    /// index (`idx_budget_approvals_one_pending`) constrains only rows with
    /// status `pending`, so a denied row never blocks re-requesting.
    Denied,
}

impl BudgetApprovalDecision {
    /// The `approval_status` enum value stored in `budget_approvals.status`.
    pub fn as_str(self) -> &'static str {
        match self {
            BudgetApprovalDecision::Granted => "granted",
            BudgetApprovalDecision::Denied => "denied",
        }
    }
}

/// Resolve a pending budget approval row (grant or deny) by its stored
/// (already-hashed) token.
///
/// Mirrors the workflow-approval TOCTOU guard: the `UPDATE` carries
/// `AND status = 'pending'`, so of two concurrent resolutions exactly one
/// returns `true` and the loser observes the row already resolved.
///
/// Expiry is enforced by the caller (the relay approval command path
/// rejects a resolution whose row is past `expires_at`, matching workflow
/// approvals); an expired-but-still-pending row is never silently
/// resolved here. An unanswered expired row is not dead state either —
/// the next overrun refreshes it via [`create_budget_approval`] (new
/// `expires_at`, same stored token), so the request stays actionable.
///
/// Returns `true` when this call won the pending row.
pub async fn resolve_budget_approval_by_stored_hash(
    pool: &PgPool,
    community_id: CommunityId,
    token_hash: &[u8],
    decision: BudgetApprovalDecision,
    approver_pubkey: Option<&[u8]>,
    note: Option<&str>,
) -> Result<bool> {
    let status_str = decision.as_str();
    let affected = sqlx::query(
        r#"
        UPDATE budget_approvals
        SET status          = $1::approval_status,
            approver_pubkey = $2,
            note            = $3,
            granted_at      = CASE WHEN $1 = 'granted' THEN NOW() ELSE granted_at END,
            denied_at       = CASE WHEN $1 = 'denied'  THEN NOW() ELSE denied_at  END
        WHERE community_id = $4 AND token = $5 AND status = 'pending'
        "#,
    )
    .bind(status_str)
    .bind(approver_pubkey)
    .bind(note)
    .bind(community_id.as_uuid())
    .bind(token_hash)
    .execute(pool)
    .await?
    .rows_affected();

    Ok(affected > 0)
}

/// Count granted budget approvals that lift a budget's effective limit.
///
/// A grant means "this overrun is forgiven once": each granted row for the
/// same `(community, subject, counter_type, window_start, budget_event_id)`
/// raises the budget's effective limit by exactly one unit of consumption.
/// Consumption counters are never rolled back; the enforcement check
/// compares consumption against `limit + granted_count`, so a granted
/// subject may act again until the counter reaches the limit once more,
/// then the next overrun raises a fresh request. Pending and denied rows
/// contribute nothing, and rows from other windows, counters, or budget
/// events never leak into this limit.
pub async fn count_granted_budget_tolerances(
    pool: &PgPool,
    community_id: CommunityId,
    subject: &str,
    counter_type: &str,
    window_start: chrono::DateTime<chrono::Utc>,
    budget_event_id: Option<&str>,
) -> Result<i64> {
    let row = sqlx::query(
        r#"
        SELECT COUNT(*)::bigint AS granted
        FROM budget_approvals
        WHERE community_id = $1
          AND subject = $2
          AND counter_type = $3
          AND window_start = $4
          AND status = 'granted'
          AND budget_event_id IS NOT DISTINCT FROM $5
        "#,
    )
    .bind(community_id.as_uuid())
    .bind(subject)
    .bind(counter_type)
    .bind(window_start)
    .bind(budget_event_id)
    .fetch_one(pool)
    .await?;

    Ok(row.get("granted"))
}

impl Db {
    /// Look up budget events for a given agent pubkey.
    #[datastore_span(name = "budget_enforcement_lookup", system = "postgresql")]
    pub async fn budget_enforcement_lookup(
        &self,
        community_id: CommunityId,
        agent_pubkey_hex: &str,
    ) -> Result<Vec<BudgetEvent>> {
        budget_enforcement_lookup(&self.pool, *community_id.as_uuid(), agent_pubkey_hex).await
    }

    /// Count accepted/rejected contribution records for a budget ladder.
    #[datastore_span(name = "count_contribution_outcomes", system = "postgresql")]
    pub async fn count_contribution_outcomes(
        &self,
        community_id: CommunityId,
        subject_pubkey_hex: &str,
        window_start: chrono::DateTime<chrono::Utc>,
        dimensions: &[String],
    ) -> Result<ContributionOutcomeCounts> {
        count_contribution_outcomes(
            &self.pool,
            *community_id.as_uuid(),
            subject_pubkey_hex,
            window_start,
            dimensions,
        )
        .await
    }

    /// Check whether a budget subject has hit its limit for a counter type
    /// within the current window.
    #[datastore_span(name = "check_budget_consumption", system = "postgresql")]
    pub async fn check_budget_consumption(
        &self,
        community_id: CommunityId,
        subject: &str,
        counter_type: &str,
        window_start: chrono::DateTime<chrono::Utc>,
        limit: i64,
    ) -> Result<bool> {
        check_budget_consumption(
            &self.pool,
            *community_id.as_uuid(),
            subject,
            counter_type,
            window_start,
            limit,
        )
        .await
    }

    /// Atomically increment a budget counter for the current window.
    #[datastore_span(name = "increment_budget_consumption", system = "postgresql")]
    pub async fn increment_budget_consumption(
        &self,
        community_id: CommunityId,
        subject: &str,
        counter_type: &str,
        window_start: chrono::DateTime<chrono::Utc>,
        amount: i64,
    ) -> Result<i64> {
        increment_budget_consumption(
            &self.pool,
            *community_id.as_uuid(),
            subject,
            counter_type,
            window_start,
            amount,
        )
        .await
    }

    /// Persist (or refresh) the durable budget approval request row.
    #[datastore_span(name = "create_budget_approval", system = "postgresql")]
    pub async fn create_budget_approval(
        &self,
        community_id: CommunityId,
        params: CreateBudgetApprovalParams<'_>,
    ) -> Result<Vec<u8>> {
        create_budget_approval(&self.pool, community_id, params).await
    }

    /// Fetch a budget approval row by its stored (already-hashed) token.
    #[datastore_span(name = "get_budget_approval_by_stored_hash", system = "postgresql")]
    pub async fn get_budget_approval_by_stored_hash(
        &self,
        community_id: CommunityId,
        token_hash: &[u8],
    ) -> Result<BudgetApprovalRecord> {
        get_budget_approval_by_stored_hash(&self.pool, community_id, token_hash).await
    }
    /// Resolve a pending budget approval row (grant or deny) by its stored
    /// (already-hashed) token. TOCTOU-guarded: only a `pending` row is
    /// updated; returns `true` when this call won the row.
    #[datastore_span(name = "resolve_budget_approval", system = "postgresql")]
    pub async fn resolve_budget_approval(
        &self,
        community_id: CommunityId,
        token_hash: &[u8],
        decision: BudgetApprovalDecision,
        approver_pubkey: Option<&[u8]>,
        note: Option<&str>,
    ) -> Result<bool> {
        resolve_budget_approval_by_stored_hash(
            &self.pool,
            community_id,
            token_hash,
            decision,
            approver_pubkey,
            note,
        )
        .await
    }

    /// Count granted budget approvals that lift a budget's effective limit
    /// (one forgiven overrun per grant).
    #[datastore_span(name = "count_granted_budget_tolerances", system = "postgresql")]
    pub async fn count_granted_budget_tolerances(
        &self,
        community_id: CommunityId,
        subject: &str,
        counter_type: &str,
        window_start: chrono::DateTime<chrono::Utc>,
        budget_event_id: Option<&str>,
    ) -> Result<i64> {
        count_granted_budget_tolerances(
            &self.pool,
            community_id,
            subject,
            counter_type,
            window_start,
            budget_event_id,
        )
        .await
    }
}

#[cfg(test)]
mod postgres_tests {
    use super::*;

    async fn test_pool() -> PgPool {
        let database_url = crate::test_support::database_url();
        let pool = PgPool::connect(&database_url)
            .await
            .expect("connect test DB");
        // Apply pending migrations (idempotent) so the newest tables —
        // including this migration's budget tables — exist.
        Db::from_pool(pool.clone())
            .migrate()
            .await
            .expect("migrate test DB");
        pool
    }

    async fn insert_test_community(pool: &PgPool) -> Uuid {
        let id = Uuid::new_v4();
        sqlx::query("INSERT INTO communities (id, host) VALUES ($1, $2)")
            .bind(id)
            .bind(format!("budget-{id}.test"))
            .execute(pool)
            .await
            .expect("insert community");
        id
    }

    async fn insert_budget_event(
        pool: &PgPool,
        community_id: Uuid,
        subject: &str,
        on_exceed: &str,
    ) -> Vec<u8> {
        let mut event_id = [0u8; 32];
        event_id[..16].copy_from_slice(Uuid::new_v4().as_bytes());
        event_id[16..].copy_from_slice(Uuid::new_v4().as_bytes());
        let content = serde_json::json!({
            "v": 1,
            "subject": subject,
            "window": "day",
            "limits": { "runs": 50 },
            "onExceed": on_exceed,
        })
        .to_string();
        sqlx::query(
            "INSERT INTO events (community_id, id, pubkey, created_at, kind, tags, content, sig)
             VALUES ($1, $2, $3, now(), 37012, '[]'::jsonb, $4, $5)",
        )
        .bind(community_id)
        .bind(event_id.as_slice())
        .bind([9u8; 32])
        .bind(content)
        .bind([1u8; 64])
        .execute(pool)
        .await
        .expect("insert budget event");
        event_id.to_vec()
    }

    async fn cleanup(pool: &PgPool, community_id: Uuid) {
        sqlx::query("DELETE FROM events WHERE community_id = $1")
            .bind(community_id)
            .execute(pool)
            .await
            .expect("delete events");
        sqlx::query("DELETE FROM budget_consumption WHERE community_id = $1")
            .bind(community_id)
            .execute(pool)
            .await
            .expect("delete consumption");
        sqlx::query("DELETE FROM budget_approvals WHERE community_id = $1")
            .bind(community_id)
            .execute(pool)
            .await
            .expect("delete approvals");
        sqlx::query("DELETE FROM communities WHERE id = $1")
            .bind(community_id)
            .execute(pool)
            .await
            .expect("delete community");
    }

    /// Binds the production lookup seam: the SQL must execute and return
    /// only the budgets whose `content.subject` matches the agent pubkey
    /// (case-insensitively), never budgets capping other agents.
    #[tokio::test]
    #[ignore = "requires migrated Postgres"]
    async fn budget_lookup_finds_budgets_by_content_subject() {
        let pool = test_pool().await;
        let community = insert_test_community(&pool).await;
        let agent = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let other = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

        let own_id = insert_budget_event(&pool, community, agent, "require-approval").await;
        insert_budget_event(&pool, community, other, "reject").await;
        // Uppercase variant of the same subject must also match.
        let upper = agent.to_ascii_uppercase();
        insert_budget_event(&pool, community, &upper, "reject").await;

        let db = Db::from_pool(pool.clone());
        let found = db
            .budget_enforcement_lookup(buzz_core::CommunityId::from_uuid(community), agent)
            .await
            .expect("lookup");

        assert_eq!(
            found.len(),
            2,
            "own + uppercase variant, not the other agent's"
        );
        assert!(
            found
                .iter()
                .all(|b| b.content.contains(agent) || b.content.contains(&upper)),
            "all hits must name the agent"
        );
        let approval_one = found
            .iter()
            .find(|b| b.on_exceed == "require-approval")
            .expect("onExceed parsed from camelCase key");
        assert_eq!(
            approval_one.event_id_hex,
            hex::encode(own_id),
            "event id hex is returned for the audit reference"
        );

        cleanup(&pool, community).await;
    }

    /// Binds the consumption seam: increments accumulate within a window,
    /// the limit check respects them, and a previous window does not count.
    #[tokio::test]
    #[ignore = "requires migrated Postgres"]
    async fn consumption_increment_and_window_check() {
        let pool = test_pool().await;
        let community = insert_test_community(&pool).await;
        let db = Db::from_pool(pool.clone());
        let community_id = buzz_core::CommunityId::from_uuid(community);
        let agent = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
        let now = chrono::Utc::now();
        let current_window = budget_window_start_for_test(now);
        let old_window = current_window - chrono::Duration::days(40);

        // A stale window's consumption must not count toward the current one.
        db.increment_budget_consumption(community_id, agent, "runs", old_window, 10)
            .await
            .expect("increment old window");

        assert!(
            db.check_budget_consumption(community_id, agent, "runs", current_window, 3)
                .await
                .expect("check empty window"),
            "fresh window is under the limit"
        );

        assert_eq!(
            db.increment_budget_consumption(community_id, agent, "runs", current_window, 1)
                .await
                .expect("first increment"),
            1
        );
        assert_eq!(
            db.increment_budget_consumption(community_id, agent, "runs", current_window, 1)
                .await
                .expect("second increment"),
            2,
            "post-increment value is returned"
        );

        assert!(
            db.check_budget_consumption(community_id, agent, "runs", current_window, 3)
                .await
                .expect("check under limit"),
            "2 < 3 is under the limit"
        );
        assert!(
            !db.check_budget_consumption(community_id, agent, "runs", current_window, 2)
                .await
                .expect("check at limit"),
            "2 >= 2 is at the limit"
        );
        // Concurrent-safe UPSERT accumulates rather than overwriting.
        assert_eq!(
            db.increment_budget_consumption(community_id, agent, "runs", current_window, 1)
                .await
                .expect("third increment"),
            3
        );

        cleanup(&pool, community).await;
    }

    /// Binds the durable approval row: created pending, retrievable by the
    /// stored hash, and scoped to its community.
    #[tokio::test]
    #[ignore = "requires migrated Postgres"]
    async fn budget_approval_row_is_durable_and_retrievable() {
        let pool = test_pool().await;
        let community = insert_test_community(&pool).await;
        let db = Db::from_pool(pool.clone());
        let community_id = buzz_core::CommunityId::from_uuid(community);
        let agent = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
        let token_hash = [7u8; 32];
        let window_start = chrono::Utc::now();
        let expires_at = window_start + chrono::Duration::seconds(3600);

        let stored = db
            .create_budget_approval(
                community_id,
                CreateBudgetApprovalParams {
                    subject: agent,
                    counter_type: "runs",
                    window_start,
                    limit_value: 50,
                    budget_event_id: Some("abc123"),
                    token_hash: &token_hash,
                    expires_at,
                },
            )
            .await
            .expect("create budget approval");
        assert_eq!(
            stored, token_hash,
            "first insert returns the new token hash"
        );

        // A repeat overrun refreshes the pending request instead of adding a
        // second row, and returns the still-stored token hash.
        let refreshed = db
            .create_budget_approval(
                community_id,
                CreateBudgetApprovalParams {
                    subject: agent,
                    counter_type: "runs",
                    window_start,
                    limit_value: 50,
                    budget_event_id: Some("abc123"),
                    token_hash: &[9u8; 32],
                    expires_at,
                },
            )
            .await
            .expect("refresh budget approval");
        assert_eq!(
            refreshed, token_hash,
            "refresh keeps the original token hash"
        );

        let record = db
            .get_budget_approval_by_stored_hash(community_id, &token_hash)
            .await
            .expect("fetch by stored hash");
        assert_eq!(record.subject, agent);
        assert_eq!(record.counter_type, "runs");
        assert_eq!(record.limit_value, 50);
        assert_eq!(record.status, "pending");
        assert_eq!(record.budget_event_id.as_deref(), Some("abc123"));

        // Another community cannot read the row.
        let other = insert_test_community(&pool).await;
        assert!(
            db.get_budget_approval_by_stored_hash(
                buzz_core::CommunityId::from_uuid(other),
                &token_hash
            )
            .await
            .is_err(),
            "cross-community token lookup must not resolve"
        );
        sqlx::query("DELETE FROM communities WHERE id = $1")
            .bind(other)
            .execute(&pool)
            .await
            .expect("delete other community");

        cleanup(&pool, community).await;
    }

    /// Binds the resolution seam: grant/deny update a pending row exactly
    /// once (TOCTOU guard), record the approver and timestamp, and never
    /// touch an already-resolved row.
    #[tokio::test]
    #[ignore = "requires migrated Postgres"]
    async fn budget_resolution_updates_pending_rows_only() {
        let pool = test_pool().await;
        let community = insert_test_community(&pool).await;
        let db = Db::from_pool(pool.clone());
        let community_id = buzz_core::CommunityId::from_uuid(community);
        let agent = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
        let approver = [5u8; 32];
        let window_start = chrono::Utc::now();
        let expires_at = window_start + chrono::Duration::seconds(3600);

        let token_a = [1u8; 32];
        db.create_budget_approval(
            community_id,
            CreateBudgetApprovalParams {
                subject: agent,
                counter_type: "runs",
                window_start,
                limit_value: 2,
                budget_event_id: Some("evt-a"),
                token_hash: &token_a,
                expires_at,
            },
        )
        .await
        .expect("create approval A");

        // Grant wins the pending row once; the loser is refused.
        assert!(
            db.resolve_budget_approval(
                community_id,
                &token_a,
                BudgetApprovalDecision::Granted,
                Some(&approver),
                Some("ok once"),
            )
            .await
            .expect("grant A"),
            "first grant must win the pending row"
        );
        assert!(
            !db.resolve_budget_approval(
                community_id,
                &token_a,
                BudgetApprovalDecision::Granted,
                Some(&approver),
                None,
            )
            .await
            .expect("second grant A"),
            "second grant must lose (row no longer pending)"
        );

        let granted = db
            .get_budget_approval_by_stored_hash(community_id, &token_a)
            .await
            .expect("fetch granted row");
        assert_eq!(granted.status, "granted");
        assert_eq!(granted.approver.as_deref(), Some(&approver[..]));
        assert!(granted.granted_at.is_some());
        assert!(granted.denied_at.is_none());

        // A grant is not denied retroactively: the row is resolved.
        assert!(
            !db.resolve_budget_approval(
                community_id,
                &token_a,
                BudgetApprovalDecision::Denied,
                Some(&approver),
                None,
            )
            .await
            .expect("deny granted row"),
            "deny must not flip a granted row"
        );
        assert!(
            db.get_budget_approval_by_stored_hash(community_id, &token_a)
                .await
                .expect("refetch")
                .status
                == "granted",
            "row stays granted after refused deny"
        );

        // Deny path on a fresh pending row.
        let token_b = [2u8; 32];
        // (the previous row is granted, so the partial unique index admits B)
        db.create_budget_approval(
            community_id,
            CreateBudgetApprovalParams {
                subject: agent,
                counter_type: "runs",
                window_start,
                limit_value: 2,
                budget_event_id: Some("evt-a"),
                token_hash: &token_b,
                expires_at,
            },
        )
        .await
        .expect("create approval B");
        assert!(
            db.resolve_budget_approval(
                community_id,
                &token_b,
                BudgetApprovalDecision::Denied,
                Some(&approver),
                Some("no"),
            )
            .await
            .expect("deny B"),
            "deny wins the pending row"
        );
        let denied = db
            .get_budget_approval_by_stored_hash(community_id, &token_b)
            .await
            .expect("fetch denied row");
        assert_eq!(denied.status, "denied");
        assert!(denied.denied_at.is_some());
        assert!(denied.granted_at.is_none());
        assert_eq!(denied.note.as_deref(), Some("no"));

        cleanup(&pool, community).await;
    }

    /// After a denial the row is no longer pending, so the partial unique
    /// index admits a fresh pending row for the same coordinate — a new
    /// overrun raises a new request with a new token, and refreshes keep
    /// hitting the new pending row.
    #[tokio::test]
    #[ignore = "requires migrated Postgres"]
    async fn re_overrun_after_denial_creates_fresh_pending_row() {
        let pool = test_pool().await;
        let community = insert_test_community(&pool).await;
        let db = Db::from_pool(pool.clone());
        let community_id = buzz_core::CommunityId::from_uuid(community);
        let agent = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
        let window_start = chrono::Utc::now();
        let expires_at = window_start + chrono::Duration::seconds(3600);

        fn make<'a>(
            agent: &'a str,
            token: &'a [u8; 32],
            window_start: chrono::DateTime<chrono::Utc>,
            expires_at: chrono::DateTime<chrono::Utc>,
        ) -> CreateBudgetApprovalParams<'a> {
            CreateBudgetApprovalParams {
                subject: agent,
                counter_type: "runs",
                window_start,
                limit_value: 1,
                budget_event_id: Some("evt-r"),
                token_hash: token,
                expires_at,
            }
        }
        let token_c = [3u8; 32];
        assert_eq!(
            db.create_budget_approval(
                community_id,
                make(agent, &token_c, window_start, expires_at)
            )
            .await
            .expect("create C"),
            token_c
        );
        db.resolve_budget_approval(
            community_id,
            &token_c,
            BudgetApprovalDecision::Denied,
            None,
            None,
        )
        .await
        .expect("deny C");

        // Re-overrun after denial: a NEW pending row inserts (the denied
        // row does not hold the partial unique index).
        let token_d = [4u8; 32];
        assert_eq!(
            db.create_budget_approval(
                community_id,
                make(agent, &token_d, window_start, expires_at)
            )
            .await
            .expect("create D after denial"),
            token_d,
            "fresh overrun must mint a fresh token, not reuse the denied one"
        );
        assert_eq!(
            db.get_budget_approval_by_stored_hash(community_id, &token_c)
                .await
                .expect("fetch C")
                .status,
            "denied"
        );
        assert_eq!(
            db.get_budget_approval_by_stored_hash(community_id, &token_d)
                .await
                .expect("fetch D")
                .status,
            "pending"
        );

        // Refresh targets the pending row D, not the denied row C.
        let token_e = [6u8; 32];
        assert_eq!(
            db.create_budget_approval(
                community_id,
                make(agent, &token_e, window_start, expires_at)
            )
            .await
            .expect("refresh"),
            token_d,
            "refresh keeps the pending row's stored token"
        );
        assert_eq!(
            db.get_budget_approval_by_stored_hash(community_id, &token_c)
                .await
                .expect("fetch C again")
                .status,
            "denied",
            "refresh must not resurrect the denied row"
        );

        cleanup(&pool, community).await;
    }

    /// Binds the tolerance seam: only granted rows for the exact
    /// (subject, counter, window, budget event) lift the effective limit.
    #[tokio::test]
    #[ignore = "requires migrated Postgres"]
    async fn granted_tolerance_counts_only_matching_granted_rows() {
        let pool = test_pool().await;
        let community = insert_test_community(&pool).await;
        let db = Db::from_pool(pool.clone());
        let community_id = buzz_core::CommunityId::from_uuid(community);
        let agent = "abababababababababababababababababababababababababababababababab";
        let window_start = chrono::Utc::now();
        let other_window = window_start - chrono::Duration::days(1);
        let expires_at = window_start + chrono::Duration::seconds(3600);
        let approver = [7u8; 32];

        fn make<'a>(
            agent: &'a str,
            token: &'a [u8; 32],
            counter: &'a str,
            window: chrono::DateTime<chrono::Utc>,
            event: Option<&'a str>,
            expires_at: chrono::DateTime<chrono::Utc>,
        ) -> CreateBudgetApprovalParams<'a> {
            CreateBudgetApprovalParams {
                subject: agent,
                counter_type: counter,
                window_start: window,
                limit_value: 2,
                budget_event_id: event,
                token_hash: token,
                expires_at,
            }
        }
        // Matching granted row.
        let token_g = [10u8; 32];
        db.create_budget_approval(
            community_id,
            make(
                agent,
                &token_g,
                "runs",
                window_start,
                Some("evt-1"),
                expires_at,
            ),
        )
        .await
        .expect("create granted row");
        db.resolve_budget_approval(
            community_id,
            &token_g,
            BudgetApprovalDecision::Granted,
            Some(&approver),
            None,
        )
        .await
        .expect("grant");

        // Same coordinate but still pending: must not count.
        let token_p = [11u8; 32];
        db.create_budget_approval(
            community_id,
            make(
                agent,
                &token_p,
                "runs",
                window_start,
                Some("evt-1"),
                expires_at,
            ),
        )
        .await
        .expect("create pending row");
        // Same coordinate but denied: must not count.
        let token_x = [12u8; 32];
        db.create_budget_approval(
            community_id,
            make(
                agent,
                &token_x,
                "runs",
                window_start,
                Some("evt-1"),
                expires_at,
            ),
        )
        .await
        .expect("create denied row");
        db.resolve_budget_approval(
            community_id,
            &token_x,
            BudgetApprovalDecision::Denied,
            Some(&approver),
            None,
        )
        .await
        .expect("deny");

        // Granted but different window / counter / budget event / subject.
        let token_w = [13u8; 32];
        db.create_budget_approval(
            community_id,
            make(
                agent,
                &token_w,
                "runs",
                other_window,
                Some("evt-1"),
                expires_at,
            ),
        )
        .await
        .expect("create other-window row");
        db.resolve_budget_approval(
            community_id,
            &token_w,
            BudgetApprovalDecision::Granted,
            Some(&approver),
            None,
        )
        .await
        .expect("grant other window");
        let token_k = [14u8; 32];
        db.create_budget_approval(
            community_id,
            make(
                agent,
                &token_k,
                "task_create",
                window_start,
                Some("evt-1"),
                expires_at,
            ),
        )
        .await
        .expect("create other-counter row");
        db.resolve_budget_approval(
            community_id,
            &token_k,
            BudgetApprovalDecision::Granted,
            Some(&approver),
            None,
        )
        .await
        .expect("grant other counter");
        let token_e = [15u8; 32];
        db.create_budget_approval(
            community_id,
            make(
                agent,
                &token_e,
                "runs",
                window_start,
                Some("evt-2"),
                expires_at,
            ),
        )
        .await
        .expect("create other-budget row");
        db.resolve_budget_approval(
            community_id,
            &token_e,
            BudgetApprovalDecision::Granted,
            Some(&approver),
            None,
        )
        .await
        .expect("grant other budget");

        assert_eq!(
            db.count_granted_budget_tolerances(
                community_id,
                agent,
                "runs",
                window_start,
                Some("evt-1")
            )
            .await
            .expect("count"),
            1,
            "only the one matching granted row lifts the limit"
        );
        assert_eq!(
            db.count_granted_budget_tolerances(community_id, agent, "runs", window_start, None)
                .await
                .expect("count null-event"),
            0,
            "rows tied to a budget event must not lift an event-less lookup"
        );
        assert_eq!(
            db.count_granted_budget_tolerances(
                community_id,
                "c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0",
                "runs",
                window_start,
                Some("evt-1")
            )
            .await
            .expect("count other subject"),
            0,
            "another subject's grants never leak"
        );

        cleanup(&pool, community).await;
    }

    fn budget_window_start_for_test(
        now: chrono::DateTime<chrono::Utc>,
    ) -> chrono::DateTime<chrono::Utc> {
        // Same day-window anchor the relay computes; kept local so this test
        // does not depend on relay internals.
        now.date_naive()
            .and_hms_opt(0, 0, 0)
            .map(|t| t.and_utc())
            .unwrap_or(now)
    }
}
