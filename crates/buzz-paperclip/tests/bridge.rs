//! Tests for the always-on bridge loop.
//!
//! The properties under test are the operational ones: the two directions must
//! not block each other, state must be saved every cycle, a rehearsal must not
//! write, and shutdown must stop the loop without abandoning a cycle in flight.

use std::sync::Mutex;
use std::time::Duration;

use buzz_paperclip::paperclip_write::RecordingWriter;
use buzz_paperclip::relay::{PublishOutcome, Publisher};
use buzz_paperclip::source::{Issue, IssueBatch, IssueSource};
use buzz_paperclip::{
    run_bridge, ApplyConfig, BridgeConfig, BridgeError, BridgeRun, BuzzTask, MappedTask,
    ProjectionConfig, SyncState, TaskBatch, TaskFeed,
};

struct EmptySource;

impl IssueSource for EmptySource {
    async fn fetch_issues(&self, _since: Option<&str>) -> Result<IssueBatch, BridgeError> {
        Ok(IssueBatch::complete(Vec::new()))
    }
}

struct FailingSource;

impl IssueSource for FailingSource {
    async fn fetch_issues(&self, _since: Option<&str>) -> Result<IssueBatch, BridgeError> {
        Err(BridgeError::Source("paperclip is down".to_string()))
    }
}

struct FixedSource(Vec<Issue>);

impl IssueSource for FixedSource {
    async fn fetch_issues(&self, _since: Option<&str>) -> Result<IssueBatch, BridgeError> {
        Ok(IssueBatch::complete(self.0.clone()))
    }
}

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

struct FailingFeed;

impl TaskFeed for FailingFeed {
    async fn fetch_tasks(
        &self,
        _channel: Option<&str>,
        _since: Option<&str>,
    ) -> Result<TaskBatch, BridgeError> {
        Err(BridgeError::Source("relay is down".to_string()))
    }
}

#[derive(Default)]
struct CountingPublisher {
    published: Mutex<Vec<String>>,
}

impl CountingPublisher {
    fn published(&self) -> Vec<String> {
        self.published.lock().expect("lock").clone()
    }
}

impl Publisher for CountingPublisher {
    async fn publish_task(&self, task: &MappedTask) -> Result<PublishOutcome, BridgeError> {
        self.published.lock().expect("lock").push(task.d.clone());
        Ok(PublishOutcome::accepted(Some("evt".to_string())))
    }
}

fn task(d: &str, status: &str) -> BuzzTask {
    BuzzTask {
        d: d.to_string(),
        title: format!("Task {d}"),
        description: String::new(),
        status: status.to_string(),
        assignee: None,
        event_id: format!("evt-{d}"),
        author: "a".repeat(64),
        created_at: 1_000,
        projected: false,
    }
}

fn issue(id: &str, status: &str) -> Issue {
    Issue {
        id: id.to_string(),
        title: Some(format!("Issue {id}")),
        status: Some(status.to_string()),
        updated_at: Some("2026-09-18T10:00:00Z".to_string()),
        ..Issue::default()
    }
}

fn sync_config() -> ProjectionConfig {
    ProjectionConfig {
        company_id: "cmp_1".to_string(),
        ..ProjectionConfig::default()
    }
}

/// Cycle config: no waiting between cycles, a fixed number of them.
fn cycles(n: u32) -> BridgeConfig {
    BridgeConfig {
        interval: Duration::ZERO,
        cycles: Some(n),
        dry_run: false,
    }
}

/// Assemble a run over the four endpoints.
fn run<'a, S, P, F, W>(
    source: &'a S,
    publisher: &'a P,
    feed: &'a F,
    writer: &'a W,
    apply: &'a ApplyConfig,
    state: &'a mut SyncState,
) -> BridgeRun<'a, S, P, F, W> {
    BridgeRun {
        source,
        publisher,
        feed,
        writer,
        sync_config: Box::leak(Box::new(sync_config())),
        apply_config: apply,
        state,
    }
}

#[tokio::test]
async fn the_loop_runs_the_requested_number_of_cycles() {
    let dir = tempfile::tempdir().expect("temp dir");
    let state_path = dir.path().join("state.json");
    let mut state = SyncState::new();
    let writer = RecordingWriter::new();
    let publisher = CountingPublisher::default();
    let apply = ApplyConfig::default();
    let feed = FixedFeed(vec![task("open:t1", "open")]);

    let report = run_bridge(
        run(&EmptySource, &publisher, &feed, &writer, &apply, &mut state),
        &cycles(3),
        &state_path,
        std::future::pending(),
    )
    .await
    .expect("bridge runs");

    assert_eq!(report.cycles, 3);
    assert!(!report.shutdown_requested);
    assert_eq!(
        report.created, 1,
        "the task is created once and bound, so later cycles skip it"
    );
    assert_eq!(writer.creates().len(), 1);
    assert!(state_path.exists(), "state is saved every cycle");
}

#[tokio::test]
async fn a_failing_paperclip_read_does_not_stop_buzz_work() {
    let dir = tempfile::tempdir().expect("temp dir");
    let mut state = SyncState::new();
    let writer = RecordingWriter::new();
    let publisher = CountingPublisher::default();
    let apply = ApplyConfig::default();
    let feed = FixedFeed(vec![task("open:t1", "open")]);

    let report = run_bridge(
        run(
            &FailingSource,
            &publisher,
            &feed,
            &writer,
            &apply,
            &mut state,
        ),
        &cycles(2),
        &dir.path().join("state.json"),
        std::future::pending(),
    )
    .await
    .expect("bridge runs");

    assert_eq!(
        report.sync_failures, 2,
        "both cycles report the read failure"
    );
    assert_eq!(report.created, 1, "Buzz work still reached Paperclip");
    assert_eq!(report.apply_failures, 0);
    assert!(
        report
            .last_error
            .as_deref()
            .expect("error kept")
            .contains("sync"),
        "{:?}",
        report.last_error
    );
}

#[tokio::test]
async fn a_failing_buzz_read_does_not_stop_the_projection() {
    let dir = tempfile::tempdir().expect("temp dir");
    let mut state = SyncState::new();
    let publisher = CountingPublisher::default();
    let writer = RecordingWriter::new();
    let apply = ApplyConfig::default();
    let source = FixedSource(vec![issue("iss_1", "open")]);

    let report = run_bridge(
        run(
            &source,
            &publisher,
            &FailingFeed,
            &writer,
            &apply,
            &mut state,
        ),
        &cycles(2),
        &dir.path().join("state.json"),
        std::future::pending(),
    )
    .await
    .expect("bridge runs");

    assert_eq!(report.apply_failures, 2);
    assert_eq!(report.projected_created, 1, "the row was still published");
    assert_eq!(publisher.published(), vec!["paperclip:iss_1".to_string()]);
    assert_eq!(report.sync_failures, 0);
}

#[tokio::test]
async fn shutdown_stops_the_loop_after_a_complete_cycle() {
    let dir = tempfile::tempdir().expect("temp dir");
    let mut state = SyncState::new();
    let publisher = CountingPublisher::default();
    let writer = RecordingWriter::new();
    let apply = ApplyConfig::default();
    let feed = FixedFeed(Vec::new());

    let report = run_bridge(
        run(&EmptySource, &publisher, &feed, &writer, &apply, &mut state),
        &BridgeConfig {
            interval: Duration::from_secs(3600),
            cycles: None,
            dry_run: false,
        },
        &dir.path().join("state.json"),
        async {},
    )
    .await
    .expect("bridge runs");

    assert!(report.shutdown_requested);
    assert_eq!(
        report.cycles, 1,
        "the cycle in flight completes before stopping"
    );
}

#[tokio::test]
async fn a_rehearsal_never_calls_the_write_side() {
    let dir = tempfile::tempdir().expect("temp dir");
    let state_path = dir.path().join("state.json");
    let mut state = SyncState::new();
    let writer = RecordingWriter::new();
    let publisher = CountingPublisher::default();
    let apply = ApplyConfig::default();
    let feed = FixedFeed(vec![task("open:t1", "open")]);
    let source = FixedSource(vec![issue("iss_1", "open")]);

    let report = run_bridge(
        run(&source, &publisher, &feed, &writer, &apply, &mut state),
        &BridgeConfig {
            interval: Duration::ZERO,
            cycles: Some(1),
            dry_run: true,
        },
        &state_path,
        std::future::pending(),
    )
    .await
    .expect("bridge runs");

    assert_eq!(report.cycles, 1);
    assert_eq!(report.created, 1, "a rehearsal still plans the work");
    assert_eq!(report.projected_created, 1);
    assert!(
        writer.creates().is_empty(),
        "a rehearsal must never call the write side"
    );
    assert!(
        publisher.published().is_empty(),
        "a rehearsal must never publish, even when handed a live publisher"
    );
    assert!(
        !state_path.exists(),
        "a rehearsal must not persist a cursor"
    );
    assert!(state.buzz_tasks.is_empty());
}

#[tokio::test]
async fn a_created_issue_is_projected_back_under_its_buzz_identity() {
    let dir = tempfile::tempdir().expect("temp dir");
    let mut state = SyncState::new();
    let publisher = CountingPublisher::default();
    let writer = RecordingWriter::new();
    let apply = ApplyConfig::default();
    let feed = FixedFeed(vec![task("open:t1", "open")]);
    let source = FixedSource(vec![issue("iss_1", "open")]);

    let report = run_bridge(
        run(&source, &publisher, &feed, &writer, &apply, &mut state),
        &cycles(1),
        &dir.path().join("state.json"),
        std::future::pending(),
    )
    .await
    .expect("bridge runs");

    assert_eq!(report.created, 1);
    assert_eq!(report.projected_created, 1);
    assert_eq!(
        publisher.published(),
        vec!["open:t1".to_string()],
        "the row keeps the d tag the community authored, instead of gaining a second row"
    );
}
