//! The two step 4 keys of the numbers record, `pause` and `earlierGrants`, and the team's two additive fields
//! (`team.earlierPool`, `team.earlierReserve`): `docs/next-version/RECORD-V2.md` section 13.
//!
//! Each is `null` unless the project has the thing (a holder pause, the earlier backers' pool). A key that cannot be
//! worked out, or whose own checks fail, is signed `null` and its reason is returned for the log: nothing else in the
//! record depends on it (`team.ungranted` reads the Vester's own `earlierReserve`, which is part of the main batch).
//!
//! Nothing here is per person. The pause key says how many accounts have Shares parked, never which. The claim key
//! says how many rows were claimed and how many Team Shares they granted, never whose; the list's rows are not known
//! to the server at all (only its fingerprint is).

use anyhow::{anyhow, bail};
use serde::{Deserialize, Serialize};

use super::ledger::Ledger;
use super::record::{amount, is_hex, Record};
use super::views::{EarlierViews, PauseViews, Views};

/// The most accounts with parked Shares the key may count before it reads as broken.
pub const MAX_PARKERS: u64 = 1_000_000;
/// The largest earlier pool the claim contract accepts (`EarlierGrants.MAX_EARLIER_POOL`, 1e9 whole Team Shares).
pub const MAX_EARLIER_POOL: u128 = 1_000_000_000_000_000_000_000_000_000;
/// The pause's line is one this-many-th of the backers' Shares, within these limits, or the key reads as broken.
const LINE_DIVISOR_RANGE: std::ops::RangeInclusive<u128> = 2..=100;

/// The holder pause (18 decimals for Shares, seconds for times).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PauseRec {
    /// The project's pause contract.
    pub contract: String,
    /// Shares parked now.
    pub parked_total: String,
    /// The parked Shares that make the line (a third of the backers' Shares, rounded up).
    pub line: String,
    /// The warning period in seconds (24 hours on a real network).
    pub day_length: u64,
    /// The line is one this-many-th of the backers' Shares (3: a third).
    pub line_divisor: u64,
    /// When the line was first seen reached in an unbroken run; none when it is not armed.
    pub armed_at: Option<u64>,
    /// When the pause starts if the line stays reached (`armedAt` plus `dayLength`); none when it is not armed.
    pub pauses_from: Option<u64>,
    /// Whether the team's draws and new task plans are refused at `asOf.time`.
    pub paused: bool,
    /// When the pause began (while it is on); none otherwise.
    pub since: Option<u64>,
    /// How many accounts have Shares parked (a count only, never a name).
    pub parker_count: u64,
}

/// The earlier backers' claim contract (18 decimals for Team Shares).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct EarlierGrantsRec {
    /// The claim contract.
    pub contract: String,
    /// Whether it is tied to the project's Vester (claims can start).
    pub bound: bool,
    /// The list's fingerprint (a Merkle root); the rows themselves are not here or anywhere on the server.
    pub root: String,
    /// The text's fingerprint a claimant accepts in the same call.
    pub text_hash: String,
    /// The pool: the most the rows can claim in all.
    pub total: String,
    /// How many rows the list has.
    pub rows: u64,
    /// How many rows were claimed.
    pub claimed_rows: u64,
    /// The Team Shares granted by claims.
    pub claimed_total: String,
    /// How long a claimed grant takes to vest, in seconds (calendar time, counted from the project's birth).
    pub clock_secs: u64,
}

/// What a step 4 key came to: the value, and a line to log when it was left `null` for a reason.
pub type Built<T> = (Option<T>, Option<String>);

/// The `pause` key: `null` when the project has no pause, or when it could not be read or did not agree with the
/// events and the arithmetic of the rule (RECORD-V2 section 13).
pub fn pause(ledger: &Ledger, v: &Views, time: u64) -> Built<PauseRec> {
    let Some(read) = &v.pause else {
        return (None, None);
    };
    let outcome = match read {
        Ok(read) => pause_from(ledger, v, read, time),
        Err(e) => Err(anyhow!("{e}")),
    };
    match outcome {
        Ok(rec) => (Some(rec), None),
        Err(e) => (None, Some(format!("pause: left null: {e:#}"))),
    }
}

fn pause_from(ledger: &Ledger, v: &Views, p: &PauseViews, time: u64) -> anyhow::Result<PauseRec> {
    if ledger.contracts.pause.as_deref() != Some(p.address.as_str()) {
        bail!("the pause read is not the one the Treasury named");
    }
    let seen = &ledger.pause_seen;
    let backers = v.shares_supply;
    // The events, the pause's own numbers and the Share token's supply must all say the same.
    if p.parked_total != seen.parked_total {
        bail!(
            "the events add up to {} parked, the pause says {}",
            seen.parked_total,
            p.parked_total
        );
    }
    if p.backer_shares != backers {
        bail!(
            "the pause read {} backer Shares, the Share token says {backers}",
            p.backer_shares
        );
    }
    if p.parked_total > backers {
        bail!(
            "{} parked is more than the {backers} backer Shares",
            p.parked_total
        );
    }
    if !LINE_DIVISOR_RANGE.contains(&p.line_divisor) {
        bail!(
            "the line divisor {} is outside {LINE_DIVISOR_RANGE:?}",
            p.line_divisor
        );
    }
    let want_line = backers.div_ceil(p.line_divisor);
    if p.line != want_line {
        bail!(
            "the line is {} but {backers} backer Shares give {want_line}",
            p.line
        );
    }
    if p.day == 0 || p.day != ledger.unit / 7 {
        bail!(
            "the warning period is {} seconds, a seventh of the {} unit is {}",
            p.day,
            ledger.unit,
            ledger.unit / 7
        );
    }
    if p.armed_at != seen.armed_at {
        bail!(
            "the events say it was armed at {}, the pause says {}",
            seen.armed_at,
            p.armed_at
        );
    }
    if p.armed_at > time {
        bail!("armedAt {} is after the block's time {time}", p.armed_at);
    }
    let want_from = if p.armed_at == 0 {
        0
    } else {
        p.armed_at + p.day
    };
    if p.pauses_from != want_from {
        bail!(
            "pausesFrom is {} but armedAt and the warning period give {want_from}",
            p.pauses_from
        );
    }
    // The rule, worked out here and compared with the contract's own answer at the same block's time.
    let reached = backers != 0 && p.parked_total.saturating_mul(p.line_divisor) >= backers;
    let want_paused = p.armed_at != 0 && time >= want_from && reached;
    if p.paused != want_paused {
        bail!(
            "the pause says paused is {} but its numbers give {want_paused}",
            p.paused
        );
    }
    let parkers = seen.parker_count();
    if parkers > MAX_PARKERS {
        bail!("{parkers} accounts have Shares parked");
    }
    if (p.parked_total == 0) != (parkers == 0) {
        bail!("{parkers} accounts have {} Shares parked", p.parked_total);
    }
    Ok(PauseRec {
        contract: p.address.clone(),
        parked_total: p.parked_total.to_string(),
        line: p.line.to_string(),
        day_length: p.day,
        line_divisor: u64::try_from(p.line_divisor)?,
        armed_at: (p.armed_at != 0).then_some(p.armed_at),
        pauses_from: (want_from != 0).then_some(want_from),
        paused: p.paused,
        since: p.paused.then_some(want_from),
        parker_count: parkers,
    })
}

/// The `earlierGrants` key: `null` unless this project is the one the claim contract names, and `null` too when it
/// could not be read or did not agree with the events (RECORD-V2 section 13).
pub fn earlier(ledger: &Ledger, v: &Views) -> Built<EarlierGrantsRec> {
    let Some(read) = &v.earlier else {
        return (None, None);
    };
    let outcome = match read {
        Ok(read) => earlier_from(ledger, v, read),
        Err(e) => Err(anyhow!("{e}")),
    };
    match outcome {
        Ok(rec) => (Some(rec), None),
        Err(e) => (None, Some(format!("earlierGrants: left null: {e:#}"))),
    }
}

fn earlier_from(ledger: &Ledger, v: &Views, e: &EarlierViews) -> anyhow::Result<EarlierGrantsRec> {
    let Some(pool) = ledger.earlier_pool else {
        bail!("the project has no earlier pool");
    };
    if ledger.contracts.earlier.as_deref() != Some(e.address.as_str()) {
        bail!("the claim contract read is not the one the Launcher named");
    }
    if e.total != pool {
        bail!(
            "the Launcher funded {pool} but the claim contract's pool is {}",
            e.total
        );
    }
    if e.total == 0 || e.total > MAX_EARLIER_POOL {
        bail!("the pool {} is outside 1 to {MAX_EARLIER_POOL}", e.total);
    }
    if e.rows == 0 || e.rows > u128::from(u32::MAX) {
        bail!("{} rows is outside 1 to {}", e.rows, u32::MAX);
    }
    if e.claimed_rows > e.rows || e.claimed_total > e.total {
        bail!(
            "{} rows and {} claimed are more than the list holds",
            e.claimed_rows,
            e.claimed_total
        );
    }
    let (rows, total) = ledger.earlier_claimed;
    if e.claimed_rows != u128::from(rows) || e.claimed_total != total {
        bail!(
            "the events add up to {rows} rows and {total} claimed, the contract says {} and {}",
            e.claimed_rows,
            e.claimed_total
        );
    }
    let zero = "0x0000000000000000000000000000000000000000";
    let bound = e.vester != zero;
    if bound != ledger.earlier_bound {
        bail!(
            "the contract's Vester is {} but the events say bound is {}",
            e.vester,
            ledger.earlier_bound
        );
    }
    if bound && e.vester != ledger.contracts.vester {
        bail!(
            "the claim contract is tied to {}, not to the project's Vester",
            e.vester
        );
    }
    Ok(EarlierGrantsRec {
        contract: e.address.clone(),
        bound,
        root: e.root.clone(),
        text_hash: e.text_hash.clone(),
        total: e.total.to_string(),
        rows: u64::try_from(e.rows)?,
        claimed_rows: u64::try_from(e.claimed_rows)?,
        claimed_total: e.claimed_total.to_string(),
        clock_secs: u64::try_from(v.v("PROTECTED_LENGTH")?)?,
    })
}

/// The rules of the two keys over a finished record (called from [`super::record::validate`]); a key that is `null`
/// has none.
pub fn check(r: &Record, bad: &mut Vec<String>) -> anyhow::Result<()> {
    let mut rule = |ok: bool, what: String| {
        if !ok {
            bad.push(what);
        }
    };
    if let Some(p) = &r.pause {
        rule(
            is_hex(&p.contract, 20) && r.contracts.pause.as_deref() == Some(p.contract.as_str()),
            "pause.contract is not contracts.pause".into(),
        );
        let (parked, line, backers) = (
            amount(&p.parked_total, "pause.parkedTotal")?,
            amount(&p.line, "pause.line")?,
            amount(&r.shares.backers, "shares.backers")?,
        );
        rule(
            parked <= backers,
            format!("pause.parkedTotal {parked} is more than the {backers} backer Shares"),
        );
        rule(
            line <= backers,
            format!("pause.line {line} is more than the {backers} backer Shares"),
        );
        rule(
            p.line_divisor != 0 && line == backers.div_ceil(u128::from(p.line_divisor)),
            "pause.line is not the backer Shares over pause.lineDivisor, rounded up".into(),
        );
        rule(
            p.armed_at.map(|a| a + p.day_length) == p.pauses_from,
            "pause.pausesFrom is not armedAt plus dayLength".into(),
        );
        rule(
            p.since == if p.paused { p.pauses_from } else { None },
            "pause.since is pausesFrom while paused and none otherwise".into(),
        );
        rule(
            !p.paused
                || (p.pauses_from.is_some_and(|f| f <= r.as_of.time)
                    && parked.saturating_mul(u128::from(p.line_divisor)) >= backers),
            "pause.paused is on before its start or under the line".into(),
        );
        rule(
            p.parker_count <= MAX_PARKERS,
            "pause.parkerCount is past its bound".into(),
        );
        rule(
            (parked == 0) == (p.parker_count == 0),
            "pause.parkerCount and pause.parkedTotal disagree about whether anything is parked"
                .into(),
        );
    }
    if let Some(e) = &r.earlier_grants {
        let (total, claimed) = (
            amount(&e.total, "earlierGrants.total")?,
            amount(&e.claimed_total, "earlierGrants.claimedTotal")?,
        );
        rule(
            is_hex(&e.contract, 20) && is_hex(&e.root, 32) && is_hex(&e.text_hash, 32),
            "earlierGrants has a contract, root or text fingerprint that is not lower-case hex"
                .into(),
        );
        rule(
            claimed <= total && total <= MAX_EARLIER_POOL,
            "earlierGrants.claimedTotal or total is past its bound".into(),
        );
        rule(
            e.claimed_rows <= e.rows,
            "earlierGrants.claimedRows is more than rows".into(),
        );
        rule(
            r.team.earlier_pool.as_deref() == Some(e.total.as_str()),
            "earlierGrants.total is not team.earlierPool".into(),
        );
    }
    // The reserve is what the pool has left; the runner can grant only what the reserve does not hold back.
    match (&r.team.earlier_pool, &r.team.earlier_reserve) {
        (Some(pool), Some(reserve)) => {
            let (pool, reserve) = (
                amount(pool, "team.earlierPool")?,
                amount(reserve, "team.earlierReserve")?,
            );
            rule(
                reserve <= pool,
                format!("team.earlierReserve {reserve} is more than team.earlierPool {pool}"),
            );
            if let Some(e) = &r.earlier_grants {
                rule(
                    pool.checked_sub(amount(&e.claimed_total, "earlierGrants.claimedTotal")?)
                        == Some(reserve),
                    "team.earlierReserve is not team.earlierPool less earlierGrants.claimedTotal"
                        .into(),
                );
            }
        }
        (None, None) => {}
        _ => rule(
            false,
            "team.earlierPool and team.earlierReserve are both set or both none".into(),
        ),
    }
    Ok(())
}
