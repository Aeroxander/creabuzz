//! Budget-window → contract-epoch derivation.
//!
//! Mirrors the documented epoch mapping on `OrgAllowance.sol`:
//! day = `unix/86400`, week = `unix/604800`, month = `unix/2592000`
//! (fixed 30-day months in dev). The all-time `"epoch"` window maps to the
//! constant epoch `0` — it never resets, so it needs no time-derived key.

use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::AllowanceError;

const DAY_SECS: u64 = 86_400;
const WEEK_SECS: u64 = 604_800;
/// Fixed 30-day months — the documented dev simplification on
/// `OrgAllowance.sol`, not calendar months.
const MONTH_SECS: u64 = 2_592_000;

/// The budget window a kind:37012 spend ceiling uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Window {
    /// All-time cumulative (contract epoch `0`, never resets).
    Epoch,
    /// Resets each day (`unix/86400`).
    Day,
    /// Resets each week (`unix/604800`).
    Week,
    /// Resets each fixed 30-day month (`unix/2592000`).
    Month,
}

impl Window {
    /// The contract's `uint64` epoch for this window at `unix_secs`.
    pub fn epoch_at(self, unix_secs: u64) -> u64 {
        match self {
            Window::Epoch => 0,
            Window::Day => unix_secs / DAY_SECS,
            Window::Week => unix_secs / WEEK_SECS,
            Window::Month => unix_secs / MONTH_SECS,
        }
    }

    /// The contract's `uint64` epoch for this window at the current time.
    pub fn epoch_now(self) -> u64 {
        let secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            // A clock before the epoch is a broken clock: epoch 0 is the
            // conservative (most restrictive) mapping.
            .unwrap_or(0);
        self.epoch_at(secs)
    }
}

impl std::fmt::Display for Window {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl Window {
    /// The kind:37012 window string this variant mirrors.
    pub fn as_str(self) -> &'static str {
        match self {
            Window::Epoch => "epoch",
            Window::Day => "day",
            Window::Week => "week",
            Window::Month => "month",
        }
    }
}

impl std::str::FromStr for Window {
    type Err = AllowanceError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "epoch" => Ok(Window::Epoch),
            "day" => Ok(Window::Day),
            "week" => Ok(Window::Week),
            "month" => Ok(Window::Month),
            other => Err(AllowanceError::InvalidInput(format!(
                "unknown window {other:?} (expected epoch/day/week/month)"
            ))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn day_epoch_is_unix_over_86400() {
        assert_eq!(Window::Day.epoch_at(0), 0);
        assert_eq!(Window::Day.epoch_at(86_399), 0);
        assert_eq!(Window::Day.epoch_at(86_400), 1);
        assert_eq!(Window::Day.epoch_at(1_758_240_000), 20_350);
    }

    #[test]
    fn week_epoch_is_unix_over_604800() {
        assert_eq!(Window::Week.epoch_at(604_799), 0);
        assert_eq!(Window::Week.epoch_at(604_800), 1);
    }

    #[test]
    fn month_epoch_is_fixed_30_day_months() {
        assert_eq!(Window::Month.epoch_at(2_591_999), 0);
        assert_eq!(Window::Month.epoch_at(2_592_000), 1);
    }

    #[test]
    fn all_time_epoch_is_constant_zero() {
        assert_eq!(Window::Epoch.epoch_at(0), 0);
        assert_eq!(Window::Epoch.epoch_at(u64::MAX / 2), 0);
    }

    #[test]
    fn window_strings_round_trip() {
        for name in ["epoch", "day", "week", "month"] {
            let w: Window = name.parse().unwrap();
            assert_eq!(w.as_str(), name);
        }
        assert!("hour".parse::<Window>().is_err());
    }
}
