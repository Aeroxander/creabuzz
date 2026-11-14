//! Applying Buzz-authored work to Paperclip: the `apply` direction.
//!
//! A task row a community member authored in Buzz is an intent to create work.
//! This module turns that intent into a Paperclip issue and then keeps the
//! status in step, using the durable binding in [`SyncState::buzz_tasks`] so
//! one task is one issue and one Buzz row.
//!
//! The decision of *what* to do is a pure function ([`decide`]) so the risky
//! part - when to create, when to patch, when to do nothing - is testable
//! without a relay or a Paperclip instance.

use std::collections::BTreeMap;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::paperclip_write::{
    accept_created, to_paperclip_status, CreateIssue, IssueWriter, PatchIssue, WriteError,
};
use crate::state::SyncState;
use crate::{BridgeError, D_PREFIX};

/// A task row as the bridge reads it from Buzz.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuzzTask {
    /// The task's `d` tag value.
    pub d: String,
    /// Rendered title.
    pub title: String,
    /// Description body.
    #[serde(default)]
    pub description: String,
    /// Buzz task status.
    pub status: String,
    /// Assignee pubkey, when the row names one.
    #[serde(default)]
    pub assignee: Option<String>,
    /// Event id of the row, used as the idempotency key.
    pub event_id: String,
    /// Author pubkey.
    #[serde(default)]
    pub author: String,
    /// Row creation time, in seconds. Drives newest-row-wins.
    #[serde(default)]
    pub created_at: u64,
    /// True when the row was projected FROM Paperclip, which the bridge must
    /// never turn back into a new issue.
    #[serde(default)]
    pub projected: bool,
}

/// One read of Buzz task rows, plus whether the read is known complete.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskBatch {
    /// The rows read, newest-row-wins already applied.
    pub tasks: Vec<BuzzTask>,
    /// False when the feed stopped early — a relay timeout, an error, or a row
    /// cap — and there may be rows it never saw. A truncated read must never be
    /// mistaken for "these are all the tasks".
    pub complete: bool,
}

impl TaskBatch {
    /// A batch that read everything the source had.
    pub fn complete(tasks: Vec<BuzzTask>) -> Self {
        Self {
            tasks,
            complete: true,
        }
    }

    /// A batch that stopped early and may be missing rows.
    pub fn truncated(tasks: Vec<BuzzTask>) -> Self {
        Self {
            tasks,
            complete: false,
        }
    }
}

/// Where the bridge reads Buzz task rows from.
pub trait TaskFeed {
    /// Fetch task rows, optionally scoped to one channel and to rows newer than
    /// `since`.
    fn fetch_tasks(
        &self,
        channel: Option<&str>,
        since: Option<&str>,
    ) -> impl std::future::Future<Output = Result<TaskBatch, BridgeError>> + Send;
}

/// Apply-side configuration.
#[derive(Debug, Clone)]
pub struct ApplyConfig {
    /// Project new issues land in, when configured.
    pub project_id: Option<String>,
    /// Attempts per write before giving up.
    pub max_attempts: u32,
    /// Delay between attempts.
    pub retry_delay: Duration,
    /// Maps a Buzz pubkey to the Paperclip principal that should be assigned.
    pub assignee_by_npub: BTreeMap<String, String>,
    /// Maps a Buzz pubkey to the Paperclip principal whose work it is.
    ///
    /// The same identity map as [`ApplyConfig::assignee_by_npub`] is normally
    /// used for both: it maps a person (or agent) to their principal, and the
    /// role differs per field rather than per mapping.
    pub responsible_by_npub: BTreeMap<String, String>,
}

impl Default for ApplyConfig {
    fn default() -> Self {
        Self {
            project_id: None,
            max_attempts: 3,
            retry_delay: Duration::from_millis(250),
            assignee_by_npub: BTreeMap::new(),
            responsible_by_npub: BTreeMap::new(),
        }
    }
}

/// What the bridge intends to do with one task row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    /// Create a Paperclip issue for this task.
    Create {
        /// Mapped Paperclip status.
        status: &'static str,
        /// Resolved Paperclip assignee, when the map covers it.
        assignee: Option<String>,
        /// Resolved Paperclip principal whose work this is, when the author is
        /// mapped.
        responsible: Option<String>,
    },
    /// Move an already-linked issue to a new status.
    PatchStatus {
        /// Linked Paperclip issue.
        issue_id: String,
        /// Mapped Paperclip status.
        status: &'static str,
    },
    /// Nothing to do.
    Skip(SkipReason),
}

/// Why a task needs no action.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkipReason {
    /// The row came from the projection, so Paperclip already owns it.
    Projected,
    /// The row's `d` tag is in the projection's namespace (`paperclip:`), so an
    /// issue already exists for it even when the `source=paperclip` tag is
    /// missing (a status update published by another client omits it).
    ProjectedPrefix,
    /// The linked issue is already in the mapped status.
    AlreadyCurrent,
}

/// Resolve a task's assignee to a Paperclip principal id.
pub fn resolve_assignee(task: &BuzzTask, config: &ApplyConfig) -> Option<String> {
    task.assignee
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(|pubkey| config.assignee_by_npub.get(pubkey))
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
}

/// Resolve a task's author to the Paperclip principal whose work it is.
///
/// Returns `None` when the author is unmapped. The value is checked against
/// [`crate::paperclip_write::is_plausible_principal`] because Paperclip stores
/// whatever it is given, so an unchecked mapping would attribute work to a
/// principal that cannot be looked up.
pub fn resolve_author(task: &BuzzTask, config: &ApplyConfig) -> Option<String> {
    let pubkey = task.author.trim();
    if pubkey.is_empty() {
        return None;
    }
    config
        .responsible_by_npub
        .get(pubkey)
        .map(|id| id.trim().to_string())
        .filter(|id| crate::paperclip_write::is_plausible_principal(id))
}

/// Decide what to do with one task row. Pure.
pub fn decide(task: &BuzzTask, config: &ApplyConfig, state: &SyncState) -> Decision {
    if task.projected {
        return Decision::Skip(SkipReason::Projected);
    }
    // A `d` tag in the projection's namespace names a row the projection owns,
    // even when the `source=paperclip` tag is missing. That happens in practice:
    // an MCP `task_status` row takes the `d` tag verbatim and publishes without
    // a source tag, so without this guard it looks Buzz-authored, the binding
    // lookup misses, and the apply run mints a SECOND Paperclip issue that the
    // event-id idempotency key cannot dedupe (the key is the new row's id).
    if task.d.starts_with(D_PREFIX) {
        return Decision::Skip(SkipReason::ProjectedPrefix);
    }
    let assignee = resolve_assignee(task, config);
    let status = to_paperclip_status(&task.status, assignee.is_some());
    match state.buzz_tasks.get(&task.d) {
        None => Decision::Create {
            status,
            assignee,
            responsible: resolve_author(task, config),
        },
        Some(binding) => {
            if binding.last_status == status {
                Decision::Skip(SkipReason::AlreadyCurrent)
            } else {
                Decision::PatchStatus {
                    issue_id: binding.paperclip_issue_id.clone(),
                    status,
                }
            }
        }
    }
}

/// Outcome of one apply run.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyReport {
    /// Issues created.
    pub created: usize,
    /// Issues whose status was moved.
    pub patched: usize,
    /// Tasks that needed no work.
    pub skipped: usize,
    /// Tasks whose write ultimately failed.
    pub failures: usize,
    /// Whether this was a rehearsal.
    pub dry_run: bool,
    /// Tasks whose assignee could not be mapped to a Paperclip principal.
    pub unmapped_assignees: Vec<String>,
    /// Tasks whose author could not be mapped, so responsibility falls to the
    /// creating actor instead of the author.
    pub unmapped_authors: Vec<String>,
    /// Failure detail, as `<task>: <reason>`.
    pub failure_details: Vec<String>,
    /// True when the feed stopped early — relay timeout, read error, or the
    /// row cap — so the tasks acted on may be a subset of what exists. The run
    /// still applies what it read, but the report says the read was incomplete
    /// rather than letting an empty-looking pass read as "all quiet".
    pub feed_truncated: bool,
}

/// Apply Buzz work to Paperclip.
///
/// Retries only what a retry can fix: a transport failure, `409`, `429` or a
/// `5xx`. A terminal error is reported and the task is left unbound, so the next
/// run tries again rather than recording a half-applied state.
pub async fn run_apply<F, W>(
    feed: &F,
    writer: &W,
    config: &ApplyConfig,
    state: &mut SyncState,
    dry_run: bool,
) -> Result<ApplyReport, BridgeError>
where
    F: TaskFeed,
    W: IssueWriter,
{
    let batch = feed.fetch_tasks(None, None).await?;
    let mut report = ApplyReport {
        dry_run,
        feed_truncated: !batch.complete,
        ..ApplyReport::default()
    };

    for task in &batch.tasks {
        if task.assignee.is_some() && resolve_assignee(task, config).is_none() {
            report.unmapped_assignees.push(task.d.clone());
        }
        if !task.author.trim().is_empty() && resolve_author(task, config).is_none() {
            report.unmapped_authors.push(task.d.clone());
        }
        match decide(task, config, state) {
            Decision::Skip(_) => report.skipped += 1,
            Decision::Create {
                status,
                assignee,
                responsible,
            } => {
                let request = CreateIssue::with_responsible_user(
                    task.title.clone(),
                    task.description.clone(),
                    &task.status,
                    assignee.as_deref(),
                    config.project_id.clone(),
                    &task.event_id,
                    responsible.as_deref(),
                )?;
                debug_assert_eq!(request.status, status);
                if dry_run {
                    report.created += 1;
                    continue;
                }
                match create_with_retry(writer, &request, config).await {
                    Ok(issue_id) => {
                        state.bind_buzz_task(&task.d, &issue_id, status);
                        report.created += 1;
                    }
                    Err(error) => {
                        report.failures += 1;
                        report
                            .failure_details
                            .push(format!("{}: {}", task.d, error.label()));
                    }
                }
            }
            Decision::PatchStatus { issue_id, status } => {
                if dry_run {
                    report.patched += 1;
                    continue;
                }
                let patch = PatchIssue {
                    status: Some(status),
                    ..PatchIssue::default()
                };
                match patch_with_retry(writer, &issue_id, &patch, config).await {
                    Ok(()) => {
                        if let Some(binding) = state.buzz_tasks.get_mut(&task.d) {
                            binding.last_status = status.to_string();
                        }
                        report.patched += 1;
                    }
                    Err(error) => {
                        report.failures += 1;
                        report
                            .failure_details
                            .push(format!("{}: {}", task.d, error.label()));
                    }
                }
            }
        }
    }
    report.unmapped_assignees.sort();
    report.unmapped_assignees.dedup();
    report.unmapped_authors.sort();
    report.unmapped_authors.dedup();
    Ok(report)
}

async fn create_with_retry<W: IssueWriter>(
    writer: &W,
    request: &CreateIssue,
    config: &ApplyConfig,
) -> Result<String, WriteError> {
    let mut attempt = 0;
    loop {
        attempt += 1;
        match writer.create_issue(request).await {
            Ok(created) => match accept_created(&created) {
                Ok(id) => return Ok(id.to_string()),
                Err(error) => {
                    // A title-based dedupe is terminal: retrying cannot undo the
                    // binding Paperclip already made.
                    return Err(WriteError::Transport(error.to_string()));
                }
            },
            Err(error) if error.is_retryable() && attempt < config.max_attempts => {
                tracing::warn!(attempt, error = %error.label(), "retrying issue create");
                tokio::time::sleep(config.retry_delay).await;
            }
            Err(error) => return Err(error),
        }
    }
}

async fn patch_with_retry<W: IssueWriter>(
    writer: &W,
    issue_id: &str,
    patch: &PatchIssue,
    config: &ApplyConfig,
) -> Result<(), WriteError> {
    let mut attempt = 0;
    loop {
        attempt += 1;
        match writer.patch_issue(issue_id, patch).await {
            Ok(()) => return Ok(()),
            Err(error) if error.is_retryable() && attempt < config.max_attempts => {
                tracing::warn!(attempt, error = %error.label(), "retrying issue patch");
                tokio::time::sleep(config.retry_delay).await;
            }
            Err(error) => return Err(error),
        }
    }
}
