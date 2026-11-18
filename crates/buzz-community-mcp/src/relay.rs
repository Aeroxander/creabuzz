//! Relay access for the community tools.
//!
//! The tools talk to a [`BuzzRelay`], not to a socket, so every tool can be
//! tested against a fake. The trait uses boxed futures because the server holds
//! it as a trait object.

use std::future::Future;
use std::pin::Pin;
use std::time::{Duration, Instant};

use buzz_ws_client::{NostrWsConnection, RelayMessage};
use nostr::{Event, Keys};
use serde_json::{json, Value};

use crate::McpError;

/// A boxed future, used to keep [`BuzzRelay`] object-safe.
pub type BoxFut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Result of publishing one event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublishOutcome {
    /// Event id the relay acknowledged.
    pub event_id: String,
    /// Whether the relay accepted the event.
    pub accepted: bool,
    /// Relay message, surfaced to the caller.
    pub message: String,
}

/// Result of a relay query.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueryOutcome {
    /// Events returned before end-of-stored-events.
    pub events: Vec<Event>,
    /// True when the relay signalled end-of-stored-events. A false value means
    /// the read timed out and may be incomplete, which the caller must say out
    /// loud rather than present as a full answer.
    pub complete: bool,
}

/// The relay operations the community tools need.
pub trait BuzzRelay: Send + Sync {
    /// Relay URL this server publishes to.
    fn relay_url(&self) -> &str;
    /// Identity the server acts as, in hex.
    fn identity(&self) -> String;
    /// Publish a signed event.
    fn publish(&self, event: Event) -> BoxFut<'_, Result<PublishOutcome, McpError>>;
    /// Run one query and collect the events.
    fn query(&self, filter: Value) -> BoxFut<'_, Result<QueryOutcome, McpError>>;
}

/// Subscription id used for the single query a tool runs at a time.
const QUERY_SUB_ID: &str = "buzz-community-mcp";

/// Talks to a Buzz relay over an authenticated WebSocket.
#[derive(Debug, Clone)]
pub struct WsRelay {
    relay_url: String,
    keys: Keys,
    query_timeout: Duration,
}

impl WsRelay {
    /// Build a relay client for `relay_url`, signing as `keys`.
    pub fn new(relay_url: impl Into<String>, keys: Keys, query_timeout: Duration) -> Self {
        Self {
            relay_url: relay_url.into(),
            keys,
            query_timeout,
        }
    }

    async fn connection(&self) -> Result<NostrWsConnection, McpError> {
        let mut connection = NostrWsConnection::connect(&self.relay_url)
            .await
            .map_err(|error| McpError::Relay(format!("cannot connect to relay: {error}")))?;
        connection
            .authenticate(&self.keys, None)
            .await
            .map_err(|error| McpError::Relay(format!("relay authentication failed: {error}")))?;
        Ok(connection)
    }
}

impl BuzzRelay for WsRelay {
    fn relay_url(&self) -> &str {
        &self.relay_url
    }

    fn identity(&self) -> String {
        self.keys.public_key().to_hex()
    }

    fn publish(&self, event: Event) -> BoxFut<'_, Result<PublishOutcome, McpError>> {
        Box::pin(async move {
            let event_id = event.id.to_hex();
            let response =
                buzz_ws_client::publish_event(&self.relay_url, event, &self.keys, None, 15)
                    .await
                    .map_err(|error| McpError::Relay(error.to_string()))?;
            Ok(PublishOutcome {
                event_id,
                accepted: response.accepted,
                message: response.message,
            })
        })
    }

    fn query(&self, filter: Value) -> BoxFut<'_, Result<QueryOutcome, McpError>> {
        Box::pin(async move {
            let mut connection = self.connection().await?;
            connection
                .send_raw(&json!(["REQ", QUERY_SUB_ID, filter]))
                .await
                .map_err(|error| McpError::Relay(format!("cannot send REQ: {error}")))?;

            let deadline = Instant::now() + self.query_timeout;
            let mut events = Vec::new();
            let mut complete = false;
            while Instant::now() < deadline {
                let remaining = deadline.saturating_duration_since(Instant::now());
                let wait = remaining.min(Duration::from_millis(1500));
                match connection.next_event(wait).await {
                    Ok(RelayMessage::Event { event, .. }) => events.push(*event),
                    Ok(RelayMessage::Eose { .. }) => {
                        complete = true;
                        break;
                    }
                    Ok(RelayMessage::Closed { message, .. }) => {
                        // A closed subscription is a failure, never an empty
                        // result: the relay refuses filters it considers
                        // unscoped, and reporting that as "no matches" would
                        // hide a real misconfiguration.
                        let _ = connection.send_raw(&json!(["CLOSE", QUERY_SUB_ID])).await;
                        let _ = connection.disconnect().await;
                        return Err(McpError::Relay(format!(
                            "relay closed the subscription: {message}"
                        )));
                    }
                    Ok(RelayMessage::Notice { message }) => {
                        tracing::warn!(message = %message, "relay notice");
                    }
                    Ok(_) => {}
                    Err(_) => break,
                }
            }
            let _ = connection.send_raw(&json!(["CLOSE", QUERY_SUB_ID])).await;
            let _ = connection.disconnect().await;
            Ok(QueryOutcome { events, complete })
        })
    }
}
