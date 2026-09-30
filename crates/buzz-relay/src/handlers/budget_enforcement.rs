//! NIP-ORG budget enforcement — relay-side ingest gate.
//!
//! Checks whether an agent's action exceeds any applicable budget limits
//! before the event is committed to the database, and consumes the matching
//! counter when the action is admitted. Counter classes:
//!
//! | counter                                          | gate                                   |
//! |--------------------------------------------------|----------------------------------------|
//! | `runs`                                           | kind:44200 agent turn metrics          |
//! | `task_create`                                    | kind:44011 agent tasks                 |
//! | `governance_proposal` / `_vote` / `_execute`     | kinds 47004 / 47005                    |
//! | `messages`                                       | chat messages (kinds 9, 40002) by agents |
//! | `llm_calls`                                      | the LLM gateway (`/llm/chat/completions`) |
//!
//! Contract (see `docs/nips/NIP-ORG.md`): a budget's JSON content keys are
//! camelCase — `{ subject, window, limits, onExceed }`.
//!
//! # Which budgets apply
//!
//! A budget applies to an agent when `content.subject` equals the agent's
//! 64-hex pubkey (case-insensitive), **or** it is a community *default*
//! budget (`subject: "*"`, owner/admin-signed only — enforced at ingest) and
//! the agent has no authority-signed budget of its own for that counter (R2).
//! A budget the subject signed itself is *additive*: it never displaces the
//! default or an authority-signed budget.
//!
//! When several budgets apply to one subject the **strictest limit wins** (a
//! subject cannot loosen itself). One admitted action increments each
//! `(counter, window)` exactly once, however many budgets share that window,
//! while every applicable budget's limit is checked against the shared
//! counter.
//!
//! # Windows
//!
//! Windows are fixed epochs — `floor(unix_time / len) * len` with `len` of
//! 86 400 (`day`), 604 800 (`week`) or 2 592 000 (`month`) seconds — so the
//! relay, `OrgAllowance.sol` and the desktop agree on where a window starts.
//! `epoch` is the all-time cumulative window.
//!
//! On exceed with `onExceed: "require-approval"` the relay records the
//! overrun durably (a `budget_approvals` row, written first) and then emits
//! a relay-signed kind:46010 notification best-effort; the row is the
//! recovery record if the notification is lost. The would-be action is
//! still rejected — approval is granted through a human decision, never by
//! re-submitting the same event. Granting and denying those rows is wired:
//! see `command_executor::resolve_budget_approval_command` (kinds 46030/46031).
//! (`migrations/0056_budget_consumption.sql` still says grant/deny wiring is a
//! follow-up; that comment predates the wiring and applied migrations are
//! never edited.)

use std::sync::Arc;

use buzz_core::org_grant::DEFAULT_BUDGET_SUBJECT;
use buzz_core::tenant::TenantContext;
use chrono::DateTime;
use chrono::Utc;
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

/// Length in seconds of the fixed `day` window (`OrgAllowance.sol`: `unix / 86400`).
const DAY_SECS: i64 = 86_400;
/// Length in seconds of the fixed `week` window (`unix / 604800`).
const WEEK_SECS: i64 = 604_800;
/// Length in seconds of the fixed `month` window (`unix / 2592000`).
const MONTH_SECS: i64 = 2_592_000;

/// Counter class for chat messages authored by agents (kinds 9 and 40002).
pub(crate) const COUNTER_MESSAGES: &str = "messages";
/// Counter class for LLM gateway calls.
pub(crate) const COUNTER_LLM_CALLS: &str = "llm_calls";
/// Counter class for LLM gateway spend, in milli-cents (thousandths of a US
/// cent) — see [`crate::config::MILLICENTS_PER_CENT`].
pub(crate) const COUNTER_LLM_COST: &str = "llm_cost_mc";

/// Compute the window start timestamp for a budget window type.
///
/// - `"day"` / `"week"` / `"month"` are **fixed epochs**: the window starts at
///   `floor(unix_time / len) * len` with `len` = 86 400 / 604 800 / 2 592 000
///   seconds, exactly the epoch numbering `OrgAllowance.sol` and the desktop
///   use (`unix / len`). They are not calendar days/weeks/months.
/// - `"epoch"` is the **all-time cumulative** counter: its window starts at
///   the Unix epoch and never resets. A budget that must expire needs an
///   explicit `expires` on the budget event itself, not this window.
///
/// Unknown window strings also map to the all-time epoch window here (the
/// stricter direction: an all-time counter only grows), but they can only
/// reach enforcement if they were stored before this validation existed —
/// kind:37012 ingest rejects unknown windows (see [`budget_content_error`]).
pub(crate) fn budget_window_start(window: &str, now: DateTime<Utc>) -> DateTime<Utc> {
    let len = match window {
        "day" => DAY_SECS,
        "week" => WEEK_SECS,
        "month" => MONTH_SECS,
        // "epoch" and any unknown legacy value: all-time cumulative.
        _ => return DateTime::UNIX_EPOCH,
    };
    let ts = now.timestamp().max(0);
    DateTime::from_timestamp(ts - ts.rem_euclid(len), 0).unwrap_or(DateTime::UNIX_EPOCH)
}

/// Validate the budget-specific content of a kind:37012 event.
///
/// Beyond the shared org envelope (JSON object, bounded `d`), a budget must
/// carry:
/// - `subject`: a 64-hex pubkey (case-insensitive) — the agent the budget
///   applies to — or `"*"`, the community default budget (R2), which covers
///   agents that have no authority-signed budget of their own and cannot
///   carry an `onchain` binding (that binds one agent's key). A budget
///   without a resolvable subject could never apply, so it is rejected
///   rather than stored dead.
/// - `window`: one of `"epoch" | "day" | "week" | "month"`. Unknown values
///   are rejected so they can no longer silently degrade to the all-time
///   epoch window.
/// - `limits` (when present): a well-formed limits object. A malformed one
///   would be skipped by enforcement — and, being authority-signed, would
///   still displace the default — so it is rejected up front.
///
/// Returns the rejection message on failure.
pub(crate) fn budget_content_error(content: &serde_json::Value) -> Option<String> {
    let subject = content.get("subject").and_then(|s| s.as_str());
    let Some(subject) = subject else {
        return Some(
            "org budget content must carry a `subject` (64-hex agent pubkey, or \"*\" for the community default)"
                .into(),
        );
    };
    let is_default = subject == DEFAULT_BUDGET_SUBJECT;
    let is_hex = subject.len() == 64 && subject.bytes().all(|b| b.is_ascii_hexdigit());
    if !is_default && !is_hex {
        return Some(
            "org budget content `subject` must be a 64-hex agent pubkey (or \"*\" for the community default)"
                .into(),
        );
    }
    if is_default && content.get("onchain").is_some() {
        return Some("a default budget (subject \"*\") cannot carry an `onchain` binding".into());
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

    if let Some(limits) = content.get("limits") {
        if let Err(e) = serde_json::from_value::<buzz_sdk::BudgetLimits>(limits.clone()) {
            return Some(format!("org budget content `limits` is malformed: {e}"));
        }
    }

    None
}

/// Validate a kind:37012 budget event at ingest: content contract plus the
/// publication-authority rule (R1).
///
/// A budget may be published by the community owner/admin, by a human holding
/// a seat in an anchored org node, or by its subject agent itself; the
/// community default (`subject: "*"`) by the owner/admin only. A subject's own
/// budget can only ever *add* constraints — enforcement applies the strictest
/// limit among every budget covering the subject and never lets a
/// subject-signed budget displace an authority-signed one.
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
    let graph = state.db.org_graph(tenant.community());
    buzz_core::org_grant::check_budget_publisher(&graph, &author_hex, subject)
        .await
        .map(|_| ())
        .map_err(|e| super::org_grant_enforcement::authority_ingest_error(e, "budget author"))
}

/// One applicable budget limit resolved for enforcement.
#[derive(Debug, Clone)]
struct ApplicableLimit {
    budget_event_id_hex: String,
    on_exceed: String,
    window: String,
    limit: i64,
    window_start: DateTime<Utc>,
}

/// Map a counter class to the limit a budget's typed `limits` carries for it.
///
/// Counter types: `"runs"` for agent turn metrics (kind:44200),
/// `"task_create"`/`"task_approve"` for agent task counters (kind:44011),
/// `"governance_proposal"`/`"governance_vote"`/`"governance_execute"` for the
/// governance-action classes (kinds 47004/47005 — the S3 HITL gate: over the
/// ceiling with `onExceed: "require-approval"` the action becomes a 46010
/// approval request instead of executing), `"messages"` for chat messages an
/// agent authors (kinds 9/40002) and `"llm_calls"` for LLM gateway calls.
/// `"task_approve"` is not enforced anywhere yet (see the note in `ingest.rs`).
pub(crate) fn counter_limit(limits: &buzz_sdk::BudgetLimits, counter_type: &str) -> Option<u64> {
    match counter_type {
        "runs" => limits.runs.map(u64::from),
        "task_create" => limits.tasks.as_ref().and_then(|t| t.create).map(u64::from),
        "task_approve" => limits.tasks.as_ref().and_then(|t| t.approve).map(u64::from),
        "governance_proposal" => limits
            .governance
            .as_ref()
            .and_then(|g| g.proposal)
            .map(u64::from),
        "governance_vote" => limits
            .governance
            .as_ref()
            .and_then(|g| g.vote)
            .map(u64::from),
        "governance_execute" => limits
            .governance
            .as_ref()
            .and_then(|g| g.execute)
            .map(u64::from),
        COUNTER_MESSAGES => limits.messages.map(u64::from),
        COUNTER_LLM_CALLS => limits.llm_calls.map(u64::from),
        COUNTER_LLM_COST => limits
            .llm_cost_cents
            .map(|cents| u64::from(cents) * crate::config::MILLICENTS_PER_CENT),
        _ => None,
    }
}

/// Outcome of checking (and, when admitted, consuming) a set of budgets.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BudgetOutcome {
    /// The action is within every applicable limit and its consumption was
    /// recorded once per `(counter, window)`.
    Admitted,
    /// The counter is at or past the strictest limit of a window (including
    /// the post-increment race check). Carries the index of the binding
    /// budget in the slice; the caller routes it through the exceed path,
    /// which records the durable approval request.
    Exceeded(usize),
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

/// The strictest limit among the budgets that share one `(counter, window)`.
struct WindowGroup {
    window_start: DateTime<Utc>,
    /// Effective (tolerance-adjusted) limit of the binding budget.
    limit: i64,
    /// Index of the binding budget in the input slice.
    binding: usize,
}

/// Check every applicable budget and, when all pass, consume the action.
///
/// Budgets are grouped by `window_start` (all budgets on one window share one
/// counter row). Per group the strictest effective limit binds — a subject
/// cannot loosen itself by holding a second, looser budget — ties go to a hard
/// (`onExceed: "reject"`) budget.
///
/// 1. **Check** every group's counter against its binding limit. If any is at
///    or over, return [`BudgetOutcome::Exceeded`] *without consuming
///    anything*: a rejected action must not burn budget.
/// 2. **Consume** exactly one unit per group — never one per budget, which
///    would over-count N x when N budgets share a window. The increment is a
///    same-call durable write whose failure fails the ingest (never a
///    fire-and-forget log). The relay store does not expose a transaction
///    spanning event insert and counter write, so the counter is consumed
///    before the event is stored — a later storage failure then over-counts
///    one action, which fails closed (a subject is budget-limited sooner,
///    never later). A concurrent ingest that races past the check trips the
///    post-increment guard (`consumed > limit`) and is reported as exceeded;
///    the counter stands (conservative).
/// Group budgets by window and pick the strictest effective limit of each
/// group — the binding budget. Shared by [`enforce_budget_set`] (check and
/// consume one unit) and the LLM cost meter (check now, consume later).
async fn budget_groups(
    db: &buzz_db::Db,
    tenant: &TenantContext,
    subject: &str,
    counter_type: &str,
    budgets: &[ApplicableLimit],
) -> Result<Vec<WindowGroup>, IngestError> {
    let mut groups: Vec<WindowGroup> = Vec::new();
    for (index, budget) in budgets.iter().enumerate() {
        let limit = effective_limit(db, tenant, subject, counter_type, budget).await?;
        match groups
            .iter_mut()
            .find(|g| g.window_start == budget.window_start)
        {
            Some(group) => {
                let binding_is_hard = budgets[group.binding].on_exceed == "reject";
                let stricter = limit < group.limit
                    || (limit == group.limit && budget.on_exceed == "reject" && !binding_is_hard);
                if stricter {
                    group.limit = limit;
                    group.binding = index;
                }
            }
            None => groups.push(WindowGroup {
                window_start: budget.window_start,
                limit,
                binding: index,
            }),
        }
    }
    Ok(groups)
}

/// Choose which violated budget binds the rejection (pure — the policy is
/// unit-tested below). A hard-reject budget (`on_exceed: "reject"`, e.g. an
/// emergency stop's all-zero budget) always outranks a violated
/// `require-approval` budget, so a stopped agent is hard-refused with NO
/// approval queue regardless of window or discovery order. Within a class the
/// strictest (lowest) limit binds; ties keep the first violated.
fn select_binding(budgets: &[ApplicableLimit], violated: &[usize]) -> usize {
    let mut best = violated[0];
    let class = |i: usize| budgets[i].on_exceed == "reject";
    let reject_class = class(best);
    for &candidate in &violated[1..] {
        let cand_class = class(candidate);
        if cand_class != reject_class {
            if cand_class {
                best = candidate;
            }
            continue;
        }
        if budgets[candidate].limit < budgets[best].limit {
            best = candidate;
        }
    }
    best
}

async fn enforce_budget_set(
    db: &buzz_db::Db,
    tenant: &TenantContext,
    subject: &str,
    counter_type: &str,
    budgets: &[ApplicableLimit],
) -> Result<BudgetOutcome, IngestError> {
    let groups = budget_groups(db, tenant, subject, counter_type, budgets).await?;

    // Collect EVERY violated group before choosing: a hard-reject budget (an
    // emergency stop's limit 0) must win the binding over a violated
    // require-approval budget in another window, or a stopped agent's refusal
    // would report the softer budget AND record an approval request the stop
    // design forbids.
    let mut violated: Vec<usize> = Vec::new();
    for group in &groups {
        let within = db
            .check_budget_consumption(
                tenant.community(),
                subject,
                counter_type,
                group.window_start,
                group.limit,
            )
            .await
            .map_err(|e| IngestError::Internal(format!("error: db error checking budget: {e}")))?;
        if !within {
            violated.push(group.binding);
        }
    }
    if !violated.is_empty() {
        return Ok(BudgetOutcome::Exceeded(select_binding(
            budgets, &violated,
        )));
    }

    let mut raced: Vec<usize> = Vec::new();
    for group in &groups {
        let consumed = db
            .increment_budget_consumption(
                tenant.community(),
                subject,
                counter_type,
                group.window_start,
                1,
            )
            .await
            .map_err(|e| {
                IngestError::Internal(format!("error: could not record budget consumption: {e}"))
            })?;
        if consumed > group.limit {
            raced.push(group.binding);
        }
    }
    Ok(match raced.is_empty() {
        true => BudgetOutcome::Admitted,
        false => BudgetOutcome::Exceeded(select_binding(budgets, &raced)),
    })
}

/// A subject's LLM spend budgets, checked before a gateway call and charged
/// after it, once the upstream has reported what the call actually cost.
#[derive(Debug)]
pub(crate) struct LlmCostMeter {
    subject: String,
    windows: Vec<DateTime<Utc>>,
}

/// Before a gateway call: if any budget bounds this caller's LLM spend, the
/// spend so far must be under the strictest limit of every window. Nothing is
/// consumed here — the cost is unknown until the upstream answers. Returns
/// `None` when no budget bounds LLM spend for the caller.
///
/// The check is against spend already recorded, so one call can overshoot a
/// limit by its own cost; the *next* call is then refused (a soft ceiling, as
/// with any post-paid meter).
pub(crate) async fn begin_llm_cost(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    pubkey_hex: &str,
) -> Result<Option<LlmCostMeter>, IngestError> {
    let subject = pubkey_hex.to_ascii_lowercase();
    let budgets = applicable_limits(state, tenant, &subject, COUNTER_LLM_COST).await?;
    if budgets.is_empty() {
        return Ok(None);
    }
    let groups = budget_groups(&state.db, tenant, &subject, COUNTER_LLM_COST, &budgets).await?;
    for group in &groups {
        let within = state
            .db
            .check_budget_consumption(
                tenant.community(),
                &subject,
                COUNTER_LLM_COST,
                group.window_start,
                group.limit,
            )
            .await
            .map_err(|e| IngestError::Internal(format!("error: db error checking budget: {e}")))?;
        if !within {
            return Err(exceeded_error(
                state,
                tenant,
                &subject,
                COUNTER_LLM_COST,
                &budgets[group.binding],
            )
            .await);
        }
    }
    Ok(Some(LlmCostMeter {
        subject,
        windows: groups.iter().map(|g| g.window_start).collect(),
    }))
}

/// After a gateway call: charge what it cost (milli-cents) to every window the
/// caller's budgets cover. A failed write fails the request — an unrecorded
/// paid call would be free spend.
pub(crate) async fn record_llm_cost(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    meter: &LlmCostMeter,
    cost_millicents: u64,
) -> Result<(), IngestError> {
    let amount = i64::try_from(cost_millicents).unwrap_or(i64::MAX);
    for window_start in &meter.windows {
        state
            .db
            .increment_budget_consumption(
                tenant.community(),
                &meter.subject,
                COUNTER_LLM_COST,
                *window_start,
                amount,
            )
            .await
            .map_err(|e| {
                IngestError::Internal(format!("error: could not record LLM spend: {e}"))
            })?;
    }
    Ok(())
}

/// A limit that applies when no budget defines one for the counter (the LLM
/// gateway's operator-configured daily cap).
#[derive(Debug, Clone, Copy)]
pub(crate) struct FallbackLimit {
    /// Window the fallback counts over (`"day"`, …).
    pub(crate) window: &'static str,
    /// Calls allowed per window.
    pub(crate) limit: i64,
}

/// Enforce the agent's run budget and consume one run.
///
/// The full kind:44200 gate: check every applicable budget's `runs` limit,
/// and when all pass, increment the `runs` counter once per window. See
/// [`enforce_budget_set`] for the atomicity note.
pub(crate) async fn enforce_run_budget(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    agent_pubkey_hex: &str,
) -> Result<(), IngestError> {
    enforce_counter(state, tenant, agent_pubkey_hex, "runs").await
}

/// Enforce every applicable budget's `counter_type` limit for the subject,
/// consuming one unit per window when within the (effective) limits.
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
    enforce_counter_with_fallback(state, tenant, agent_pubkey_hex, counter_type, None).await
}

/// [`enforce_counter`] with an operator fallback: when no budget defines a
/// limit for the counter, `fallback` applies (as a hard reject).
pub(crate) async fn enforce_counter_with_fallback(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    agent_pubkey_hex: &str,
    counter_type: &str,
    fallback: Option<FallbackLimit>,
) -> Result<(), IngestError> {
    let mut budgets = applicable_limits(state, tenant, agent_pubkey_hex, counter_type).await?;
    if budgets.is_empty() {
        if let Some(fallback) = fallback {
            budgets.push(ApplicableLimit {
                budget_event_id_hex: "config-default".to_string(),
                on_exceed: "reject".to_string(),
                window: fallback.window.to_string(),
                limit: fallback.limit,
                window_start: budget_window_start(fallback.window, Utc::now()),
            });
        }
    }
    if budgets.is_empty() {
        return Ok(());
    }
    match enforce_budget_set(&state.db, tenant, agent_pubkey_hex, counter_type, &budgets).await? {
        BudgetOutcome::Admitted => Ok(()),
        BudgetOutcome::Exceeded(binding) => Err(exceeded_error(
            state,
            tenant,
            agent_pubkey_hex,
            counter_type,
            &budgets[binding],
        )
        .await),
    }
}

/// Enforce the `messages` budget for a chat message (kinds 9 and 40002).
///
/// Only agents are metered (design rule 5: budgets never cap a human's own
/// actions), so a non-agent author returns immediately without a budget
/// lookup — the common case on the hot chat path.
pub(crate) async fn enforce_message_budget(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    author_pubkey_hex: &str,
) -> Result<(), IngestError> {
    if !subject_is_agent(state, tenant, author_pubkey_hex).await? {
        return Ok(());
    }
    enforce_counter(state, tenant, author_pubkey_hex, COUNTER_MESSAGES).await
}

/// Enforce the `llm_calls` budget for an LLM gateway call, falling back to the
/// operator's daily cap when no budget covers the caller.
pub(crate) async fn enforce_llm_call(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    caller_pubkey_hex: &str,
    default_daily_cap: u32,
) -> Result<(), IngestError> {
    enforce_counter_with_fallback(
        state,
        tenant,
        caller_pubkey_hex,
        COUNTER_LLM_CALLS,
        Some(FallbackLimit {
            window: "day",
            limit: i64::from(default_daily_cap),
        }),
    )
    .await
}

/// Whether `pubkey_hex` is an agent: its `users` row carries an
/// `agent_owner_pubkey` (set from the NIP-OA owner attestation at auth).
///
/// Read-through the per-community author-type cache (the mapping is
/// first-write-wins and set before an agent's first event). A lookup error
/// propagates — it is never read as "human".
///
/// Limitation: a key that never registered an owner (no NIP-OA attestation)
/// is indistinguishable from a human here, so only its *own* budgets bind it,
/// never the community default. Register agents through NIP-OA.
pub(crate) async fn subject_is_agent(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    pubkey_hex: &str,
) -> Result<bool, IngestError> {
    let Ok(bytes) = hex::decode(pubkey_hex) else {
        return Ok(false);
    };
    let key = (tenant.community(), bytes);
    if let Some(cached) = state.author_type_cache.get(&key) {
        return Ok(cached);
    }
    let is_agent = match state.db.get_agent_channel_policy(key.0, &key.1).await {
        Ok(Some((_, owner))) => owner.is_some(),
        Ok(None) => false,
        Err(e) => {
            return Err(IngestError::Internal(format!(
                "error: db error resolving agent status: {e}"
            )))
        }
    };
    state.author_type_cache.insert(key, is_agent);
    Ok(is_agent)
}

/// One counter limit resolved through (or without) a performance ladder.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ResolvedCounterLimit {
    limit: i64,
    /// True when the ladder is violated with `onViolation: "revoke"`: the
    /// budget hard-rejects (no approval path) for as long as the window is
    /// violated.
    hard_reject: bool,
}

/// Resolve the effective counter limit for one budget, applying the
/// performance ladder when present.
///
/// Pure: all DB access (contribution counts) happens in the caller. A
/// malformed ladder fails closed to the base limits (NIP-ORG §
/// Performance-linked autonomy); malformed base limits yield `None`, which
/// the caller treats as "no enforceable limit" — the same skip a missing
/// base limit gets today.
fn resolve_laddered_limit(
    base_limits: &serde_json::Value,
    performance_link: Option<&serde_json::Value>,
    summary: Option<buzz_sdk::ContributionSummary>,
    counter_type: &str,
) -> Option<ResolvedCounterLimit> {
    let from_limits = |limits: &buzz_sdk::BudgetLimits| counter_limit(limits, counter_type);

    let base_typed: buzz_sdk::BudgetLimits = match serde_json::from_value(base_limits.clone()) {
        Ok(v) => v,
        Err(_) => return None,
    };
    let base_limit = from_limits(&base_typed)?;

    let Some(link_val) = performance_link else {
        return Some(base_limit).map(|limit| ResolvedCounterLimit {
            limit: limit as i64,
            hard_reject: false,
        });
    };
    let link: buzz_sdk::PerformanceLink = match serde_json::from_value(link_val.clone()) {
        Ok(l) => l,
        Err(e) => {
            // Fail closed to base: a ladder the relay cannot parse never
            // widens anything, and must not break enforcement either.
            tracing::warn!("malformed performanceLink, using base limits: {e}");
            return Some(base_limit).map(|limit| ResolvedCounterLimit {
                limit: limit as i64,
                hard_reject: false,
            });
        }
    };
    let summary = summary.unwrap_or_default();
    let resolution = buzz_sdk::evaluate_performance_link(&link, &summary, &base_typed);
    let hard_reject = resolution.violated && link.on_violation == buzz_sdk::OnViolation::Revoke;
    from_limits(&resolution.limits).map(|limit| ResolvedCounterLimit {
        limit: limit as i64,
        hard_reject,
    })
}

/// Resolve one stored budget event into the limit it imposes on
/// `counter_type` for `subject`, or `None` when it does not bound that
/// counter (no limits object, or no limit for this counter).
async fn resolve_budget_event(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    subject: &str,
    counter_type: &str,
    budget_event: buzz_db::budget::BudgetEvent,
) -> Result<Option<ApplicableLimit>, IngestError> {
    let content: serde_json::Value = serde_json::from_str(&budget_event.content)
        .map_err(|e| IngestError::Internal(format!("error: malformed budget content: {e}")))?;

    // Missing/unknown window falls back to the all-time epoch window;
    // ingest validation keeps unknown values out of new budgets.
    let window = content
        .get("window")
        .and_then(|w| w.as_str())
        .unwrap_or("epoch");

    let Some(limits) = content.get("limits") else {
        return Ok(None);
    };

    // Performance ladder (NIP-ORG § Performance-linked autonomy): fetch the
    // subject's *reviewed* contribution outcome counts over the ladder's own
    // window, then resolve the active tier. A malformed ladder fails closed to
    // the base limits inside `resolve_laddered_limit`.
    let ladder_counts: Option<buzz_sdk::ContributionSummary> = match content.get("performanceLink")
    {
        Some(link_val) => {
            let link: Option<buzz_sdk::PerformanceLink> =
                serde_json::from_value(link_val.clone()).ok();
            match link {
                Some(link) => {
                    let window_start = budget_window_start(
                        match link.window {
                            buzz_sdk::BudgetWindow::Epoch => "epoch",
                            buzz_sdk::BudgetWindow::Day => "day",
                            buzz_sdk::BudgetWindow::Week => "week",
                            buzz_sdk::BudgetWindow::Month => "month",
                        },
                        Utc::now(),
                    );
                    let dims = link.dimensions.clone().unwrap_or_default();
                    match state
                        .db
                        .count_contribution_outcomes(
                            tenant.community(),
                            subject,
                            window_start,
                            &dims,
                        )
                        .await
                    {
                        Ok(c) => Some(buzz_sdk::ContributionSummary {
                            accepted: c.accepted as u32,
                            rejected: c.rejected as u32,
                        }),
                        Err(e) => {
                            return Err(IngestError::Internal(format!(
                                "error: db error counting contribution outcomes: {e}"
                            )));
                        }
                    }
                }
                None => None,
            }
        }
        None => None,
    };

    let Some(resolved) = resolve_laddered_limit(
        limits,
        content.get("performanceLink"),
        ladder_counts,
        counter_type,
    ) else {
        return Ok(None);
    };

    Ok(Some(ApplicableLimit {
        budget_event_id_hex: budget_event.event_id_hex,
        // A violated ladder with `onViolation: "revoke"` hard-rejects:
        // zero autonomy means zero, with no approval escape hatch.
        on_exceed: if resolved.hard_reject {
            "reject".to_string()
        } else {
            budget_event.on_exceed
        },
        window: window.to_string(),
        limit: resolved.limit,
        window_start: budget_window_start(window, Utc::now()),
    }))
}

/// Resolve the budgets that actually bound `counter_type` for this subject.
///
/// - Every budget whose `content.subject` names the subject and that defines a
///   limit for the counter applies. The lookup filters by subject in SQL, so
///   budgets for other subjects can never hide these.
/// - If none of them was signed by an authority (someone other than the
///   subject — the subject's own budget only ever adds constraints), the
///   community default budget(s) (`subject: "*"`) apply too, **to agents
///   only** (design rule 5: budgets never cap a human) — see
///   [`subject_is_agent`].
async fn applicable_limits(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    agent_pubkey_hex: &str,
    counter_type: &str,
) -> Result<Vec<ApplicableLimit>, IngestError> {
    let community_id = tenant.community();
    let subject = agent_pubkey_hex.to_ascii_lowercase();

    let own = state
        .db
        .budget_enforcement_lookup(community_id, &subject)
        .await
        .map_err(|e| IngestError::Internal(format!("error: db error querying budgets: {e}")))?;

    let mut applicable = Vec::new();
    let mut has_authority_limit = false;
    for budget_event in own {
        let authority_signed = !budget_event.author_hex.eq_ignore_ascii_case(&subject);
        if let Some(limit) =
            resolve_budget_event(state, tenant, &subject, counter_type, budget_event).await?
        {
            has_authority_limit |= authority_signed;
            applicable.push(limit);
        }
    }

    if !has_authority_limit {
        let defaults = state
            .db
            .default_budget_lookup(community_id)
            .await
            .map_err(|e| {
                IngestError::Internal(format!("error: db error querying default budgets: {e}"))
            })?;
        if !defaults.is_empty() && subject_is_agent(state, tenant, &subject).await? {
            for budget_event in defaults {
                if let Some(limit) =
                    resolve_budget_event(state, tenant, &subject, counter_type, budget_event)
                        .await?
                {
                    applicable.push(limit);
                }
            }
        }
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
    let message = if counter_type == COUNTER_LLM_COST {
        format!(
            "budget exceeded: LLM spend limit of {} cents reached",
            budget.limit / crate::config::MILLICENTS_PER_CENT as i64
        )
    } else {
        format!(
            "budget exceeded: {counter_type} limit {} reached",
            budget.limit
        )
    };

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

    /// The counter-type vocabulary binds to the typed budget limits — this
    /// mapping IS the governance-action gate's vocabulary (S3 HITL).
    fn applicable(id: &str, limit: i64, on_exceed: &str) -> ApplicableLimit {
        ApplicableLimit {
            budget_event_id_hex: id.to_string(),
            on_exceed: on_exceed.to_string(),
            window: "day".to_string(),
            limit,
            window_start: chrono::Utc::now(),
        }
    }

    /// The emergency-stop invariant: a violated hard-reject budget binds over
    /// a violated require-approval budget in ANY order, so a stopped agent is
    /// refused with the stop's "limit 0" and NO approval request is recorded.
    #[test]
    fn hard_reject_outranks_a_violated_approval_budget() {
        let budgets = vec![
            applicable("day", 2, "require-approval"),
            applicable("stop", 0, "reject"),
        ];
        assert_eq!(select_binding(&budgets, &[0, 1]), 1);
        assert_eq!(select_binding(&budgets, &[1, 0]), 1);
    }

    /// Within one class the strictest limit binds regardless of order.
    #[test]
    fn strictest_limit_binds_within_a_class() {
        let budgets = vec![
            applicable("a", 5, "reject"),
            applicable("b", 0, "reject"),
            applicable("c", 3, "require-approval"),
            applicable("d", 1, "require-approval"),
        ];
        assert_eq!(select_binding(&budgets, &[0, 1]), 1);
        assert_eq!(select_binding(&budgets, &[3, 2]), 3);
    }

    /// Full ties keep the first violated (stable, deterministic).
    #[test]
    fn first_violated_binds_on_a_full_tie() {
        let budgets = vec![applicable("a", 2, "reject"), applicable("b", 2, "reject")];
        assert_eq!(select_binding(&budgets, &[0, 1]), 0);
    }

    #[test]
    fn counter_limit_maps_every_class() {
        let mut limits = buzz_sdk::BudgetLimits::default();
        limits.runs = Some(9);
        limits.governance = Some(buzz_sdk::GovernanceLimits {
            proposal: Some(1),
            vote: Some(3),
            execute: Some(2),
        });
        assert_eq!(counter_limit(&limits, "runs"), Some(9));
        assert_eq!(counter_limit(&limits, "governance_proposal"), Some(1));
        assert_eq!(counter_limit(&limits, "governance_vote"), Some(3));
        assert_eq!(counter_limit(&limits, "governance_execute"), Some(2));
        assert_eq!(counter_limit(&limits, "task_create"), None);
        assert_eq!(counter_limit(&limits, "unknown_class"), None);
    }

    /// Unset governance caps mean "no ceiling" — never a silent zero.
    #[test]
    fn counter_limit_never_invents_a_ceiling() {
        let limits = buzz_sdk::BudgetLimits::default();
        assert_eq!(counter_limit(&limits, "governance_vote"), None);
    }
    use chrono::TimeZone;

    fn fixed_now() -> DateTime<Utc> {
        // Wednesday 2026-09-16 15:42:07 UTC
        Utc.with_ymd_and_hms(2026, 9, 16, 15, 42, 7).unwrap()
    }

    fn base_limits_json() -> serde_json::Value {
        serde_json::json!({ "runs": 50, "tasks": { "create": 20, "approve": 0 } })
    }

    fn ladder_json() -> serde_json::Value {
        serde_json::json!({
            "window": "week",
            "dimensions": ["build"],
            "tiers": [
                { "minAccepted": 3, "limits": { "runs": 80, "tasks": { "create": 30, "approve": 0 } } },
                { "minAccepted": 10, "limits": { "runs": 200, "tasks": { "create": 60, "approve": 2 } } }
            ],
            "onViolation": "revoke",
            "violationThreshold": { "rejected": 1 }
        })
    }

    #[test]
    fn no_ladder_uses_base_limits() {
        let r = resolve_laddered_limit(&base_limits_json(), None, None, "runs").unwrap();
        assert_eq!(r.limit, 50);
        assert!(!r.hard_reject);
    }

    #[test]
    fn ladder_tier_raises_the_limit() {
        let summary = buzz_sdk::ContributionSummary {
            accepted: 5,
            rejected: 0,
        };
        let r = resolve_laddered_limit(
            &base_limits_json(),
            Some(&ladder_json()),
            Some(summary),
            "runs",
        )
        .unwrap();
        assert_eq!(r.limit, 80);
        assert!(!r.hard_reject);
    }

    #[test]
    fn violated_ladder_with_revoke_zeroes_and_hard_rejects() {
        let summary = buzz_sdk::ContributionSummary {
            accepted: 30,
            rejected: 1,
        };
        let r = resolve_laddered_limit(
            &base_limits_json(),
            Some(&ladder_json()),
            Some(summary),
            "runs",
        )
        .unwrap();
        assert_eq!(r.limit, 0);
        assert!(r.hard_reject);
    }

    #[test]
    fn violated_ladder_without_revoke_keeps_the_approval_path() {
        let mut link = ladder_json();
        link["onViolation"] = serde_json::json!("require-approval");
        let summary = buzz_sdk::ContributionSummary {
            accepted: 30,
            rejected: 2,
        };
        let r = resolve_laddered_limit(&base_limits_json(), Some(&link), Some(summary), "runs")
            .unwrap();
        assert_eq!(r.limit, 0);
        assert!(!r.hard_reject);
    }

    #[test]
    fn malformed_ladder_fails_closed_to_base() {
        let bad = serde_json::json!({ "tiers": "not-an-array" });
        let r = resolve_laddered_limit(&base_limits_json(), Some(&bad), None, "runs").unwrap();
        assert_eq!(r.limit, 50);
        assert!(!r.hard_reject);
    }

    #[test]
    fn malformed_base_limits_yield_no_enforceable_limit() {
        let bad = serde_json::json!({ "runs": "fifty" });
        assert!(resolve_laddered_limit(&bad, None, None, "runs").is_none());
    }

    #[test]
    fn task_create_counter_extracts_from_tier() {
        let summary = buzz_sdk::ContributionSummary {
            accepted: 12,
            rejected: 0,
        };
        let r = resolve_laddered_limit(
            &base_limits_json(),
            Some(&ladder_json()),
            Some(summary),
            "task_create",
        )
        .unwrap();
        assert_eq!(r.limit, 60);
    }

    #[test]
    fn uncapped_counter_in_every_layer_yields_none() {
        let limits = serde_json::json!({ "runs": 50 });
        assert!(resolve_laddered_limit(&limits, None, None, "task_approve").is_none());
    }

    /// Item 8: windows are fixed epochs (`floor(ts/len)*len`), the same slot
    /// `OrgAllowance.sol` (`unix / len`) and the desktop compute — not
    /// calendar days/weeks/months.
    #[test]
    fn windows_are_fixed_epochs_matching_the_contract() {
        let now = fixed_now();
        let ts = now.timestamp();
        for (window, len) in [("day", 86_400i64), ("week", 604_800), ("month", 2_592_000)] {
            let start = budget_window_start(window, now);
            assert_eq!(
                start.timestamp(),
                (ts / len) * len,
                "{window} must start at floor(unix/{len})*{len}"
            );
            assert_eq!(start.timestamp() % len, 0);
            assert!(start <= now && now < start + chrono::Duration::seconds(len));
        }
    }

    /// The fixed 30-day month and 7-day week are NOT calendar boundaries:
    /// 2026-09-16 15:42:07 UTC is neither the 1st of September nor the Monday
    /// of its ISO week in epoch numbering.
    #[test]
    fn fixed_epoch_windows_differ_from_calendar_windows() {
        let now = fixed_now();
        assert_ne!(
            budget_window_start("month", now),
            Utc.with_ymd_and_hms(2026, 9, 1, 0, 0, 0).unwrap(),
            "month is a 30-day epoch, not the calendar month"
        );
        assert_ne!(
            budget_window_start("week", now),
            Utc.with_ymd_and_hms(2026, 9, 14, 0, 0, 0).unwrap(),
            "week is a 7-day epoch (Thursday-aligned), not the ISO week"
        );
        // Day windows happen to coincide with UTC midnight.
        assert_eq!(
            budget_window_start("day", now),
            Utc.with_ymd_and_hms(2026, 9, 16, 0, 0, 0).unwrap()
        );
    }

    /// One instant belongs to exactly one window per kind, and the boundary
    /// second starts the next window.
    #[test]
    fn window_boundary_starts_the_next_epoch() {
        let boundary = DateTime::from_timestamp(86_400 * 20_000, 0).unwrap();
        assert_eq!(budget_window_start("day", boundary), boundary);
        let last = boundary - chrono::Duration::seconds(1);
        assert_eq!(
            budget_window_start("day", last),
            boundary - chrono::Duration::days(1)
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

    #[test]
    fn default_budget_subject_is_accepted_but_cannot_be_onchain() {
        let content =
            budget_json(r#"{"subject": "*", "window": "day", "limits": {"messages": 10}}"#);
        assert_eq!(budget_content_error(&content), None);
        let onchain = budget_json(
            r#"{"subject": "*", "window": "day", "limits": {"runs": 1},
                "onchain": {"chain": "eip155:1", "contract": "0x0", "subject": "*"}}"#,
        );
        let msg = budget_content_error(&onchain).expect("onchain default rejected");
        assert!(msg.contains("onchain"), "got: {msg}");
    }

    #[test]
    fn malformed_limits_are_rejected_at_ingest() {
        let content = budget_json(
            r#"{"subject": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "window": "day", "limits": {"runs": "fifty"}}"#,
        );
        let msg = budget_content_error(&content).expect("bad limits rejected");
        assert!(msg.contains("`limits` is malformed"), "got: {msg}");
        // The new counter keys parse from the wire.
        let ok = budget_json(
            r#"{"subject": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "window": "day", "limits": {"messages": 5, "llmCalls": 7}}"#,
        );
        assert_eq!(budget_content_error(&ok), None);
    }

    /// Item 10: `messages` and `llm_calls` bind to `limits.messages` /
    /// `limits.llmCalls` read from the camelCase wire content.
    #[test]
    fn message_and_llm_counters_bind_their_limits() {
        let limits: buzz_sdk::BudgetLimits =
            serde_json::from_str(r#"{"messages": 12, "llmCalls": 34}"#).unwrap();
        assert_eq!(counter_limit(&limits, COUNTER_MESSAGES), Some(12));
        assert_eq!(counter_limit(&limits, COUNTER_LLM_CALLS), Some(34));
        assert_eq!(counter_limit(&limits, "runs"), None);
        let r = resolve_laddered_limit(
            &serde_json::json!({"messages": 12}),
            None,
            None,
            COUNTER_MESSAGES,
        )
        .unwrap();
        assert_eq!(r.limit, 12);
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
        sqlx::query("DELETE FROM users WHERE community_id = $1")
            .bind(community)
            .execute(pool)
            .await
            .expect("delete users");
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
            one_budget(&db, &tenant, agent, "runs", &budget).await,
            BudgetOutcome::Admitted
        );
        assert_eq!(
            one_budget(&db, &tenant, agent, "runs", &budget).await,
            BudgetOutcome::Admitted
        );
        assert_eq!(
            one_budget(&db, &tenant, agent, "runs", &budget).await,
            BudgetOutcome::Exceeded(0),
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
            one_budget(&db, &tenant, agent, "runs", &budget).await,
            BudgetOutcome::Admitted,
            "granted tolerance must admit one more run"
        );
        assert_eq!(
            one_budget(&db, &tenant, agent, "runs", &budget).await,
            BudgetOutcome::Exceeded(0),
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
            one_budget(&db, &tenant, agent, "runs", &budget).await,
            BudgetOutcome::Exceeded(0),
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
            one_budget(&db, &tenant, agent, "task_create", &budget).await,
            BudgetOutcome::Admitted
        );
        assert_eq!(
            one_budget(&db, &tenant, agent, "task_create", &budget).await,
            BudgetOutcome::Exceeded(0),
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
            one_budget(&db, &tenant, agent, "task_create", &budget).await,
            BudgetOutcome::Admitted,
            "granted tolerance must admit one more task_create"
        );
        assert_eq!(
            one_budget(&db, &tenant, agent, "task_create", &budget).await,
            BudgetOutcome::Exceeded(0),
            "one grant forgives one overrun, no more"
        );

        pg_cleanup(&pool, community).await;
    }

    // -- item 6-10: sets of budgets, defaults, windows, counters -----------------

    /// Test-facing seam: one budget through the production check/consume core.
    async fn one_budget(
        db: &buzz_db::Db,
        tenant: &TenantContext,
        agent: &str,
        counter_type: &str,
        budget: &ApplicableLimit,
    ) -> BudgetOutcome {
        enforce_budget_set(
            db,
            tenant,
            agent,
            counter_type,
            std::slice::from_ref(budget),
        )
        .await
        .expect("budget check")
    }

    fn tenant_of(community: uuid::Uuid) -> TenantContext {
        TenantContext::resolved(
            buzz_core::CommunityId::from_uuid(community),
            format!("budget-enf-{community}.test"),
        )
    }

    async fn pg_insert_budget_event_by(
        pool: &sqlx::PgPool,
        community: uuid::Uuid,
        author: [u8; 32],
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
        .bind(author.as_slice())
        .bind(content.to_string())
        .bind([2u8; 64])
        .execute(pool)
        .await
        .expect("insert budget event");
    }

    /// Register `agent` (with `owner`) in the users table — the relay's agent
    /// discriminator (`agent_owner_pubkey IS NOT NULL`).
    async fn pg_register_agent(
        pool: &sqlx::PgPool,
        community: uuid::Uuid,
        agent: [u8; 32],
        owner: [u8; 32],
    ) {
        for pk in [owner, agent] {
            sqlx::query(
                "INSERT INTO users (community_id, pubkey) VALUES ($1, $2) ON CONFLICT DO NOTHING",
            )
            .bind(community)
            .bind(pk.as_slice())
            .execute(pool)
            .await
            .expect("insert user");
        }
        sqlx::query(
            "UPDATE users SET agent_owner_pubkey = $3 WHERE community_id = $1 AND pubkey = $2",
        )
        .bind(community)
        .bind(agent.as_slice())
        .bind(owner.as_slice())
        .execute(pool)
        .await
        .expect("set agent owner");
    }

    async fn consumed(
        pool: &sqlx::PgPool,
        community: uuid::Uuid,
        agent: &str,
        counter: &str,
    ) -> Vec<(DateTime<Utc>, i64)> {
        sqlx::query_as(
            "SELECT window_start, consumed FROM budget_consumption
             WHERE community_id = $1 AND subject = $2 AND counter_type = $3
             ORDER BY window_start",
        )
        .bind(community)
        .bind(agent)
        .bind(counter)
        .fetch_all(pool)
        .await
        .expect("consumption rows")
    }

    /// Item 9: two budgets on one window must increment the shared counter
    /// ONCE per action (not N x), with the STRICTEST limit binding — and a
    /// looser subject-signed budget cannot loosen it.
    #[tokio::test]
    #[ignore = "requires migrated Postgres"]
    async fn shared_window_counts_once_and_strictest_limit_wins() {
        let (pool, community) = pg_pool().await;
        let tenant = tenant_of(community);
        let agent = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
        let mk = |limit: i64| {
            serde_json::json!({
                "v": 1, "subject": agent, "window": "day",
                "limits": { "messages": limit }, "onExceed": "reject",
            })
        };
        // Two authority-signed budgets (limits 5 and 3) on the same day window…
        pg_insert_budget_event_by(&pool, community, [8u8; 32], mk(5)).await;
        pg_insert_budget_event_by(&pool, community, [7u8; 32], mk(3)).await;
        // …and a looser budget the subject signed itself (limit 100).
        let agent_key: [u8; 32] = hex::decode(agent).unwrap().try_into().unwrap();
        pg_insert_budget_event_by(&pool, community, agent_key, mk(100)).await;
        let Some(state) = pg_app_state(&pool).await else {
            pg_cleanup(&pool, community).await;
            eprintln!("skipping: could not build AppState (config/media unavailable)");
            return;
        };

        for n in 1..=3 {
            enforce_counter(&state, &tenant, agent, COUNTER_MESSAGES)
                .await
                .unwrap_or_else(|e| panic!("action {n} is within the strictest limit (3): {e:?}"));
        }
        let rows = consumed(&pool, community, agent, COUNTER_MESSAGES).await;
        assert_eq!(rows.len(), 1, "one (counter, window) row");
        assert_eq!(
            rows[0].1, 3,
            "3 actions consumed 3 units, not 3 x 3 budgets"
        );

        let err = enforce_counter(&state, &tenant, agent, COUNTER_MESSAGES)
            .await
            .expect_err("the strictest limit (3) binds; 100 and 5 do not loosen it");
        match err {
            IngestError::Rejected(msg) => assert!(
                msg.contains("budget exceeded: messages limit 3"),
                "unexpected rejection: {msg}"
            ),
            other => panic!("expected Rejected, got {other:?}"),
        }
        let rows = consumed(&pool, community, agent, COUNTER_MESSAGES).await;
        assert_eq!(rows[0].1, 3, "a rejected action consumes nothing");

        pg_cleanup(&pool, community).await;
    }

    /// Budgets on different windows each get their own counter row,
    /// incremented once per action; the tighter window binds; a rejected
    /// action does not burn the looser window's budget.
    #[tokio::test]
    #[ignore = "requires migrated Postgres"]
    async fn each_window_counts_once_and_a_rejection_burns_nothing() {
        let (pool, community) = pg_pool().await;
        let tenant = tenant_of(community);
        let agent = "a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2";
        pg_insert_budget_event_by(
            &pool,
            community,
            [8u8; 32],
            serde_json::json!({
                "v": 1, "subject": agent, "window": "day",
                "limits": { "llmCalls": 10 }, "onExceed": "reject",
            }),
        )
        .await;
        pg_insert_budget_event_by(
            &pool,
            community,
            [8u8; 32],
            serde_json::json!({
                "v": 1, "subject": agent, "window": "week",
                "limits": { "llmCalls": 2 }, "onExceed": "reject",
            }),
        )
        .await;
        let Some(state) = pg_app_state(&pool).await else {
            pg_cleanup(&pool, community).await;
            eprintln!("skipping: could not build AppState (config/media unavailable)");
            return;
        };

        enforce_counter(&state, &tenant, agent, COUNTER_LLM_CALLS)
            .await
            .expect("call 1");
        enforce_counter(&state, &tenant, agent, COUNTER_LLM_CALLS)
            .await
            .expect("call 2");
        let err = enforce_counter(&state, &tenant, agent, COUNTER_LLM_CALLS)
            .await
            .expect_err("the weekly limit of 2 binds");
        assert!(
            matches!(&err, IngestError::Rejected(m) if m.contains("llm_calls limit 2")),
            "{err:?}"
        );

        let rows = consumed(&pool, community, agent, COUNTER_LLM_CALLS).await;
        let total: i64 = rows.iter().map(|r| r.1).sum();
        // day window row and week window row (they may be the same row when
        // the current week and day start together — Thursday 00:00 UTC).
        let expected: Vec<i64> =
            if budget_window_start("day", Utc::now()) == budget_window_start("week", Utc::now()) {
                vec![2]
            } else {
                vec![2, 2]
            };
        assert_eq!(
            rows.iter().map(|r| r.1).collect::<Vec<_>>(),
            expected,
            "each (counter, window) exactly once: {rows:?} total {total}"
        );

        pg_cleanup(&pool, community).await;
    }

    /// Item 7 (R2): the community default budget binds every REGISTERED AGENT
    /// without its own authority-signed budget for the counter — and never
    /// binds a human, an unregistered key, or an agent whose owner budgeted it.
    #[tokio::test]
    #[ignore = "requires migrated Postgres"]
    async fn default_budget_binds_agents_by_default_but_never_humans() {
        let (pool, community) = pg_pool().await;
        let tenant = tenant_of(community);
        let owner = [0x10u8; 32];
        let agent_a = [0x11u8; 32]; // no own budget -> default applies
        let agent_b = [0x12u8; 32]; // owner-signed own budget -> default displaced
        let human = [0x13u8; 32];
        let (a_hex, b_hex, h_hex) = (
            hex::encode(agent_a),
            hex::encode(agent_b),
            hex::encode(human),
        );
        pg_register_agent(&pool, community, agent_a, owner).await;
        pg_register_agent(&pool, community, agent_b, owner).await;
        pg_register_agent(&pool, community, human, human).await; // self-owned row is not an agent… see below
        sqlx::query(
            "UPDATE users SET agent_owner_pubkey = NULL WHERE community_id = $1 AND pubkey = $2",
        )
        .bind(community)
        .bind(human.as_slice())
        .execute(&pool)
        .await
        .expect("humans have no owner");

        // The default: 1 message per day, signed by the (admin) owner key.
        pg_insert_budget_event_by(
            &pool,
            community,
            [0xaau8; 32],
            serde_json::json!({
                "v": 1, "subject": "*", "window": "day",
                "limits": { "messages": 1 }, "onExceed": "reject",
            }),
        )
        .await;
        // agent_b's owner gave it 3 messages/day.
        pg_insert_budget_event_by(
            &pool,
            community,
            [0xaau8; 32],
            serde_json::json!({
                "v": 1, "subject": b_hex, "window": "day",
                "limits": { "messages": 3 }, "onExceed": "reject",
            }),
        )
        .await;
        let Some(state) = pg_app_state(&pool).await else {
            pg_cleanup(&pool, community).await;
            eprintln!("skipping: could not build AppState (config/media unavailable)");
            return;
        };

        // agent_a: default (1/day) applies.
        enforce_message_budget(&state, &tenant, &a_hex)
            .await
            .expect("agent a, message 1");
        let err = enforce_message_budget(&state, &tenant, &a_hex)
            .await
            .expect_err("the default budget must bind an agent with no budget of its own");
        assert!(
            matches!(&err, IngestError::Rejected(m) if m.contains("messages limit 1")),
            "{err:?}"
        );

        // agent_b: its own (3/day) governs, not the default (1/day).
        for n in 1..=3 {
            enforce_message_budget(&state, &tenant, &b_hex)
                .await
                .unwrap_or_else(|e| panic!("agent b message {n}: {e:?}"));
        }
        assert!(
            enforce_message_budget(&state, &tenant, &b_hex)
                .await
                .is_err(),
            "its own limit still binds"
        );

        // A human is never budget-capped, however many messages.
        for _ in 0..5 {
            enforce_message_budget(&state, &tenant, &h_hex)
                .await
                .expect("humans pass");
        }
        // Nor is a key the relay has never seen (no agent registration).
        let stranger = hex::encode([0x14u8; 32]);
        for _ in 0..5 {
            enforce_message_budget(&state, &tenant, &stranger)
                .await
                .expect("unregistered keys pass");
        }

        pg_cleanup(&pool, community).await;
    }

    /// The default fills per counter: an agent whose own budget does not
    /// define `messages` is still bound by the default's `messages`.
    #[tokio::test]
    #[ignore = "requires migrated Postgres"]
    async fn default_budget_fills_counters_the_own_budget_omits() {
        let (pool, community) = pg_pool().await;
        let tenant = tenant_of(community);
        let agent = [0x21u8; 32];
        let a_hex = hex::encode(agent);
        pg_register_agent(&pool, community, agent, [0x20u8; 32]).await;
        pg_insert_budget_event_by(
            &pool,
            community,
            [0xaau8; 32],
            serde_json::json!({
                "v": 1, "subject": "*", "window": "day",
                "limits": { "messages": 1, "runs": 9 }, "onExceed": "reject",
            }),
        )
        .await;
        pg_insert_budget_event_by(
            &pool,
            community,
            [0xaau8; 32],
            serde_json::json!({
                "v": 1, "subject": a_hex, "window": "day",
                "limits": { "runs": 50 }, "onExceed": "reject",
            }),
        )
        .await;
        let Some(state) = pg_app_state(&pool).await else {
            pg_cleanup(&pool, community).await;
            eprintln!("skipping: could not build AppState (config/media unavailable)");
            return;
        };
        enforce_message_budget(&state, &tenant, &a_hex)
            .await
            .expect("message 1");
        assert!(
            enforce_message_budget(&state, &tenant, &a_hex)
                .await
                .is_err(),
            "default messages limit binds"
        );
        // `runs` is governed by the agent's own budget (50), not the default (9).
        for _ in 0..10 {
            enforce_counter(&state, &tenant, &a_hex, "runs")
                .await
                .expect("own runs budget (50)");
        }
        pg_cleanup(&pool, community).await;
    }

    /// A subject-signed budget is additive: with NO authority-signed budget
    /// the default still applies next to it (the subject cannot displace it).
    #[tokio::test]
    #[ignore = "requires migrated Postgres"]
    async fn subject_signed_budget_never_displaces_the_default() {
        let (pool, community) = pg_pool().await;
        let tenant = tenant_of(community);
        let agent = [0x31u8; 32];
        let a_hex = hex::encode(agent);
        pg_register_agent(&pool, community, agent, [0x30u8; 32]).await;
        pg_insert_budget_event_by(
            &pool,
            community,
            [0xaau8; 32],
            serde_json::json!({
                "v": 1, "subject": "*", "window": "day",
                "limits": { "messages": 1 }, "onExceed": "reject",
            }),
        )
        .await;
        // The agent tries to loosen itself with a 1000/day budget of its own.
        pg_insert_budget_event_by(
            &pool,
            community,
            agent,
            serde_json::json!({
                "v": 1, "subject": a_hex, "window": "day",
                "limits": { "messages": 1000 }, "onExceed": "reject",
            }),
        )
        .await;
        let Some(state) = pg_app_state(&pool).await else {
            pg_cleanup(&pool, community).await;
            eprintln!("skipping: could not build AppState (config/media unavailable)");
            return;
        };
        enforce_message_budget(&state, &tenant, &a_hex)
            .await
            .expect("message 1");
        assert!(
            enforce_message_budget(&state, &tenant, &a_hex)
                .await
                .is_err(),
            "the subject's looser own budget must not displace the community default"
        );
        pg_cleanup(&pool, community).await;
    }

    /// Item 6, end to end through the production gate: 150 unrelated budgets
    /// (the newest rows) must not hide the subject's budget from enforcement.
    #[tokio::test]
    #[ignore = "requires migrated Postgres"]
    async fn junk_budgets_do_not_silently_disable_enforcement() {
        let (pool, community) = pg_pool().await;
        let tenant = tenant_of(community);
        let agent = "a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4";
        pg_insert_budget_event_by(
            &pool,
            community,
            [8u8; 32],
            serde_json::json!({
                "v": 1, "subject": agent, "window": "day",
                "limits": { "runs": 1 }, "onExceed": "reject",
            }),
        )
        .await;
        for i in 0..150u32 {
            pg_insert_budget_event_by(
                &pool,
                community,
                [9u8; 32],
                serde_json::json!({
                    "v": 1, "subject": format!("{i:064x}"), "window": "day",
                    "limits": { "runs": 1 }, "onExceed": "reject",
                }),
            )
            .await;
        }
        let Some(state) = pg_app_state(&pool).await else {
            pg_cleanup(&pool, community).await;
            eprintln!("skipping: could not build AppState (config/media unavailable)");
            return;
        };
        enforce_counter(&state, &tenant, agent, "runs")
            .await
            .expect("first run");
        assert!(
            enforce_counter(&state, &tenant, agent, "runs")
                .await
                .is_err(),
            "the subject's budget must still bind behind 150 newer unrelated budgets"
        );
        pg_cleanup(&pool, community).await;
    }

    /// Item 11: the LLM gateway's daily cap applies through the `llm_calls`
    /// counter when no budget covers the caller, and a budget's `llmCalls`
    /// governs when one does.
    /// LLM spend budgets: nothing is charged before the call, the real cost is
    /// charged after it, and once spend reaches the limit the next call is
    /// refused. Callers no budget bounds are not metered at all.
    #[tokio::test]
    #[ignore = "requires migrated Postgres"]
    async fn llm_cost_is_charged_after_the_call_and_bounds_the_next() {
        let (pool, community) = pg_pool().await;
        let tenant = tenant_of(community);
        let budgeted = "a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7";
        let unbounded = "a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8";
        // 1 cent per day = 1,000 milli-cents, hard reject.
        pg_insert_budget_event_by(
            &pool,
            community,
            [8u8; 32],
            serde_json::json!({
                "v": 1, "subject": budgeted, "window": "day",
                "limits": { "llmCostCents": 1 }, "onExceed": "reject",
            }),
        )
        .await;
        let Some(state) = pg_app_state(&pool).await else {
            pg_cleanup(&pool, community).await;
            eprintln!("skipping: could not build AppState (config/media unavailable)");
            return;
        };

        assert!(
            begin_llm_cost(&state, &tenant, unbounded)
                .await
                .expect("no budget bounds this caller")
                .is_none(),
            "a caller with no spend budget is not metered"
        );

        // Under the limit: admitted, and beginning consumes nothing by itself.
        let meter = begin_llm_cost(&state, &tenant, budgeted)
            .await
            .expect("first call is within budget")
            .expect("a budget bounds this caller");
        begin_llm_cost(&state, &tenant, budgeted)
            .await
            .expect("beginning a call never charges")
            .expect("still metered");

        // 600 milli-cents charged: still under 1,000, so another call may start.
        record_llm_cost(&state, &tenant, &meter, 600)
            .await
            .expect("record");
        let meter = begin_llm_cost(&state, &tenant, budgeted)
            .await
            .expect("600 of 1000 is within budget")
            .expect("metered");

        // The second call overshoots (600 + 600 = 1,200): allowed once, since
        // the cost is only known afterwards ...
        record_llm_cost(&state, &tenant, &meter, 600)
            .await
            .expect("record");
        // ... and then the next call is refused with a readable reason.
        let err = begin_llm_cost(&state, &tenant, budgeted)
            .await
            .expect_err("spend is at the limit");
        assert!(
            matches!(&err, IngestError::Rejected(m) if m.contains("LLM spend limit of 1 cents")),
            "{err:?}"
        );

        pg_cleanup(&pool, community).await;
    }

    #[tokio::test]
    #[ignore = "requires migrated Postgres"]
    async fn llm_daily_cap_falls_back_to_config_and_yields_to_a_budget() {
        let (pool, community) = pg_pool().await;
        let tenant = tenant_of(community);
        let plain = "a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5";
        let budgeted = "a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6";
        pg_insert_budget_event_by(
            &pool,
            community,
            [8u8; 32],
            serde_json::json!({
                "v": 1, "subject": budgeted, "window": "day",
                "limits": { "llmCalls": 3 }, "onExceed": "reject",
            }),
        )
        .await;
        let Some(state) = pg_app_state(&pool).await else {
            pg_cleanup(&pool, community).await;
            eprintln!("skipping: could not build AppState (config/media unavailable)");
            return;
        };

        // No budget: the config default (2/day here) applies.
        enforce_llm_call(&state, &tenant, plain, 2)
            .await
            .expect("call 1");
        enforce_llm_call(&state, &tenant, plain, 2)
            .await
            .expect("call 2");
        let err = enforce_llm_call(&state, &tenant, plain, 2)
            .await
            .expect_err("the config default caps a caller with no budget");
        assert!(
            matches!(&err, IngestError::Rejected(m) if m.contains("llm_calls limit 2")),
            "{err:?}"
        );

        // A budget with llmCalls governs (3), not the config default (2).
        for n in 1..=3 {
            enforce_llm_call(&state, &tenant, budgeted, 2)
                .await
                .unwrap_or_else(|e| panic!("budgeted call {n}: {e:?}"));
        }
        assert!(matches!(
            enforce_llm_call(&state, &tenant, budgeted, 2).await,
            Err(IngestError::Rejected(m)) if m.contains("llm_calls limit 3")
        ));
        pg_cleanup(&pool, community).await;
    }
}
