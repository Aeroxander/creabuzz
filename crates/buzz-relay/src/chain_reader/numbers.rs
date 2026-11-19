//! The project numbers record (kind 39009), version 2: where it is built.
//!
//! The reader (`events`, `scan`, `store`, `ledger`) has been moved to the
//! contracts/pot contracts; the record itself (`docs/next-version/RECORD-V2.md`)
//! is built next: [`derive`] is where it goes. Until it is, no record is signed
//! (`derive` answers `None`), which the publish pass treats as "nothing to say
//! yet". What it is given is everything the reader keeps: the project's
//! [`Ledger`] rebuilt from its events (pot, paid-in, Shares, Team Shares, burn
//! queue, box, arriving money, active time, rate, door, wind-down, grants,
//! agents, totals, holders), already cross-checked where the caller has the
//! contracts' views.

use serde_json::Value;

use super::ledger::Ledger;
use super::word::Word;

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

/// Work out the record for project `key` from its ledger as of `as_of`, or
/// `Ok(None)` when there is nothing to sign.
pub fn derive(_key: &Word, _ledger: &Ledger, _as_of: &AsOf) -> anyhow::Result<Option<Value>> {
    Ok(None)
}

/// The part of the content that changes only with events: everything but
/// `asOf`.
pub fn facts_of(content: &Value) -> Value {
    without_as_of(content)
}

/// The content without `asOf`, to tell whether anything a reader sees moved.
pub fn without_as_of(content: &Value) -> Value {
    let mut c = content.clone();
    if let Some(obj) = c.as_object_mut() {
        obj.remove("asOf");
    }
    c
}
