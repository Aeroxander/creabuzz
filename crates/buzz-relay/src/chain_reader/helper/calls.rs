//! The calls the helper may send: a closed list, each producing its own
//! calldata. There is no way to build a job from raw calldata, so the list
//! below is everything the helper can ever ask a contract to do.
//!
//! Every call here is one anyone may make, none moves a person's money by
//! their choice, and none speaks for the project's runner. Never here, by
//! design (and pinned by the tests): a check-in (the runner's sign of life
//! must be the runner's), a Take out for anyone, a refund, a draw from the
//! allowance, a claim of a member's Team Shares, a join, a grant, a rate
//! proposal or a lowering, a wind-down (ending a project is a person's press,
//! also once the quiet time has passed), the burn of the Team Shares nobody
//! was granted, anything a runner, a Pair or the Launcher's admin signs.
//! The seven calls of the task book (`announceTask`, `takeTask`, `acceptTask`,
//! `rejectTask`, `cancelTask`, `returnTask`, `claimNote`) are never here either:
//! a task that ran out is returned by a plain `settle()`, which moves no one's
//! money to anyone.
//!
//! The stored names (`chain_helper_jobs.call`, whose list the database closes,
//! migrations 0070, 0075 and 0077) are `treasury.collectFees`, `treasury.settle`,
//! `treasury.applyRate`, `vester.execute`, `vester.burnAfterWindDown`,
//! `vote.openSeats`, `vote.finish`, `vote.carryOut` and `vote.lapse`.
//!
//! The four vote calls are the Council round's (`COUNCIL-PLAN.md` section 5.5):
//! the seat election that is due, the result of a ballot whose vote has ended,
//! a won result's wait being carried out, and a won result nobody carried out
//! being let go. Each is a call anyone may make, moves no money, and never
//! opens a replace vote (that is a holder's press): `HolderVote.openReplace` is
//! not here. They are held to their own pace and caps (see [`VOTE_NAMES`]).
//!
//! The last three close a notice that was already public, once its time has
//! run and a person has had ten minutes to do it themselves: a proposed
//! allowance rate (`Treasury.applyRate()`), the announced part of a grant
//! (`Vester.execute(id)`), and what a grant does not keep after a wind-down
//! (`Vester.burnAfterWindDown(id)`). A stranger must not be able to make the
//! helper pay for failing transactions, so these three are held to a tighter
//! rule than the first two: [`MAX_OPTIONAL_ATTEMPTS`] failed attempts,
//! [`OPTIONAL_PER_PASS`] looked at in a pass and [`OPTIONAL_PER_PROJECT_PER_DAY`]
//! sent for one project in a day (see `super::Helper`).

use anyhow::bail;
use buzz_evm_allowance::abi::selector;
use serde_json::{json, Value};

/// One call the helper may send.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HelperCall {
    /// `Treasury.collectFees()`: the platform's owed fee goes to the
    /// platform. Stored as `treasury.collectFees`.
    TreasuryCollectFees {
        /// The project's Treasury.
        treasury: [u8; 20],
    },
    /// `Treasury.settle()`: works out the allowance and moves outside money
    /// that has arrived into the pot. Stored as `treasury.settle`.
    TreasurySettle {
        /// The project's Treasury.
        treasury: [u8; 20],
    },
    /// `Treasury.settle()` for a task that has run out (the end of a take
    /// window or a deadline): a settle returns the money of every task whose
    /// time is up and makes `locked`, the notes and the record true without a
    /// person pressing anything. The same call and the same stored name as
    /// [`HelperCall::TreasurySettle`]; its arguments name the second the task
    /// ran out, which is what makes the job once per expiry.
    TreasurySettleTasks {
        /// The project's Treasury.
        treasury: [u8; 20],
        /// The second the earliest overdue task ran out
        /// (`TaskBook` `expiresAt`).
        expiry: u64,
    },
    /// `Treasury.applyRate()`: a proposed rise of the allowance rate whose
    /// wait of one time unit has ended takes effect (the Treasury settles
    /// first, at the old rate). Stored as `treasury.applyRate`.
    TreasuryApplyRate {
        /// The project's Treasury.
        treasury: [u8; 20],
    },
    /// `Vester.execute(id)`: the part of grant `id` that was announced to burn
    /// burns, once its notice has run. Stored as `vester.execute`.
    VesterExecute {
        /// The project's Vester.
        vester: [u8; 20],
        /// The grant's id in the Vester.
        grant: u64,
    },
    /// `Vester.burnAfterWindDown(id)`: after a wind-down and one more time
    /// unit, what grant `id` does not keep burns. Stored as
    /// `vester.burnAfterWindDown`.
    VesterBurnAfterWindDown {
        /// The project's Vester.
        vester: [u8; 20],
        /// The grant's id in the Vester.
        grant: u64,
    },
    /// `HolderVote.openSeats()`: the seat election the Council says is due
    /// opens (anyone may open it; the helper does). Stored as `vote.openSeats`.
    VoteOpenSeats {
        /// The project's vote contract (its pause).
        vote: [u8; 20],
    },
    /// `HolderVote.finish(id)`: the result of ballot `id`, whose vote has
    /// ended, is recorded (anyone, once). Stored as `vote.finish`.
    VoteFinish {
        /// The project's vote contract (its pause).
        vote: [u8; 20],
        /// The ballot's id.
        ballot: u32,
    },
    /// `HolderVote.carryOut(id)`: a won result of ballot `id` takes effect
    /// once its wait has run. Stored as `vote.carryOut`.
    VoteCarryOut {
        /// The project's vote contract (its pause).
        vote: [u8; 20],
        /// The ballot's id.
        ballot: u32,
    },
    /// `HolderVote.lapse(id)`: a won result of ballot `id` that nobody carried
    /// out is let go two time units after it was due. Stored as `vote.lapse`.
    VoteLapse {
        /// The project's vote contract (its pause).
        vote: [u8; 20],
        /// The ballot's id.
        ballot: u32,
    },
}

/// Every function signature the helper may call, and nothing else. The tests
/// compare the selectors [`HelperCall`] can produce with this list exactly.
pub const ALLOWED: [&str; 9] = [
    "collectFees()",
    "settle()",
    "applyRate()",
    "execute(uint256)",
    "burnAfterWindDown(uint256)",
    "openSeats()",
    "finish(uint32)",
    "carryOut(uint32)",
    "lapse(uint32)",
];

/// The names stored in `chain_helper_jobs.call` (the database's CHECK list,
/// migration 0077, allows exactly these and the retired names of the old
/// contracts' calls, which are only history).
pub const NAMES: [&str; 9] = [
    "treasury.collectFees",
    "treasury.settle",
    "treasury.applyRate",
    "vester.execute",
    "vester.burnAfterWindDown",
    "vote.openSeats",
    "vote.finish",
    "vote.carryOut",
    "vote.lapse",
];

/// The four vote calls: each anyone may make, none moves money, none opens a
/// replace vote. They are held to their own pace, per-project day and pass
/// bounds (see `super`).
pub const VOTE_NAMES: [&str; 4] = [
    "vote.openSeats",
    "vote.finish",
    "vote.carryOut",
    "vote.lapse",
];

/// The stored names of the three calls that are optional in the sense that
/// nobody's money waits on them (a notice closes, a rate takes effect, a
/// burn runs): these are held to the tighter rule of this module.
pub const OPTIONAL_NAMES: [&str; 3] = [
    "treasury.applyRate",
    "vester.execute",
    "vester.burnAfterWindDown",
];

/// How long after a notice has run (a proposed rate's wait, a grant's burn
/// time, the notice after a wind-down) the helper acts, in seconds (ten
/// minutes): whoever is there has had that time to do it themselves.
pub const NOTICE_GRACE_SECS: u64 = 600;

/// Failed attempts after which a job of an optional call ends `failed`
/// (the first two calls use the configured limit, 8 by default). Each attempt
/// is checked against the contract's views, `eth_call` and `eth_estimateGas`
/// before anything is sent, so a failure is a race, not a routine.
pub const MAX_OPTIONAL_ATTEMPTS: u32 = 3;

/// Failed attempts after which a job of a vote call ends `failed`: five
/// failures in a row leave that project's vote calls alone for 24 hours and
/// log it (`COUNCIL-PLAN.md` section 5.5).
pub const MAX_VOTE_ATTEMPTS: u32 = 5;

/// How long a project whose vote calls failed five times in a row is left
/// alone, in seconds (24 hours).
pub const VOTE_PROJECT_COOLDOWN_SECS: u64 = 24 * 3_600;

/// Jobs of the optional calls looked at in one helper pass at most.
pub const OPTIONAL_PER_PASS: usize = 3;

/// Transactions of the optional calls the helper sends for one project in any
/// 24 hours at most (a replacement of a stuck one is not a new one).
pub const OPTIONAL_PER_PROJECT_PER_DAY: i64 = 8;

/// The share of the daily gas and spend caps the optional calls may use
/// together, across every project (a smaller slice inside
/// [`ROUTINE_SHARE_PERCENT`]). A stranger who launches projects of their own
/// can make these calls due; whatever they use, the settle that returns a task
/// and the platform's fee still have the rest of the routine share.
pub const OPTIONAL_SHARE_PERCENT: u128 = 20;

/// Whether a stored call name is one of the optional calls.
pub fn is_optional(name: &str) -> bool {
    OPTIONAL_NAMES.contains(&name)
}

/// Whether a stored call name is one of the four vote calls.
pub fn is_vote(name: &str) -> bool {
    VOTE_NAMES.contains(&name)
}

/// The failed attempts after which a job of `name` ends `failed`, given the
/// configured limit: the tighter limit of the optional calls, and five for the
/// vote calls.
pub fn max_attempts_for(name: &str, configured: u32) -> u32 {
    if is_optional(name) {
        configured.min(MAX_OPTIONAL_ATTEMPTS)
    } else if is_vote(name) {
        configured.min(MAX_VOTE_ATTEMPTS)
    } else {
        configured
    }
}

/// How long after a task's time the helper settles it, in seconds (ten
/// minutes): the team or a holder who is there has had that time to do it
/// themselves, and a settle is only made when nobody did.
pub const TASK_SETTLE_DELAY_SECS: u64 = 600;

/// The share of the daily gas and spend caps the calls may use (nothing the
/// helper sends blocks a person's money, which can always be taken out
/// without it, so no call is let past this share).
pub const ROUTINE_SHARE_PERCENT: u128 = 50;

/// The order of a stored call in a pass (lower first).
pub fn priority_of(name: &str) -> u8 {
    match name {
        "treasury.settle" => 0,
        // The result of a ballot whose vote has ended is recorded before
        // anything reads it, as the contract's own calls all finish it first.
        "vote.finish" => 1,
        "treasury.applyRate" | "vote.openSeats" | "vote.carryOut" => 2,
        "vester.execute" | "vester.burnAfterWindDown" | "vote.lapse" => 3,
        _ => 1,
    }
}

/// Every stored call name, in pass order.
pub fn names_by_priority() -> Vec<&'static str> {
    let mut names = NAMES.to_vec();
    names.sort_by_key(|n| priority_of(n));
    names
}

fn encode(signature: &str) -> Vec<u8> {
    selector(signature).to_vec()
}

/// The selector of `signature` followed by one `uint256` argument.
fn encode_id(signature: &str, id: u64) -> Vec<u8> {
    let mut out = selector(signature).to_vec();
    out.extend_from_slice(&[0u8; 24]);
    out.extend_from_slice(&id.to_be_bytes());
    out
}

/// The grant id a stored Vester job carries.
fn grant_of(args: &Value) -> anyhow::Result<u64> {
    args.get("grant")
        .and_then(Value::as_u64)
        .ok_or_else(|| anyhow::anyhow!("grant is not a number"))
}

/// The ballot id a stored vote job carries (`HolderVote`'s ballots are `uint32`).
fn ballot_of(args: &Value) -> anyhow::Result<u32> {
    let id = args
        .get("ballot")
        .and_then(Value::as_u64)
        .ok_or_else(|| anyhow::anyhow!("ballot is not a number"))?;
    u32::try_from(id).map_err(|_| anyhow::anyhow!("ballot {id} is past the contract's uint32"))
}

impl HelperCall {
    /// The stored name (`<contract>.<function>`).
    pub fn name(&self) -> &'static str {
        match self {
            HelperCall::TreasuryCollectFees { .. } => "treasury.collectFees",
            HelperCall::TreasurySettle { .. } | HelperCall::TreasurySettleTasks { .. } => {
                "treasury.settle"
            }
            HelperCall::TreasuryApplyRate { .. } => "treasury.applyRate",
            HelperCall::VesterExecute { .. } => "vester.execute",
            HelperCall::VesterBurnAfterWindDown { .. } => "vester.burnAfterWindDown",
            HelperCall::VoteOpenSeats { .. } => "vote.openSeats",
            HelperCall::VoteFinish { .. } => "vote.finish",
            HelperCall::VoteCarryOut { .. } => "vote.carryOut",
            HelperCall::VoteLapse { .. } => "vote.lapse",
        }
    }

    /// The Solidity signature of the function called.
    pub fn signature(&self) -> &'static str {
        match self {
            HelperCall::TreasuryCollectFees { .. } => "collectFees()",
            HelperCall::TreasurySettle { .. } | HelperCall::TreasurySettleTasks { .. } => {
                "settle()"
            }
            HelperCall::TreasuryApplyRate { .. } => "applyRate()",
            HelperCall::VesterExecute { .. } => "execute(uint256)",
            HelperCall::VesterBurnAfterWindDown { .. } => "burnAfterWindDown(uint256)",
            HelperCall::VoteOpenSeats { .. } => "openSeats()",
            HelperCall::VoteFinish { .. } => "finish(uint32)",
            HelperCall::VoteCarryOut { .. } => "carryOut(uint32)",
            HelperCall::VoteLapse { .. } => "lapse(uint32)",
        }
    }

    /// The contract called.
    pub fn target(&self) -> [u8; 20] {
        match self {
            HelperCall::TreasuryCollectFees { treasury }
            | HelperCall::TreasurySettle { treasury }
            | HelperCall::TreasurySettleTasks { treasury, .. }
            | HelperCall::TreasuryApplyRate { treasury } => *treasury,
            HelperCall::VesterExecute { vester, .. }
            | HelperCall::VesterBurnAfterWindDown { vester, .. } => *vester,
            HelperCall::VoteOpenSeats { vote }
            | HelperCall::VoteFinish { vote, .. }
            | HelperCall::VoteCarryOut { vote, .. }
            | HelperCall::VoteLapse { vote, .. } => *vote,
        }
    }

    /// The calldata: the selector of [`HelperCall::signature`], and for the
    /// Vester calls the grant's id, for the ballot calls the ballot's id, as
    /// the one argument (both are `uint` padded to one 32-byte word).
    pub fn calldata(&self) -> Vec<u8> {
        match self {
            HelperCall::VesterExecute { grant, .. }
            | HelperCall::VesterBurnAfterWindDown { grant, .. } => {
                encode_id(self.signature(), *grant)
            }
            HelperCall::VoteFinish { ballot, .. }
            | HelperCall::VoteCarryOut { ballot, .. }
            | HelperCall::VoteLapse { ballot, .. } => {
                encode_id(self.signature(), u64::from(*ballot))
            }
            _ => encode(self.signature()),
        }
    }

    /// The arguments as stored (`chain_helper_jobs.args`); the target is kept
    /// in its own column.
    pub fn args(&self) -> Value {
        match self {
            HelperCall::TreasurySettleTasks { expiry, .. } => json!({ "taskExpiry": expiry }),
            HelperCall::VesterExecute { grant, .. }
            | HelperCall::VesterBurnAfterWindDown { grant, .. } => json!({ "grant": grant }),
            HelperCall::VoteFinish { ballot, .. }
            | HelperCall::VoteCarryOut { ballot, .. }
            | HelperCall::VoteLapse { ballot, .. } => json!({ "ballot": ballot }),
            HelperCall::TreasuryCollectFees { .. }
            | HelperCall::TreasurySettle { .. }
            | HelperCall::TreasuryApplyRate { .. }
            | HelperCall::VoteOpenSeats { .. } => json!({}),
        }
    }

    /// Read a stored job back. An unknown name is an error; the job then ends
    /// as failed, never sent.
    pub fn parse(name: &str, target: [u8; 20], args: &Value) -> anyhow::Result<Self> {
        Ok(match name {
            "treasury.collectFees" => HelperCall::TreasuryCollectFees { treasury: target },
            "treasury.settle" => match args.get("taskExpiry") {
                None => HelperCall::TreasurySettle { treasury: target },
                Some(expiry) => HelperCall::TreasurySettleTasks {
                    treasury: target,
                    expiry: expiry
                        .as_u64()
                        .ok_or_else(|| anyhow::anyhow!("taskExpiry is not a second"))?,
                },
            },
            "treasury.applyRate" => HelperCall::TreasuryApplyRate { treasury: target },
            "vester.execute" => HelperCall::VesterExecute {
                vester: target,
                grant: grant_of(args)?,
            },
            "vester.burnAfterWindDown" => HelperCall::VesterBurnAfterWindDown {
                vester: target,
                grant: grant_of(args)?,
            },
            "vote.openSeats" => HelperCall::VoteOpenSeats { vote: target },
            "vote.finish" => HelperCall::VoteFinish {
                vote: target,
                ballot: ballot_of(args)?,
            },
            "vote.carryOut" => HelperCall::VoteCarryOut {
                vote: target,
                ballot: ballot_of(args)?,
            },
            "vote.lapse" => HelperCall::VoteLapse {
                vote: target,
                ballot: ballot_of(args)?,
            },
            other => bail!("unknown helper call {other:?}"),
        })
    }

    /// Order inside one pass.
    pub fn priority(&self) -> u8 {
        priority_of(self.name())
    }

    /// Custom errors (their selectors) that mean "nothing for this job to do",
    /// not "try again": the job is dropped, not counted as a failed attempt.
    /// `collectFees()` reverts with `NothingToPay()` when another caller
    /// collected the fee first.
    pub fn nothing_to_do_errors(&self) -> &'static [&'static str] {
        match self {
            HelperCall::TreasuryCollectFees { .. } => &["NothingToPay()"],
            HelperCall::TreasurySettle { .. } | HelperCall::TreasurySettleTasks { .. } => &[],
            // Another caller applied it, or the project was wound down, since
            // the views were read (a proposal pending was just seen).
            HelperCall::TreasuryApplyRate { .. } => &["AlreadyWoundDown()", "BadInput()"],
            // Someone else burned it first.
            HelperCall::VesterExecute { .. } => &["WrongState()"],
            HelperCall::VesterBurnAfterWindDown { .. } => &["WrongState()", "ProtectedGrant()"],
            // Someone else opened the election, finished or moved on: a ballot
            // is live, one is already open, the Council is no longer the
            // runner, or an earlier `finish`/`carryOut` counted. (A call that
            // is merely early is retried, never dropped: the clock may move.)
            HelperCall::VoteOpenSeats { .. } => &["BallotLive()", "BadKind()", "BadProject()"],
            HelperCall::VoteFinish { .. } => &["AlreadyFinished()", "NoBallot()"],
            HelperCall::VoteCarryOut { .. } => &[
                "Settled()",
                "TooLate(uint64)",
                "NothingToDo()",
                "WoundDown()",
                "NoBallot()",
            ],
            HelperCall::VoteLapse { .. } => {
                &["Settled()", "NothingToDo()", "NotLapsable()", "NoBallot()"]
            }
        }
    }
}

#[cfg(test)]
#[path = "calls_tests.rs"]
pub(crate) mod tests;
