//! Issue sources for the Paperclip projection.
//!
//! Two implementations ship here:
//!
//! * [`JsonFileSource`] reads a JSON array of issues from disk. It makes the
//!   projection runnable and testable without a live Paperclip instance, and it
//!   is what `--from-json` uses.
//! * [`PaperclipRestSource`] reads the same shape over HTTP from a Paperclip
//!   instance, paginating with the keyset the server supports.
//!
//! The `Issue` model is deliberately tolerant: unknown fields are ignored and
//! every field the projection does not strictly need is optional. Paperclip
//! schemas evolve, and a new column must not break a running projection.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::BridgeError;

/// One Paperclip issue, reduced to the fields this projection consumes.
///
/// Field names follow Paperclip's camelCase JSON. `status` and `priority` are
/// left as raw strings on purpose: [`crate::map_status`] and
/// [`crate::map_priority`] translate them, and an unrecognised value must be
/// reported rather than rejected at parse time.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    /// Stable issuer-scoped identifier. Becomes the `d` tag of the task row.
    pub id: String,
    /// Human-readable title. Falls back to the identifier when absent.
    #[serde(default)]
    pub title: Option<String>,
    /// Free-form body rendered as the task description.
    #[serde(default)]
    pub description: Option<String>,
    /// Raw status string, translated by [`crate::map_status`].
    #[serde(default)]
    pub status: Option<String>,
    /// Raw priority string, translated by [`crate::map_priority`].
    #[serde(default)]
    pub priority: Option<String>,
    /// ISO-8601 last-modified stamp.
    #[serde(default)]
    pub updated_at: Option<String>,
    /// Assignee as a Paperclip user principal id, when assigned to a human.
    #[serde(default)]
    pub assignee_user_id: Option<String>,
    /// Assignee as a Paperclip agent id, when assigned to an agent.
    #[serde(default)]
    pub assignee_agent_id: Option<String>,
    /// Parent issue id, when this issue is a subtask.
    #[serde(default)]
    pub parent_id: Option<String>,
    /// Owning project id.
    #[serde(default)]
    pub project_id: Option<String>,
    /// Labels/tags attached to the issue.
    #[serde(default)]
    pub labels: Option<Vec<String>>,
    /// ISO-8601 due date.
    #[serde(default)]
    pub due_date: Option<String>,
    /// Human-facing issue key (for example `PAP-12`) when the source has one.
    #[serde(default)]
    pub identifier: Option<String>,
    /// Paperclip sets this when the list route truncated `description`.
    ///
    /// The list route clips descriptions (base64, ~1200 chars); a full body
    /// needs `GET /api/issues/{id}`. Carried so a later pass can fetch detail
    /// only where it matters.
    #[serde(default)]
    pub description_truncated: Option<bool>,
}

impl Issue {
    /// The assignee principal id, preferring the human assignment over the
    /// agent assignment, or `None` when the issue is unassigned.
    pub fn assignee_id(&self) -> Option<&str> {
        self.assignee_user_id
            .as_deref()
            .or(self.assignee_agent_id.as_deref())
            .map(str::trim)
            .filter(|value| !value.is_empty())
    }

    /// Title used for the task row: the issue title, else the identifier, else
    /// the raw id. Never empty, so a row always renders.
    pub fn display_title(&self) -> String {
        for candidate in [self.title.as_deref(), self.identifier.as_deref()] {
            if let Some(value) = candidate.map(str::trim).filter(|v| !v.is_empty()) {
                return value.to_string();
            }
        }
        self.id.clone()
    }
}

/// One page-set of issues plus whether the source had to stop early.
///
/// `truncated` is load-bearing: a truncated read means the projection has NOT
/// seen the whole source, so it must not advance its cursor. Reporting that is
/// how the bridge avoids invisible divergence.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct IssueBatch {
    /// Issues read in this fetch, in source order.
    pub issues: Vec<Issue>,
    /// True when a page cap stopped the read before the source was exhausted.
    pub truncated: bool,
}

impl IssueBatch {
    /// A complete read.
    pub fn complete(issues: Vec<Issue>) -> Self {
        Self {
            issues,
            truncated: false,
        }
    }

    /// A read that stopped early.
    pub fn truncated(issues: Vec<Issue>) -> Self {
        Self {
            issues,
            truncated: true,
        }
    }
}

/// A read-only source of issues.
///
/// Returns only `impl Future` rather than using `async fn` in the trait so the
/// trait stays object-safe-friendly and free of the `async_fn_in_trait` lint.
pub trait IssueSource {
    /// Fetch issues, optionally restricted to those changed since `since`
    /// (an ISO-8601 stamp).
    fn fetch_issues(
        &self,
        since: Option<&str>,
    ) -> impl std::future::Future<Output = Result<IssueBatch, BridgeError>> + Send;
}

/// Reads issues from a JSON file: either a bare array, or an object with an
/// `issues` array. Used by `--from-json` and by the integration tests.
#[derive(Debug, Clone)]
pub struct JsonFileSource {
    path: PathBuf,
}

impl JsonFileSource {
    /// Construct a source reading from `path`.
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }
}

impl IssueSource for JsonFileSource {
    async fn fetch_issues(&self, _since: Option<&str>) -> Result<IssueBatch, BridgeError> {
        let text = std::fs::read_to_string(&self.path).map_err(|error| {
            BridgeError::Source(format!("cannot read {}: {error}", self.path.display()))
        })?;
        parse_issues(&text)
            .map(IssueBatch::complete)
            .map_err(|error| {
                BridgeError::Source(format!("cannot parse {}: {error}", self.path.display()))
            })
    }
}

/// Parse the two accepted JSON shapes into issues.
///
/// Extracted from [`JsonFileSource`] so the shape tolerance is unit-testable
/// without touching the filesystem.
pub fn parse_issues(text: &str) -> Result<Vec<Issue>, serde_json::Error> {
    let value: serde_json::Value = serde_json::from_str(text)?;
    match value {
        serde_json::Value::Array(_) => serde_json::from_value(value),
        serde_json::Value::Object(mut map) => match map.remove("issues") {
            Some(issues) => serde_json::from_value(issues),
            None => Ok(Vec::new()),
        },
        other => serde_json::from_value(other),
    }
}

/// How many pages a single fetch may read before it reports truncation.
///
/// Bounded on purpose: an unbounded pagination loop against a large company
/// would hold the run open forever. Hitting the cap is reported, never hidden.
pub const DEFAULT_MAX_PAGES: u32 = 10;

/// Reads issues from a Paperclip instance over HTTP.
///
/// Verified against Paperclip at `84fe899` by reading its route and service
/// source, not its docs:
///
/// * `GET /api/companies/{companyId}/issues` returns a **bare array** with no
///   envelope and no cursor.
/// * Auth is `Authorization: Bearer <board key>` only; a key from a
///   `viewer`-role membership is read-only and sufficient.
/// * `?updatedSince=<ISO8601>` exists but is undocumented. It is a strict
///   `updated_at > since` filter.
/// * Pagination is `limit` (max 1000, silently clamped) plus keyset `afterId`,
///   and `afterId` is only legal with `sortField=id&sortDir=asc&offset=0`. That
///   is why this source always sends that exact sort/filter combination.
#[derive(Debug, Clone)]
pub struct PaperclipRestSource {
    base_url: String,
    issues_path: String,
    /// Credential to send, or `None` to send none at all.
    ///
    /// On a `local_trusted` instance the implicit `local-board` actor applies
    /// only when **no** Authorization header is present: a malformed or unknown
    /// bearer is answered `401`, so an empty key must be omitted rather than
    /// sent empty.
    api_key: Option<String>,
    page_size: u32,
    max_pages: u32,
    incremental_param: Option<String>,
    client: reqwest::Client,
}

impl PaperclipRestSource {
    /// Build a source against `base_url`, reading `issues_path` (for example
    /// `/api/companies/<companyId>/issues`) with a board API key.
    pub fn new(
        base_url: impl Into<String>,
        issues_path: impl Into<String>,
        api_key: impl Into<String>,
        page_size: u32,
    ) -> Result<Self, BridgeError> {
        let base_url = base_url.into();
        url::Url::parse(&base_url).map_err(|error| {
            BridgeError::Config(format!("invalid Paperclip base URL {base_url}: {error}"))
        })?;
        Ok(Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            issues_path: issues_path.into(),
            api_key: crate::paperclip_write::normalize_api_key(api_key.into()),
            // Paperclip clamps silently at 1000, so ask for what it honours.
            page_size: page_size.clamp(1, 1000),
            max_pages: DEFAULT_MAX_PAGES,
            incremental_param: None,
            client: reqwest::Client::new(),
        })
    }

    /// Opt in to an incremental filter, using the parameter name the operator
    /// verified against their instance (`updatedSince` for Paperclip).
    pub fn with_incremental_param(mut self, param: impl Into<String>) -> Self {
        self.incremental_param = Some(param.into());
        self
    }

    /// Cap how many pages one fetch may read.
    pub fn with_max_pages(mut self, max_pages: u32) -> Self {
        self.max_pages = max_pages.max(1);
        self
    }

    /// Build the URL for one page.
    ///
    /// `after_id` drives keyset pagination, which Paperclip only accepts with
    /// `sortField=id&sortDir=asc&offset=0`, so those are always sent.
    fn request_url(
        &self,
        since: Option<&str>,
        after_id: Option<&str>,
    ) -> Result<String, BridgeError> {
        let mut url = url::Url::parse(&format!("{}{}", self.base_url, self.issues_path))
            .map_err(|error| BridgeError::Config(format!("invalid issues URL: {error}")))?;
        {
            let mut query = url.query_pairs_mut();
            query.append_pair("limit", &self.page_size.to_string());
            query.append_pair("offset", "0");
            query.append_pair("sortField", "id");
            query.append_pair("sortDir", "asc");
            if let (Some(param), Some(since)) = (self.incremental_param.as_deref(), since) {
                query.append_pair(param, since);
            }
            if let Some(after_id) = after_id {
                query.append_pair("afterId", after_id);
            }
        }
        Ok(url.to_string())
    }

    async fn fetch_page(
        &self,
        since: Option<&str>,
        after_id: Option<&str>,
    ) -> Result<Vec<Issue>, BridgeError> {
        let url = self.request_url(since, after_id)?;
        let mut request = self.client.get(&url).header("accept", "application/json");
        if let Some(api_key) = self.api_key.as_deref() {
            request = request.bearer_auth(api_key);
        }
        let response = request
            .send()
            .await
            .map_err(|error| BridgeError::Source(format!("request to {url} failed: {error}")))?;
        let status = response.status();
        let body = response
            .text()
            .await
            .map_err(|error| BridgeError::Source(format!("cannot read response body: {error}")))?;
        if !status.is_success() {
            return Err(BridgeError::Source(format!(
                "Paperclip returned {status} for {url}"
            )));
        }
        parse_issues(&body).map_err(|error| {
            BridgeError::Source(format!("cannot parse issues from {url}: {error}"))
        })
    }
}

impl IssueSource for PaperclipRestSource {
    async fn fetch_issues(&self, since: Option<&str>) -> Result<IssueBatch, BridgeError> {
        let mut issues: Vec<Issue> = Vec::new();
        let mut after_id: Option<String> = None;
        for page in 0..self.max_pages {
            let batch = self.fetch_page(since, after_id.as_deref()).await?;
            let short_page = (batch.len() as u32) < self.page_size;
            let last_id = batch.last().map(|issue| issue.id.clone());
            issues.extend(batch);
            if short_page {
                return Ok(IssueBatch::complete(issues));
            }
            match last_id {
                // A full page with no id to advance on would loop forever.
                Some(id) if Some(&id) != after_id.as_ref() => after_id = Some(id),
                _ => {
                    tracing::warn!(
                        pages = page + 1,
                        "Paperclip returned a full page that could not be advanced past"
                    );
                    return Ok(IssueBatch::truncated(issues));
                }
            }
        }
        tracing::warn!(
            pages = self.max_pages,
            limit = self.page_size,
            "stopped paginating at the page cap; the read is incomplete"
        );
        Ok(IssueBatch::truncated(issues))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_bare_array_and_an_issues_object() {
        let row = r#"{"id":"iss_1","title":"Ship it","status":"in_progress"}"#;
        let array = format!("[{row}]");
        let object = format!(r#"{{"issues":[{row}]}}"#);
        for shape in [array, object] {
            let issues = parse_issues(&shape).expect("shape parses");
            assert_eq!(issues.len(), 1);
            assert_eq!(issues[0].id, "iss_1");
            assert_eq!(issues[0].status.as_deref(), Some("in_progress"));
        }
    }

    #[test]
    fn ignores_unknown_fields_so_new_paperclip_columns_do_not_break_the_projection() {
        let text = r#"[{"id":"iss_2","brandNewColumn":{"nested":true},"status":"open"}]"#;
        let issues = parse_issues(text).expect("unknown fields are tolerated");
        assert_eq!(issues[0].id, "iss_2");
    }

    #[test]
    fn parses_the_real_paperclip_issue_shape() {
        let text = r#"[{
            "id":"3f1c4b2e-0000-4000-8000-000000000001",
            "companyId":"cmp_1",
            "identifier":"PAP-39",
            "title":"Ship it",
            "status":"in_review",
            "priority":"critical",
            "assigneeAgentId":"agt_1",
            "assigneeUserId":null,
            "updatedAt":"2026-09-18T10:00:00.000Z",
            "descriptionTruncated":true
        }]"#;
        let issues = parse_issues(text).expect("real shape parses");
        assert_eq!(issues[0].identifier.as_deref(), Some("PAP-39"));
        assert_eq!(issues[0].assignee_id(), Some("agt_1"));
        assert_eq!(issues[0].description_truncated, Some(true));
    }

    #[test]
    fn display_title_falls_back_to_identifier_then_id() {
        let mut issue = Issue {
            id: "iss_3".to_string(),
            identifier: Some("PAP-12".to_string()),
            ..Issue::default()
        };
        assert_eq!(issue.display_title(), "PAP-12");
        issue.identifier = None;
        assert_eq!(issue.display_title(), "iss_3");
        issue.title = Some("  real title  ".to_string());
        assert_eq!(issue.display_title(), "real title");
    }

    #[test]
    fn assignee_prefers_the_human_assignment() {
        let mut issue = Issue {
            id: "iss_4".to_string(),
            assignee_user_id: Some("usr_1".to_string()),
            assignee_agent_id: Some("agt_1".to_string()),
            ..Issue::default()
        };
        assert_eq!(issue.assignee_id(), Some("usr_1"));
        issue.assignee_user_id = None;
        assert_eq!(issue.assignee_id(), Some("agt_1"));
        issue.assignee_agent_id = Some("   ".to_string());
        assert_eq!(issue.assignee_id(), None, "blank ids are not assignees");
    }

    #[test]
    fn request_url_uses_the_keyset_sort_the_server_requires() {
        let source = PaperclipRestSource::new(
            "https://tasks.example.com/",
            "/api/companies/c1/issues",
            "board_key",
            50,
        )
        .expect("source builds");
        let url = source.request_url(None, None).expect("url");
        assert!(url.contains("limit=50"), "{url}");
        assert!(
            url.contains("offset=0"),
            "keyset paging requires offset=0: {url}"
        );
        assert!(url.contains("sortField=id"), "{url}");
        assert!(url.contains("sortDir=asc"), "{url}");
        assert!(
            !url.contains("updatedSince"),
            "no cursor param may be invented: {url}"
        );

        let paged = source.request_url(None, Some("iss_9")).expect("url");
        assert!(paged.contains("afterId=iss_9"), "{paged}");
    }

    #[test]
    fn request_url_uses_a_configured_cursor_param() {
        let source = PaperclipRestSource::new("https://tasks.example.com", "/issues", "k", 10)
            .expect("source builds")
            .with_incremental_param("updatedSince");
        let url = source
            .request_url(Some("2026-09-18T00:00:00Z"), None)
            .expect("url");
        assert!(url.contains("updatedSince="), "{url}");
    }

    #[test]
    fn the_page_size_is_clamped_to_what_paperclip_honours() {
        let source = PaperclipRestSource::new("https://tasks.example.com", "/issues", "k", 5000)
            .expect("source builds");
        let url = source.request_url(None, None).expect("url");
        assert!(
            url.contains("limit=1000"),
            "silent server clamping avoided: {url}"
        );
    }

    #[test]
    fn rejects_an_unparseable_base_url_rather_than_panicking() {
        let error = PaperclipRestSource::new("not a url", "/issues", "k", 10)
            .expect_err("invalid base URL must be a config error");
        assert!(matches!(error, BridgeError::Config(_)));
    }
}
