//! The chain reader's tables (migration 0065).
//!
//! Every write that moves the reader runs in one transaction that takes the
//! reader's advisory lock and checks the cursor is still where the caller
//! read it, so two relay processes reading the same chain cannot interleave:
//! the slower one's result is dropped and it reads again (a generation fence).

use std::collections::HashMap;

use anyhow::{bail, Context};
use serde_json::Value;
use sqlx::{PgPool, Postgres, Row, Transaction};

use super::events::Role;
use super::numbers::{LogRow, Runners};
use super::source::Header;
use super::word::Word;

/// A contract the reader follows.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Contract {
    /// Its address.
    pub address: [u8; 20],
    /// What it is.
    pub role: Role,
    /// The project it belongs to (none for the Launcher).
    pub project_key: Option<Word>,
    /// The block it was found in.
    pub from_block: u64,
}

/// One log ready to store.
#[derive(Clone, Debug)]
pub struct StoredLog {
    /// Block number.
    pub block_number: u64,
    /// Position in the block.
    pub log_index: u32,
    /// Block hash.
    pub block_hash: Word,
    /// Transaction hash.
    pub tx_hash: Word,
    /// Emitting contract.
    pub address: [u8; 20],
    /// Its role.
    pub role: Role,
    /// Its project.
    pub project_key: Option<Word>,
    /// Event name.
    pub event: String,
    /// Raw topics.
    pub topics: Vec<Word>,
    /// Raw data.
    pub data: Vec<u8>,
    /// Decoded fields.
    pub decoded: Value,
}

/// What was last signed for a project.
#[derive(Clone, Debug)]
pub struct Published {
    /// The newest final block of the project's logs it was worked out from.
    pub source_block: u64,
    /// Digest of the event-derived part.
    pub facts_digest: Vec<u8>,
    /// Digest of everything but `asOf`.
    pub content_digest: Vec<u8>,
    /// When it was signed, or last checked and found unchanged (unix seconds).
    pub published_at: i64,
    /// The same, to the microsecond, to refresh the longest-unchecked first.
    pub checked_at: f64,
    /// A rollback removed rows it was worked out from.
    pub stale: bool,
}

fn i64_of(v: u64) -> anyhow::Result<i64> {
    i64::try_from(v).context("block number out of range")
}

fn u64_of(v: i64) -> anyhow::Result<u64> {
    u64::try_from(v).context("negative block number")
}

fn word_of(bytes: Vec<u8>) -> anyhow::Result<Word> {
    bytes
        .try_into()
        .map_err(|_| anyhow::anyhow!("stored hash is not 32 bytes"))
}

fn addr_of(bytes: Vec<u8>) -> anyhow::Result<[u8; 20]> {
    bytes
        .try_into()
        .map_err(|_| anyhow::anyhow!("stored address is not 20 bytes"))
}

/// Create the reader's cursor at `start_block` and follow the Launcher, once.
pub async fn ensure_reader(
    pool: &PgPool,
    reader: &str,
    launcher: &[u8; 20],
    start_block: u64,
) -> anyhow::Result<()> {
    let mut tx = pool.begin().await?;
    sqlx::query(
        "INSERT INTO chain_reader_cursor (reader, next_block) VALUES ($1, $2) \
         ON CONFLICT (reader) DO NOTHING",
    )
    .bind(reader)
    .bind(i64_of(start_block)?)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "INSERT INTO chain_contracts (reader, address, role, project_key, from_block) \
         VALUES ($1, $2, 'launcher', NULL, $3) ON CONFLICT (reader, address) DO NOTHING",
    )
    .bind(reader)
    .bind(launcher.as_slice())
    .bind(i64_of(start_block)?)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

/// The next block the reader will scan.
pub async fn cursor(pool: &PgPool, reader: &str) -> anyhow::Result<u64> {
    let next: i64 =
        sqlx::query_scalar("SELECT next_block FROM chain_reader_cursor WHERE reader = $1")
            .bind(reader)
            .fetch_one(pool)
            .await?;
    u64_of(next)
}

/// The stored blocks, newest first, at most `limit`.
pub async fn blocks_desc(pool: &PgPool, reader: &str, limit: i64) -> anyhow::Result<Vec<Header>> {
    let rows = sqlx::query(
        "SELECT number, hash, parent_hash, block_time FROM chain_blocks \
         WHERE reader = $1 ORDER BY number DESC LIMIT $2",
    )
    .bind(reader)
    .bind(limit)
    .fetch_all(pool)
    .await?;
    rows.into_iter()
        .map(|r| {
            Ok(Header {
                number: u64_of(r.try_get("number")?)?,
                hash: word_of(r.try_get("hash")?)?,
                parent: word_of(r.try_get("parent_hash")?)?,
                time: u64_of(r.try_get("block_time")?)?,
            })
        })
        .collect()
}

/// The stored header of block `number`, if any.
pub async fn block(pool: &PgPool, reader: &str, number: u64) -> anyhow::Result<Option<Header>> {
    let row = sqlx::query(
        "SELECT number, hash, parent_hash, block_time FROM chain_blocks WHERE reader = $1 AND number = $2",
    )
    .bind(reader)
    .bind(i64_of(number)?)
    .fetch_optional(pool)
    .await?;
    row.map(|r| {
        Ok(Header {
            number: u64_of(r.try_get("number")?)?,
            hash: word_of(r.try_get("hash")?)?,
            parent: word_of(r.try_get("parent_hash")?)?,
            time: u64_of(r.try_get("block_time")?)?,
        })
    })
    .transpose()
}

/// Every contract the reader follows.
pub async fn contracts(pool: &PgPool, reader: &str) -> anyhow::Result<Vec<Contract>> {
    let rows = sqlx::query(
        "SELECT address, role, project_key, from_block FROM chain_contracts WHERE reader = $1 \
         ORDER BY from_block, address",
    )
    .bind(reader)
    .fetch_all(pool)
    .await?;
    rows.into_iter()
        .map(|r| {
            let role: String = r.try_get("role")?;
            let key: Option<Vec<u8>> = r.try_get("project_key")?;
            Ok(Contract {
                address: addr_of(r.try_get("address")?)?,
                role: Role::parse(&role).with_context(|| format!("unknown role {role}"))?,
                project_key: key.map(word_of).transpose()?,
                from_block: u64_of(r.try_get("from_block")?)?,
            })
        })
        .collect()
}

/// Take the reader's lock and check its cursor is still `expected_next`.
async fn fenced(
    pool: &PgPool,
    reader: &str,
    expected_next: u64,
) -> anyhow::Result<Transaction<'static, Postgres>> {
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(format!("chain_reader:{reader}"))
        .execute(&mut *tx)
        .await?;
    let next: i64 = sqlx::query_scalar(
        "SELECT next_block FROM chain_reader_cursor WHERE reader = $1 FOR UPDATE",
    )
    .bind(reader)
    .fetch_one(&mut *tx)
    .await?;
    if u64_of(next)? != expected_next {
        bail!("another reader moved the cursor (expected {expected_next}, found {next})");
    }
    Ok(tx)
}

/// One scanned range, written as one transaction.
pub struct RangeWrite<'a> {
    /// The cursor the scan started from.
    pub expected_next: u64,
    /// The last block scanned.
    pub to: u64,
    /// Headers of every block a log came from, and of `to`.
    pub blocks: &'a [Header],
    /// Contracts found in the range.
    pub contracts: &'a [Contract],
    /// Logs found in the range.
    pub logs: &'a [StoredLog],
    /// Blocks with no logs below this are forgotten (only recent ones are kept
    /// to find a fork point).
    pub keep_from: u64,
}

/// Store a scanned range and move the cursor past it.
pub async fn commit_range(pool: &PgPool, reader: &str, w: RangeWrite<'_>) -> anyhow::Result<()> {
    let mut tx = fenced(pool, reader, w.expected_next).await?;
    for h in w.blocks {
        sqlx::query(
            "INSERT INTO chain_blocks (reader, number, hash, parent_hash, block_time) \
             VALUES ($1, $2, $3, $4, $5) \
             ON CONFLICT (reader, number) DO UPDATE SET hash = EXCLUDED.hash, \
                 parent_hash = EXCLUDED.parent_hash, block_time = EXCLUDED.block_time",
        )
        .bind(reader)
        .bind(i64_of(h.number)?)
        .bind(h.hash.as_slice())
        .bind(h.parent.as_slice())
        .bind(i64_of(h.time)?)
        .execute(&mut *tx)
        .await?;
    }
    for c in w.contracts {
        sqlx::query(
            "INSERT INTO chain_contracts (reader, address, role, project_key, from_block) \
             VALUES ($1, $2, $3, $4, $5) ON CONFLICT (reader, address) DO NOTHING",
        )
        .bind(reader)
        .bind(c.address.as_slice())
        .bind(c.role.as_str())
        .bind(c.project_key.as_ref().map(|k| k.as_slice()))
        .bind(i64_of(c.from_block)?)
        .execute(&mut *tx)
        .await?;
    }
    // Logs from before the range: contracts or pools found late, read back
    // to where they began (review I2 / I1). A row already stored is kept, and
    // the projects they belong to are worked out and signed again.
    let mut earlier_projects: Vec<Vec<u8>> = Vec::new();
    for l in w.logs {
        let earlier = l.block_number < w.expected_next;
        if earlier {
            if let Some(k) = l.project_key {
                if !earlier_projects
                    .iter()
                    .any(|e| e.as_slice() == k.as_slice())
                {
                    earlier_projects.push(k.to_vec());
                }
            }
        }
        let topics: Vec<Vec<u8>> = l.topics.iter().map(|t| t.to_vec()).collect();
        let inserted = sqlx::query(if earlier {
            "INSERT INTO chain_logs (reader, block_number, log_index, block_hash, tx_hash, address, \
                 role, project_key, event, topics, data, decoded) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) \
             ON CONFLICT (reader, block_number, log_index) DO NOTHING"
        } else {
            "INSERT INTO chain_logs (reader, block_number, log_index, block_hash, tx_hash, address, \
                 role, project_key, event, topics, data, decoded) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)"
        })
        .bind(reader)
        .bind(i64_of(l.block_number)?)
        .bind(i32::try_from(l.log_index).context("log index")?)
        .bind(l.block_hash.as_slice())
        .bind(l.tx_hash.as_slice())
        .bind(l.address.as_slice())
        .bind(l.role.as_str())
        .bind(l.project_key.as_ref().map(|k| k.as_slice()))
        .bind(&l.event)
        .bind(topics)
        .bind(&l.data)
        .bind(&l.decoded)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        if inserted == 0 {
            continue;
        }
        if let Some((key, moves)) = balance_moves(l) {
            for (account, delta) in moves {
                sqlx::query(
                    "INSERT INTO chain_balance_changes \
                         (reader, block_number, log_index, account, project_key, delta) \
                     VALUES ($1, $2, $3, $4, $5, $6::numeric)",
                )
                .bind(reader)
                .bind(i64_of(l.block_number)?)
                .bind(i32::try_from(l.log_index).context("log index")?)
                .bind(account.as_slice())
                .bind(key.as_slice())
                .bind(&delta)
                .execute(&mut *tx)
                .await?;
                sqlx::query(
                    "INSERT INTO chain_balances (reader, project_key, account, balance) \
                     VALUES ($1, $2, $3, $4::numeric) \
                     ON CONFLICT (reader, project_key, account) \
                     DO UPDATE SET balance = chain_balances.balance + EXCLUDED.balance",
                )
                .bind(reader)
                .bind(key.as_slice())
                .bind(account.as_slice())
                .bind(&delta)
                .execute(&mut *tx)
                .await?;
            }
        }
    }
    if !earlier_projects.is_empty() {
        sqlx::query(
            "UPDATE chain_project_numbers SET stale = true \
             WHERE reader = $1 AND project_key = ANY($2)",
        )
        .bind(reader)
        .bind(&earlier_projects)
        .execute(&mut *tx)
        .await?;
    }
    sqlx::query(
        "DELETE FROM chain_blocks b WHERE b.reader = $1 AND b.number < $2 AND b.number <> $3 \
         AND NOT EXISTS (SELECT 1 FROM chain_logs l WHERE l.reader = b.reader AND l.block_number = b.number)",
    )
    .bind(reader)
    .bind(i64_of(w.keep_from)?)
    .bind(i64_of(w.to)?)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "UPDATE chain_reader_cursor SET next_block = $2, updated_at = now() WHERE reader = $1",
    )
    .bind(reader)
    .bind(i64_of(w.to + 1)?)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

/// Undo everything after block `fork` (the last block both chains share) and
/// scan again from `fork + 1`.
pub async fn rollback(
    pool: &PgPool,
    reader: &str,
    expected_next: u64,
    fork: u64,
) -> anyhow::Result<u64> {
    let mut tx = fenced(pool, reader, expected_next).await?;
    let fork_i = i64_of(fork)?;
    // The running balances lose the changes of the logs that are going. A
    // balance that reaches 0 is kept: a later rollback past earlier changes
    // must find its row to subtract from, and `balances` leaves zeros out.
    sqlx::query(
        "UPDATE chain_balances b SET balance = b.balance - c.total \
         FROM (SELECT project_key, account, sum(delta) AS total FROM chain_balance_changes \
               WHERE reader = $1 AND block_number > $2 GROUP BY project_key, account) c \
         WHERE b.reader = $1 AND b.project_key = c.project_key AND b.account = c.account",
    )
    .bind(reader)
    .bind(fork_i)
    .execute(&mut *tx)
    .await?;
    sqlx::query("DELETE FROM chain_balance_changes WHERE reader = $1 AND block_number > $2")
        .bind(reader)
        .bind(fork_i)
        .execute(&mut *tx)
        .await?;
    let removed = sqlx::query("DELETE FROM chain_logs WHERE reader = $1 AND block_number > $2")
        .bind(reader)
        .bind(fork_i)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    sqlx::query("DELETE FROM chain_blocks WHERE reader = $1 AND number > $2")
        .bind(reader)
        .bind(fork_i)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "DELETE FROM chain_contracts WHERE reader = $1 AND from_block > $2 AND role <> 'launcher'",
    )
    .bind(reader)
    .bind(fork_i)
    .execute(&mut *tx)
    .await?;
    // A helper job made due by a row that is gone is dropped with it. A job
    // whose transaction is in flight stays: its receipt (or its vanishing)
    // settles it, and a done job is history.
    sqlx::query(
        "DELETE FROM chain_helper_jobs WHERE reader = $1 AND due_block > $2 \
         AND state IN ('pending', 'dropped', 'failed')",
    )
    .bind(reader)
    .bind(fork_i)
    .execute(&mut *tx)
    .await?;
    // The numbers signed from rows that are gone must be worked out again,
    // even when the new rows end at the same block number.
    sqlx::query(
        "UPDATE chain_project_numbers SET stale = true WHERE reader = $1 AND source_block > $2",
    )
    .bind(reader)
    .bind(fork_i)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "UPDATE chain_reader_cursor SET next_block = $2, updated_at = now() WHERE reader = $1",
    )
    .bind(reader)
    .bind(i64_of(fork + 1)?)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(removed)
}

/// Each launched project with final logs, and the newest final block of its
/// logs.
pub async fn final_projects(
    pool: &PgPool,
    reader: &str,
    final_block: u64,
) -> anyhow::Result<Vec<(Word, u64)>> {
    let rows = sqlx::query(
        "SELECT project_key, max(block_number) AS head FROM chain_logs \
         WHERE reader = $1 AND project_key IS NOT NULL AND block_number <= $2 \
           AND project_key IN (SELECT project_key FROM chain_logs \
               WHERE reader = $1 AND event = 'ProjectLaunched' AND role = 'launcher' AND block_number <= $2) \
         GROUP BY project_key ORDER BY project_key",
    )
    .bind(reader)
    .bind(i64_of(final_block)?)
    .fetch_all(pool)
    .await?;
    rows.into_iter()
        .map(|r| {
            Ok((
                word_of(r.try_get("project_key")?)?,
                u64_of(r.try_get("head")?)?,
            ))
        })
        .collect()
}

/// A project's decoded final logs, oldest first, with their block times.
pub async fn project_logs(
    pool: &PgPool,
    reader: &str,
    key: &Word,
    final_block: u64,
) -> anyhow::Result<Vec<LogRow>> {
    let rows = sqlx::query(
        "SELECT l.block_number, l.log_index, b.block_time, l.role, l.address, l.event, l.decoded \
         FROM chain_logs l JOIN chain_blocks b ON b.reader = l.reader AND b.number = l.block_number \
         WHERE l.reader = $1 AND l.project_key = $2 AND l.block_number <= $3 AND l.decoded IS NOT NULL \
           AND NOT (l.role = 'shares' AND l.event = 'Transfer') \
         ORDER BY l.block_number, l.log_index",
    )
    .bind(reader)
    .bind(key.as_slice())
    .bind(i64_of(final_block)?)
    .fetch_all(pool)
    .await?;
    rows.into_iter()
        .map(|r| {
            let role: String = r.try_get("role")?;
            let index: i32 = r.try_get("log_index")?;
            Ok(LogRow {
                block: u64_of(r.try_get("block_number")?)?,
                log_index: u32::try_from(index).context("log index")?,
                time: u64_of(r.try_get("block_time")?)?,
                role: Role::parse(&role).with_context(|| format!("unknown role {role}"))?,
                address: addr_of(r.try_get("address")?)?,
                event: r.try_get("event")?,
                fields: r.try_get("decoded")?,
            })
        })
        .collect()
}

/// The Shares moves a stored log makes: its project and, for a Shares
/// `Transfer`, the sender's and the receiver's changes as decimal text (the
/// zero address, mint and burn, is not an account).
/// A project and the balance changes (account, signed decimal) of one log.
type BalanceMoves = (Word, Vec<([u8; 20], String)>);

fn balance_moves(l: &StoredLog) -> Option<BalanceMoves> {
    if l.role != Role::Shares || l.event != "Transfer" {
        return None;
    }
    let key = l.project_key?;
    let addr = |name: &str| {
        l.decoded
            .get(name)
            .and_then(Value::as_str)
            .and_then(super::word::parse_fixed::<20>)
    };
    let (from, to) = (addr("from")?, addr("to")?);
    let value = l.decoded.get("value").and_then(Value::as_str)?.to_owned();
    let mut moves = Vec::with_capacity(2);
    if from != to {
        if from != [0u8; 20] {
            moves.push((from, format!("-{value}")));
        }
        if to != [0u8; 20] {
            moves.push((to, value));
        }
    }
    Some((key, moves))
}

/// A project's free Shares per account as of `final_block` (lower-case `0x`
/// text): the running balances, less any change stored past that block
/// (review F5: Transfers are no longer loaded with the project's logs).
pub async fn balances(
    pool: &PgPool,
    reader: &str,
    key: &Word,
    final_block: u64,
) -> anyhow::Result<HashMap<String, i128>> {
    let rows: Vec<(Vec<u8>, String)> = sqlx::query_as(
        "SELECT b.account, (b.balance - COALESCE((SELECT sum(c.delta) FROM chain_balance_changes c \
                 WHERE c.reader = b.reader AND c.project_key = b.project_key \
                   AND c.account = b.account AND c.block_number > $3), 0))::text \
         FROM chain_balances b WHERE b.reader = $1 AND b.project_key = $2",
    )
    .bind(reader)
    .bind(key.as_slice())
    .bind(i64_of(final_block)?)
    .fetch_all(pool)
    .await?;
    let mut out = HashMap::with_capacity(rows.len());
    for (account, balance) in rows {
        let balance: i128 = balance
            .parse()
            .with_context(|| format!("a stored balance is not a number: {balance}"))?;
        if balance != 0 {
            out.insert(super::word::hex0x(&account), balance);
        }
    }
    Ok(out)
}

/// What was last signed, per project.
pub async fn published(pool: &PgPool, reader: &str) -> anyhow::Result<HashMap<Word, Published>> {
    let rows = sqlx::query(
        "SELECT project_key, source_block, facts_digest, content_digest, \
                floor(extract(epoch FROM published_at))::bigint AS at, \
                extract(epoch FROM published_at)::float8 AS checked, stale \
         FROM chain_project_numbers WHERE reader = $1",
    )
    .bind(reader)
    .fetch_all(pool)
    .await?;
    let mut out = HashMap::new();
    for r in rows {
        out.insert(
            word_of(r.try_get("project_key")?)?,
            Published {
                source_block: u64_of(r.try_get("source_block")?)?,
                facts_digest: r.try_get("facts_digest")?,
                content_digest: r.try_get("content_digest")?,
                published_at: r.try_get("at")?,
                checked_at: r.try_get("checked")?,
                stale: r.try_get("stale")?,
            },
        );
    }
    Ok(out)
}

/// A signed record to remember.
pub struct PublishedRow<'a> {
    /// The project.
    pub key: &'a Word,
    /// The newest final block of its logs.
    pub source_block: u64,
    /// Digest of the event-derived part.
    pub facts_digest: &'a [u8; 32],
    /// Digest of everything but `asOf`.
    pub content_digest: &'a [u8; 32],
    /// The signed event's id.
    pub event_id: &'a [u8; 32],
    /// Its `created_at`.
    pub published_at: i64,
}

/// Remember what was signed for a project.
pub async fn record_published(
    pool: &PgPool,
    reader: &str,
    row: PublishedRow<'_>,
) -> anyhow::Result<()> {
    sqlx::query(
        "INSERT INTO chain_project_numbers (reader, project_key, source_block, facts_digest, \
             content_digest, event_id, published_at) \
         VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7)) \
         ON CONFLICT (reader, project_key) DO UPDATE SET source_block = EXCLUDED.source_block, \
             facts_digest = EXCLUDED.facts_digest, content_digest = EXCLUDED.content_digest, \
             event_id = EXCLUDED.event_id, published_at = EXCLUDED.published_at, stale = false",
    )
    .bind(reader)
    .bind(row.key.as_slice())
    .bind(i64_of(row.source_block)?)
    .bind(row.facts_digest.as_slice())
    .bind(row.content_digest.as_slice())
    .bind(row.event_id.as_slice())
    .bind(row.published_at as f64)
    .execute(pool)
    .await?;
    Ok(())
}

/// Forget a project whose launch left the chain, after its removal was signed.
pub async fn forget_published(pool: &PgPool, reader: &str, key: &Word) -> anyhow::Result<()> {
    sqlx::query("DELETE FROM chain_project_numbers WHERE reader = $1 AND project_key = $2")
        .bind(reader)
        .bind(key.as_slice())
        .execute(pool)
        .await?;
    Ok(())
}

/// Remember that the record already covers the project's logs up to
/// `source_block`. With `checked`, the record was also found unchanged now:
/// `published_at` moves to now, so the project is not due a refresh again for
/// the refresh time and others get their turn (review I1 / F3).
pub async fn touch_source_block(
    pool: &PgPool,
    reader: &str,
    key: &Word,
    source_block: u64,
    checked: bool,
) -> anyhow::Result<()> {
    sqlx::query(
        "UPDATE chain_project_numbers SET source_block = $3, stale = false, \
             published_at = CASE WHEN $4 THEN greatest(published_at, now()) ELSE published_at END \
         WHERE reader = $1 AND project_key = $2",
    )
    .bind(reader)
    .bind(key.as_slice())
    .bind(i64_of(source_block)?)
    .bind(checked)
    .execute(pool)
    .await?;
    Ok(())
}

/// The Launcher's Pair and Council runners made in final blocks (`Launcher.runnerKind`).
pub async fn runners(pool: &PgPool, reader: &str, final_block: u64) -> anyhow::Result<Runners> {
    let rows = sqlx::query(
        "SELECT decoded->>'pair' AS pair, decoded->>'council' AS council FROM chain_logs \
         WHERE reader = $1 AND role = 'launcher' AND event IN ('PairMade', 'CouncilRegistered') \
           AND block_number <= $2",
    )
    .bind(reader)
    .bind(i64_of(final_block)?)
    .fetch_all(pool)
    .await?;
    let mut out = Runners::default();
    for r in rows {
        let pair: Option<String> = r.try_get("pair")?;
        let council: Option<String> = r.try_get("council")?;
        out.pairs.extend(pair);
        out.councils.extend(council);
    }
    let shared: Vec<Vec<u8>> = sqlx::query_scalar(
        "SELECT address FROM chain_contracts \
         WHERE reader = $1 AND role IN ('holder', 'pool_manager') AND from_block <= $2",
    )
    .bind(reader)
    .bind(i64_of(final_block)?)
    .fetch_all(pool)
    .await?;
    out.shared
        .extend(shared.iter().map(|a| super::word::hex0x(a)));
    Ok(out)
}

/// The pools the projects' Finishers opened (`Finisher.PoolOpened.poolId`),
/// each with its project: the pool manager's `Swap` logs are read for these.
pub async fn pool_ids(pool: &PgPool, reader: &str) -> anyhow::Result<HashMap<Word, Word>> {
    let rows: Vec<(Option<String>, Vec<u8>)> = sqlx::query_as(
        "SELECT decoded->>'poolId', project_key FROM chain_logs \
         WHERE reader = $1 AND role = 'finisher' AND event = 'PoolOpened' \
           AND project_key IS NOT NULL",
    )
    .bind(reader)
    .fetch_all(pool)
    .await?;
    let mut out = HashMap::new();
    for (id, key) in rows {
        let id = id
            .as_deref()
            .and_then(super::word::parse_fixed::<32>)
            .context("a stored PoolOpened without a pool id")?;
        let key: Word = key
            .as_slice()
            .try_into()
            .context("a stored project key is not 32 bytes")?;
        out.insert(id, key);
    }
    Ok(out)
}

/// The stored Launcher rows that name contracts (`ProjectLaunched`, a sale's
/// auction, project zero's claim, a Pair) in blocks before `before`: project
/// key, block, event and decoded fields. A reader that ran before a contract
/// kind was followed finds those contracts here (review I2).
pub async fn launcher_reveals(
    pool: &PgPool,
    reader: &str,
    before: u64,
) -> anyhow::Result<Vec<(Word, u64, String, Value)>> {
    let rows: Vec<(Vec<u8>, i64, String, Value)> = sqlx::query_as(
        "SELECT project_key, block_number, event, decoded FROM chain_logs \
         WHERE reader = $1 AND role = 'launcher' AND block_number < $2 \
           AND project_key IS NOT NULL AND decoded IS NOT NULL \
           AND event IN ('ProjectLaunched', 'SaleOpened', 'ReserveSaleOpened', 'ProjectZeroSplit', \
                         'PairMade') \
         ORDER BY block_number, log_index",
    )
    .bind(reader)
    .bind(i64_of(before)?)
    .fetch_all(pool)
    .await?;
    rows.into_iter()
        .map(|(key, block, event, decoded)| Ok((word_of(key)?, u64_of(block)?, event, decoded)))
        .collect()
}

/// Where a sale's pool can first trade, from the stored Finisher rows of
/// project `key` for `auction` (lower-case `0x` text): the block of its pool
/// step (`PoolStep`, the transaction that makes the pool), else the sale's
/// last block (`SaleOpenedBy.endBlock`; no pool step runs before it).
pub async fn pool_start(
    pool: &PgPool,
    reader: &str,
    key: &Word,
    auction: &str,
) -> anyhow::Result<Option<u64>> {
    let start: Option<i64> = sqlx::query_scalar(
        "SELECT coalesce( \
             (SELECT min(block_number) FROM chain_logs WHERE reader = $1 AND project_key = $2 \
                AND role = 'finisher' AND event = 'PoolStep' AND decoded->>'auction' = $3), \
             (SELECT max((decoded->>'endBlock')::bigint) FROM chain_logs WHERE reader = $1 \
                AND project_key = $2 AND role = 'finisher' AND event = 'SaleOpenedBy' \
                AND decoded->>'auction' = $3))",
    )
    .bind(reader)
    .bind(key.as_slice())
    .bind(auction)
    .fetch_one(pool)
    .await?;
    start.map(u64_of).transpose()
}
