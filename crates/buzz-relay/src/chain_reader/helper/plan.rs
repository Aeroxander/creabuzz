//! The job builder: which calls are due, worked out from one project's FINAL
//! logs only (the reader's rows at least the confirmation depth under the
//! head) as of one final block. Pure: no node, no database.
//!
//! A job names the row that made it due (`due_block`), so a rollback past that
//! row deletes it. Whether a due call would still do something is checked
//! again at the head right before it is sent (`super::check`): this builder
//! only says when to look.

use std::collections::{BTreeMap, BTreeSet};

use anyhow::{anyhow, Context};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::calls::HelperCall;
use crate::chain_reader::events::Role;
use crate::chain_reader::numbers::LogRow;
use crate::chain_reader::word::{hex0x, parse_fixed, Word};

/// One week, the period of the repeating jobs.
pub const WEEK: u64 = 7 * 86_400;
/// One day, the period of the earlier backers' delivery.
pub const DAY: u64 = 86_400;
/// `Finisher`'s `ABANDON_DELAY_BLOCKS`: seven days of 12-second blocks after
/// the sale's last block.
pub const ABANDON_DELAY_BLOCKS: u64 = 50_400;
/// `EarlierBackers` refuses more entries than this.
pub const MAX_EARLIER_ENTRIES: u64 = 64;

/// A call that is due, and why.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Job {
    /// Unique per reader: the call, its target, its arguments and, for a
    /// repeating call, its period.
    pub key: String,
    /// The call.
    pub call: HelperCall,
    /// The project.
    pub project_key: Word,
    /// The final block of the row that made it due.
    pub due_block: u64,
    /// A repeating call (a weekly release, a sweep): "nothing to do" ends this
    /// period's job for good. A one-off call (a close) is looked at again if
    /// its effect has not reached the final rows by the time they pass the
    /// block where it was seen.
    pub repeats: bool,
}

/// A pool position the LiquidityHolder holds for a project (from the pool
/// events, when the reader follows them).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Position {
    /// The LiquidityHolder.
    pub holder: [u8; 20],
    /// The position's token id.
    pub token_id: Word,
    /// The block it was seen in.
    pub block: u64,
}

/// What the builder needs besides the logs.
#[derive(Clone, Debug)]
pub struct PlanContext {
    /// The newest final block.
    pub block: u64,
    /// Its time.
    pub time: u64,
    /// Backers per `settleMany`, entries per `deliverMany`.
    pub batch: usize,
}

fn text<'a>(row: &'a LogRow, name: &str) -> anyhow::Result<&'a str> {
    row.fields
        .get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("{}.{name} is missing", row.event))
}

fn addr(row: &LogRow, name: &str) -> anyhow::Result<[u8; 20]> {
    parse_fixed::<20>(text(row, name)?)
        .ok_or_else(|| anyhow!("{}.{name} is not an address", row.event))
}

fn amount(row: &LogRow, name: &str) -> anyhow::Result<u128> {
    text(row, name)?
        .parse::<u128>()
        .with_context(|| format!("{}.{name} is not an amount", row.event))
}

fn small(row: &LogRow, name: &str) -> anyhow::Result<u64> {
    u64::try_from(amount(row, name)?).with_context(|| format!("{}.{name} is too large", row.event))
}

fn project_addr(row: &LogRow, name: &str) -> anyhow::Result<[u8; 20]> {
    row.fields
        .get("project")
        .and_then(|p| p.get(name))
        .and_then(Value::as_str)
        .and_then(parse_fixed::<20>)
        .ok_or_else(|| anyhow!("ProjectLaunched.project.{name} is not an address"))
}

fn is(row: &LogRow, role: Role, event: &str) -> bool {
    row.role == role && row.event == event
}

fn short_digest(parts: &[String]) -> String {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p.as_bytes());
        h.update(b",");
    }
    hex::encode(&h.finalize()[..8])
}

struct Builder<'a> {
    key: Word,
    ctx: &'a PlanContext,
    out: Vec<Job>,
}

impl Builder<'_> {
    fn push(&mut self, key: String, call: HelperCall, due_block: u64, repeats: bool) {
        self.out.push(Job {
            key,
            call,
            project_key: self.key,
            due_block,
            repeats,
        });
    }

    fn week(&self) -> u64 {
        self.ctx.time / WEEK
    }
}

/// The jobs due for one project, from its final logs (oldest first) as of
/// `ctx`. `positions` are the project's pool positions (none until the reader
/// follows the pool events).
pub fn plan(
    key: &Word,
    logs: &[LogRow],
    positions: &[Position],
    ctx: &PlanContext,
) -> anyhow::Result<Vec<Job>> {
    let Some(launch) = logs
        .iter()
        .find(|r| is(r, Role::Launcher, "ProjectLaunched"))
    else {
        return Ok(Vec::new());
    };
    let rounds = project_addr(launch, "rounds")?;
    let treasury = project_addr(launch, "treasury")?;
    let vester = project_addr(launch, "vester")?;
    let finisher = project_addr(launch, "finisher")?;
    let batch = ctx.batch.max(1);
    let mut b = Builder {
        key: *key,
        ctx,
        out: Vec::new(),
    };
    let week = b.week();
    let r_hex = hex0x(&rounds);

    // ── Backing rounds ──────────────────────────────────────────────────────
    let mut opened: BTreeMap<u64, (u64, u64)> = BTreeMap::new(); // round -> (closesAt, block)
    let mut closed: BTreeMap<u64, (u128, u64, u64)> = BTreeMap::new(); // round -> (accepted, time, block)
    let mut asks: BTreeMap<(u64, [u8; 20]), u128> = BTreeMap::new();
    let mut settled: BTreeSet<(u64, [u8; 20])> = BTreeSet::new();
    let mut fees_block: Option<u64> = None;
    for r in logs.iter().filter(|r| r.role == Role::Rounds) {
        match r.event.as_str() {
            "RoundOpened" => {
                opened.insert(small(r, "round")?, (small(r, "closesAt")?, r.block));
            }
            "RoundClosed" => {
                closed.insert(
                    small(r, "round")?,
                    (amount(r, "accepted")?, r.time, r.block),
                );
            }
            "Asked" | "AskLowered" => {
                asks.insert(
                    (small(r, "round")?, addr(r, "backer")?),
                    amount(r, "total")?,
                );
            }
            "Settled" | "Refunded" => {
                settled.insert((small(r, "round")?, addr(r, "backer")?));
                fees_block = Some(r.block);
            }
            _ => {}
        }
    }
    for (&round, &(closes_at, block)) in &opened {
        if !closed.contains_key(&round) && ctx.time >= closes_at {
            b.push(
                format!("rounds.close:{r_hex}:{round}"),
                HelperCall::RoundsClose { rounds, round },
                block,
                false,
            );
        }
    }
    for (&round, &(accepted, closed_at, block)) in &closed {
        let waiting: Vec<[u8; 20]> = asks
            .iter()
            .filter(|((r, backer), total)| {
                *r == round && **total > 0 && !settled.contains(&(round, *backer))
            })
            .map(|((_, backer), _)| *backer)
            .collect();
        for chunk in waiting.chunks(batch) {
            let names: Vec<String> = chunk.iter().map(|a| hex0x(a)).collect();
            b.push(
                format!("rounds.settleMany:{r_hex}:{round}:{}", short_digest(&names)),
                HelperCall::RoundsSettleMany {
                    rounds,
                    round,
                    backers: chunk.to_vec(),
                },
                block,
                false,
            );
        }
        if accepted > 0 && ctx.time >= closed_at.saturating_add(WEEK) {
            b.push(
                format!("rounds.release:{r_hex}:{round}:w{week}"),
                HelperCall::RoundsRelease { rounds, round },
                block,
                true,
            );
        }
    }
    if let Some(block) = fees_block {
        b.push(
            format!("rounds.sweepFees:{r_hex}:w{week}"),
            HelperCall::RoundsSweepFees { rounds },
            block,
            true,
        );
    }

    // ── Treasury ────────────────────────────────────────────────────────────
    let t_hex = hex0x(&treasury);
    let first = |events: &[&str]| {
        logs.iter()
            .find(|r| r.role == Role::Treasury && events.contains(&r.event.as_str()))
            .map(|r| r.block)
    };
    // No round can open again: the market opened, "no market", a wind-down,
    // or an abandoned sale (which opens the pool flag without PoolOpened).
    if let Some(block) = first(&[
        "PoolOpened",
        "NoMarketDeclared",
        "WoundDown",
        "SaleAbandoned",
    ]) {
        b.push(
            format!("rounds.returnUnsold:{r_hex}:w{week}"),
            HelperCall::RoundsReturnUnsold { rounds },
            block,
            true,
        );
    }
    // Sale money went into the melting floor.
    if let Some(block) = first(&["Settled", "ReserveSaleSettled", "SaleAbandoned"]) {
        b.push(
            format!("treasury.release:{t_hex}:w{week}"),
            HelperCall::TreasuryRelease { treasury },
            block,
            true,
        );
    }
    // The platform's cut of exits.
    if let Some(block) = logs
        .iter()
        .rev()
        .find(|r| is(r, Role::Treasury, "HandedBack"))
        .map(|r| r.block)
    {
        b.push(
            format!("treasury.sweepFees:{t_hex}:w{week}"),
            HelperCall::TreasurySweepFees { treasury },
            block,
            true,
        );
    }

    // ── The sale's finish ──────────────────────────────────────────────────
    let f_hex = hex0x(&finisher);
    let for_auction = |event: &str, auction: &str| {
        logs.iter().any(|r| {
            is(r, Role::Finisher, event)
                && r.fields.get("auction").and_then(Value::as_str) == Some(auction)
        })
    };
    for sale in logs
        .iter()
        .filter(|r| is(r, Role::Finisher, "SaleOpenedBy"))
    {
        let auction = text(sale, "auction")?;
        let end_block = small(sale, "endBlock")?;
        if ["Swept", "SaleFailed", "Abandoned"]
            .iter()
            .any(|e| for_auction(e, auction))
        {
            continue;
        }
        if ctx.block <= end_block {
            continue;
        }
        if !for_auction("PoolStep", auction) {
            b.push(
                format!("finisher.openPool:{f_hex}:{auction}"),
                HelperCall::FinisherOpenPool { finisher },
                sale.block,
                false,
            );
        }
        let settled = for_auction("Settled", auction);
        if !settled {
            b.push(
                format!("finisher.settle:{f_hex}:{auction}"),
                HelperCall::FinisherSettle { finisher },
                sale.block,
                false,
            );
        }
        b.push(
            format!("finisher.sweep:{f_hex}:{auction}"),
            HelperCall::FinisherSweep { finisher },
            sale.block,
            false,
        );
        if !settled
            && !for_auction("PoolOpened", auction)
            && ctx.block >= end_block.saturating_add(ABANDON_DELAY_BLOCKS)
        {
            b.push(
                format!("finisher.abandon:{f_hex}:{auction}"),
                HelperCall::FinisherAbandon { finisher },
                sale.block,
                false,
            );
        }
    }

    // ── Pool fees ──────────────────────────────────────────────────────────
    for p in positions {
        b.push(
            format!(
                "holder.collect:{}:{}:w{week}",
                hex0x(&p.holder),
                hex0x(&p.token_id)
            ),
            HelperCall::HolderCollect {
                holder: p.holder,
                token_id: p.token_id,
            },
            p.block,
            true,
        );
    }

    // ── Plain grants and the earlier backers ──────────────────────────────
    let claim: Option<([u8; 20], u64)> = logs
        .iter()
        .rev()
        .find(|r| is(r, Role::Launcher, "ProjectZeroSplit"))
        .map(|r| addr(r, "claim").map(|a| (a, r.block)))
        .transpose()?;
    if let Some(started) = logs.iter().find(|r| is(r, Role::Vester, "Started")) {
        let v_hex = hex0x(&vester);
        // PLAIN grants only (`Granted`): never a backer's held Shares
        // (`HeldGranted`), which only the backer may take out. The claim
        // contract takes its own when it delivers.
        let mut beneficiaries: BTreeMap<[u8; 20], u64> = BTreeMap::new();
        for g in logs.iter().filter(|r| is(r, Role::Vester, "Granted")) {
            let who = addr(g, "beneficiary")?;
            if claim.map(|(c, _)| c) == Some(who) {
                continue;
            }
            beneficiaries.insert(who, g.block.max(started.block));
        }
        for (who, block) in beneficiaries {
            b.push(
                format!("vester.claim:{v_hex}:{}:w{week}", hex0x(&who)),
                HelperCall::VesterClaim {
                    vester,
                    beneficiary: who,
                },
                block,
                true,
            );
        }
        if let Some((claim, block)) = claim {
            let day = ctx.time / DAY;
            let size = batch as u64;
            let chunks = MAX_EARLIER_ENTRIES.div_ceil(size);
            for chunk in 0..chunks {
                let from = chunk * size;
                let to = (from + size).min(MAX_EARLIER_ENTRIES);
                b.push(
                    format!("earlier.deliverMany:{}:d{day}:{from}-{to}", hex0x(&claim)),
                    HelperCall::EarlierDeliverMany {
                        claim,
                        entries: (from..to).collect(),
                    },
                    block.max(started.block),
                    true,
                );
            }
        }
    }
    Ok(b.out)
}

#[cfg(test)]
#[path = "plan_tests.rs"]
mod tests;
