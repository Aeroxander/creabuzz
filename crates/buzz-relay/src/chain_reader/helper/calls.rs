//! The calls the helper may send: a closed list, each producing its own
//! calldata. There is no way to build a job from raw calldata, so the list
//! below is everything the helper can ever ask a contract to do.
//!
//! Every call here is one anyone may make, none moves a person's money by
//! their choice, and none speaks for the project's runner. Never here, by
//! design (and pinned by the tests): a check-in (the runner's sign of life
//! must be the runner's), a Take out for anyone, a refund, a draw from the
//! allowance, a claim of a member's Team Shares, a join, a grant, a rate
//! change, a wind-down, anything a runner, a Pair or the Launcher's admin signs.
//! The seven calls of the task book (`announceTask`, `takeTask`, `acceptTask`,
//! `rejectTask`, `cancelTask`, `returnTask`, `claimNote`) are never here either:
//! a task that ran out is returned by a plain `settle()`, which moves no one's
//! money to anyone.
//!
//! The stored names (`chain_helper_jobs.call`, whose list the database closes,
//! migration 0070) are `treasury.collectFees` and `treasury.settle`. A migration
//! that widens the list is what lets the other calls anyone may make
//! (`applyRate()`, `Vester.execute(id)`, `Vester.burnAfterWindDown(id)`,
//! `Treasury.windDown()` after 26 quiet units) be added here: see
//! `docs/next-version/READER-V2-REPORT.md`.

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
}

/// Every function signature the helper may call, and nothing else. The tests
/// compare the selectors [`HelperCall`] can produce with this list exactly.
pub const ALLOWED: [&str; 2] = ["collectFees()", "settle()"];

/// The names stored in `chain_helper_jobs.call` (the database's CHECK list,
/// migration 0070, allows exactly these and the retired names of the old
/// contracts' calls, which are only history).
pub const NAMES: [&str; 2] = ["treasury.collectFees", "treasury.settle"];

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

impl HelperCall {
    /// The stored name (`<contract>.<function>`).
    pub fn name(&self) -> &'static str {
        match self {
            HelperCall::TreasuryCollectFees { .. } => "treasury.collectFees",
            HelperCall::TreasurySettle { .. } | HelperCall::TreasurySettleTasks { .. } => {
                "treasury.settle"
            }
        }
    }

    /// The Solidity signature of the function called.
    pub fn signature(&self) -> &'static str {
        match self {
            HelperCall::TreasuryCollectFees { .. } => "collectFees()",
            HelperCall::TreasurySettle { .. } | HelperCall::TreasurySettleTasks { .. } => {
                "settle()"
            }
        }
    }

    /// The contract called.
    pub fn target(&self) -> [u8; 20] {
        match self {
            HelperCall::TreasuryCollectFees { treasury }
            | HelperCall::TreasurySettle { treasury }
            | HelperCall::TreasurySettleTasks { treasury, .. } => *treasury,
        }
    }

    /// The calldata: the selector of [`HelperCall::signature`] (both calls
    /// take no arguments).
    pub fn calldata(&self) -> Vec<u8> {
        encode(self.signature())
    }

    /// The arguments as stored (`chain_helper_jobs.args`); the target is kept
    /// in its own column.
    pub fn args(&self) -> Value {
        match self {
            HelperCall::TreasurySettleTasks { expiry, .. } => json!({ "taskExpiry": expiry }),
            _ => json!({}),
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
        }
    }
}

#[cfg(test)]
#[path = "calls_tests.rs"]
pub(crate) mod tests;
