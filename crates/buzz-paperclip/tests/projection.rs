//! Integration tests for the projection.
//!
//! These bind the production seam: a fake source and a recording publisher
//! drive the real `run_once`, `plan` and `map_issue` paths that the binary
//! uses. If the mapping or the idempotency rule regresses, these fail.

use std::sync::Mutex;

use buzz_paperclip::relay::{PublishOutcome, Publisher};
use buzz_paperclip::source::{Issue, IssueSource};
use buzz_paperclip::tests_support::{config, issue, SAMPLE_PUBKEY};
use buzz_paperclip::{
    incremental_since, is_hex_pubkey, map_issue, map_priority, map_status, plan, run_once,
    BridgeError, IssueBatch, MappedTask, ProjectionConfig, PublishReason, SyncState,
    TASK_PRIORITIES, TASK_STATUSES,
};

/// A source that returns a fixed set of issues, recording the cursor it was
/// asked for so tests can assert the cursor policy.
#[derive(Default)]
struct VecSource {
    issues: Vec<Issue>,
    truncated: bool,
    seen_since: Mutex<Vec<Option<String>>>,
}

impl VecSource {
    fn new(issues: Vec<Issue>) -> Self {
        Self {
            issues,
            truncated: false,
            seen_since: Mutex::new(Vec::new()),
        }
    }

    fn truncated(issues: Vec<Issue>) -> Self {
        Self {
            issues,
            truncated: true,
            seen_since: Mutex::new(Vec::new()),
        }
    }

    fn last_since(&self) -> Option<String> {
        self.seen_since
            .lock()
            .expect("lock")
            .last()
            .cloned()
            .flatten()
    }
}

impl IssueSource for VecSource {
    async fn fetch_issues(&self, since: Option<&str>) -> Result<IssueBatch, BridgeError> {
        self.seen_since
            .lock()
            .expect("lock")
            .push(since.map(str::to_string));
        let issues = self.issues.clone();
        Ok(if self.truncated {
            IssueBatch::truncated(issues)
        } else {
            IssueBatch::complete(issues)
        })
    }
}

/// The scan-start stamp the tests treat as "now" for the first run.
const SCAN_1: &str = "2026-09-18T12:00:00.000Z";
/// A later scan start.
const SCAN_2: &str = "2026-09-18T12:30:00.000Z";

/// A publisher that records what it accepted, and can refuse named rows.
#[derive(Default)]
struct Recording {
    accepted: Mutex<Vec<MappedTask>>,
    reject: Vec<String>,
}

impl Recording {
    fn with_rejects(reject: Vec<String>) -> Self {
        Self {
            accepted: Mutex::new(Vec::new()),
            reject,
        }
    }

    fn accepted(&self) -> Vec<MappedTask> {
        self.accepted.lock().expect("lock").clone()
    }
}

impl Publisher for Recording {
    async fn publish_task(&self, task: &MappedTask) -> Result<PublishOutcome, BridgeError> {
        if self.reject.contains(&task.d) {
            return Ok(PublishOutcome {
                event_id: None,
                accepted: false,
                message: "refused by test publisher".to_string(),
            });
        }
        self.accepted.lock().expect("lock").push(task.clone());
        Ok(PublishOutcome::accepted(Some(format!("evt:{}", task.d))))
    }
}

fn config_with_assignee(paperclip_id: &str, pubkey: &str) -> ProjectionConfig {
    let mut config = config();
    config
        .assignee_map
        .insert(paperclip_id.to_string(), pubkey.to_string());
    config
}

#[tokio::test]
async fn projects_new_issues_and_records_them() {
    let source = VecSource::new(vec![issue("iss_1", "open"), issue("iss_2", "done")]);
    let publisher = Recording::default();
    let mut state = SyncState::new();

    let report = run_once(&source, &publisher, &config(), &mut state, SCAN_1, false)
        .await
        .expect("run succeeds");

    assert_eq!(report.created, 2);
    assert_eq!(report.updated, 0);
    assert_eq!(report.failures, 0);
    assert_eq!(publisher.accepted().len(), 2);
    assert!(state.issues.contains_key("paperclip:iss_1"));
    assert_eq!(
        state.last_scan_started_at.as_deref(),
        Some(SCAN_1),
        "the cursor is the wall-clock scan start, not the newest source stamp"
    );
    assert!(report.cursor_advanced);
}

#[tokio::test]
async fn second_run_publishes_nothing_when_nothing_changed() {
    let source = VecSource::new(vec![issue("iss_1", "open")]);
    let config = config();
    let mut state = SyncState::new();

    let first = Recording::default();
    run_once(&source, &first, &config, &mut state, SCAN_1, false)
        .await
        .expect("first run");
    let second = Recording::default();
    let report = run_once(&source, &second, &config, &mut state, SCAN_2, false)
        .await
        .expect("second run");

    assert_eq!(report.created, 0);
    assert_eq!(report.updated, 0);
    assert_eq!(report.skipped, 1);
    assert!(
        second.accepted().is_empty(),
        "an unchanged issue must not republish: 44011 rows are not addressable"
    );
    assert!(
        report.cursor_advanced,
        "the wall-clock scan watermark advances on every successful run, which is \
         what lets the next run ask only for what changed"
    );
}

#[tokio::test]
async fn a_status_change_republishes_as_an_update() {
    let config = config();
    let mut state = SyncState::new();
    run_once(
        &VecSource::new(vec![issue("iss_1", "open")]),
        &Recording::default(),
        &config,
        &mut state,
        SCAN_1,
        false,
    )
    .await
    .expect("first run");

    let publisher = Recording::default();
    let report = run_once(
        &VecSource::new(vec![issue("iss_1", "in_progress")]),
        &publisher,
        &config,
        &mut state,
        SCAN_2,
        false,
    )
    .await
    .expect("second run");

    assert_eq!(report.updated, 1);
    let published = publisher.accepted();
    assert_eq!(published.len(), 1);
    assert_eq!(published[0].status, "in_progress");
    assert_eq!(state.issues["paperclip:iss_1"].status, "in_progress");
}

#[test]
fn a_status_change_is_reported_as_a_status_reason_not_a_content_reason() {
    let config = config();
    let mut state = SyncState::new();
    let open = vec![issue("iss_1", "open")];
    let materialised = plan(&open, &config, &state);
    assert_eq!(materialised.to_publish.len(), 1);
    assert_eq!(materialised.to_publish[0].reason, PublishReason::New);
    materialise(&materialised, &mut state);

    let changed = plan(&[issue("iss_1", "done")], &config, &state);
    assert_eq!(changed.to_publish[0].reason, PublishReason::StatusChanged);
    materialise(&changed, &mut state);

    let mut retitled = issue("iss_1", "done");
    retitled.title = Some("Different title".to_string());
    let content_only = plan(&[retitled], &config, &state);
    assert_eq!(
        content_only.to_publish[0].reason,
        PublishReason::ContentChanged
    );
}

#[test]
fn unresolved_assignees_omit_the_p_tag_and_are_reported() {
    let mut issue = issue("iss_1", "open");
    issue.assignee_user_id = Some("usr_unknown".to_string());
    let mapped = map_issue(&issue, &config());

    assert!(
        mapped.tag("p").is_none(),
        "an unresolved assignee must never be published as a pubkey"
    );
    assert_eq!(mapped.tag("paperclip-assignee"), Some("usr_unknown"));
    assert_eq!(mapped.unresolved_assignee.as_deref(), Some("usr_unknown"));

    let plan = plan(&[issue], &config(), &SyncState::new());
    assert_eq!(plan.unresolved_assignees, vec!["usr_unknown".to_string()]);
}

#[test]
fn a_resolved_assignee_is_published_as_the_p_tag() {
    let mut issue = issue("iss_1", "open");
    issue.assignee_user_id = Some("usr_known".to_string());
    let mapped = map_issue(&issue, &config_with_assignee("usr_known", SAMPLE_PUBKEY));
    assert_eq!(mapped.tag("p"), Some(SAMPLE_PUBKEY));
    assert!(mapped.unresolved_assignee.is_none());
}

#[test]
fn a_non_hex_pubkey_in_the_map_is_treated_as_unresolved() {
    let mut issue = issue("iss_1", "open");
    issue.assignee_user_id = Some("usr_known".to_string());
    let config = config_with_assignee("usr_known", "definitely-not-a-pubkey");
    let mapped = map_issue(&issue, &config);
    assert!(
        mapped.tag("p").is_none(),
        "a malformed mapping must not become an identity claim"
    );
    assert!(mapped.unresolved_assignee.is_some());
    assert!(!is_hex_pubkey("definitely-not-a-pubkey"));
}

#[test]
fn unrecognized_statuses_map_to_open_and_are_reported() {
    let plan = plan(
        &[issue("iss_1", "some-new-paperclip-state")],
        &config(),
        &SyncState::new(),
    );
    assert_eq!(plan.to_publish.len(), 1, "the row must still appear");
    assert_eq!(plan.to_publish[0].task.status, "open");
    assert_eq!(
        plan.unrecognized_statuses,
        vec!["iss_1:some-new-paperclip-state".to_string()]
    );
}

#[test]
fn unrecognized_priorities_are_reported_too() {
    let mut issue = issue("iss_1", "open");
    issue.priority = Some("expedite-me".to_string());
    let plan = plan(&[issue], &config(), &SyncState::new());
    assert_eq!(plan.to_publish[0].task.status, "open");
    assert_eq!(
        plan.unrecognized_priorities,
        vec!["iss_1:expedite-me".to_string()],
        "an unknown priority must be surfaced, not silently defaulted"
    );
}

#[test]
fn projected_rows_carry_the_fields_the_buzz_task_reader_consumes() {
    let mut issue = issue("iss_1", "in_progress");
    issue.description = Some("Body".to_string());
    issue.priority = Some("urgent".to_string());
    issue.due_date = Some("2026-10-01T00:00:00Z".to_string());
    issue.labels = Some(vec!["infra".to_string()]);
    issue.assignee_user_id = Some("usr_known".to_string());
    let mapped = map_issue(&issue, &config_with_assignee("usr_known", SAMPLE_PUBKEY));

    let content: serde_json::Value =
        serde_json::from_str(&mapped.content).expect("content is JSON");
    for key in [
        "title",
        "description",
        "status",
        "priority",
        "due",
        "labels",
    ] {
        assert!(
            content.get(key).is_some(),
            "reader field `{key}` missing from {content}"
        );
    }
    assert_eq!(content["status"], "in_progress");
    assert_eq!(content["priority"], "urgent");
    assert_eq!(
        content["due"],
        buzz_paperclip::parse_unix_seconds("2026-10-01T00:00:00Z")
            .expect("fixture due date parses"),
        "the due date must reach the reader as unix seconds"
    );
    assert_eq!(mapped.tag("d"), Some("paperclip:iss_1"));
    assert_eq!(
        mapped.tag("h"),
        Some("9c1f0f4a-0000-4000-8000-000000000001"),
        "rows must be channel-scoped so they appear in the work board"
    );
    assert_eq!(mapped.tag("source"), Some("paperclip"));
    assert_eq!(mapped.tag("paperclip-company"), Some("cmp_1"));
    assert_eq!(mapped.tag("paperclip-issue"), Some("iss_1"));
    assert_eq!(
        mapped.tag("paperclip-url"),
        Some("https://tasks.example.com/issues/iss_1")
    );
    assert!(
        content.get("paperclip").is_some(),
        "provenance travels with the row for later tooling"
    );
}

#[tokio::test]
async fn a_refused_row_does_not_advance_the_cursor_or_the_state() {
    let config = config();
    let source = VecSource::new(vec![issue("iss_1", "open"), issue("iss_2", "open")]);
    let mut state = SyncState::new();

    let publisher = Recording::with_rejects(vec!["paperclip:iss_2".to_string()]);
    let report = run_once(&source, &publisher, &config, &mut state, SCAN_1, false)
        .await
        .expect("run completes");

    assert_eq!(report.created, 1);
    assert_eq!(report.failures, 1);
    assert!(
        !state.issues.contains_key("paperclip:iss_2"),
        "a refused row must not be recorded as published"
    );
    assert!(
        state.last_scan_started_at.is_none(),
        "the cursor must not advance past a failed row, or an incremental source \
         would skip it forever"
    );
    assert!(!report.cursor_advanced);

    // The retry republishes only the row that failed.
    let retry = Recording::default();
    let second = run_once(&source, &retry, &config, &mut state, SCAN_2, false)
        .await
        .expect("retry run");
    assert_eq!(second.created, 1);
    assert_eq!(second.skipped, 1);
    assert_eq!(retry.accepted()[0].d, "paperclip:iss_2");
}

#[tokio::test]
async fn dry_run_publishes_and_records_nothing() {
    let source = VecSource::new(vec![issue("iss_1", "open")]);
    let publisher = Recording::default();
    let mut state = SyncState::new();

    let report = run_once(&source, &publisher, &config(), &mut state, SCAN_1, true)
        .await
        .expect("dry run completes");

    assert!(report.dry_run);
    assert_eq!(report.created, 1);
    assert!(state.issues.is_empty(), "dry run must not record state");
    assert!(state.last_scan_started_at.is_none());
    assert_eq!(
        publisher.accepted().len(),
        1,
        "dry run still exercises the real publisher call"
    );
}

#[test]
fn assignee_map_load_rejects_a_bad_pubkey() {
    let dir = tempfile::tempdir().expect("temp dir");
    let path = dir.path().join("assignees.json");
    std::fs::write(&path, r#"{"usr_1":"not-hex"}"#).expect("write");
    let error = ProjectionConfig::load_assignee_map(&path).expect_err("bad key must fail");
    let message = error.to_string();
    assert!(message.contains("usr_1"), "{message}");
    assert!(matches!(error, BridgeError::Config(_)));
}

#[test]
fn assignee_map_load_accepts_a_valid_pubkey() {
    let dir = tempfile::tempdir().expect("temp dir");
    let path = dir.path().join("assignees.json");
    std::fs::write(&path, format!(r#"{{"usr_1":"{SAMPLE_PUBKEY}"}}"#)).expect("write");
    let map = ProjectionConfig::load_assignee_map(&path).expect("valid key loads");
    assert_eq!(map.get("usr_1").map(String::as_str), Some(SAMPLE_PUBKEY));
}

#[test]
fn status_and_priority_tables_cover_the_documented_input_space() {
    let statuses = [
        ("open", "open"),
        ("TODO", "open"),
        ("Backlog", "open"),
        ("triage", "open"),
        ("assigned", "assigned"),
        ("in_progress", "in_progress"),
        ("In Progress", "in_progress"),
        ("in-progress", "in_progress"),
        ("needs_approval", "needs_approval"),
        ("waiting approval", "needs_approval"),
        ("blocked", "needs_approval"),
        ("done", "done"),
        ("completed", "done"),
        ("closed", "done"),
        ("cancelled", "cancelled"),
        ("canceled", "cancelled"),
        ("wontfix", "cancelled"),
    ];
    for (raw, expected) in statuses {
        let (mapped, recognized) = map_status(raw);
        assert_eq!(mapped, expected, "map_status({raw})");
        assert!(recognized, "map_status({raw}) should be recognized");
    }
    for status in TASK_STATUSES {
        let (mapped, recognized) = map_status(status);
        assert_eq!(mapped, status, "the Buzz vocabulary round-trips");
        assert!(recognized);
    }
    for raw in ["", "   ", "brand-new-state"] {
        let (mapped, recognized) = map_status(raw);
        assert_eq!(mapped, "open");
        assert!(
            !recognized,
            "map_status({raw:?}) must report an unknown state"
        );
    }

    let priorities = [
        ("low", "low"),
        ("minor", "low"),
        ("medium", "normal"),
        ("High", "high"),
        ("urgent", "urgent"),
        ("blocker", "urgent"),
        ("p0", "urgent"),
    ];
    for (raw, expected) in priorities {
        let (mapped, recognized) = map_priority(raw);
        assert_eq!(mapped, expected, "map_priority({raw})");
        assert!(recognized);
    }
    for priority in TASK_PRIORITIES {
        assert_eq!(map_priority(priority).0, priority);
    }
    assert_eq!(map_priority("nonsense").0, "normal");
    assert!(!map_priority("nonsense").1);
}

#[test]
fn the_content_hash_ignores_tag_order_but_not_content() {
    let a = vec![
        vec!["d".to_string(), "paperclip:iss_1".to_string()],
        vec!["source".to_string(), "paperclip".to_string()],
    ];
    let b = vec![
        vec!["source".to_string(), "paperclip".to_string()],
        vec!["d".to_string(), "paperclip:iss_1".to_string()],
    ];
    assert_eq!(
        buzz_paperclip::content_hash("{}", &a),
        buzz_paperclip::content_hash("{}", &b),
        "reordering tags must not look like an edit"
    );
    assert_ne!(
        buzz_paperclip::content_hash("{}", &a),
        buzz_paperclip::content_hash(r#"{"status":"done"}"#, &a)
    );
}

/// Apply a plan to state as the projector would, without any I/O.
fn materialise(plan: &buzz_paperclip::Plan, state: &mut SyncState) {
    for planned in &plan.to_publish {
        state.record(
            &planned.task.d,
            &planned.task.hash,
            &planned.task.status,
            None,
        );
    }
}

#[tokio::test]
async fn the_cursor_is_the_scan_start_minus_the_overlap() {
    let config = config();
    let mut state = SyncState::new();
    let first = VecSource::new(vec![issue("iss_1", "open")]);
    run_once(
        &first,
        &Recording::default(),
        &config,
        &mut state,
        SCAN_1,
        false,
    )
    .await
    .expect("first run");

    assert!(
        first.last_since().is_none(),
        "the first run has no cursor and must scan everything"
    );
    assert_eq!(state.last_scan_started_at.as_deref(), Some(SCAN_1));

    let second = VecSource::new(vec![issue("iss_1", "open")]);
    let report = run_once(
        &second,
        &Recording::default(),
        &config,
        &mut state,
        SCAN_2,
        false,
    )
    .await
    .expect("second run");

    assert_eq!(
        second.last_since().as_deref(),
        Some("2026-09-18T11:58:00.000Z"),
        "the cursor must be the previous scan start minus the 120s overlap"
    );
    assert_eq!(
        report.cursor_used.as_deref(),
        Some("2026-09-18T11:58:00.000Z")
    );
    assert!(!report.source_truncated);
}

#[tokio::test]
async fn a_truncated_read_does_not_advance_the_cursor() {
    let config = config();
    let mut state = SyncState::new();
    let source = VecSource::truncated(vec![issue("iss_1", "open")]);
    let report = run_once(
        &source,
        &Recording::default(),
        &config,
        &mut state,
        SCAN_1,
        false,
    )
    .await
    .expect("run completes");

    assert!(report.source_truncated, "truncation must be reported");
    assert_eq!(report.created, 1, "rows read before the cap still publish");
    assert!(
        state.last_scan_started_at.is_none(),
        "a partial read must not advance the cursor, or the unread rows are lost"
    );
}

#[test]
fn incremental_since_covers_the_cursor_space() {
    // No stored cursor: scan everything.
    assert_eq!(incremental_since(None, 120), None);
    // A stored cursor subtracts the overlap.
    assert_eq!(
        incremental_since(Some("2026-09-18T12:00:00Z"), 120).as_deref(),
        Some("2026-09-18T11:58:00.000Z")
    );
    // Zero overlap is honoured.
    assert_eq!(
        incremental_since(Some("2026-09-18T12:00:00Z"), 0).as_deref(),
        Some("2026-09-18T12:00:00.000Z")
    );
    // An unparseable cursor must fall back to a full scan, never to "up to date".
    assert_eq!(incremental_since(Some("not a timestamp"), 120), None);
    assert_eq!(incremental_since(Some("   "), 120), None);
}

#[test]
fn a_bridged_issue_keeps_the_buzz_row_identity_instead_of_gaining_a_second_row() {
    let config = config();
    let mut state = SyncState::new();
    // The apply direction bound a Buzz-authored task to this Paperclip issue.
    state.bind_buzz_task("open:t1", "iss_1", "todo");

    let plan = plan(&[issue("iss_1", "in_progress")], &config, &state);

    assert_eq!(plan.to_publish.len(), 1);
    assert_eq!(
        plan.to_publish[0].task.d, "open:t1",
        "the row must keep the d tag the community authored it under, or the board shows the task twice"
    );
    assert_eq!(plan.to_publish[0].task.tag("d"), Some("open:t1"));
    assert_eq!(
        plan.to_publish[0].task.tag("source"),
        Some("paperclip"),
        "the row is now a read-through view of Paperclip"
    );
}

#[test]
fn an_unbridged_issue_keeps_its_projected_identity() {
    let plan = plan(&[issue("iss_1", "open")], &config(), &SyncState::new());
    assert_eq!(plan.to_publish[0].task.d, "paperclip:iss_1");
}
