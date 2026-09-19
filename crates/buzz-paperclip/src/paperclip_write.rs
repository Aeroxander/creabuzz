//! Writing to Paperclip: the issue create and update calls the bridge needs.
//!
//! Verified against Paperclip at `84fe899` from route, validator and service
//! source (see `issues-api/issues-write-contract.md`):
//!
//! * `POST /api/companies/{companyId}/issues` with `Authorization: Bearer
//!   <board key>`. `title` is the only required field.
//! * Retries are safe: `idempotencyKey` is a **body** field (there is no header
//!   for it), scoped per company, kept 7 days, and a replay answers `200` with
//!   the original issue plus `deduplicated: true` - never `409`.
//! * `PATCH /api/issues/{id}` carries status and assignment. There is **no
//!   optimistic concurrency**: a stale write wins silently.
//! * `POST /api/issues/{id}/comments` takes `body` and an optional
//!   `clientRequestId`.
//!
//! Two hazards shape this module, and both are guarded here rather than left to
//! the caller:
//!
//! 1. **The recent-title dedupe.** With `allowDuplicate` unset, a create whose
//!    title matches an open issue in the same company and parent created within
//!    48 hours is answered `200` with *that* issue's id, and the server then
//!    binds the idempotency key to the wrong issue. Every create therefore sets
//!    `allowDuplicate: true`, and a `recent_open_title` dedupe reason is a hard
//!    failure.
//! 2. **The empty assignee.** `assigneeUserId: ""` is accepted and stored as an
//!    empty string. An unresolved assignee is omitted entirely instead.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::BridgeError;

/// Paperclip's issue statuses, as the write validator accepts them.
pub const PAPERCLIP_STATUSES: [&str; 7] = [
    "backlog",
    "todo",
    "in_progress",
    "in_review",
    "done",
    "blocked",
    "cancelled",
];

/// Translate a Buzz task status into a Paperclip issue status.
///
/// `has_assignee` matters because Paperclip defaults an assigned issue to
/// `todo` and an unassigned one to `backlog`, and because `in_progress` on an
/// unassigned issue is rejected with `422`: an unassigned in-progress task is
/// reported as `todo` instead of sending a request that cannot succeed.
pub fn to_paperclip_status(buzz_status: &str, has_assignee: bool) -> &'static str {
    match buzz_status.trim().to_ascii_lowercase().as_str() {
        "assigned" | "in_progress" | "done" | "cancelled" => {
            match buzz_status.trim().to_ascii_lowercase().as_str() {
                "assigned" => "todo",
                "in_progress" => {
                    if has_assignee {
                        "in_progress"
                    } else {
                        "todo"
                    }
                }
                "done" => "done",
                _ => "cancelled",
            }
        }
        "needs_approval" => "in_review",
        // open, or anything unrecognised: the backlog is where unassigned work
        // belongs, and it matches Paperclip's own default.
        _ => "backlog",
    }
}

/// Which assignment field a Paperclip principal id belongs in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AssigneeField {
    /// `assigneeAgentId` - a UUID referencing an agent.
    Agent,
    /// `assigneeUserId` - a free-text user principal id.
    User,
}

/// Decide which assignment field an id belongs in.
///
/// Agents are UUID-keyed and user ids are free text, so a UUID is treated as an
/// agent and anything else as a user. Getting this wrong is loud (Paperclip
/// rejects an unknown id) rather than silent.
pub fn assignee_field(id: &str) -> AssigneeField {
    if uuid::Uuid::parse_str(id.trim()).is_ok() {
        AssigneeField::Agent
    } else {
        AssigneeField::User
    }
}

/// Whether a value looks like a Paperclip principal id.
///
/// Paperclip does not check this itself, so the bridge does: a value that is
/// blank, absurdly long, or contains whitespace is not an identity, and writing
/// it would attribute work to something that cannot be looked up.
pub fn is_plausible_principal(value: &str) -> bool {
    let trimmed = value.trim();
    !trimmed.is_empty() && trimmed.len() <= 128 && !trimmed.chars().any(char::is_whitespace)
}

/// The idempotency key for a Buzz task row.
///
/// Derived from the Buzz event id, so replaying the same row after a failure
/// reuses the same key and Paperclip answers with the original issue.
pub fn idempotency_key(event_id: &str) -> String {
    format!("buzz:{}", event_id.trim())
}

/// A create request, already normalised.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateIssue {
    /// Issue title.
    pub title: String,
    /// Issue body.
    pub description: String,
    /// Paperclip status.
    pub status: &'static str,
    /// Owning project, when configured.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    /// Agent assignee, when resolvable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assignee_agent_id: Option<String>,
    /// User assignee, when resolvable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assignee_user_id: Option<String>,
    /// The Paperclip principal whose work this is.
    ///
    /// Verified live: Paperclip accepts **any** string here and stores it as-is,
    /// so a bad mapping silently attributes work to a principal that does not
    /// exist. The bridge therefore resolves this only from an explicit identity
    /// map and refuses implausible values.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub responsible_user_id: Option<String>,
    /// Stable retry key.
    pub idempotency_key: String,
    /// Always true: see the module note about the recent-title dedupe.
    pub allow_duplicate: bool,
}

impl CreateIssue {
    /// Build a create request, refusing to send an empty assignee.
    pub fn new(
        title: impl Into<String>,
        description: impl Into<String>,
        buzz_status: &str,
        assignee: Option<&str>,
        project_id: Option<String>,
        event_id: &str,
    ) -> Result<Self, BridgeError> {
        Self::with_responsible_user(
            title,
            description,
            buzz_status,
            assignee,
            project_id,
            event_id,
            None,
        )
    }

    /// Build a create request with an explicit responsible principal.
    #[allow(clippy::too_many_arguments)]
    pub fn with_responsible_user(
        title: impl Into<String>,
        description: impl Into<String>,
        buzz_status: &str,
        assignee: Option<&str>,
        project_id: Option<String>,
        event_id: &str,
        responsible_user_id: Option<&str>,
    ) -> Result<Self, BridgeError> {
        let assignee = assignee.map(str::trim).filter(|value| !value.is_empty());
        let status = to_paperclip_status(buzz_status, assignee.is_some());
        let (assignee_agent_id, assignee_user_id) = match assignee {
            Some(id) => match assignee_field(id) {
                AssigneeField::Agent => (Some(id.to_string()), None),
                AssigneeField::User => (None, Some(id.to_string())),
            },
            None => (None, None),
        };
        Ok(Self {
            title: title.into(),
            description: description.into(),
            status,
            project_id,
            assignee_agent_id,
            assignee_user_id,
            responsible_user_id: responsible_user_id
                .map(str::trim)
                .filter(|value| is_plausible_principal(value))
                .map(str::to_string),
            idempotency_key: idempotency_key(event_id),
            allow_duplicate: true,
        })
    }
}

/// A field update on an existing issue.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchIssue {
    /// New status.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<&'static str>,
    /// New agent assignee.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assignee_agent_id: Option<String>,
    /// New user assignee.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assignee_user_id: Option<String>,
}

/// What Paperclip returned for a create.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedIssue {
    /// Issue id, as Paperclip assigned it.
    pub id: String,
    /// True when Paperclip recognised the idempotency key.
    #[serde(default)]
    pub deduplicated: Option<bool>,
    /// Why Paperclip deduplicated, when it did.
    #[serde(default)]
    pub deduplication_reason: Option<String>,
}

/// The dedupe reason that means "we matched an unrelated recent issue".
pub const REASON_RECENT_OPEN_TITLE: &str = "recent_open_title";

/// Check a create response for the trap it must never accept silently.
///
/// A title-based dedupe means the returned issue is *not* ours; Paperclip has
/// already bound our idempotency key to it. Accepting it would write Buzz work
/// into someone else's issue forever.
pub fn accept_created(created: &CreatedIssue) -> Result<&str, BridgeError> {
    if created.deduplication_reason.as_deref() == Some(REASON_RECENT_OPEN_TITLE) {
        return Err(BridgeError::Source(format!(
            "Paperclip matched issue {} by recent title instead of creating a new issue; \
             refusing to bind this task to it",
            created.id
        )));
    }
    Ok(created.id.as_str())
}

/// A failed write, classified for the retry decision.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WriteError {
    /// The request never completed (connection, timeout, body read).
    Transport(String),
    /// Paperclip answered with a status code.
    Status {
        /// HTTP status.
        code: u16,
        /// Paperclip's machine-readable code, when present.
        code_name: Option<String>,
        /// Human-readable detail.
        message: String,
    },
}

impl WriteError {
    /// Whether retrying the same request can succeed.
    ///
    /// Retryable: a transport failure, `409` (run lock), `429` (rate/cap) and
    /// `5xx`. Terminal: `400`, `401`, `403`, `404`, `422` - a retry cannot fix
    /// bad input, missing authority or a missing entity.
    pub fn is_retryable(&self) -> bool {
        match self {
            WriteError::Transport(_) => true,
            WriteError::Status { code, .. } => {
                matches!(*code, 409 | 429) || (500..600).contains(code)
            }
        }
    }

    /// A short label for the run report.
    pub fn label(&self) -> String {
        match self {
            WriteError::Transport(message) => format!("transport: {message}"),
            WriteError::Status {
                code, code_name, ..
            } => match code_name {
                Some(name) => format!("http {code} ({name})"),
                None => format!("http {code}"),
            },
        }
    }
}

/// Normalise a credential: blank means "send no Authorization header".
///
/// Verified live against a `local_trusted` instance: a request with **no**
/// credential is served by the implicit `local-board` actor, while an unknown
/// bearer is rejected with `401`. Sending an empty key would therefore break a
/// local instance that would otherwise work.
pub fn normalize_api_key(raw: String) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Where the bridge writes issues.
pub trait IssueWriter {
    /// Create an issue.
    fn create_issue(
        &self,
        request: &CreateIssue,
    ) -> impl std::future::Future<Output = Result<CreatedIssue, WriteError>> + Send;

    /// Update an existing issue.
    fn patch_issue(
        &self,
        issue_id: &str,
        patch: &PatchIssue,
    ) -> impl std::future::Future<Output = Result<(), WriteError>> + Send;

    /// Add a comment.
    fn add_comment(
        &self,
        issue_id: &str,
        body: &str,
        client_request_id: &str,
    ) -> impl std::future::Future<Output = Result<(), WriteError>> + Send;
}

/// Talks to a Paperclip instance over HTTP with a board key.
#[derive(Debug, Clone)]
pub struct RestIssueWriter {
    base_url: String,
    company_id: String,
    /// Credential to send, or `None` to send none at all. See
    /// [`normalize_api_key`].
    api_key: Option<String>,
    client: reqwest::Client,
}

impl RestIssueWriter {
    /// Build a writer for one company.
    pub fn new(
        base_url: impl Into<String>,
        company_id: impl Into<String>,
        api_key: impl Into<String>,
    ) -> Result<Self, BridgeError> {
        let base_url = base_url.into();
        url::Url::parse(&base_url).map_err(|error| {
            BridgeError::Config(format!("invalid Paperclip base URL {base_url}: {error}"))
        })?;
        Ok(Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            company_id: company_id.into(),
            api_key: normalize_api_key(api_key.into()),
            client: reqwest::Client::new(),
        })
    }

    async fn send(
        &self,
        request: reqwest::RequestBuilder,
    ) -> Result<serde_json::Value, WriteError> {
        let mut request = request.header("accept", "application/json");
        if let Some(api_key) = self.api_key.as_deref() {
            request = request.bearer_auth(api_key);
        }
        let response = request
            .send()
            .await
            .map_err(|error| WriteError::Transport(error.to_string()))?;
        let status = response.status().as_u16();
        let body = response.text().await.map_err(|error| {
            WriteError::Transport(format!("cannot read response body: {error}"))
        })?;
        if !(200..300).contains(&status) {
            let parsed: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
            return Err(WriteError::Status {
                code: status,
                code_name: parsed
                    .get("code")
                    .and_then(|value| value.as_str())
                    .map(str::to_string),
                message: parsed
                    .get("error")
                    .and_then(|value| value.as_str())
                    .map(str::to_string)
                    .unwrap_or_else(|| body.chars().take(200).collect()),
            });
        }
        Ok(serde_json::from_str(&body).unwrap_or(serde_json::Value::Null))
    }
}

impl IssueWriter for RestIssueWriter {
    async fn create_issue(&self, request: &CreateIssue) -> Result<CreatedIssue, WriteError> {
        let url = format!("{}/api/companies/{}/issues", self.base_url, self.company_id);
        let body = self.send(self.client.post(&url).json(request)).await?;
        serde_json::from_value(body)
            .map_err(|error| WriteError::Transport(format!("unexpected create response: {error}")))
    }

    async fn patch_issue(&self, issue_id: &str, patch: &PatchIssue) -> Result<(), WriteError> {
        let url = format!("{}/api/issues/{}", self.base_url, issue_id);
        self.send(self.client.patch(&url).json(patch))
            .await
            .map(|_| ())
    }

    async fn add_comment(
        &self,
        issue_id: &str,
        body: &str,
        client_request_id: &str,
    ) -> Result<(), WriteError> {
        let url = format!("{}/api/issues/{}/comments", self.base_url, issue_id);
        let payload = serde_json::json!({
            "body": body,
            "clientRequestId": client_request_id,
        });
        self.send(self.client.post(&url).json(&payload))
            .await
            .map(|_| ())
    }
}

/// An in-memory writer used by tests and by `--dry-run`.
#[derive(Debug, Default)]
pub struct RecordingWriter {
    creates: std::sync::Mutex<Vec<CreateIssue>>,
    patches: std::sync::Mutex<Vec<(String, PatchIssue)>>,
    comments: std::sync::Mutex<Vec<String>>,
    next_id: std::sync::Mutex<u32>,
    fail_next: std::sync::Mutex<Option<WriteError>>,
}

impl RecordingWriter {
    /// A writer that accepts everything.
    pub fn new() -> Self {
        Self::default()
    }

    /// Make the next call fail with `error`.
    pub fn failing_once(error: WriteError) -> Self {
        let writer = Self::new();
        *writer.fail_next.lock().expect("lock") = Some(error);
        writer
    }

    /// Creates seen, in order.
    pub fn creates(&self) -> Vec<CreateIssue> {
        self.creates.lock().expect("lock").clone()
    }

    /// Patches seen, in order.
    pub fn patches(&self) -> Vec<(String, PatchIssue)> {
        self.patches.lock().expect("lock").clone()
    }

    /// Comment bodies seen, in order.
    pub fn comments(&self) -> Vec<String> {
        self.comments.lock().expect("lock").clone()
    }

    fn take_failure(&self) -> Option<WriteError> {
        self.fail_next.lock().expect("lock").take()
    }
}

impl IssueWriter for RecordingWriter {
    async fn create_issue(&self, request: &CreateIssue) -> Result<CreatedIssue, WriteError> {
        if let Some(error) = self.take_failure() {
            return Err(error);
        }
        self.creates.lock().expect("lock").push(request.clone());
        let mut next = self.next_id.lock().expect("lock");
        *next += 1;
        Ok(CreatedIssue {
            id: format!("iss_{next}"),
            deduplicated: None,
            deduplication_reason: None,
        })
    }

    async fn patch_issue(&self, issue_id: &str, patch: &PatchIssue) -> Result<(), WriteError> {
        if let Some(error) = self.take_failure() {
            return Err(error);
        }
        self.patches
            .lock()
            .expect("lock")
            .push((issue_id.to_string(), patch.clone()));
        Ok(())
    }

    async fn add_comment(
        &self,
        _issue_id: &str,
        body: &str,
        _client_request_id: &str,
    ) -> Result<(), WriteError> {
        if let Some(error) = self.take_failure() {
            return Err(error);
        }
        self.comments.lock().expect("lock").push(body.to_string());
        Ok(())
    }
}

/// An assignee map keyed by Buzz pubkey, built by inverting the projection map.
///
/// One file drives both directions, so the two can never disagree about which
/// npub is which Paperclip principal.
pub fn invert_assignee_map(
    paperclip_to_npub: &BTreeMap<String, String>,
) -> BTreeMap<String, String> {
    paperclip_to_npub
        .iter()
        .map(|(paperclip_id, npub)| (npub.clone(), paperclip_id.clone()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn statuses_map_onto_the_paperclip_vocabulary() {
        let cases = [
            ("open", false, "backlog"),
            ("open", true, "backlog"),
            ("assigned", true, "todo"),
            ("in_progress", true, "in_progress"),
            ("in_progress", false, "todo"),
            ("needs_approval", true, "in_review"),
            ("done", true, "done"),
            ("cancelled", true, "cancelled"),
            ("something-new", true, "backlog"),
            ("  DONE  ", true, "done"),
        ];
        for (buzz, has_assignee, expected) in cases {
            let mapped = to_paperclip_status(buzz, has_assignee);
            assert_eq!(
                mapped, expected,
                "to_paperclip_status({buzz}, {has_assignee})"
            );
            assert!(
                PAPERCLIP_STATUSES.contains(&mapped),
                "{mapped} must be a status Paperclip accepts"
            );
        }
    }

    #[test]
    fn a_uuid_assignee_is_an_agent_and_anything_else_is_a_user() {
        assert_eq!(
            assignee_field("3f1c4b2e-0000-4000-8000-000000000001"),
            AssigneeField::Agent
        );
        assert_eq!(assignee_field("usr_alex"), AssigneeField::User);
        assert_eq!(assignee_field("local-board"), AssigneeField::User);
    }

    #[test]
    fn an_empty_assignee_is_omitted_rather_than_stored_as_an_empty_string() {
        let request =
            CreateIssue::new("T", "D", "open", Some("   "), None, "evt1").expect("builds");
        assert!(request.assignee_agent_id.is_none());
        assert!(request.assignee_user_id.is_none());
        let json = serde_json::to_value(&request).expect("json");
        assert!(json.get("assigneeUserId").is_none(), "{json}");
        assert!(json.get("assigneeAgentId").is_none(), "{json}");
    }

    #[test]
    fn a_create_always_allows_duplicates_and_uses_a_derived_key() {
        let request = CreateIssue::new("T", "D", "open", None, None, "evt-9").expect("builds");
        assert!(
            request.allow_duplicate,
            "without this the recent-title dedupe can bind us to a stranger's issue"
        );
        assert_eq!(request.idempotency_key, "buzz:evt-9");
    }

    #[test]
    fn a_recent_title_dedupe_is_refused() {
        let created = CreatedIssue {
            id: "iss_someone_else".to_string(),
            deduplicated: Some(true),
            deduplication_reason: Some(REASON_RECENT_OPEN_TITLE.to_string()),
        };
        let error = accept_created(&created).expect_err("must refuse");
        assert!(format!("{error}").contains("recent title"), "{error}");
    }

    #[test]
    fn an_idempotent_replay_is_accepted() {
        let created = CreatedIssue {
            id: "iss_ours".to_string(),
            deduplicated: Some(true),
            deduplication_reason: Some("idempotency_key".to_string()),
        };
        assert_eq!(accept_created(&created).expect("accepted"), "iss_ours");
    }

    #[test]
    fn retryable_and_terminal_errors_are_classified() {
        let retryable = [
            WriteError::Transport("connection reset".to_string()),
            WriteError::Status {
                code: 409,
                code_name: Some("run_lock".to_string()),
                message: String::new(),
            },
            WriteError::Status {
                code: 429,
                code_name: None,
                message: String::new(),
            },
            WriteError::Status {
                code: 500,
                code_name: None,
                message: String::new(),
            },
            WriteError::Status {
                code: 503,
                code_name: None,
                message: String::new(),
            },
        ];
        for error in retryable {
            assert!(error.is_retryable(), "{error:?} should be retryable");
        }
        let terminal = [400, 401, 403, 404, 422];
        for code in terminal {
            let error = WriteError::Status {
                code,
                code_name: None,
                message: String::new(),
            };
            assert!(!error.is_retryable(), "http {code} must not be retried");
        }
    }

    #[test]
    fn the_assignee_map_inverts_both_ways() {
        let mut forward = BTreeMap::new();
        forward.insert("usr_alex".to_string(), "a".repeat(64));
        let inverse = invert_assignee_map(&forward);
        assert_eq!(
            inverse.get(&"a".repeat(64)).map(String::as_str),
            Some("usr_alex")
        );
    }
}
