//! The helper's tables (migration 0066): its jobs and every transaction it
//! broadcast. Only the replica holding the writer lock calls the writes.

use anyhow::{anyhow, Context};
use serde_json::Value;
use sqlx::{PgPool, Row};

use super::plan::Job;
use crate::chain_reader::word::Word;

/// A stored job.
#[derive(Clone, Debug)]
pub struct JobRow {
    /// Row id.
    pub id: i64,
    /// Unique key.
    pub key: String,
    /// Stored call name.
    pub call: String,
    /// The contract called.
    pub target: [u8; 20],
    /// Stored arguments.
    pub args: Value,
    /// `pending`, `sent`, `done`, `dropped` or `failed`.
    pub state: String,
    /// Failed attempts so far.
    pub attempts: i32,
    /// The nonce of the transaction in flight.
    pub nonce: Option<u64>,
    /// The newest transaction sent for it.
    pub tx_hash: Option<Word>,
    /// Seconds since that transaction was sent.
    pub sent_secs_ago: Option<f64>,
    /// A repeating job (its key names its period).
    pub repeats: bool,
    /// The project it was built for.
    pub project_key: Option<Word>,
}

/// One transaction to remember before it is broadcast.
pub struct SendRow<'a> {
    /// The job.
    pub job_id: i64,
    /// Its hash.
    pub tx_hash: &'a Word,
    /// Its nonce.
    pub nonce: u64,
    /// Its gas limit.
    pub gas_limit: u64,
    /// Its fee cap per gas.
    pub max_fee_per_gas: u128,
    /// Its tip cap per gas.
    pub max_priority_fee_per_gas: u128,
}

fn i64_of(v: u64) -> anyhow::Result<i64> {
    i64::try_from(v).context("number out of range")
}

fn job_of(r: &sqlx::postgres::PgRow) -> anyhow::Result<JobRow> {
    let target: Vec<u8> = r.try_get("target")?;
    let tx_hash: Option<Vec<u8>> = r.try_get("tx_hash")?;
    let nonce: Option<i64> = r.try_get("nonce")?;
    Ok(JobRow {
        id: r.try_get("id")?,
        key: r.try_get("job_key")?,
        call: r.try_get("call")?,
        target: target
            .try_into()
            .map_err(|_| anyhow!("stored target is not 20 bytes"))?,
        args: r.try_get("args")?,
        state: r.try_get("state")?,
        attempts: r.try_get("attempts")?,
        nonce: nonce
            .map(u64::try_from)
            .transpose()
            .context("negative nonce")?,
        tx_hash: tx_hash
            .map(|h| {
                h.try_into()
                    .map_err(|_| anyhow!("stored hash is not 32 bytes"))
            })
            .transpose()?,
        sent_secs_ago: r.try_get("sent_secs_ago")?,
        repeats: r.try_get("repeats")?,
        project_key: r
            .try_get::<Option<Vec<u8>>, _>("project_key")?
            .map(|k| {
                k.try_into()
                    .map_err(|_| anyhow!("stored project key is not 32 bytes"))
            })
            .transpose()?,
    })
}

macro_rules! columns {
    () => {
        "id, job_key, call, target, args, state, attempts, nonce, tx_hash, repeats, project_key, \
         extract(epoch FROM now() - sent_at)::float8 AS sent_secs_ago"
    };
}

/// Store newly due jobs. A job already stored is left alone, except a one-off
/// job that ended `done` or `dropped` at a block the final rows have now
/// passed while its effect is still missing from them (the builder would not
/// make it otherwise): a shallow reorg took its effect away, so it is looked
/// at again. Returns the jobs added or reopened.
pub async fn upsert_jobs(
    pool: &PgPool,
    reader: &str,
    jobs: &[Job],
    final_block: u64,
) -> anyhow::Result<u64> {
    let mut changed = 0;
    let mut tx = pool.begin().await?;
    for job in jobs {
        changed += sqlx::query(
            "INSERT INTO chain_helper_jobs (reader, job_key, call, target, args, project_key, \
                 due_block, repeats) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) \
             ON CONFLICT (reader, job_key) DO UPDATE SET state = 'pending', attempts = 0, \
                 next_try_at = now(), last_error = NULL, nonce = NULL, tx_hash = NULL, sent_at = NULL, \
                 settled_block = NULL, done_at = NULL, due_block = EXCLUDED.due_block, args = EXCLUDED.args \
             WHERE NOT chain_helper_jobs.repeats AND chain_helper_jobs.state IN ('done', 'dropped') \
               AND chain_helper_jobs.settled_block <= $9",
        )
        .bind(reader)
        .bind(&job.key)
        .bind(job.call.name())
        .bind(job.call.target().as_slice())
        .bind(job.call.args())
        .bind(job.project_key.as_slice())
        .bind(i64_of(job.due_block)?)
        .bind(job.repeats)
        .bind(i64_of(final_block)?)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    }
    tx.commit().await?;
    Ok(changed)
}

/// Jobs whose transaction is in flight.
pub async fn in_flight(pool: &PgPool, reader: &str) -> anyhow::Result<Vec<JobRow>> {
    let rows = sqlx::query(concat!(
        "SELECT ",
        columns!(),
        " FROM chain_helper_jobs WHERE reader = $1 AND state = 'sent' ORDER BY id"
    ))
    .bind(reader)
    .fetch_all(pool)
    .await?;
    rows.iter().map(job_of).collect()
}

/// Pending jobs whose next try has come, at most `limit`: the calls a round or
/// a sale waits on first (in their order, [`super::calls::priority_of`]), then
/// the oldest first. Ordered in SQL, so a long queue of routine calls cannot
/// keep a close out of the first `limit` (review I2).
pub async fn due_jobs(pool: &PgPool, reader: &str, limit: i64) -> anyhow::Result<Vec<JobRow>> {
    let order: Vec<String> = super::calls::names_by_priority()
        .into_iter()
        .map(str::to_owned)
        .collect();
    let rows = sqlx::query(concat!(
        "SELECT ",
        columns!(),
        " FROM chain_helper_jobs \
         WHERE reader = $1 AND state = 'pending' AND next_try_at <= now() \
         ORDER BY array_position($3::text[], call), id LIMIT $2"
    ))
    .bind(reader)
    .bind(limit)
    .bind(&order)
    .fetch_all(pool)
    .await?;
    rows.iter().map(job_of).collect()
}

/// One job by id (tests and logs).
pub async fn job(pool: &PgPool, id: i64) -> anyhow::Result<JobRow> {
    let row = sqlx::query(concat!(
        "SELECT ",
        columns!(),
        " FROM chain_helper_jobs WHERE id = $1"
    ))
    .bind(id)
    .fetch_one(pool)
    .await?;
    job_of(&row)
}

/// Nothing to do at `head`: the job ends (a repeating job for this period; a
/// one-off job unless its effect never reaches the final rows).
pub async fn mark_dropped(pool: &PgPool, id: i64, reason: &str, head: u64) -> anyhow::Result<()> {
    sqlx::query(
        "UPDATE chain_helper_jobs SET state = 'dropped', last_error = $2, settled_block = $3, \
             done_at = now(), nonce = NULL WHERE id = $1",
    )
    .bind(id)
    .bind(reason)
    .bind(i64_of(head)?)
    .execute(pool)
    .await?;
    Ok(())
}

/// The transaction mined and succeeded in `block`.
pub async fn mark_done(pool: &PgPool, id: i64, block: u64) -> anyhow::Result<()> {
    sqlx::query(
        "UPDATE chain_helper_jobs SET state = 'done', settled_block = $2, done_at = now(), \
             last_error = NULL WHERE id = $1",
    )
    .bind(id)
    .bind(i64_of(block)?)
    .execute(pool)
    .await?;
    Ok(())
}

/// A failed attempt: count it, keep the error, and wait `pause` seconds; at
/// `max_attempts` the job ends `failed` (terminal). Returns whether it ended.
pub async fn mark_retry(
    pool: &PgPool,
    id: i64,
    error: &str,
    pause_secs: f64,
    max_attempts: u32,
) -> anyhow::Result<bool> {
    let state: String = sqlx::query_scalar(
        "UPDATE chain_helper_jobs SET attempts = attempts + 1, last_error = $2, nonce = NULL, \
             next_try_at = now() + make_interval(secs => $3), \
             state = CASE WHEN attempts + 1 >= $4 THEN 'failed' ELSE 'pending' END, \
             done_at = CASE WHEN attempts + 1 >= $4 THEN now() ELSE NULL END \
         WHERE id = $1 RETURNING state",
    )
    .bind(id)
    .bind(error)
    .bind(pause_secs)
    .bind(i32::try_from(max_attempts).unwrap_or(i32::MAX))
    .fetch_one(pool)
    .await?;
    Ok(state == "failed")
}

/// Not now, through no fault of the job (a daily cap, an empty balance): try
/// again after `pause` seconds without counting an attempt.
pub async fn postpone(pool: &PgPool, id: i64, reason: &str, pause_secs: f64) -> anyhow::Result<()> {
    sqlx::query(
        "UPDATE chain_helper_jobs SET state = 'pending', last_error = $2, nonce = NULL, \
             next_try_at = now() + make_interval(secs => $3) WHERE id = $1",
    )
    .bind(id)
    .bind(reason)
    .bind(pause_secs)
    .execute(pool)
    .await?;
    Ok(())
}

/// A job that can never be sent (its stored call does not read back): it ends
/// `failed` at once.
pub async fn mark_failed(pool: &PgPool, id: i64, reason: &str) -> anyhow::Result<()> {
    sqlx::query(
        "UPDATE chain_helper_jobs SET state = 'failed', last_error = $2, done_at = now() WHERE id = $1",
    )
    .bind(id)
    .bind(reason)
    .execute(pool)
    .await?;
    Ok(())
}

/// Before broadcasting: remember the transaction (its reserved gas and fee
/// count toward the daily caps at once) and mark the job `sent`, in one
/// transaction. The arguments stored are the ones sent.
pub async fn record_send(
    pool: &PgPool,
    reader: &str,
    send: SendRow<'_>,
    args: &Value,
) -> anyhow::Result<()> {
    let reserved = u128::from(send.gas_limit).saturating_mul(send.max_fee_per_gas);
    let mut tx = pool.begin().await?;
    sqlx::query(
        "INSERT INTO chain_helper_sends (reader, tx_hash, job_id, nonce, gas_limit, max_fee_per_gas, \
             max_priority_fee_per_gas, reserved_wei) \
         VALUES ($1, $2, $3, $4, $5, $6::numeric, $8::numeric, $7::numeric) \
         ON CONFLICT (reader, tx_hash) DO UPDATE SET gas_used = NULL, spent_wei = NULL, \
             settled_at = NULL, sent_at = now(), reserved_wei = EXCLUDED.reserved_wei",
    )
    .bind(reader)
    .bind(send.tx_hash.as_slice())
    .bind(send.job_id)
    .bind(i64_of(send.nonce)?)
    .bind(i64_of(send.gas_limit)?)
    .bind(send.max_fee_per_gas.to_string())
    .bind(reserved.to_string())
    .bind(send.max_priority_fee_per_gas.to_string())
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "UPDATE chain_helper_jobs SET state = 'sent', nonce = $2, tx_hash = $3, sent_at = now(), \
             args = $4 WHERE id = $1",
    )
    .bind(send.job_id)
    .bind(i64_of(send.nonce)?)
    .bind(send.tx_hash.as_slice())
    .bind(args)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

/// A broadcast transaction mined: what it really used and cost.
pub async fn settle_send(
    pool: &PgPool,
    reader: &str,
    tx_hash: &Word,
    gas_used: u64,
    spent_wei: u128,
) -> anyhow::Result<()> {
    sqlx::query(
        "UPDATE chain_helper_sends SET gas_used = $3, spent_wei = $4::numeric, settled_at = now() \
         WHERE reader = $1 AND tx_hash = $2",
    )
    .bind(reader)
    .bind(tx_hash.as_slice())
    .bind(i64_of(gas_used)?)
    .bind(spent_wei.to_string())
    .execute(pool)
    .await?;
    Ok(())
}

/// A broadcast transaction that will never mine (it vanished, or another of
/// the same nonce mined): it costs nothing.
pub async fn void_send(pool: &PgPool, reader: &str, tx_hash: &Word) -> anyhow::Result<()> {
    sqlx::query(
        "UPDATE chain_helper_sends SET gas_used = 0, spent_wei = 0, settled_at = now() \
         WHERE reader = $1 AND tx_hash = $2 AND settled_at IS NULL",
    )
    .bind(reader)
    .bind(tx_hash.as_slice())
    .execute(pool)
    .await?;
    Ok(())
}

/// A transaction sent for a job.
#[derive(Clone, Debug)]
pub struct Sent {
    /// Its hash.
    pub tx_hash: Word,
    /// Its gas limit.
    pub gas_limit: u64,
    /// Its fee cap per gas.
    pub max_fee_per_gas: u128,
    /// Its tip cap per gas.
    pub max_priority_fee_per_gas: u128,
}

/// Every transaction sent for a job at `nonce`, newest first (the first and
/// any replacements).
pub async fn sends_at_nonce(
    pool: &PgPool,
    reader: &str,
    job_id: i64,
    nonce: u64,
) -> anyhow::Result<Vec<Sent>> {
    let rows = sqlx::query(
        "SELECT tx_hash, gas_limit, max_fee_per_gas::text AS fee, \
                max_priority_fee_per_gas::text AS tip FROM chain_helper_sends \
         WHERE reader = $1 AND job_id = $2 AND nonce = $3 ORDER BY sent_at DESC, tx_hash",
    )
    .bind(reader)
    .bind(job_id)
    .bind(i64_of(nonce)?)
    .fetch_all(pool)
    .await?;
    rows.into_iter()
        .map(|r| {
            let hash: Vec<u8> = r.try_get("tx_hash")?;
            let gas: i64 = r.try_get("gas_limit")?;
            let fee: String = r.try_get("fee")?;
            let tip: String = r.try_get("tip")?;
            Ok(Sent {
                tx_hash: hash
                    .try_into()
                    .map_err(|_| anyhow!("stored hash is not 32 bytes"))?,
                gas_limit: u64::try_from(gas).context("gas")?,
                max_fee_per_gas: fee.parse::<u128>().context("fee")?,
                max_priority_fee_per_gas: tip.parse::<u128>().context("tip")?,
            })
        })
        .collect()
}

/// A sent job whose transaction vanished goes back to pending (checked again
/// at the head before anything is sent).
pub async fn back_to_pending(pool: &PgPool, id: i64, reason: &str) -> anyhow::Result<()> {
    sqlx::query(
        "UPDATE chain_helper_jobs SET state = 'pending', nonce = NULL, tx_hash = NULL, sent_at = NULL, \
             last_error = $2, next_try_at = now() WHERE id = $1",
    )
    .bind(id)
    .bind(reason)
    .execute(pool)
    .await?;
    Ok(())
}

/// What the helper used in the last 24 hours.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Used {
    /// Gas, every call.
    pub gas: u128,
    /// Wei, every call.
    pub wei: u128,
}

/// Gas and wei used in the last 24 hours: what mined at its real cost, what is
/// in flight at what it reserved.
pub async fn used_last_day(pool: &PgPool, reader: &str) -> anyhow::Result<Used> {
    let row = sqlx::query(
        "SELECT coalesce(sum(coalesce(s.gas_used, s.gas_limit)), 0)::text AS gas, \
                coalesce(sum(coalesce(s.spent_wei, s.reserved_wei)), 0)::text AS wei \
         FROM chain_helper_sends s \
         WHERE s.reader = $1 AND s.sent_at > now() - interval '24 hours'",
    )
    .bind(reader)
    .fetch_one(pool)
    .await?;
    let number = |name: &str| -> anyhow::Result<u128> {
        let text: String = row.try_get(name)?;
        text.parse().with_context(|| format!("{name} used"))
    };
    Ok(Used {
        gas: number("gas")?,
        wei: number("wei")?,
    })
}

/// Gas and wei that the sends of one job at `nonce` still reserve in the last
/// 24 hours (the part of [`used_last_day`] that is in flight at that nonce).
/// Only one of them can mine, so a replacement is checked against the caps
/// for what it adds over these, not for its whole cost again.
pub async fn reserved_at_nonce(
    pool: &PgPool,
    reader: &str,
    job_id: i64,
    nonce: u64,
) -> anyhow::Result<(u128, u128)> {
    let (gas, wei): (String, String) = sqlx::query_as(
        "SELECT coalesce(sum(coalesce(gas_used, gas_limit)), 0)::text, \
                coalesce(sum(coalesce(spent_wei, reserved_wei)), 0)::text \
         FROM chain_helper_sends \
         WHERE reader = $1 AND job_id = $2 AND nonce = $3 AND settled_at IS NULL \
           AND sent_at > now() - interval '24 hours'",
    )
    .bind(reader)
    .bind(job_id)
    .bind(i64_of(nonce)?)
    .fetch_one(pool)
    .await?;
    Ok((
        gas.parse().context("gas reserved at the nonce")?,
        wei.parse().context("wei reserved at the nonce")?,
    ))
}

/// Transactions of the optional calls (`calls::OPTIONAL_NAMES`) sent for one
/// project in the last 24 hours. A replacement at the same nonce is the same
/// transaction; a send that failed or vanished still counts (it cost gas, or
/// could have).
pub async fn optional_sends_last_day(
    pool: &PgPool,
    reader: &str,
    project_key: &Word,
) -> anyhow::Result<i64> {
    let names: Vec<String> = super::calls::OPTIONAL_NAMES
        .iter()
        .map(|n| (*n).to_owned())
        .collect();
    Ok(sqlx::query_scalar(
        "SELECT count(DISTINCT (s.job_id, s.nonce)) FROM chain_helper_sends s \
         JOIN chain_helper_jobs j ON j.id = s.job_id \
         WHERE s.reader = $1 AND j.reader = $1 AND j.project_key = $2 AND j.call = ANY($3) \
           AND s.sent_at > now() - interval '24 hours'",
    )
    .bind(reader)
    .bind(project_key.as_slice())
    .bind(&names)
    .fetch_one(pool)
    .await?)
}

/// Forget ended repeating jobs older than five weeks (their period is long
/// past, so the builder will not make their keys again).
pub async fn prune(pool: &PgPool, reader: &str) -> anyhow::Result<u64> {
    Ok(sqlx::query(
        "DELETE FROM chain_helper_jobs WHERE reader = $1 AND repeats \
           AND state IN ('done', 'dropped') AND created_at < now() - interval '35 days'",
    )
    .bind(reader)
    .execute(pool)
    .await?
    .rows_affected())
}
