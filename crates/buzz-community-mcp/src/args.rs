//! Tool arguments, and the validation that turns caller strings into typed ids.
//!
//! Validation lives here rather than inside the tool bodies so it is testable
//! without a relay, and so every tool rejects bad input the same way.

use nostr::EventId;
use schemars::JsonSchema;
use serde::Deserialize;
use uuid::Uuid;

use crate::McpError;

/// Read a channel's recent messages.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct ReadChannelParams {
    /// Channel UUID to read.
    pub channel: String,
    /// Maximum messages to return (default 50, capped at 200).
    #[serde(default)]
    pub limit: Option<u32>,
}

/// Post a message to a channel.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct PostMessageParams {
    /// Channel UUID to post into.
    pub channel: String,
    /// Message text (capped at 64 KiB by the relay).
    pub text: String,
    /// Hex event id of the message being replied to.
    #[serde(default)]
    pub reply_to: Option<String>,
    /// Hex event id of the thread root, when replying to a nested message.
    /// Defaults to `reply_to`, which is correct for a top-level reply.
    #[serde(default)]
    pub thread_root: Option<String>,
}

/// List task rows (kind:44011).
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct ListTasksParams {
    /// Optional channel UUID to scope the read to.
    #[serde(default)]
    pub channel: Option<String>,
    /// Maximum task rows to return (default 100, capped at 500).
    #[serde(default)]
    pub limit: Option<u32>,
}

/// Move a task to a new status by publishing a new task row.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct SetTaskStatusParams {
    /// The task `d` tag value (the task id).
    pub task_id: String,
    /// New status: one of open, assigned, in_progress, needs_approval, done, cancelled.
    pub status: String,
    /// Optional channel UUID to keep the row scoped to its channel.
    #[serde(default)]
    pub channel: Option<String>,
    /// Optional title, so a row created without one still renders.
    #[serde(default)]
    pub title: Option<String>,
}

/// Parse a channel UUID supplied by a caller.
pub fn channel_id(raw: &str) -> Result<Uuid, McpError> {
    Uuid::parse_str(raw.trim()).map_err(|error| {
        McpError::InvalidArgument(format!("`{raw}` is not a channel UUID: {error}"))
    })
}

/// Parse a hex event id supplied by a caller.
pub fn event_id(raw: &str) -> Result<EventId, McpError> {
    EventId::parse(raw.trim())
        .map_err(|error| McpError::InvalidArgument(format!("`{raw}` is not an event id: {error}")))
}

/// Clamp a caller-supplied limit into a bounded range.
///
/// Every read is capped on purpose: a tool caller must not be able to ask for
/// an unbounded result set.
pub fn limit_or_default(requested: Option<u32>, default: u32, cap: u32) -> u32 {
    requested.unwrap_or(default).clamp(1, cap)
}

/// Validate a task status against the shared vocabulary.
pub fn task_status(raw: &str) -> Result<String, McpError> {
    let normalised = raw.trim().to_ascii_lowercase();
    if buzz_core::kind::TASK_STATUSES.contains(&normalised.as_str()) {
        Ok(normalised)
    } else {
        Err(McpError::InvalidArgument(format!(
            "`{raw}` is not a task status; expected one of {}",
            buzz_core::kind::TASK_STATUSES.join(", ")
        )))
    }
}

/// Reject empty or whitespace-only text before it reaches the relay.
pub fn non_empty_text(raw: &str, what: &str) -> Result<String, McpError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(McpError::InvalidArgument(format!(
            "{what} must not be empty"
        )));
    }
    Ok(trimmed.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limits_are_bounded_in_both_directions() {
        assert_eq!(limit_or_default(None, 50, 200), 50);
        assert_eq!(
            limit_or_default(Some(0), 50, 200),
            1,
            "zero must not read nothing"
        );
        assert_eq!(limit_or_default(Some(10_000), 50, 200), 200);
        assert_eq!(limit_or_default(Some(75), 50, 200), 75);
    }

    #[test]
    fn task_statuses_accept_the_shared_vocabulary_and_normalise_case() {
        for status in buzz_core::kind::TASK_STATUSES {
            assert_eq!(task_status(status).expect("status accepted"), status);
        }
        assert_eq!(task_status("  Done  ").expect("accepted"), "done");
        let error = task_status("shipped").expect_err("unknown status rejected");
        assert!(format!("{error}").contains("expected one of"));
    }

    #[test]
    fn channel_ids_and_event_ids_reject_junk() {
        assert!(channel_id("9c1f0f4a-0000-4000-8000-000000000001").is_ok());
        assert!(channel_id("general").is_err());
        assert!(channel_id("").is_err());
        let hex = "1".repeat(64);
        assert!(event_id(&hex).is_ok());
        assert!(event_id("not-an-id").is_err());
    }

    #[test]
    fn empty_text_is_rejected() {
        assert!(non_empty_text("  ", "text").is_err());
        assert_eq!(non_empty_text(" hi ", "text").expect("trimmed"), "hi");
    }
}
