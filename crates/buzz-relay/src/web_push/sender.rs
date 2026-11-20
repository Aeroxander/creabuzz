//! The sender: a supervised task that makes alerts, sends them, and sweeps what is old.
//!
//! **Never in front of money.** It is its own task, started from `main.rs` and not inside the chain reader's pass, so a
//! push outage can never stall the reader or Take out. One sender runs at a time per deployment: it holds a session
//! advisory lock of its own on a connection detached from the pool (the same way the reader's writer lock is held), and a
//! second replica idles.
//!
//! **A claim, a result, a terminal state.** Due rows are claimed with `FOR UPDATE SKIP LOCKED` and a 30-second lease; a
//! sender that stopped leaves rows that expire and are claimed again. `201` is `delivered`; `404` and `410` are `gone` and
//! the device is deleted; `429`, any `5xx`, a network error and a timeout retry with a pause of `60 s x 2^(attempts-1)` up
//! to six hours (a `Retry-After` is honoured up to that cap) and, after eight attempts, end as `failed`; `413` and other
//! `4xx` end as `failed` at once. `401` and `403` mean the operator's key or contact is wrong: the row is retried, a warning
//! names the host, and after three such answers in a row from different devices the whole sender pauses 15 minutes (one
//! error line, once) so a wrong key does not spend every device's day.

use std::collections::BTreeSet;
use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use futures_util::stream::{FuturesUnordered, StreamExt};
use uuid::Uuid;

use super::hosts::{self, check_endpoint};
use super::settings::WebPushConfig;
use super::store::{self, Due, Outcome};
use super::{ece, message};
use crate::state::AppState;

/// How often the loop looks for work.
pub const TICK: Duration = Duration::from_secs(5);
/// The time one send is given, connect to last byte.
pub const SEND_TIMEOUT: Duration = Duration::from_secs(10);
/// Rows claimed at once.
pub const CLAIM_BATCH: i64 = 32;
/// Sends in flight at once.
pub const CONCURRENCY: usize = 8;
/// How long the whole sender stops after repeated `401` or `403` answers from different devices.
pub const AUTH_PAUSE: Duration = Duration::from_secs(15 * 60);
/// How many devices must be refused in a row to stop the sender.
pub const AUTH_STREAK: usize = 3;
/// How often old rows are swept.
pub const SWEEP_EVERY: Duration = Duration::from_secs(3_600);
/// How long a `Retry-After` is read as (anything longer is capped by the backoff cap).
const RETRY_AFTER_MAX: u64 = store::BACKOFF_CAP_SECS;

/// What a push service answered, reduced to what the sender acts on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Answer {
    /// The HTTP status.
    pub status: u16,
    /// The `Retry-After` in seconds, when it was a number of seconds.
    pub retry_after: Option<u64>,
}

/// What an answer means for the row. Pure.
pub fn outcome_of(answer: Answer) -> Outcome {
    let status = i32::from(answer.status);
    match answer.status {
        // 201 is what the push services answer; any success means the service took it.
        200..=299 => Outcome::Delivered(status),
        404 | 410 => Outcome::Gone(status),
        429 | 500..=599 => Outcome::Retry {
            status: Some(status),
            error: format!("the push service answered {}", answer.status),
            retry_after: answer.retry_after.map(|s| s.min(RETRY_AFTER_MAX)),
        },
        // The operator's key or contact was refused: retried, and counted toward a pause of the whole sender.
        401 | 403 => Outcome::Retry {
            status: Some(status),
            error: format!(
                "the push service refused the operator's key ({})",
                answer.status
            ),
            retry_after: None,
        },
        _ => Outcome::Failed {
            status: Some(status),
            error: format!("the push service answered {}", answer.status),
        },
    }
}

/// Whether an answer is a refusal of the operator's own key or contact.
pub fn refuses_the_operator(answer: Answer) -> bool {
    matches!(answer.status, 401 | 403)
}

/// What a sender remembers between sends: the devices refused in a row, and how long it is paused.
#[derive(Debug, Default)]
pub struct AuthWatch {
    refused: BTreeSet<Uuid>,
}

impl AuthWatch {
    /// Note an answer for a device. Returns `true` when the third different device in a row has just been refused: the
    /// caller pauses the sender (and the streak starts over). Any other answer ends a streak.
    pub fn note(&mut self, device: Uuid, answer: Option<Answer>) -> bool {
        match answer {
            Some(a) if refuses_the_operator(a) => {
                self.refused.insert(device);
                if self.refused.len() >= AUTH_STREAK {
                    self.refused.clear();
                    return true;
                }
                false
            }
            _ => {
                self.refused.clear();
                false
            }
        }
    }
}

/// The Retry-After seconds of an HTTP-date-less header, if it is a plain number of seconds.
pub fn retry_after_secs(value: Option<&str>) -> Option<u64> {
    value?.trim().parse::<u64>().ok()
}

/// Send one claimed row. Returns what to write and what the service answered (`None` for a failure with no answer).
pub async fn send_one(
    config: &WebPushConfig,
    due: &Due,
    timeout: Duration,
) -> (Outcome, Option<Answer>) {
    let retry = |error: &str| Outcome::Retry {
        status: None,
        error: error.to_owned(),
        retry_after: None,
    };
    // The address was checked when it was stored and is checked again now: the operator's list may have changed.
    let endpoint = match check_endpoint(&due.subscription.endpoint, &config.extra_hosts) {
        Ok(endpoint) => endpoint,
        Err(why) => {
            return (
                Outcome::Failed {
                    status: None,
                    error: format!("the device's address is not allowed: {why:?}"),
                },
                None,
            )
        }
    };
    // The name is resolved now and the connection goes to the address that passed.
    let address = match hosts::resolve(&endpoint).await {
        Ok(Some(address)) => address,
        Ok(None) => {
            return (
                Outcome::Failed {
                    status: None,
                    error: "the device's address resolves to a network that is not allowed"
                        .to_owned(),
                },
                None,
            )
        }
        Err(_) => return (retry("the device's address did not resolve"), None),
    };
    let plain = message(due.kind, &due.link_ref);
    let body = match ece::encrypt(
        plain.as_bytes(),
        &due.subscription.p256dh,
        &due.subscription.auth,
    ) {
        Ok(body) => body,
        Err(why) => {
            return (
                Outcome::Failed {
                    status: None,
                    error: format!("the message could not be encrypted: {why}"),
                },
                None,
            )
        }
    };
    let now = u64::try_from(Utc::now().timestamp()).unwrap_or(0);
    let authorization = config
        .vapid
        .authorization(&endpoint.origin(), now, &config.subject);
    let topic = config.vapid.topic(
        &due.subscription.endpoint_hash,
        &due.project_key,
        due.serial,
    );
    let client = match reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(timeout)
        .no_proxy()
        .resolve(&endpoint.host, address)
        .build()
    {
        Ok(client) => client,
        Err(_) => return (retry("the HTTP client could not be built"), None),
    };
    let sent = client
        .post(endpoint.url.as_str())
        .header("Authorization", authorization)
        .header("Content-Encoding", "aes128gcm")
        .header("Content-Type", "application/octet-stream")
        .header("TTL", "86400")
        .header("Urgency", "normal")
        .header("Topic", topic)
        .body(body)
        .send()
        .await;
    match sent {
        Ok(response) => {
            let answer = Answer {
                status: response.status().as_u16(),
                retry_after: retry_after_secs(
                    response
                        .headers()
                        .get("retry-after")
                        .and_then(|v| v.to_str().ok()),
                ),
            };
            (outcome_of(answer), Some(answer))
        }
        Err(e) if e.is_timeout() => (retry("the push service did not answer in time"), None),
        Err(_) => (retry("the push service could not be reached"), None),
    }
}

/// The state of a running sender.
pub struct Sender {
    state: Arc<AppState>,
    config: WebPushConfig,
    watch: tokio::sync::Mutex<AuthWatch>,
    paused_until: tokio::sync::Mutex<Option<tokio::time::Instant>>,
    auth_pause: Duration,
    send_timeout: Duration,
    pauses: std::sync::atomic::AtomicU32,
    leader: tokio::sync::Mutex<Option<sqlx::PgConnection>>,
}

impl Sender {
    /// A sender for this server's push settings.
    pub fn new(state: Arc<AppState>, config: WebPushConfig) -> Self {
        Self {
            state,
            config,
            watch: tokio::sync::Mutex::new(AuthWatch::default()),
            paused_until: tokio::sync::Mutex::new(None),
            auth_pause: AUTH_PAUSE,
            send_timeout: SEND_TIMEOUT,
            pauses: std::sync::atomic::AtomicU32::new(0),
            leader: tokio::sync::Mutex::new(None),
        }
    }

    /// The same, with a shorter pause after repeated refusals (for tests).
    #[cfg(test)]
    pub fn with_auth_pause(mut self, pause: Duration) -> Self {
        self.auth_pause = pause;
        self
    }

    /// The same, with a shorter time for one send (for tests).
    #[cfg(test)]
    pub fn with_send_timeout(mut self, timeout: Duration) -> Self {
        self.send_timeout = timeout;
        self
    }

    /// How many times the whole sender has paused for repeated refusals of the operator's key.
    pub fn pauses(&self) -> u32 {
        self.pauses.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Whether this replica holds the sender's lock: a session advisory lock on a connection detached from the pool
    /// (dropping it closes the session and frees the lock). Checked on every tick; a connection that stopped answering
    /// took the lock with it, so it is taken again.
    pub async fn is_sender(&self) -> anyhow::Result<bool> {
        let mut held = self.leader.lock().await;
        if let Some(conn) = held.as_mut() {
            if sqlx::query("SELECT 1").execute(&mut *conn).await.is_ok() {
                return Ok(true);
            }
            *held = None;
            tracing::warn!("web push: the sender's lock connection was lost");
        }
        let mut conn = self.state.db.pool().acquire().await?.detach();
        let got: bool = sqlx::query_scalar("SELECT pg_try_advisory_lock(hashtextextended($1, 0))")
            .bind("web_push_sender")
            .fetch_one(&mut conn)
            .await?;
        if got {
            *held = Some(conn);
        }
        Ok(got)
    }

    /// Whether the whole sender is paused after repeated refusals of the operator's key.
    pub async fn is_paused(&self) -> bool {
        let mut paused = self.paused_until.lock().await;
        match *paused {
            Some(until) if tokio::time::Instant::now() < until => true,
            Some(_) => {
                *paused = None;
                false
            }
            None => false,
        }
    }

    /// One tick: make alerts, then send what is due. Returns how many rows were sent.
    pub async fn tick(&self) -> anyhow::Result<usize> {
        let now = Utc::now();
        match super::alerts::make_alerts(&self.state, &self.config, now).await {
            Ok(report) => {
                if report.made > 0 || report.queued > 0 || report.dropped > 0 {
                    tracing::info!(
                        made = report.made,
                        queued = report.queued,
                        dropped = report.dropped,
                        "web push: alerts made"
                    );
                }
                metrics::counter!("buzz_web_push_alerts_total").increment(report.made as u64);
            }
            Err(e) => {
                // The cursor did not move: the next tick makes the same alerts again.
                tracing::warn!(error = %format!("{e:#}"), "web push: making alerts failed; trying again");
                metrics::counter!("buzz_web_push_alert_errors_total").increment(1);
            }
        }
        if self.is_paused().await {
            return Ok(0);
        }
        let pool = self.state.db.pool();
        let due = store::claim_due(pool, CLAIM_BATCH, Utc::now()).await?;
        let sent = due.len();
        let mut running = FuturesUnordered::new();
        let mut queue = due.into_iter();
        let mut stopped: Vec<Due> = Vec::new();
        loop {
            while running.len() < CONCURRENCY {
                let Some(row) = queue.next() else { break };
                if self.is_paused().await {
                    stopped.push(row);
                    continue;
                }
                let config = &self.config;
                let timeout = self.send_timeout;
                running.push(async move {
                    let (outcome, answer) = send_one(config, &row, timeout).await;
                    (row, outcome, answer)
                });
            }
            let Some((row, outcome, answer)) = running.next().await else {
                break;
            };
            store::record(pool, &row, &outcome, Utc::now()).await?;
            match &outcome {
                Outcome::Delivered(_) => {
                    metrics::counter!("buzz_web_push_sent_total", "result" => "delivered")
                        .increment(1)
                }
                Outcome::Gone(_) => {
                    metrics::counter!("buzz_web_push_sent_total", "result" => "gone").increment(1)
                }
                Outcome::Retry { .. } => {
                    metrics::counter!("buzz_web_push_sent_total", "result" => "retry").increment(1)
                }
                Outcome::Failed { .. } => {
                    metrics::counter!("buzz_web_push_sent_total", "result" => "failed").increment(1)
                }
            }
            if let Some(a) = answer.filter(|a| refuses_the_operator(*a)) {
                tracing::warn!(
                    status = a.status,
                    host = %row.subscription.endpoint.split('/').nth(2).unwrap_or("?"),
                    "web push: a push service refused the operator's key or contact"
                );
            }
            let pause = self.watch.lock().await.note(row.subscription.id, answer);
            if pause {
                *self.paused_until.lock().await =
                    Some(tokio::time::Instant::now() + self.auth_pause);
                self.pauses
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                tracing::error!(
                    "web push: three devices in a row were refused; check {} and {}; sending is paused for {} minutes",
                    super::settings::KEY_VAR,
                    super::settings::SUBJECT_VAR,
                    self.auth_pause.as_secs() / 60
                );
            }
        }
        // Rows that were claimed but not sent because the sender paused go back unsent.
        for row in &stopped {
            store::release(pool, row).await?;
        }
        Ok(sent)
    }
}

/// The sender's loop: wait for the lock, then tick until the process ends. It returns only on an error the supervisor
/// should restart it after.
pub async fn run(sender: Arc<Sender>) {
    let mut last_sweep = tokio::time::Instant::now() - SWEEP_EVERY;
    loop {
        match sender.is_sender().await {
            Ok(true) => {
                if let Err(e) = sender.tick().await {
                    tracing::warn!(error = %format!("{e:#}"), "web push: a tick failed");
                }
                if last_sweep.elapsed() >= SWEEP_EVERY {
                    match store::sweep(sender.state.db.pool(), Utc::now()).await {
                        Ok(swept) => {
                            last_sweep = tokio::time::Instant::now();
                            if swept != store::Swept::default() {
                                tracing::info!(?swept, "web push: swept old rows");
                            }
                        }
                        Err(e) => tracing::warn!(error = %e, "web push: the sweep failed"),
                    }
                }
            }
            Ok(false) => {}
            Err(e) => tracing::warn!(error = %e, "web push: the lock could not be asked for"),
        }
        tokio::time::sleep(TICK).await;
    }
}

/// Start the sender when push is on; `None` when it is off. The task is supervised: it starts again after a panic.
pub fn spawn(state: Arc<AppState>) -> Option<tokio::task::JoinHandle<()>> {
    let config = state.config.web_push.clone()?;
    let sender = Arc::new(Sender::new(state, config));
    Some(tokio::spawn(crate::chain_reader::supervise(
        move || run(Arc::clone(&sender)),
        TICK,
        Duration::from_secs(60),
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn answer(status: u16, retry_after: Option<u64>) -> Answer {
        Answer {
            status,
            retry_after,
        }
    }

    #[test]
    fn each_answer_means_one_thing_for_the_row() {
        assert_eq!(outcome_of(answer(201, None)), Outcome::Delivered(201));
        assert_eq!(outcome_of(answer(202, None)), Outcome::Delivered(202));
        assert_eq!(outcome_of(answer(404, None)), Outcome::Gone(404));
        assert_eq!(outcome_of(answer(410, None)), Outcome::Gone(410));
        for retried in [429, 500, 502, 503, 504, 599] {
            assert!(
                matches!(outcome_of(answer(retried, None)), Outcome::Retry { .. }),
                "{retried}"
            );
        }
        for ended in [400, 413, 405, 415, 301, 418] {
            assert!(
                matches!(outcome_of(answer(ended, None)), Outcome::Failed { .. }),
                "{ended}"
            );
        }
        // A key that was refused is retried, not ended.
        for refused in [401, 403] {
            assert!(matches!(
                outcome_of(answer(refused, None)),
                Outcome::Retry { .. }
            ));
            assert!(refuses_the_operator(answer(refused, None)));
        }
        assert!(!refuses_the_operator(answer(429, None)));
        // A Retry-After is kept, and capped at the longest pause.
        assert_eq!(
            outcome_of(answer(429, Some(120))),
            Outcome::Retry {
                status: Some(429),
                error: "the push service answered 429".into(),
                retry_after: Some(120)
            }
        );
        assert!(matches!(
            outcome_of(answer(503, Some(10_000_000))),
            Outcome::Retry {
                retry_after: Some(21_600),
                ..
            }
        ));
    }

    #[test]
    fn three_different_devices_refused_in_a_row_pause_the_sender_once() {
        let mut watch = AuthWatch::default();
        let (a, b, c) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
        let refused = Some(answer(403, None));
        assert!(!watch.note(a, refused));
        assert!(
            !watch.note(a, refused),
            "the same device twice is one device"
        );
        assert!(!watch.note(b, refused));
        assert!(
            watch.note(c, refused),
            "the third different device pauses the sender"
        );
        assert!(!watch.note(a, refused), "and the streak starts over");
        // A good answer or a network error in between ends the streak.
        assert!(!watch.note(b, refused));
        assert!(!watch.note(c, Some(answer(201, None))));
        assert!(!watch.note(a, refused));
        assert!(!watch.note(b, refused));
        assert!(!watch.note(c, None));
        assert!(!watch.note(a, refused));
        assert!(!watch.note(b, refused));
    }

    #[test]
    fn retry_after_is_read_as_a_number_of_seconds_only() {
        assert_eq!(retry_after_secs(Some("120")), Some(120));
        assert_eq!(retry_after_secs(Some(" 7 ")), Some(7));
        assert_eq!(
            retry_after_secs(Some("Wed, 21 Oct 2026 07:28:00 GMT")),
            None
        );
        assert_eq!(retry_after_secs(Some("-1")), None);
        assert_eq!(retry_after_secs(None), None);
    }
}
