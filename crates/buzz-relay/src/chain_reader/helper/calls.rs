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
//!
//! The stored names are the two the database's closed list
//! (`chain_helper_jobs.call`, migration 0066) still allows; they keep their
//! old names and now mean: `treasury.sweepFees` is `Treasury.collectFees()`
//! (the platform's owed fee goes to the platform) and `treasury.release` is
//! `Treasury.settle()` (the allowance and the arriving money are worked out).
//! A migration that widens the list would let the other calls anyone may make
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
    /// platform. Stored as `treasury.sweepFees`.
    TreasurySweepFees {
        /// The project's Treasury.
        treasury: [u8; 20],
    },
    /// `Treasury.settle()`: works out the allowance and moves outside money
    /// that has arrived into the pot. Stored as `treasury.release`.
    TreasuryRelease {
        /// The project's Treasury.
        treasury: [u8; 20],
    },
}

/// Every function signature the helper may call, and nothing else. The tests
/// compare the selectors [`HelperCall`] can produce with this list exactly.
pub const ALLOWED: [&str; 2] = ["collectFees()", "settle()"];

/// The names stored in `chain_helper_jobs.call` (the migration's CHECK list
/// allows these among others).
pub const NAMES: [&str; 2] = ["treasury.sweepFees", "treasury.release"];

/// The share of the daily gas and spend caps the calls nothing waits on may
/// use (see [`HelperCall::is_essential`]).
pub const ROUTINE_SHARE_PERCENT: u128 = 50;

/// The calls somebody waits on: none (nothing the helper sends blocks a
/// person's money, which can always be taken out without it).
pub const ESSENTIAL: [&str; 0] = [];

/// Whether the stored call `name` is one of [`ESSENTIAL`].
pub fn is_essential_name(name: &str) -> bool {
    ESSENTIAL.contains(&name)
}

/// The order of a stored call in a pass (lower first).
pub fn priority_of(name: &str) -> u8 {
    match name {
        "treasury.release" => 0,
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
            HelperCall::TreasurySweepFees { .. } => "treasury.sweepFees",
            HelperCall::TreasuryRelease { .. } => "treasury.release",
        }
    }

    /// The Solidity signature of the function called.
    pub fn signature(&self) -> &'static str {
        match self {
            HelperCall::TreasurySweepFees { .. } => "collectFees()",
            HelperCall::TreasuryRelease { .. } => "settle()",
        }
    }

    /// The contract called.
    pub fn target(&self) -> [u8; 20] {
        match self {
            HelperCall::TreasurySweepFees { treasury }
            | HelperCall::TreasuryRelease { treasury } => *treasury,
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
        json!({})
    }

    /// Read a stored job back. An unknown name is an error; the job then ends
    /// as failed, never sent.
    pub fn parse(name: &str, target: [u8; 20], _args: &Value) -> anyhow::Result<Self> {
        Ok(match name {
            "treasury.sweepFees" => HelperCall::TreasurySweepFees { treasury: target },
            "treasury.release" => HelperCall::TreasuryRelease { treasury: target },
            other => bail!("unknown helper call {other:?}"),
        })
    }

    /// Order inside one pass.
    pub fn priority(&self) -> u8 {
        priority_of(self.name())
    }

    /// Whether somebody waits on this call (nobody does: see [`ESSENTIAL`]).
    pub fn is_essential(&self) -> bool {
        is_essential_name(self.name())
    }

    /// How many members a batch call carries (1: neither call is a batch).
    pub fn members(&self) -> usize {
        1
    }

    /// The same batch call with only the members at the indices in `keep`;
    /// `None`: neither call is a batch.
    pub fn only(&self, _keep: &[usize]) -> Option<HelperCall> {
        None
    }

    /// The first half of a batch of two or more; `None` for these calls.
    pub fn first_half(&self) -> Option<HelperCall> {
        None
    }

    /// Custom errors (their selectors) that mean "nothing for this job to do",
    /// not "try again": the job is dropped, not counted as a failed attempt.
    pub fn nothing_to_do_errors(&self) -> &'static [&'static str] {
        &[]
    }
}

#[cfg(test)]
#[path = "calls_tests.rs"]
pub(crate) mod tests;
