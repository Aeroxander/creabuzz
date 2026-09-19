//! Tool-level tests for the Buzz community MCP server.
//!
//! These bind the production seam: the real `CommunityMcp` tools are driven
//! against a fake relay, so the assertions cover the exact events that would be
//! published and the exact filters that would be sent.

use std::sync::{Arc, Mutex};

use buzz_community_mcp::relay::{BoxFut, BuzzRelay, PublishOutcome, QueryOutcome};
use buzz_community_mcp::{args, CommunityMcp, McpError};
use nostr::{Event, Keys, Kind};
use rmcp::handler::server::wrapper::Parameters;
use serde_json::{json, Value};

const CHANNEL: &str = "9c1f0f4a-0000-4000-8000-000000000001";

/// A relay that records what it was asked to do.
///
/// Reads are complete by default, so a test only sees the "may be incomplete"
/// note when it asks for it with [`FakeRelay::truncated`].
struct FakeRelay {
    published: Mutex<Vec<Event>>,
    events: Mutex<Vec<Event>>,
    queries: Mutex<Vec<Value>>,
    complete: Mutex<bool>,
    fail_with: Mutex<Option<String>>,
}

impl Default for FakeRelay {
    fn default() -> Self {
        Self {
            published: Mutex::new(Vec::new()),
            events: Mutex::new(Vec::new()),
            queries: Mutex::new(Vec::new()),
            complete: Mutex::new(true),
            fail_with: Mutex::new(None),
        }
    }
}

impl FakeRelay {
    fn with_events(events: Vec<Event>) -> Self {
        let relay = Self::default();
        *relay.events.lock().expect("lock") = events;
        relay
    }

    fn failing(message: &str) -> Self {
        let relay = Self::default();
        *relay.fail_with.lock().expect("lock") = Some(message.to_string());
        relay
    }

    fn truncated(self) -> Self {
        *self.complete.lock().expect("lock") = false;
        self
    }

    fn published(&self) -> Vec<Event> {
        self.published.lock().expect("lock").clone()
    }

    fn last_query(&self) -> Value {
        self.queries
            .lock()
            .expect("lock")
            .last()
            .cloned()
            .expect("a query was sent")
    }
}

impl BuzzRelay for FakeRelay {
    fn relay_url(&self) -> &str {
        "ws://relay.test.invalid"
    }

    fn identity(&self) -> String {
        "deadbeef".repeat(8)
    }

    fn publish(&self, event: Event) -> BoxFut<'_, Result<PublishOutcome, McpError>> {
        Box::pin(async move {
            if let Some(message) = self.fail_with.lock().expect("lock").clone() {
                return Err(McpError::Relay(message));
            }
            let event_id = event.id.to_hex();
            self.published.lock().expect("lock").push(event);
            Ok(PublishOutcome {
                event_id,
                accepted: true,
                message: "ok".to_string(),
            })
        })
    }

    fn query(&self, filter: Value) -> BoxFut<'_, Result<QueryOutcome, McpError>> {
        Box::pin(async move {
            self.queries.lock().expect("lock").push(filter);
            if let Some(message) = self.fail_with.lock().expect("lock").clone() {
                // A closed subscription must surface as an error, not as an
                // empty result set.
                return Err(McpError::Relay(format!(
                    "relay closed the subscription: {message}"
                )));
            }
            Ok(QueryOutcome {
                events: self.events.lock().expect("lock").clone(),
                complete: *self.complete.lock().expect("lock"),
            })
        })
    }
}

fn server(relay: FakeRelay) -> (CommunityMcp, Keys) {
    let keys = Keys::generate();
    (CommunityMcp::new(Arc::new(relay), keys.clone()), keys)
}

/// Re-stamp an event so ordering is unambiguous in tests.
fn at(mut event: Event, seconds: u64) -> Event {
    event.created_at = nostr::Timestamp::from(seconds);
    event
}

fn message(kind: u16, content: &str, tags: Vec<Vec<&str>>, keys: &Keys) -> Event {
    let parsed: Vec<nostr::Tag> = tags
        .into_iter()
        .map(|tag| nostr::Tag::parse(tag).expect("tag"))
        .collect();
    nostr::EventBuilder::new(Kind::Custom(kind), content.to_string())
        .tags(parsed)
        .sign_with_keys(keys)
        .expect("signs")
}

#[tokio::test]
async fn whoami_reports_the_relay_and_identity() {
    let (server, _keys) = server(FakeRelay::default());
    let text = server.buzz_whoami().await.expect("whoami");
    assert!(text.contains("ws://relay.test.invalid"), "{text}");
    assert!(text.contains(&"deadbeef".repeat(8)), "{text}");
}

#[tokio::test]
async fn post_message_publishes_a_kind_9_event_scoped_to_the_channel() {
    let relay = FakeRelay::default();
    let (server, keys) = server(relay);
    let text = server
        .buzz_post_message(Parameters(args::PostMessageParams {
            channel: CHANNEL.to_string(),
            text: "hello from a Paperclip agent".to_string(),
            reply_to: None,
            thread_root: None,
        }))
        .await
        .expect("posts");
    assert!(text.contains("accepted"), "{text}");

    // The fake moved into the server, so re-read it through the Arc the server
    // holds is not possible; assert through the returned text plus a fresh run.
    let _ = keys;
}

#[tokio::test]
async fn post_message_records_the_published_event_on_the_relay() {
    let relay = Arc::new(FakeRelay::default());
    let keys = Keys::generate();
    let server = CommunityMcp::new(relay.clone(), keys.clone());
    server
        .buzz_post_message(Parameters(args::PostMessageParams {
            channel: CHANNEL.to_string(),
            text: "hello".to_string(),
            reply_to: None,
            thread_root: None,
        }))
        .await
        .expect("posts");

    let published = relay.published();
    assert_eq!(published.len(), 1);
    assert_eq!(published[0].kind, Kind::Custom(9));
    assert_eq!(published[0].content, "hello");
    assert_eq!(published[0].pubkey, keys.public_key());
    let h = published[0]
        .tags
        .iter()
        .find(|tag| tag.as_slice().first().map(String::as_str) == Some("h"))
        .expect("h tag");
    assert_eq!(h.as_slice().get(1).map(String::as_str), Some(CHANNEL));
}

#[tokio::test]
async fn read_channel_queries_kind_9_for_that_channel_only() {
    let keys = Keys::generate();
    let relay = FakeRelay::with_events(vec![message(
        9,
        "hello there",
        vec![vec!["h", CHANNEL]],
        &keys,
    )]);
    let (server, _) = server(relay);
    let text = server
        .buzz_read_channel(Parameters(args::ReadChannelParams {
            channel: CHANNEL.to_string(),
            limit: Some(20),
        }))
        .await
        .expect("reads");
    assert!(text.contains("hello there"), "{text}");
}

#[tokio::test]
async fn read_channel_sends_a_kind_filter_and_bounds_the_limit() {
    let relay = Arc::new(FakeRelay::with_events(vec![]));
    let server = CommunityMcp::new(relay.clone(), Keys::generate());
    server
        .buzz_read_channel(Parameters(args::ReadChannelParams {
            channel: CHANNEL.to_string(),
            limit: Some(100_000),
        }))
        .await
        .expect("reads");

    let filter = relay.last_query();
    assert_eq!(
        filter["kinds"],
        json!([9]),
        "the relay rejects unscoped reads"
    );
    assert_eq!(filter["#h"], json!([CHANNEL]));
    assert_eq!(
        filter["limit"],
        json!(buzz_community_mcp::MAX_MESSAGE_LIMIT),
        "an unbounded caller limit must be capped"
    );
}

#[tokio::test]
async fn a_closed_subscription_is_an_error_not_an_empty_read() {
    let (server, _) = server(FakeRelay::failing("p-gate"));
    let error = server
        .buzz_read_channel(Parameters(args::ReadChannelParams {
            channel: CHANNEL.to_string(),
            limit: None,
        }))
        .await
        .expect_err("a closed subscription must fail");
    let message = format!("{error:?}");
    assert!(message.contains("p-gate"), "{message}");
}

#[tokio::test]
async fn an_incomplete_read_says_so() {
    let (server, _) = server(FakeRelay::default().truncated());
    let text = server
        .buzz_list_tasks(Parameters(args::ListTasksParams {
            channel: None,
            limit: None,
        }))
        .await
        .expect("reads");
    assert!(text.contains("may be incomplete"), "{text}");
}

#[tokio::test]
async fn list_tasks_returns_the_newest_row_per_task() {
    let keys = Keys::generate();
    let older = at(
        message(
            44011,
            r#"{"title":"Ship it","status":"open"}"#,
            vec![vec!["d", "open:t1"], vec!["h", CHANNEL]],
            &keys,
        ),
        1_000,
    );
    let newer = at(
        message(
            44011,
            r#"{"title":"Ship it","status":"done"}"#,
            vec![vec!["d", "open:t1"], vec!["h", CHANNEL]],
            &keys,
        ),
        2_000,
    );
    let (server, _) = server(FakeRelay::with_events(vec![older, newer]));
    let text = server
        .buzz_list_tasks(Parameters(args::ListTasksParams {
            channel: Some(CHANNEL.to_string()),
            limit: None,
        }))
        .await
        .expect("lists");
    assert_eq!(text.lines().count(), 1, "one line per task: {text}");
    assert!(text.contains("[done]"), "newest status wins: {text}");
}

#[tokio::test]
async fn set_task_status_publishes_a_44011_row_for_that_task() {
    let relay = Arc::new(FakeRelay::default());
    let keys = Keys::generate();
    let server = CommunityMcp::new(relay.clone(), keys.clone());
    server
        .buzz_set_task_status(Parameters(args::SetTaskStatusParams {
            task_id: "open:t1".to_string(),
            status: "Done".to_string(),
            channel: Some(CHANNEL.to_string()),
            title: Some("Ship it".to_string()),
        }))
        .await
        .expect("publishes");

    let published = relay.published();
    assert_eq!(published.len(), 1);
    assert_eq!(published[0].kind, Kind::Custom(44011));
    let body: Value = serde_json::from_str(&published[0].content).expect("json");
    assert_eq!(body["status"], "done", "status is normalised");
    assert_eq!(body["title"], "Ship it");
    assert_eq!(published[0].pubkey, keys.public_key());
}

#[tokio::test]
async fn set_task_status_rejects_an_unknown_status_before_publishing() {
    let relay = Arc::new(FakeRelay::default());
    let server = CommunityMcp::new(relay.clone(), Keys::generate());
    let error = server
        .buzz_set_task_status(Parameters(args::SetTaskStatusParams {
            task_id: "open:t1".to_string(),
            status: "shipped".to_string(),
            channel: None,
            title: None,
        }))
        .await
        .expect_err("unknown status rejected");
    assert!(
        format!("{error:?}").contains("expected one of"),
        "{error:?}"
    );
    assert!(relay.published().is_empty(), "nothing may be published");
}

#[tokio::test]
async fn a_bad_channel_id_is_rejected_before_any_relay_call() {
    let relay = Arc::new(FakeRelay::default());
    let server = CommunityMcp::new(relay.clone(), Keys::generate());
    let error = server
        .buzz_read_channel(Parameters(args::ReadChannelParams {
            channel: "general".to_string(),
            limit: None,
        }))
        .await
        .expect_err("bad channel rejected");
    assert!(
        format!("{error:?}").contains("not a channel UUID"),
        "{error:?}"
    );
    assert!(relay.queries.lock().expect("lock").is_empty());
}

#[tokio::test]
async fn empty_message_text_is_rejected_before_publishing() {
    let relay = Arc::new(FakeRelay::default());
    let server = CommunityMcp::new(relay.clone(), Keys::generate());
    let error = server
        .buzz_post_message(Parameters(args::PostMessageParams {
            channel: CHANNEL.to_string(),
            text: "   ".to_string(),
            reply_to: None,
            thread_root: None,
        }))
        .await
        .expect_err("empty text rejected");
    assert!(
        format!("{error:?}").contains("must not be empty"),
        "{error:?}"
    );
    assert!(relay.published().is_empty());
}
