//! The four social keys of the project numbers record: `held`, `feed`, `streaks` and `established`
//! (`docs/next-version/RECORD-V2.md` section 11; the plan is `docs/next-version/STEP3-PLAN.md` section 2).
//!
//! They are display only: no screen unlocks a power from them, and no money rule reads them. Each is the
//! server's own count from the chain's logs and is **either right or `null`**: a key whose input could not be
//! counted (a database error, a window over its cap) or whose own checks failed is signed as `null`, "not known
//! here", never as zero or as a smaller number, and the rest of the record is signed as usual.
//!
//! No address and no per-account figure is in any of them: counts, sums rounded to the nearest 100 dollars, and
//! shares of the whole.
//!
//! Everything here is pure: rows go in, values come out.

use std::collections::BTreeSet;

use anyhow::{anyhow, bail, Context};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::events::Role;
use super::held::{Held, Window};
use super::ledger::LogRow;
use super::record::{amount, mul_div, Record, RunnerRec};
use super::record_tasks::MAX_JSON_SERIAL;

/// The ranking window, in days of the project's unit (a day is `unit / 7` seconds).
pub const RANK_DAYS: u64 = 30;
/// The badge window, in time units (the design's 13N).
pub const BADGE_UNITS: u64 = 13;
/// The share of the money that must have stayed for the badge window, in basis points (the design's 60%).
pub const ESTABLISHED_MIN_HELD_BPS: u64 = 6_000;
/// The accounts that must hold for the badge (the design's 10).
pub const ESTABLISHED_MIN_ACCOUNTS: u64 = 10;
/// The hour buckets of the feed.
pub const FEED_HOURS: usize = 48;
/// The most items of the feed.
pub const FEED_ITEMS: usize = 30;
/// How far back the feed's items look, in days of the project's unit.
pub const FEED_WINDOW_DAYS: u64 = 28;
/// The rounding step of the feed's net money, in whole dollars.
pub const FEED_ROUND_DOLLARS: u64 = 100;
/// Hours in a time unit of seven days: a bucket is `unit / 168` seconds.
const HOURS_PER_UNIT: u64 = 168;
/// One Share, in the token's smallest units.
const ONE_SHARE: u128 = 1_000_000_000_000_000_000;
/// The dollar's smallest units in one dollar.
const DOLLAR: u128 = 1_000_000;

/// The ranking window in seconds: 30 days of the project's unit.
pub fn rank_secs(unit: u64) -> u64 {
    RANK_DAYS * (unit / 7)
}

/// The badge window in seconds: 13 time units.
pub fn badge_secs(unit: u64) -> u64 {
    BADGE_UNITS * unit
}

/// The two windows' lengths.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WindowsRec {
    /// The ranking window, in seconds.
    pub rank_secs: u64,
    /// The badge window, in seconds.
    pub badge_secs: u64,
}

/// What stayed for the ranking window.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RankRec {
    /// Backer Shares held without a fall for the whole window (sum over accounts of the lowest balance).
    pub shares: String,
    /// `floor(10000 * shares / shares.backers)`.
    pub bps: u64,
    /// What those Shares would get if taken out at `value.leaveValue`, 6 decimals.
    pub money: String,
    /// Accounts whose lowest balance is worth at least the smallest Back at `value.leaveValue`.
    pub accounts: u64,
}

/// What stayed for the badge window.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct BadgeRec {
    /// As [`RankRec::shares`], for the badge window.
    pub shares: String,
    /// As [`RankRec::bps`], for the badge window.
    pub bps: u64,
}

/// `held`: how long money has stayed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct HeldRec {
    /// The two windows.
    pub windows: WindowsRec,
    /// The ranking window's figures; `null` when it could not be counted.
    pub rank: Option<RankRec>,
    /// The badge window's figures; `null` when it could not be counted.
    pub badge: Option<BadgeRec>,
    /// Accounts that hold now at least the smallest Back at `value.leaveValue`.
    pub counted_accounts: u64,
}

/// Which way the net money of an hour went.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NetDir {
    /// More came in than went out.
    In,
    /// More went out than came in.
    Out,
    /// Nothing, to the nearest rounding step.
    Even,
}

/// The net money of an hour, rounded.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct NetRec {
    /// The way it went.
    pub dir: NetDir,
    /// The absolute net, rounded half up to `feed.roundTo`; `"0"` exactly when `dir` is `even`.
    pub amount: String,
}

/// One hour of the feed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct HourRec {
    /// The hour's first second.
    pub at: u64,
    /// Backs in the hour.
    pub joins: u64,
    /// Take-outs in the hour (a Team Share take-out counts the same).
    pub took_out: u64,
    /// The net money.
    pub net: NetRec,
}

/// What an item of the feed says happened.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ItemKind {
    /// A task was planned.
    TaskPlanned,
    /// A task was taken.
    TaskTaken,
    /// A task was paid.
    TaskPaid,
    /// A task ended unpaid: sent back, lapsed or ran out.
    TaskEnded,
    /// A task was withdrawn before a take.
    TaskWithdrawn,
    /// The project checked in.
    Update,
}

impl ItemKind {
    fn is_task(self) -> bool {
        !matches!(self, Self::Update)
    }
}

/// One thing that happened that is not a flow of money.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ItemRec {
    /// What happened.
    pub kind: ItemKind,
    /// When (the block's time).
    pub at: u64,
    /// The task's number for the `task_*` kinds, otherwise `null`.
    pub serial: Option<u64>,
    /// For a planned task, when it can first be taken; for a taken one, its deadline; otherwise `null`.
    pub date: Option<u64>,
}

/// `feed`: joins and take-outs by the hour, and what else happened.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct FeedRec {
    /// The rounding step, 6 decimals.
    pub round_to: String,
    /// The length of one bucket, in seconds.
    pub bucket_secs: u64,
    /// The last 48 hours, oldest first; a quiet hour is a zero bucket.
    pub hours: Vec<HourRec>,
    /// Up to 30 things that are not money flows, newest first.
    pub items: Vec<ItemRec>,
    /// How many items were left out because of the 30.
    pub cut: u64,
}

/// The weeks of updates in a row.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct UpdatesRec {
    /// The consecutive launch-aligned windows, newest first, that each hold a check-in.
    pub weeks: u64,
    /// The longest such run in the project's life.
    pub longest: u64,
    /// The newest check-in.
    pub last_at: Option<u64>,
}

/// `streaks`: the project's own run of updates (a person's own weeks held are not here).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct StreaksRec {
    /// Check-ins, week by week.
    pub updates: UpdatesRec,
}

/// The badge's rule, as the server holds it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RuleRec {
    /// The share of the money that must have stayed, in basis points.
    pub min_held_bps: u64,
    /// For how long, in seconds (the badge window).
    pub held_secs: u64,
    /// How many accounts must hold.
    pub min_accounts: u64,
}

/// `established`: the badge's inputs and the server's verdict.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct EstablishedRec {
    /// The rule.
    pub rule: RuleRec,
    /// `held.badge.bps`; `null` when that is.
    pub held_bps: Option<u64>,
    /// `held.countedAccounts`; `null` when `held` is.
    pub accounts: Option<u64>,
    /// The runner is a Pair with two different signers.
    pub two_signers: bool,
    /// The rule on its inputs; `null` when `held.badge` is.
    pub reached: Option<bool>,
}

/// What the build of the social keys needs besides the ledger's rows.
#[derive(Clone, Copy, Debug)]
pub struct SocialInput<'a> {
    /// The project's rows up to the final block.
    pub rows: &'a [LogRow],
    /// The rank window and the badge window; `None` when they could not be read at all (a database error):
    /// `held` is then `null` and the next pass tries again.
    pub held: Option<(&'a Window, &'a Window)>,
}

impl SocialInput<'_> {
    /// An input with no rows and no held figures (a build that wants none).
    pub fn empty() -> SocialInput<'static> {
        SocialInput {
            rows: &[],
            held: None,
        }
    }
}

/// What a build of the social keys did, for the pass report.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SocialReport {
    /// The keys signed as `null` and why (one line each).
    pub failed: Vec<String>,
    /// Windows left without a figure because they were over a cap.
    pub cut: u64,
}

// ---------------------------------------------------------------------------------------------- the builders

fn worth(shares: u128, leave_value: u128) -> anyhow::Result<u128> {
    mul_div(shares, leave_value, ONE_SHARE)
        .ok_or_else(|| anyhow!("what {shares} Shares are worth overflows"))
}

fn bps_of(part: u128, whole: u128) -> anyhow::Result<u64> {
    if whole == 0 {
        return Ok(0);
    }
    let bps =
        mul_div(part, 10_000, whole).ok_or_else(|| anyhow!("a share of the whole overflows"))?;
    u64::try_from(bps).context("a share of the whole")
}

/// `held` from the two windows. `supply` is `shares.backers`; `min_join` and `leave_value` are the record's own
/// (`limits.minJoin`, `value.leaveValue`); `counted_accounts` is how many accounts hold now at least the smallest
/// Back at that figure.
pub fn held_of(
    rank: &Window,
    badge: &Window,
    supply: u128,
    leave_value: u128,
    min_join: u128,
    counted_accounts: u64,
    unit: u64,
) -> anyhow::Result<HeldRec> {
    let rank = match rank {
        Window::Cut => None,
        Window::Counted(h) => Some(rank_of(h, supply, leave_value, min_join)?),
    };
    let badge = match badge {
        Window::Cut => None,
        Window::Counted(h) => Some(BadgeRec {
            shares: h.shares.to_string(),
            bps: bps_of(h.shares, supply)?,
        }),
    };
    Ok(HeldRec {
        windows: WindowsRec {
            rank_secs: rank_secs(unit),
            badge_secs: badge_secs(unit),
        },
        rank,
        badge,
        counted_accounts,
    })
}

fn rank_of(h: &Held, supply: u128, leave_value: u128, min_join: u128) -> anyhow::Result<RankRec> {
    let mut accounts = 0u64;
    for low in &h.lowest {
        if worth(*low, leave_value)? >= min_join {
            accounts += 1;
        }
    }
    Ok(RankRec {
        shares: h.shares.to_string(),
        bps: bps_of(h.shares, supply)?,
        money: worth(h.shares, leave_value)?.to_string(),
        accounts,
    })
}

/// How many of `balances` are worth at least `min_join` at `leave_value` a Share.
pub fn count_worth(
    balances: impl Iterator<Item = u128>,
    leave_value: u128,
    min_join: u128,
) -> anyhow::Result<u64> {
    let mut n = 0u64;
    for b in balances {
        if worth(b, leave_value)? >= min_join {
            n += 1;
        }
    }
    Ok(n)
}

fn field_u128(row: &LogRow, name: &str) -> anyhow::Result<u128> {
    row.fields
        .get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("{}.{name} is missing or not text", row.event))?
        .parse()
        .with_context(|| format!("{}.{name} is not an amount", row.event))
}

fn field_u64(row: &LogRow, name: &str) -> anyhow::Result<u64> {
    u64::try_from(field_u128(row, name)?)
        .with_context(|| format!("{}.{name} is too large", row.event))
}

/// The rounding step in the dollar's smallest units.
fn round_to() -> u128 {
    u128::from(FEED_ROUND_DOLLARS) * DOLLAR
}

/// `x` rounded half up to a multiple of `step`.
fn round_half_up(x: u128, step: u128) -> anyhow::Result<u128> {
    Ok(x.checked_add(step / 2)
        .ok_or_else(|| anyhow!("a net amount overflows"))?
        / step
        * step)
}

/// The first second of the oldest hour of the feed at `as_of_time`.
fn first_hour(as_of_time: u64, bucket: u64) -> anyhow::Result<u64> {
    let last = as_of_time - as_of_time % bucket;
    last.checked_sub(bucket * (FEED_HOURS as u64 - 1))
        .ok_or_else(|| anyhow!("the chain is younger than the feed's 48 hours"))
}

/// `feed` at `as_of_time` from a project's rows.
///
/// The hours count backs and take-outs and carry **one** amount each: the net money in, rounded to the nearest
/// 100 dollars. No bucket carries money in and money out apart, so volume cannot be worked out from it.
pub fn feed_of(rows: &[LogRow], as_of_time: u64, unit: u64) -> anyhow::Result<FeedRec> {
    let bucket = unit / HOURS_PER_UNIT;
    if bucket == 0 {
        bail!("the unit {unit} is too short for hour buckets");
    }
    let first = first_hour(as_of_time, bucket)?;
    let mut joins = [0u64; FEED_HOURS];
    let mut took = [0u64; FEED_HOURS];
    let mut money_in = [0u128; FEED_HOURS];
    let mut money_out = [0u128; FEED_HOURS];
    for row in rows.iter().filter(|r| r.role == Role::Treasury) {
        if row.time < first || row.time > as_of_time {
            continue;
        }
        let slot = usize::try_from((row.time - first) / bucket).context("an hour")?;
        if slot >= FEED_HOURS {
            continue;
        }
        match row.event.as_str() {
            "Joined" => {
                let (paid, fee) = (field_u128(row, "paid")?, field_u128(row, "fee")?);
                let net = paid
                    .checked_sub(fee)
                    .ok_or_else(|| anyhow!("a Joined event charged more fee than it took in"))?;
                joins[slot] += 1;
                money_in[slot] = money_in[slot]
                    .checked_add(net)
                    .ok_or_else(|| anyhow!("the money in overflows"))?;
            }
            "Left" | "TeamLeft" => {
                took[slot] += 1;
                money_out[slot] = money_out[slot]
                    .checked_add(field_u128(row, "cash")?)
                    .ok_or_else(|| anyhow!("the money out overflows"))?;
            }
            _ => {}
        }
    }
    let step = round_to();
    let mut hours = Vec::with_capacity(FEED_HOURS);
    for k in 0..FEED_HOURS {
        let (up, down) = (money_in[k], money_out[k]);
        let rounded = round_half_up(up.abs_diff(down), step)?;
        let dir = if rounded == 0 {
            NetDir::Even
        } else if up > down {
            NetDir::In
        } else {
            NetDir::Out
        };
        hours.push(HourRec {
            at: first + bucket * k as u64,
            joins: joins[k],
            took_out: took[k],
            net: NetRec {
                dir,
                amount: rounded.to_string(),
            },
        });
    }
    let (items, cut) = items_of(rows, as_of_time, unit)?;
    Ok(FeedRec {
        round_to: step.to_string(),
        bucket_secs: bucket,
        hours,
        items,
        cut,
    })
}

/// The feed's items: the task events and check-ins of the last 28 days, newest first, at most 30, and how many
/// more there were.
fn items_of(rows: &[LogRow], as_of_time: u64, unit: u64) -> anyhow::Result<(Vec<ItemRec>, u64)> {
    let window = FEED_WINDOW_DAYS * (unit / 7);
    let mut items = Vec::new();
    let mut total = 0u64;
    for row in rows.iter().rev() {
        if row.time.saturating_add(window) <= as_of_time {
            break; // rows are in time order: nothing older is inside the window
        }
        let item = match (row.role, row.event.as_str()) {
            (Role::Treasury, "CheckedIn") => ItemRec {
                kind: ItemKind::Update,
                at: row.time,
                serial: None,
                date: None,
            },
            (Role::Tasks, "TaskAnnounced") => ItemRec {
                kind: ItemKind::TaskPlanned,
                at: row.time,
                serial: Some(serial_of(row)?),
                date: Some(field_u64(row, "noticeEnd")?),
            },
            (Role::Tasks, "TaskTaken") => ItemRec {
                kind: ItemKind::TaskTaken,
                at: row.time,
                serial: Some(serial_of(row)?),
                date: Some(field_u64(row, "deadline")?),
            },
            (Role::Tasks, "TaskResolved") => ItemRec {
                kind: match field_u64(row, "state")? {
                    3 => ItemKind::TaskPaid,
                    6 => ItemKind::TaskWithdrawn,
                    4 | 5 | 7 => ItemKind::TaskEnded,
                    n => bail!("TaskResolved.state {n} is not an ending"),
                },
                at: row.time,
                serial: Some(serial_of(row)?),
                date: None,
            },
            _ => continue,
        };
        total += 1;
        if items.len() < FEED_ITEMS {
            items.push(item);
        }
    }
    let cut = total - items.len() as u64;
    Ok((items, cut))
}

fn serial_of(row: &LogRow) -> anyhow::Result<u64> {
    let serial = field_u64(row, "serial")?;
    if serial > MAX_JSON_SERIAL {
        bail!("task serial {serial} is past 2^53");
    }
    Ok(serial)
}

/// `streaks`: windows one unit long, aligned to the launch (`k` is `[launchedAt + k*unit, launchedAt + (k+1)*unit)`),
/// counted back from the window that holds `as_of_time`. That window is still open: empty, it is skipped; with a
/// check-in, it counts. The first empty closed window ends the run.
///
/// A fixed grid gives the same answer on every pass (a window anchored at `as_of_time` would slide and flap). It is
/// stricter than the contract's own rule on purpose: a project that checks in every ten days shows fewer weeks.
pub fn streaks_of(
    rows: &[LogRow],
    as_of_time: u64,
    unit: u64,
    launched_at: u64,
) -> anyhow::Result<StreaksRec> {
    if unit == 0 {
        bail!("the unit is zero");
    }
    let current = as_of_time
        .checked_sub(launched_at)
        .ok_or_else(|| anyhow!("the project was launched after the record's time"))?
        / unit;
    let mut windows = BTreeSet::new();
    let mut last_at = None;
    for row in rows
        .iter()
        .filter(|r| r.role == Role::Treasury && r.event == "CheckedIn")
    {
        if let Some(since) = row.time.checked_sub(launched_at) {
            windows.insert(since / unit);
            last_at = Some(row.time);
        }
    }
    let mut weeks = 0u64;
    let mut next = if windows.contains(&current) {
        Some(current)
    } else {
        current.checked_sub(1)
    };
    while let Some(k) = next {
        if !windows.contains(&k) {
            break;
        }
        weeks += 1;
        next = k.checked_sub(1);
    }
    let (mut longest, mut run, mut previous) = (0u64, 0u64, None::<u64>);
    for &k in &windows {
        run = if previous.is_some_and(|p| p + 1 == k) {
            run + 1
        } else {
            1
        };
        longest = longest.max(run);
        previous = Some(k);
    }
    Ok(StreaksRec {
        updates: UpdatesRec {
            weeks,
            longest,
            last_at,
        },
    })
}

/// Whether the runner is a Pair with two different, non-zero signers.
fn two_signers(runner: &RunnerRec) -> bool {
    let zero = format!("0x{}", "0".repeat(40));
    runner.is_pair
        && runner
            .signers
            .as_ref()
            .is_some_and(|[a, b]| a != b && *a != zero && *b != zero)
}

/// `established` from `held` (when there is one) and the runner.
pub fn established_of(held: Option<&HeldRec>, runner: &RunnerRec, unit: u64) -> EstablishedRec {
    let held_bps = held.and_then(|h| h.badge.as_ref()).map(|b| b.bps);
    let accounts = held.map(|h| h.counted_accounts);
    let two = two_signers(runner);
    EstablishedRec {
        rule: RuleRec {
            min_held_bps: ESTABLISHED_MIN_HELD_BPS,
            held_secs: badge_secs(unit),
            min_accounts: ESTABLISHED_MIN_ACCOUNTS,
        },
        held_bps,
        accounts,
        two_signers: two,
        reached: held_bps.zip(accounts).map(|(bps, n)| {
            bps >= ESTABLISHED_MIN_HELD_BPS && n >= ESTABLISHED_MIN_ACCOUNTS && two
        }),
    }
}

// ---------------------------------------------------------------------------------------------- the checks

fn seen(ok: bool, what: impl FnOnce() -> String) -> anyhow::Result<()> {
    if ok {
        Ok(())
    } else {
        Err(anyhow!(what()))
    }
}

/// The checks of `held` that need only the record.
pub fn check_held(r: &Record) -> anyhow::Result<()> {
    let Some(h) = &r.held else {
        return Ok(());
    };
    let supply = amount(&r.shares.backers, "shares.backers")?;
    let leave = amount(&r.worth.leave_value, "value.leaveValue")?;
    seen(
        h.windows.rank_secs == rank_secs(r.unit) && h.windows.badge_secs == badge_secs(r.unit),
        || "held.windows are not the project's own windows".into(),
    )?;
    seen(h.counted_accounts <= r.holder_count, || {
        format!(
            "held.countedAccounts {} is more than holderCount {}",
            h.counted_accounts, r.holder_count
        )
    })?;
    let mut rank_shares = None;
    if let Some(rank) = &h.rank {
        let shares = amount(&rank.shares, "held.rank.shares")?;
        seen(shares <= supply, || {
            "held.rank.shares is more than shares.backers".into()
        })?;
        seen(rank.bps == bps_of(shares, supply)?, || {
            "held.rank.bps is not the share of the whole".into()
        })?;
        seen(
            amount(&rank.money, "held.rank.money")? == worth(shares, leave)?,
            || "held.rank.money is not what the Shares are worth at value.leaveValue".into(),
        )?;
        seen(rank.accounts <= h.counted_accounts, || {
            "held.rank.accounts is more than held.countedAccounts".into()
        })?;
        rank_shares = Some(shares);
    }
    if let Some(badge) = &h.badge {
        let shares = amount(&badge.shares, "held.badge.shares")?;
        seen(shares <= supply, || {
            "held.badge.shares is more than shares.backers".into()
        })?;
        seen(badge.bps == bps_of(shares, supply)?, || {
            "held.badge.bps is not the share of the whole".into()
        })?;
        if let Some(rank) = rank_shares {
            seen(shares <= rank, || {
                "held.badge.shares is more than held.rank.shares (a longer window cannot hold more)"
                    .into()
            })?;
        }
    }
    Ok(())
}

/// The checks of `feed` that need only the record.
pub fn check_feed(r: &Record) -> anyhow::Result<()> {
    let Some(f) = &r.feed else {
        return Ok(());
    };
    let bucket = r.unit / HOURS_PER_UNIT;
    seen(bucket > 0 && f.bucket_secs == bucket, || {
        "feed.bucketSecs is not the unit over 168".into()
    })?;
    seen(f.round_to == round_to().to_string(), || {
        "feed.roundTo is not 100 dollars".into()
    })?;
    seen(f.hours.len() == FEED_HOURS, || {
        format!("feed has {} hours, not {FEED_HOURS}", f.hours.len())
    })?;
    let first = first_hour(r.as_of.time, bucket)?;
    let step = round_to();
    for (k, hour) in f.hours.iter().enumerate() {
        seen(hour.at == first + bucket * k as u64, || {
            format!("feed hour {k} does not start where the 48 hours ending at asOf.time say")
        })?;
        let net = amount(&hour.net.amount, "feed net amount")?;
        seen(net % step == 0, || {
            format!("feed hour {k}: the net amount is not a multiple of the rounding step")
        })?;
        seen((net == 0) == (hour.net.dir == NetDir::Even), || {
            format!("feed hour {k}: dir is even exactly when the amount is 0")
        })?;
    }
    seen(f.items.len() <= FEED_ITEMS, || {
        format!("feed has {} items, at most {FEED_ITEMS}", f.items.len())
    })?;
    let window = FEED_WINDOW_DAYS * (r.unit / 7);
    for (i, item) in f.items.iter().enumerate() {
        seen(item.serial.is_some() == item.kind.is_task(), || {
            format!("feed item {i}: a serial belongs to the task kinds only")
        })?;
        seen(
            item.at <= r.as_of.time && item.at.saturating_add(window) > r.as_of.time,
            || format!("feed item {i} is outside the last 28 days"),
        )?;
        seen(i == 0 || f.items[i - 1].at >= item.at, || {
            "feed items are not newest first".into()
        })?;
    }
    Ok(())
}

/// The checks of `streaks` that need only the record.
pub fn check_streaks(r: &Record) -> anyhow::Result<()> {
    let Some(s) = &r.streaks else {
        return Ok(());
    };
    let u = &s.updates;
    seen(u.weeks <= u.longest, || {
        "streaks.updates.weeks is more than longest".into()
    })?;
    if let Some(at) = u.last_at {
        seen(at <= r.clock.last_check_in && at >= r.launched_at, || {
            "streaks.updates.lastAt is not a check-in the clock knows".into()
        })?;
    }
    Ok(())
}

/// The checks of `established` that need only the record.
pub fn check_established(r: &Record) -> anyhow::Result<()> {
    let Some(e) = &r.established else {
        return Ok(());
    };
    let want = established_of(r.held.as_ref(), &r.runner, r.unit);
    seen(e.rule == want.rule, || {
        "established.rule is not the server's rule".into()
    })?;
    seen(
        e.held_bps == want.held_bps && e.accounts == want.accounts,
        || "established's inputs are not held's".into(),
    )?;
    seen(e.two_signers == want.two_signers, || {
        "established.twoSigners is not what the runner says".into()
    })?;
    seen(e.reached == want.reached, || {
        "established.reached contradicts its inputs".into()
    })
}

/// The record-only checks of every social key that is present, one line per broken rule (what
/// [`super::record::validate`] adds).
pub fn check_record(r: &Record, bad: &mut Vec<String>) {
    for (key, result) in [
        ("held", check_held(r)),
        ("feed", check_feed(r)),
        ("streaks", check_streaks(r)),
        ("established", check_established(r)),
    ] {
        if let Err(e) = result {
            bad.push(format!("{key}: {e:#}"));
        }
    }
}

/// The feed recounted from the rows by a second and separate method: every hour's joins, take-outs and net
/// money are counted again hour by hour, the hours are added up against the rows of the whole window, and the
/// items are made again from the rows.
pub fn check_feed_rows(r: &Record, rows: &[LogRow]) -> anyhow::Result<()> {
    let Some(f) = &r.feed else {
        return Ok(());
    };
    let (mut joins_in_window, mut took_in_window) = (0u64, 0u64);
    for hour in &f.hours {
        let end = hour.at + f.bucket_secs;
        let in_hour =
            |row: &&LogRow| row.role == Role::Treasury && row.time >= hour.at && row.time < end;
        let (mut joins, mut took) = (0u64, 0u64);
        let (mut up, mut down) = (0u128, 0u128);
        for row in rows.iter().filter(in_hour) {
            match row.event.as_str() {
                "Joined" => {
                    joins += 1;
                    up += field_u128(row, "paid")?
                        .checked_sub(field_u128(row, "fee")?)
                        .ok_or_else(|| {
                            anyhow!("a Joined event charged more fee than it took in")
                        })?;
                }
                "Left" | "TeamLeft" => {
                    took += 1;
                    down += field_u128(row, "cash")?;
                }
                _ => {}
            }
        }
        seen(joins == hour.joins && took == hour.took_out, || {
            format!(
                "feed hour at {}: the rows say {joins} backs and {took} take-outs",
                hour.at
            )
        })?;
        let net = round_half_up(up.abs_diff(down), round_to())?;
        let shown = amount(&hour.net.amount, "feed net amount")?;
        seen(net == shown, || {
            format!(
                "feed hour at {}: the rows say a net of {net}, the record {shown}",
                hour.at
            )
        })?;
        joins_in_window += joins;
        took_in_window += took;
    }
    let first = f.hours.first().map_or(0, |h| h.at);
    let count = |events: &[&str]| {
        rows.iter()
            .filter(|row| {
                row.role == Role::Treasury
                    && row.time >= first
                    && row.time <= r.as_of.time
                    && events.contains(&row.event.as_str())
            })
            .count() as u64
    };
    seen(
        count(&["Joined"]) == joins_in_window && count(&["Left", "TeamLeft"]) == took_in_window,
        || "feed: the hours do not add up to the rows of the window".into(),
    )?;
    let (items, cut) = items_of(rows, r.as_of.time, r.unit)?;
    seen(items == f.items && cut == f.cut, || {
        "feed: the items are not the rows' newest 30 of the last 28 days".into()
    })
}

/// The streak's last check-in against the newest check-in row.
pub fn check_streaks_rows(r: &Record, rows: &[LogRow]) -> anyhow::Result<()> {
    let Some(s) = &r.streaks else {
        return Ok(());
    };
    let newest = rows
        .iter()
        .rev()
        .find(|row| row.role == Role::Treasury && row.event == "CheckedIn")
        .map(|row| row.time);
    seen(s.updates.last_at == newest, || {
        "streaks.updates.lastAt is not the newest check-in row".into()
    })
}

/// Build the four keys into `r` from `input`, check each, and sign as `null` any that fails: `r.held`,
/// `r.feed`, `r.streaks` and `r.established` are replaced. `holder_balances` are the balances in hand of every
/// account that holds backer Shares now, the excluded accounts left out.
pub fn fill(r: &mut Record, input: &SocialInput<'_>, holder_balances: &[u128]) -> SocialReport {
    let mut failed: Vec<String> = Vec::new();
    let mut note = |key: &str, why: String| failed.push(format!("{key} not published: {why}"));
    let mut cut = 0u64;

    r.held = None;
    if let Some((rank, badge)) = input.held {
        cut += [rank, badge]
            .iter()
            .filter(|w| matches!(w, Window::Cut))
            .count() as u64;
        let built = (|| {
            let supply = amount(&r.shares.backers, "shares.backers")?;
            let leave = amount(&r.worth.leave_value, "value.leaveValue")?;
            let min_join = amount(&r.limits.min_join, "limits.minJoin")?;
            let counted = count_worth(holder_balances.iter().copied(), leave, min_join)?;
            held_of(rank, badge, supply, leave, min_join, counted, r.unit)
        })();
        match built {
            Ok(held) => {
                r.held = Some(held);
                if let Err(e) = check_held(r) {
                    note("held", format!("{e:#}"));
                    r.held = None;
                }
            }
            Err(e) => note("held", format!("{e:#}")),
        }
    } else {
        note("held", "its figures could not be read".into());
    }

    r.feed = match feed_of(input.rows, r.as_of.time, r.unit) {
        Ok(feed) => Some(feed),
        Err(e) => {
            note("feed", format!("{e:#}"));
            None
        }
    };
    if let Err(e) = check_feed(r).and_then(|()| check_feed_rows(r, input.rows)) {
        note("feed", format!("{e:#}"));
        r.feed = None;
    }
    r.streaks = match streaks_of(input.rows, r.as_of.time, r.unit, r.launched_at) {
        Ok(s) => Some(s),
        Err(e) => {
            note("streaks", format!("{e:#}"));
            None
        }
    };
    if let Err(e) = check_streaks(r).and_then(|()| check_streaks_rows(r, input.rows)) {
        note("streaks", format!("{e:#}"));
        r.streaks = None;
    }
    // `established` is made from `held` as it stands now, so a held that was cut or failed leaves it with
    // `null` inputs and `reached: null`.
    r.established = Some(established_of(r.held.as_ref(), &r.runner, r.unit));
    if let Err(e) = check_established(r) {
        note("established", format!("{e:#}"));
        r.established = None;
    }
    SocialReport { failed, cut }
}
