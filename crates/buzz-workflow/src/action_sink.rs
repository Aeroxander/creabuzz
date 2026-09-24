//! Action sink trait — interface for workflow side-effects.
//!
//! The relay implements [`ActionSink`] to provide direct DB access to the
//! executor, replacing the HTTP loopback pattern.

use std::future::Future;
use std::pin::Pin;

use buzz_core::tenant::CommunityId;

/// Errors from action sink operations.
#[derive(Debug, thiserror::Error)]
pub enum ActionSinkError {
    /// An input parameter is malformed (e.g. invalid UUID).
    #[error("invalid input: {0}")]
    InvalidInput(String),
    /// The target channel does not exist.
    #[error("channel not found: {0}")]
    ChannelNotFound(String),
    /// The target channel is archived.
    #[error("channel is archived: {0}")]
    ChannelArchived(String),
    /// Nostr event construction or signing failed.
    #[error("event construction failed: {0}")]
    EventBuild(String),
    /// A database operation failed.
    #[error("database error: {0}")]
    Database(String),
    /// Message content is empty or whitespace-only.
    #[error("empty message content")]
    EmptyContent,
    /// The Agent Wiki distillation loop failed (LLM contract, corrupt cursor
    /// page, publish bounds, or unconfigured classifier). Surfaced as a
    /// visible workflow run failure — a scheduled distill must never silently
    /// no-op.
    #[error("agent wiki distill failed: {0}")]
    Distill(String),
}

impl From<ActionSinkError> for crate::WorkflowError {
    fn from(e: ActionSinkError) -> Self {
        crate::WorkflowError::WebhookError(e.to_string())
    }
}

/// Interface for workflow actions that produce side effects.
///
/// Implemented by the relay to provide direct DB/event access to the executor.
/// This replaces the HTTP loopback where the executor POSTed to the relay's
/// REST API (which failed with 401 auth errors).
///
/// Returns `Pin<Box<dyn Future>>` for dyn-compatibility — required because
/// `WorkflowEngine` stores `Arc<dyn ActionSink>`.
pub trait ActionSink: Send + Sync {
    /// Post a message to a channel on behalf of a workflow owner.
    ///
    /// - `community_id`: the server-resolved community that owns the workflow
    ///   run driving this side effect. The relay-signed message is published
    ///   under *this* community, never the deployment/default tenant — the run
    ///   carries its owning community so a workflow in community B posts into B
    ///   even though the side effect has no inbound connection to bind.
    /// - `channel_id`: UUID string of the target channel
    /// - `text`: rendered message body (must not be empty/whitespace-only)
    /// - `authored_text`: the workflow owner's stored, unrendered step template;
    ///   consumers must use this rather than trigger-controlled rendered output
    ///   when attaching authority-bearing metadata
    /// - `author_pubkey`: hex-encoded pubkey of the workflow owner (used for
    ///   the `p` attribution tag; the relay keypair signs the event)
    /// - `reply_to`: when `Some(event_id_hex)`, the message is posted as a
    ///   threaded reply to that event (NIP-10 root/reply tags + real thread
    ///   metadata); when `None`, it is a top-level channel message.
    ///
    /// Returns the event ID hex string on success.
    fn send_message(
        &self,
        community_id: CommunityId,
        channel_id: &str,
        text: &str,
        authored_text: &str,
        author_pubkey: &str,
        reply_to: Option<&str>,
    ) -> Pin<Box<dyn Future<Output = Result<String, ActionSinkError>> + Send + '_>>;

    /// Publish a workflow approval request (kind:46010) for a suspended run.
    ///
    /// Called after the approval row is durably persisted: emission is a
    /// notification, persistence is the contract. If emission fails, the run
    /// stays `WaitingApproval` with a pending approval row — the durable
    /// retry record — and the caller must surface the failure rather than
    /// rolling the suspension back.
    ///
    /// - `community_id` / `channel_id`: same scoping contract as
    ///   [`ActionSink::send_message`] — the event belongs to the run's
    ///   community, `h`-tagged to the channel so membership gates reads.
    /// - `token_hash_hex`: hex-encoded SHA-256 of the approval token UUID
    ///   (`d` tag — the same value grant/deny look up).
    /// - `approver_spec` / `message`: rendered from the stored step
    ///   definition (`from`, `message`); trigger-controlled text must never
    ///   reach authority-bearing tags (same rule as `authored_text` above —
    ///   here the whole payload is definition-rendered, never raw trigger).
    /// - `author_pubkey`: hex-encoded pubkey of the workflow owner (`p`
    ///   attribution tag; the relay keypair signs the event).
    ///
    /// Returns the event ID hex string on success.
    fn emit_approval_request(
        &self,
        community_id: CommunityId,
        channel_id: &str,
        token_hash_hex: &str,
        approver_spec: &str,
        message: &str,
        author_pubkey: &str,
    ) -> Pin<Box<dyn Future<Output = Result<String, ActionSinkError>> + Send + '_>>;

    /// Run the Agent Wiki distill loop for one wiki space and publish the
    /// standup page (kind:44002) — the `distill_agent_wiki` action.
    ///
    /// The sink executes the shared `buzz-agwiki` core end to end: bounded
    /// source fetch from the relay store (done kind:44011 tasks + published
    /// kind:37013 records since the page's durable cursor), the classifier
    /// LLM call (same `BUZZ_CLASSIFIER_*` env as `org classify` — **fail
    /// closed** on missing config: return [`ActionSinkError::Distill`] so a
    /// scheduled run leaves a visible run-status error instead of silently
    /// skipping), strict draft validation, and a relay-signed kind:44002
    /// publish through the relay's internal ingest path (which enforces the
    /// same `validate_agent_wiki_envelope` bounds as client publishes).
    ///
    /// - `community_id`: the run's owning community (same scoping contract as
    ///   [`ActionSink::send_message`]).
    /// - `space`: wiki space name; the page coordinate is `<space>/standup`.
    ///
    /// Returns the step-output object recorded in workflow run history:
    /// `{"status": "published", "space", "coordinate", "event_id", "cursor",
    /// "cost_tokens", "model", "sources"}` or `{"status": "skipped",
    /// "space", "coordinate", "since"}` when nothing new was found (skip
    /// cleanly — no LLM call, nothing published).
    fn distill_agent_wiki(
        &self,
        community_id: CommunityId,
        space: &str,
    ) -> Pin<Box<dyn Future<Output = Result<serde_json::Value, ActionSinkError>> + Send + '_>>;
}
