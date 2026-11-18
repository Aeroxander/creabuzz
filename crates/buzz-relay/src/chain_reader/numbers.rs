//! The project numbers the chain cannot give directly, worked out from one
//! project's events (oldest first) as of one block.
//!
//! The content has two parts. Everything outside `now` follows from the events
//! alone and changes only when a new event arrives. `now` holds what moves with
//! time between events (the refund per 100, the active clock, "quiet since",
//! the Open stage) as of the record's `asOf` time; with `clock.runsUntil` a
//! reader can carry the clock forward exactly until the next event.
//!
//! Rules copied from `contracts/next/src` (each pinned by a test below):
//! - Total raised is the sum of `Rounds.RoundClosed.accepted` (= `Rounds.raised`),
//!   never the sum of `Rounds.Settled.accepted` (scale-back dust and unsettled
//!   backers make that lower).
//! - The refund uses the Rounds' active clock, not wall time: time counts only
//!   inside the Treasury's check-in window (14 days after the last check-in, or
//!   after the first sale money is settled), and not while paused or after a
//!   wind-down. The released part is rounded up and the 5% fee (1% after a
//!   wind-down) is rounded up, as `Rounds.refundable` does.

use std::collections::{BTreeMap, HashMap, HashSet};

use anyhow::{anyhow, Context};
use serde_json::{json, Map, Value};

use super::events::Role;
use super::word::{hex0x, Word};

/// `Rounds.RELEASE`: the held money is released over 182 days of active time.
pub const RELEASE: u128 = 182 * 86_400;
/// `Rounds.HELD_BPS` is implied by `Settled.held`; the refund fees:
const REFUND_FEE_BPS: u128 = 500;
const REFUND_PLATFORM_BPS: u128 = 100;
const BPS: u128 = 10_000;
/// `Treasury.CHECK_IN_WINDOW`.
pub const CHECK_IN_WINDOW: u64 = 14 * 86_400;
/// `Launcher.SOLO_CAP` and `TEAM_CAP` (raw dollars, 6 decimals).
pub const SOLO_CAP: u128 = 10_000_000_000;
/// See [`SOLO_CAP`].
pub const TEAM_CAP: u128 = 50_000_000_000;
/// `Launcher.NO_MARKET_AFTER` and `OPEN_AFTER`.
pub const YEAR: u64 = 365 * 86_400;
/// The most backings and accounts listed in one record; the counts are always
/// given, and `truncated` says when the list was cut. 200 keeps a record near
/// 150 KB at worst, well under the relay's 512 KB frame.
pub const MAX_LISTED: usize = 200;
/// Every Share that exists, in raw units: 1,000,000,000 x 1e18.
const ALL_SHARES_RAW: u128 = 1_000_000_000_000_000_000_000_000_000;

/// One stored log of the project, with its block time.
#[derive(Clone, Debug)]
pub struct LogRow {
    /// Block number.
    pub block: u64,
    /// Position in the block.
    pub log_index: u32,
    /// Block time (unix seconds).
    pub time: u64,
    /// Emitting contract's role.
    pub role: Role,
    /// Emitting contract.
    pub address: [u8; 20],
    /// Event name.
    pub event: String,
    /// Decoded fields (see `events::decode`).
    pub fields: Value,
}

/// The runners the Launcher counts as more than one person
/// (`Launcher.runnerKind`): every Pair it made, for any project (`isPair` is
/// one list for the whole Launcher), and every Council it registered, read from
/// its final events.
#[derive(Clone, Debug, Default)]
pub struct Runners {
    /// `Launcher.PairMade.pair`, lower-case `0x` text.
    pub pairs: HashSet<String>,
    /// `Launcher.CouncilRegistered.council`, lower-case `0x` text.
    pub councils: HashSet<String>,
    /// The Launcher's shared contracts that hold Shares for others (its
    /// LiquidityHolder and the pool manager): never listed as holders
    /// (review F8).
    pub shared: HashSet<String>,
}

/// Where and when the numbers are taken.
#[derive(Clone, Debug)]
pub struct AsOf {
    /// Chain id.
    pub chain_id: u64,
    /// The Launcher.
    pub launcher: [u8; 20],
    /// The newest final block.
    pub block: u64,
    /// Its time.
    pub time: u64,
    /// The Launcher's Pair and Council runners as of `block`.
    pub runners: Runners,
}

fn field<'a>(row: &'a LogRow, name: &str) -> anyhow::Result<&'a Value> {
    row.fields
        .get(name)
        .ok_or_else(|| anyhow!("{} has no {name}", row.event))
}

fn num(row: &LogRow, name: &str) -> anyhow::Result<u128> {
    let v = field(row, name)?;
    v.as_str()
        .and_then(|s| s.parse::<u128>().ok())
        .ok_or_else(|| anyhow!("{}.{name} is not an amount", row.event))
}

fn small(row: &LogRow, name: &str) -> anyhow::Result<u64> {
    u64::try_from(num(row, name)?).with_context(|| format!("{}.{name} too large", row.event))
}

fn text(row: &LogRow, name: &str) -> anyhow::Result<String> {
    Ok(field(row, name)?
        .as_str()
        .ok_or_else(|| anyhow!("{}.{name} is not text", row.event))?
        .to_owned())
}

fn flag(row: &LogRow, name: &str) -> anyhow::Result<bool> {
    field(row, name)?
        .as_bool()
        .ok_or_else(|| anyhow!("{}.{name} is not true or false", row.event))
}

/// `a * b / c` rounded up, in `u128`.
fn ceil_div(a: u128, c: u128) -> u128 {
    if c == 0 {
        return 0;
    }
    a.div_ceil(c)
}

/// Hundredths as text: 5864 -> "58.64".
fn hundredths(value: u128) -> String {
    format!("{}.{:02}", value / 100, value % 100)
}

/// `numerator / denominator` to two places, rounded half up.
fn ratio_hundredths(numerator: u128, denominator: u128) -> Option<String> {
    if denominator == 0 {
        return None;
    }
    let scaled = numerator.checked_mul(200)?;
    Some(hundredths((scaled / denominator).div_ceil(2)))
}

/// The price for the whole project (dollars for all 1,000,000,000 Shares) at
/// `shares_per_raw_dollar`, to the cent (rounded down): 3e15 gives 333333.33.
pub fn project_price(shares_per_raw_dollar: u128) -> Option<String> {
    if shares_per_raw_dollar == 0 {
        return None;
    }
    // dollars = 1e27 / spr raw dollars / 1e6, so cents = 1e23 / spr.
    Some(hundredths(
        100_000_000_000_000_000_000_000 / shares_per_raw_dollar,
    ))
}

/// The Rounds' shared active clock, worked out from the Treasury's events.
#[derive(Clone, Debug, Default)]
struct Clock {
    total: u64,
    at: u64,
    last_check_in: Option<u64>,
    paused: bool,
    wound_down: bool,
    settled: bool,
}

impl Clock {
    fn started(at: u64) -> Self {
        Self {
            at,
            ..Self::default()
        }
    }

    fn end(&self) -> Option<u64> {
        if self.paused || self.wound_down {
            return None;
        }
        self.last_check_in.map(|l| l + CHECK_IN_WINDOW)
    }

    /// `Rounds.activeNow()` at `t` (no later event in between).
    fn active_at(&self, t: u64) -> u64 {
        match self.end() {
            Some(end) => {
                let upto = t.min(end);
                self.total + upto.saturating_sub(self.at)
            }
            None => self.total,
        }
    }

    /// Work the clock out to `t` before the window changes (`Rounds.sync`).
    fn sync(&mut self, t: u64) {
        self.total = self.active_at(t);
        self.at = self.at.max(t);
    }
}

#[derive(Debug, Default)]
struct RoundState {
    opened: Option<Value>,
    size: u128,
    cap: u128,
    raised_before: u128,
    price: u128,
    opens_at: u64,
    closes_at: u64,
    asks: BTreeMap<String, u128>,
    asked: u128,
    closed_at: Option<u64>,
    accepted: u128,
    active_at_close: u64,
    released: u128,
    settled: usize,
}

#[derive(Debug, Default)]
struct Position {
    accepted: u128,
    returned: u128,
    shares: u128,
    held_money: u128,
    held_total: u128,
    held_claimed: u128,
    held_cancelled: u128,
    refunded: Option<(u128, u64)>,
}

#[derive(Debug, Default)]
struct Account {
    held: i128,
    free: i128,
}

/// Work out the numbers for project `key` from its events, oldest first, or
/// `Ok(None)` when its launch is not among them (for example after a rollback).
/// `balances` are the free Shares per account the reader keeps as ranges are
/// committed (Shares Transfers are not among the stored logs it loads, review
/// F5); Transfers in `logs`, if any, are counted on top.
pub fn derive(
    key: &Word,
    logs: &[LogRow],
    balances: &HashMap<String, i128>,
    as_of: &AsOf,
) -> anyhow::Result<Option<Value>> {
    let Some(launch) = logs
        .iter()
        .find(|l| l.role == Role::Launcher && l.event == "ProjectLaunched")
    else {
        return Ok(None);
    };
    let project = field(launch, "project")?;
    let contract = |name: &str| -> anyhow::Result<String> {
        Ok(project
            .get(name)
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("ProjectLaunched.project has no {name}"))?
            .to_owned())
    };
    let founder = text(launch, "founder")?;
    let launched_at = launch.time;
    let stake = field(launch, "settings")?
        .get("stake")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let project_zero = stake == hex0x(&[0u8; 20]);
    let quote = field(launch, "settings")?
        .get("quote")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let own: Vec<String> = ["shares", "treasury", "vester", "finisher", "rounds"]
        .iter()
        .map(|n| contract(n))
        .collect::<anyhow::Result<_>>()?;

    let mut clock = Clock::started(launched_at);
    let mut rounds: BTreeMap<u64, RoundState> = BTreeMap::new();
    let mut positions: BTreeMap<(u64, String), Position> = BTreeMap::new();
    let mut accounts: HashMap<String, Account> = balances
        .iter()
        .map(|(a, free)| {
            (
                a.clone(),
                Account {
                    held: 0,
                    free: *free,
                },
            )
        })
        .collect();
    // The first Pair made for this project (shown), and since when the current
    // runner has been a Pair or a Council: the cap and the Team stage follow
    // the current runner (`Launcher.capOf`, `stageOf`), so a Pair that hands
    // the seat to one person ends Team.
    let mut pair: Option<String> = None;
    let own_pairs: HashSet<&str> = logs
        .iter()
        .filter(|l| l.role == Role::Launcher && l.event == "PairMade")
        .filter_map(|l| l.fields.get("pair").and_then(Value::as_str))
        .collect();
    let is_team = |who: &str| {
        own_pairs.contains(who)
            || as_of.runners.pairs.contains(who)
            || as_of.runners.councils.contains(who)
    };
    let mut runner = founder.clone();
    let mut team_since: Option<u64> = None;
    let mut first_money_at: Option<u64> = None;
    let mut pool_opened_at: Option<u64> = None;
    // The sale (review O1, O2): `Launcher.stageOf` says Council only once the
    // Finisher's stage is Done, which `sweep` sets after a sale that sold. An
    // abandoned sale emits `Swept` too (after `Abandoned`), and a failed one
    // emits `SaleFailed` instead. "No market" cannot be declared while a sale
    // runs, nor after an abandoned sale (the Treasury's pool flag is set
    // without `PoolOpened`).
    let mut sale_running: Option<String> = None;
    let mut abandoned: HashSet<String> = HashSet::new();
    let mut done_at: Option<u64> = None;
    let mut sale_abandoned_at: Option<u64> = None;
    let mut vester_started: Option<u64> = None;
    let mut no_market_at: Option<u64> = None;
    let mut wound_down_at: Option<u64> = None;
    let mut rounds_wound_down = false;
    let mut paused_at: Option<u64> = None;
    let mut treasury = Map::new();
    let mut sums: BTreeMap<&'static str, u128> = BTreeMap::new();
    let mut handed_back_count: u64 = 0;
    let mut sale = Map::new();
    let mut reserve_sales: Vec<Value> = Vec::new();
    // Auctions hold Shares for sale, and project zero's earlier backers' claim
    // contract holds Shares for the people on its list, not for an account.
    let mut auctions: Vec<String> = Vec::new();
    let mut earlier_backers: Option<Value> = None;
    // Its events as counts and totals, and the accounts it delivered to: they
    // are left out of the holder list, which would otherwise show each
    // receiver with its entry's Shares.
    let mut claim: Option<String> = None;
    let mut earlier = numbers_earlier::Earlier::default();
    let mut receivers: HashSet<String> = HashSet::new();
    // Auctions, pool trades and pool fees. The pool orders its two tokens by
    // address: the Shares are `currency0` when theirs is the lower.
    let mut market = numbers_market::Market::default();
    let shares_first = own[0] < quote;
    let mut clock_mismatch: Option<(u64, u64, u64)> = None;

    let add = |sums: &mut BTreeMap<&'static str, u128>, k: &'static str, v: u128| {
        let e = sums.entry(k).or_insert(0);
        *e = e.saturating_add(v);
    };

    for row in logs {
        let t = row.time;
        match (row.role, row.event.as_str()) {
            (Role::Launcher, "RoundOpened") => {
                let id = small(row, "round")?;
                let r = rounds.entry(id).or_default();
                r.size = num(row, "size")?;
                r.cap = num(row, "cap")?;
                r.raised_before = num(row, "raisedBefore")?;
                r.price = num(row, "sharesPerRawDollar")?;
                r.opened = Some(json!(t));
            }
            (Role::Launcher, "PairMade") => {
                let p = text(row, "pair")?;
                if pair.is_none() {
                    pair = Some(p.clone());
                }
                // Treasury.RunnerChanged to the Pair comes first, in the same
                // transaction; this keeps the runner right if it did not.
                if runner != p {
                    runner = p;
                    team_since = team_since.or(Some(t));
                }
            }
            (Role::Launcher, "ProjectZeroSplit") => {
                let named = text(row, "claim")?;
                auctions.push(named.clone());
                claim = Some(named.clone());
                earlier_backers = Some(json!({
                    "claim": named, "fromBacking": field(row, "fromBacking")?,
                    "fromFounder": field(row, "fromFounder")?, "teamBudget": field(row, "teamBudget")?,
                }));
            }
            (Role::Launcher, "SaleOpened") => {
                for k in [
                    "auction",
                    "minimum",
                    "startBlock",
                    "endBlock",
                    "floorPriceQ96",
                    "tickSpacingQ96",
                ] {
                    sale.insert(k.to_owned(), field(row, k)?.clone());
                }
                sale.insert("openedAt".into(), json!(t));
                auctions.push(text(row, "auction")?);
            }
            (Role::Launcher, "ReserveSaleOpened") => {
                auctions.push(text(row, "auction")?);
                reserve_sales.push(json!({
                    "auction": field(row, "auction")?, "amount": field(row, "amount")?,
                    "floorPriceQ96": field(row, "floorPriceQ96")?, "openedAt": t, "finished": null,
                }));
            }
            (Role::Launcher, "ReserveSaleFinished") => {
                let auction = field(row, "auction")?.clone();
                if let Some(s) = reserve_sales
                    .iter_mut()
                    .rev()
                    .find(|s| s["auction"] == auction)
                {
                    s["finished"] = json!({
                        "toTreasury": field(row, "toTreasury")?, "sharesBack": field(row, "sharesBack")?,
                        "endPriceQ96": field(row, "endPriceQ96")?, "at": t,
                    });
                }
            }
            (Role::Rounds, "RoundOpened") => {
                let id = small(row, "round")?;
                let r = rounds.entry(id).or_default();
                r.size = num(row, "size")?;
                r.price = num(row, "sharesPerRawDollar")?;
                r.opens_at = small(row, "opensAt")?;
                r.closes_at = small(row, "closesAt")?;
            }
            (Role::Rounds, "Asked") | (Role::Rounds, "AskLowered") => {
                let id = small(row, "round")?;
                let backer = text(row, "backer")?;
                let total = num(row, "total")?;
                let r = rounds.entry(id).or_default();
                let old = r.asks.insert(backer, total).unwrap_or(0);
                r.asked = r.asked.saturating_sub(old).saturating_add(total);
            }
            (Role::Rounds, "RoundClosed") => {
                let id = small(row, "round")?;
                let r = rounds.entry(id).or_default();
                r.asked = num(row, "asked")?;
                r.accepted = num(row, "accepted")?;
                r.active_at_close = small(row, "activeAtClose")?;
                r.closed_at = Some(t);
                let modelled = clock.active_at(t);
                if modelled != r.active_at_close && clock_mismatch.is_none() {
                    clock_mismatch = Some((id, modelled, r.active_at_close));
                }
                if r.accepted > 0 && first_money_at.is_none() {
                    first_money_at = Some(t);
                }
            }
            (Role::Rounds, "Settled") => {
                let id = small(row, "round")?;
                rounds.entry(id).or_default().settled += 1;
                let p = positions.entry((id, text(row, "backer")?)).or_default();
                p.accepted = num(row, "accepted")?;
                p.returned = num(row, "returned")?;
                p.shares = num(row, "shares")?;
                p.held_money = num(row, "held")?;
            }
            (Role::Rounds, "Released") => {
                let id = small(row, "round")?;
                let r = rounds.entry(id).or_default();
                r.released = r.released.saturating_add(num(row, "amount")?);
            }
            (Role::Rounds, "Refunded") => {
                let id = small(row, "round")?;
                let p = positions.entry((id, text(row, "backer")?)).or_default();
                let still = p.held_total.saturating_sub(p.held_claimed);
                let part = if still == p.held_total || p.held_total == 0 {
                    p.held_money
                } else {
                    p.held_money * still / p.held_total
                };
                p.held_money -= part.min(p.held_money);
                p.refunded = Some((num(row, "paid")?, t));
                add(&mut sums, "refundsPaid", num(row, "paid")?);
            }
            (Role::Rounds, "WoundDown") => rounds_wound_down = true,
            (Role::Vester, "Granted") => {
                let a = accounts.entry(text(row, "beneficiary")?).or_default();
                a.held += num(row, "amount")? as i128;
            }
            (Role::Vester, "Claimed") => {
                let a = accounts.entry(text(row, "beneficiary")?).or_default();
                a.held -= num(row, "amount")? as i128;
            }
            (Role::Vester, "FounderTrimmed") => {
                let a = accounts.entry(founder.clone()).or_default();
                a.held -= num(row, "cut")? as i128;
            }
            (Role::Vester, "HeldGranted")
            | (Role::Vester, "HeldClaimed")
            | (Role::Vester, "HeldCancelled") => {
                let id = small(row, "round")?;
                let backer = text(row, "backer")?;
                let amount = num(row, "amount")?;
                let a = accounts.entry(backer.clone()).or_default();
                let p = positions.entry((id, backer)).or_default();
                match row.event.as_str() {
                    "HeldGranted" => {
                        p.held_total += amount;
                        a.held += amount as i128;
                    }
                    "HeldClaimed" => {
                        p.held_claimed += amount;
                        a.held -= amount as i128;
                    }
                    _ => {
                        p.held_cancelled += amount;
                        a.held -= amount as i128;
                    }
                }
            }
            (Role::Vester, "Started") => vester_started = Some(t),
            (Role::Earlier, event) => {
                if event == "Delivered" {
                    receivers.insert(text(row, "receiver")?);
                }
                earlier.apply(row)?;
            }
            (Role::Auction | Role::Holder | Role::PoolManager, _) => {
                market.apply(row, shares_first, &own[1])?;
            }
            (Role::Shares, "Transfer") => {
                let value = num(row, "value")? as i128;
                let from = text(row, "from")?;
                let to = text(row, "to")?;
                if claim.as_deref() == Some(from.as_str()) {
                    receivers.insert(to.clone());
                }
                accounts.entry(from).or_default().free -= value;
                accounts.entry(to).or_default().free += value;
            }
            (Role::Treasury, "CheckedIn") => {
                clock.sync(t);
                clock.last_check_in = Some(t);
            }
            (Role::Treasury, "Paused") => {
                clock.sync(t);
                clock.paused = flag(row, "on")?;
                paused_at = clock.paused.then_some(t);
            }
            (Role::Treasury, "WoundDown") => {
                clock.sync(t);
                clock.wound_down = true;
                wound_down_at = Some(t);
            }
            (Role::Treasury, ev @ ("Settled" | "ReserveSaleSettled")) => {
                if !clock.settled {
                    clock.sync(t);
                    clock.settled = true;
                    clock.last_check_in = Some(t);
                }
                add(
                    &mut sums,
                    if ev == "Settled" {
                        "saleSettled"
                    } else {
                        "reserveSaleSettled"
                    },
                    num(row, "amount")?,
                );
            }
            (Role::Treasury, "PoolOpened") => pool_opened_at = Some(t),
            (Role::Treasury, "SaleAbandoned") => sale_abandoned_at = Some(t),
            (Role::Finisher, "SaleOpenedBy") => sale_running = Some(text(row, "auction")?),
            (Role::Finisher, "SaleFailed") => {
                let auction = text(row, "auction")?;
                if sale_running.as_deref() == Some(auction.as_str()) {
                    sale_running = None;
                }
            }
            (Role::Finisher, "Swept") => {
                let auction = text(row, "auction")?;
                if sale_running.as_deref() == Some(auction.as_str()) {
                    sale_running = None;
                }
                if !abandoned.contains(&auction) {
                    done_at = done_at.or(Some(t));
                }
            }
            (Role::Treasury, "NoMarketDeclared") => no_market_at = Some(t),
            (Role::Treasury, "RunnerChanged") => {
                runner = text(row, "to")?;
                team_since = if is_team(&runner) {
                    team_since.or(Some(t))
                } else {
                    None
                };
            }
            (Role::Treasury, "ToppedUp") => add(&mut sums, "toppedUp", num(row, "amount")?),
            (Role::Treasury, "ShareRevenue") => add(&mut sums, "shareRevenue", num(row, "amount")?),
            (Role::Treasury, "Released") => add(&mut sums, "floorReleased", num(row, "amount")?),
            (Role::Treasury, "Spent") => add(&mut sums, "spent", num(row, "amount")?),
            (Role::Treasury, "TeamPaid") => {
                add(&mut sums, "teamPaid", num(row, "amount")?);
                treasury.insert("teamBudgetLeft".into(), json!(text(row, "left")?));
            }
            (Role::Treasury, "SharesGiven") => add(&mut sums, "sharesGiven", num(row, "amount")?),
            (Role::Treasury, "StakeGranted") => add(&mut sums, "stakeGranted", num(row, "amount")?),
            (Role::Treasury, "HandedBack") => {
                handed_back_count += 1;
                add(&mut sums, "handedBackShares", num(row, "shares")?);
                add(&mut sums, "handedBackPaid", num(row, "paid")?);
            }
            (Role::Finisher, "Settled") => {
                sale.insert(
                    "settled".into(),
                    json!({"raised": field(row, "raised")?, "afterFee": field(row, "afterFee")?,
                           "toTreasury": field(row, "toTreasury")?, "at": t}),
                );
            }
            (Role::Finisher, "PoolOpened") => {
                sale.insert(
                    "pool".into(),
                    json!({"poolId": field(row, "poolId")?, "sqrtPriceX96": field(row, "sqrtPriceX96")?,
                           "poolDollars": field(row, "poolDollars")?, "poolShares": field(row, "poolShares")?,
                           "at": t}),
                );
            }
            (Role::Finisher, "Abandoned") => {
                let auction = text(row, "auction")?;
                if sale_running.as_deref() == Some(auction.as_str()) {
                    sale_running = None;
                }
                abandoned.insert(auction);
                sale.insert("abandonedAt".into(), json!(t));
            }
            _ => {}
        }
    }
    if let Some((round, modelled, emitted)) = clock_mismatch {
        tracing::warn!(
            project = %hex0x(key), round, modelled, emitted,
            "chain reader: modelled active clock differs from RoundClosed.activeAtClose"
        );
    }

    // ── raised against the cap, prices ──────────────────────────────────────
    let team = team_since.is_some();
    let cap = if team { TEAM_CAP } else { SOLO_CAP };
    let total_raised: u128 = rounds.values().map(|r| r.accepted).sum();
    let mut weighted: u128 = 0; // sum of accepted x price = Shares sold in raw units
    let mut round_list = Vec::new();
    for (id, r) in &rounds {
        weighted = weighted.saturating_add(r.accepted.saturating_mul(r.price));
        let scaled_back = r.closed_at.is_some() && r.asked > r.accepted;
        round_list.push(json!({
            "round": id,
            "size": r.size.to_string(),
            "cap": r.cap.to_string(),
            "raisedBefore": r.raised_before.to_string(),
            "sharesPerRawDollar": r.price.to_string(),
            "projectPrice": project_price(r.price),
            "opensAt": r.opens_at,
            "closesAt": r.closes_at,
            "backers": r.asks.values().filter(|a| **a > 0).count(),
            "asked": r.asked.to_string(),
            "closed": r.closed_at.is_some(),
            "closedAt": r.closed_at,
            "accepted": r.accepted.to_string(),
            "acceptedPercent": if scaled_back { ratio_hundredths(r.accepted * 100, r.asked) } else { None },
            "activeAtClose": r.closed_at.map(|_| r.active_at_close),
            "settled": r.settled,
            "released": r.released.to_string(),
        }));
    }
    let average = if total_raised > 0 && weighted > 0 {
        json!({
            "sharesPerRawDollar": (weighted / total_raised).to_string(),
            // dollars for all Shares = raised / sold x 1e27 raw Shares; in cents.
            "projectPrice": total_raised
                .checked_mul(ALL_SHARES_RAW / 10_000)
                .map(|n| hundredths(n / weighted)),
        })
    } else {
        Value::Null
    };

    // ── stage and eligibility (Launcher.stageOf) ─────────────────────────────
    let (stage, stage_since) = if let Some(t) = done_at {
        ("council", t)
    } else if let Some(t) = team_since {
        ("team", t)
    } else if let Some(t) = first_money_at {
        ("backed", t)
    } else {
        ("solo", launched_at)
    };
    let open_at = match (done_at, vester_started) {
        (Some(_), Some(start)) => Some(start + YEAR),
        _ => None,
    };
    let finished = wound_down_at.is_some() || no_market_at.is_some();
    let eligible = match stage {
        _ if wound_down_at.is_some() => Value::Null,
        "solo" => json!({"for": "backed", "since": launched_at}),
        "backed" => json!({"for": "team", "since": stage_since}),
        "team" if !finished => json!({"for": "council", "since": stage_since}),
        "council" => json!({"for": "open", "since": open_at}),
        _ => Value::Null,
    };
    let no_market_from = if pool_opened_at.is_none()
        && sale_abandoned_at.is_none()
        && sale_running.is_none()
        && !finished
    {
        Some(first_money_at.unwrap_or(launched_at) + YEAR)
    } else {
        None
    };

    // ── receipts and the refund ───────────────────────────────────────────────
    let active_now = clock.active_at(as_of.time);
    let fee_bps = if rounds_wound_down {
        REFUND_PLATFORM_BPS
    } else {
        REFUND_FEE_BPS
    };
    let mut receipts = Vec::new();
    let mut refunds_now = Vec::new();
    for ((id, backer), p) in &positions {
        if p.accepted == 0 && p.held_total == 0 {
            continue;
        }
        let shares_held = p
            .held_total
            .saturating_sub(p.held_claimed)
            .saturating_sub(p.held_cancelled);
        receipts.push(json!({
            "round": id, "backer": backer, "accepted": p.accepted.to_string(),
            "returned": p.returned.to_string(), "shares": p.shares.to_string(),
            "heldMoney": p.held_money.to_string(), "sharesHeld": shares_held.to_string(),
            "refunded": p.refunded.map(|(paid, at)| json!({"paid": paid.to_string(), "at": at})),
        }));
        let at_close = rounds.get(id).map(|r| r.active_at_close).unwrap_or(0);
        let refundable = refundable(p, active_now, at_close, fee_bps);
        refunds_now.push(json!({
            "round": id, "backer": backer, "refundable": refundable.to_string(),
            "per100": ratio_hundredths(refundable * 100, p.accepted),
        }));
    }
    let receipt_count = receipts.len();
    receipts.truncate(MAX_LISTED);
    refunds_now.truncate(MAX_LISTED);

    // ── held and free Shares per account ──────────────────────────────────────
    let zero = hex0x(&[0u8; 20]);
    let mut received = (0usize, 0i128);
    for r in &receivers {
        if let Some(a) = accounts.remove(r) {
            received.0 += 1;
            received.1 += a.held.max(0) + a.free.max(0);
        }
    }
    if let Some(eb) = earlier_backers.as_mut() {
        earlier.merge_into(eb, received);
    }
    let mut holder_list: Vec<(String, i128, i128)> = accounts
        .into_iter()
        .filter(|(addr, _)| {
            *addr != zero
                && !own.contains(addr)
                && !is_team(addr)
                && !auctions.contains(addr)
                && !as_of.runners.shared.contains(addr)
        })
        .map(|(addr, a)| (addr, a.held.max(0), a.free.max(0)))
        .filter(|(_, held, free)| *held > 0 || *free > 0)
        .collect();
    holder_list.sort_by(|a, b| (b.1 + b.2).cmp(&(a.1 + a.2)).then(a.0.cmp(&b.0)));
    let holder_count = holder_list.len();
    let holders: Vec<Value> = holder_list
        .into_iter()
        .take(MAX_LISTED)
        .map(|(addr, held, free)| json!({"account": addr, "held": held.to_string(), "free": free.to_string()}))
        .collect();

    for (k, v) in &sums {
        treasury.insert((*k).to_owned(), json!(v.to_string()));
    }
    treasury.insert("handedBackCount".into(), json!(handed_back_count));
    treasury.insert("runner".into(), json!(runner));

    let runs_until = clock.end();
    let quiet_since = if let Some(t) = wound_down_at {
        Some(t)
    } else if clock.paused {
        paused_at
    } else {
        runs_until.filter(|end| *end <= as_of.time)
    };
    let stage_now = match open_at {
        Some(at) if as_of.time >= at => "open",
        _ => stage,
    };

    Ok(Some(json!({
        "version": 1,
        "chainId": as_of.chain_id,
        "launcher": hex0x(&as_of.launcher),
        "key": hex0x(key),
        "projectId": field(launch, "projectId")?,
        "founder": founder,
        "launchedAt": launched_at,
        "projectZero": project_zero,
        "earlierBackers": earlier_backers,
        "contracts": {
            "shares": own[0], "treasury": own[1], "vester": own[2], "finisher": own[3], "rounds": own[4],
            "pair": pair,
        },
        "stage": {"name": stage, "since": stage_since, "openAt": open_at},
        "eligible": eligible,
        "noMarketFrom": no_market_from,
        "noMarketAt": no_market_at,
        "woundDownAt": wound_down_at,
        "raised": {
            "total": total_raised.to_string(),
            "cap": cap.to_string(),
            "left": cap.saturating_sub(total_raised).to_string(),
        },
        "averagePrice": average,
        "rounds": round_list,
        "clock": {
            "lastCheckIn": clock.last_check_in,
            "runsUntil": runs_until,
            "paused": clock.paused,
            "woundDown": clock.wound_down,
        },
        "receipts": receipts,
        "receiptCount": receipt_count,
        "holders": holders,
        "holderCount": holder_count,
        "truncated": receipt_count > MAX_LISTED || holder_count > MAX_LISTED,
        "treasury": treasury,
        "sale": if sale.is_empty() { Value::Null } else { Value::Object(sale) },
        "reserveSales": reserve_sales,
        "bids": market.bids_json(),
        "pool": market.pool_json(),
        "asOf": {"block": as_of.block, "time": as_of.time},
        "now": {
            "stage": stage_now,
            "activeSeconds": active_now,
            "quietSince": quiet_since,
            "refunds": refunds_now,
        },
    })))
}

/// `Rounds.refundable(id, backer)` for a settled position, on the active clock.
fn refundable(p: &Position, active_now: u64, active_at_close: u64, fee_bps: u128) -> u128 {
    if p.held_money == 0 || p.held_total == 0 {
        return 0;
    }
    // A refund cancels what is still held (`Vester.cancelHeld` sets the grant's
    // total to what was claimed), so after it nothing is left to take back.
    let still = p
        .held_total
        .saturating_sub(p.held_claimed)
        .saturating_sub(p.held_cancelled);
    if still == 0 {
        return 0;
    }
    let part = if still == p.held_total {
        p.held_money
    } else {
        p.held_money * still / p.held_total
    };
    let elapsed = u128::from(active_now.saturating_sub(active_at_close)).min(RELEASE);
    let released_up = ceil_div(part * elapsed, RELEASE);
    let unreleased = part.saturating_sub(released_up);
    unreleased - ceil_div(unreleased * fee_bps, BPS)
}

/// The part of the content that changes only with events: everything but
/// `asOf` and `now`.
pub fn facts_of(content: &Value) -> Value {
    let mut c = content.clone();
    if let Some(obj) = c.as_object_mut() {
        obj.remove("asOf");
        obj.remove("now");
    }
    c
}

/// The content without `asOf`, to tell whether anything a reader sees moved.
pub fn without_as_of(content: &Value) -> Value {
    let mut c = content.clone();
    if let Some(obj) = c.as_object_mut() {
        obj.remove("asOf");
    }
    c
}

#[path = "numbers_earlier.rs"]
mod numbers_earlier;
#[path = "numbers_market.rs"]
mod numbers_market;

#[cfg(test)]
#[path = "numbers_tests.rs"]
mod tests;
