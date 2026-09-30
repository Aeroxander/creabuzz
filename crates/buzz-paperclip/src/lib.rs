//! Buzz <- Paperclip projection.
//!
//! This crate publishes Paperclip issues into a Buzz community as
//! `kind:44011` task rows, signed by a dedicated Buzz key. It is deliberately
//! one-directional: Paperclip stays the system of record for issues, and Buzz
//! carries a read model plus the conversation around it.
//!
//! Three properties the design protects, each with tests:
//!
//! * **Idempotent.** A row is published only when its mapped content actually
//!   changed, because `kind:44011` is not an addressable kind: every update is
//!   its own row, and readers apply last-write-wins.
//! * **Resumable.** The durable cursor only advances when every publish in the
//!   run succeeded. A partial failure must not skip work forever.
//! * **Truthful attribution.** The projection signs with its own key and never
//!   invents a pubkey for an unresolved assignee.

pub mod apply;
pub mod bridge;
pub mod feed;
pub mod invites;
pub mod paperclip_write;
pub mod relay;
pub mod source;
pub mod state;
pub mod tests_support;

use std::collections::BTreeMap;

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::source::Issue;

pub use crate::apply::{
    run_apply, ApplyConfig, ApplyReport, BuzzTask, Decision, SkipReason, TaskBatch, TaskFeed,
};
pub use crate::bridge::{run_bridge, BridgeConfig, BridgeReport, BridgeRun};
pub use crate::feed::{JsonFileTaskFeed, RelayTaskFeed};
pub use crate::invites::{
    invite_member, invite_message, CreatedInvite, InviteIssuer, InviteKind, InviteOutcome,
    InviteRequest, MessagePublisher, RelayMessagePublisher, RestInviteIssuer,
};
pub use crate::paperclip_write::{
    invert_assignee_map, CreateIssue, CreatedIssue, IssueWriter, PatchIssue, RestIssueWriter,
    WriteError,
};
pub use crate::relay::{
    build_task_event, DryRunPublisher, PublishOutcome, Publisher, RelayPublisher,
};
pub use crate::source::{IssueBatch, IssueSource, JsonFileSource, PaperclipRestSource};
pub use crate::state::{IssueState, SyncState, DEFAULT_OVERLAP_SECONDS};

/// The relay kind for a coordination task, from the single source of truth in
/// `buzz-core`.
pub const KIND_AGENT_TASK: u16 = buzz_core::kind::KIND_AGENT_TASK as u16;

/// Task statuses the Buzz readers understand, from the shared vocabulary in
/// `buzz-core` so every surface that writes a task row agrees.
pub use buzz_core::kind::TASK_STATUSES;

/// Status used when a source status is missing or unrecognised.
pub const DEFAULT_STATUS: &str = buzz_core::kind::DEFAULT_TASK_STATUS;

/// Priorities the Buzz readers understand.
pub use buzz_core::kind::TASK_PRIORITIES;

/// Priority used when a source priority is missing or unrecognised.
pub const DEFAULT_PRIORITY: &str = buzz_core::kind::DEFAULT_TASK_PRIORITY;

/// Tag naming the system that projected the row.
pub const TAG_SOURCE: &str = "source";
/// Value of [`TAG_SOURCE`] for this projection.
pub const TAG_SOURCE_PAPERCLIP: &str = "paperclip";
/// Tag carrying the source company id.
pub const TAG_COMPANY: &str = "paperclip-company";
/// Tag carrying the source issue id.
pub const TAG_ISSUE: &str = "paperclip-issue";
/// Tag carrying the source's last-modified stamp.
pub const TAG_UPDATED_AT: &str = "paperclip-updated-at";
/// Tag carrying an assignee we could not resolve to a Buzz key.
pub const TAG_ASSIGNEE: &str = "paperclip-assignee";
/// Tag carrying a link back to the issue in Paperclip.
pub const TAG_URL: &str = "paperclip-url";
/// Prefix applied to the `d` tag so projected rows are identifiable.
pub const D_PREFIX: &str = "paperclip:";

/// Failures this crate can produce. Every variant is terminal for the run
/// except [`BridgeError::Publish`], which is per-issue.
#[derive(Debug, thiserror::Error)]
pub enum BridgeError {
    /// Invalid configuration, such as an unparseable base URL.
    #[error("configuration error: {0}")]
    Config(String),
    /// The source could not be read.
    #[error("source error: {0}")]
    Source(String),
    /// The state file could not be read, parsed or written.
    #[error("state error: {0}")]
    State(String),
    /// A tag could not be built.
    #[error("invalid tag `{name}`: {reason}")]
    Tag {
        /// Tag name that failed.
        name: String,
        /// Underlying reason.
        reason: String,
    },
    /// The event could not be signed.
    #[error("cannot sign event: {0}")]
    Sign(String),
    /// The relay rejected or did not answer for one task row.
    #[error("publish failed: {0}")]
    Publish(String),
}

/// Static configuration for one projection run.
#[derive(Debug, Clone, Default)]
pub struct ProjectionConfig {
    /// Paperclip company whose issues are projected.
    pub company_id: String,
    /// Buzz channel the task rows are scoped to, via the `h` tag.
    pub channel_id: Option<String>,
    /// Paperclip dashboard base URL, used to build a link-back tag.
    pub dashboard_url: Option<String>,
    /// Maps a Paperclip assignee principal id to a 64-hex Buzz public key.
    pub assignee_map: BTreeMap<String, String>,
}

impl ProjectionConfig {
    /// Load an assignee map from JSON (`{"<paperclip id>": "<hex pubkey>"}`).
    ///
    /// An entry whose value is not a 64-character hex public key is an error
    /// rather than a silent omission: a typo here would quietly strip the
    /// assignee from every projected task.
    pub fn load_assignee_map(
        path: &std::path::Path,
    ) -> Result<BTreeMap<String, String>, BridgeError> {
        let text = std::fs::read_to_string(path).map_err(|error| {
            BridgeError::Config(format!(
                "cannot read assignee map {}: {error}",
                path.display()
            ))
        })?;
        let map: BTreeMap<String, String> = serde_json::from_str(&text).map_err(|error| {
            BridgeError::Config(format!(
                "assignee map {} is not valid JSON: {error}",
                path.display()
            ))
        })?;
        for (principal, pubkey) in &map {
            if !is_hex_pubkey(pubkey) {
                return Err(BridgeError::Config(format!(
                    "assignee map {} maps `{principal}` to `{pubkey}`, which is not a 64-character \
                     hex public key",
                    path.display()
                )));
            }
        }
        Ok(map)
    }
}

/// Whether `value` is a 64-character hex public key.
pub fn is_hex_pubkey(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// Translate a source status into the Buzz task-status vocabulary.
///
/// Returns the mapped status and whether the input was recognised. An
/// unrecognised status maps to [`DEFAULT_STATUS`] so a row still appears; the
/// caller reports it instead of dropping the issue.
pub fn map_status(raw: &str) -> (&'static str, bool) {
    let normalised = raw.trim().to_ascii_lowercase().replace([' ', '-'], "_");
    match normalised.as_str() {
        "open" | "todo" | "backlog" | "new" | "triage" | "planning" | "ready" => ("open", true),
        "assigned" => ("assigned", true),
        "in_progress" | "inprogress" | "started" | "doing" | "running" | "in_review" => {
            ("in_progress", true)
        }
        "needs_approval" | "pending_approval" | "waiting_approval" | "approval" | "blocked" => {
            ("needs_approval", true)
        }
        "done" | "complete" | "completed" | "closed" | "merged" | "resolved" => ("done", true),
        "cancelled" | "canceled" | "wontfix" | "won_t_fix" | "rejected" | "abandoned" => {
            ("cancelled", true)
        }
        _ => (DEFAULT_STATUS, false),
    }
}

/// Translate a source priority into the Buzz task-priority vocabulary.
///
/// Returns the mapped priority and whether the input was recognised.
pub fn map_priority(raw: &str) -> (&'static str, bool) {
    let normalised = raw.trim().to_ascii_lowercase();
    match normalised.as_str() {
        "low" | "minor" | "p3" | "p4" => ("low", true),
        "normal" | "medium" | "med" | "default" | "none" | "p2" => ("normal", true),
        "high" | "major" | "p1" => ("high", true),
        "urgent" | "critical" | "blocker" | "highest" | "p0" => ("urgent", true),
        _ => (DEFAULT_PRIORITY, false),
    }
}

/// One issue mapped onto the wire shape Buzz readers expect.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MappedTask {
    /// The `d` tag value: `paperclip:<issue id>`.
    pub d: String,
    /// The event content: JSON with the fields the Buzz readers consume.
    pub content: String,
    /// Tags as ordered name/value lists, in publish order.
    pub tags: Vec<Vec<String>>,
    /// Mapped Buzz status.
    pub status: String,
    /// SHA-256 of content plus tags, used for change detection.
    pub hash: String,
    /// Source assignee we could not resolve to a Buzz key, when any.
    pub unresolved_assignee: Option<String>,
    /// Whether the source status was unrecognised.
    pub status_unrecognized: bool,
    /// Whether the source priority was unrecognised.
    pub priority_unrecognized: bool,
}

impl MappedTask {
    /// Read a tag value by name.
    pub fn tag(&self, name: &str) -> Option<&str> {
        self.tags
            .iter()
            .find(|tag| tag.first().map(String::as_str) == Some(name))
            .and_then(|tag| tag.get(1))
            .map(String::as_str)
    }
}

/// Rewrite a mapped task's `d` tag, keeping the hash in step.
///
/// A task a community member created in Buzz must keep the `d` tag it was
/// authored under once Paperclip owns it, otherwise the projection publishes a
/// *second* row for the same work and the board shows it twice.
pub fn remap_task_d(task: &mut MappedTask, d: &str) {
    if task.d == d {
        return;
    }
    for tag in task.tags.iter_mut() {
        if tag.first().map(String::as_str) == Some("d") && tag.len() > 1 {
            tag[1] = d.to_string();
        }
    }
    task.d = d.to_string();
    task.hash = content_hash(&task.content, &task.tags);
}

/// Map one issue onto a task row.
///
/// This is the production mapping seam: the integration tests assert its exact
/// output, so a regression here fails a test rather than silently changing what
/// every Buzz client renders.
pub fn map_issue(issue: &Issue, config: &ProjectionConfig) -> MappedTask {
    let (status, status_recognized) = map_status(issue.status.as_deref().unwrap_or_default());
    let (priority, priority_recognized) =
        map_priority(issue.priority.as_deref().unwrap_or_default());
    let due = issue.due_date.as_deref().and_then(parse_unix_seconds);
    let d = format!("{D_PREFIX}{}", issue.id);

    let assignee_raw = issue.assignee_id().map(str::to_string);
    let resolved_assignee = assignee_raw
        .as_deref()
        .and_then(|raw| config.assignee_map.get(raw))
        .filter(|pubkey| is_hex_pubkey(pubkey))
        .cloned();

    let mut content = serde_json::json!({
        "title": issue.display_title(),
        "description": issue.description.clone().unwrap_or_default(),
        "status": status,
        "priority": priority,
    });
    if let Some(object) = content.as_object_mut() {
        if let Some(due) = due {
            object.insert("due".to_string(), serde_json::json!(due));
        }
        if let Some(labels) = issue.labels.as_ref().filter(|labels| !labels.is_empty()) {
            object.insert("labels".to_string(), serde_json::json!(labels));
        }
        // Provenance the Buzz readers ignore but humans and later tooling need.
        object.insert(
            "paperclip".to_string(),
            serde_json::json!({
                "companyId": config.company_id,
                "issueId": issue.id,
                "identifier": issue.identifier,
                "projectId": issue.project_id,
                "parentId": issue.parent_id,
                "assignee": assignee_raw,
                "updatedAt": issue.updated_at,
            }),
        );
    }
    let content = content.to_string();

    let mut tags: Vec<Vec<String>> = vec![vec!["d".to_string(), d.clone()]];
    if let Some(channel) = config.channel_id.as_deref().filter(|v| !v.is_empty()) {
        tags.push(vec!["h".to_string(), channel.to_string()]);
    }
    if let Some(pubkey) = resolved_assignee.as_ref() {
        tags.push(vec!["p".to_string(), pubkey.clone()]);
    }
    tags.push(vec![
        TAG_SOURCE.to_string(),
        TAG_SOURCE_PAPERCLIP.to_string(),
    ]);
    tags.push(vec![TAG_COMPANY.to_string(), config.company_id.clone()]);
    tags.push(vec![TAG_ISSUE.to_string(), issue.id.clone()]);
    if let Some(updated_at) = issue.updated_at.as_deref().filter(|v| !v.is_empty()) {
        tags.push(vec![TAG_UPDATED_AT.to_string(), updated_at.to_string()]);
    }
    if let Some(raw) = assignee_raw.as_deref() {
        tags.push(vec![TAG_ASSIGNEE.to_string(), raw.to_string()]);
    }
    if let Some(url) = issue_url(issue, config) {
        tags.push(vec![TAG_URL.to_string(), url]);
    }

    let hash = content_hash(&content, &tags);
    MappedTask {
        d,
        content,
        tags,
        status: status.to_string(),
        hash,
        unresolved_assignee: assignee_raw.filter(|_| resolved_assignee.is_none()),
        status_unrecognized: !status_recognized,
        priority_unrecognized: !priority_recognized,
    }
}

fn issue_url(issue: &Issue, config: &ProjectionConfig) -> Option<String> {
    let base = config.dashboard_url.as_deref()?.trim_end_matches('/');
    if base.is_empty() {
        return None;
    }
    let identifier = issue
        .identifier
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(issue.id.as_str());
    Some(format!("{base}/issues/{identifier}"))
}

/// SHA-256 over the content and the rendered tags.
///
/// Tag order is normalised so unrelated ordering changes do not look like an
/// edit and cause a spurious republish.
pub fn content_hash(content: &str, tags: &[Vec<String>]) -> String {
    let mut normalised: Vec<String> = tags.iter().map(|tag| tag.join("\u{1f}")).collect();
    normalised.sort();
    const FIELD_SEPARATOR: u8 = 0x1e;
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    for tag in normalised {
        hasher.update([FIELD_SEPARATOR]);
        hasher.update(tag.as_bytes());
    }
    hex::encode(hasher.finalize())
}

/// Parse an ISO-8601 stamp into Unix seconds.
///
/// Returns `None` for anything unparseable: a bad due date must not fail the
/// run, and the readers treat a missing `due` as "no due date".
pub fn parse_unix_seconds(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value.trim())
        .ok()
        .map(|stamp| stamp.timestamp())
}

/// Why a task is being published.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PublishReason {
    /// The issue has never been projected.
    New,
    /// Mapped content changed but the status did not.
    ContentChanged,
    /// The mapped status changed.
    StatusChanged,
}

/// A task selected for publishing this run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PlannedTask {
    /// The mapped task row.
    pub task: MappedTask,
    /// Why it is being published.
    pub reason: PublishReason,
}

/// What a run intends to do, computed without any I/O.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Plan {
    /// Rows to publish, in source order.
    pub to_publish: Vec<PlannedTask>,
    /// Issues whose mapped content is unchanged.
    pub skipped: usize,
    /// Source assignees that could not be resolved to a Buzz key.
    pub unresolved_assignees: Vec<String>,
    /// Source statuses that were not recognised.
    pub unrecognized_statuses: Vec<String>,
    /// Source priorities that were not recognised.
    pub unrecognized_priorities: Vec<String>,
    /// Highest source `updatedAt` observed in this run.
    pub max_updated_at: Option<String>,
}

impl Plan {
    /// Whether this plan has no work to do.
    pub fn is_empty(&self) -> bool {
        self.to_publish.is_empty()
    }
}

/// Decide what to publish. Pure: no network, no filesystem, no clock.
pub fn plan(issues: &[Issue], config: &ProjectionConfig, state: &SyncState) -> Plan {
    let mut plan = Plan::default();
    // Issues a community member created in Buzz keep the Buzz row's `d` tag, so
    // one task stays one row instead of gaining a second projected row.
    let buzz_d_by_issue: BTreeMap<&str, &str> = state
        .buzz_tasks
        .iter()
        .map(|(d, binding)| (binding.paperclip_issue_id.as_str(), d.as_str()))
        .collect();
    for issue in issues {
        let mut task = map_issue(issue, config);
        if let Some(d) = buzz_d_by_issue.get(issue.id.as_str()) {
            remap_task_d(&mut task, d);
        }
        if let Some(unresolved) = task.unresolved_assignee.clone() {
            plan.unresolved_assignees.push(unresolved);
        }
        if task.status_unrecognized {
            plan.unrecognized_statuses.push(format!(
                "{}:{}",
                issue.id,
                issue.status.as_deref().unwrap_or("<missing>")
            ));
        }
        if task.priority_unrecognized {
            plan.unrecognized_priorities.push(format!(
                "{}:{}",
                issue.id,
                issue.priority.as_deref().unwrap_or("<missing>")
            ));
        }
        if let Some(updated_at) = issue.updated_at.as_deref().filter(|v| !v.is_empty()) {
            plan.max_updated_at = max_stamp(plan.max_updated_at.take(), updated_at);
        }
        match state.issues.get(&task.d) {
            None => plan.to_publish.push(PlannedTask {
                task,
                reason: PublishReason::New,
            }),
            Some(previous) => {
                if previous.hash == task.hash {
                    plan.skipped += 1;
                } else {
                    let reason = if previous.status == task.status {
                        PublishReason::ContentChanged
                    } else {
                        PublishReason::StatusChanged
                    };
                    plan.to_publish.push(PlannedTask { task, reason });
                }
            }
        }
    }
    plan.unresolved_assignees.sort();
    plan.unresolved_assignees.dedup();
    plan.unrecognized_statuses.sort();
    plan.unrecognized_statuses.dedup();
    plan.unrecognized_priorities.sort();
    plan.unrecognized_priorities.dedup();
    plan
}

fn max_stamp(current: Option<String>, candidate: &str) -> Option<String> {
    match current {
        None => Some(candidate.to_string()),
        Some(current) => {
            let current_key = parse_unix_seconds(&current);
            let candidate_key = parse_unix_seconds(candidate);
            let newer = match (current_key, candidate_key) {
                (_, None) => false,
                (None, Some(_)) => true,
                (Some(left), Some(right)) => right > left,
            };
            Some(if newer {
                candidate.to_string()
            } else {
                current
            })
        }
    }
}

/// Outcome of one projection run.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    /// Rows published for the first time.
    pub created: usize,
    /// Rows republished because their content or status changed.
    pub updated: usize,
    /// Issues already up to date.
    pub skipped: usize,
    /// Rows the relay refused, or publishes that errored.
    pub failures: usize,
    /// Whether the projection ran without publishing anything.
    pub dry_run: bool,
    /// Source assignees with no Buzz key mapping.
    pub unresolved_assignees: Vec<String>,
    /// Unrecognised source statuses, as `<issue id>:<raw status>`.
    pub unrecognized_statuses: Vec<String>,
    /// Unrecognised source priorities, as `<issue id>:<raw priority>`.
    pub unrecognized_priorities: Vec<String>,
    /// Incremental cursor used for this run, when one existed.
    pub cursor_used: Option<String>,
    /// Wall-clock scan start stored after this run.
    pub last_scan_started_at: Option<String>,
    /// Whether the cursor advanced in this run.
    pub cursor_advanced: bool,
    /// Whether the source read stopped early, so the projection saw only part
    /// of the source. A truncated read never advances the cursor.
    pub source_truncated: bool,
}

/// Build the incremental cursor for a run: the stored scan start minus the
/// overlap.
///
/// Returns `None` (meaning "scan everything") when nothing is stored, and also
/// when the stored stamp cannot be parsed: an unreadable cursor must never be
/// treated as up to date, because that would skip work forever.
pub fn incremental_since(
    last_scan_started_at: Option<&str>,
    overlap_seconds: u64,
) -> Option<String> {
    let stored = last_scan_started_at?;
    let parsed = chrono::DateTime::parse_from_rfc3339(stored.trim()).ok()?;
    let overlap = chrono::Duration::seconds(overlap_seconds.min(i64::MAX as u64) as i64);
    Some((parsed - overlap).to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

/// Fetch, map, publish, and record.
///
/// The cursor is a wall-clock scan start, not the maximum `updatedAt` seen:
/// Paperclip filters on `updated_at` but orders by a different expression, so a
/// maximum-stamp cursor silently drops issues that share a timestamp across a
/// page boundary. The cursor advances only when nothing failed **and** the read
/// was complete; either problem means the next run repeats the work instead of
/// skipping it forever.
pub async fn run_once<S, P>(
    source: &S,
    publisher: &P,
    config: &ProjectionConfig,
    state: &mut SyncState,
    scan_started_at: &str,
    dry_run: bool,
) -> Result<SyncReport, BridgeError>
where
    S: IssueSource,
    P: Publisher,
{
    let cursor = incremental_since(state.last_scan_started_at.as_deref(), state.overlap_seconds);
    let batch = source.fetch_issues(cursor.as_deref()).await?;
    if batch.truncated {
        tracing::warn!("the source read stopped early, so the cursor will not advance this run");
    }
    let plan = plan(&batch.issues, config, state);
    let mut report = SyncReport {
        skipped: plan.skipped,
        dry_run,
        unresolved_assignees: plan.unresolved_assignees.clone(),
        unrecognized_statuses: plan.unrecognized_statuses.clone(),
        unrecognized_priorities: plan.unrecognized_priorities.clone(),
        cursor_used: cursor,
        source_truncated: batch.truncated,
        ..SyncReport::default()
    };

    for planned in &plan.to_publish {
        match publisher.publish_task(&planned.task).await {
            Ok(outcome) if outcome.accepted => {
                match planned.reason {
                    PublishReason::New => report.created += 1,
                    PublishReason::ContentChanged | PublishReason::StatusChanged => {
                        report.updated += 1
                    }
                }
                if !dry_run {
                    state.record(
                        &planned.task.d,
                        &planned.task.hash,
                        &planned.task.status,
                        outcome.event_id,
                    );
                }
            }
            Ok(outcome) => {
                report.failures += 1;
                tracing::warn!(
                    task = %planned.task.d,
                    message = %outcome.message,
                    "relay did not accept the projected task row"
                );
            }
            Err(error) => {
                report.failures += 1;
                tracing::warn!(task = %planned.task.d, error = %error, "publish failed");
            }
        }
    }

    if !dry_run && report.failures == 0 && !batch.truncated {
        report.cursor_advanced = state.last_scan_started_at.as_deref() != Some(scan_started_at);
        state.last_scan_started_at = Some(scan_started_at.to_string());
    }
    report.last_scan_started_at = state.last_scan_started_at.clone();
    Ok(report)
}
