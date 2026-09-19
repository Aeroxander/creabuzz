//! Publishing projected tasks to a Buzz relay, and the dry-run stand-in.
//!
//! Task rows are published as `kind:44011` events signed by the projection's
//! own key. That key is supplied by the operator and is never a human's key:
//! attribution must stay truthful, because a reader cannot tell a projected
//! row apart from a task an agent authored itself.

use std::sync::Mutex;

use nostr::{Event, EventBuilder, Keys, Kind, Tag};

use crate::BridgeError;
use crate::MappedTask;

/// Result of handing one task row to a publisher.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublishOutcome {
    /// Event id, when the publisher learned it.
    pub event_id: Option<String>,
    /// Whether the relay accepted the event.
    pub accepted: bool,
    /// Relay message, kept for the run report.
    pub message: String,
}

impl PublishOutcome {
    /// An outcome for a publisher that accepted the row.
    pub fn accepted(event_id: Option<String>) -> Self {
        Self {
            event_id,
            accepted: true,
            message: "ok".to_string(),
        }
    }
}

/// A destination for projected task rows.
pub trait Publisher {
    /// Publish one mapped task, returning whether it was accepted.
    fn publish_task(
        &self,
        task: &MappedTask,
    ) -> impl std::future::Future<Output = Result<PublishOutcome, BridgeError>> + Send;
}

/// Build the signed `kind:44011` event for a mapped task.
///
/// Tag construction is fallible: an invalid tag is an error, never a panic and
/// never a silently dropped tag.
pub fn build_task_event(task: &MappedTask, keys: &Keys) -> Result<Event, BridgeError> {
    let mut tags = Vec::with_capacity(task.tags.len());
    for tag in &task.tags {
        let parsed =
            Tag::parse(tag.iter().map(String::as_str)).map_err(|error| BridgeError::Tag {
                name: tag.first().cloned().unwrap_or_default(),
                reason: error.to_string(),
            })?;
        tags.push(parsed);
    }
    EventBuilder::new(Kind::Custom(crate::KIND_AGENT_TASK), task.content.clone())
        .tags(tags)
        .sign_with_keys(keys)
        .map_err(|error| BridgeError::Sign(error.to_string()))
}

/// Publishes task rows to a relay over an authenticated WebSocket connection.
///
/// Each publish is a fresh connection, matching how the fleet worker and the
/// CLI talk to the relay. A long-lived connection is a later optimisation, and
/// the projection is not throughput-bound.
#[derive(Debug, Clone)]
pub struct RelayPublisher {
    relay_url: String,
    keys: Keys,
    timeout_secs: u64,
}

impl RelayPublisher {
    /// Build a publisher for `relay_url`, signing with `keys`.
    pub fn new(relay_url: impl Into<String>, keys: Keys, timeout_secs: u64) -> Self {
        Self {
            relay_url: relay_url.into(),
            keys,
            timeout_secs: timeout_secs.max(1),
        }
    }

    /// The publisher's public key in hex, for diagnostics and run reports.
    pub fn public_key_hex(&self) -> String {
        self.keys.public_key().to_hex()
    }
}

impl RelayPublisher {
    /// Publish an already-signed event.
    ///
    /// Task rows are built here; a plain message is built by the caller (a
    /// message is not a task row, and the two have different shapes).
    pub async fn publish_event(&self, event: Event) -> Result<PublishOutcome, BridgeError> {
        let event_id = event.id.to_hex();
        let response = buzz_ws_client::publish_event(
            &self.relay_url,
            event,
            &self.keys,
            None,
            self.timeout_secs,
        )
        .await
        .map_err(|error| BridgeError::Publish(error.to_string()))?;
        Ok(PublishOutcome {
            event_id: Some(event_id),
            accepted: response.accepted,
            message: response.message,
        })
    }
}

impl Publisher for RelayPublisher {
    async fn publish_task(&self, task: &MappedTask) -> Result<PublishOutcome, BridgeError> {
        let event = build_task_event(task, &self.keys)?;
        self.publish_event(event).await
    }
}

/// Records task rows instead of publishing them, for `--dry-run` and tests.
///
/// It is a real [`Publisher`], so a dry run and a live run exercise exactly the
/// same mapping, planning and state code paths.
#[derive(Debug, Default)]
pub struct DryRunPublisher {
    tasks: Mutex<Vec<MappedTask>>,
}

impl DryRunPublisher {
    /// A publisher that records and accepts everything.
    pub fn new() -> Self {
        Self::default()
    }

    /// The tasks received so far, in publish order.
    pub fn tasks(&self) -> Vec<MappedTask> {
        self.tasks
            .lock()
            .map(|tasks| tasks.clone())
            .unwrap_or_default()
    }
}

impl Publisher for DryRunPublisher {
    async fn publish_task(&self, task: &MappedTask) -> Result<PublishOutcome, BridgeError> {
        if let Ok(mut tasks) = self.tasks.lock() {
            tasks.push(task.clone());
        }
        Ok(PublishOutcome::accepted(None))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests_support::mapped_task;

    #[test]
    fn builds_a_signed_44011_event_with_the_mapped_tags() {
        let keys = Keys::generate();
        let task = mapped_task();
        let event = build_task_event(&task, &keys).expect("event builds");
        assert_eq!(event.kind, Kind::Custom(44011));
        assert_eq!(event.content, task.content);
        assert_eq!(event.pubkey, keys.public_key());
        let d_tag = event
            .tags
            .iter()
            .find(|tag| tag.as_slice().first().map(String::as_str) == Some("d"))
            .expect("d tag present");
        assert_eq!(
            d_tag.as_slice().get(1).map(String::as_str),
            Some("paperclip:iss_1")
        );
        assert!(!event.tags.is_empty());
    }

    /// A single-name tag such as `["d"]` is valid in nostr, so the real
    /// failure mode is a tag with no elements at all. The point of the test is
    /// that the error path returns a `BridgeError` instead of panicking on
    /// untrusted tag data.
    #[test]
    fn an_empty_tag_is_an_error_not_a_panic() {
        let keys = Keys::generate();
        let mut task = mapped_task();
        task.tags.push(Vec::new());
        let error = build_task_event(&task, &keys).expect_err("an empty tag must fail");
        assert!(matches!(error, BridgeError::Tag { .. }), "{error}");
    }

    #[test]
    fn a_name_only_tag_is_accepted_by_the_nostr_parser() {
        let keys = Keys::generate();
        let mut task = mapped_task();
        task.tags.push(vec!["d".to_string()]);
        let event = build_task_event(&task, &keys).expect("a name-only tag parses");
        assert_eq!(event.tags.len(), task.tags.len());
    }

    #[tokio::test]
    async fn dry_run_records_tasks_and_accepts_them() {
        let publisher = DryRunPublisher::new();
        let task = mapped_task();
        let outcome = publisher
            .publish_task(&task)
            .await
            .expect("dry run publishes");
        assert!(outcome.accepted);
        assert_eq!(publisher.tasks(), vec![task]);
    }
}
