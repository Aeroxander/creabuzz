//! The market side of a project's numbers: its sales' auctions (bids, exits,
//! claims, clearing price), its pool's trades and the pool fees the
//! Launcher's LiquidityHolder collects for it. Counts and totals only: no
//! bidder or trader is listed here.

use std::collections::BTreeMap;

use serde_json::{json, Value};

use super::super::events::Role;
use super::{num, text, LogRow};

/// One auction's bids.
#[derive(Debug, Default)]
struct Bids {
    count: u64,
    amount: u128,
    exited: u64,
    refunded: u128,
    claimed: u128,
    clearing_price_q96: Option<String>,
    supply: Option<String>,
}

/// The market side of a project, added up from its logs.
#[derive(Debug, Default)]
pub(super) struct Market {
    bids: BTreeMap<String, Bids>,
    collections: u64,
    fee_dollars: u128,
    fee_to_platform: u128,
    fee_to_project: u128,
    shares_burned: u128,
    owed: u128,
    owed_sent: u128,
    trades: u64,
    trade_dollars: u128,
    shares_bought: u128,
    shares_sold: u128,
    last_sqrt_price_x96: Option<String>,
    last_tick: Option<String>,
}

/// A signed decimal string (`intN`) as an `i128`; the pool's amounts are
/// `int128`, so they always fit.
fn signed(row: &LogRow, name: &str) -> anyhow::Result<i128> {
    let t = text(row, name)?;
    t.parse::<i128>()
        .map_err(|_| anyhow::anyhow!("{} {name} is not a signed number: {t}", row.event))
}

impl Market {
    /// Count one log. `shares_first` says whether the project's Shares are the
    /// pool's `currency0` (the lower address of the Shares and the dollar
    /// token); `treasury` is the project's Treasury, the receiver of what the
    /// holder owes the project.
    pub(super) fn apply(
        &mut self,
        row: &LogRow,
        shares_first: bool,
        treasury: &str,
    ) -> anyhow::Result<()> {
        let add = |total: &mut u128, v: u128| *total = total.saturating_add(v);
        match (row.role, row.event.as_str()) {
            (Role::Auction, event) => {
                let auction = super::super::word::hex0x(&row.address);
                let b = self.bids.entry(auction).or_default();
                match event {
                    "BidSubmitted" => {
                        b.count += 1;
                        add(&mut b.amount, num(row, "amount")?);
                    }
                    "BidExited" => {
                        b.exited += 1;
                        add(&mut b.refunded, num(row, "currencyRefunded")?);
                    }
                    "TokensClaimed" => add(&mut b.claimed, num(row, "tokensFilled")?),
                    "CheckpointUpdated" | "ClearingPriceUpdated" => {
                        b.clearing_price_q96 = Some(text(row, "clearingPriceQ96")?);
                    }
                    "TokensReceived" => b.supply = Some(text(row, "totalSupply")?),
                    _ => {}
                }
            }
            (Role::Holder, "Collected") => {
                self.collections += 1;
                add(&mut self.fee_dollars, num(row, "dollars")?);
                add(&mut self.fee_to_platform, num(row, "toPlatform")?);
                add(&mut self.fee_to_project, num(row, "toProject")?);
                add(&mut self.shares_burned, num(row, "sharesBurned")?);
            }
            (Role::Holder, "Owed") if text(row, "to")? == treasury => {
                add(&mut self.owed, num(row, "amount")?);
            }
            (Role::Holder, "OwedSent") if text(row, "to")? == treasury => {
                add(&mut self.owed_sent, num(row, "amount")?);
            }
            (Role::PoolManager, "Swap") => {
                // The amounts are the trader's: below zero is what the trader
                // paid into the pool, above zero what it took out.
                let (shares, dollars) = if shares_first {
                    (signed(row, "amount0")?, signed(row, "amount1")?)
                } else {
                    (signed(row, "amount1")?, signed(row, "amount0")?)
                };
                self.trades += 1;
                add(&mut self.trade_dollars, dollars.unsigned_abs());
                if shares > 0 {
                    add(&mut self.shares_bought, shares.unsigned_abs());
                } else {
                    add(&mut self.shares_sold, shares.unsigned_abs());
                }
                self.last_sqrt_price_x96 = Some(text(row, "sqrtPriceX96")?);
                self.last_tick = Some(text(row, "tick")?);
            }
            _ => {}
        }
        Ok(())
    }

    /// Each auction's bids, in address order.
    pub(super) fn bids_json(&self) -> Value {
        Value::Array(
            self.bids
                .iter()
                .map(|(auction, b)| {
                    json!({
                        "auction": auction, "count": b.count, "amount": b.amount.to_string(),
                        "exited": b.exited, "refunded": b.refunded.to_string(),
                        "sharesClaimed": b.claimed.to_string(),
                        "clearingPriceQ96": b.clearing_price_q96, "sharesForSale": b.supply,
                    })
                })
                .collect(),
        )
    }

    /// The pool's trades and fees.
    pub(super) fn pool_json(&self) -> Value {
        json!({
            "trades": self.trades,
            "tradedDollars": self.trade_dollars.to_string(),
            "sharesBought": self.shares_bought.to_string(),
            "sharesSold": self.shares_sold.to_string(),
            "sqrtPriceX96": self.last_sqrt_price_x96,
            "tick": self.last_tick,
            "fees": {
                "collections": self.collections,
                "dollars": self.fee_dollars.to_string(),
                "toPlatform": self.fee_to_platform.to_string(),
                "toProject": self.fee_to_project.to_string(),
                "sharesBurned": self.shares_burned.to_string(),
                "owedToProject": self.owed.saturating_sub(self.owed_sent).to_string(),
            },
        })
    }
}
