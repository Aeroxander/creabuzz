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

/// Upper bound on budget events returned per subject lookup.
///
/// Budgets are small, community-level records and the lookup filters by
/// subject *in SQL*, so unrelated budgets can never crowd a subject's own out
/// of the result. The bound only caps how many budgets one subject can carry:
/// budgets are NIP-33 replaceable per `(author, d)`, and only the community
/// owner/admin, anchored seat holders, and the subject itself may publish one
/// for it, so 64 is far beyond any realistic org.
pub const BUDGET_LOOKUP_CAP: i64 = 64;

/// Upper bound on community default (`subject: "*"`) budgets returned by
/// [`default_budget_lookup`]. Only the owner/admin can publish them.
pub const DEFAULT_BUDGET_LOOKUP_CAP: i64 = 16;

/// `content.subject` of the community default budget (R2).
pub const DEFAULT_BUDGET_SUBJECT: &str = buzz_core::org_grant::DEFAULT_BUDGET_SUBJECT;

/// Upper bound on the subject's own contribution action ids examined when
/// tallying ladder outcomes.
const CONTRIBUTION_ACTION_CAP: i64 = 2_000;

/// Upper bound on review events examined when tallying ladder outcomes.
const CONTRIBUTION_REVIEW_CAP: i64 = 5_000;

/// One applicable budget event returned by [`budget_enforcement_lookup`].
#[derive(Debug, Clone)]
pub struct BudgetEvent {
    /// Raw JSON content of the kind:37012 event.
    pub content: String,
    /// `onExceed` policy, defaulting to `"require-approval"`.
    pub on_exceed: String,
    /// Event id (hex) of the kind:37012 record, for audit references.
    pub event_id_hex: String,
    /// Signer of the budget event (lowercase 64-hex). Enforcement uses it to
    /// tell an authority-authored budget from a subject-authored one.
    pub author_hex: String,
}

/// Look up budget events whose `content.subject` equals `subject`.
///
/// The subject filter runs in SQL (`lower(content.subject) = $subject`), newest
/// first, bounded by `cap`. The JSON cast only ever runs on JSON-object rows of
/// kind 37012 (nested `CASE`s — SQL does not promise `AND` short-circuiting),
/// so a malformed unrelated row cannot fail the lookup. Budgets with malformed
/// content are ignored by enforcement: ingest validation rejects them.
async fn budgets_for_subject(
    pool: &PgPool,
    community_id: Uuid,
    subject: &str,
    cap: i64,
) -> Result<Vec<BudgetEvent>> {
    let rows = sqlx::query(
        r#"
        SELECT encode(id, 'hex') AS event_id,
               encode(pubkey, 'hex') AS author,
               content
        FROM events
        WHERE community_id = $1
          AND kind = 37012
          AND deleted_at IS NULL
          AND CASE
                WHEN kind = 37012 AND content IS JSON OBJECT
                  THEN lower(content::jsonb ->> 'subject') = $2
                ELSE false
              END
        ORDER BY created_at DESC, id ASC
        LIMIT $3
        "#,
    )
    .bind(community_id)
    .bind(subject.to_ascii_lowercase())
    .bind(cap)
    .fetch_all(pool)
    .await?;

    let mut results = Vec::with_capacity(rows.len());
    for row in rows {
        let content: String = row.get("content");
        let parsed: serde_json::Value = match serde_json::from_str(&content) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let on_exceed: String = parsed
            .get("onExceed")
            .and_then(|o| o.as_str())
            .map(String::from)
            .unwrap_or_else(|| "require-approval".into());
        results.push(BudgetEvent {
            content,
            on_exceed,
            event_id_hex: row.get("event_id"),
            author_hex: row.get("author"),
        });
    }
    Ok(results)
}

/// Look up budget events for a given agent pubkey.
///
/// Returns each budget whose `content.subject` equals the agent's hex pubkey
/// (case-insensitive), filtered in SQL so that budgets for other subjects can
/// never hide it. The caller parses `content` to extract limits and window
/// type.
pub async fn budget_enforcement_lookup(
    pool: &PgPool,
    community_id: Uuid,
    agent_pubkey_hex: &str,
) -> Result<Vec<BudgetEvent>> {
    budgets_for_subject(pool, community_id, agent_pubkey_hex, BUDGET_LOOKUP_CAP).await
}

/// Look up the community's default budgets (`content.subject == "*"`, R2).
///
/// A default budget covers every agent that has no budget of its own. Ingest
/// admits them from the community owner/admin only, so every row returned
/// here carries that authority.
pub async fn default_budget_lookup(pool: &PgPool, community_id: Uuid) -> Result<Vec<BudgetEvent>> {
    budgets_for_subject(
        pool,
        community_id,
        DEFAULT_BUDGET_SUBJECT,
        DEFAULT_BUDGET_LOOKUP_CAP,
    )
    .await
}

/// Deterministic per-window contribution outcome counts for one contributor,
/// consumed by budget ladder evaluation (NIP-ORG § Performance-linked
/// autonomy). Records with a `reviewStatus` other than `accepted` /
/// `rejected` (e.g. `pending`, `appealed`) count as neither.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ContributionOutcomeCounts {
    /// Actions whose canonical authorized review is `accepted`.
    pub accepted: u64,
    /// Actions whose canonical authorized review is `rejected`.
    pub rejected: u64,
}

/// Count accepted/rejected contribution actions for one contributor within a
/// window. `dimensions` filters to reviews carrying at least one of the named
/// dimensions (empty slice = no dimension filter).
///
/// **The subject's own `reviewStatus` is never trusted** — a contributor
/// (typically an agent) grading itself must not climb the autonomy ladder. An
/// action counts only through a review: a kind:37013 event with the same `d`
/// tag, signed by a pubkey other than the subject, who is the community
/// owner/admin or a human holding a seat in an *anchored* org node
/// ([`buzz_core::org_grant::is_authority_holder`]). Per action the canonical
/// disposition is the newest such review
/// ([`buzz_core::org_grant::tally_reviews`]); a review cannot predate the
/// subject's own record of the action, and the window is applied to the
/// review's `created_at` (when the verdict was reached).
pub async fn count_contribution_outcomes(
    pool: &PgPool,
    community_id: Uuid,
    subject_pubkey_hex: &str,
    window_start: chrono::DateTime<chrono::Utc>,
    dimensions: &[String],
) -> Result<ContributionOutcomeCounts> {
    let subject = subject_pubkey_hex.to_ascii_lowercase();
    // `mine`: the subject's own action ids (newest first, bounded) with the
    // time of its earliest surviving record. Reviews are matched to actions
    // by `d`; the subject's own rows only establish that the action is its.
    // jsonb `?|` needs a text[] operand.
    let dimension_filter = if dimensions.is_empty() {
        ""
    } else {
        "AND CASE WHEN r.content IS JSON OBJECT \
              THEN r.content::jsonb -> 'dimensions' ?| $6 \
              ELSE false END"
    };
    let sql = format!(
        r#"
        WITH mine AS (
          SELECT d_tag, MIN(created_at) AS first_at
          FROM events
          WHERE community_id = $1
            AND kind = 37013
            AND deleted_at IS NULL
            AND pubkey = decode($2, 'hex')
            AND d_tag IS NOT NULL
          GROUP BY d_tag
          ORDER BY MAX(created_at) DESC
          LIMIT $4
        )
        SELECT r.d_tag AS d,
               encode(r.pubkey, 'hex') AS reviewer,
               EXTRACT(EPOCH FROM r.created_at)::bigint AS created_at,
               encode(r.id, 'hex') AS event_id,
               CASE WHEN r.content IS JSON OBJECT
                    THEN r.content::jsonb ->> 'reviewStatus'
               END AS status
        FROM events r
        JOIN mine m ON m.d_tag = r.d_tag
        WHERE r.community_id = $1
          AND r.kind = 37013
          AND r.deleted_at IS NULL
          AND r.pubkey <> decode($2, 'hex')
          AND r.created_at >= $3
          AND r.created_at >= m.first_at
          {dimension_filter}
        ORDER BY r.created_at DESC, r.id ASC
        LIMIT $5
        "#
    );

    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(community_id)
        .bind(&subject)
        .bind(window_start)
        .bind(CONTRIBUTION_ACTION_CAP)
        .bind(CONTRIBUTION_REVIEW_CAP);
    if !dimensions.is_empty() {
        query = query.bind(dimensions.to_vec());
    }
    let rows = query.fetch_all(pool).await?;

    let reviews: Vec<buzz_core::org_grant::ReviewRow> = rows
        .iter()
        .map(|row| {
            let created_at: i64 = row.get("created_at");
            buzz_core::org_grant::ReviewRow {
                d: row.get("d"),
                reviewer: row.get("reviewer"),
                created_at: created_at.max(0) as u64,
                event_id: row.get("event_id"),
                status: row.get("status"),
            }
        })
        .collect();

    // Resolve each distinct reviewer's authority once.
    let graph = crate::store::org_graph::PgOrgGraph::new(pool, community_id);
    let mut authorized = std::collections::HashSet::new();
    let mut checked = std::collections::HashSet::new();
    for review in &reviews {
        if review.reviewer == subject || !checked.insert(review.reviewer.clone()) {
            continue;
        }
        match buzz_core::org_grant::is_authority_holder(&graph, &review.reviewer).await {
            Ok(true) => {
                authorized.insert(review.reviewer.clone());
            }
            Ok(false) => {}
            // A denial here means the graph was too large to verify:
            // treat the reviewer as unauthorized (fail closed).
            Err(buzz_core::org_grant::OrgAuthorityError::Denied(_)) => {}
            // A store error must not read as "nobody reviewed": propagate.
            Err(buzz_core::org_grant::OrgAuthorityError::Source(e)) => return Err(e),
        }
    }

    let (accepted, rejected) = buzz_core::org_grant::tally_reviews(&reviews, &subject, &authorized);
    Ok(ContributionOutcomeCounts { accepted, rejected })
}

/// Check whether a budget subject has hit its limit for a counter type
/// within the window that starts at `window_start`.
///
/// The counter is the single row keyed `(community, subject, counter,
/// window_start)`: one action increments each `(counter, window)` exactly once
/// (see [`increment_budget_consumption`]), whatever number of budgets apply,
/// so this reads that one row — never a sum across windows, which would count
/// the same action once per window kind.
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
          AND window_start = $4
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

    /// Look up the community default budgets (`subject: "*"`, R2).
    #[datastore_span(name = "default_budget_lookup", system = "postgresql")]
    pub async fn default_budget_lookup(
        &self,
        community_id: CommunityId,
    ) -> Result<Vec<BudgetEvent>> {
        default_budget_lookup(&self.pool, *community_id.as_uuid()).await
    }

    /// Count reviewed accepted/rejected contribution actions for a budget
    /// ladder (self-attested status never counts).
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
        sqlx::query("DELETE FROM relay_members WHERE community_id = $1")
            .bind(community_id)
            .execute(pool)
            .await
            .expect("delete relay members");
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

    /// Insert a raw org/contribution event row with a signer, `d` tag,
    /// content and creation time — the same raw-row recipe the relay's
    /// enforcement tests use.
    async fn insert_org_event(
        pool: &PgPool,
        community_id: Uuid,
        kind: i32,
        author: &[u8; 32],
        d_tag: Option<&str>,
        content: serde_json::Value,
        created_at: chrono::DateTime<chrono::Utc>,
    ) {
        let mut event_id = [0u8; 32];
        event_id[..16].copy_from_slice(Uuid::new_v4().as_bytes());
        event_id[16..].copy_from_slice(Uuid::new_v4().as_bytes());
        let tags = match d_tag {
            Some(d) => serde_json::json!([["d", d]]),
            None => serde_json::json!([]),
        };
        sqlx::query(
            "INSERT INTO events (community_id, id, pubkey, created_at, kind, tags, content, sig, d_tag)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
        )
        .bind(community_id)
        .bind(event_id.as_slice())
        .bind(author.as_slice())
        .bind(created_at)
        .bind(kind)
        .bind(tags)
        .bind(content.to_string())
        .bind([1u8; 64])
        .bind(d_tag)
        .execute(pool)
        .await
        .expect("insert org event");
    }

    async fn insert_relay_member(pool: &PgPool, community_id: Uuid, pubkey_hex: &str, role: &str) {
        sqlx::query(
            "INSERT INTO relay_members (community_id, pubkey, role, added_by)
             VALUES ($1, $2, $3, NULL)",
        )
        .bind(community_id)
        .bind(pubkey_hex)
        .bind(role)
        .execute(pool)
        .await
        .expect("insert relay member");
    }

    fn contribution_content(status: &str, dimensions: &[&str]) -> serde_json::Value {
        let dims: serde_json::Map<String, serde_json::Value> = dimensions
            .iter()
            .map(|d| ((*d).to_string(), serde_json::json!(1.0)))
            .collect();
        serde_json::json!({
            "v": 1,
            "action": "ship the thing",
            "dimensions": dims,
            "reviewStatus": status,
        })
    }

    /// Item 6: ~150 unrelated budgets must not hide the subject's budget —
    /// the old lookup read the 100 newest kind:37012 rows community-wide and
    /// filtered by subject in Rust, so junk silently disabled enforcement.
    #[tokio::test]
    #[ignore = "requires migrated Postgres"]
    async fn junk_budgets_do_not_hide_the_subjects_budget() {
        let pool = test_pool().await;
        let community = insert_test_community(&pool).await;
        let agent = "abababababababababababababababababababababababababababababababab";
        let junk_subject = "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd";

        // The subject's budget is the OLDEST row; 150 newer junk rows follow.
        let own_id = insert_budget_event(&pool, community, agent, "require-approval").await;
        for _ in 0..150 {
            insert_budget_event(&pool, community, junk_subject, "reject").await;
        }

        let db = Db::from_pool(pool.clone());
        let found = db
            .budget_enforcement_lookup(buzz_core::CommunityId::from_uuid(community), agent)
            .await
            .expect("lookup");
        assert_eq!(found.len(), 1, "exactly the subject's own budget");
        assert_eq!(found[0].event_id_hex, hex::encode(own_id));
        assert_eq!(
            found[0].author_hex,
            hex::encode([9u8; 32]),
            "the signer is returned so enforcement can tell authority from self"
        );

        cleanup(&pool, community).await;
    }

    /// Item 7: the default budget (`subject: "*"`) is found by its own
    /// lookup and is never returned as some agent's own budget.
    #[tokio::test]
    #[ignore = "requires migrated Postgres"]
    async fn default_budget_lookup_returns_only_star_budgets() {
        let pool = test_pool().await;
        let community = insert_test_community(&pool).await;
        let agent = "abababababababababababababababababababababababababababababababab";
        insert_budget_event(&pool, community, agent, "require-approval").await;
        let default_id = insert_budget_event(&pool, community, "*", "require-approval").await;

        let db = Db::from_pool(pool.clone());
        let cid = buzz_core::CommunityId::from_uuid(community);
        let defaults = db.default_budget_lookup(cid).await.expect("defaults");
        assert_eq!(defaults.len(), 1);
        assert_eq!(defaults[0].event_id_hex, hex::encode(default_id));
        let own = db.budget_enforcement_lookup(cid, agent).await.expect("own");
        assert_eq!(own.len(), 1, "the default never shows up as an own budget");
        assert_ne!(own[0].event_id_hex, defaults[0].event_id_hex);

        cleanup(&pool, community).await;
    }

    /// Item 9: the counter is one row per `(counter, window_start)`; the
    /// check must read exactly that row. A day counter that lives at a later
    /// `window_start` inside the same week must not inflate the week's
    /// check (the old `window_start >=` sum counted it, so two budgets on
    /// one counter over-counted N x).
    #[tokio::test]
    #[ignore = "requires migrated Postgres"]
    async fn check_reads_only_the_windows_own_counter_row() {
        let pool = test_pool().await;
        let community = insert_test_community(&pool).await;
        let db = Db::from_pool(pool.clone());
        let cid = buzz_core::CommunityId::from_uuid(community);
        let agent = "efefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefef";
        let week_start =
            chrono::DateTime::from_timestamp(1_700_000_000 - 1_700_000_000 % 604_800, 0)
                .expect("week start");
        let later_day = week_start + chrono::Duration::days(2);

        db.increment_budget_consumption(cid, agent, "runs", week_start, 2)
            .await
            .expect("week counter");
        db.increment_budget_consumption(cid, agent, "runs", later_day, 5)
            .await
            .expect("day counter inside the week");

        assert!(
            db.check_budget_consumption(cid, agent, "runs", week_start, 3)
                .await
                .expect("week check"),
            "week counter is 2 (< 3); the day row must not be summed into it"
        );
        assert!(
            !db.check_budget_consumption(cid, agent, "runs", later_day, 5)
                .await
                .expect("day check"),
            "the day counter is at its own limit"
        );

        cleanup(&pool, community).await;
    }

    /// Item 4: the ladder counts an action only through a review by an
    /// authorized human other than the contributor. A self-signed `accepted`
    /// must NOT raise the count; a reviewer-signed one must. Binds the
    /// production seam `Db::count_contribution_outcomes`.
    #[tokio::test]
    #[ignore = "requires migrated Postgres"]
    async fn self_attested_acceptance_never_counts_but_a_reviewers_does() {
        let pool = test_pool().await;
        let community = insert_test_community(&pool).await;
        let db = Db::from_pool(pool.clone());
        let cid = buzz_core::CommunityId::from_uuid(community);

        let agent = [0xa1u8; 32];
        let agent_hex = hex::encode(agent);
        let owner = [0xb2u8; 32];
        let outsider = [0xc3u8; 32];
        insert_relay_member(&pool, community, &hex::encode(owner), "owner").await;
        let window = chrono::Utc::now() - chrono::Duration::days(1);
        let t0 = chrono::Utc::now() - chrono::Duration::hours(2);

        // The agent files an action and grades it `accepted` itself.
        insert_org_event(
            &pool,
            community,
            37013,
            &agent,
            Some("act-1"),
            contribution_content("accepted", &["build"]),
            t0,
        )
        .await;
        let counts = db
            .count_contribution_outcomes(cid, &agent_hex, window, &[])
            .await
            .expect("count");
        assert_eq!(
            (counts.accepted, counts.rejected),
            (0, 0),
            "a self-signed `accepted` must not raise the count"
        );

        // A member with no authority also cannot accept it.
        insert_org_event(
            &pool,
            community,
            37013,
            &outsider,
            Some("act-1"),
            contribution_content("accepted", &["build"]),
            t0 + chrono::Duration::minutes(5),
        )
        .await;
        let counts = db
            .count_contribution_outcomes(cid, &agent_hex, window, &[])
            .await
            .expect("count");
        assert_eq!(
            (counts.accepted, counts.rejected),
            (0, 0),
            "an unauthorized reviewer's disposition is ignored"
        );

        // The owner accepts it under the owner's own key (NIP-ORG review).
        insert_org_event(
            &pool,
            community,
            37013,
            &owner,
            Some("act-1"),
            contribution_content("accepted", &["build"]),
            t0 + chrono::Duration::minutes(10),
        )
        .await;
        let counts = db
            .count_contribution_outcomes(cid, &agent_hex, window, &[])
            .await
            .expect("count");
        assert_eq!(
            (counts.accepted, counts.rejected),
            (1, 0),
            "a reviewer-signed `accepted` counts"
        );

        // Dimension filter applies to the canonical review.
        let with_dim = db
            .count_contribution_outcomes(cid, &agent_hex, window, &["build".to_string()])
            .await
            .expect("count build");
        assert_eq!(with_dim.accepted, 1);
        let other_dim = db
            .count_contribution_outcomes(cid, &agent_hex, window, &["care".to_string()])
            .await
            .expect("count care");
        assert_eq!(other_dim.accepted, 0);

        // A review outside the window does not count.
        let future_window = chrono::Utc::now() + chrono::Duration::hours(1);
        let empty = db
            .count_contribution_outcomes(cid, &agent_hex, future_window, &[])
            .await
            .expect("count future window");
        assert_eq!(empty.accepted, 0);

        // The owner later rejects a second action; the agent's own claim of
        // `accepted` on it is ignored and the rejection counts.
        insert_org_event(
            &pool,
            community,
            37013,
            &agent,
            Some("act-2"),
            contribution_content("accepted", &[]),
            t0,
        )
        .await;
        insert_org_event(
            &pool,
            community,
            37013,
            &owner,
            Some("act-2"),
            contribution_content("rejected", &[]),
            t0 + chrono::Duration::minutes(20),
        )
        .await;
        let counts = db
            .count_contribution_outcomes(cid, &agent_hex, window, &[])
            .await
            .expect("count");
        assert_eq!((counts.accepted, counts.rejected), (1, 1));

        cleanup(&pool, community).await;
    }

    /// An anchored human seat holder is a reviewer; an UNanchored one (a
    /// node the owner did not sanction) is not; an agent seat never is.
    #[tokio::test]
    #[ignore = "requires migrated Postgres"]
    async fn only_anchored_seat_holders_review() {
        let pool = test_pool().await;
        let community = insert_test_community(&pool).await;
        let db = Db::from_pool(pool.clone());
        let cid = buzz_core::CommunityId::from_uuid(community);

        let agent = [0xa1u8; 32];
        let agent_hex = hex::encode(agent);
        let owner = [0xb2u8; 32];
        let lead = [0xd4u8; 32];
        let mallory = [0xe5u8; 32];
        let seat_agent = [0xf6u8; 32];
        insert_relay_member(&pool, community, &hex::encode(owner), "owner").await;
        let window = chrono::Utc::now() - chrono::Duration::days(1);
        let t0 = chrono::Utc::now() - chrono::Duration::hours(3);
        let now = chrono::Utc::now() - chrono::Duration::hours(2);

        // Owner-authored root seats `lead` (human) and `seat_agent` (agent).
        insert_org_event(
            &pool,
            community,
            37010,
            &owner,
            Some("root"),
            serde_json::json!({
                "v": 1, "name": "Root", "kind": "role",
                "holders": [hex::encode(lead)],
                "agentSeats": [hex::encode(seat_agent)],
            }),
            t0,
        )
        .await;
        // Mallory self-seats a root of her own: not anchored.
        insert_org_event(
            &pool,
            community,
            37010,
            &mallory,
            Some("fake"),
            serde_json::json!({
                "v": 1, "name": "Fake", "kind": "role",
                "holders": [hex::encode(mallory)],
            }),
            t0,
        )
        .await;

        for (i, reviewer) in [lead, mallory, seat_agent].iter().enumerate() {
            let action = format!("act-{i}");
            insert_org_event(
                &pool,
                community,
                37013,
                &agent,
                Some(&action),
                contribution_content("pending", &[]),
                t0,
            )
            .await;
            insert_org_event(
                &pool,
                community,
                37013,
                reviewer,
                Some(&action),
                contribution_content("accepted", &[]),
                now,
            )
            .await;
        }
        let counts = db
            .count_contribution_outcomes(cid, &agent_hex, window, &[])
            .await
            .expect("count");
        assert_eq!(
            counts.accepted, 1,
            "only the anchored human holder's review (act-0) counts"
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
