//! Buzz community MCP server.
//!
//! Exposes a small, typed surface over a Buzz community so an external agent
//! (for example a Paperclip-managed agent) can take part in the conversation
//! and move work: read a channel, post a message, list task rows, and set a
//! task's status.
//!
//! The server acts as exactly one Buzz identity, taken from `BUZZ_PRIVATE_KEY`.
//! It never borrows a human's identity, and it does not invent one: every event
//! it publishes is signed by that key, so attribution in the community stays
//! truthful.

#![cfg_attr(not(windows), forbid(unsafe_code))]

use std::sync::Arc;
use std::time::Duration;

use rmcp::{
    handler::server::wrapper::Parameters,
    model::{ServerCapabilities, ServerInfo},
    tool, tool_handler, tool_router,
    transport::stdio,
    ErrorData, ServerHandler, ServiceExt,
};
use serde_json::json;

pub mod args;
pub mod events;
pub mod relay;

pub use crate::relay::{BoxFut, BuzzRelay, PublishOutcome, QueryOutcome, WsRelay};

/// Failures a tool can report.
#[derive(Debug, thiserror::Error)]
pub enum McpError {
    /// The caller passed something unusable.
    #[error("invalid argument: {0}")]
    InvalidArgument(String),
    /// The relay refused, closed, or could not be reached.
    #[error("relay error: {0}")]
    Relay(String),
    /// An event could not be signed.
    #[error("cannot sign event: {0}")]
    Sign(String),
}

impl From<McpError> for ErrorData {
    fn from(error: McpError) -> Self {
        match error {
            McpError::InvalidArgument(message) => ErrorData::invalid_params(message, None),
            other => ErrorData::internal_error(other.to_string(), None),
        }
    }
}

/// Default number of messages a read returns.
pub const DEFAULT_MESSAGE_LIMIT: u32 = 50;
/// Hard cap on messages per read.
pub const MAX_MESSAGE_LIMIT: u32 = 200;
/// Default number of task rows a read returns.
pub const DEFAULT_TASK_LIMIT: u32 = 100;
/// Hard cap on task rows per read.
pub const MAX_TASK_LIMIT: u32 = 500;
/// How long a query waits for end-of-stored-events.
pub const QUERY_TIMEOUT: Duration = Duration::from_secs(10);

/// The MCP server.
///
/// It holds the signing key as well as the relay client so that event
/// construction and relay authentication cannot drift apart: both are built
/// from the same key by [`run`], and the signatures are what make a community
/// member able to attribute the action to this agent.
#[derive(Clone)]
pub struct CommunityMcp {
    relay: Arc<dyn BuzzRelay>,
    keys: nostr::Keys,
}

#[tool_router]
impl CommunityMcp {
    /// Build a server on top of a relay client.
    ///
    /// `keys` must be the same identity `relay` authenticates as; passing a
    /// different key would publish events the relay cannot attribute.
    pub fn new(relay: Arc<dyn BuzzRelay>, keys: nostr::Keys) -> Self {
        Self { relay, keys }
    }

    #[tool(
        name = "buzz_whoami",
        description = "Report the Buzz identity this server acts as, and the relay it publishes to. Call this first when you need to know which agent you are in the community."
    )]
    pub async fn buzz_whoami(&self) -> Result<String, ErrorData> {
        Ok(format!(
            "relay: {}\nidentity (hex pubkey): {}\nAll events this server publishes are signed by that identity.",
            self.relay.relay_url(),
            self.relay.identity()
        ))
    }

    #[tool(
        name = "buzz_read_channel",
        description = "Read recent messages from a Buzz channel. Returns one line per message, oldest first, as `[unix_seconds] short_pubkey: text`. The channel is identified by its UUID."
    )]
    pub async fn buzz_read_channel(
        &self,
        Parameters(params): Parameters<args::ReadChannelParams>,
    ) -> Result<String, ErrorData> {
        let channel = args::channel_id(&params.channel)?;
        let limit = args::limit_or_default(params.limit, DEFAULT_MESSAGE_LIMIT, MAX_MESSAGE_LIMIT);
        let outcome = self
            .relay
            .query(json!({
                "kinds": [events::KIND_MESSAGE],
                "#h": [channel.to_string()],
                "limit": limit,
            }))
            .await?;
        let rendered = events::format_messages(&outcome.events, limit as usize);
        Ok(with_truncation_note(rendered, outcome.complete))
    }

    #[tool(
        name = "buzz_post_message",
        description = "Post a message into a Buzz channel as this server's identity. Set reply_to to the hex event id of a message to reply in its thread; also set thread_root when replying to a nested message."
    )]
    pub async fn buzz_post_message(
        &self,
        Parameters(params): Parameters<args::PostMessageParams>,
    ) -> Result<String, ErrorData> {
        let channel = args::channel_id(&params.channel)?;
        let text = args::non_empty_text(&params.text, "text")?;
        let thread = events::thread_ref(params.reply_to.as_deref(), params.thread_root.as_deref())?;
        let event = events::message_event(&self.keys, channel, &text, thread.as_ref())?;
        let outcome = self.relay.publish(event).await?;
        Ok(describe_publish("posted message", &outcome))
    }

    #[tool(
        name = "buzz_list_tasks",
        description = "List task rows in the community (kind:44011), newest status per task. Returns one line per task as `task_id [status] title (by agent)`. Optionally scope to one channel UUID."
    )]
    pub async fn buzz_list_tasks(
        &self,
        Parameters(params): Parameters<args::ListTasksParams>,
    ) -> Result<String, ErrorData> {
        let limit = args::limit_or_default(params.limit, DEFAULT_TASK_LIMIT, MAX_TASK_LIMIT);
        let mut filter = json!({ "kinds": [events::KIND_TASK], "limit": limit });
        if let Some(channel) = params.channel.as_deref() {
            let channel = args::channel_id(channel)?;
            filter["#h"] = json!([channel.to_string()]);
        }
        let outcome = self.relay.query(filter).await?;
        let rows = events::latest_task_rows(&outcome.events);
        let rendered = events::format_tasks(&rows);
        Ok(with_truncation_note(rendered, outcome.complete))
    }

    #[tool(
        name = "buzz_set_task_status",
        description = "Move a task to a new status by publishing a new kind:44011 row. Status must be one of open, assigned, in_progress, needs_approval, done, cancelled. Pass the task's d tag value as task_id."
    )]
    pub async fn buzz_set_task_status(
        &self,
        Parameters(params): Parameters<args::SetTaskStatusParams>,
    ) -> Result<String, ErrorData> {
        let channel = match params.channel.as_deref() {
            Some(channel) => Some(args::channel_id(channel)?),
            None => None,
        };
        let event = events::task_status_event(
            &self.keys,
            &params.task_id,
            &params.status,
            channel,
            params.title.as_deref(),
        )?;
        let outcome = self.relay.publish(event).await?;
        Ok(describe_publish("published task row", &outcome))
    }
}

#[tool_handler]
impl ServerHandler for CommunityMcp {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build()).with_instructions(
            "Buzz community tools. You act as one Buzz identity. Use buzz_read_channel and \
             buzz_list_tasks to see what the community is doing, buzz_post_message to take part, \
             and buzz_set_task_status to move work."
                .to_string(),
        )
    }
}

/// Append a warning when a read did not reach end-of-stored-events.
fn with_truncation_note(rendered: String, complete: bool) -> String {
    if complete {
        rendered
    } else {
        format!(
            "{rendered}\n\nNOTE: this read stopped before end-of-stored-events, so it may be \
             incomplete."
        )
    }
}

/// Render a publish outcome for a tool result.
fn describe_publish(what: &str, outcome: &PublishOutcome) -> String {
    if outcome.accepted {
        format!("{what}: accepted as {}", outcome.event_id)
    } else {
        format!(
            "{what}: NOT accepted by the relay — {}. Event id {}.",
            outcome.message, outcome.event_id
        )
    }
}

/// Read identity and relay URL from the environment and serve over stdio.
///
/// `BUZZ_RELAY_URL` and `BUZZ_PRIVATE_KEY` are the same variables the ACP
/// harness injects into managed agents, so a managed agent can host this server
/// without extra configuration.
pub fn config_from_env() -> Result<(String, nostr::Keys), McpError> {
    let relay_url = std::env::var("BUZZ_RELAY_URL")
        .map_err(|_| McpError::InvalidArgument("BUZZ_RELAY_URL is not set".to_string()))?;
    let private_key = std::env::var("BUZZ_PRIVATE_KEY")
        .map_err(|_| McpError::InvalidArgument("BUZZ_PRIVATE_KEY is not set".to_string()))?;
    let keys = nostr::Keys::parse(private_key.trim()).map_err(|error| {
        McpError::InvalidArgument(format!("BUZZ_PRIVATE_KEY is invalid: {error}"))
    })?;
    Ok((relay_url, keys))
}

/// Serve the community tools over stdio.
pub async fn run() -> Result<(), Box<dyn std::error::Error>> {
    // Install ring as the process-level rustls provider before any TLS work.
    let _ = rustls::crypto::ring::default_provider().install_default();
    // stdout carries the MCP protocol, so logs must go to stderr.
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_ansi(false)
        .init();

    let (relay_url, keys) = config_from_env()?;
    let identity = keys.public_key().to_hex();
    let relay = Arc::new(WsRelay::new(relay_url.clone(), keys.clone(), QUERY_TIMEOUT));
    tracing::info!(relay = %relay_url, identity = %identity, "buzz-community-mcp starting");

    let service = CommunityMcp::new(relay, keys).serve(stdio()).await?;
    service.waiting().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_truncated_read_says_so() {
        assert_eq!(with_truncation_note("x".to_string(), true), "x");
        let noted = with_truncation_note("x".to_string(), false);
        assert!(noted.contains("may be incomplete"), "{noted}");
    }

    #[test]
    fn a_rejected_publish_is_reported_as_rejected() {
        let outcome = PublishOutcome {
            event_id: "abc".to_string(),
            accepted: false,
            message: "blocked: p-gate".to_string(),
        };
        let text = describe_publish("posted message", &outcome);
        assert!(text.contains("NOT accepted"), "{text}");
        assert!(text.contains("p-gate"), "{text}");
    }
}
