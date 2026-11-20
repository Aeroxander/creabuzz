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

/// Each holding account's lowest balance over the window, from the balances now. `balances` are the accounts'
/// balances at the final block; `excluded` are the accounts nobody holds for (the zero address, the
/// contracts, the Launcher). An account with no move in the window held its balance the whole time.
///
/// An account whose moves do not fit its balance (a start balance below zero, or a lowest balance above what
/// it holds now) means the stored rows disagree with each other: that is an error, never a number.
pub fn lowest<'a>(
    raw: &BTreeMap<String, Run>,
    balances: impl Iterator<Item = (&'a String, &'a u128)>,
    excluded: &BTreeSet<String>,
) -> anyhow::Result<Held> {
    let mut held = Held::default();
    for (account, balance) in balances {
        if excluded.contains(account) || *balance == 0 {
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
/// block's time: a change counts when its block is later), `$5` the most rows read, `$6` the most accounts.
///
/// `first` finds the first block inside the window through `idx_chain_blocks_time`; `win` reads this
/// project's change rows from that block on through `idx_chain_balance_changes_block`, in `(block, log_index)`
/// order, with the `LIMIT` before the running sum; the outer query makes one row per account.
pub(crate) const WINDOW_SQL: &str = "\
WITH first AS (SELECT min(number) AS n FROM chain_blocks WHERE reader = $1 AND block_time > $4), \
win AS (SELECT c.account, c.block_number, c.log_index, c.delta \
        FROM chain_balance_changes c, first \
        WHERE c.reader = $1 AND c.project_key = $2 AND c.token = 'shares' \
          AND c.block_number >= first.n AND c.block_number <= $3 \
        ORDER BY c.block_number, c.log_index LIMIT $5 + 1) \
SELECT account, sum(delta)::text AS total, min(cum)::text AS lowest_run, max(rows_read) AS rows_read \
FROM (SELECT account, delta, \
             sum(delta) OVER (PARTITION BY account ORDER BY block_number, log_index) AS cum, \
             count(*) OVER () AS rows_read FROM win) r \
GROUP BY account LIMIT $6 + 1";

/// Count one window of one project in the database: see [`WINDOW_SQL`]. A database error is an `Err`, never
/// a cut and never an empty window.
pub async fn held_input(
    pool: &PgPool,
    reader: &str,
    key: &Word,
    final_block: u64,
    window_start: u64,
    limits: Limits,
) -> anyhow::Result<WindowRaw> {
    let to_i64 =
        |v: u64, what: &str| i64::try_from(v).with_context(|| format!("{what} is too large"));
    let rows: Vec<(Vec<u8>, String, String, i64)> = sqlx::query_as(WINDOW_SQL)
        .bind(reader)
        .bind(key.as_slice())
        .bind(to_i64(final_block, "the final block")?)
        .bind(to_i64(window_start, "the window's start")?)
        .bind(i64::try_from(limits.rows_max).context("the row cap")?)
        .bind(i64::try_from(limits.accounts_max).context("the account cap")?)
        .fetch_all(pool)
        .await
        .context("count the held Shares of a window")?;
    let mut out = BTreeMap::new();
    for (account, total, lowest_run, rows_read) in rows {
        if usize::try_from(rows_read).is_ok_and(|read| read > limits.rows_max) {
            return Ok(WindowRaw::Cut);
        }
        let parse = |text: &str, what: &str| {
            text.parse::<i128>()
                .with_context(|| format!("a stored {what} is not a number: {text}"))
        };
        out.insert(
            hex0x(&account),
            Run {
                total: parse(&total, "sum")?,
                lowest_run: parse(&lowest_run, "running sum")?,
            },
        );
    }
    if out.len() > limits.accounts_max {
        return Ok(WindowRaw::Cut);
    }
    Ok(WindowRaw::Counted(out))
}
