//! The job builder: which calls are due, worked out from one project's FINAL
//! logs only (the reader's rows at least the confirmation depth under the
//! head) as of one final block. Pure: no node, no database.
//!
//! A job names the row that made it due (`due_block`), so a rollback past that
//! row deletes it. Whether a due call would still do something is checked
//! again at the head right before it is sent (`super::check`): this builder
//! only says when to look.

use super::calls::HelperCall;
use crate::chain_reader::ledger::LogRow;
use crate::chain_reader::word::Word;

/// One week, the period of the repeating jobs.
pub const WEEK: u64 = 7 * 86_400;
/// One day, the period of the earlier backers' delivery.
pub const DAY: u64 = 86_400;

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

/// The jobs due for one project, from its final logs (oldest first) as of
/// `ctx`. None yet: the calls anyone may make on the contracts/pot contracts
/// (settling, collecting the platform's fees, applying a waiting rate raise,
/// burning an announced forfeit, winding down a quiet project) are not planned
/// until the helper is rebuilt for them; the calls of the contracts they
/// replaced (rounds, sales, pools, the earlier backers' claim) are gone.
pub fn plan(
    _key: &Word,
    _logs: &[LogRow],
    _positions: &[Position],
    _ctx: &PlanContext,
) -> anyhow::Result<Vec<Job>> {
    Ok(Vec::new())
}
