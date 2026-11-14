//! Where the `apply` direction reads Buzz task rows from.

use std::path::PathBuf;
use std::time::Duration;

use buzz_ws_client::{NostrWsConnection, RelayMessage};
use nostr::{Event, Keys, Kind};
use serde_json::json;

use crate::apply::{BuzzTask, TaskBatch, TaskFeed};
use crate::BridgeError;

/// Kind of a fleet coordination task row.
pub const KIND_TASK: u16 = buzz_core::kind::KIND_AGENT_TASK as u16;

/// Tag naming the system that projected a row.
pub const TAG_SOURCE: &str = "source";
/// Value of [`TAG_SOURCE`] written by the projection.
pub const TAG_SOURCE_PAPERCLIP: &str = "paperclip";

fn tag_value<'a>(event: &'a Event, name: &str) -> Option<&'a str> {
    event
        .tags
        .iter()
        .find(|tag| tag.as_slice().first().map(String::as_str) == Some(name))
        .and_then(|tag| tag.as_slice().get(1))
        .map(String::as_str)
}

/// Parse relay events into task rows.
///
/// A row tagged `source=paperclip` came *from* Paperclip, so it is marked
/// `projected` and the apply direction skips it. Without that mark the bridge
/// would turn its own projection back into a new issue, once per run.
pub fn parse_task_events(events: &[Event]) -> Vec<BuzzTask> {
    let mut tasks: Vec<BuzzTask> = Vec::new();
    for event in events
        .iter()
        .filter(|event| event.kind == Kind::Custom(KIND_TASK))
    {
        let Some(d) = tag_value(event, "d") else {
            continue;
        };
        let body: serde_json::Value = serde_json::from_str(&event.content).unwrap_or(json!({}));
        let title = body
            .get("title")
            .and_then(|value| value.as_str())
            .filter(|value| !value.trim().is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| d.to_string());
        let task = BuzzTask {
            d: d.to_string(),
            title,
            description: body
                .get("description")
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .to_string(),
            status: body
                .get("status")
                .and_then(|value| value.as_str())
                .unwrap_or(buzz_core::kind::DEFAULT_TASK_STATUS)
                .to_string(),
            assignee: tag_value(event, "p").map(str::to_string),
            event_id: event.id.to_hex(),
            author: event.pubkey.to_hex(),
            created_at: event.created_at.as_secs(),
            projected: tag_value(event, TAG_SOURCE) == Some(TAG_SOURCE_PAPERCLIP),
        };
        // One row per task: the newest wins, matching the clients. Rows in the
        // same second tie and the first read wins, which is deterministic.
        match tasks.iter_mut().find(|existing| existing.d == task.d) {
            Some(existing) if task.created_at > existing.created_at => *existing = task,
            Some(_) => {}
            None => tasks.push(task),
        }
    }
    tasks
}

/// Reads task rows from a JSON file, for dry runs and tests.
#[derive(Debug, Clone)]
pub struct JsonFileTaskFeed {
    path: PathBuf,
}

impl JsonFileTaskFeed {
    /// Read tasks from `path`.
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }
}

impl TaskFeed for JsonFileTaskFeed {
    async fn fetch_tasks(
        &self,
        _channel: Option<&str>,
        _since: Option<&str>,
    ) -> Result<TaskBatch, BridgeError> {
        let text = std::fs::read_to_string(&self.path).map_err(|error| {
            BridgeError::Source(format!("cannot read {}: {error}", self.path.display()))
        })?;
        let tasks: Vec<BuzzTask> = serde_json::from_str(&text).map_err(|error| {
            BridgeError::Source(format!("cannot parse {}: {error}", self.path.display()))
        })?;
        // A file read is a complete read: the file is the whole feed.
        Ok(TaskBatch::complete(tasks))
    }
}

/// Subscription id used for the task query.
const SUB_ID: &str = "buzz-paperclip-apply";

/// Row cap for one relay read. Hitting it means the read may be incomplete,
/// the same way the projection side treats its page cap.
const APPLY_READ_LIMIT: u64 = 500;

/// Reads task rows from a Buzz relay.
#[derive(Debug, Clone)]
pub struct RelayTaskFeed {
    relay_url: String,
    keys: Keys,
    channel: Option<String>,
    timeout: Duration,
}

impl RelayTaskFeed {
    /// Read task rows from `relay_url`, optionally scoped to one channel.
    pub fn new(
        relay_url: impl Into<String>,
        keys: Keys,
        channel: Option<String>,
        timeout: Duration,
    ) -> Self {
        Self {
            relay_url: relay_url.into(),
            keys,
            channel,
            timeout,
        }
    }
}

impl TaskFeed for RelayTaskFeed {
    async fn fetch_tasks(
        &self,
        channel: Option<&str>,
        _since: Option<&str>,
    ) -> Result<TaskBatch, BridgeError> {
        let mut connection = NostrWsConnection::connect(&self.relay_url)
            .await
            .map_err(|error| BridgeError::Source(format!("cannot connect to relay: {error}")))?;
        connection
            .authenticate(&self.keys, None)
            .await
            .map_err(|error| BridgeError::Source(format!("relay auth failed: {error}")))?;

        let channel = channel.map(str::to_string).or_else(|| self.channel.clone());
        let mut filter = json!({ "kinds": [KIND_TASK], "limit": APPLY_READ_LIMIT });
        if let Some(channel) = channel.as_deref() {
            filter["#h"] = json!([channel]);
        }
        connection
            .send_raw(&json!(["REQ", SUB_ID, filter]))
            .await
            .map_err(|error| BridgeError::Source(format!("cannot send REQ: {error}")))?;

        let deadline = std::time::Instant::now() + self.timeout;
        let mut events = Vec::new();
        // The read is only known complete when the relay sends EOSE. A timeout,
        // a read error, or filling the row cap all leave it possibly short, and
        // the caller must be told rather than left to assume "these are all".
        let mut eose_seen = false;
        while std::time::Instant::now() < deadline {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            match connection
                .next_event(remaining.min(Duration::from_millis(1500)))
                .await
            {
                Ok(RelayMessage::Event { event, .. }) => events.push(*event),
                Ok(RelayMessage::Eose { .. }) => {
                    eose_seen = true;
                    break;
                }
                Ok(RelayMessage::Closed { message, .. }) => {
                    // A closed subscription is a failure: the relay refuses
                    // filters it considers unscoped, and reporting that as "no
                    // tasks" would hide a misconfiguration.
                    let _ = connection.send_raw(&json!(["CLOSE", SUB_ID])).await;
                    let _ = connection.disconnect().await;
                    return Err(BridgeError::Source(format!(
                        "relay closed the subscription: {message}"
                    )));
                }
                Ok(_) => {}
                Err(_) => break,
            }
        }
        let _ = connection.send_raw(&json!(["CLOSE", SUB_ID])).await;
        let _ = connection.disconnect().await;
        let tasks = parse_task_events(&events);
        if eose_seen && (events.len() as u64) < APPLY_READ_LIMIT {
            Ok(TaskBatch::complete(tasks))
        } else {
            tracing::warn!(
                rows = events.len(),
                eose_seen,
                "apply feed read is incomplete; acting only on what was read"
            );
            Ok(TaskBatch::truncated(tasks))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::Tag;

    fn task_event(
        keys: &Keys,
        d: &str,
        status: &str,
        extra: Vec<Vec<&str>>,
        seconds: u64,
    ) -> Event {
        let mut tags = vec![vec!["d", d]];
        tags.extend(extra);
        let parsed: Vec<Tag> = tags
            .into_iter()
            .map(|tag| Tag::parse(tag).expect("tag"))
            .collect();
        nostr::EventBuilder::new(
            Kind::Custom(KIND_TASK),
            json!({ "title": "T", "status": status }).to_string(),
        )
        .tags(parsed)
        .custom_created_at(nostr::Timestamp::from(seconds))
        .sign_with_keys(keys)
        .expect("signs")
    }

    #[test]
    fn parses_a_task_row() {
        let keys = Keys::generate();
        let event = task_event(&keys, "open:t1", "in_progress", vec![vec!["h", "chan"]], 10);
        let tasks = parse_task_events(&[event]);
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].d, "open:t1");
        assert_eq!(tasks[0].status, "in_progress");
        assert!(!tasks[0].projected);
    }

    /// An MCP `task_status` row on a projected task carries the projected `d`
    /// tag verbatim but no `source` tag. It parses `projected == false` —
    /// which is why the apply-side decide path also refuses `paperclip:`
    /// prefixes instead of trusting this flag alone.
    #[test]
    fn a_projected_task_s_status_row_without_a_source_tag_parses_unmarked() {
        let keys = Keys::generate();
        let event = task_event(
            &keys,
            "paperclip:iss_1",
            "done",
            vec![vec!["h", "chan"]],
            30,
        );
        let tasks = parse_task_events(&[event]);
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].d, "paperclip:iss_1");
        assert!(
            !tasks[0].projected,
            "without a source tag the parse cannot know the row is projected"
        );
    }

    #[test]
    fn a_projected_row_is_marked_so_it_is_never_created_again() {
        let keys = Keys::generate();
        let event = task_event(
            &keys,
            "paperclip:iss_1",
            "open",
            vec![vec!["source", "paperclip"]],
            10,
        );
        let tasks = parse_task_events(&[event]);
        assert!(
            tasks[0].projected,
            "the bridge must not turn its own projection into a new issue"
        );
    }

    #[test]
    fn only_the_newest_row_per_task_survives() {
        let keys = Keys::generate();
        let older = task_event(&keys, "open:t1", "open", vec![], 10);
        let newer = task_event(&keys, "open:t1", "done", vec![], 20);
        let tasks = parse_task_events(&[older, newer]);
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].status, "done");
    }

    #[test]
    fn a_row_without_a_d_tag_is_ignored() {
        let keys = Keys::generate();
        let parsed: Vec<Tag> = vec![];
        let event = nostr::EventBuilder::new(Kind::Custom(KIND_TASK), "{}".to_string())
            .tags(parsed)
            .sign_with_keys(&keys)
            .expect("signs");
        assert!(parse_task_events(&[event]).is_empty());
    }

    #[test]
    fn a_non_task_event_is_ignored() {
        let keys = Keys::generate();
        let event = nostr::EventBuilder::new(Kind::Custom(9), "hi".to_string())
            .sign_with_keys(&keys)
            .expect("signs");
        assert!(parse_task_events(&[event]).is_empty());
    }
}
