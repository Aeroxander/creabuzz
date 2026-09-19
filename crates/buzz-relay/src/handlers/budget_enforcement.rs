//! NIP-ORG budget enforcement — relay-side ingest gate.
//!
//! Checks whether an agent's action exceeds any applicable budget limits
//! before the event is committed to the database, and consumes the matching
//! counter when the action is admitted (`runs` on the kind:44200 gate,
//! `tasks.create` on the kind:44011 gate — see [`enforce_counter`]).
//!
//! Contract (see `docs/nips/NIP-ORG.md`): a budget's JSON content keys are
//! camelCase — `{ subject, window, limits, onExceed }` — and a budget
//! applies to an agent when `content.subject` equals the agent's 64-hex
//! pubkey (case-insensitive).
//!
//! On exceed with `onExceed: "require-approval"` the relay records the
//! overrun durably (a `budget_approvals` row, written first) and then emits
//! a relay-signed kind:46010 notification best-effort; the row is the
//! recovery record if the notification is lost. The would-be action is
//! still rejected — approval is granted through a human decision, never by
//! re-submitting the same event.

use std::sync::Arc;

use buzz_core::tenant::TenantContext;
use chrono::Datelike;
use chrono::{DateTime, NaiveDate, Utc};
use nostr::{EventBuilder, Kind, Tag};
use uuid::Uuid;

use crate::handlers::ingest::IngestError;
use crate::state::AppState;

/// Budget window values accepted at kind:37012 ingest.
const VALID_WINDOWS: [&str; 4] = ["epoch", "day", "week", "month"];

/// Default lifetime of a budget approval request before it expires
/// unanswered (matches the workflow approval default in
/// `buzz-workflow`'s `suspend_run`).
const BUDGET_APPROVAL_TTL_SECS: i64 = 24 * 3600;

/// Compute the window start timestamp for a budget window type.
///
/// - `"day"` / `"week"` / `"month"` start at local-relay midnight of the
///   current day / Monday of the current ISO week / 1st of the current
///   month (UTC).
/// - `"epoch"` is the **all-time cumulative** counter: its window starts at
///   the Unix epoch and never resets. A budget that must expire needs an
///   explicit `expires` on the budget event itself, not this window.
///
/// Unknown window strings also map to the all-time epoch window here, but
/// they can only reach enforcement if they were stored before this
/// validation existed — kind:37012 ingest rejects unknown windows (see
/// [`validate_budget_publication`]).
pub(crate) fn budget_window_start(window: &str, now: DateTime<Utc>) -> DateTime<Utc> {
    match window {
        "day" => now
            .date_naive()
            .and_hms_opt(0, 0, 0)
            .map(|t| t.and_utc())
            .unwrap_or(now),
        "week" => {
            let days_since_monday = now.date_naive().weekday().num_days_from_monday() as i64;
            (now - chrono::Duration::days(days_since_monday))
                .date_naive()
                .and_hms_opt(0, 0, 0)
                .map(|t| t.and_utc())
                .unwrap_or(now)
        }
        "month" => NaiveDate::from_ymd_opt(now.year(), now.month(), 1)
            .and_then(|d| d.and_hms_opt(0, 0, 0))
            .map(|t| t.and_utc())
            .unwrap_or(now),
        // "epoch" and any unknown legacy value: all-time cumulative.
        _ => DateTime::UNIX_EPOCH,
    }
}

/// Validate the budget-specific content of a kind:37012 event.
///
/// Beyond the shared org envelope (JSON object, bounded `d`), a budget must
/// carry:
/// - `subject`: a 64-hex pubkey (case-insensitive) — the agent the budget
///   applies to. A budget without a resolvable subject could never apply,
///   so it is rejected rather than stored dead.
/// - `window`: one of `"epoch" | "day" | "week" | "month"`. Unknown values
///   are rejected so they can no longer silently degrade to the all-time
///   epoch window.
///
/// Returns the rejection message on failure.
pub(crate) fn budget_content_error(content: &serde_json::Value) -> Option<String> {
    let subject = content.get("subject").and_then(|s| s.as_str());
    let Some(subject) = subject else {
        return Some("org budget content must carry a `subject` (64-hex agent pubkey)".into());
    };
    let is_hex = subject.len() == 64 && subject.bytes().all(|b| b.is_ascii_hexdigit());
    if !is_hex {
        return Some("org budget content `subject` must be a 64-hex agent pubkey".into());
    }

    let window = content.get("window").and_then(|w| w.as_str());
    match window {
        Some(w) if VALID_WINDOWS.contains(&w) => {}
        Some(other) => {
            return Some(format!(
                "org budget content `window` must be one of {VALID_WINDOWS:?} (got \"{other}\")"
            ));
        }
        None => {
            return Some(
                "org budget content must carry a `window` (epoch | day | week | month)".into(),
            );
        }
    }

    None
}

/// Decision core of the budget publication rule.
///
/// A budget capping an agent may only be published by:
/// (a) the agent itself (`content.subject` equals the author), or
/// (b) the community owner (relay-member role `"owner"`).
///
/// Any other MessagesWrite member could otherwise cap any agent's autonomy
/// (a griefing vector: a peer budget of `runs: 0` would freeze an agent).
/// Returns the rejection message when publication is not allowed.
pub(crate) fn budget_author_error(
    author_hex: &str,
    subject: &str,
    author_role: Option<&str>,
) -> Option<String> {
    if author_hex.eq_ignore_ascii_case(subject) {
        return None;
    }
    if author_role == Some("owner") {
        return None;
    }
    Some(
        "restricted: a budget may only be published by its subject agent or the community owner"
            .into(),
    )
}

/// Validate a kind:37012 budget event at ingest: content contract plus the
/// publication-authority rule (subject itself or community owner).
pub(crate) async fn validate_budget_publication(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    event: &nostr::Event,
) -> Result<(), IngestError> {
    let content: serde_json::Value = serde_json::from_str(&event.content).map_err(|e| {
        IngestError::Rejected(format!(
            "invalid: org budget content must be valid JSON: {e}"
        ))
    })?;

    if let Some(msg) = budget_content_error(&content) {
        return Err(IngestError::Rejected(format!("invalid: {msg}")));
    }

    let subject = content
        .get("subject")
        .and_then(|s| s.as_str())
        .unwrap_or_default();
    let author_hex = event.pubkey.to_hex();
    if !author_hex.eq_ignore_ascii_case(subject) {
        let author_role = state
            .db
            .get_relay_member(tenant.community(), &author_hex)
            .await
            .map_err(|e| {
                IngestError::Internal(format!("error: db error checking budget author: {e}"))
            })?
            .map(|m| m.role);
        if let Some(msg) = budget_author_error(&author_hex, subject, author_role.as_deref()) {
            return Err(IngestError::Rejected(msg));
        }
    }

    Ok(())
}

/// One applicable budget limit resolved for enforcement.
struct ApplicableLimit {
    budget_event_id_hex: String,
    on_exceed: String,
    window: String,
    limit: i64,
    window_start: DateTime<Utc>,
}

/// Check whether an agent's action exceeds any applicable budget limits.
///
/// Looks up budget events (kind:37012) whose `content.subject` matches the
/// agent's hex pubkey, then checks the relevant counter against the limit.
///
/// Counter types: `"runs"` for agent turn metrics (kind:44200),
/// `"task_create"`/`"task_approve"` for agent task counters (kind:44011 —
/// see the TODO on the kind-44200 wiring in `ingest.rs` for why the task
/// counters are not yet enforced).
#[allow(dead_code)]
pub(crate) async fn check_agent_budget(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    agent_pubkey_hex: &str,
    counter_type: &str,
) -> Result<(), IngestError> {
    let budgets = applicable_limits(state, tenant, agent_pubkey_hex, counter_type).await?;
    for budget in budgets {
        let effective_limit =
            effective_limit(&state.db, tenant, agent_pubkey_hex, counter_type, &budget).await?;
        let within = state
            .db
            .check_budget_consumption(
                tenant.community(),
                agent_pubkey_hex,
                counter_type,
                budget.window_start,
                effective_limit,
            )
            .await
            .map_err(|e| IngestError::Internal(format!("error: db error checking budget: {e}")))?;
        if !within {
            return Err(
                exceeded_error(state, tenant, agent_pubkey_hex, counter_type, &budget).await,
            );
        }
    }
    Ok(())
}

/// Outcome of one budget's check-and-consume pass.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RunBudgetOutcome {
    /// The action is within the (effective) limit and its consumption was
    /// recorded.
    Admitted,
    /// The counter is at or past the effective limit (including the
    /// post-increment race check). The caller routes this through the
    /// exceed path, which records the durable approval request.
    Exceeded,
}

/// Effective limit for one budget: the published limit plus one unit of
/// tolerance per granted budget approval.
///
/// Grant semantics ("this overrun is forgiven once"): a granted approval
/// never rolls the counter back. Each grant raises the effective limit by
/// exactly one unit, so a granted subject may act again until the counter
/// reaches the limit once more; the next overrun then raises a fresh
/// request. Tolerances are scoped to the granted window, counter, and
/// budget event (see [`buzz_db::budget::count_granted_budget_tolerances`]).
async fn effective_limit(
    db: &buzz_db::Db,
    tenant: &TenantContext,
    agent_pubkey_hex: &str,
    counter_type: &str,
    budget: &ApplicableLimit,
) -> Result<i64, IngestError> {
    let granted = db
        .count_granted_budget_tolerances(
            tenant.community(),
            agent_pubkey_hex,
            counter_type,
            budget.window_start,
            Some(&budget.budget_event_id_hex),
        )
        .await
        .map_err(|e| {
            IngestError::Internal(format!("error: db error checking budget grants: {e}"))
        })?;
    Ok(budget.limit.saturating_add(granted))
}

/// Enforce the agent's run budget and consume one run.
///
/// The full kind:44200 gate: check every applicable budget's `runs` limit,
/// and when all pass, immediately increment the `runs` counter for each of
/// them in the current window. The increment is a same-call durable write
/// whose failure fails the ingest (never a fire-and-forget log). The relay
/// store does not expose a transaction spanning event insert and counter
/// write, so the counter is consumed before the event is stored — a later
/// storage failure then over-counts one run, which fails closed (an agent
/// is budget-limited sooner, never later).
pub(crate) async fn enforce_run_budget(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    agent_pubkey_hex: &str,
) -> Result<(), IngestError> {
    enforce_counter(state, tenant, agent_pubkey_hex, "runs").await
}

/// Enforce every applicable budget's `counter_type` limit for the agent,
/// consuming one unit of each when within the (effective) limit.
///
/// The counter_type-parameterized form of [`enforce_run_budget`] — the
/// kind:44200 gate enforces `"runs"`, the kind:44011 gate enforces
/// `"task_create"`/`"task_approve"`. The exceed path (durable approval
/// row + best-effort kind:46010) is identical for every counter.
pub(crate) async fn enforce_counter(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    agent_pubkey_hex: &str,
    counter_type: &str,
) -> Result<(), IngestError> {
    let budgets = applicable_limits(state, tenant, agent_pubkey_hex, counter_type).await?;
    for budget in budgets {
        match enforce_one_counter(&state.db, tenant, agent_pubkey_hex, counter_type, &budget)
            .await?
        {
            RunBudgetOutcome::Admitted => {}
            RunBudgetOutcome::Exceeded => {
                return Err(
                    exceeded_error(state, tenant, agent_pubkey_hex, counter_type, &budget).await,
                );
            }
        }
    }
    Ok(())
}

/// Check and consume one budget's `runs` limit for the agent.
///
/// The decision core of [`enforce_run_budget`], split out so tests can
/// drive the real check/tolerance/increment seam with a bare `Db` (the
/// exceed path needs the full app state to emit the kind:46010
/// notification and is exercised end-to-end elsewhere). The increment is
/// a same-call durable write whose failure fails the ingest — see the
/// atomicity note on [`enforce_run_budget`].
async fn enforce_one_counter(
    db: &buzz_db::Db,
    tenant: &TenantContext,
    agent_pubkey_hex: &str,
    counter_type: &str,
    budget: &ApplicableLimit,
) -> Result<RunBudgetOutcome, IngestError> {
    let limit = effective_limit(db, tenant, agent_pubkey_hex, counter_type, budget).await?;

    let within = db
        .check_budget_consumption(
            tenant.community(),
            agent_pubkey_hex,
            counter_type,
            budget.window_start,
            limit,
        )
        .await
        .map_err(|e| IngestError::Internal(format!("error: db error checking budget: {e}")))?;
    if !within {
        return Ok(RunBudgetOutcome::Exceeded);
    }

    let consumed = db
        .increment_budget_consumption(
            tenant.community(),
            agent_pubkey_hex,
            counter_type,
            budget.window_start,
            1,
        )
        .await
        .map_err(|e| {
            IngestError::Internal(format!("error: could not record budget consumption: {e}"))
        })?;
    if consumed > limit {
        // A concurrent ingest raced past the check. The counter already
        // stands (conservative); route through the same exceed path.
        return Ok(RunBudgetOutcome::Exceeded);
    }
    Ok(RunBudgetOutcome::Admitted)
}

/// `"runs"` delegator over [`enforce_one_counter`] — the seam the
/// budget-enforcement postgres tests drive (production callers go through
/// [`enforce_run_budget`] → [`enforce_counter`]).
#[cfg_attr(not(test), allow(dead_code))]
async fn enforce_one_run_budget(
    db: &buzz_db::Db,
    tenant: &TenantContext,
    agent_pubkey_hex: &str,
    budget: &ApplicableLimit,
) -> Result<RunBudgetOutcome, IngestError> {
    enforce_one_counter(db, tenant, agent_pubkey_hex, "runs", budget).await
}

/// Resolve the budgets that actually bound `counter_type` for this agent.
async fn applicable_limits(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    agent_pubkey_hex: &str,
    counter_type: &str,
) -> Result<Vec<ApplicableLimit>, IngestError> {
    let community_id = tenant.community();

    let budgets = state
        .db
        .budget_enforcement_lookup(community_id, agent_pubkey_hex)
        .await
        .map_err(|e| IngestError::Internal(format!("error: db error querying budgets: {e}")))?;

    let mut applicable = Vec::new();
    for budget_event in budgets {
        let content: serde_json::Value = serde_json::from_str(&budget_event.content)
            .map_err(|e| IngestError::Internal(format!("error: malformed budget content: {e}")))?;

        // Missing/unknown window falls back to the all-time epoch window;
        // ingest validation keeps unknown values out of new budgets.
        let window = content
            .get("window")
            .and_then(|w| w.as_str())
            .unwrap_or("epoch");

        let Some(limits) = content.get("limits") else {
            continue;
        };

        let limit_value = match counter_type {
            "runs" => limits.get("runs").and_then(|r| r.as_i64()),
            "task_create" => limits
                .get("tasks")
                .and_then(|t| t.get("create"))
                .and_then(|c| c.as_i64()),
            "task_approve" => limits
                .get("tasks")
                .and_then(|t| t.get("approve"))
                .and_then(|a| a.as_i64()),
            _ => None,
        };

        let Some(limit) = limit_value else {
            continue;
        };

        applicable.push(ApplicableLimit {
            budget_event_id_hex: budget_event.event_id_hex,
            on_exceed: budget_event.on_exceed,
            window: window.to_string(),
            limit,
            window_start: budget_window_start(window, Utc::now()),
        });
    }
    Ok(applicable)
}

/// Build the rejection for an exceeded budget, creating the durable
/// approval request when `onExceed` routes to `"require-approval"`.
///
/// Resolution of the recorded request happens through the existing
/// approval command path (kinds 46030/46031 in `command_executor`): a
/// grant forgives one overrun (see [`effective_limit`]); a denial records
/// the refusal and the next overrun raises a fresh request. The
/// notification's `d` token stays resolvable after either resolution is
/// rejected as "already acted on".
///
/// Persistence is the contract: the `budget_approvals` row is written
/// first; the kind:46010 notification is emitted best-effort with the row
/// as the recovery record. A hard budget (`"reject"`) or a failed row
/// write rejects without a request — a failed write propagates as
/// `Internal` so the caller never mistakes the gate for a client error.
async fn exceeded_error(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    agent_pubkey_hex: &str,
    counter_type: &str,
    budget: &ApplicableLimit,
) -> IngestError {
    let message = format!(
        "budget exceeded: {counter_type} limit {} reached",
        budget.limit
    );

    if budget.on_exceed == "reject" {
        return IngestError::Rejected(message);
    }

    // Durable approval request first — the recovery record. At most one
    // pending request per (subject, counter, window) exists: repeats refresh
    // it and reuse the stored token so the notification stays resolvable.
    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let fresh_token_hash = buzz_db::workflow::approval_token_hash_hex(&token);
    let fresh_token_bytes = hex::decode(&fresh_token_hash).unwrap_or_default();
    let expires_at = Utc::now() + chrono::Duration::seconds(BUDGET_APPROVAL_TTL_SECS);

    let stored_token_hash = match state
        .db
        .create_budget_approval(
            tenant.community(),
            buzz_db::budget::CreateBudgetApprovalParams {
                subject: agent_pubkey_hex,
                counter_type,
                window_start: budget.window_start,
                limit_value: budget.limit,
                budget_event_id: Some(&budget.budget_event_id_hex),
                token_hash: &fresh_token_bytes,
                expires_at,
            },
        )
        .await
    {
        Ok(stored) => stored,
        Err(e) => {
            return IngestError::Internal(format!(
                "error: could not record budget approval request: {e}"
            ));
        }
    };
    let token_hash_hex = hex::encode(&stored_token_hash);

    // Best-effort kind:46010 notification. The row above is the durable
    // retry record; a lost notification must not fail the gate.
    if let Err(e) = emit_budget_approval_event(
        state,
        tenant,
        agent_pubkey_hex,
        counter_type,
        &budget.window,
        budget.limit,
        &token_hash_hex,
    )
    .await
    {
        tracing::error!(
            subject = %agent_pubkey_hex,
            counter_type,
            "Budget approval persisted but kind:46010 emission failed: {e}"
        );
    }

    IngestError::Rejected(format!(
        "{message} — a budget approval request was recorded; it must be granted before this action can proceed"
    ))
}

/// Emit a relay-signed kind:46010 budget approval notification as a
/// channel-less global event (`d` carries the token hash, `p` the budgeted
/// agent) and dispatch fan-out best-effort.
async fn emit_budget_approval_event(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    subject_hex: &str,
    counter_type: &str,
    window: &str,
    limit: i64,
    token_hash_hex: &str,
) -> Result<(), String> {
    let content = serde_json::json!({
        "type": "budget-exceeded",
        "subject": subject_hex,
        "counterType": counter_type,
        "window": window,
        "limit": limit,
    })
    .to_string();

    let tags = vec![
        Tag::parse(["d", token_hash_hex]).map_err(|e| format!("d tag: {e}"))?,
        Tag::parse(["p", subject_hex]).map_err(|e| format!("p tag: {e}"))?,
    ];

    let kind = Kind::from(buzz_core::kind::KIND_WORKFLOW_APPROVAL_REQUESTED as u16);
    let event = EventBuilder::new(kind, &content)
        .tags(tags)
        .sign_with_keys(&state.relay_keypair)
        .map_err(|e| format!("signing: {e}"))?;

    // Store with channel_id = None → globally scoped, reachable by global
    // subscribers (same shape as relay-signed membership notifications).
    let (stored_event, was_inserted) = state
        .db
        .insert_event(tenant.community(), &event, None)
        .await
        .map_err(|e| format!("persist: {e}"))?;

    if was_inserted {
        crate::handlers::event::dispatch_persistent_event(
            tenant,
            state,
            &stored_event,
            buzz_core::kind::KIND_WORKFLOW_APPROVAL_REQUESTED,
            &state.relay_keypair.public_key().to_hex(),
            None,
        )
        .await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn fixed_now() -> DateTime<Utc> {
        // Wednesday 2026-09-16 15:42:07 UTC
        Utc.with_ymd_and_hms(2026, 9, 16, 15, 42, 7).unwrap()
    }

    #[test]
    fn day_window_starts_at_utc_midnight() {
        assert_eq!(
            budget_window_start("day", fixed_now()),
            Utc.with_ymd_and_hms(2026, 9, 16, 0, 0, 0).unwrap()
        );
    }

    #[test]
    fn week_window_starts_monday() {
        // 2026-09-16 is a Wednesday; Monday is 2026-09-14.
        assert_eq!(
            budget_window_start("week", fixed_now()),
            Utc.with_ymd_and_hms(2026, 9, 14, 0, 0, 0).unwrap()
        );
    }

    #[test]
    fn month_window_starts_on_the_first() {
        assert_eq!(
            budget_window_start("month", fixed_now()),
            Utc.with_ymd_and_hms(2026, 9, 1, 0, 0, 0).unwrap()
        );
    }

    #[test]
    fn epoch_window_is_all_time_cumulative() {
        assert_eq!(
            budget_window_start("epoch", fixed_now()),
            DateTime::UNIX_EPOCH
        );
    }

    #[test]
    fn unknown_window_falls_back_to_epoch_in_enforcement() {
        // Only reachable for pre-validation stored budgets; must not panic
        // and must not reset.
        assert_eq!(
            budget_window_start("fortnight", fixed_now()),
            DateTime::UNIX_EPOCH
        );
    }

    fn budget_json(json: &str) -> serde_json::Value {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn budget_content_accepts_valid_budget() {
        let content = budget_json(
            r#"{"subject": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "window": "day",
                "limits": {"runs": 50},
                "onExceed": "require-approval"}"#,
        );
        assert_eq!(budget_content_error(&content), None);
    }

    #[test]
    fn budget_content_rejects_unknown_window() {
        let content = budget_json(
            r#"{"subject": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "window": "fortnight",
                "limits": {"runs": 50}}"#,
        );
        let msg = budget_content_error(&content).expect("unknown window must be rejected");
        assert!(msg.contains("`window` must be one of"), "got: {msg}");
        assert!(msg.contains("fortnight"), "message names the value: {msg}");
    }

    #[test]
    fn budget_content_rejects_missing_window_and_subject() {
        let no_window = budget_json(
            r#"{"subject": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "limits": {"runs": 50}}"#,
        );
        assert!(budget_content_error(&no_window).is_some());

        let no_subject = budget_json(r#"{"window": "day", "limits": {"runs": 50}}"#);
        let msg = budget_content_error(&no_subject).expect("missing subject must be rejected");
        assert!(msg.contains("subject"), "got: {msg}");
    }

    #[test]
    fn budget_content_rejects_malformed_subject() {
        let content = budget_json(r#"{"subject": "xyz", "window": "day"}"#);
        let msg = budget_content_error(&content).expect("bad subject must be rejected");
        assert!(msg.contains("64-hex"), "got: {msg}");
    }

    const AGENT: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const OTHER: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    #[test]
    fn budget_author_may_publish_own_budget() {
        assert_eq!(budget_author_error(AGENT, AGENT, None), None);
        // Case-insensitive hex comparison.
        let upper_agent = AGENT.to_ascii_uppercase();
        assert_eq!(budget_author_error(&upper_agent, AGENT, None), None);
    }

    #[test]
    fn community_owner_may_publish_any_budget() {
        assert_eq!(budget_author_error(OTHER, AGENT, Some("owner")), None);
    }

    #[test]
    fn plain_member_and_outsider_may_not_publish_someone_elses_budget() {
        let msg = budget_author_error(OTHER, AGENT, Some("member"))
            .expect("member capping another agent must be rejected");
        assert!(msg.contains("restricted:"), "got: {msg}");

        let msg = budget_author_error(OTHER, AGENT, None)
            .expect("non-member capping an agent must be rejected");
        assert!(msg.contains("restricted:"), "got: {msg}");
    }

    #[test]
    fn admin_role_is_not_owner_authority_for_budgets() {
        // The minimal rule is subject-or-owner; admins intentionally do not
        // gain budget authority.
        assert!(budget_author_error(OTHER, AGENT, Some("admin")).is_some());
    }

    // -- Postgres tests: drive the real check/tolerance/increment seam ----

    async fn pg_pool() -> (sqlx::PgPool, uuid::Uuid) {
        let database_url = std::env::var("BUZZ_TEST_DATABASE_URL")
            .or_else(|_| std::env::var("DATABASE_URL"))
            .unwrap_or_else(|_| "postgres://buzz:buzz_dev@localhost:5432/buzz".to_string()); // sadscan:disable np.postgres.1 -- local test-only credentials
        let pool = sqlx::PgPool::connect(&database_url)
            .await
            .expect("connect budget enforcement test database");
        let db = buzz_db::Db::from_pool(pool.clone());
        db.migrate().await.expect("migrate test database");
        let id = uuid::Uuid::new_v4();
        sqlx::query("INSERT INTO communities (id, host) VALUES ($1, $2)")
            .bind(id)
            .bind(format!("budget-enf-{id}.test"))
            .execute(&pool)
            .await
            .expect("insert community");
        (pool, id)
    }

    async fn pg_cleanup(pool: &sqlx::PgPool, community: uuid::Uuid) {
        // Emitted kind:46010 notifications carry a `p` tag, which lands in
        // event_mentions; clear it before the events rows it references.
        // Async dispatch side effects (audit rows) can land after the test
        // body finished, so clear those stragglers here too.
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
        sqlx::query("DELETE FROM budget_consumption WHERE community_id = $1")
            .bind(community)
            .execute(pool)
            .await
            .expect("delete consumption");
        sqlx::query("DELETE FROM budget_approvals WHERE community_id = $1")
            .bind(community)
            .execute(pool)
            .await
            .expect("delete approvals");
        sqlx::query("DELETE FROM communities WHERE id = $1")
            .bind(community)
            .execute(pool)
            .await
            .expect("delete community");
    }

    fn run_budget(limit: i64) -> ApplicableLimit {
        ApplicableLimit {
            budget_event_id_hex: "evt-tol".into(),
            on_exceed: "require-approval".into(),
            window: "day".into(),
            limit,
            window_start: Utc::now(),
        }
    }

    /// Drives the production check/tolerance/increment seam
    /// (`enforce_one_run_budget`) against Postgres: a limit-2 budget
    /// admits two runs and blocks the third; granting the recorded
    /// request forgives exactly ONE more run (counters are not rolled
    /// back), after which the budget blocks again. A denied request lifts
    /// nothing.
    #[tokio::test]
    #[ignore = "requires migrated Postgres"]
    async fn grant_forgives_exactly_one_overrun() {
        let (pool, community) = pg_pool().await;
        let db = buzz_db::Db::from_pool(pool.clone());
        let tenant = TenantContext::resolved(
            buzz_core::CommunityId::from_uuid(community),
            format!("budget-enf-{community}.test"),
        );
        let agent = "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd";
        let budget = run_budget(2);

        // Two runs admitted, the third exceeds.
        assert_eq!(
            enforce_one_run_budget(&db, &tenant, agent, &budget)
                .await
                .expect("first run"),
            RunBudgetOutcome::Admitted
        );
        assert_eq!(
            enforce_one_run_budget(&db, &tenant, agent, &budget)
                .await
                .expect("second run"),
            RunBudgetOutcome::Admitted
        );
        assert_eq!(
            enforce_one_run_budget(&db, &tenant, agent, &budget)
                .await
                .expect("third run"),
            RunBudgetOutcome::Exceeded,
            "limit-2 budget must block the third run"
        );

        // Record the overrun request (the exceed path does this) and grant
        // it through the production resolution write.
        let token_hash = [0x5au8; 32];
        db.create_budget_approval(
            tenant.community(),
            buzz_db::budget::CreateBudgetApprovalParams {
                subject: agent,
                counter_type: "runs",
                window_start: budget.window_start,
                limit_value: budget.limit,
                budget_event_id: Some(&budget.budget_event_id_hex),
                token_hash: &token_hash,
                expires_at: Utc::now() + chrono::Duration::seconds(3600),
            },
        )
        .await
        .expect("record overrun request");
        assert!(
            db.resolve_budget_approval(
                tenant.community(),
                &token_hash,
                buzz_db::budget::BudgetApprovalDecision::Granted,
                Some(&[1u8; 32]),
                None,
            )
            .await
            .expect("grant"),
            "grant wins the pending row"
        );

        // The grant forgives exactly one overrun: the next run is admitted
        // (counter reaches the effective limit), then blocked again.
        assert_eq!(
            enforce_one_run_budget(&db, &tenant, agent, &budget)
                .await
                .expect("run after grant"),
            RunBudgetOutcome::Admitted,
            "granted tolerance must admit one more run"
        );
        assert_eq!(
            enforce_one_run_budget(&db, &tenant, agent, &budget)
                .await
                .expect("run after tolerance spent"),
            RunBudgetOutcome::Exceeded,
            "one grant forgives one overrun, no more"
        );

        // A denied request lifts nothing.
        let denied_hash = [0x5bu8; 32];
        db.create_budget_approval(
            tenant.community(),
            buzz_db::budget::CreateBudgetApprovalParams {
                subject: agent,
                counter_type: "runs",
                window_start: budget.window_start,
                limit_value: budget.limit,
                budget_event_id: Some(&budget.budget_event_id_hex),
                token_hash: &denied_hash,
                expires_at: Utc::now() + chrono::Duration::seconds(3600),
            },
        )
        .await
        .expect("record second overrun request");
        db.resolve_budget_approval(
            tenant.community(),
            &denied_hash,
            buzz_db::budget::BudgetApprovalDecision::Denied,
            Some(&[1u8; 32]),
            None,
        )
        .await
        .expect("deny");
        assert_eq!(
            enforce_one_run_budget(&db, &tenant, agent, &budget)
                .await
                .expect("run after denial"),
            RunBudgetOutcome::Exceeded,
            "a denied request must not lift the limit"
        );

        pg_cleanup(&pool, community).await;
    }

    // -- task_create (kind:44011) enforcement tests ---------------------------
    //
    // The kind:44011 ingest branch in `ingest.rs` drives the same production
    // gate as the runs path, parameterized with counter_type `task_create`.

    /// Insert a kind:37012 budget event row so `applicable_limits` can
    /// resolve it from the real events table.
    async fn pg_insert_budget_event(
        pool: &sqlx::PgPool,
        community: uuid::Uuid,
        content: serde_json::Value,
    ) {
        let mut event_id = [0u8; 32];
        event_id[..16].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
        event_id[16..].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
        sqlx::query(
            "INSERT INTO events (community_id, id, pubkey, created_at, kind, tags, content, sig)
             VALUES ($1, $2, $3, now(), 37012, '[]'::jsonb, $4, $5)",
        )
        .bind(community)
        .bind(event_id.as_slice())
        .bind([8u8; 32])
        .bind(content.to_string())
        .bind([2u8; 64])
        .execute(pool)
        .await
        .expect("insert budget event");
    }

    /// Budget content with a `tasks.create` limit only (camelCase keys per
    /// NIP-ORG) — the shape a kind:44011 gate must bind.
    fn task_budget_content(subject: &str, create_limit: i64, on_exceed: &str) -> serde_json::Value {
        serde_json::json!({
            "v": 1,
            "subject": subject,
            "window": "day",
            "limits": { "tasks": { "create": create_limit } },
            "onExceed": on_exceed,
        })
    }

    fn task_budget(limit: i64) -> ApplicableLimit {
        ApplicableLimit {
            budget_event_id_hex: "evt-task-tol".into(),
            on_exceed: "require-approval".into(),
            window: "day".into(),
            limit,
            window_start: Utc::now(),
        }
    }

    /// Build a real `AppState` on the test pool so tests can drive the full
    /// production gate (`enforce_counter`, including the exceed path's
    /// durable row + kind:46010 emission). Same recipe as the invite
    /// tests' `invite_test_state`; `None` means the host environment cannot
    /// produce a relay config and the caller skips (reported, not silent).
    async fn pg_app_state(pool: &sqlx::PgPool) -> Option<Arc<crate::state::AppState>> {
        let database_url = std::env::var("BUZZ_TEST_DATABASE_URL")
            .or_else(|_| std::env::var("DATABASE_URL"))
            .unwrap_or_else(|_| "postgres://buzz:buzz_dev@localhost:5432/buzz".to_string()); // sadscan:disable np.postgres.1 -- local test-only credentials
        let mut config = crate::config::Config::from_env().ok()?;
        config.database_url = database_url;
        config.redis_url = "redis://127.0.0.1:1".to_string();
        config.relay_url = "wss://budget-enforcement.test".to_string();

        let redis_pool = deadpool_redis::Config::from_url(&config.redis_url)
            .create_pool(Some(deadpool_redis::Runtime::Tokio1))
            .ok()?;
        let pubsub = Arc::new(
            buzz_pubsub::PubSubManager::new(&config.redis_url, redis_pool.clone())
                .await
                .ok()?,
        );
        // No audit service: the exceed path's best-effort dispatch would
        // otherwise race the cleanup with async audit_log writes. Budget
        // enforcement does not read audit_log, so tests run audit-free.
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

    /// Binds the production kind:44011 gate (`enforce_counter` with
    /// counter_type `task_create`) against Postgres: under the limit the
    /// action is admitted and consumed under the `task_create` counter; at
    /// the limit with `onExceed: "reject"` the gate rejects hard and
    /// persists NO approval row. Also pins counter isolation: a
    /// tasks-only budget must not bind the `runs` counter.
    #[tokio::test]
    #[ignore = "requires migrated Postgres"]
    async fn task_create_counter_increments_then_hard_rejects() {
        let (pool, community) = pg_pool().await;
        let tenant = TenantContext::resolved(
            buzz_core::CommunityId::from_uuid(community),
            format!("budget-enf-{community}.test"),
        );
        let agent = "e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1";
        pg_insert_budget_event(&pool, community, task_budget_content(agent, 1, "reject")).await;
        let Some(state) = pg_app_state(&pool).await else {
            pg_cleanup(&pool, community).await;
            eprintln!("skipping: could not build AppState (config/media unavailable)");
            return;
        };

        // Under the limit: admitted, consumed under the `task_create` counter.
        enforce_counter(&state, &tenant, agent, "task_create")
            .await
            .expect("first task creation within limit");
        let consumed: i64 = sqlx::query_scalar(
            "SELECT consumed FROM budget_consumption
             WHERE community_id = $1 AND subject = $2 AND counter_type = 'task_create'",
        )
        .bind(community)
        .bind(agent)
        .fetch_one(&pool)
        .await
        .expect("task_create consumption row");
        assert_eq!(consumed, 1, "pass must increment the task_create counter");

        // At the limit with onExceed "reject": hard reject, no approval row.
        let err = enforce_counter(&state, &tenant, agent, "task_create")
            .await
            .expect_err("second task creation must exceed the create limit");
        match err {
            IngestError::Rejected(msg) => assert!(
                msg.contains("budget exceeded: task_create limit 1"),
                "unexpected rejection: {msg}"
            ),
            other => panic!("expected Rejected, got {other:?}"),
        }
        let approvals: i64 =
            sqlx::query_scalar("SELECT count(*) FROM budget_approvals WHERE community_id = $1")
                .bind(community)
                .fetch_one(&pool)
                .await
                .expect("approval count");
        assert_eq!(approvals, 0, "hard reject must not persist an approval row");

        // Counter isolation: a tasks-only budget does not bind `runs`.
        enforce_counter(&state, &tenant, agent, "runs")
            .await
            .expect("tasks-only budget must not bind the runs counter");

        pg_cleanup(&pool, community).await;
    }

    /// Binds the require-approval branch of the production kind:44011 gate:
    /// exceeding `tasks.create` persists a pending `budget_approvals` row
    /// with counter_type `task_create` (the durable recovery record) plus a
    /// stored relay-signed kind:46010 notification, and a repeated overrun
    /// refreshes the single pending row instead of growing it.
    #[tokio::test]
    #[ignore = "requires migrated Postgres"]
    async fn task_create_exceed_persists_approval_row() {
        let (pool, community) = pg_pool().await;
        let tenant = TenantContext::resolved(
            buzz_core::CommunityId::from_uuid(community),
            format!("budget-enf-{community}.test"),
        );
        let agent = "e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2";
        pg_insert_budget_event(
            &pool,
            community,
            task_budget_content(agent, 0, "require-approval"),
        )
        .await;
        let Some(state) = pg_app_state(&pool).await else {
            pg_cleanup(&pool, community).await;
            eprintln!("skipping: could not build AppState (config/media unavailable)");
            return;
        };

        // Limit 0 (no granted tolerances) exceeds on the first task.
        let err = enforce_counter(&state, &tenant, agent, "task_create")
            .await
            .expect_err("limit-0 budget must exceed on the first task");
        match err {
            IngestError::Rejected(msg) => assert!(
                msg.contains("budget approval request was recorded"),
                "require-approval must record a request, got: {msg}"
            ),
            other => panic!("expected Rejected, got {other:?}"),
        }

        // The durable row: pending, task_create-typed, current day window.
        let (counter_type, status, limit_value, window_start): (
            String,
            String,
            i64,
            DateTime<Utc>,
        ) = sqlx::query_as(
            "SELECT counter_type, status::text, limit_value, window_start
                 FROM budget_approvals WHERE community_id = $1 AND subject = $2",
        )
        .bind(community)
        .bind(agent)
        .fetch_one(&pool)
        .await
        .expect("durable approval row");
        assert_eq!(counter_type, "task_create");
        assert_eq!(status, "pending");
        assert_eq!(limit_value, 0);
        assert_eq!(
            window_start,
            budget_window_start("day", Utc::now()),
            "row must carry the current day window"
        );

        // The recovery notification reached the events table.
        let notifications: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM events
             WHERE community_id = $1 AND kind = 46010 AND content LIKE '%task_create%'",
        )
        .bind(community)
        .fetch_one(&pool)
        .await
        .expect("46010 lookup");
        assert!(
            notifications >= 1,
            "kind:46010 notification must be stored alongside the row"
        );

        // A repeat overrun refreshes the single pending request.
        assert!(
            enforce_counter(&state, &tenant, agent, "task_create")
                .await
                .is_err(),
            "repeat overrun must still be rejected"
        );
        let pending: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM budget_approvals
             WHERE community_id = $1 AND subject = $2 AND status = 'pending'",
        )
        .bind(community)
        .bind(agent)
        .fetch_one(&pool)
        .await
        .expect("pending count");
        assert_eq!(
            pending, 1,
            "repeats must refresh the single pending request, not grow the table"
        );

        pg_cleanup(&pool, community).await;
    }

    /// `grant_forgives_exactly_one_overrun` pins the tolerance semantics for
    /// `runs`; this pins the same for the `task_create` counter the
    /// kind:44011 gate consumes: a granted approval raises the effective
    /// limit by exactly one, then the budget blocks again.
    #[tokio::test]
    #[ignore = "requires migrated Postgres"]
    async fn grant_tolerance_lifts_task_create_limit_by_one() {
        let (pool, community) = pg_pool().await;
        let db = buzz_db::Db::from_pool(pool.clone());
        let tenant = TenantContext::resolved(
            buzz_core::CommunityId::from_uuid(community),
            format!("budget-enf-{community}.test"),
        );
        let agent = "e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3";
        let budget = task_budget(1);

        assert_eq!(
            enforce_one_counter(&db, &tenant, agent, "task_create", &budget)
                .await
                .expect("first task"),
            RunBudgetOutcome::Admitted
        );
        assert_eq!(
            enforce_one_counter(&db, &tenant, agent, "task_create", &budget)
                .await
                .expect("second task"),
            RunBudgetOutcome::Exceeded,
            "limit-1 budget must block the second task"
        );

        // Record the overrun request and grant it (production resolution).
        let token_hash = [0x7au8; 32];
        db.create_budget_approval(
            tenant.community(),
            buzz_db::budget::CreateBudgetApprovalParams {
                subject: agent,
                counter_type: "task_create",
                window_start: budget.window_start,
                limit_value: budget.limit,
                budget_event_id: Some(&budget.budget_event_id_hex),
                token_hash: &token_hash,
                expires_at: Utc::now() + chrono::Duration::seconds(3600),
            },
        )
        .await
        .expect("record task_create overrun request");
        assert!(
            db.resolve_budget_approval(
                tenant.community(),
                &token_hash,
                buzz_db::budget::BudgetApprovalDecision::Granted,
                Some(&[1u8; 32]),
                None,
            )
            .await
            .expect("grant"),
            "grant wins the pending row"
        );

        assert_eq!(
            enforce_one_counter(&db, &tenant, agent, "task_create", &budget)
                .await
                .expect("task after grant"),
            RunBudgetOutcome::Admitted,
            "granted tolerance must admit one more task_create"
        );
        assert_eq!(
            enforce_one_counter(&db, &tenant, agent, "task_create", &budget)
                .await
                .expect("task after tolerance spent"),
            RunBudgetOutcome::Exceeded,
            "one grant forgives one overrun, no more"
        );

        pg_cleanup(&pool, community).await;
    }
}
