//! The web push tables (migration 0074): devices, the alert maker's position, alerts, and the outbox.
//!
//! Every statement here takes the community it is for (the device rows and the outbox are community tables, fenced like
//! the others) or the chain reader's name (the cursor and the alerts are deployment-global). Nothing here reads a wallet
//! or a project: what a device is told about, and why, is decided by [`super::alerts`].

use chrono::{DateTime, Duration, Utc};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Postgres, Row, Transaction};
use uuid::Uuid;

use super::Kind;

/// How long a subscription is kept without being renewed. The app asks again when a device is opened and the row is older
/// than 30 days.
pub const SUBSCRIPTION_LIFETIME_DAYS: i64 = 90;
/// Attempts at one delivery before it ends as `failed`.
pub const MAX_ATTEMPTS: i32 = 8;
/// The longest pause between two attempts.
pub const BACKOFF_CAP_SECS: u64 = 6 * 3600;
/// How long a claimed row is held by the sender that took it, before another may take it.
pub const LEASE_SECS: i64 = 30;
/// Delivered and dropped rows are kept this long (the daily cap counts them), then swept.
pub const DELIVERED_KEEP_DAYS: i64 = 7;
/// Rows that ended as `failed` are kept this long.
pub const FAILED_KEEP_DAYS: i64 = 30;
/// An alert row is kept this long after it was made (what absorbs a repeated pass), then swept when nothing refers to it.
pub const ALERT_KEEP_DAYS: i64 = 31;

/// A device's push address and keys, as stored.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Subscription {
    /// The row's id.
    pub id: Uuid,
    /// The account.
    pub pubkey: [u8; 32],
    /// The push service's address for this device.
    pub endpoint: String,
    /// The hash of the address.
    pub endpoint_hash: [u8; 32],
    /// The device's public key.
    pub p256dh: [u8; 65],
    /// The device's auth secret.
    pub auth: [u8; 16],
}

/// The hash a subscription is unique by (per account).
pub fn endpoint_hash(endpoint: &str) -> [u8; 32] {
    Sha256::digest(endpoint.as_bytes()).into()
}

fn array<const N: usize>(bytes: Vec<u8>) -> Result<[u8; N], sqlx::Error> {
    <[u8; N]>::try_from(bytes.as_slice())
        .map_err(|_| sqlx::Error::Decode(format!("expected {N} bytes").into()))
}

fn subscription_of(row: &sqlx::postgres::PgRow) -> Result<Subscription, sqlx::Error> {
    Ok(Subscription {
        id: row.try_get("id")?,
        pubkey: array(row.try_get("pubkey")?)?,
        endpoint: row.try_get("endpoint")?,
        endpoint_hash: array(row.try_get("endpoint_hash")?)?,
        p256dh: array(row.try_get("p256dh")?)?,
        auth: array(row.try_get("auth")?)?,
    })
}

/// What a browser gave for one device: the address its push service made and the two public values it made.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NewDevice<'a> {
    /// The push address.
    pub endpoint: &'a str,
    /// The device's public key.
    pub p256dh: &'a [u8; 65],
    /// The device's auth secret.
    pub auth: &'a [u8; 16],
}

/// Keep a device for an account: add it, or renew it when the account already has this address. At most `max_per_account`
/// devices stay; the oldest go first. Everything happens in one transaction under a lock for the account, so two requests
/// at once cannot leave more than the cap.
pub async fn upsert_subscription(
    pool: &PgPool,
    community: Uuid,
    pubkey: &[u8; 32],
    device: NewDevice<'_>,
    max_per_account: u32,
    now: DateTime<Utc>,
) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(format!("web_push:{community}:{}", hex::encode(pubkey)))
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "INSERT INTO web_push_subscriptions \
             (community_id, pubkey, endpoint, endpoint_hash, p256dh, auth, created_at, expires_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) \
         ON CONFLICT (community_id, pubkey, endpoint_hash) \
         DO UPDATE SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, endpoint = EXCLUDED.endpoint, \
                       created_at = EXCLUDED.created_at, expires_at = EXCLUDED.expires_at",
    )
    .bind(community)
    .bind(pubkey.as_slice())
    .bind(device.endpoint)
    .bind(endpoint_hash(device.endpoint).as_slice())
    .bind(device.p256dh.as_slice())
    .bind(device.auth.as_slice())
    .bind(now)
    .bind(now + Duration::days(SUBSCRIPTION_LIFETIME_DAYS))
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "DELETE FROM web_push_subscriptions WHERE community_id = $1 AND pubkey = $2 AND id NOT IN ( \
             SELECT id FROM web_push_subscriptions WHERE community_id = $1 AND pubkey = $2 \
             ORDER BY created_at DESC, id DESC LIMIT $3)",
    )
    .bind(community)
    .bind(pubkey.as_slice())
    .bind(i64::from(max_per_account))
    .execute(&mut *tx)
    .await?;
    tx.commit().await
}

/// Delete an account's devices: the one with this address, or all of them. Their outbox rows go with them.
pub async fn delete_subscriptions(
    pool: &PgPool,
    community: Uuid,
    pubkey: &[u8; 32],
    endpoint_hash: Option<&[u8; 32]>,
) -> Result<u64, sqlx::Error> {
    let done = match endpoint_hash {
        Some(hash) => {
            sqlx::query(
                "DELETE FROM web_push_subscriptions \
                 WHERE community_id = $1 AND pubkey = $2 AND endpoint_hash = $3",
            )
            .bind(community)
            .bind(pubkey.as_slice())
            .bind(hash.as_slice())
            .execute(pool)
            .await?
        }
        None => {
            sqlx::query(
                "DELETE FROM web_push_subscriptions WHERE community_id = $1 AND pubkey = $2",
            )
            .bind(community)
            .bind(pubkey.as_slice())
            .execute(pool)
            .await?
        }
    };
    Ok(done.rows_affected())
}

/// The live devices of some accounts in a community (not expired), at most `limit`.
pub async fn live_subscriptions(
    executor: &mut Transaction<'_, Postgres>,
    community: Uuid,
    pubkeys: &[Vec<u8>],
    now: DateTime<Utc>,
    limit: i64,
) -> Result<Vec<Subscription>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT id, pubkey, endpoint, endpoint_hash, p256dh, auth FROM web_push_subscriptions \
         WHERE community_id = $1 AND pubkey = ANY($2) AND expires_at > $3 \
         ORDER BY pubkey, created_at, id LIMIT $4",
    )
    .bind(community)
    .bind(pubkeys)
    .bind(now)
    .bind(limit)
    .fetch_all(&mut **executor)
    .await?;
    rows.iter().map(subscription_of).collect()
}

/// The pause before the next attempt after the `attempts`th: 60 s doubling each time, at most 6 hours.
pub fn backoff_secs(attempts: i32) -> u64 {
    let n = u32::try_from(attempts.max(1) - 1).unwrap_or(0).min(20);
    (60u64 << n).min(BACKOFF_CAP_SECS)
}

/// A row the sender has claimed, with what it needs to send it.
#[derive(Clone, Debug)]
pub struct Due {
    /// The community of the device.
    pub community_id: Uuid,
    /// The outbox row.
    pub id: Uuid,
    /// How many attempts this is, counting the one now claimed.
    pub attempts: i32,
    /// The device.
    pub subscription: Subscription,
    /// The project the alert is about.
    pub project_key: [u8; 32],
    /// The task's serial.
    pub serial: u64,
    /// What happened.
    pub kind: Kind,
    /// The project's link reference, the part after `/p/`.
    pub link_ref: String,
}

/// Claim up to `limit` rows that are due: pending ones whose time has come, and ones whose lease ran out (a sender that
/// stopped). Each claimed row counts an attempt and is held for [`LEASE_SECS`].
pub async fn claim_due(
    pool: &PgPool,
    limit: i64,
    now: DateTime<Utc>,
) -> Result<Vec<Due>, sqlx::Error> {
    let rows = sqlx::query(
        "WITH due AS ( \
             SELECT community_id, id FROM web_push_outbox \
             WHERE (state = 'pending' AND next_attempt_at <= $2) OR (state = 'sending' AND lease_until < $2) \
             ORDER BY next_attempt_at, id LIMIT $1 FOR UPDATE SKIP LOCKED), \
         claimed AS ( \
             UPDATE web_push_outbox o SET state = 'sending', attempts = o.attempts + 1, \
                    lease_until = $2 + make_interval(secs => $3) \
             FROM due WHERE o.community_id = due.community_id AND o.id = due.id \
             RETURNING o.community_id, o.id, o.attempts, o.project_key, o.alert_id, o.subscription_id) \
         SELECT c.community_id, c.id, c.attempts, c.project_key, a.serial, a.kind, a.link_ref, \
                s.id AS sub_id, s.pubkey, s.endpoint, s.endpoint_hash, s.p256dh, s.auth \
         FROM claimed c \
         JOIN web_push_alerts a ON a.id = c.alert_id \
         JOIN web_push_subscriptions s ON s.community_id = c.community_id AND s.id = c.subscription_id",
    )
    .bind(limit)
    .bind(now)
    .bind(LEASE_SECS as f64)
    .fetch_all(pool)
    .await?;
    let mut claimed = Vec::with_capacity(rows.len());
    for row in &rows {
        let kind: String = row.try_get("kind")?;
        let link_ref: Option<String> = row.try_get("link_ref")?;
        let serial: i64 = row.try_get("serial")?;
        let (Some(kind), Some(link_ref)) = (Kind::parse(&kind), link_ref) else {
            // An alert with no link, or a kind this build does not know, reaches nobody: end the row.
            let community: Uuid = row.try_get("community_id")?;
            let id: Uuid = row.try_get("id")?;
            sqlx::query(
                "UPDATE web_push_outbox SET state = 'failed', last_error = 'the alert has no link', \
                        lease_until = NULL, done_at = $3 WHERE community_id = $1 AND id = $2",
            )
            .bind(community)
            .bind(id)
            .bind(now)
            .execute(pool)
            .await?;
            continue;
        };
        claimed.push(Due {
            community_id: row.try_get("community_id")?,
            id: row.try_get("id")?,
            attempts: row.try_get("attempts")?,
            subscription: Subscription {
                id: row.try_get("sub_id")?,
                pubkey: array(row.try_get("pubkey")?)?,
                endpoint: row.try_get("endpoint")?,
                endpoint_hash: array(row.try_get("endpoint_hash")?)?,
                p256dh: array(row.try_get("p256dh")?)?,
                auth: array(row.try_get("auth")?)?,
            },
            project_key: array(row.try_get("project_key")?)?,
            serial: u64::try_from(serial).unwrap_or(0),
            kind,
            link_ref,
        });
    }
    Ok(claimed)
}

/// What came of one attempt.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// The push service took it (201).
    Delivered(i32),
    /// The push service says the device is gone (404 or 410): the device is deleted.
    Gone(i32),
    /// Try again later: the push service was busy or failed, or the network did. `retry_after` is the service's own wish in
    /// seconds.
    Retry {
        /// The status, when there was an answer.
        status: Option<i32>,
        /// A short reason, kept (at most 200 bytes).
        error: String,
        /// The `Retry-After` the service sent.
        retry_after: Option<u64>,
    },
    /// Do not try again: the push service refused it for good.
    Failed {
        /// The status.
        status: Option<i32>,
        /// A short reason.
        error: String,
    },
}

fn short(text: &str) -> String {
    let mut end = text.len().min(200);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_owned()
}

/// Write down what came of an attempt. A retry that has used its [`MAX_ATTEMPTS`] ends as `failed`.
pub async fn record(
    pool: &PgPool,
    due: &Due,
    outcome: &Outcome,
    now: DateTime<Utc>,
) -> Result<(), sqlx::Error> {
    match outcome {
        Outcome::Delivered(status) => {
            sqlx::query(
                "UPDATE web_push_outbox SET state = 'delivered', last_status = $3, last_error = NULL, \
                        lease_until = NULL, done_at = $4 WHERE community_id = $1 AND id = $2",
            )
            .bind(due.community_id)
            .bind(due.id)
            .bind(*status)
            .bind(now)
            .execute(pool)
            .await?;
        }
        Outcome::Gone(status) => {
            // The row is marked first and the device is deleted in the same transaction; the device's rows go with it.
            let mut tx = pool.begin().await?;
            sqlx::query(
                "UPDATE web_push_outbox SET state = 'gone', last_status = $3, lease_until = NULL, done_at = $4 \
                 WHERE community_id = $1 AND id = $2",
            )
            .bind(due.community_id)
            .bind(due.id)
            .bind(*status)
            .bind(now)
            .execute(&mut *tx)
            .await?;
            sqlx::query("DELETE FROM web_push_subscriptions WHERE community_id = $1 AND id = $2")
                .bind(due.community_id)
                .bind(due.subscription.id)
                .execute(&mut *tx)
                .await?;
            tx.commit().await?;
        }
        Outcome::Retry {
            status,
            error,
            retry_after,
        } => {
            if due.attempts >= MAX_ATTEMPTS {
                end_failed(pool, due, *status, error, now).await?;
            } else {
                let pause = backoff_secs(due.attempts)
                    .max(retry_after.unwrap_or(0))
                    .min(BACKOFF_CAP_SECS);
                sqlx::query(
                    "UPDATE web_push_outbox SET state = 'pending', last_status = $3, last_error = $4, \
                            lease_until = NULL, next_attempt_at = $5 + make_interval(secs => $6) \
                     WHERE community_id = $1 AND id = $2",
                )
                .bind(due.community_id)
                .bind(due.id)
                .bind(*status)
                .bind(short(error))
                .bind(now)
                .bind(pause as f64)
                .execute(pool)
                .await?;
            }
        }
        Outcome::Failed { status, error } => end_failed(pool, due, *status, error, now).await?,
    }
    Ok(())
}

async fn end_failed(
    pool: &PgPool,
    due: &Due,
    status: Option<i32>,
    error: &str,
    now: DateTime<Utc>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE web_push_outbox SET state = 'failed', last_status = $3, last_error = $4, lease_until = NULL, \
                done_at = $5 WHERE community_id = $1 AND id = $2",
    )
    .bind(due.community_id)
    .bind(due.id)
    .bind(status)
    .bind(short(error))
    .bind(now)
    .execute(pool)
    .await?;
    Ok(())
}

/// Give claimed rows back unsent (a sender that is stopping, or a pause of the whole sender): the attempt it counted is
/// given back too, since nothing left the server.
pub async fn release(pool: &PgPool, due: &Due) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE web_push_outbox SET state = 'pending', attempts = GREATEST(attempts - 1, 0), lease_until = NULL \
         WHERE community_id = $1 AND id = $2 AND state = 'sending'",
    )
    .bind(due.community_id)
    .bind(due.id)
    .execute(pool)
    .await?;
    Ok(())
}

/// What a sweep removed.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Swept {
    /// Devices past their expiry.
    pub expired: u64,
    /// Delivered, gone and dropped rows past their keeping time.
    pub finished: u64,
    /// Failed rows past their keeping time.
    pub failed: u64,
    /// Alert rows past their keeping time that no row refers to.
    pub alerts: u64,
}

/// Sweep what is old: expired devices (their rows go with them), finished rows after 7 days, failed rows after 30 and
/// alert rows after 31 that nothing refers to.
pub async fn sweep(pool: &PgPool, now: DateTime<Utc>) -> Result<Swept, sqlx::Error> {
    let expired = sqlx::query("DELETE FROM web_push_subscriptions WHERE expires_at <= $1")
        .bind(now)
        .execute(pool)
        .await?
        .rows_affected();
    let finished = sqlx::query(
        "DELETE FROM web_push_outbox WHERE state IN ('delivered', 'gone', 'dropped') AND done_at <= $1",
    )
    .bind(now - Duration::days(DELIVERED_KEEP_DAYS))
    .execute(pool)
    .await?
    .rows_affected();
    let failed =
        sqlx::query("DELETE FROM web_push_outbox WHERE state = 'failed' AND done_at <= $1")
            .bind(now - Duration::days(FAILED_KEEP_DAYS))
            .execute(pool)
            .await?
            .rows_affected();
    let alerts = sqlx::query(
        "DELETE FROM web_push_alerts a WHERE a.created_at <= $1 \
           AND NOT EXISTS (SELECT 1 FROM web_push_outbox o WHERE o.alert_id = a.id)",
    )
    .bind(now - Duration::days(ALERT_KEEP_DAYS))
    .execute(pool)
    .await?
    .rows_affected();
    Ok(Swept {
        expired,
        finished,
        failed,
        alerts,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_pause_doubles_from_a_minute_to_six_hours() {
        let pauses: Vec<u64> = (1..=8).map(backoff_secs).collect();
        assert_eq!(pauses, [60, 120, 240, 480, 960, 1920, 3840, 7680]);
        assert_eq!(backoff_secs(9), 15_360);
        assert_eq!(backoff_secs(10), 21_600, "capped at six hours");
        assert_eq!(backoff_secs(i32::MAX), 21_600);
        assert_eq!(backoff_secs(0), 60);
        assert_eq!(backoff_secs(-5), 60);
    }

    #[test]
    fn a_stored_reason_is_cut_to_200_bytes_on_a_character_edge() {
        assert_eq!(short("short"), "short");
        let long = "é".repeat(150);
        let cut = short(&long);
        assert!(cut.len() <= 200 && cut.chars().all(|c| c == 'é'));
    }
}
