//! Integration tests for the Buzz -> Paperclip apply direction.
//!
//! A fake feed and a recording writer drive the real `run_apply`, `decide` and
//! request-building code the binary uses.

use std::collections::BTreeMap;

use buzz_paperclip::paperclip_write::RecordingWriter;
use buzz_paperclip::{
    run_apply, ApplyConfig, BridgeError, BuzzTask, Decision, IssueWriter, SkipReason, SyncState,
    TaskBatch, TaskFeed, WriteError,
};

/// A feed that returns a fixed set of task rows.
struct FixedFeed(Vec<BuzzTask>);

impl TaskFeed for FixedFeed {
    async fn fetch_tasks(
        &self,
        _channel: Option<&str>,
        _since: Option<&str>,
    ) -> Result<TaskBatch, BridgeError> {
        Ok(TaskBatch::complete(self.0.clone()))
    }
}

fn task(d: &str, status: &str) -> BuzzTask {
    BuzzTask {
        d: d.to_string(),
        title: format!("Task {d}"),
        description: "from Buzz".to_string(),
        status: status.to_string(),
        assignee: None,
        event_id: format!("evt-{d}"),
        author: "b".repeat(64),
        created_at: 1_000,
        projected: false,
    }
}

fn config() -> ApplyConfig {
    ApplyConfig {
        retry_delay: std::time::Duration::from_millis(0),
        ..ApplyConfig::default()
    }
}

/// A config where `npub` is both the author and the assignee map key.
fn config_mapping(npub: &str, principal: &str) -> ApplyConfig {
    let mut config = config();
    config
        .assignee_by_npub
        .insert(npub.to_string(), principal.to_string());
    config
        .responsible_by_npub
        .insert(npub.to_string(), principal.to_string());
    config
}

#[tokio::test]
async fn a_new_buzz_task_creates_one_issue_and_binds_it() {
    let feed = FixedFeed(vec![task("open:t1", "open")]);
    let writer = RecordingWriter::new();
    let mut state = SyncState::new();

    let report = run_apply(&feed, &writer, &config(), &mut state, false)
        .await
        .expect("apply runs");

    assert_eq!(report.created, 1);
    assert_eq!(report.failures, 0);
    let creates = writer.creates();
    assert_eq!(creates.len(), 1);
    assert_eq!(creates[0].title, "Task open:t1");
    assert_eq!(
        creates[0].idempotency_key, "buzz:evt-open:t1",
        "retries must reuse the same key so Paperclip replays instead of duplicating"
    );
    assert!(
        creates[0].allow_duplicate,
        "the recent-title dedupe must be off"
    );
    assert_eq!(
        creates[0].status, "backlog",
        "unassigned open work is backlog"
    );

    let binding = state.buzz_tasks.get("open:t1").expect("bound");
    assert_eq!(binding.paperclip_issue_id, "iss_1");
    assert_eq!(binding.last_status, "backlog");
}

#[tokio::test]
async fn a_second_run_creates_nothing_for_an_already_bound_task() {
    let feed = FixedFeed(vec![task("open:t1", "open")]);
    let mut state = SyncState::new();
    run_apply(&feed, &RecordingWriter::new(), &config(), &mut state, false)
        .await
        .expect("first run");

    let writer = RecordingWriter::new();
    let report = run_apply(&feed, &writer, &config(), &mut state, false)
        .await
        .expect("second run");

    assert_eq!(report.created, 0);
    assert_eq!(report.skipped, 1);
    assert!(writer.creates().is_empty(), "one task must stay one issue");
    assert!(writer.patches().is_empty());
}

#[tokio::test]
async fn a_status_move_patches_the_linked_issue() {
    let mut state = SyncState::new();
    run_apply(
        &FixedFeed(vec![task("open:t1", "open")]),
        &RecordingWriter::new(),
        &config(),
        &mut state,
        false,
    )
    .await
    .expect("first run");

    let writer = RecordingWriter::new();
    let report = run_apply(
        &FixedFeed(vec![task("open:t1", "done")]),
        &writer,
        &config(),
        &mut state,
        false,
    )
    .await
    .expect("second run");

    assert_eq!(report.patched, 1);
    assert_eq!(report.created, 0);
    let patches = writer.patches();
    assert_eq!(patches.len(), 1);
    assert_eq!(patches[0].0, "iss_1");
    assert_eq!(patches[0].1.status, Some("done"));
    assert_eq!(
        state.buzz_tasks["open:t1"].last_status, "done",
        "the binding tracks what was applied so the next run is a no-op"
    );
}

#[tokio::test]
async fn a_projected_row_is_never_turned_back_into_an_issue() {
    let mut projected = task("paperclip:iss_9", "open");
    projected.projected = true;
    let writer = RecordingWriter::new();
    let mut state = SyncState::new();

    let report = run_apply(
        &FixedFeed(vec![projected]),
        &writer,
        &config(),
        &mut state,
        false,
    )
    .await
    .expect("apply runs");

    assert_eq!(report.skipped, 1);
    assert!(
        writer.creates().is_empty(),
        "our own projection is not new work"
    );
    assert!(state.buzz_tasks.is_empty());
}

/// The fork bug this pins: an MCP `task_status` row takes a projected task's
/// `d` tag verbatim and publishes WITHOUT a `source=paperclip` tag, so the row
/// parses with `projected == false`. The decide path must still refuse to
/// create a second Paperclip issue for it: the create idempotency key is the
/// new row's event id, which Paperclip has never seen, so its own dedupe
/// cannot save it.
#[tokio::test]
async fn a_paperclip_prefixed_d_without_a_source_tag_is_never_created_again() {
    let mut status_row = task("paperclip:iss_9", "done");
    status_row.projected = false;
    let writer = RecordingWriter::new();
    let mut state = SyncState::new();

    let report = run_apply(
        &FixedFeed(vec![status_row.clone()]),
        &writer,
        &config(),
        &mut state,
        false,
    )
    .await
    .expect("apply runs");

    assert_eq!(
        report.skipped, 1,
        "a paperclip:-prefixed d names an issue Paperclip already owns"
    );
    assert!(
        writer.creates().is_empty(),
        "the MCP status row must not mint a second Paperclip issue"
    );
    assert!(state.buzz_tasks.is_empty(), "nothing was bound");
    let decision = buzz_paperclip::apply::decide(&status_row, &config(), &SyncState::new());
    assert_eq!(
        decision,
        Decision::Skip(SkipReason::ProjectedPrefix),
        "the guard lives in the production decide() path"
    );
}

#[test]
fn the_decision_for_a_projected_row_is_skip() {
    let mut projected = task("paperclip:iss_9", "open");
    projected.projected = true;
    assert_eq!(
        buzz_paperclip::apply::decide(&projected, &config(), &SyncState::new()),
        Decision::Skip(SkipReason::Projected)
    );
    assert_eq!(
        buzz_paperclip::apply::decide(&task("open:t1", "open"), &config(), &SyncState::new()),
        Decision::Create {
            status: "backlog",
            assignee: None,
            responsible: None
        }
    );
}

#[tokio::test]
async fn an_unmapped_assignee_is_created_unassigned_and_reported() {
    let mut assigned = task("open:t1", "in_progress");
    assigned.assignee = Some("c".repeat(64));
    let writer = RecordingWriter::new();
    let mut state = SyncState::new();

    let report = run_apply(
        &FixedFeed(vec![assigned]),
        &writer,
        &config(),
        &mut state,
        false,
    )
    .await
    .expect("apply runs");

    assert_eq!(
        report.unmapped_assignees,
        vec!["open:t1".to_string()],
        "an unmapped assignee must be reported, never guessed"
    );
    let creates = writer.creates();
    assert!(creates[0].assignee_agent_id.is_none());
    assert!(creates[0].assignee_user_id.is_none());
    assert_eq!(
        creates[0].status, "todo",
        "in_progress without an assignee is rejected by Paperclip with 422, so it is sent as todo"
    );
}

#[tokio::test]
async fn a_mapped_assignee_is_sent_in_the_right_field() {
    let mut assigned = task("open:t1", "in_progress");
    assigned.assignee = Some("d".repeat(64));
    let mut config = config();
    config.assignee_by_npub.insert(
        "d".repeat(64),
        "3f1c4b2e-0000-4000-8000-000000000001".to_string(),
    );
    let writer = RecordingWriter::new();
    let mut state = SyncState::new();

    run_apply(
        &FixedFeed(vec![assigned]),
        &writer,
        &config,
        &mut state,
        false,
    )
    .await
    .expect("apply runs");

    let creates = writer.creates();
    assert_eq!(
        creates[0].assignee_agent_id.as_deref(),
        Some("3f1c4b2e-0000-4000-8000-000000000001"),
        "a UUID assignee is an agent"
    );
    assert!(creates[0].assignee_user_id.is_none());
    assert_eq!(
        creates[0].status, "in_progress",
        "assigned work may be in progress"
    );
}

#[tokio::test]
async fn a_terminal_error_leaves_the_task_unbound() {
    let feed = FixedFeed(vec![task("open:t1", "open")]);
    let writer = RecordingWriter::failing_once(WriteError::Status {
        code: 403,
        code_name: Some("forbidden".to_string()),
        message: "viewer cannot write".to_string(),
    });
    let mut state = SyncState::new();

    let report = run_apply(&feed, &writer, &config(), &mut state, false)
        .await
        .expect("apply completes with a failure");

    assert_eq!(report.failures, 1);
    assert_eq!(report.created, 0);
    assert!(
        report.failure_details[0].contains("403"),
        "{:?}",
        report.failure_details
    );
    assert!(
        state.buzz_tasks.is_empty(),
        "a failed create must not be recorded as applied, or the task is lost"
    );
}

#[tokio::test]
async fn a_retryable_error_is_retried_and_then_succeeds() {
    let feed = FixedFeed(vec![task("open:t1", "open")]);
    let writer = RecordingWriter::failing_once(WriteError::Status {
        code: 429,
        code_name: Some("rate_limited".to_string()),
        message: "slow down".to_string(),
    });
    let mut state = SyncState::new();

    let report = run_apply(&feed, &writer, &config(), &mut state, false)
        .await
        .expect("apply runs");

    assert_eq!(report.failures, 0);
    assert_eq!(report.created, 1);
    assert_eq!(
        writer.creates().len(),
        1,
        "the retry reused the same request"
    );
    assert!(state.buzz_tasks.contains_key("open:t1"));
}

#[tokio::test]
async fn a_title_dedupe_response_is_never_bound() {
    struct DedupeWriter;

    impl IssueWriter for DedupeWriter {
        async fn create_issue(
            &self,
            _request: &buzz_paperclip::CreateIssue,
        ) -> Result<buzz_paperclip::CreatedIssue, WriteError> {
            Ok(buzz_paperclip::CreatedIssue {
                id: "iss_someone_else".to_string(),
                deduplicated: Some(true),
                deduplication_reason: Some("recent_open_title".to_string()),
            })
        }

        async fn patch_issue(
            &self,
            _issue_id: &str,
            _patch: &buzz_paperclip::PatchIssue,
        ) -> Result<(), WriteError> {
            Ok(())
        }

        async fn add_comment(
            &self,
            _issue_id: &str,
            _body: &str,
            _client_request_id: &str,
        ) -> Result<(), WriteError> {
            Ok(())
        }
    }

    let mut state = SyncState::new();
    let report = run_apply(
        &FixedFeed(vec![task("open:t1", "open")]),
        &DedupeWriter,
        &config(),
        &mut state,
        false,
    )
    .await
    .expect("apply completes with a failure");

    assert_eq!(report.failures, 1);
    assert!(
        state.buzz_tasks.is_empty(),
        "binding to a stranger's issue would corrupt that issue forever"
    );
}

#[tokio::test]
async fn dry_run_writes_nothing_and_binds_nothing() {
    let feed = FixedFeed(vec![task("open:t1", "open")]);
    let writer = RecordingWriter::new();
    let mut state = SyncState::new();

    let report = run_apply(&feed, &writer, &config(), &mut state, true)
        .await
        .expect("dry run");

    assert!(report.dry_run);
    assert_eq!(report.created, 1, "a dry run still plans the work");
    assert!(writer.creates().is_empty());
    assert!(state.buzz_tasks.is_empty());
}

#[tokio::test]
async fn an_empty_feed_is_not_an_error() {
    let writer = RecordingWriter::new();
    let mut state = SyncState::new();
    let report = run_apply(&FixedFeed(vec![]), &writer, &config(), &mut state, false)
        .await
        .expect("apply runs");
    assert_eq!(
        report,
        buzz_paperclip::ApplyReport {
            dry_run: false,
            ..Default::default()
        }
    );
}

#[tokio::test]
async fn the_assignee_map_is_shared_with_the_projection_direction() {
    // One file drives both directions; it is inverted for `apply` so the two can
    // never disagree about which npub is which Paperclip principal.
    let mut forward = BTreeMap::new();
    forward.insert("usr_alex".to_string(), "e".repeat(64));
    let inverse = buzz_paperclip::invert_assignee_map(&forward);
    assert_eq!(inverse[&"e".repeat(64)], "usr_alex");
}

#[tokio::test]
async fn a_mapped_author_is_recorded_as_responsible_in_paperclip() {
    let mut authored = task("open:t1", "open");
    authored.author = "a".repeat(64);
    let config = config_mapping(&"a".repeat(64), "local-board");
    let writer = RecordingWriter::new();
    let mut state = SyncState::new();

    let report = run_apply(
        &FixedFeed(vec![authored]),
        &writer,
        &config,
        &mut state,
        false,
    )
    .await
    .expect("apply runs");

    assert!(report.unmapped_authors.is_empty());
    assert_eq!(
        writer.creates()[0].responsible_user_id.as_deref(),
        Some("local-board"),
        "the Buzz author is the responsible principal, so two people's work is distinguishable"
    );
}

#[tokio::test]
async fn an_unmapped_author_is_reported_and_never_guessed() {
    let mut authored = task("open:t1", "open");
    authored.author = "f".repeat(64);
    let writer = RecordingWriter::new();
    let mut state = SyncState::new();

    let report = run_apply(
        &FixedFeed(vec![authored]),
        &writer,
        &config(),
        &mut state,
        false,
    )
    .await
    .expect("apply runs");

    assert_eq!(report.unmapped_authors, vec!["open:t1".to_string()]);
    assert!(
        writer.creates()[0].responsible_user_id.is_none(),
        "Paperclip accepts any string here, so an unmapped author must not be invented"
    );
}

#[tokio::test]
async fn an_implausible_principal_is_refused_rather_than_sent() {
    let mut authored = task("open:t1", "open");
    authored.author = "a".repeat(64);
    // Paperclip stores whatever it is given, so a value that is not an identity
    // must never reach it.
    let config = config_mapping(&"a".repeat(64), "not a principal id");
    let writer = RecordingWriter::new();
    let mut state = SyncState::new();

    let report = run_apply(
        &FixedFeed(vec![authored]),
        &writer,
        &config,
        &mut state,
        false,
    )
    .await
    .expect("apply runs");

    assert_eq!(report.unmapped_authors, vec!["open:t1".to_string()]);
    assert!(writer.creates()[0].responsible_user_id.is_none());
}
