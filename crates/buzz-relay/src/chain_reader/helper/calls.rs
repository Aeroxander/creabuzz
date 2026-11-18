//! The calls the helper may send: a closed list, each producing its own
//! calldata. There is no way to build a job from raw calldata, so the list
//! below is everything the helper can ever ask a contract to do.
//!
//! Every call here is one anyone may make and none moves a person's money by
//! their choice. Never here, by design (and pinned by the tests): a backer's
//! held Shares (`Vester.claimHeld`), a refund, a check-in, anything a runner,
//! a Pair or the Launcher's admin signs, an ask, a consent.

use anyhow::{anyhow, bail, Context};
use buzz_evm_allowance::abi::selector;
use serde_json::{json, Value};

use crate::chain_reader::word::{hex0x, parse_fixed, Word};

/// One call the helper may send.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HelperCall {
    /// `Rounds.close(id)`: 24 hours after the round opened.
    RoundsClose {
        /// The project's Rounds.
        rounds: [u8; 20],
        /// The round.
        round: u64,
    },
    /// `Rounds.settleMany(id, backers)`: puts each backer's Shares into the
    /// Vester as held Shares and returns the scaled-back part of the ask.
    RoundsSettleMany {
        /// The project's Rounds.
        rounds: [u8; 20],
        /// The round.
        round: u64,
        /// Backers not settled yet.
        backers: Vec<[u8; 20]>,
    },
    /// `Rounds.release(id)`: the round's released money to the project.
    RoundsRelease {
        /// The project's Rounds.
        rounds: [u8; 20],
        /// The round.
        round: u64,
    },
    /// `Rounds.returnUnsold()`: backing Shares nobody bought to the reserve.
    RoundsReturnUnsold {
        /// The project's Rounds.
        rounds: [u8; 20],
    },
    /// `Rounds.sweepFees()`: the platform's owed money.
    RoundsSweepFees {
        /// The project's Rounds.
        rounds: [u8; 20],
    },
    /// `Treasury.sweepFees()`: the platform's cut of exits.
    TreasurySweepFees {
        /// The project's Treasury.
        treasury: [u8; 20],
    },
    /// `Treasury.release()`: works out the floor's release.
    TreasuryRelease {
        /// The project's Treasury.
        treasury: [u8; 20],
    },
    /// `Finisher.openPool()`: step 1 after the sale ends.
    FinisherOpenPool {
        /// The project's Finisher.
        finisher: [u8; 20],
    },
    /// `Finisher.settle()`: step 2.
    FinisherSettle {
        /// The project's Finisher.
        finisher: [u8; 20],
    },
    /// `Finisher.sweep()`: step 3.
    FinisherSweep {
        /// The project's Finisher.
        finisher: [u8; 20],
    },
    /// `Finisher.abandon()`: only once its block has come and no pool exists.
    FinisherAbandon {
        /// The project's Finisher.
        finisher: [u8; 20],
    },
    /// `LiquidityHolder.collect(tokenId)`: pool fees to the project.
    HolderCollect {
        /// The LiquidityHolder.
        holder: [u8; 20],
        /// The pool position.
        token_id: Word,
    },
    /// `Vester.claim(beneficiary)`: a PLAIN grant's released Shares (the
    /// founder's, gifts, the stake). Never a backer's held Shares.
    VesterClaim {
        /// The project's Vester.
        vester: [u8; 20],
        /// Who receives them.
        beneficiary: [u8; 20],
    },
    /// `EarlierBackers.deliverMany(entries)`: agreed entries' released
    /// Shares, each to its own receiver.
    EarlierDeliverMany {
        /// The claim contract.
        claim: [u8; 20],
        /// The entries, filtered with `entryOf` and `due` right before sending.
        entries: Vec<u64>,
    },
}

/// Every function signature the helper may call, and nothing else. The tests
/// compare the selectors [`HelperCall`] can produce with this list exactly.
pub const ALLOWED: [&str; 13] = [
    "close(uint256)",
    "settleMany(uint256,address[])",
    "release(uint256)",
    "returnUnsold()",
    "sweepFees()",
    "release()",
    "openPool()",
    "settle()",
    "sweep()",
    "abandon()",
    "collect(uint256)",
    "claim(address)",
    "deliverMany(uint256[])",
];

/// The names stored in `chain_helper_jobs.call` (the migration's CHECK list).
pub const NAMES: [&str; 14] = [
    "rounds.close",
    "rounds.settleMany",
    "rounds.release",
    "rounds.returnUnsold",
    "rounds.sweepFees",
    "treasury.sweepFees",
    "treasury.release",
    "finisher.openPool",
    "finisher.settle",
    "finisher.sweep",
    "finisher.abandon",
    "holder.collect",
    "vester.claim",
    "earlier.deliverMany",
];

fn uint_word(v: u64) -> Word {
    let mut w = [0u8; 32];
    w[24..].copy_from_slice(&v.to_be_bytes());
    w
}

fn address_word(a: &[u8; 20]) -> Word {
    let mut w = [0u8; 32];
    w[12..].copy_from_slice(a);
    w
}

fn encode(signature: &str, head: &[Word], tail: &[Word]) -> Vec<u8> {
    let mut out = selector(signature).to_vec();
    for w in head.iter().chain(tail) {
        out.extend_from_slice(w);
    }
    out
}

/// A dynamic array argument: its length word, then its items.
fn array(items: impl ExactSizeIterator<Item = Word>) -> Vec<Word> {
    let mut out = vec![uint_word(items.len() as u64)];
    out.extend(items);
    out
}

fn addr_arg(args: &Value, name: &str) -> anyhow::Result<[u8; 20]> {
    args.get(name)
        .and_then(Value::as_str)
        .and_then(parse_fixed::<20>)
        .ok_or_else(|| anyhow!("argument {name} is not an address"))
}

fn u64_arg(args: &Value, name: &str) -> anyhow::Result<u64> {
    args.get(name)
        .and_then(Value::as_u64)
        .ok_or_else(|| anyhow!("argument {name} is not a whole number"))
}

impl HelperCall {
    /// The stored name (`<contract>.<function>`).
    pub fn name(&self) -> &'static str {
        match self {
            HelperCall::RoundsClose { .. } => "rounds.close",
            HelperCall::RoundsSettleMany { .. } => "rounds.settleMany",
            HelperCall::RoundsRelease { .. } => "rounds.release",
            HelperCall::RoundsReturnUnsold { .. } => "rounds.returnUnsold",
            HelperCall::RoundsSweepFees { .. } => "rounds.sweepFees",
            HelperCall::TreasurySweepFees { .. } => "treasury.sweepFees",
            HelperCall::TreasuryRelease { .. } => "treasury.release",
            HelperCall::FinisherOpenPool { .. } => "finisher.openPool",
            HelperCall::FinisherSettle { .. } => "finisher.settle",
            HelperCall::FinisherSweep { .. } => "finisher.sweep",
            HelperCall::FinisherAbandon { .. } => "finisher.abandon",
            HelperCall::HolderCollect { .. } => "holder.collect",
            HelperCall::VesterClaim { .. } => "vester.claim",
            HelperCall::EarlierDeliverMany { .. } => "earlier.deliverMany",
        }
    }

    /// The Solidity signature of the function called.
    pub fn signature(&self) -> &'static str {
        match self {
            HelperCall::RoundsClose { .. } => "close(uint256)",
            HelperCall::RoundsSettleMany { .. } => "settleMany(uint256,address[])",
            HelperCall::RoundsRelease { .. } => "release(uint256)",
            HelperCall::RoundsReturnUnsold { .. } => "returnUnsold()",
            HelperCall::RoundsSweepFees { .. } | HelperCall::TreasurySweepFees { .. } => {
                "sweepFees()"
            }
            HelperCall::TreasuryRelease { .. } => "release()",
            HelperCall::FinisherOpenPool { .. } => "openPool()",
            HelperCall::FinisherSettle { .. } => "settle()",
            HelperCall::FinisherSweep { .. } => "sweep()",
            HelperCall::FinisherAbandon { .. } => "abandon()",
            HelperCall::HolderCollect { .. } => "collect(uint256)",
            HelperCall::VesterClaim { .. } => "claim(address)",
            HelperCall::EarlierDeliverMany { .. } => "deliverMany(uint256[])",
        }
    }

    /// The contract called.
    pub fn target(&self) -> [u8; 20] {
        match self {
            HelperCall::RoundsClose { rounds, .. }
            | HelperCall::RoundsSettleMany { rounds, .. }
            | HelperCall::RoundsRelease { rounds, .. }
            | HelperCall::RoundsReturnUnsold { rounds }
            | HelperCall::RoundsSweepFees { rounds } => *rounds,
            HelperCall::TreasurySweepFees { treasury }
            | HelperCall::TreasuryRelease { treasury } => *treasury,
            HelperCall::FinisherOpenPool { finisher }
            | HelperCall::FinisherSettle { finisher }
            | HelperCall::FinisherSweep { finisher }
            | HelperCall::FinisherAbandon { finisher } => *finisher,
            HelperCall::HolderCollect { holder, .. } => *holder,
            HelperCall::VesterClaim { vester, .. } => *vester,
            HelperCall::EarlierDeliverMany { claim, .. } => *claim,
        }
    }

    /// The calldata: the selector of [`HelperCall::signature`] and the
    /// ABI-encoded arguments.
    pub fn calldata(&self) -> Vec<u8> {
        let sig = self.signature();
        match self {
            HelperCall::RoundsClose { round, .. } | HelperCall::RoundsRelease { round, .. } => {
                encode(sig, &[uint_word(*round)], &[])
            }
            HelperCall::RoundsSettleMany { round, backers, .. } => encode(
                sig,
                // (round, offset of the array = 2 words)
                &[uint_word(*round), uint_word(64)],
                &array(backers.iter().map(address_word)),
            ),
            HelperCall::HolderCollect { token_id, .. } => encode(sig, &[*token_id], &[]),
            HelperCall::VesterClaim { beneficiary, .. } => {
                encode(sig, &[address_word(beneficiary)], &[])
            }
            HelperCall::EarlierDeliverMany { entries, .. } => encode(
                sig,
                &[uint_word(32)],
                &array(entries.iter().map(|e| uint_word(*e))),
            ),
            HelperCall::RoundsReturnUnsold { .. }
            | HelperCall::RoundsSweepFees { .. }
            | HelperCall::TreasurySweepFees { .. }
            | HelperCall::TreasuryRelease { .. }
            | HelperCall::FinisherOpenPool { .. }
            | HelperCall::FinisherSettle { .. }
            | HelperCall::FinisherSweep { .. }
            | HelperCall::FinisherAbandon { .. } => encode(sig, &[], &[]),
        }
    }

    /// The arguments as stored (`chain_helper_jobs.args`); the target is kept
    /// in its own column.
    pub fn args(&self) -> Value {
        match self {
            HelperCall::RoundsClose { round, .. } | HelperCall::RoundsRelease { round, .. } => {
                json!({ "round": round })
            }
            HelperCall::RoundsSettleMany { round, backers, .. } => json!({
                "round": round,
                "backers": backers.iter().map(|b| hex0x(b)).collect::<Vec<_>>(),
            }),
            HelperCall::HolderCollect { token_id, .. } => json!({ "tokenId": hex0x(token_id) }),
            HelperCall::VesterClaim { beneficiary, .. } => {
                json!({ "beneficiary": hex0x(beneficiary) })
            }
            HelperCall::EarlierDeliverMany { entries, .. } => json!({ "entries": entries }),
            _ => json!({}),
        }
    }

    /// Read a stored job back. An unknown name or a bad argument is an error;
    /// the job then ends as failed, never sent.
    pub fn parse(name: &str, target: [u8; 20], args: &Value) -> anyhow::Result<Self> {
        Ok(match name {
            "rounds.close" => HelperCall::RoundsClose {
                rounds: target,
                round: u64_arg(args, "round")?,
            },
            "rounds.settleMany" => HelperCall::RoundsSettleMany {
                rounds: target,
                round: u64_arg(args, "round")?,
                backers: args
                    .get("backers")
                    .and_then(Value::as_array)
                    .context("argument backers is not a list")?
                    .iter()
                    .map(|b| {
                        b.as_str()
                            .and_then(parse_fixed::<20>)
                            .ok_or_else(|| anyhow!("a backer is not an address"))
                    })
                    .collect::<anyhow::Result<_>>()?,
            },
            "rounds.release" => HelperCall::RoundsRelease {
                rounds: target,
                round: u64_arg(args, "round")?,
            },
            "rounds.returnUnsold" => HelperCall::RoundsReturnUnsold { rounds: target },
            "rounds.sweepFees" => HelperCall::RoundsSweepFees { rounds: target },
            "treasury.sweepFees" => HelperCall::TreasurySweepFees { treasury: target },
            "treasury.release" => HelperCall::TreasuryRelease { treasury: target },
            "finisher.openPool" => HelperCall::FinisherOpenPool { finisher: target },
            "finisher.settle" => HelperCall::FinisherSettle { finisher: target },
            "finisher.sweep" => HelperCall::FinisherSweep { finisher: target },
            "finisher.abandon" => HelperCall::FinisherAbandon { finisher: target },
            "holder.collect" => HelperCall::HolderCollect {
                holder: target,
                token_id: args
                    .get("tokenId")
                    .and_then(Value::as_str)
                    .and_then(parse_fixed::<32>)
                    .context("argument tokenId is not a 32-byte word")?,
            },
            "vester.claim" => HelperCall::VesterClaim {
                vester: target,
                beneficiary: addr_arg(args, "beneficiary")?,
            },
            "earlier.deliverMany" => HelperCall::EarlierDeliverMany {
                claim: target,
                entries: args
                    .get("entries")
                    .and_then(Value::as_array)
                    .context("argument entries is not a list")?
                    .iter()
                    .map(|e| e.as_u64().context("an entry is not a whole number"))
                    .collect::<anyhow::Result<_>>()?,
            },
            other => bail!("unknown helper call {other:?}"),
        })
    }

    /// Order inside one pass: a sale's steps run in their order, closes before
    /// settles, so a later step's check sees the earlier step's effect.
    pub fn priority(&self) -> u8 {
        match self {
            HelperCall::RoundsClose { .. } => 0,
            HelperCall::RoundsSettleMany { .. } => 1,
            HelperCall::FinisherOpenPool { .. } => 2,
            HelperCall::FinisherSettle { .. } => 3,
            HelperCall::FinisherSweep { .. } => 4,
            HelperCall::FinisherAbandon { .. } => 5,
            _ => 6,
        }
    }

    /// Custom errors (their selectors) that mean "nothing for this job to do",
    /// not "try again": the job is dropped, not counted as a failed attempt.
    pub fn nothing_to_do_errors(&self) -> &'static [&'static str] {
        match self {
            HelperCall::RoundsClose { .. } | HelperCall::RoundsReturnUnsold { .. } => {
                &["WrongPhase()"]
            }
            HelperCall::FinisherOpenPool { .. } => &["WrongStage()"],
            HelperCall::FinisherSettle { .. } => {
                &["NoPool()", "SaleDidNotGraduate()", "WrongStage()"]
            }
            HelperCall::FinisherSweep { .. } => &["WrongStage()"],
            HelperCall::FinisherAbandon { .. } => {
                &["PoolExists()", "SaleDidNotGraduate()", "WrongStage()"]
            }
            _ => &[],
        }
    }
}

#[cfg(test)]
#[path = "calls_tests.rs"]
pub(crate) mod tests;
