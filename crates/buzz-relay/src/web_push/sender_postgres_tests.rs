//! The sender against a real database and the local stand-in for a push service (`test_support::StandIn`): the claim
//! with a lease, each answer's meaning, the backoff and the terminal state, the refusal of the operator's key, the one
//! sender per deployment, and what the stand-in decrypts. Ignored without infrastructure; run with
//! `cargo test -p buzz-relay --lib -- web_push::sender_postgres_tests --include-ignored --test-threads=1`.

use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use sqlx::Row as _;

use super::alerts::make_alerts;
use super::sender::Sender;
use super::store;
use super::test_support::{push_world, subscribed, task_event, PushWorld, Script};

const HOLDER: usize = 3;

/// One planned alert for the holders already subscribed; the rows are pending and due.
async fn one_alert(pw: &PushWorld) -> u64 {
    make_alerts(&pw.w.state, &pw.config, Utc::now())
        .await
        .expect("starts the cursor");
    let (head, t0) = (pw.w.fx.head(), pw.w.time_of(pw.w.fx.head()));
    let block = task_event(&pw.w, head + 1, t0 + 100, "TaskAnnounced", 1, None).await;
    let report = make_alerts(&pw.w.state, &pw.config, Utc::now())
        .await
        .expect("makes the alert");
    assert!(report.queued >= 1, "{report:?}");
    block
}

fn sender(pw: &PushWorld) -> Sender {
    Sender::new(Arc::clone(&pw.w.state), pw.config.clone())
}

/// Make every row due now.
async fn make_due(pw: &PushWorld) {
    sqlx::query("UPDATE web_push_outbox SET next_attempt_at = now() - interval '1 second' WHERE community_id = $1 AND state = 'pending'")
        .bind(pw.w.tenant.community().as_uuid())
        .execute(pw.w.state.db.pool())
        .await
        .expect("due");
}

struct Outbox {
    state: String,
    attempts: i32,
    status: Option<i32>,
    error: Option<String>,
    wait_secs: f64,
    done: bool,
}

async fn rows(pw: &PushWorld) -> Vec<Outbox> {
    sqlx::query(
        "SELECT state, attempts, last_status, last_error, done_at IS NOT NULL AS done, \
                EXTRACT(EPOCH FROM (next_attempt_at - now()))::float8 AS wait \
         FROM web_push_outbox WHERE community_id = $1 ORDER BY created_at, id",
    )
    .bind(pw.w.tenant.community().as_uuid())
    .fetch_all(pw.w.state.db.pool())
    .await
    .expect("rows")
    .iter()
    .map(|r| Outbox {
        state: r.get("state"),
        attempts: r.get("attempts"),
        status: r.get("last_status"),
        error: r.get("last_error"),
        wait_secs: r.get("wait"),
        done: r.get("done"),
    })
    .collect()
}

async fn subscriptions(pw: &PushWorld) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM web_push_subscriptions WHERE community_id = $1")
        .bind(pw.w.tenant.community().as_uuid())
        .fetch_one(pw.w.state.db.pool())
        .await
        .expect("count")
}

/// P9 and P11: a 201 is delivered; what the stand-in decrypts is a message with exactly the keys `v`, `k` and `r`, under
/// 200 bytes, with no amount, name or date; the headers and the VAPID token are what the RFCs ask for.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn p9_and_p11_a_201_is_delivered_and_the_stand_in_reads_exactly_the_message() {
    let pw = push_world().await;
    let (_holder, device) = subscribed(&pw, HOLDER).await;
    one_alert(&pw).await;
    let sender = sender(&pw);
    assert_eq!(sender.tick().await.expect("tick"), 1);
    let rows = rows(&pw).await;
    assert_eq!(
        (
            rows[0].state.as_str(),
            rows[0].attempts,
            rows[0].status,
            rows[0].done
        ),
        ("delivered", 1, Some(201), true)
    );
    let got = pw.stand_in.received_at(&device);
    assert_eq!(got.len(), 1);
    let message = got[0].payload.as_ref().expect("the stand-in decrypted it");
    let value: serde_json::Value = serde_json::from_str(message).expect("JSON");
    let mut keys: Vec<&str> = value
        .as_object()
        .expect("an object")
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(keys, ["k", "r", "v"], "P11: exactly these keys");
    assert_eq!(
        (value["v"].as_u64(), value["k"].as_str()),
        (Some(1), Some("planned"))
    );
    assert_eq!(
        value["r"].as_str(),
        Some(format!("orbit-{}", &pw.w.founder.public_key().to_hex()[..16]).as_str())
    );
    assert!(message.len() < 200, "{} bytes", message.len());
    // The headers and the token.
    let r = &got[0];
    assert_eq!(r.ttl.as_deref(), Some("86400"));
    assert_eq!(r.urgency.as_deref(), Some("normal"));
    assert_eq!(r.content_encoding.as_deref(), Some("aes128gcm"));
    assert_eq!(r.topic.as_deref().map(str::len), Some(32));
    let claims = r
        .vapid
        .as_ref()
        .expect("the token verifies against the operator's public key");
    assert_eq!(
        claims.aud,
        format!("http://127.0.0.1:{}", pw.stand_in.addr.port())
    );
    assert_eq!(claims.sub, pw.config.subject);
    let now = u64::try_from(Utc::now().timestamp()).expect("now");
    assert!(
        claims.exp > now && claims.exp <= now + 12 * 3600 + 5,
        "exp is at most 12 hours ahead"
    );
    assert!(r.content_length > 86 + 17 && r.content_length < 400);
}

/// P12: two devices get different topics for one alert; one device gets the same topic for the same alert; the topic is
/// not a plain hash of the project and the serial.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn p12_topics_are_per_device_stable_for_one_alert_and_keyed() {
    let pw = push_world().await;
    let (_a, device_a) = subscribed(&pw, HOLDER).await;
    let (_b, device_b) = subscribed(&pw, HOLDER).await;
    one_alert(&pw).await;
    // The first answer fails, so device A is sent the same alert twice.
    pw.stand_in.script([Script::Status(500)]);
    let sender = sender(&pw);
    sender.tick().await.expect("tick");
    make_due(&pw).await;
    sender.tick().await.expect("tick again");
    let topic_of = |device: &super::test_support::Device| -> Vec<String> {
        pw.stand_in
            .received_at(device)
            .into_iter()
            .map(|r| r.topic.expect("a topic"))
            .collect()
    };
    let (a, b) = (topic_of(&device_a), topic_of(&device_b));
    let all: Vec<String> = a.iter().chain(b.iter()).cloned().collect();
    assert!(all.len() >= 3, "three sends: {all:?}");
    let first = pw.stand_in.received();
    let failed_one = &first[0];
    assert!(failed_one.path.starts_with("/push/"));
    let repeated: Vec<&Vec<String>> = [&a, &b].into_iter().filter(|t| t.len() == 2).collect();
    assert_eq!(repeated.len(), 1, "one device was sent twice");
    assert_eq!(
        repeated[0][0], repeated[0][1],
        "the same device and alert keep one topic"
    );
    let (one, other) = (&a[0], &b[0]);
    assert_ne!(one, other, "two devices never share a topic");
    // Not a plain hash of the public values.
    use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
    use base64::Engine;
    use sha2::Digest;
    let mut plain = sha2::Sha256::new();
    plain.update(pw.w.key);
    plain.update(1u64.to_be_bytes());
    assert!(![one, other].contains(&&B64.encode(&plain.finalize()[..24])));
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn p9_a_404_and_a_410_delete_the_device() {
    for gone in [404u16, 410] {
        let pw = push_world().await;
        let (_holder, _device) = subscribed(&pw, HOLDER).await;
        one_alert(&pw).await;
        pw.stand_in.script([Script::Status(gone)]);
        assert_eq!(subscriptions(&pw).await, 1);
        sender(&pw).tick().await.expect("tick");
        assert_eq!(subscriptions(&pw).await, 0, "{gone}: the device is deleted");
        assert!(
            rows(&pw).await.is_empty(),
            "{gone}: and its rows go with it"
        );
        assert_eq!(
            pw.stand_in.received().len(),
            1,
            "no second try at a device that is gone"
        );
    }
}

/// P9: 429 with a Retry-After is honoured; a 500 backs off 60 x 2^(n-1) seconds; the eighth attempt ends as `failed`, which
/// is final.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn p9_retry_after_is_honoured_the_pause_doubles_and_the_eighth_attempt_ends_failed() {
    let pw = push_world().await;
    let (_holder, _device) = subscribed(&pw, HOLDER).await;
    one_alert(&pw).await;
    let sender = sender(&pw);
    pw.stand_in.script([Script::RetryAfter(429, 7_200)]);
    pw.stand_in.default_answer(Script::Status(500));
    sender.tick().await.expect("tick");
    let first = &rows(&pw).await[0];
    assert_eq!(
        (first.state.as_str(), first.attempts, first.status),
        ("pending", 1, Some(429))
    );
    assert!(
        first.wait_secs > 7_190.0 && first.wait_secs <= 7_205.0,
        "the service's wait is honoured, not the 60 s: {}",
        first.wait_secs
    );
    for attempt in 2..=7 {
        make_due(&pw).await;
        sender.tick().await.expect("tick");
        let row = &rows(&pw).await[0];
        assert_eq!((row.state.as_str(), row.attempts), ("pending", attempt));
        let expected = store::backoff_secs(attempt) as f64;
        assert!(
            (row.wait_secs - expected).abs() < 6.0,
            "attempt {attempt}: waits {} s, expected {expected}",
            row.wait_secs
        );
    }
    make_due(&pw).await;
    sender.tick().await.expect("the eighth");
    let last = &rows(&pw).await[0];
    assert_eq!(
        (last.state.as_str(), last.attempts, last.status, last.done),
        ("failed", 8, Some(500), true)
    );
    // Final: nothing is sent again, even if the row were due.
    let sent = pw.stand_in.received().len();
    sender.tick().await.expect("tick");
    assert_eq!(pw.stand_in.received().len(), sent);
    assert_eq!(rows(&pw).await[0].state, "failed");
}

/// A slow service is a retry with no status, and a redirect is never followed.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_timeout_is_a_retry_and_a_redirect_is_a_terminal_refusal_that_is_never_followed() {
    let pw = push_world().await;
    let (_holder, _device) = subscribed(&pw, HOLDER).await;
    one_alert(&pw).await;
    pw.stand_in
        .script([Script::Slow(Duration::from_secs(3), 201)]);
    let sender = sender(&pw).with_send_timeout(Duration::from_millis(300));
    sender.tick().await.expect("tick");
    let row = &rows(&pw).await[0];
    assert_eq!(
        (row.state.as_str(), row.attempts, row.status),
        ("pending", 1, None)
    );
    assert!(
        row.error.as_deref().is_some_and(|e| e.contains("in time")),
        "{:?}",
        row.error
    );
    assert!((row.wait_secs - 60.0).abs() < 6.0);
    // A redirect.
    pw.stand_in.script([Script::Redirect(format!(
        "http://127.0.0.1:{}/elsewhere",
        pw.stand_in.addr.port()
    ))]);
    make_due(&pw).await;
    sender.tick().await.expect("tick");
    let row = &rows(&pw).await[0];
    assert_eq!((row.state.as_str(), row.status), ("failed", Some(302)));
    let paths: Vec<String> = pw.stand_in.received().into_iter().map(|r| r.path).collect();
    assert!(
        !paths.iter().any(|p| p == "/elsewhere"),
        "the redirect was not followed: {paths:?}"
    );
}

/// P4 at send time: the operator's list may have changed since the address was stored; a host that is no longer allowed
/// is never called.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn an_address_that_is_no_longer_allowed_is_not_called() {
    let pw = push_world().await;
    let (_holder, _device) = subscribed(&pw, HOLDER).await;
    one_alert(&pw).await;
    let mut narrowed = pw.config.clone();
    narrowed.extra_hosts.clear();
    Sender::new(Arc::clone(&pw.w.state), narrowed)
        .tick()
        .await
        .expect("tick");
    let row = &rows(&pw).await[0];
    assert_eq!(row.state, "failed");
    assert!(
        row.error
            .as_deref()
            .is_some_and(|e| e.contains("not allowed")),
        "{:?}",
        row.error
    );
    assert!(pw.stand_in.received().is_empty(), "nothing was sent");
}

/// P13: three devices in a row refused with 403 pause the whole sender once; while it is paused nothing is sent; it
/// goes on afterwards.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn p13_repeated_refusals_of_the_operators_key_pause_the_sender_once() {
    let pw = push_world().await;
    for _ in 0..5 {
        subscribed(&pw, HOLDER).await;
    }
    one_alert(&pw).await;
    pw.stand_in.default_answer(Script::Status(403));
    let sender = sender(&pw).with_auth_pause(Duration::from_millis(400));
    assert_eq!(sender.tick().await.expect("tick"), 5);
    assert_eq!(sender.pauses(), 1, "one pause, not one per device");
    assert!(sender.is_paused().await);
    let sent = pw.stand_in.received().len();
    assert_eq!(sent, 5);
    // Retried later, not ended: every row is pending with its attempt counted.
    assert!(rows(&pw)
        .await
        .iter()
        .all(|r| r.state == "pending" && r.attempts == 1 && r.status == Some(403)));
    make_due(&pw).await;
    assert_eq!(sender.tick().await.expect("tick while paused"), 0);
    assert_eq!(
        pw.stand_in.received().len(),
        sent,
        "nothing is sent while paused"
    );
    tokio::time::sleep(Duration::from_millis(450)).await;
    assert!(!sender.is_paused().await);
    pw.stand_in.default_answer(Script::Status(201));
    assert_eq!(sender.tick().await.expect("tick after the pause"), 5);
    assert!(rows(&pw).await.iter().all(|r| r.state == "delivered"));
}

/// The lease: a claimed row is not claimed again until its lease runs out; a sender that stopped leaves rows that are
/// claimed again; a row given back unsent gets its attempt back.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn a_claim_holds_a_lease_a_crashed_lease_is_reclaimed_and_a_release_gives_the_attempt_back() {
    let pw = push_world().await;
    let (_holder, _device) = subscribed(&pw, HOLDER).await;
    one_alert(&pw).await;
    let pool = pw.w.state.db.pool();
    let first = store::claim_due(pool, 10, Utc::now()).await.expect("claim");
    assert_eq!((first.len(), first[0].attempts), (1, 1));
    assert!(
        store::claim_due(pool, 10, Utc::now())
            .await
            .expect("claim")
            .is_empty(),
        "held by its lease"
    );
    // The sender crashed: the lease ran out.
    sqlx::query("UPDATE web_push_outbox SET lease_until = now() - interval '1 second' WHERE state = 'sending'")
        .execute(pool)
        .await
        .expect("expire the lease");
    let again = store::claim_due(pool, 10, Utc::now()).await.expect("claim");
    assert_eq!(
        (again.len(), again[0].attempts),
        (1, 2),
        "claimed again, the attempt counted"
    );
    store::release(pool, &again[0]).await.expect("release");
    let row = &rows(&pw).await[0];
    assert_eq!(
        (row.state.as_str(), row.attempts),
        ("pending", 1),
        "given back unsent"
    );
    // Two claimers at once never take the same row.
    for _ in 0..4 {
        subscribed(&pw, HOLDER).await;
    }
    make_alerts(&pw.w.state, &pw.config, Utc::now())
        .await
        .expect("pass");
    let (a, b) = tokio::join!(
        store::claim_due(pool, 3, Utc::now()),
        store::claim_due(pool, 3, Utc::now())
    );
    let (a, b) = (a.expect("claim"), b.expect("claim"));
    let mut ids: Vec<_> = a.iter().chain(b.iter()).map(|d| d.id).collect();
    let n = ids.len();
    ids.sort();
    ids.dedup();
    assert_eq!(ids.len(), n, "no row is claimed twice");
}

/// P15 and P16: the sender is not started when push is off; with two replicas only the lock holder sends.
#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn p15_and_p16_the_sender_is_not_started_when_off_and_only_one_replica_sends() {
    let off = crate::test_support::test_state().await;
    assert!(off.config.web_push.is_none());
    assert!(super::sender::spawn(off).is_none(), "off: no task");
    let pw = push_world().await;
    let (first, second) = (sender(&pw), sender(&pw));
    assert!(first.is_sender().await.expect("lock"));
    assert!(
        !second.is_sender().await.expect("lock"),
        "a second replica idles"
    );
    assert!(
        first.is_sender().await.expect("lock"),
        "the holder keeps it"
    );
    drop(first);
    let mut taken = false;
    for _ in 0..50 {
        if second.is_sender().await.expect("lock") {
            taken = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(taken, "the lock is free when its holder is gone");
}
