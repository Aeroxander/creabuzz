//! Project zero's earlier backers' claim contract (`EarlierBackers`), told as
//! counts and totals only. The public record never carries an entry, a
//! holder, a receiver or one entry's amount: the events do, and the record
//! adds them up.

use std::collections::{HashMap, HashSet};

use serde_json::{json, Value};

use super::{num, small, text, LogRow};

/// The claim contract's events, added up.
#[derive(Debug)]
pub(super) struct Earlier {
    /// Entries agreed to now, with their amounts (kept to subtract a void).
    consented: HashMap<String, u128>,
    voided: u64,
    delivered: u128,
    deliveries: u64,
    /// Entries with a proposed new holder that has not applied yet.
    pending: HashSet<String>,
    replaced: u64,
    cancelled: u64,
    /// The constructor publishes version 1 before the Launcher names the
    /// contract, so the reader starts from it.
    text_version: u64,
    list_closed: Option<(u64, u128)>,
    sent_to_reserve: u128,
    keeper_changes: u64,
    bound: bool,
}

impl Default for Earlier {
    fn default() -> Self {
        Self {
            consented: HashMap::new(),
            voided: 0,
            delivered: 0,
            deliveries: 0,
            pending: HashSet::new(),
            replaced: 0,
            cancelled: 0,
            text_version: 1,
            list_closed: None,
            sent_to_reserve: 0,
            keeper_changes: 0,
            bound: false,
        }
    }
}

impl Earlier {
    /// Count one of the claim contract's logs.
    pub(super) fn apply(&mut self, row: &LogRow) -> anyhow::Result<()> {
        match row.event.as_str() {
            "Bound" => self.bound = true,
            "Consented" => {
                let entry = text(row, "entry")?;
                self.pending.remove(&entry);
                self.consented.insert(entry, num(row, "amount")?);
            }
            "Voided" => {
                self.voided += 1;
                self.consented.remove(&text(row, "entry")?);
            }
            "Delivered" => {
                self.deliveries += 1;
                self.delivered = self.delivered.saturating_add(num(row, "amount")?);
            }
            "HolderProposed" => {
                self.pending.insert(text(row, "entry")?);
            }
            "HolderReplaced" => {
                self.replaced += 1;
                self.pending.remove(&text(row, "entry")?);
            }
            "ReplacementCancelled" => {
                self.cancelled += 1;
                self.pending.remove(&text(row, "entry")?);
            }
            "TextPublished" => self.text_version = self.text_version.max(small(row, "version")?),
            "ListClosed" => self.list_closed = Some((row.time, num(row, "open")?)),
            "SentToReserve" => {
                self.sent_to_reserve = self.sent_to_reserve.saturating_add(num(row, "amount")?);
            }
            "KeeperChanged" => self.keeper_changes += 1,
            _ => {}
        }
        Ok(())
    }

    /// The counts and totals, merged into project zero's `earlierBackers`.
    /// `receivers` is how many accounts received Shares from the claim and
    /// what they hold now (they are left out of the holder list).
    pub(super) fn merge_into(&self, out: &mut Value, receivers: (usize, i128)) {
        let Some(obj) = out.as_object_mut() else {
            return;
        };
        let consented_total: u128 = self.consented.values().copied().sum();
        obj.insert("bound".into(), json!(self.bound));
        obj.insert("textVersion".into(), json!(self.text_version));
        obj.insert(
            "consented".into(),
            json!({"count": self.consented.len(), "total": consented_total.to_string()}),
        );
        obj.insert("voidedCount".into(), json!(self.voided));
        obj.insert(
            "delivered".into(),
            json!({"count": self.deliveries, "total": self.delivered.to_string()}),
        );
        obj.insert(
            "replacements".into(),
            json!({"pending": self.pending.len(), "done": self.replaced, "cancelled": self.cancelled}),
        );
        obj.insert(
            "listClosed".into(),
            match self.list_closed {
                Some((at, open)) => json!({"at": at, "open": open.to_string()}),
                None => Value::Null,
            },
        );
        obj.insert(
            "sentToReserve".into(),
            json!(self.sent_to_reserve.to_string()),
        );
        obj.insert("keeperChanges".into(), json!(self.keeper_changes));
        obj.insert(
            "receivers".into(),
            json!({"count": receivers.0, "shares": receivers.1.max(0).to_string()}),
        );
    }
}
