//! The ranking index: one small record the server signs, so Home reads one record and then the few projects
//! it names (`docs/next-version/STEP3-PLAN.md` section 2.8).
//!
//! Home does not work the ranking out from the records it reads for browsing: that read is ordered by when a
//! founder last edited a record, so an old project whose money has stayed longest could fall out of it, a
//! founder could edit to stay in, and sixty junk records could push everyone else out. The index is built from
//! **every launched project** the reader signed a record for, ranked by the money that stayed (valued at what a
//! take-out would give now), and tied to each project's coordinate: a project is listed only when
//! `ProjectLaunched.projectId` equals the hash of a stored project record's coordinate, so a founder cannot
//! claim another project's key and nobody's word decides who is listed.
//!
//! It carries no name, no address and no per-person figure, and no price: the rule reads `held.rank.money`
//! (money held, valued at `value.leaveValue`), then the number of different accounts, then age, then the key.
//! Never the pot, never the price of a Share, never joins, never volume, never anything in the feed.
//!
//! [`explore_of`] is pure: rows in, the sorted and capped index out. [`build`] reads the rows, the project
//! records and each listed project's standing; [`publish`] signs it, only when the entries changed.

use std::collections::BTreeMap;

use anyhow::Context;
use buzz_core::kind::{KIND_LAUNCH_RECORD, KIND_PROJECT_NUMBERS};
use buzz_core::tenant::TenantContext;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{PgPool, Row as _};

use super::numbers::AsOf;
use super::store::RankingColumns;
use super::word::{hex0x, parse_fixed, Word};
use crate::state::AppState;

/// The most entries of the index (about 4 KB).
pub const MAX_ENTRIES: usize = 20;
/// How many of the community's newest project records are read to tie a project to its coordinate.
pub const RECORDS_READ: i64 = 5_000;
/// How many ranking rows are read before the cap (the best ones first).
pub const ROWS_READ: i64 = 500;
/// How many listed candidates are looked at for their standing before the build gives up the rest.
pub const STANDING_CHECKS: usize = 100;
/// The index is looked at no oftener than this many seconds.
pub const EVERY_SECS: u64 = 600;
/// The index's own version.
pub const VERSION: u32 = 1;
/// The `d` tag of the index.
pub const D_TAG: &str = "explore";

/// The ranking columns of one launched project, with the coordinate its record has.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Row {
    /// The project's chain key, `0x` and 64 hex.
    pub key: String,
    /// The project record's coordinate, `37001:<founder>:<id>`.
    pub coordinate: String,
    /// When it launched.
    pub launched_at: u64,
    /// The ranking window, in seconds.
    pub window_secs: u64,
    /// The money that stayed, valued at a take-out, 6 decimals.
    pub money: u128,
    /// The accounts that hold it.
    pub accounts: u64,
    /// The badge's verdict, when there is one.
    pub reached: Option<bool>,
}

/// One entry of the index.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Entry {
    /// The project's chain key.
    pub key: String,
    /// The project record's coordinate.
    pub a: String,
    /// When it launched.
    pub launched_at: u64,
    /// The ranking window, in seconds.
    pub window_secs: u64,
    /// The money that stayed, 6 decimals.
    pub money: String,
    /// The accounts that hold it.
    pub accounts: u64,
    /// The badge's verdict, `null` when the record had none.
    pub reached: Option<bool>,
}

/// The block and time the index is for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AsOfRec {
    /// The block.
    pub block: u64,
    /// Its time.
    pub time: u64,
}

/// The signed content of the index.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Index {
    /// Always [`VERSION`].
    pub version: u32,
    /// Always `"explore"`.
    pub kind: String,
    /// What it was built at.
    pub as_of: AsOfRec,
    /// The first [`MAX_ENTRIES`] of the ranking.
    pub entries: Vec<Entry>,
    /// How many projects could be listed.
    pub seen: u64,
    /// How many of those were left out of the entries.
    pub cut: u64,
}

/// The ranking rule: money (most first), then accounts (most first), then older, then the key.
fn order(a: &Row, b: &Row) -> std::cmp::Ordering {
    b.money
        .cmp(&a.money)
        .then(b.accounts.cmp(&a.accounts))
        .then(a.launched_at.cmp(&b.launched_at))
        .then(a.key.cmp(&b.key))
}

/// The rows in ranking order, those with no money left out.
pub fn ranked(mut rows: Vec<Row>) -> Vec<Row> {
    rows.retain(|r| r.money > 0);
    rows.sort_by(order);
    rows
}

/// The index of `rows`: ranked, at most [`MAX_ENTRIES`], with how many there were and how many were left out.
/// A project with no money that stayed is not listed.
pub fn explore_of(rows: Vec<Row>, as_of: AsOfRec) -> Index {
    let rows = ranked(rows);
    let seen = rows.len() as u64;
    let entries: Vec<Entry> = rows
        .into_iter()
        .take(MAX_ENTRIES)
        .map(|r| Entry {
            key: r.key,
            a: r.coordinate,
            launched_at: r.launched_at,
            window_secs: r.window_secs,
            money: r.money.to_string(),
            accounts: r.accounts,
            reached: r.reached,
        })
        .collect();
    Index {
        version: VERSION,
        kind: D_TAG.to_owned(),
        as_of,
        cut: seen - entries.len() as u64,
        entries,
        seen,
    }
}

/// What a signed record said about the money that stayed, for the columns beside it: all `None` when the
/// record has no ranking row.
pub fn columns_of(content: &Value) -> RankingColumns {
    let rank = &content["held"]["rank"];
    let amount = |v: &Value| v.as_str().and_then(|s| s.parse::<u128>().ok());
    let Some(money) = amount(&rank["money"]) else {
        return RankingColumns::default();
    };
    RankingColumns {
        money: Some(money),
        accounts: rank["accounts"].as_u64(),
        window_secs: content["held"]["windows"]["rankSecs"].as_u64(),
        reached: content["established"]["reached"].as_bool(),
        launched_at: content["launchedAt"].as_u64(),
    }
}

/// A ranking row as the table has it, before its coordinate is known.
pub(crate) struct Stored {
    pub(crate) key: Word,
    pub(crate) money: u128,
    pub(crate) accounts: u64,
    pub(crate) window_secs: u64,
    pub(crate) reached: Option<bool>,
    pub(crate) launched_at: u64,
}

/// The best [`ROWS_READ`] rows of this reader's table: only records that are not stale and have money that
/// stayed. Ranking order, so the cap keeps the best.
pub(crate) async fn stored_rows(pool: &PgPool, reader: &str) -> anyhow::Result<Vec<Stored>> {
    let rows = sqlx::query(
        "SELECT project_key, rank_money::text AS money, rank_accounts, rank_window_secs, reached, launched_at \
         FROM chain_project_numbers \
         WHERE reader = $1 AND NOT stale AND rank_money > 0 \
           AND rank_accounts IS NOT NULL AND rank_window_secs IS NOT NULL AND launched_at IS NOT NULL \
         ORDER BY rank_money DESC, rank_accounts DESC, launched_at ASC, project_key ASC LIMIT $2",
    )
    .bind(reader)
    .bind(ROWS_READ)
    .fetch_all(pool)
    .await
    .context("read the ranking rows")?;
    rows.into_iter()
        .map(|r| {
            let key: Vec<u8> = r.try_get("project_key")?;
            let money: String = r.try_get("money")?;
            Ok(Stored {
                key: key
                    .try_into()
                    .map_err(|_| anyhow::anyhow!("a stored key is not 32 bytes"))?,
                money: money.parse().context("a stored ranking money")?,
                accounts: u64::try_from(r.try_get::<i32, _>("rank_accounts")?)?,
                window_secs: u64::try_from(r.try_get::<i64, _>("rank_window_secs")?)?,
                reached: r.try_get("reached")?,
                launched_at: u64::try_from(r.try_get::<i64, _>("launched_at")?)?,
            })
        })
        .collect()
}

/// The `projectId` the launch of each key named (lower case), from the reader's own rows.
async fn launched_ids(
    pool: &PgPool,
    reader: &str,
    keys: &[Word],
) -> anyhow::Result<BTreeMap<Word, String>> {
    let wanted: Vec<Vec<u8>> = keys.iter().map(|k| k.to_vec()).collect();
    let rows: Vec<(Vec<u8>, Option<String>)> = sqlx::query_as(
        "SELECT project_key, lower(decoded->>'projectId') FROM chain_logs \
         WHERE reader = $1 AND role = 'launcher' AND event = 'ProjectLaunched' AND project_key = ANY($2)",
    )
    .bind(reader)
    .bind(&wanted)
    .fetch_all(pool)
    .await
    .context("read the launches")?;
    let mut out = BTreeMap::new();
    for (key, id) in rows {
        if let (Ok(key), Some(id)) = (Word::try_from(key), id) {
            out.insert(key, id);
        }
    }
    Ok(out)
}

/// A project record's coordinate and the chain key it names, when it is listed.
pub fn claim_of(event: &nostr::Event) -> Option<(String, Word)> {
    let d = event.tags.iter().find_map(|t| match t.as_slice() {
        [name, value, ..] if name == "d" => Some(value.clone()),
        _ => None,
    })?;
    let key = event.tags.iter().find_map(|t| match t.as_slice() {
        [name, value, ..] if name == "chain-key" => parse_fixed::<32>(value),
        _ => None,
    })?;
    let body: Value = serde_json::from_str(&event.content).unwrap_or_default();
    if body.get("listing").and_then(Value::as_str) == Some("unlisted") {
        return None;
    }
    Some((
        format!("{KIND_LAUNCH_RECORD}:{}:{d}", event.pubkey.to_hex()),
        key,
    ))
}

/// Tie the rows to coordinates: a row is kept, with its coordinate, only when some stored project record that
/// names its key has a coordinate whose hash is the `projectId` its launch named. `claims` are the records'
/// `(coordinate, key)`; `ids` the launches' project ids by key. Pure.
pub(crate) fn tie(
    stored: Vec<Stored>,
    claims: &[(String, Word)],
    ids: &BTreeMap<Word, String>,
    id_of: impl Fn(&str) -> String,
) -> Vec<Row> {
    let mut out = Vec::new();
    for s in stored {
        let Some(want) = ids.get(&s.key) else {
            continue;
        };
        let coordinate = claims
            .iter()
            .filter(|(_, key)| *key == s.key)
            .map(|(c, _)| c)
            .find(|c| id_of(c.as_str()).eq_ignore_ascii_case(want));
        if let Some(coordinate) = coordinate {
            out.push(Row {
                key: hex0x(&s.key),
                coordinate: coordinate.clone(),
                launched_at: s.launched_at,
                window_secs: s.window_secs,
                money: s.money,
                accounts: s.accounts,
                reached: s.reached,
            });
        }
    }
    out
}

/// Build the index: the ranking rows tied to their coordinates and held to the standing every public project
/// has (listed, not removed, a founder who is neither banned nor muted). A failed read is an error, never an
/// empty index.
pub async fn build(
    state: &AppState,
    tenant: &TenantContext,
    reader: &str,
    as_of: &AsOf,
) -> anyhow::Result<Index> {
    #[cfg(test)]
    if FAIL_BUILD.with(std::cell::Cell::get) {
        anyhow::bail!("a build that fails (a test)");
    }
    let pool = state.db.pool();
    let stored = stored_rows(pool, reader).await?;
    let as_of = AsOfRec {
        block: as_of.block,
        time: as_of.time,
    };
    if stored.is_empty() {
        return Ok(explore_of(Vec::new(), as_of));
    }
    let keys: Vec<Word> = stored.iter().map(|s| s.key).collect();
    let ids = launched_ids(pool, reader, &keys).await?;
    let records = state
        .db
        .query_events(&buzz_db::EventQuery {
            kinds: Some(vec![KIND_LAUNCH_RECORD as i32]),
            global_only: true,
            limit: Some(RECORDS_READ),
            max_limit: Some(RECORDS_READ),
            ..buzz_db::EventQuery::for_community(tenant.community())
        })
        .await
        .context("read the project records")?;
    let claims: Vec<(String, Word)> = records.iter().filter_map(|r| claim_of(&r.event)).collect();
    let tied = tie(stored, &claims, &ids, crate::api::manager::cost::project_id);
    // The best first; a project's standing is asked until the index is full.
    let mut kept = Vec::new();
    let ordered = ranked(tied);
    let seen = ordered.len() as u64;
    for row in ordered.into_iter().take(STANDING_CHECKS) {
        if kept.len() >= MAX_ENTRIES {
            break;
        }
        let Some(event) = records
            .iter()
            .find(|r| claim_of(&r.event).is_some_and(|(c, _)| c == row.coordinate))
        else {
            continue;
        };
        let standing =
            crate::share_preview::public_standing(state, tenant.community(), event.event.clone())
                .await
                .context("read a project's standing")?;
        if standing.is_some() {
            kept.push(row);
        }
    }
    let mut index = explore_of(kept, as_of);
    // `seen` counts the projects that could be listed (they passed the tie); `cut` those left out.
    index.seen = seen.max(index.entries.len() as u64);
    index.cut = index.seen - index.entries.len() as u64;
    Ok(index)
}

/// The entries of the index that is live now, if any: what [`publish`] compares with.
async fn live_entries(
    state: &AppState,
    tenant: &TenantContext,
) -> anyhow::Result<Option<(Vec<Entry>, i64)>> {
    let relay = state.relay_keypair.public_key().to_bytes().to_vec();
    let rows = state
        .db
        .query_events(&buzz_db::EventQuery {
            kinds: Some(vec![KIND_PROJECT_NUMBERS as i32]),
            pubkey: Some(relay),
            d_tag: Some(D_TAG.to_owned()),
            global_only: true,
            limit: Some(1),
            ..buzz_db::EventQuery::for_community(tenant.community())
        })
        .await
        .context("read the live ranking index")?;
    Ok(rows.into_iter().next().and_then(|stored| {
        let index: Index = serde_json::from_str(&stored.event.content).ok()?;
        Some((
            index.entries,
            i64::try_from(stored.event.created_at.as_secs()).ok()?,
        ))
    }))
}

/// Sign and store `index` as the relay, **only when its entries differ from the live index's** and the live
/// one is at least [`EVERY_SECS`] old. Returns whether a record was signed. A failure leaves the old index.
pub async fn publish(
    state: &std::sync::Arc<AppState>,
    tenant: &TenantContext,
    chain_id: u64,
    launcher: &[u8; 20],
    index: &Index,
    now: i64,
) -> anyhow::Result<bool> {
    let live = live_entries(state, tenant).await?;
    let mut created_at = now;
    match &live {
        Some((entries, at)) => {
            if *entries == index.entries {
                return Ok(false);
            }
            if now - at < i64::try_from(EVERY_SECS).unwrap_or(i64::MAX) {
                return Ok(false);
            }
            created_at = created_at.max(at + 1);
        }
        // Nothing to say and nothing said before: no record.
        None if index.entries.is_empty() => return Ok(false),
        None => {}
    }
    let content = json!(index);
    let tags = super::publish::tags(D_TAG, chain_id, &hex0x(launcher))?;
    match super::publish::publish(
        state,
        tenant,
        tags,
        D_TAG,
        &content,
        u64::try_from(created_at).context("time before 1970")?,
    )
    .await?
    {
        super::publish::Outcome::Stored(_) => Ok(true),
        super::publish::Outcome::Superseded(at) => {
            anyhow::bail!("a newer ranking index is stored (at {at}); not replaced")
        }
    }
}

#[cfg(test)]
thread_local! {
    /// Makes [`build`] fail on this thread (a test of what a failed build leaves).
    pub(super) static FAIL_BUILD: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

#[cfg(test)]
#[path = "explore_postgres_tests.rs"]
mod postgres_tests;
#[cfg(test)]
#[path = "explore_tests.rs"]
mod tests;
