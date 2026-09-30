//! The always-on bridge: both directions on one cadence.
//!
//! This is the process the relay-buffered topology needs. It runs the apply
//! direction and then the projection, saves state, sleeps, and repeats. Two
//! properties matter more than throughput:
//!
//! * **The directions are isolated.** A failing Paperclip read must not stop
//!   Buzz work from being applied, and vice versa. Each direction counts its own
//!   failures, and one failing never skips the other in the same cycle.
//! * **State is saved every cycle**, so a crash costs at most one cycle of
//!   re-work rather than the whole session's cursor.
//!
//! Apply runs before sync on purpose: an issue created in this cycle is then
//! projected back in the same cycle under the Buzz row's own `d` tag, so the
//! community sees the status it just set reflected immediately.

use std::path::Path;
use std::time::Duration;

use chrono::Utc;
use serde::Serialize;

use crate::apply::{run_apply, ApplyConfig, TaskFeed};
use crate::paperclip_write::IssueWriter;
use crate::relay::Publisher;
use crate::source::IssueSource;
use crate::state::SyncState;
use crate::{run_once, BridgeError, ProjectionConfig};

/// How the loop runs.
#[derive(Debug, Clone)]
pub struct BridgeConfig {
    /// Time between cycles.
    pub interval: Duration,
    /// Cycle limit; `None` runs until shutdown.
    pub cycles: Option<u32>,
    /// Rehearse without publishing or writing.
    pub dry_run: bool,
}

impl Default for BridgeConfig {
    fn default() -> Self {
        Self {
            interval: Duration::from_secs(60),
            cycles: None,
            dry_run: false,
        }
    }
}

/// Totals across every cycle.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeReport {
    /// Completed cycles.
    pub cycles: u32,
    /// Issues created in Paperclip from Buzz work.
    pub created: usize,
    /// Issues whose status was moved.
    pub patched: usize,
    /// Paperclip rows published to Buzz for the first time.
    pub projected_created: usize,
    /// Paperclip rows republished because they changed.
    pub projected_updated: usize,
    /// Rows the relay refused, across cycles.
    pub publish_failures: usize,
    /// Cycles where the Paperclip read or publish failed.
    pub sync_failures: usize,
    /// Cycles where the Buzz read or Paperclip write failed.
    pub apply_failures: usize,
    /// Whether the loop stopped because shutdown was requested.
    pub shutdown_requested: bool,
    /// Last error seen, for the operator.
    pub last_error: Option<String>,
}

/// The four endpoints the loop drives, plus the state it maintains.
pub struct BridgeRun<'a, S, P, F, W> {
    /// Paperclip issue source for the projection direction.
    pub source: &'a S,
    /// Relay publisher for the projection direction.
    pub publisher: &'a P,
    /// Buzz task feed for the apply direction.
    pub feed: &'a F,
    /// Paperclip writer for the apply direction.
    pub writer: &'a W,
    /// Projection configuration.
    pub sync_config: &'a ProjectionConfig,
    /// Apply configuration.
    pub apply_config: &'a ApplyConfig,
    /// Durable state, shared by both directions.
    pub state: &'a mut SyncState,
}

/// Run the bridge loop until the cycle limit or shutdown.
///
/// `shutdown` resolves when the process should stop; the loop then finishes the
/// cycle in flight (bounded by the work already started) and returns rather than
/// abandoning state mid-write.
pub async fn run_bridge<S, P, F, W, Sh>(
    run: BridgeRun<'_, S, P, F, W>,
    config: &BridgeConfig,
    state_path: &Path,
    shutdown: Sh,
) -> Result<BridgeReport, BridgeError>
where
    S: IssueSource,
    P: Publisher,
    F: TaskFeed,
    W: IssueWriter,
    Sh: std::future::Future<Output = ()>,
{
    let BridgeRun {
        source,
        publisher,
        feed,
        writer,
        sync_config,
        apply_config,
        state,
    } = run;
    let mut shutdown = std::pin::pin!(shutdown);
    let mut report = BridgeReport::default();

    loop {
        let scan_started_at = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

        if config.dry_run {
            // A rehearsal never touches either write side. It is enforced here
            // rather than left to the caller's choice of publisher and writer,
            // because a rehearsal that writes is worse than no rehearsal.
            rehearse_cycle(source, feed, sync_config, apply_config, state, &mut report).await;
            report.cycles += 1;
            if let Some(limit) = config.cycles {
                if report.cycles >= limit {
                    break;
                }
            }
            tokio::select! {
                () = &mut shutdown => {
                    report.shutdown_requested = true;
                    break;
                }
                () = tokio::time::sleep(config.interval) => {}
            }
            continue;
        }

        // Buzz -> Paperclip.
        match run_apply(feed, writer, apply_config, state, config.dry_run).await {
            Ok(applied) => {
                report.created += applied.created;
                report.patched += applied.patched;
                report.publish_failures += applied.failures;
                if applied.failures > 0 {
                    report.last_error = applied.failure_details.first().cloned();
                }
            }
            Err(error) => {
                report.apply_failures += 1;
                report.last_error = Some(format!("apply: {error}"));
                tracing::error!(error = %error, "apply direction failed; continuing");
            }
        }

        // Paperclip -> Buzz.
        match run_once(
            source,
            publisher,
            sync_config,
            state,
            &scan_started_at,
            config.dry_run,
        )
        .await
        {
            Ok(synced) => {
                report.projected_created += synced.created;
                report.projected_updated += synced.updated;
                report.publish_failures += synced.failures;
                if synced.failures > 0 {
                    report.last_error = Some(format!(
                        "{} row(s) were not accepted by the relay",
                        synced.failures
                    ));
                }
            }
            Err(error) => {
                report.sync_failures += 1;
                report.last_error = Some(format!("sync: {error}"));
                tracing::error!(error = %error, "sync direction failed; continuing");
            }
        }

        if !config.dry_run {
            // Saved every cycle: a crash costs one cycle, not the session.
            state.save(state_path)?;
        }

        report.cycles += 1;
        tracing::info!(
            cycles = report.cycles,
            created = report.created,
            patched = report.patched,
            projected = report.projected_created + report.projected_updated,
            "bridge cycle complete"
        );

        if let Some(limit) = config.cycles {
            if report.cycles >= limit {
                break;
            }
        }

        tokio::select! {
            () = &mut shutdown => {
                report.shutdown_requested = true;
                tracing::info!("shutdown requested; stopping after a complete cycle");
                break;
            }
            () = tokio::time::sleep(config.interval) => {}
        }
    }

    Ok(report)
}

/// Plan both directions without writing anything.
async fn rehearse_cycle<S, F>(
    source: &S,
    feed: &F,
    sync_config: &ProjectionConfig,
    apply_config: &ApplyConfig,
    state: &SyncState,
    report: &mut BridgeReport,
) where
    S: IssueSource,
    F: TaskFeed,
{
    match feed.fetch_tasks(None, None).await {
        Ok(batch) => {
            for task in &batch.tasks {
                match crate::apply::decide(task, apply_config, state) {
                    crate::apply::Decision::Create { .. } => report.created += 1,
                    crate::apply::Decision::PatchStatus { .. } => report.patched += 1,
                    crate::apply::Decision::Skip(_) => {}
                }
            }
        }
        Err(error) => {
            report.apply_failures += 1;
            report.last_error = Some(format!("apply: {error}"));
        }
    }

    let cursor =
        crate::incremental_since(state.last_scan_started_at.as_deref(), state.overlap_seconds);
    match source.fetch_issues(cursor.as_deref()).await {
        Ok(batch) => {
            let planned = crate::plan(&batch.issues, sync_config, state);
            for entry in &planned.to_publish {
                match entry.reason {
                    crate::PublishReason::New => report.projected_created += 1,
                    _ => report.projected_updated += 1,
                }
            }
        }
        Err(error) => {
            report.sync_failures += 1;
            report.last_error = Some(format!("sync: {error}"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_cadence_is_a_minute_and_runs_until_shutdown() {
        let config = BridgeConfig::default();
        assert_eq!(config.interval, Duration::from_secs(60));
        assert_eq!(config.cycles, None, "a supervisor decides when to stop");
        assert!(!config.dry_run);
    }
}
