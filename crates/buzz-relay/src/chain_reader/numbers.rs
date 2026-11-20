//! The project numbers record (kind 39009), version 2: where it is built.
//!
//! A record is built from two things read at **one** block, `asOf.block`: the
//! project's [`Ledger`] (its stored events, up to and including that block)
//! and the contracts' own views called at that block number (`views`). Where
//! a view has the number, the view's number is used and never recomputed; the
//! one formula the server repeats is the settled snapshot of section 3
//! (`record::roll_forward`), and it is checked against two views on every
//! build. Before a record is returned, every cross-check of section 4.3 runs:
//! the ledger the events rebuild must equal the contracts' stored numbers, the
//! views must agree with the events on everything both know, and
//! [`record::validate`] must find nothing wrong. Any failure is an error that
//! names each field and both values: the caller keeps the previous record and
//! tries again at its next pass. Nothing here turns a failed read, or a
//! disagreement, into a zero or an empty record.

use std::collections::BTreeSet;

use anyhow::{anyhow, bail, Context};
use serde_json::Value;

use super::ledger::{GrantState, Ledger, Stored as LedgerStored, StoredBook};
use super::numbers_tasks;
use super::record::{
    self, quiet_state, roll_forward, AgentRec, AllowanceRec, AsOfRec, ClockRec, ContractsRec,
    DoorRec, FeeRec, ForfeitRec, GrantKind, GrantRec, GrantStateRec, HolderRec, LedgerRec,
    LimitsRec, MoneyRec, PendingRec, QuietRec, Record, RunnerRec, SharesRec, Stored, TeamRec,
    TotalsRec, WindDownRec, WorthRec, DORMANT_UNITS, MAX_AGENTS, MAX_GRANTS, MAX_HOLDERS,
};
use super::record_tasks;
use super::source::ChainSource;
use super::views::{self, Views};
use super::word::hex0x;

pub use super::ledger::LogRow;

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
}

/// How often the server promises a fresh record (`refreshEverySecs`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Cadence {
    /// While the allowance is accruing or outside money is arriving.
    pub active_secs: u64,
    /// Otherwise: a heartbeat.
    pub idle_secs: u64,
}

impl Default for Cadence {
    fn default() -> Self {
        Self {
            active_secs: 600,
            idle_secs: 3_600,
        }
    }
}

/// Read the views at `as_of.block` and build the project's record: a JSON
/// value of the shape of `docs/next-version/record-v2-example.json`.
pub async fn derive(
    source: &dyn ChainSource,
    ledger: &Ledger,
    as_of: &AsOf,
    cadence: &Cadence,
    built_at: u64,
) -> anyhow::Result<Value> {
    let read = views::read(source, as_of.launcher, ledger, as_of.block, as_of.time).await?;
    super::note_play_money(read.test_network);
    let record = build(ledger, as_of, &read, cadence, built_at)?;
    serde_json::to_value(&record).context("write the record")
}

fn put(problems: &mut Vec<String>, field: &str, events: impl ToString, view: impl ToString) {
    problems.push(format!(
        "{field}: events say {}, the contract says {}",
        events.to_string(),
        view.to_string()
    ));
}

/// Where the events and the contracts' views must agree, beyond what the
/// ledger already checks against the stored numbers.
fn cross_check(ledger: &Ledger, v: &Views, t: u64) -> anyhow::Result<Vec<String>> {
    let unit = v.t64("unit")?;
    let book = v
        .book
        .as_ref()
        .map(|b| -> anyhow::Result<StoredBook> {
            Ok(StoredBook {
                open_count: b.open_count,
                next_serial: b.next_serial,
                window_sum_bps: b.window_sum_bps,
                at: t,
                span: b.cap_window_secs(unit)?,
            })
        })
        .transpose()?;
    let stored = LedgerStored {
        locked: v.t("locked")?,
        notes_owed: v.t("notesOwed")?,
        arrival_start: v.t64("arrivalStart")?,
        arrival_total: v.t("arrivalTotal")?,
        book,
        pot: v.t("pot")?,
        paid_in: v.t("paidIn")?,
        box_: v.t("box")?,
        arriving: v.t("arriving")?,
        fees_owed: v.t("feesOwed")?,
        z: v.t("Z")?,
        active_seconds: v.t("activeSeconds")?,
        last_settle: v.t64("lastSettle")?,
        shares_supply: v.shares_supply,
        team_supply: v.team_supply,
        vester_team_balance: v.vester_team_balance,
    };
    let mut bad: Vec<String> = ledger
        .mismatches(&stored)
        .iter()
        .map(|m| {
            format!(
                "{}: events add up to {}, the contract says {}",
                m.field, m.ledger, m.view
            )
        })
        .collect();
    if ledger.runner != v.runner {
        put(&mut bad, "runner", &ledger.runner, &v.runner);
    }
    if v.v("grantCount")? != ledger.grants.len() as u128 {
        put(
            &mut bad,
            "grantCount",
            ledger.grants.len(),
            v.v("grantCount")?,
        );
    }
    if v.v("committed")? != ledger.committed() {
        put(&mut bad, "committed", ledger.committed(), v.v("committed")?);
    }
    if v.door_flag != ledger.door_open {
        put(&mut bad, "doorFlag", ledger.door_open, v.door_flag);
    }
    if v.t("ratePpm")? != u128::from(ledger.rate_ppm) {
        put(&mut bad, "ratePpm", ledger.rate_ppm, v.t("ratePpm")?);
    }
    let (pending_rate, pending_at) = (v.t("pendingRatePpm")?, v.t64("pendingAt")?);
    match ledger.pending_rate {
        Some(p) => {
            if pending_rate != u128::from(p.ppm) || pending_at != p.proposed_at {
                put(
                    &mut bad,
                    "pending rate",
                    format!("{} at {}", p.ppm, p.proposed_at),
                    format!("{pending_rate} at {pending_at}"),
                );
            }
        }
        None => {
            if pending_rate != 0 || pending_at != 0 {
                put(
                    &mut bad,
                    "pending rate",
                    "none",
                    format!("{pending_rate} at {pending_at}"),
                );
            }
        }
    }
    if v.t64("lastCheckIn")? != ledger.last_check_in {
        put(
            &mut bad,
            "lastCheckIn",
            ledger.last_check_in,
            v.t64("lastCheckIn")?,
        );
    }
    let (kind, at) = (v.t("windDownKind")?, v.t64("windDownAt")?);
    match ledger.wind_down {
        Some(w) => {
            if kind != u128::from(w.kind) || at != w.at {
                put(
                    &mut bad,
                    "wind-down",
                    format!("{} at {}", w.kind, w.at),
                    format!("{kind} at {at}"),
                );
            }
        }
        None => {
            if kind != 0 {
                put(&mut bad, "wind-down", "none", format!("{kind} at {at}"));
            }
        }
    }
    if v.t64("unit")? != ledger.unit {
        put(&mut bad, "unit", ledger.unit, v.t64("unit")?);
    }
    if v.t("feeBps")? != u128::from(ledger.fee_bps) {
        put(&mut bad, "feeBps", ledger.fee_bps, v.t("feeBps")?);
    }
    if v.t64("arrivalEnd")? != ledger.arrival_end {
        put(
            &mut bad,
            "arrivalEnd",
            ledger.arrival_end,
            v.t64("arrivalEnd")?,
        );
    }
    bad.extend(numbers_tasks::cross_check(ledger, v, t)?);
    for g in &v.grants {
        let Some(l) = ledger.grants.get(&g.id) else {
            bad.push(format!(
                "grant {} is in the Vester but its events were never read",
                g.id
            ));
            continue;
        };
        let state: u8 = match l.state {
            GrantState::Live => 0,
            GrantState::Announced => 1,
            GrantState::Closed => 2,
        };
        for (what, events, view) in [
            ("state", u128::from(state), u128::from(g.state)),
            ("keeps", l.total, g.total),
            ("claimed", l.claimed, g.claimed),
            ("start", l.start_active, g.start),
            ("burn", l.burn, g.burn),
            ("burnAt", u128::from(l.burn_at), u128::from(g.burn_at)),
        ] {
            if events != view {
                put(&mut bad, &format!("grant {} {what}", g.id), events, view);
            }
        }
        if l.member != g.member || l.protected != g.protected {
            put(
                &mut bad,
                &format!("grant {} member or kind", g.id),
                format!("{} {}", l.member, l.protected),
                format!("{} {}", g.member, g.protected),
            );
        }
    }
    Ok(bad)
}

fn grant_state(state: u8) -> anyhow::Result<GrantStateRec> {
    Ok(match state {
        0 => GrantStateRec::Live,
        1 => GrantStateRec::Announced,
        2 => GrantStateRec::Closed,
        n => bail!("grant state {n} is not known"),
    })
}

/// Build the record from a ledger and the views read at its block. Every
/// check of RECORD-V2 section 4.3 runs here; an `Err` means "do not publish".
pub fn build(
    ledger: &Ledger,
    as_of: &AsOf,
    v: &Views,
    cadence: &Cadence,
    built_at: u64,
) -> anyhow::Result<Record> {
    if v.block != as_of.block {
        bail!(
            "the views were read at block {}, not {}",
            v.block,
            as_of.block
        );
    }
    let t = as_of.time;
    let bad = cross_check(ledger, v, t)?;
    if !bad.is_empty() {
        bail!(
            "the events and the contracts disagree, nothing is published: {}",
            bad.join("; ")
        );
    }

    let unit = v.t64("unit")?;
    let rate = u32::try_from(v.t("ratePpm")?).context("ratePpm")?;
    let active_end = v.t64("activeEnd")?;
    let last_settle = v.t64("lastSettle")?;
    let stored = Stored {
        last_settle,
        active_end,
        arrival_end: v.t64("arrivalEnd")?,
        arrival_start: v.t64("arrivalStart")?,
        arrival_total: v.t("arrivalTotal")?,
        rate_ppm: rate,
        unit,
        pot: v.t("pot")?,
        box_: v.t("box")?,
        arriving: v.t("arriving")?,
        active_seconds: v.t("activeSeconds")?,
        locked: v.t("locked")?,
        due_c: v.book.as_ref().map_or(0, |b| b.due_c),
    };
    let settled = roll_forward(t, &stored)?;
    // The two views that are the contract's own settled numbers.
    let view_cap = v.t("boxCap")?;
    let mut bad = Vec::new();
    if settled.box_cap(rate) != Some(view_cap) {
        put(
            &mut bad,
            "boxCap (settled pot and box)",
            settled.box_cap(rate).map_or(0, |c| c),
            view_cap,
        );
    }
    if settled.active_seconds != v.t("activeNow")? {
        put(
            &mut bad,
            "activeNow (settled active time)",
            settled.active_seconds,
            v.t("activeNow")?,
        );
    }
    if !bad.is_empty() {
        bail!(
            "the settled numbers do not match the contract, nothing is published: {}",
            bad.join("; ")
        );
    }

    let wind = match v.t("windDownKind")? {
        0 => None,
        kind => Some(WindDownRec {
            kind: u8::try_from(kind).context("windDownKind")?,
            at: v.t64("windDownAt")?,
        }),
    };
    let wound = wind.is_some();

    // The quiet scale.
    let last_check_in = v.t64("lastCheckIn")?;
    let window_units = v.t64("CHECK_IN_MULT")?;
    let wind_units = v.t64("WIND_MULT")?;
    let (quiet, active_until) = match wind {
        Some(w) => (
            QuietRec {
                state: record::QuietState::WoundDown,
                since: w.at,
                quiet_from: None,
                dormant_from: None,
                windable_from: None,
                next: None,
            },
            None,
        ),
        None => {
            let quiet_from = active_end;
            let dormant_from = last_check_in + DORMANT_UNITS * unit;
            let windable_from = last_check_in + wind_units * unit;
            let state = quiet_state(t, quiet_from, dormant_from, windable_from);
            let since = match state {
                record::QuietState::Active => last_check_in,
                record::QuietState::Quiet => quiet_from,
                record::QuietState::Dormant => dormant_from,
                _ => windable_from,
            };
            (
                QuietRec {
                    state,
                    since,
                    quiet_from: Some(quiet_from),
                    dormant_from: Some(dormant_from),
                    windable_from: Some(windable_from),
                    next: record::next_state(state, quiet_from, dormant_from, windable_from),
                },
                Some(active_end),
            )
        }
    };

    // Grants (those not finished), by id.
    let cliff_len = u128::from(v.v64("CLIFF_MULT")?) * u128::from(unit);
    let vest_len = u128::from(v.v64("VEST_MULT")?) * u128::from(unit);
    let protected_len = v.v("PROTECTED_LENGTH")?;
    let active = settled.active_seconds;
    let after = |remaining: u128| -> anyhow::Result<u64> {
        u64::try_from(u128::from(t) + remaining).context("a vesting time is too large")
    };
    let mut grants = Vec::new();
    for g in &v.grants {
        let l = ledger
            .grants
            .get(&g.id)
            .ok_or_else(|| anyhow!("grant {} has no events", g.id))?;
        let state = grant_state(g.state)?;
        let live = state == GrantStateRec::Live;
        let (cliff, fully) = if !live {
            (None, None)
        } else if g.protected {
            let end = g.start + protected_len;
            (
                None,
                (u128::from(t) < end)
                    .then(|| u64::try_from(end).context("a vesting time is too large"))
                    .transpose()?,
            )
        } else {
            let cliff_at = g.start + cliff_len;
            let passed = active >= cliff_at;
            let ends = if passed || wound {
                None
            } else {
                Some(after(cliff_at - active)?)
            };
            let remaining = (g.start + vest_len).saturating_sub(active);
            let full = if remaining == 0 || wound {
                None
            } else {
                Some(after(remaining)?)
            };
            (
                Some(record::CliffRec {
                    passed,
                    ends_at_if_active: ends,
                }),
                full,
            )
        };
        let forfeit = if state == GrantStateRec::Announced {
            Some(ForfeitRec {
                amount: g.burn.to_string(),
                burn_at: g.burn_at,
                by_member: l.by_member.ok_or_else(|| {
                    anyhow!(
                        "grant {} is announced but no event said who announced it",
                        g.id
                    )
                })?,
            })
        } else {
            None
        };
        grants.push(GrantRec {
            id: g.id,
            member: g.member.clone(),
            kind: if g.protected {
                GrantKind::Protected
            } else {
                GrantKind::Normal
            },
            state,
            granted: l.granted.to_string(),
            keeps: g.total.to_string(),
            claimed: g.claimed.to_string(),
            vested: g.vested.to_string(),
            claimable: g.claimable.to_string(),
            start_active: u64::try_from(g.start).context("a grant's start")?,
            cliff,
            fully_vested_at_if_active: fully,
            forfeit,
        });
    }
    let unfinished = ledger
        .grants
        .values()
        .filter(|g| !(g.state == GrantState::Closed && g.claimed == g.total))
        .count();

    // Agents: live ones first, at most 50.
    let epoch = v.t("agentEpoch")?;
    let mut agents: Vec<AgentRec> = v
        .agents
        .iter()
        .map(|a| AgentRec {
            agent: a.agent.clone(),
            live: a.active && a.epoch_of == epoch,
            usd_cap: a.usd_cap.to_string(),
            team_cap: a.share_cap.to_string(),
            usd_used: a.usd_used.to_string(),
            team_used: a.team_used.to_string(),
        })
        .collect();
    agents.sort_by(|a, b| b.live.cmp(&a.live).then(a.agent.cmp(&b.agent)));
    let agents_cut = ledger.agents.len() > agents.len() || agents.len() > MAX_AGENTS;
    agents.truncate(MAX_AGENTS);

    // Holders.
    let launcher_hex = hex0x(&as_of.launcher);
    let all = ledger.holders(&BTreeSet::from([launcher_hex]));
    let holder_count = all.iter().filter(|h| h.shares != 0).count() as u64;
    let team_holder_count = all.iter().filter(|h| h.team != 0).count() as u64;
    let holders_cut = all.len() > MAX_HOLDERS;
    let holders: Vec<HolderRec> = all
        .into_iter()
        .take(MAX_HOLDERS)
        .map(|h| HolderRec {
            account: h.account,
            shares: h.shares.to_string(),
            team_shares: h.team.to_string(),
        })
        .collect();

    // Money and the allowance.
    let arrival_end = (settled.arriving != 0).then_some(stored.arrival_end);
    let day = unit / 7;
    let drawn_last_day: u128 = ledger
        .draws
        .iter()
        .filter(|(at, _)| at.saturating_add(day) > t)
        .map(|(_, amount)| *amount)
        .sum();
    // The raise waiting is the one the events gave; the cross-check above has
    // already proved the Treasury's own pending rate and time are the same
    // (a different or oversized number there refuses the build).
    let pending = ledger.pending_rate.map(|p| PendingRec {
        rate_ppm: p.ppm,
        proposed_at: p.proposed_at,
        applicable_at: p.proposed_at.saturating_add(unit),
    });
    let accruing = rate > 0 && settled.pot > 0 && !wound && t < active_end;
    let refresh = refresh_every(
        cadence,
        accruing,
        settled.arriving != 0,
        ledger.tasks.open_count > 0,
    );
    let in_vester = v.vester_team_balance;
    let counted = v.team_supply;
    let promised = v.v("committed")?;

    let record = Record {
        version: record::VERSION,
        chain_id: as_of.chain_id,
        launcher: hex0x(&as_of.launcher),
        key: ledger.key.clone(),
        project_id: ledger.project_id.clone(),
        founder: ledger.founder.clone(),
        launched_at: ledger.launched_at,
        play_money: v.test_network,
        contracts: ContractsRec {
            treasury: ledger.contracts.treasury.clone(),
            shares: ledger.contracts.shares.clone(),
            team: ledger.contracts.team.clone(),
            vester: ledger.contracts.vester.clone(),
            dollar: ledger.contracts.dollar.clone(),
            pair: ledger.pair.clone(),
        },
        as_of: AsOfRec {
            block: as_of.block,
            time: as_of.time,
        },
        built_at,
        refresh_every_secs: refresh,
        unit,
        fee: FeeRec {
            bps: u32::try_from(v.t("feeBps")?).context("feeBps")?,
        },
        money: MoneyRec {
            pot: settled.pot.to_string(),
            paid_in: v.t("paidIn")?.to_string(),
            arriving: settled.arriving.to_string(),
            arrival_end,
            fees_owed: v.t("feesOwed")?.to_string(),
            locked: settled.locked.to_string(),
            notes_owed: v.t("notesOwed")?.to_string(),
            held: v.dollar_held.to_string(),
        },
        shares: SharesRec {
            backers: v.shares_supply.to_string(),
            team_counted: counted.to_string(),
            announced_burn: v.t("Z")?.to_string(),
        },
        worth: WorthRec {
            leave_value: v.t("leaveValue")?.to_string(),
            team_value: v.t("teamValue")?.to_string(),
        },
        allowance: AllowanceRec {
            rate_ppm: rate,
            pending,
            box_: settled.box_.to_string(),
            // A wound-down project's box is closed: nothing can accrue in it.
            box_cap: if wound {
                "0".into()
            } else {
                view_cap.to_string()
            },
            drawn_last_day: drawn_last_day.to_string(),
        },
        clock: ClockRec {
            last_check_in,
            last_record_hash: ledger.last_record_hash.clone(),
            active_until,
            active_seconds: u64::try_from(active).context("active seconds")?,
        },
        door: DoorRec {
            switch_on: v.door_flag,
            open_now: v.door_open_now,
            shuts_at: active_until,
        },
        quiet,
        wind_down: wind,
        runner: RunnerRec {
            address: v.runner.clone(),
            is_pair: v.is_pair,
            signers: v.signers.clone(),
        },
        team: TeamRec {
            pool: ledger.team_pool.to_string(),
            in_hands: counted
                .checked_sub(in_vester)
                .ok_or_else(|| anyhow!("the Vester holds {in_vester} Team Shares of {counted}"))?
                .to_string(),
            in_vester: in_vester.to_string(),
            promised: promised.to_string(),
            ungranted: in_vester
                .checked_sub(promised)
                .ok_or_else(|| {
                    anyhow!("the Vester holds {in_vester} Team Shares but promised {promised}")
                })?
                .to_string(),
            grant_count: v.v64("grantCount")?,
            grants,
        },
        agents,
        limits: LimitsRec {
            min_join: v.t("MIN_JOIN")?.to_string(),
            min_outside_payment: v.t("MIN_REVENUE")?.to_string(),
            max_rate_ppm: u32::try_from(v.t("MAX_RATE_PPM")?).context("MAX_RATE_PPM")?,
            check_in_window_units: window_units,
            wind_down_units: wind_units,
            cliff_units: v.v64("CLIFF_MULT")?,
            vest_units: v.v64("VEST_MULT")?,
            min_grant: v.v("MIN_GRANT")?.to_string(),
            max_grants_per_member: v.v64("MAX_GRANTS_PER_MEMBER")?,
            agent_usd_per_day: v.t("agentUsd")?.to_string(),
            agent_team_per_day: v.t("agentTeam")?.to_string(),
        },
        totals: TotalsRec {
            joined: ledger.totals.joined.to_string(),
            fees: ledger.totals.fees.to_string(),
            took_out: ledger.totals.took_out.to_string(),
            drawn: ledger.totals.drawn.to_string(),
            outside: ledger.totals.outside.to_string(),
            paid_to_workers: ledger.totals.paid_to_workers.to_string(),
            note_claims: ledger.totals.note_claims.to_string(),
        },
        first_backed_at: ledger.first_backed_at,
        holders,
        holder_count,
        team_holder_count,
        truncated: holders_cut || agents_cut || unfinished > MAX_GRANTS,
        tasks: record_tasks::build(ledger, v, t, settled.pot)?,
        ledger: LedgerRec {
            last_settle,
            pot: stored.pot.to_string(),
            box_: stored.box_.to_string(),
            arriving: stored.arriving.to_string(),
            arrival_end: (stored.arriving != 0).then_some(stored.arrival_end),
            arrival_start: stored.arrival_start,
            arrival_total: stored.arrival_total.to_string(),
            active_seconds: u64::try_from(stored.active_seconds).context("active seconds")?,
            locked: stored.locked.to_string(),
            notes_owed: v.t("notesOwed")?.to_string(),
        },
    };
    let problems = record::validate(&record);
    if !problems.is_empty() {
        bail!(
            "the record fails its own checks, nothing is published: {}",
            problems.join("; ")
        );
    }
    Ok(record)
}

/// How often the server promises a fresh record: often while something moves
/// with the clock, a heartbeat otherwise. The allowance accrues, outside money
/// arrives, or a task is open (announced or taken): a notice ends, a window
/// closes, room comes back in the cap, so what a holder is told about it is
/// kept fresh.
pub fn refresh_every(
    cadence: &Cadence,
    accruing: bool,
    money_arriving: bool,
    tasks_open: bool,
) -> u64 {
    if accruing || money_arriving || tasks_open {
        cadence.active_secs
    } else {
        cadence.idle_secs
    }
}

/// Paths of numbers that move with time, not with events: they change every
/// block of a living project, so they say nothing about whether anything
/// happened. `*` stands for every item of a list.
const MOVES_WITH_TIME: &[&[&str]] = &[
    &["refreshEverySecs"],
    &["money", "pot"],
    &["money", "locked"],
    &["money", "arriving"],
    &["money", "arrivalEnd"],
    &["money", "held"],
    &["allowance", "box"],
    &["allowance", "boxCap"],
    &["allowance", "drawnLastDay"],
    &["value"],
    &["door", "openNow"],
    &["clock", "activeSeconds"],
    &["quiet", "state"],
    &["quiet", "since"],
    &["quiet", "next"],
    &["team", "grants", "*", "vested"],
    &["team", "grants", "*", "claimable"],
    &["team", "grants", "*", "cliff"],
    &["team", "grants", "*", "fullyVestedAtIfActive"],
    &["agents", "*", "usdUsed"],
    &["agents", "*", "teamUsed"],
    &["ledger", "lastSettle"],
    &["tasks", "list", "*", "atMostNow"],
    &["tasks", "cap", "usedBps"],
    &["tasks", "cap", "roomBps"],
    &["tasks", "next"],
];

fn strip(value: &mut Value, path: &[&str]) {
    let Some((head, rest)) = path.split_first() else {
        return;
    };
    match value {
        Value::Array(items) if *head == "*" => {
            for item in items {
                strip(item, rest);
            }
        }
        Value::Object(map) => {
            if rest.is_empty() {
                map.remove(*head);
            } else if let Some(inner) = map.get_mut(*head) {
                strip(inner, rest);
            }
        }
        _ => {}
    }
}

/// The part of the content that changes only with events: what a record says
/// about the project's history, with the time-moving numbers, `builtAt` and
/// `asOf` taken out.
pub fn facts_of(content: &Value) -> Value {
    let mut c = without_as_of(content);
    for path in MOVES_WITH_TIME {
        strip(&mut c, path);
    }
    c
}

/// The content without `asOf` and `builtAt`: what a reader sees, to tell
/// whether anything moved since the last record.
pub fn without_as_of(content: &Value) -> Value {
    let mut c = content.clone();
    if let Some(obj) = c.as_object_mut() {
        obj.remove("asOf");
        obj.remove("builtAt");
    }
    c
}
