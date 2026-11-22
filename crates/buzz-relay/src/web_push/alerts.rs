//! The alert maker: what is worth telling a holder, and who is told.
//!
//! **From the chain's rows, not from the record.** A step of the sender's own loop reads the reader's final task rows
//! (`TaskAnnounced` is `planned`, `TaskTaken` is `taken`, `TaskResolved` is `ended`; a withdrawn plan moved nothing and
//! makes none) from its own cursor, and makes at most one alert per `(reader, project, serial, kind)`: the same key the
//! in-app alert has, so a person is not told twice in two voices.
//!
//! **The Council round's two kinds** (`COUNCIL-PLAN.md` section 5.6). A ballot that opens (either kind: a seat election
//! changes who runs the project too) is a `vote` alert, made from its `BallotOpened` row through the same cursor, and at
//! most one is made for a project within one time unit of the chain's clock, so a stream of junk ballots cannot become a
//! stream of pushes. A result that **moves or seats** is a `moved` alert made **from the reader's own derived result**
//! (the frozen tallies and the floor, section 2.6), not from `BallotFinished`: by the first pass after `voteEnd` that
//! sees it, once per `(project, ballot, kind)`, whether or not anyone has pressed `finish`. Its own 24-hour life counts
//! from `voteEnd`. A voter's address and amount are never in a row here, as nowhere else.
//!
//! **Where the cursor starts.** The first time push is on, the cursor is set to the reader's next block to read, in the
//! statement that creates it. Nothing before that is ever alerted: a cursor at 0 would send the whole history of every task
//! to every holder. A row older than the alert's own lifetime (24 hours of the chain's clock) when it is picked up is
//! dropped, not sent.
//!
//! **The audience, with no list of holders published or kept.** For one alert: the project's accounts that hold backer
//! Shares or Team Shares in hand (at least [`ROOM_MIN_SHARES`], the contract accounts left out), largest first, at most
//! [`AUDIENCE_MAX`]; mapped to the accounts that **proved** the wallet with a kind 37017 record; mapped to those
//! accounts' live devices. A device can never name a wallet or a project, so it cannot be used to ask "does X hold here?".
//!
//! **Atomic hand-over.** One transaction writes an alert, its outbox rows and the cursor, so a stop between them repeats
//! the work (the unique keys absorb it) and never skips an alert.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use anyhow::Context;
use buzz_core::tenant::CommunityId;
use chrono::{DateTime, Utc};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use super::settings::{WebPushConfig, PROJECT_DAILY_CAP};
use super::store::{self, Subscription};
use super::Kind;
use crate::chain_reader::ledger::Ledger;
use crate::chain_reader::ledger_council::BallotSeen;
use crate::chain_reader::record_council::derive_result;
use crate::chain_reader::word::{hex0x, parse_fixed};
use crate::handlers::room_write::ROOM_MIN_SHARES;
use crate::handlers::wallet_binding::{accounts_of_wallets, WALLETS_ASKED_MAX};
use crate::state::AppState;

/// The most holders one alert is made for. More are counted (`cut`) and have the in-app alert only.
pub const AUDIENCE_MAX: usize = 2_000;
/// How many holders are counted when the audience is cut (the count reads no more than this).
const CUT_COUNT_MAX: i64 = 100_000;
/// The most task rows one pass reads.
pub const BATCH_ROWS: i64 = 200;
/// The most task rows of one single block that a pass reads when that block alone is more than [`BATCH_ROWS`]. A block's
/// logs are bounded by its gas, far below this; the bound is only a ceiling on what one pass holds in memory.
pub const BLOCK_ROWS_MAX: i64 = 10_000;
/// The alert's own lifetime: a row older than this on the chain's clock when it is picked up is dropped.
pub const ALERT_LIFETIME_SECS: u64 = 24 * 3600;
/// The most alerts without a link looked at again in one pass.
pub const UNLINKED_BATCH: i64 = 50;
/// The `TaskResolved` state of a plan withdrawn before a take: it moved nothing, so it makes no alert.
const STATE_WITHDRAWN: u64 = 6;
/// The most projects one pass looks at for a `moved` alert.
pub const MOVED_BATCH: i64 = 16;
/// One whole Share in wei (`HolderVote.MIN_VOTE`), the smallest tally a person needs to take a seat (the same value
/// `record_council` and the helper hold).
const ONE_SHARE: u128 = 1_000_000_000_000_000_000;
/// The time unit a project's `vote` push is paced by when its launch row is not stored yet (ten minutes): a ballot's
/// opening is never worth more than one push, and a unit the reader cannot read must not stop the alert.
const VOTE_UNIT_FALLBACK_SECS: u64 = 600;

/// What one pass did.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MakeReport {
    /// Task rows read.
    pub rows: usize,
    /// Alerts made (new rows).
    pub made: usize,
    /// Rows that make no alert (a withdrawn plan).
    pub skipped: usize,
    /// Rows older than the alert's lifetime: dropped, not sent.
    pub too_old: usize,
    /// Outbox rows written as `pending`.
    pub queued: usize,
    /// Outbox rows written as `dropped` by a cap.
    pub dropped: usize,
    /// Pending rows of alerts the chain rolled back, deleted.
    pub undone: u64,
    /// Alerts that had no link when they were made and have one now (see [`retry_unlinked`]).
    pub linked: usize,
}

/// A task row worth an alert, before its audience is read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Candidate {
    /// The project's chain key.
    pub project_key: [u8; 32],
    /// The task's serial.
    pub serial: u64,
    /// What happened.
    pub kind: Kind,
    /// The block the row is in.
    pub block: u64,
    /// The block's time (the chain's clock).
    pub block_time: u64,
}

/// What a task row says, or why it makes no alert. Pure.
pub fn classify(event: &str, state: Option<u64>) -> Option<Kind> {
    match event {
        "TaskAnnounced" => Some(Kind::Planned),
        "TaskTaken" => Some(Kind::Taken),
        "TaskResolved" if state == Some(STATE_WITHDRAWN) => None,
        "TaskResolved" => Some(Kind::Ended),
        // Either kind of ballot: a seat election changes who runs the project too.
        "BallotOpened" => Some(Kind::Vote),
        _ => None,
    }
}

/// Whether a row at `block_time` is too old to alert at chain time `as_of`. Pure.
pub fn is_too_old(block_time: u64, as_of: u64) -> bool {
    as_of.saturating_sub(block_time) > ALERT_LIFETIME_SECS
}

/// The block that alone fills a cut batch: `Some(block)` when `limit` rows were asked for, more came back, and the first
/// and the first unread row are in the same block. The cursor cannot name a place inside a block, so that block is read
/// whole, on its own ([`next_cursor`] would otherwise step over its unread rows). Pure.
pub fn oversized_block(blocks: &[u64], limit: usize) -> Option<u64> {
    let (first, unread) = (blocks.first()?, blocks.get(limit)?);
    (first == unread).then_some(*first)
}

/// Where the next batch starts after reading `rows` (their blocks, in order) when `limit` rows were asked for and `end`
/// is the block the reader will read next: past everything when the batch was not cut, else at the first block that was
/// not fully read (a block read twice is absorbed by the unique keys). It always moves forward. A batch that one block
/// fills is not asked of this: it is read whole first ([`oversized_block`]). Pure.
pub fn next_cursor(from: u64, blocks: &[u64], limit: usize, end: u64) -> u64 {
    if blocks.len() <= limit {
        return end;
    }
    let first_unread = blocks[limit];
    first_unread.max(from.saturating_add(1)).min(end)
}

/// The link reference (the part after `/p/`) of the project a launch names, or `None` when no stored project record of
/// this chain key hashes to the launch's `projectId`. The founder's nostr key and the record's id are not on the chain,
/// so the record is found by its `chain-key` tag and tied to the launch the way every other rule ties it
/// ([`crate::chain_reader::explore::record_of_launch`], which pages through the records of the key, so records anyone
/// signs under another project's key cannot hide the real one).
pub async fn link_ref_of(
    state: &AppState,
    community: CommunityId,
    key: &[u8; 32],
    launched_id: &str,
) -> anyhow::Result<Option<String>> {
    let found =
        crate::chain_reader::explore::record_of_launch(state, community, key, launched_id).await?;
    Ok(found.and_then(|(coordinate, event)| {
        let d = coordinate.splitn(3, ':').nth(2)?;
        let author = event.pubkey.to_hex();
        Some(format!("{d}-{}", &author[..16]))
    }))
}

/// Who is told about a project: its holders, largest first, as accounts that proved the wallet.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Audience {
    /// The accounts (32-byte keys), in order of the largest holding first.
    pub accounts: Vec<Vec<u8>>,
    /// How many holders there are, up to one more than [`AUDIENCE_MAX`].
    pub holders: usize,
    /// How many holders were cut (they have the in-app alert only).
    pub cut: usize,
}

/// The holders of a project: wallets with at least [`ROOM_MIN_SHARES`] of its backer Shares or Team Shares, the accounts
/// in `excluded` left out, largest first, at most [`AUDIENCE_MAX`] (the cut is counted); then the accounts that proved any
/// of those wallets. A database error is an error, never an empty audience.
pub async fn audience_of(
    state: &AppState,
    community: CommunityId,
    reader: &str,
    key: &[u8; 32],
    excluded: &[Vec<u8>],
) -> anyhow::Result<Audience> {
    let rows: Vec<Vec<u8>> = sqlx::query_scalar(
        "SELECT account FROM chain_balances \
         WHERE reader = $1 AND project_key = $2 AND token IN ('shares', 'team') \
           AND balance >= $3::numeric AND NOT (account = ANY($4)) \
         GROUP BY account ORDER BY sum(balance) DESC, account LIMIT $5",
    )
    .bind(reader)
    .bind(key.as_slice())
    .bind(ROOM_MIN_SHARES.to_string())
    .bind(excluded)
    .bind(i64::try_from(AUDIENCE_MAX + 1).unwrap_or(i64::MAX))
    .fetch_all(state.db.pool())
    .await
    .context("read the holders")?;
    let mut holders = rows.len();
    if holders > AUDIENCE_MAX {
        // How many there are beyond the cap, counted up to a bound: the count never reads more than this many.
        let total: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM (SELECT account FROM chain_balances \
             WHERE reader = $1 AND project_key = $2 AND token IN ('shares', 'team') \
               AND balance >= $3::numeric AND NOT (account = ANY($4)) GROUP BY account LIMIT $5) t",
        )
        .bind(reader)
        .bind(key.as_slice())
        .bind(ROOM_MIN_SHARES.to_string())
        .bind(excluded)
        .bind(CUT_COUNT_MAX)
        .fetch_one(state.db.pool())
        .await
        .context("count the holders beyond the cap")?;
        holders = usize::try_from(total).unwrap_or(holders).max(holders);
    }
    let wallets: Vec<[u8; 20]> = rows
        .iter()
        .take(AUDIENCE_MAX)
        .filter_map(|account| <[u8; 20]>::try_from(account.as_slice()).ok())
        .collect();
    let mut accounts: Vec<Vec<u8>> = Vec::new();
    let mut seen = BTreeSet::new();
    for chunk in wallets.chunks(WALLETS_ASKED_MAX) {
        let pairs = accounts_of_wallets(state, community, chunk)
            .await
            .context("read the accounts that linked the holders' wallets")?;
        for wallet in chunk {
            for (_, account) in pairs.iter().filter(|(w, _)| w == wallet) {
                if seen.insert(account.clone()) {
                    accounts.push(account.clone());
                }
            }
        }
    }
    Ok(Audience {
        accounts,
        holders: holders.min(AUDIENCE_MAX),
        cut: holders.saturating_sub(AUDIENCE_MAX),
    })
}

/// The accounts that are never holders of a project (its contracts, the zero address, the Launcher), as 20-byte values.
async fn excluded_of(
    pool: &PgPool,
    reader: &str,
    key: &[u8; 32],
    launcher: &[u8; 20],
    final_block: u64,
) -> anyhow::Result<Vec<Vec<u8>>> {
    // Only the launch and the pause's `PauseReady` name the accounts that are not holders, so only those are replayed
    // (the task rows are none of this step's business).
    let launch: Vec<_> = crate::chain_reader::store::project_logs(pool, reader, key, final_block)
        .await
        .context("read the project's rows")?
        .into_iter()
        .filter(|row| {
            use crate::chain_reader::events::Role;
            (row.role == Role::Launcher && row.event == "ProjectLaunched")
                || (row.role == Role::Treasury && row.event == "PauseReady")
        })
        .collect();
    let Some(ledger) = Ledger::from_logs(&launch)? else {
        return Ok(Vec::new());
    };
    let also = BTreeSet::from([hex0x(launcher)]);
    Ok(ledger
        .excluded(&also)
        .iter()
        .filter_map(|text| parse_fixed::<20>(text))
        .map(|a| a.to_vec())
        .collect())
}

/// The start of the UTC day `now` is in.
pub fn day_start(now: DateTime<Utc>) -> DateTime<Utc> {
    now.date_naive()
        .and_hms_opt(0, 0, 0)
        .map_or(now, |naive| naive.and_utc())
}

/// What one device has been sent today, for the caps: all alerts, and those about one project (dropped ones do not count).
async fn today_counts(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    community: Uuid,
    subscriptions: &[Uuid],
    project: &[u8; 32],
    now: DateTime<Utc>,
) -> Result<BTreeMap<Uuid, (i64, i64)>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT subscription_id, count(*) AS total, count(*) FILTER (WHERE project_key = $3) AS about \
         FROM web_push_outbox \
         WHERE community_id = $1 AND subscription_id = ANY($2) AND created_at >= $4 AND state <> 'dropped' \
         GROUP BY subscription_id",
    )
    .bind(community)
    .bind(subscriptions)
    .bind(project.as_slice())
    .bind(day_start(now))
    .fetch_all(&mut **tx)
    .await?;
    let mut counts = BTreeMap::new();
    for row in rows {
        counts.insert(
            row.try_get::<Uuid, _>("subscription_id")?,
            (
                row.try_get::<i64, _>("total")?,
                row.try_get::<i64, _>("about")?,
            ),
        );
    }
    Ok(counts)
}

/// Why a device is not sent an alert, if it is not. Pure.
pub fn cap_reason(
    total_today: i64,
    about_project_today: i64,
    daily_cap: u32,
) -> Option<&'static str> {
    if total_today >= i64::from(daily_cap) {
        Some("daily_cap")
    } else if about_project_today >= i64::from(PROJECT_DAILY_CAP) {
        Some("project_cap")
    } else {
        None
    }
}

/// An alert's rows as written in one transaction: the alert (if it is new) and one outbox row for each device.
struct Ready {
    candidate: Candidate,
    link_ref: Option<String>,
    audience: usize,
    cut: usize,
    devices: Vec<Subscription>,
}

/// The chain reader's next block to read and the newest block time it has stored, or `None` when it has read nothing.
async fn reader_position(pool: &PgPool, reader: &str) -> Result<Option<(u64, u64)>, sqlx::Error> {
    let next: Option<i64> =
        sqlx::query_scalar("SELECT next_block FROM chain_reader_cursor WHERE reader = $1")
            .bind(reader)
            .fetch_optional(pool)
            .await?;
    let Some(next) = next else {
        return Ok(None);
    };
    let as_of = crate::handlers::room_write::as_of(pool, reader).await?;
    Ok(Some((u64::try_from(next).unwrap_or(0), as_of)))
}

/// Delete the alerts of blocks the chain no longer has (the reader's next block fell to or below them) that have not left
/// the server, and bring the cursor down with the reader. An alert whose rows were already sent stays, so a person is not
/// told twice. Returns how many outbox rows were deleted.
pub async fn undo_rolled_back(
    pool: &PgPool,
    reader: &str,
    reader_next: u64,
) -> Result<u64, sqlx::Error> {
    let next = i64::try_from(reader_next).unwrap_or(i64::MAX);
    let mut tx = pool.begin().await?;
    let cursor: Option<i64> =
        sqlx::query_scalar("SELECT next_block FROM web_push_cursor WHERE reader = $1 FOR UPDATE")
            .bind(reader)
            .fetch_optional(&mut *tx)
            .await?;
    let Some(cursor) = cursor else {
        return Ok(0);
    };
    if cursor <= next {
        return Ok(0);
    }
    let deleted = sqlx::query(
        "DELETE FROM web_push_outbox WHERE state = 'pending' AND alert_id IN ( \
             SELECT id FROM web_push_alerts WHERE reader = $1 AND block_number >= $2)",
    )
    .bind(reader)
    .bind(next)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    // An alert left with no rows at all can be made again by the new chain; one that was sent stays.
    sqlx::query(
        "DELETE FROM web_push_alerts a WHERE a.reader = $1 AND a.block_number >= $2 \
           AND NOT EXISTS (SELECT 1 FROM web_push_outbox o WHERE o.alert_id = a.id)",
    )
    .bind(reader)
    .bind(next)
    .execute(&mut *tx)
    .await?;
    sqlx::query("UPDATE web_push_cursor SET next_block = $2, updated_at = now() WHERE reader = $1")
        .bind(reader)
        .bind(next)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(deleted)
}

/// Whether the reader has stored a withdrawal (`TaskResolved` with state 6) of this task below `reader_next`.
async fn withdrawn_before(
    pool: &PgPool,
    reader: &str,
    key: &[u8],
    serial: &str,
    reader_next: u64,
) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM chain_logs WHERE reader = $1 AND project_key = $2 AND role = 'tasks' \
           AND event = 'TaskResolved' AND decoded->>'serial' = $3 AND decoded->>'state' = '6' AND block_number < $4)",
    )
    .bind(reader)
    .bind(key)
    .bind(serial)
    .bind(i64::try_from(reader_next).unwrap_or(i64::MAX))
    .fetch_one(pool)
    .await
}

/// The alert rows of this reader in the blocks `from` up to, not including, `to`, in order, at most `limit` of them: the
/// task book's three events, and a ballot's opening (whose number the `vote` alert carries as its serial).
async fn read_task_rows(
    pool: &sqlx::PgPool,
    reader: &str,
    from: u64,
    to: u64,
    limit: i64,
) -> anyhow::Result<Vec<sqlx::postgres::PgRow>> {
    sqlx::query(
        "SELECT l.block_number, l.project_key, l.event, \
                coalesce(l.decoded->>'serial', l.decoded->>'id') AS serial, \
                l.decoded->>'state' AS state, b.block_time \
         FROM chain_logs l JOIN chain_blocks b ON b.reader = l.reader AND b.number = l.block_number \
         WHERE l.reader = $1 AND l.project_key IS NOT NULL \
           AND ((l.role = 'tasks' AND l.event IN ('TaskAnnounced', 'TaskTaken', 'TaskResolved')) \
                OR (l.role = 'pause' AND l.event = 'BallotOpened')) \
           AND l.block_number >= $2 AND l.block_number < $3 \
         ORDER BY l.block_number, l.log_index LIMIT $4",
    )
    .bind(reader)
    .bind(i64::try_from(from).context("block")?)
    .bind(i64::try_from(to).context("block")?)
    .bind(limit)
    .fetch_all(pool)
    .await
    .context("read the task rows")
}

/// The block of each row, in order.
fn block_numbers(rows: &[sqlx::postgres::PgRow]) -> anyhow::Result<Vec<u64>> {
    rows.iter()
        .map(|row| Ok(u64::try_from(row.try_get::<i64, _>("block_number")?).unwrap_or(0)))
        .collect()
}

/// One pass: make the alerts for the task rows the reader has stored since the cursor. A failure leaves the cursor where it
/// was, so the next pass makes the same alerts (a retry record that is the cursor itself).
pub async fn make_alerts(
    state: &Arc<AppState>,
    config: &WebPushConfig,
    now: DateTime<Utc>,
) -> anyhow::Result<MakeReport> {
    let mut report = MakeReport::default();
    let Some(reader_config) = state.config.chain_reader.as_ref() else {
        return Ok(report);
    };
    let reader = reader_config.reader_id();
    let host = match &reader_config.community_host {
        Some(h) => h.clone(),
        None => crate::tenant::relay_url_authority(&state.config.relay_url),
    };
    let Some(community) = state
        .db
        .lookup_community_by_host(&host)
        .await
        .context("look up the community of the alerts")?
        .map(|record| record.id)
    else {
        return Ok(report);
    };
    let pool = state.db.pool();
    let Some((reader_next, as_of)) = reader_position(pool, &reader).await? else {
        return Ok(report);
    };

    // The first time: the cursor starts at the reader's next block, never at 0.
    sqlx::query("INSERT INTO web_push_cursor (reader, next_block) VALUES ($1, $2) ON CONFLICT (reader) DO NOTHING")
        .bind(&reader)
        .bind(i64::try_from(reader_next).context("block")?)
        .execute(pool)
        .await
        .context("start the cursor")?;
    report.undone = undo_rolled_back(pool, &reader, reader_next).await?;
    let cursor: i64 =
        sqlx::query_scalar("SELECT next_block FROM web_push_cursor WHERE reader = $1")
            .bind(&reader)
            .fetch_one(pool)
            .await
            .context("read the cursor")?;
    let cursor = u64::try_from(cursor).unwrap_or(0);
    // The `moved` alerts are not made from a row the cursor walks past: they are the reader's derived result of a ballot
    // whose vote ended, so every pass looks at the ballots that ended and not yet told (once each, bounded).
    report.made += make_moved_alerts(
        state,
        config,
        community,
        reader_config,
        &reader,
        reader_next,
        as_of,
        now,
        &mut report.skipped,
    )
    .await?;
    if cursor >= reader_next {
        return Ok(report);
    }

    let limit = usize::try_from(BATCH_ROWS).unwrap_or(usize::MAX);
    let mut rows = read_task_rows(pool, &reader, cursor, reader_next, BATCH_ROWS + 1).await?;
    let mut blocks = block_numbers(&rows)?;
    let mut new_cursor = next_cursor(cursor, &blocks, limit, reader_next);
    let mut taken = limit;
    // One block with more rows than a batch: the cursor holds no place inside a block, so that block is read whole
    // (up to a ceiling) and the cursor goes past it.
    if let Some(block) = oversized_block(&blocks, limit) {
        rows = read_task_rows(pool, &reader, block, block + 1, BLOCK_ROWS_MAX + 1).await?;
        blocks = block_numbers(&rows)?;
        taken = usize::try_from(BLOCK_ROWS_MAX).unwrap_or(usize::MAX);
        if blocks.len() > taken {
            tracing::warn!(
                block,
                rows = blocks.len(),
                "alerts: a block holds more task rows than one pass reads; the rest make no alert"
            );
        }
        new_cursor = block + 1;
    }
    report.rows = rows.len().min(taken);

    let mut candidates = Vec::new();
    for row in rows.iter().take(taken) {
        let event: String = row.try_get("event")?;
        let state_value: Option<u64> = row
            .try_get::<Option<String>, _>("state")?
            .and_then(|text| text.parse().ok());
        let Some(kind) = classify(&event, state_value) else {
            report.skipped += 1;
            continue;
        };
        let block_time = u64::try_from(row.try_get::<i64, _>("block_time")?).unwrap_or(0);
        // A plan the chain already shows as withdrawn moved nothing: telling holders about it would be noise.
        if kind == Kind::Planned {
            let key: Vec<u8> = row.try_get("project_key")?;
            let serial = row.try_get::<Option<String>, _>("serial")?;
            if let Some(serial) = serial {
                if withdrawn_before(pool, &reader, &key, &serial, reader_next).await? {
                    report.skipped += 1;
                    continue;
                }
            }
        }
        if is_too_old(block_time, as_of) {
            report.too_old += 1;
            continue;
        }
        let key: Vec<u8> = row.try_get("project_key")?;
        let (Ok(project_key), Some(serial)) = (
            <[u8; 32]>::try_from(key.as_slice()),
            row.try_get::<Option<String>, _>("serial")?
                .and_then(|text| text.parse::<u64>().ok()),
        ) else {
            anyhow::bail!("a stored task row has no project key or serial");
        };
        candidates.push(Candidate {
            project_key,
            serial,
            kind,
            block: u64::try_from(row.try_get::<i64, _>("block_number")?).unwrap_or(0),
            block_time,
        });
    }
    let candidates = one_vote_per_unit(pool, &reader, candidates, &mut report).await?;

    // The audience and the link of each project are read once per pass.
    let mut ready = Vec::with_capacity(candidates.len());
    let mut per_project: BTreeMap<[u8; 32], (Option<String>, Audience)> = BTreeMap::new();
    for candidate in candidates {
        ready.push(
            prepare(
                state,
                community,
                &reader,
                reader_config,
                reader_next,
                now,
                candidate,
                &mut per_project,
            )
            .await?,
        );
    }

    // One transaction: the alerts, their rows and the cursor. An alert whose project's record could not be found is
    // stored with no link and no rows, and [`retry_unlinked`] looks again until it is a day old.
    let mut tx = pool.begin().await?;
    for item in &ready {
        store_alert(&mut tx, community, &reader, item, config, now, &mut report).await?;
    }
    sqlx::query("UPDATE web_push_cursor SET next_block = $2, updated_at = now() WHERE reader = $1 AND next_block = $3")
        .bind(&reader)
        .bind(i64::try_from(new_cursor).context("block")?)
        .bind(i64::try_from(cursor).context("block")?)
        .execute(&mut *tx)
        .await?;
    tx.commit()
        .await
        .context("commit the alerts and the cursor")?;
    Ok(report)
}

/// Whether a ballot's result changes who runs the project, from its own events: the recorded `BallotFinished` when
/// there is one, else the frozen tallies and the floor, exactly the reader's derived result (`COUNCIL-PLAN.md` section
/// 2.6). `None` before `voteEnd`, when there is no result yet. Pure.
pub fn moved_outcome(ballot: &BallotSeen, as_of: u64) -> Option<bool> {
    if as_of < ballot.vote_end {
        return None;
    }
    let outcome = match ballot.finished {
        Some(finished) => finished.outcome,
        None => {
            derive_result(
                ballot.kind,
                &ballot.tallies,
                ballot.option_count(),
                ballot.cast,
                ballot.floor,
                ONE_SHARE,
            )
            .0
        }
    };
    Some(matches!(outcome, 3 | 4))
}

/// The alerts one pass keeps: at most one `vote` for a project within one time
/// unit of the chain's clock (`COUNCIL-PLAN.md` section 5.6, so a stream of junk
/// ballots cannot become a stream of pushes). A ballot covered by a `vote`
/// alert already stored within the unit is dropped too. The rest keep their
/// order. Pure apart from the one read per project of its unit.
async fn one_vote_per_unit(
    pool: &sqlx::PgPool,
    reader: &str,
    candidates: Vec<Candidate>,
    report: &mut MakeReport,
) -> anyhow::Result<Vec<Candidate>> {
    let mut units: BTreeMap<[u8; 32], u64> = BTreeMap::new();
    let mut last: BTreeMap<[u8; 32], u64> = BTreeMap::new();
    let mut kept = Vec::with_capacity(candidates.len());
    for candidate in candidates {
        if candidate.kind == Kind::Vote {
            let unit = match units.get(&candidate.project_key) {
                Some(unit) => *unit,
                None => {
                    let unit = crate::handlers::room_write::launched_of(
                        pool,
                        reader,
                        &candidate.project_key,
                    )
                    .await
                    .context("read the project's time unit")?
                    .map_or(VOTE_UNIT_FALLBACK_SECS, |launch| launch.unit);
                    units.insert(candidate.project_key, unit);
                    unit
                }
            };
            if within_one_unit(
                last.get(&candidate.project_key).copied(),
                candidate.block_time,
                unit,
            ) {
                report.skipped += 1;
                continue;
            }
            if vote_alert_within(
                pool,
                reader,
                &candidate.project_key,
                candidate.block_time,
                unit,
            )
            .await?
            {
                report.skipped += 1;
                continue;
            }
            last.insert(candidate.project_key, candidate.block_time);
        }
        kept.push(candidate);
    }
    Ok(kept)
}

/// Whether a `vote` alert already made at `previous_block_time` (the chain's clock) is close enough to `at` that a
/// second one must not be made: within the project's time unit (`COUNCIL-PLAN.md` section 5.6, "at most one `vote` push
/// per project per time unit"). `None` is no alert yet, so nothing to keep. Pure.
pub fn within_one_unit(previous_block_time: Option<u64>, at: u64, unit: u64) -> bool {
    previous_block_time.is_some_and(|previous| at.saturating_sub(previous) < unit)
}

/// Whether a `vote` alert for the project was made within one time unit before `block_time` (the chain's clock).
async fn vote_alert_within(
    pool: &sqlx::PgPool,
    reader: &str,
    project_key: &[u8; 32],
    block_time: u64,
    unit: u64,
) -> Result<bool, sqlx::Error> {
    let from = i64::try_from(block_time.saturating_sub(unit)).unwrap_or(0);
    sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM web_push_alerts a \
           JOIN chain_blocks b ON b.reader = a.reader AND b.number = a.block_number \
         WHERE a.reader = $1 AND a.project_key = $2 AND a.kind = 'vote' AND b.block_time > $3)",
    )
    .bind(reader)
    .bind(project_key.as_slice())
    .bind(from)
    .fetch_one(pool)
    .await
}

/// The `moved` alerts: the ballots whose vote ended, whose derived result moves or seats someone, and that nobody has
/// told the holders about yet. Made by the first pass after `voteEnd` that sees them, whether or not anyone recorded the
/// result (`BallotFinished` is not needed), once per `(project, ballot, kind)`, with the alert's own life counted from
/// `voteEnd`. Returns how many alerts were made; a ballot of the batch that does not (yet) move or seat anyone is counted
/// in `skipped`.
#[allow(clippy::too_many_arguments)]
async fn make_moved_alerts(
    state: &Arc<AppState>,
    config: &WebPushConfig,
    community: CommunityId,
    reader_config: &crate::chain_reader::ChainReaderConfig,
    reader: &str,
    reader_next: u64,
    as_of: u64,
    now: DateTime<Utc>,
    skipped: &mut usize,
) -> anyhow::Result<usize> {
    let Some(final_block) = reader_next.checked_sub(1) else {
        return Ok(0);
    };
    let pool = state.db.pool();
    let oldest = i64::try_from(as_of.saturating_sub(ALERT_LIFETIME_SECS)).unwrap_or(0);
    // The newest ballot of each project whose vote ended inside the alert's life and whose `moved` alert is not stored.
    let rows = sqlx::query(
        "SELECT DISTINCT ON (l.project_key) l.project_key, l.decoded->>'id' AS ballot \
         FROM chain_logs l \
         WHERE l.reader = $1 AND l.role = 'pause' AND l.event = 'BallotOpened' \
           AND l.block_number < $2 \
           AND CASE WHEN l.decoded->>'voteEnd' ~ '^[0-9]+$' THEN (l.decoded->>'voteEnd')::bigint END <= $3 \
           AND CASE WHEN l.decoded->>'voteEnd' ~ '^[0-9]+$' THEN (l.decoded->>'voteEnd')::bigint END >= $4 \
           AND NOT EXISTS (SELECT 1 FROM web_push_alerts a \
                 WHERE a.reader = $1 AND a.project_key = l.project_key AND a.kind = 'moved' \
                   AND a.serial = CASE WHEN l.decoded->>'id' ~ '^[0-9]+$' THEN (l.decoded->>'id')::bigint END) \
         ORDER BY l.project_key, l.block_number DESC, l.log_index DESC LIMIT $5",
    )
    .bind(reader)
    .bind(i64::try_from(reader_next).context("block")?)
    .bind(i64::try_from(as_of).context("chain time")?)
    .bind(oldest)
    .bind(MOVED_BATCH)
    .fetch_all(pool)
    .await
    .context("read the ballots whose vote ended")?;
    if rows.is_empty() {
        return Ok(0);
    }
    let mut candidates = Vec::new();
    for row in rows {
        let key: Vec<u8> = row.try_get("project_key")?;
        let Ok(project_key) = <[u8; 32]>::try_from(key.as_slice()) else {
            continue;
        };
        let Some(ballot_id) = row
            .try_get::<Option<String>, _>("ballot")?
            .and_then(|text| text.parse::<u32>().ok())
        else {
            continue;
        };
        let logs =
            crate::chain_reader::store::project_logs(pool, reader, &project_key, final_block)
                .await?;
        let Some(ledger) = Ledger::from_logs(&logs)? else {
            *skipped += 1;
            continue;
        };
        let Some(ballot) = ledger.vote.newest_ballot() else {
            *skipped += 1;
            continue;
        };
        // A newer ballot opened since, or a result already let go: nothing to tell about this one.
        if ballot.id != ballot_id || ballot.lapsed {
            *skipped += 1;
            continue;
        }
        match moved_outcome(ballot, as_of) {
            Some(true) => {}
            _ => {
                *skipped += 1;
                continue;
            }
        }
        // The block is the newest final one: the alert was made by the pass after `voteEnd`, not by a row that opened the
        // ballot days before it, so its own life and a rollback are right.
        candidates.push(Candidate {
            project_key,
            serial: u64::from(ballot_id),
            kind: Kind::Moved,
            block: final_block,
            block_time: as_of,
        });
    }
    if candidates.is_empty() {
        return Ok(0);
    }
    let mut ready = Vec::with_capacity(candidates.len());
    let mut per_project: BTreeMap<[u8; 32], (Option<String>, Audience)> = BTreeMap::new();
    for candidate in candidates {
        ready.push(
            prepare(
                state,
                community,
                reader,
                reader_config,
                reader_next,
                now,
                candidate,
                &mut per_project,
            )
            .await?,
        );
    }
    let mut tx = pool.begin().await?;
    let mut report = MakeReport::default();
    for item in &ready {
        store_alert(&mut tx, community, reader, item, config, now, &mut report).await?;
    }
    tx.commit().await.context("commit the moved alerts")?;
    Ok(report.made)
}

/// One new alert and its outbox rows in `tx`; a repeated pass inserts nothing (the unique key absorbs it) and makes no
/// rows. Returns whether the alert was new.
async fn store_alert(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    community: CommunityId,
    reader: &str,
    item: &Ready,
    config: &WebPushConfig,
    now: DateTime<Utc>,
    report: &mut MakeReport,
) -> anyhow::Result<bool> {
    let c = &item.candidate;
    let inserted: Option<i64> = sqlx::query_scalar(
        "INSERT INTO web_push_alerts (reader, project_key, serial, kind, block_number, link_ref, audience, cut) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (reader, project_key, serial, kind) DO NOTHING \
         RETURNING id",
    )
    .bind(reader)
    .bind(c.project_key.as_slice())
    .bind(i64::try_from(c.serial).context("serial")?)
    .bind(c.kind.as_str())
    .bind(i64::try_from(c.block).context("block")?)
    .bind(&item.link_ref)
    .bind(i32::try_from(item.audience).unwrap_or(i32::MAX))
    .bind(i32::try_from(item.cut).unwrap_or(i32::MAX))
    .fetch_optional(&mut **tx)
    .await?;
    let Some(alert_id) = inserted else {
        return Ok(false); // made before: a repeated pass or a restart
    };
    report.made += 1;
    write_outbox(tx, community, alert_id, item, config, now, report).await?;
    Ok(true)
}

/// The link, the audience and the devices of one alert, with the per-project reads of `per_project` shared by the
/// alerts of one pass.
#[allow(clippy::too_many_arguments)]
async fn prepare(
    state: &Arc<AppState>,
    community: CommunityId,
    reader: &str,
    reader_config: &crate::chain_reader::ChainReaderConfig,
    reader_next: u64,
    now: DateTime<Utc>,
    candidate: Candidate,
    per_project: &mut BTreeMap<[u8; 32], (Option<String>, Audience)>,
) -> anyhow::Result<Ready> {
    let pool = state.db.pool();
    if let std::collections::btree_map::Entry::Vacant(slot) =
        per_project.entry(candidate.project_key)
    {
        let launched =
            crate::handlers::room_write::launched_of(pool, reader, &candidate.project_key)
                .await
                .context("read the project's launch")?;
        let link = match &launched {
            Some(launch) => {
                link_ref_of(state, community, &candidate.project_key, &launch.project_id)
                    .await
                    .context("find the project's link")?
            }
            None => None,
        };
        let audience = if link.is_some() {
            let excluded = excluded_of(
                pool,
                reader,
                &candidate.project_key,
                &reader_config.launcher,
                reader_next.saturating_sub(1),
            )
            .await?;
            audience_of(state, community, reader, &candidate.project_key, &excluded).await?
        } else {
            Audience::default()
        };
        slot.insert((link, audience));
    }
    let (link, audience) = &per_project[&candidate.project_key];
    let devices = if audience.accounts.is_empty() {
        Vec::new()
    } else {
        let mut tx = pool.begin().await?;
        let found = store::live_subscriptions(
            &mut tx,
            *community.as_uuid(),
            &audience.accounts,
            now,
            20_000,
        )
        .await?;
        tx.rollback().await?;
        found
    };
    Ok(Ready {
        link_ref: link.clone(),
        audience: audience.holders,
        cut: audience.cut,
        devices,
        candidate,
    })
}

/// The outbox rows of one new alert: one for each device, `dropped` at once when a cap holds.
async fn write_outbox(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    community: CommunityId,
    alert_id: i64,
    item: &Ready,
    config: &WebPushConfig,
    now: DateTime<Utc>,
    report: &mut MakeReport,
) -> anyhow::Result<()> {
    let c = &item.candidate;
    let ids: Vec<Uuid> = item.devices.iter().map(|d| d.id).collect();
    let counts = if ids.is_empty() {
        BTreeMap::new()
    } else {
        today_counts(tx, *community.as_uuid(), &ids, &c.project_key, now).await?
    };
    for device in &item.devices {
        let (total, about) = counts.get(&device.id).copied().unwrap_or((0, 0));
        let reason = cap_reason(total, about, config.daily_cap);
        let state = if reason.is_some() {
            "dropped"
        } else {
            "pending"
        };
        let written = sqlx::query(
            "INSERT INTO web_push_outbox \
                 (community_id, alert_id, subscription_id, project_key, state, drop_reason, created_at, \
                  next_attempt_at, done_at) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $7, CASE WHEN $5 = 'dropped' THEN $7 END) \
             ON CONFLICT (community_id, alert_id, subscription_id) DO NOTHING",
        )
        .bind(community.as_uuid())
        .bind(alert_id)
        .bind(device.id)
        .bind(c.project_key.as_slice())
        .bind(state)
        .bind(reason)
        .bind(now)
        .execute(&mut **tx)
        .await?
        .rows_affected();
        if written > 0 {
            if reason.is_some() {
                report.dropped += 1;
            } else {
                report.queued += 1;
            }
        }
    }
    Ok(())
}

/// Look again for the link of the alerts that had none when they were made (the project's record was not found: not
/// stored yet, or hidden among many records that name its key). **A caught failure leaves a durable retry record**: the
/// alert row with no link is that record. Each one still inside the alert's lifetime (a day of the chain's clock) is looked
/// at again, oldest first, at most [`UNLINKED_BATCH`] a pass; when its link is found the alert gets its link, its audience
/// and its outbox rows in one transaction. One that is a day old is left as it is: its terminal state, an alert that
/// reached nobody.
pub async fn retry_unlinked(
    state: &Arc<AppState>,
    config: &WebPushConfig,
    now: DateTime<Utc>,
) -> anyhow::Result<MakeReport> {
    let mut report = MakeReport::default();
    let Some(reader_config) = state.config.chain_reader.as_ref() else {
        return Ok(report);
    };
    let reader = reader_config.reader_id();
    let host = match &reader_config.community_host {
        Some(h) => h.clone(),
        None => crate::tenant::relay_url_authority(&state.config.relay_url),
    };
    let Some(community) = state
        .db
        .lookup_community_by_host(&host)
        .await
        .context("look up the community of the alerts")?
        .map(|record| record.id)
    else {
        return Ok(report);
    };
    let pool = state.db.pool();
    let Some((reader_next, as_of)) = reader_position(pool, &reader).await? else {
        return Ok(report);
    };
    let oldest = i64::try_from(as_of.saturating_sub(ALERT_LIFETIME_SECS)).unwrap_or(0);
    let rows = sqlx::query(
        "SELECT a.id, a.project_key, a.serial, a.kind, a.block_number, b.block_time \
         FROM web_push_alerts a JOIN chain_blocks b ON b.reader = a.reader AND b.number = a.block_number \
         WHERE a.reader = $1 AND a.link_ref IS NULL AND b.block_time >= $2 \
         ORDER BY a.block_number, a.id LIMIT $3",
    )
    .bind(&reader)
    .bind(oldest)
    .bind(UNLINKED_BATCH)
    .fetch_all(pool)
    .await
    .context("read the alerts with no link")?;
    let mut per_project: BTreeMap<[u8; 32], (Option<String>, Audience)> = BTreeMap::new();
    for row in rows {
        let key: Vec<u8> = row.try_get("project_key")?;
        let (Ok(project_key), Some(kind)) = (
            <[u8; 32]>::try_from(key.as_slice()),
            Kind::parse(&row.try_get::<String, _>("kind")?),
        ) else {
            continue;
        };
        let candidate = Candidate {
            project_key,
            serial: u64::try_from(row.try_get::<i64, _>("serial")?).unwrap_or(0),
            kind,
            block: u64::try_from(row.try_get::<i64, _>("block_number")?).unwrap_or(0),
            block_time: u64::try_from(row.try_get::<i64, _>("block_time")?).unwrap_or(0),
        };
        let item = prepare(
            state,
            community,
            &reader,
            reader_config,
            reader_next,
            now,
            candidate,
            &mut per_project,
        )
        .await?;
        if item.link_ref.is_none() {
            continue;
        }
        let id: i64 = row.try_get("id")?;
        let mut tx = pool.begin().await?;
        let updated = sqlx::query(
            "UPDATE web_push_alerts SET link_ref = $2, audience = $3, cut = $4 WHERE id = $1 AND link_ref IS NULL",
        )
        .bind(id)
        .bind(&item.link_ref)
        .bind(i32::try_from(item.audience).unwrap_or(i32::MAX))
        .bind(i32::try_from(item.cut).unwrap_or(i32::MAX))
        .execute(&mut *tx)
        .await?
        .rows_affected();
        if updated > 0 {
            write_outbox(&mut tx, community, id, &item, config, now, &mut report).await?;
            report.linked += 1;
        }
        tx.commit().await.context("commit a linked alert")?;
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One ballot as the tests need it: kind 1 (replace), the given tallies, floor and cast, nothing recorded.
    fn ballot(kind: u8, cast: u128, floor: u128, keep: u128, list: u128) -> BallotSeen {
        BallotSeen {
            id: 3,
            kind,
            opened_at: 1_000,
            stand_end: 1_100,
            vote_end: 1_200,
            effective_at: 1_300,
            supply: 1_000 * ONE_SHARE,
            floor,
            up_a: 0,
            up_b: 0,
            options: std::collections::BTreeMap::new(),
            tallies: std::collections::BTreeMap::from([(0, keep), (1, list)]),
            cast,
            finished: None,
            carried_out_at: None,
            carried_out_council: None,
            lapsed: false,
            lapsed_at: None,
            opened_block_time: 1_000,
        }
    }

    /// A ballot that opens is a `vote` alert (either kind of ballot: a seat election changes who runs the project too),
    /// and the pause's own other events are not.
    #[test]
    fn a_ballot_that_opened_is_a_vote_alert_and_nothing_else_of_the_pause_is() {
        assert_eq!(classify("BallotOpened", None), Some(Kind::Vote));
        for other in [
            "Stood",
            "Voted",
            "Fell",
            "BallotFinished",
            "BallotCarriedOut",
            "BallotLapsed",
            "Parked",
            "Unparked",
            "Observed",
        ] {
            assert_eq!(classify(other, None), None, "{other}");
        }
    }

    /// The `moved` alert is the reader's own derived result, not `BallotFinished`: with no recorded result, a list with
    /// more than half of the cast moves the runner; one that does not, or a ballot under its floor, does not. Before
    /// `voteEnd` there is no result at all.
    #[test]
    fn a_ballot_that_moves_or_seats_is_the_readers_derived_result_without_a_finished_row() {
        assert!(ONE_SHARE > 0);
        // No BallotFinished row: the frozen tallies say moved.
        let moved = ballot(
            1,
            500 * ONE_SHARE,
            334 * ONE_SHARE,
            200 * ONE_SHARE,
            300 * ONE_SHARE,
        );
        assert!(moved.finished.is_none(), "nobody recorded the result");
        assert_eq!(moved_outcome(&moved, moved.vote_end - 1), None);
        assert_eq!(moved_outcome(&moved, moved.vote_end), Some(true));
        // A list that keeps the runner: kept, not moved.
        let kept = ballot(
            1,
            500 * ONE_SHARE,
            334 * ONE_SHARE,
            300 * ONE_SHARE,
            200 * ONE_SHARE,
        );
        assert_eq!(moved_outcome(&kept, kept.vote_end), Some(false));
        // Under the turnout floor: short, moves nobody.
        let short = ballot(1, 100 * ONE_SHARE, 334 * ONE_SHARE, 0, 100 * ONE_SHARE);
        assert_eq!(moved_outcome(&short, short.vote_end), Some(false));
        // A seat election with a person over the whole Share and over "keep": seated.
        let seated = ballot(
            2,
            500 * ONE_SHARE,
            334 * ONE_SHARE,
            100 * ONE_SHARE,
            200 * ONE_SHARE,
        );
        assert_eq!(moved_outcome(&seated, seated.vote_end), Some(true));
        // A recorded result is used word for word.
        let mut recorded = kept.clone();
        recorded.finished = Some(crate::chain_reader::ledger_council::Finished {
            outcome: 3,
            winner: 1,
            winner_b: 0,
            cast_total: kept.cast,
        });
        assert_eq!(moved_outcome(&recorded, recorded.vote_end), Some(true));
    }

    /// At most one `vote` push for a project in one time unit: a second ballot in the same unit is dropped, the first
    /// after it is kept (COUNCIL-PLAN.md section 5.6).
    #[test]
    fn at_most_one_vote_push_is_kept_for_a_project_within_one_unit() {
        assert!(!within_one_unit(None, 1_000, 240));
        assert!(within_one_unit(Some(1_000), 1_239, 240));
        assert!(within_one_unit(Some(1_000), 1_000, 240));
        assert!(!within_one_unit(Some(1_000), 1_240, 240));
        assert!(within_one_unit(Some(1_000), 1_239, 600));
        assert!(!within_one_unit(Some(1_000), 1_240, 60));
        // A clock behind the stored one is never "after the unit": it is kept, not dropped for good.
        assert!(!within_one_unit(Some(1_000), 900, 240));
    }

    #[test]
    fn a_task_row_makes_one_of_three_kinds_and_a_withdrawn_plan_makes_none() {
        assert_eq!(classify("TaskAnnounced", None), Some(Kind::Planned));
        assert_eq!(classify("TaskTaken", None), Some(Kind::Taken));
        for ended in [3, 4, 5, 7] {
            assert_eq!(
                classify("TaskResolved", Some(ended)),
                Some(Kind::Ended),
                "state {ended}"
            );
        }
        assert_eq!(
            classify("TaskResolved", Some(6)),
            None,
            "a withdrawn plan moved nothing"
        );
        assert_eq!(classify("Transfer", None), None);
        assert_eq!(classify("CheckedIn", None), None);
    }

    #[test]
    fn a_row_older_than_the_alerts_own_lifetime_is_too_old() {
        assert!(!is_too_old(1_000, 1_000 + ALERT_LIFETIME_SECS));
        assert!(is_too_old(1_000, 1_001 + ALERT_LIFETIME_SECS));
        assert!(
            !is_too_old(5_000, 1_000),
            "a row after the chain's newest block is never old"
        );
    }

    #[test]
    fn the_cursor_moves_past_a_whole_batch_and_to_the_first_unread_block_of_a_cut_one() {
        // Not cut: everything up to the reader's next block was read.
        assert_eq!(next_cursor(10, &[11, 12, 12], 5, 40), 40);
        assert_eq!(next_cursor(10, &[], 5, 40), 40);
        // Cut after two rows: the third row's block is where to start next (it is read again if it was shared).
        assert_eq!(next_cursor(10, &[11, 12, 13], 2, 40), 13);
        assert_eq!(next_cursor(10, &[11, 12, 12], 2, 40), 12);
        // Always forward, never past the reader.
        assert_eq!(next_cursor(10, &[10, 10, 10], 2, 40), 11);
        assert_eq!(next_cursor(10, &[39, 39, 39], 2, 12), 12);
    }

    #[test]
    fn a_batch_that_one_block_fills_is_read_whole_and_no_other_is() {
        // 2 asked for, 3 came back, all in block 12: read block 12 on its own.
        assert_eq!(oversized_block(&[12, 12, 12], 2), Some(12));
        // The first unread row is in a later block than the first row: the cursor goes there, nothing is skipped.
        assert_eq!(oversized_block(&[11, 12, 12], 2), None);
        assert_eq!(oversized_block(&[12, 12, 13], 2), None);
        // Not cut, or nothing read.
        assert_eq!(oversized_block(&[12, 12], 2), None);
        assert_eq!(oversized_block(&[], 2), None);
    }

    #[test]
    fn the_daily_cap_and_the_project_cap_say_which_one_held() {
        assert_eq!(cap_reason(0, 0, 6), None);
        assert_eq!(cap_reason(5, 2, 6), None);
        assert_eq!(cap_reason(6, 0, 6), Some("daily_cap"));
        assert_eq!(cap_reason(2, 3, 6), Some("project_cap"));
        assert_eq!(
            cap_reason(6, 3, 6),
            Some("daily_cap"),
            "the daily cap is named first"
        );
        assert_eq!(cap_reason(0, 0, 1), None);
        assert_eq!(cap_reason(1, 0, 1), Some("daily_cap"));
    }

    #[test]
    fn the_day_starts_at_midnight_utc() {
        let at: DateTime<Utc> = "2026-11-20T15:26:15Z".parse().expect("time");
        let start: DateTime<Utc> = "2026-11-20T00:00:00Z".parse().expect("time");
        assert_eq!(day_start(at), start);
        assert_eq!(day_start(start), start);
    }
}
