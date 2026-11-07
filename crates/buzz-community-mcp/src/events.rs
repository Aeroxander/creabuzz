//! Event construction and rendering for the community tools.
//!
//! All of this is pure: given keys and arguments it returns a signed event or
//! a string, so the wire shape is tested without a relay.

use buzz_sdk::ThreadRef;
use nostr::{Event, Keys, Kind};
use serde_json::json;
use uuid::Uuid;

use crate::{
    args::{event_id, task_status},
    McpError,
};

/// Kind of a channel message. Buzz messages are NIP-29 group messages: kind 9
/// with an `h` tag carrying the channel, built through `buzz-sdk` so mentions,
/// thread refs and the relay's 64 KiB content limit are applied the same way
/// every other client applies them. The integer lives in the kind registry
/// (`crates/buzz-core/src/kind.rs`, `KIND_STREAM_MESSAGE`); reference it rather
/// than re-hard-coding `9` so the two cannot drift.
pub const KIND_MESSAGE: u16 = buzz_core::kind::KIND_STREAM_MESSAGE as u16;

/// Kind of a fleet coordination task row.
pub const KIND_TASK: u16 = buzz_core::kind::KIND_AGENT_TASK as u16;

/// Build the thread reference for a reply.
///
/// A reply to a top-level message has no thread root of its own, so `reply_to`
/// doubles as the root. A reply to a nested message must pass `thread_root`,
/// otherwise the thread is attached to the wrong root.
pub fn thread_ref(
    reply_to: Option<&str>,
    thread_root: Option<&str>,
) -> Result<Option<ThreadRef>, McpError> {
    let Some(reply_to) = reply_to else {
        if thread_root.is_some() {
            return Err(McpError::InvalidArgument(
                "thread_root was given without reply_to".to_string(),
            ));
        }
        return Ok(None);
    };
    let parent_event_id = event_id(reply_to)?;
    let root_event_id = match thread_root {
        Some(root) => event_id(root)?,
        None => parent_event_id,
    };
    Ok(Some(ThreadRef {
        root_event_id,
        parent_event_id,
    }))
}

/// Build a signed channel message.
pub fn message_event(
    keys: &Keys,
    channel: Uuid,
    text: &str,
    thread: Option<&ThreadRef>,
) -> Result<Event, McpError> {
    buzz_sdk::build_message(channel, text, thread, &[], false, &[], &[])
        .map_err(|error| McpError::InvalidArgument(error.to_string()))?
        .sign_with_keys(keys)
        .map_err(|error| McpError::Sign(error.to_string()))
}

/// Build a signed task-status row.
///
/// The row carries only what a reader needs to render a status change. It is
/// deliberately not a full task record: the surface that owns the task (the
/// projection, or Paperclip) remains the source of truth for the rest.
pub fn task_status_event(
    keys: &Keys,
    task_id: &str,
    status: &str,
    channel: Option<Uuid>,
    title: Option<&str>,
) -> Result<Event, McpError> {
    // The `d` tag is taken verbatim so a caller can address a task that the
    // projection owns (`paperclip:<issue>`) or a Buzz-native one.
    let d = task_id.trim().to_string();
    let status = task_status(status)?;
    let mut content = json!({
        "title": title.map(str::to_string).unwrap_or_else(|| task_id.to_string()),
        "description": "",
        "status": status,
    });
    if let Some(object) = content.as_object_mut() {
        object.insert(
            "buzzMcp".to_string(),
            json!({ "updatedBy": keys.public_key().to_hex() }),
        );
    }
    let mut tags = vec![
        vec!["d".to_string(), d],
        vec!["p".to_string(), keys.public_key().to_hex()],
    ];
    if let Some(channel) = channel {
        tags.push(vec!["h".to_string(), channel.to_string()]);
    }
    let mut parsed = Vec::with_capacity(tags.len());
    for tag in tags {
        parsed.push(
            nostr::Tag::parse(tag.iter().map(String::as_str))
                .map_err(|error| McpError::InvalidArgument(error.to_string()))?,
        );
    }
    nostr::EventBuilder::new(Kind::Custom(KIND_TASK), content.to_string())
        .tags(parsed)
        // The `p` tag names the assignee, and a status update is often made by
        // that same agent. nostr drops a `p` tag pointing at the signer unless
        // self-tagging is allowed, which is why `buzz-sdk`'s message builder
        // opts in the same way; without this the assignee silently disappears.
        .allow_self_tagging()
        .sign_with_keys(keys)
        .map_err(|error| McpError::Sign(error.to_string()))
}

/// One task row, as a reader sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskRow {
    /// The `d` tag value.
    pub id: String,
    /// Rendered title.
    pub title: String,
    /// Status string as published.
    pub status: String,
    /// Assignee pubkey, when present.
    pub assignee: Option<String>,
    /// Author pubkey.
    pub author: String,
    /// Creation timestamp, in seconds.
    pub created_at: i64,
}

/// Parse a task row, returning `None` when the event is not one.
pub fn parse_task_row(event: &Event) -> Option<TaskRow> {
    if event.kind != Kind::Custom(KIND_TASK) {
        return None;
    }
    let id = tag_value(event, "d")?.to_string();
    let body: serde_json::Value = serde_json::from_str(&event.content).unwrap_or(json!({}));
    let title = body
        .get("title")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| id.clone());
    let status = body
        .get("status")
        .and_then(|value| value.as_str())
        .unwrap_or(buzz_core::kind::DEFAULT_TASK_STATUS)
        .to_string();
    Some(TaskRow {
        id,
        title,
        status,
        assignee: tag_value(event, "p").map(str::to_string),
        author: event.pubkey.to_hex(),
        created_at: event.created_at.as_secs() as i64,
    })
}

/// Reduce task rows to the newest row per `d` tag, newest first.
///
/// `kind:44011` is not an addressable kind, so every status change is its own
/// event. A reader therefore takes the newest row per task id, which is the
/// same read-side last-write-wins rule the Buzz clients apply. Without this a
/// board would show a task once per status change.
///
/// Two rows published in the same second tie, and the first one read wins. The
/// tie is genuinely ambiguous at one-second resolution - the same ambiguity the
/// clients have - so the rule is deterministic rather than arbitrary.
pub fn latest_task_rows(events: &[Event]) -> Vec<TaskRow> {
    let mut latest: Vec<TaskRow> = Vec::new();
    for row in events.iter().filter_map(parse_task_row) {
        match latest.iter_mut().find(|existing| existing.id == row.id) {
            Some(existing) if row.created_at > existing.created_at => *existing = row,
            Some(_) => {}
            None => latest.push(row),
        }
    }
    latest.sort_by_key(|row| std::cmp::Reverse(row.created_at));
    latest
}

fn tag_value<'a>(event: &'a Event, name: &str) -> Option<&'a str> {
    event
        .tags
        .iter()
        .find(|tag| tag.as_slice().first().map(String::as_str) == Some(name))
        .and_then(|tag| tag.as_slice().get(1))
        .map(String::as_str)
}

/// Render a message for a tool result: one line per message, oldest first.
pub fn format_messages(events: &[Event], limit: usize) -> String {
    let mut lines: Vec<String> = events
        .iter()
        .filter(|event| event.kind == Kind::Custom(KIND_MESSAGE))
        .map(|event| {
            let author = short(&event.pubkey.to_hex());
            let text = event.content.replace('\n', " ");
            let text = if text.chars().count() > 500 {
                format!("{}…", text.chars().take(500).collect::<String>())
            } else {
                text
            };
            format!("[{}] {}: {text}", event.created_at.as_secs(), author)
        })
        .collect();
    if lines.len() > limit {
        lines = lines.split_off(lines.len() - limit);
    }
    if lines.is_empty() {
        return "no messages matched".to_string();
    }
    lines.join("\n")
}

/// Render task rows for a tool result.
pub fn format_tasks(rows: &[TaskRow]) -> String {
    if rows.is_empty() {
        return "no task rows matched".to_string();
    }
    rows.iter()
        .map(|row| {
            let assignee = row
                .assignee
                .as_deref()
                .map(short)
                .unwrap_or_else(|| "unassigned".to_string());
            format!(
                "{} [{}] {} (by {})",
                row.id,
                row.status,
                row.title,
                if assignee == "unassigned" {
                    assignee
                } else {
                    format!("agent {assignee}")
                }
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn short(hex: &str) -> String {
    hex.chars().take(8).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys() -> Keys {
        Keys::generate()
    }

    #[test]
    fn a_message_is_kind_9_with_an_h_tag() {
        let channel = Uuid::parse_str("9c1f0f4a-0000-4000-8000-000000000001").expect("uuid");
        let event = message_event(&keys(), channel, "hello", None).expect("builds");
        assert_eq!(event.kind, Kind::Custom(9));
        assert_eq!(event.content, "hello");
        assert_eq!(tag_value(&event, "h"), Some(channel.to_string().as_str()));
    }

    #[test]
    fn a_top_level_reply_uses_the_parent_as_its_thread_root() {
        let hex = "a".repeat(64);
        let thread = thread_ref(Some(&hex), None)
            .expect("thread builds")
            .expect("some thread");
        assert_eq!(thread.root_event_id.to_hex(), hex);
        assert_eq!(thread.parent_event_id.to_hex(), hex);
    }

    #[test]
    fn a_nested_reply_keeps_the_given_root() {
        let parent = "b".repeat(64);
        let root = "c".repeat(64);
        let thread = thread_ref(Some(&parent), Some(&root))
            .expect("thread builds")
            .expect("some thread");
        assert_eq!(thread.root_event_id.to_hex(), root);
        assert_eq!(thread.parent_event_id.to_hex(), parent);
    }

    #[test]
    fn a_thread_root_without_a_reply_is_rejected() {
        assert!(matches!(
            thread_ref(None, Some(&"d".repeat(64))),
            Err(McpError::InvalidArgument(_))
        ));
    }

    #[test]
    fn a_status_row_is_kind_44011_and_carries_the_new_status() {
        let keys = keys();
        let channel = Uuid::parse_str("9c1f0f4a-0000-4000-8000-000000000001").expect("uuid");
        let event = task_status_event(&keys, "open:task-1", "done", Some(channel), Some("Ship it"))
            .expect("builds");
        assert_eq!(event.kind, Kind::Custom(44011));
        assert_eq!(tag_value(&event, "d"), Some("open:task-1"));
        assert_eq!(tag_value(&event, "h"), Some(channel.to_string().as_str()));
        let body: serde_json::Value = serde_json::from_str(&event.content).expect("json");
        assert_eq!(body["status"], "done");
        assert_eq!(body["title"], "Ship it");
    }

    #[test]
    fn a_status_row_rejects_an_unknown_status() {
        let error = task_status_event(&keys(), "t1", "shipped", None, None).expect_err("rejected");
        assert!(matches!(error, McpError::InvalidArgument(_)));
    }

    #[test]
    fn a_task_row_without_a_title_falls_back_to_its_id() {
        let keys = keys();
        let event = task_status_event(&keys, "open:t9", "open", None, None).expect("builds");
        let row = parse_task_row(&event).expect("row parses");
        assert_eq!(row.id, "open:t9");
        assert_eq!(row.title, "open:t9");
        assert_eq!(row.status, "open");
        assert_eq!(row.assignee, Some(keys.public_key().to_hex()));
    }

    #[test]
    fn a_non_task_event_is_not_a_task_row() {
        let keys = keys();
        let channel = Uuid::parse_str("9c1f0f4a-0000-4000-8000-000000000001").expect("uuid");
        let event = message_event(&keys, channel, "hi", None).expect("builds");
        assert!(parse_task_row(&event).is_none());
    }

    #[test]
    fn messages_render_oldest_last_and_bound_their_length() {
        let keys = keys();
        let channel = Uuid::parse_str("9c1f0f4a-0000-4000-8000-000000000001").expect("uuid");
        let events: Vec<Event> = (0..3)
            .map(|n| message_event(&keys, channel, &format!("m{n}"), None).expect("builds"))
            .collect();
        let rendered = format_messages(&events, 10);
        assert_eq!(rendered.lines().count(), 3);
        let bounded = format_messages(&events, 2);
        assert_eq!(bounded.lines().count(), 2, "the limit keeps the newest");
        assert_eq!(format_messages(&[], 10), "no messages matched");
    }

    #[test]
    fn a_long_message_is_truncated_in_rendering() {
        let keys = keys();
        let channel = Uuid::parse_str("9c1f0f4a-0000-4000-8000-000000000001").expect("uuid");
        let long = "x".repeat(600);
        let event = message_event(&keys, channel, &long, None).expect("builds");
        let rendered = format_messages(&[event], 10);
        assert!(rendered.contains('…'));
        assert!(rendered.chars().count() < 600);
    }

    /// Re-stamp an event so ordering is unambiguous in tests.
    fn at(mut event: Event, seconds: u64) -> Event {
        event.created_at = nostr::Timestamp::from(seconds);
        event
    }

    #[test]
    fn only_the_newest_row_per_task_is_returned() {
        let keys = keys();
        let older = at(
            task_status_event(&keys, "open:t1", "open", None, Some("Ship it")).expect("builds"),
            1_000,
        );
        let newer = at(
            task_status_event(&keys, "open:t1", "done", None, Some("Ship it")).expect("builds"),
            2_000,
        );
        let other = at(
            task_status_event(&keys, "open:t2", "open", None, None).expect("builds"),
            3_000,
        );
        let rows = latest_task_rows(&[older, newer, other]);
        assert_eq!(rows.len(), 2, "one row per task id");
        let t1 = rows.iter().find(|row| row.id == "open:t1").expect("t1");
        assert_eq!(t1.status, "done", "the newest status wins");
        assert_eq!(rows[0].id, "open:t2", "rows are newest first");
    }

    #[test]
    fn task_rows_render_one_line_each() {
        let keys = keys();
        let row = parse_task_row(
            &task_status_event(&keys, "open:t9", "in_progress", None, Some("Ship it"))
                .expect("builds"),
        )
        .expect("parses");
        let rendered = format_tasks(&[row]);
        assert!(rendered.contains("open:t9"), "{rendered}");
        assert!(rendered.contains("in_progress"), "{rendered}");
        assert!(rendered.contains("Ship it"), "{rendered}");
        assert_eq!(format_tasks(&[]), "no task rows matched");
    }
}
