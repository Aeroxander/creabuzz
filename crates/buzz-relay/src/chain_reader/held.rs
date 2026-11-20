//! How long money has stayed: the lowest balance each account had at any moment of a window
//! (`docs/next-version/STEP3-PLAN.md` section 2.2).
//!
//! Two pieces, so the rule can be tested without a database:
//!
//! - [`held_input`] asks Postgres, once per window, for each account's moves inside the window as two
//!   numbers: their sum and the lowest point of their running sum. The rows are read through an index range
//!   starting at the window's first block with the `LIMIT` **inside** the read, before the running sum, so
//!   a project with a million changes is read for at most `rows_max + 1` of them. A window over either cap
//!   is [`WindowRaw::Cut`]: the caller then publishes nothing for that window, never a smaller number.
//!   Accounts that hold **less than a floor** now (the least that counts as an account, see
//!   [`super::record_social::dust_floor`]) are not counted: they are left out of the accounts cap and of the
//!   result, and [`lowest_above`] leaves them out of the sums. Without that, anyone holding a few Shares could
//!   send one wei to 20,001 fresh addresses and cut a rival's window for a month.
//! - [`lowest`] is pure: from those numbers and the balances now it gives each holding account's lowest
//!   balance over the window. An account's balance at the window's start is its balance now less the sum of
//!   its moves inside the window, and the running sum steps through `(block, log_index)`, so a dip inside
//!   one block counts.
//!
//! [`walk`] is the same count done in memory over a list of changes. It is what the Postgres tests hold the
//! query against, and what the record tests use over the fixture's rows.

use std::collections::{BTreeMap, BTreeSet};

use anyhow::{bail, Context};
use sqlx::PgPool;

use super::word::{hex0x, Word};

/// The most change rows one window query reads before the window is called too big. A project with more
/// moves than this inside the window gets no figure for it (`null`), never a smaller one.
pub const HELD_ROWS_MAX: usize = 500_000;
/// The most accounts that moved inside one window before it is called too big.
pub const HELD_ACCOUNTS_MAX: usize = 20_000;

/// The two cuts of a window query.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limits {
    /// The most change rows read.
    pub rows_max: usize,
    /// The most accounts that moved.
    pub accounts_max: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            rows_max: HELD_ROWS_MAX,
            accounts_max: HELD_ACCOUNTS_MAX,
        }
    }
}

/// What one account did inside the window: the sum of its moves and the lowest value its running sum
/// reached after any one of them (the start, zero, is not one of the points: [`lowest`] adds it).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Run {
    /// The sum of the account's moves in the window.
    pub total: i128,
    /// The lowest value of the running sum after any one of them.
    pub lowest_run: i128,
}

/// What a window's query found.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WindowRaw {
    /// Every account that moved, by lower-case `0x` address.
    Counted(BTreeMap<String, Run>),
    /// Over a cap: no figure for this window.
    Cut,
}

/// One balance change (a transfer's side) of an account.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Change {
    /// The block.
    pub block: u64,
    /// The log's place in it.
    pub log_index: u32,
    /// The account, lower-case `0x` address.
    pub account: String,
    /// The signed change.
    pub delta: i128,
}

/// The lowest balance of each account that holds now, over a window.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Held {
    /// The sum of the lowest balances.
    pub shares: u128,
    /// Each holding account's lowest balance (no address: the record never carries a per-account figure),
    /// largest first, leaving out accounts whose lowest balance is zero.
    pub lowest: Vec<u128>,
}

/// A window, counted or cut.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Window {
    /// Counted.
    Counted(Held),
    /// Too big to count.
    Cut,
}

/// The window's changes counted in memory: `changes` are those inside the window, oldest first.
pub fn walk(changes: &[Change], limits: Limits) -> WindowRaw {
    if changes.len() > limits.rows_max {
        return WindowRaw::Cut;
    }
    let mut running: BTreeMap<&str, Run> = BTreeMap::new();
    for c in changes {
        let run = running.entry(c.account.as_str()).or_insert(Run {
            total: 0,
            lowest_run: i128::MAX,
        });
        run.total += c.delta;
        run.lowest_run = run.lowest_run.min(run.total);
    }
    if running.len() > limits.accounts_max {
        return WindowRaw::Cut;
    }
    WindowRaw::Counted(
        running
            .into_iter()
            .map(|(a, r)| (a.to_owned(), r))
            .collect(),
    )
}

/// [`lowest_above`] with no floor: every holding account counts.
pub fn lowest<'a>(
    raw: &BTreeMap<String, Run>,
    balances: impl Iterator<Item = (&'a String, &'a u128)>,
    excluded: &BTreeSet<String>,
) -> anyhow::Result<Held> {
    lowest_above(raw, balances, excluded, 0)
}

/// Each holding account's lowest balance over the window, from the balances now. `balances` are the accounts'
/// balances at the final block; `excluded` are the accounts nobody holds for (the zero address, the
/// contracts, the Launcher); an account holding less than `floor` is left out (the query did not return its
/// moves). An account with no move in the window held its balance the whole time.
///
/// An account whose moves do not fit its balance (a start balance below zero, or a lowest balance above what
/// it holds now) means the stored rows disagree with each other: that is an error, never a number.
pub fn lowest_above<'a>(
    raw: &BTreeMap<String, Run>,
    balances: impl Iterator<Item = (&'a String, &'a u128)>,
    excluded: &BTreeSet<String>,
    floor: u128,
) -> anyhow::Result<Held> {
    let mut held = Held::default();
    for (account, balance) in balances {
        if excluded.contains(account) || *balance == 0 || *balance < floor {
            continue;
        }
        let now = i128::try_from(*balance).context("a balance is too large")?;
        let low = match raw.get(account) {
            None => now,
            Some(run) => now - run.total + run.lowest_run.min(0),
        };
        if low < 0 || low > now {
            bail!(
                "{account}: its balance now is {now} but its moves in the window add up to {} and dip to {}",
                raw[account].total,
                raw[account].lowest_run
            );
        }
        if low > 0 {
            let low = u128::try_from(low).context("a lowest balance")?;
            held.shares = held
                .shares
                .checked_add(low)
                .context("the held Shares overflow")?;
            held.lowest.push(low);
        }
    }
    held.lowest.sort_unstable_by(|a, b| b.cmp(a));
    Ok(held)
}

/// The window's query. `$1` reader, `$2` project key, `$3` the final block, `$4` the window's start (a
/// block's time: a change counts when its block is later), `$5` the most rows read, `$6` the most accounts,
/// `$7` the floor: an account that holds less than this at the final block is not returned (`0`: every account
/// is).
///
/// The window's first block is found in one step of `idx_chain_blocks_time` (a scalar subquery, evaluated
/// once, so the planner does not turn it into a join that must be sorted). The project's change rows are then
/// read from that block on through `idx_chain_balance_changes_block`, which holds the whole sort key
/// `(block, log_index)`: they come out in order, so the `LIMIT`, placed before the running sum, stops the scan
/// after `rows_max + 1` rows and no row beyond is read to be sorted. The first part makes one row per account
/// that holds the floor (its balance is the sum of its changes up to the final block); the last row, whose
/// account is `NULL`, says how many rows were read, so a window over the row cap is seen even when every account
/// in it is below the floor.
pub(crate) const WINDOW_SQL: &str = "\
WITH win AS (SELECT c.account, c.block_number, c.log_index, c.delta \
        FROM chain_balance_changes c \
        WHERE c.reader = $1 AND c.project_key = $2 AND c.token = 'shares' \
          AND c.block_number >= (SELECT b.number FROM chain_blocks b \
                                  WHERE b.reader = $1 AND b.block_time > $4 \
                                  ORDER BY b.block_time, b.number LIMIT 1) \
          AND c.block_number <= $3 \
        ORDER BY c.block_number, c.log_index LIMIT $5 + 1), \
runs AS (SELECT account, delta, \
                sum(delta) OVER (PARTITION BY account ORDER BY block_number, log_index) AS cum, \
                count(*) OVER () AS rows_read FROM win) \
(SELECT r.account, sum(r.delta)::text AS total, min(r.cum)::text AS lowest_run, NULL::bigint AS rows_read \
   FROM runs r GROUP BY r.account \
   HAVING $7::numeric = 0 \
       OR (SELECT sum(h.delta) FROM chain_balance_changes h \
            WHERE h.reader = $1 AND h.project_key = $2 AND h.token = 'shares' \
              AND h.account = r.account AND h.block_number <= $3) >= $7::numeric \
   LIMIT $6 + 1) \
UNION ALL \
(SELECT NULL::bytea, NULL::text, NULL::text, max(rows_read) FROM runs)";

/// Count one window of one project in the database, every account counted: see [`held_input_above`].
pub async fn held_input(
    pool: &PgPool,
    reader: &str,
    key: &Word,
    final_block: u64,
    window_start: u64,
    limits: Limits,
) -> anyhow::Result<WindowRaw> {
    held_input_above(pool, reader, key, final_block, window_start, limits, 0).await
}

/// Count one window of one project in the database: see [`WINDOW_SQL`]. Accounts holding less than `floor` at
/// `final_block` are not counted (neither in the accounts cap nor in the result). A database error is an `Err`,
/// never a cut and never an empty window.
pub async fn held_input_above(
    pool: &PgPool,
    reader: &str,
    key: &Word,
    final_block: u64,
    window_start: u64,
    limits: Limits,
    floor: u128,
) -> anyhow::Result<WindowRaw> {
    let to_i64 =
        |v: u64, what: &str| i64::try_from(v).with_context(|| format!("{what} is too large"));
    #[allow(clippy::type_complexity)]
    let rows: Vec<(Option<Vec<u8>>, Option<String>, Option<String>, Option<i64>)> =
        sqlx::query_as(WINDOW_SQL)
            .bind(reader)
            .bind(key.as_slice())
            .bind(to_i64(final_block, "the final block")?)
            .bind(to_i64(window_start, "the window's start")?)
            .bind(i64::try_from(limits.rows_max).context("the row cap")?)
            .bind(i64::try_from(limits.accounts_max).context("the account cap")?)
            .bind(floor.to_string())
            .fetch_all(pool)
            .await
            .context("count the held Shares of a window")?;
    let mut out = BTreeMap::new();
    for (account, total, lowest_run, rows_read) in rows {
        let Some(account) = account else {
            // The last row: how many rows the window held.
            if rows_read
                .is_some_and(|read| usize::try_from(read).is_ok_and(|read| read > limits.rows_max))
            {
                return Ok(WindowRaw::Cut);
            }
            continue;
        };
        let parse = |text: Option<String>, what: &str| {
            let text = text.with_context(|| format!("a stored {what} is missing"))?;
            text.parse::<i128>()
                .with_context(|| format!("a stored {what} is not a number: {text}"))
        };
        out.insert(
            hex0x(&account),
            Run {
                total: parse(total, "sum")?,
                lowest_run: parse(lowest_run, "running sum")?,
            },
        );
    }
    if out.len() > limits.accounts_max {
        return Ok(WindowRaw::Cut);
    }
    Ok(WindowRaw::Counted(out))
}
