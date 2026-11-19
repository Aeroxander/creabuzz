//! The helper's settings (`BUZZ_CHAIN_HELPER_*`). Off unless its key is set;
//! any other helper setting without the key, or a value that cannot be read,
//! stops startup.

use std::fmt;
use std::sync::Arc;

use buzz_evm_allowance::tx::MAX_GAS_CEILING;
use buzz_evm_allowance::Wallet;

/// The relay-held key the helper signs with. `Debug` prints the address
/// only; the key is never printed or stored anywhere else.
#[derive(Clone)]
pub struct HelperKey(pub Arc<Wallet>);

impl fmt::Debug for HelperKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "HelperKey({}, <redacted>)", self.0.address_hex())
    }
}

impl PartialEq for HelperKey {
    fn eq(&self, other: &Self) -> bool {
        self.0.address() == other.0.address()
    }
}

impl Eq for HelperKey {}

/// The helper's settings.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HelperConfig {
    /// `BUZZ_CHAIN_HELPER_KEY`: 32-byte hex. Keep a small balance on it.
    pub key: HelperKey,
    /// `BUZZ_CHAIN_HELPER_DAILY_GAS` (default 30,000,000, at least the per-call
    /// cap): gas the helper may use in any 24 hours, counting what is
    /// reserved for transactions in flight. The calls may use half of it
    /// (`calls::ROUTINE_SHARE_PERCENT`); only the replacement of a stuck
    /// transaction may pass that.
    pub daily_gas: u128,
    /// `BUZZ_CHAIN_HELPER_DAILY_SPEND_WEI` (default 10^16, 0.01 of the native
    /// coin): fees the helper may pay in any 24 hours, reserved the same way.
    pub daily_spend_wei: u128,
    /// `BUZZ_CHAIN_HELPER_MAX_ATTEMPTS` (default 8): failed attempts before a
    /// job ends `failed`.
    pub max_attempts: u32,
    /// `BUZZ_CHAIN_HELPER_CALL_GAS_CAP` (default 3,000,000, at most
    /// 8,000,000): the most gas one call may use.
    pub call_gas_cap: u64,
    /// Seconds between job builds (60; tests use 0).
    pub build_every_secs: u64,
    /// Seconds a sent transaction may wait unmined before it is replaced
    /// with a higher fee (180).
    pub stuck_after_secs: u64,
    /// Seconds to wait for a receipt right after sending (30; tests use 0).
    pub wait_secs: u64,
}

/// Every helper variable but the key: set without the key, startup stops.
pub const OTHER_VARS: [&str; 4] = [
    "BUZZ_CHAIN_HELPER_DAILY_GAS",
    "BUZZ_CHAIN_HELPER_DAILY_SPEND_WEI",
    "BUZZ_CHAIN_HELPER_MAX_ATTEMPTS",
    "BUZZ_CHAIN_HELPER_CALL_GAS_CAP",
];

fn var(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty())
}

fn number(name: &str, default: u128, min: u128, max: u128) -> Result<u128, String> {
    match var(name) {
        None => Ok(default),
        Some(raw) => match raw.parse::<u128>() {
            Ok(v) if (min..=max).contains(&v) => Ok(v),
            _ => Err(format!(
                "{name} must be a whole number from {min} to {max} (got \"{raw}\")"
            )),
        },
    }
}

impl HelperConfig {
    /// A configuration with the defaults for `key` (tests, and the base of
    /// [`HelperConfig::from_env`]).
    pub fn with_key(wallet: Wallet) -> Self {
        Self {
            key: HelperKey(Arc::new(wallet)),
            daily_gas: 30_000_000,
            daily_spend_wei: 10_000_000_000_000_000,
            max_attempts: 8,
            call_gas_cap: 3_000_000,
            build_every_secs: 60,
            stuck_after_secs: 180,
            wait_secs: 30,
        }
    }

    /// Read the settings; `Ok(None)` when the helper is off.
    pub fn from_env() -> Result<Option<Self>, String> {
        let Some(raw_key) = var("BUZZ_CHAIN_HELPER_KEY") else {
            if let Some(set) = OTHER_VARS.iter().find(|v| var(v).is_some()) {
                return Err(format!(
                    "{set} is set but BUZZ_CHAIN_HELPER_KEY is not; set the key to run the helper, or neither"
                ));
            }
            return Ok(None);
        };
        let clean = raw_key.strip_prefix("0x").unwrap_or(&raw_key);
        if clean.len() != 64 || !clean.bytes().all(|b| b.is_ascii_hexdigit()) {
            // The value is never echoed: it is meant to be a secret key.
            return Err("BUZZ_CHAIN_HELPER_KEY must be a 32-byte hex key".into());
        }
        let wallet = Wallet::from_private_key_hex(clean)
            .map_err(|_| "BUZZ_CHAIN_HELPER_KEY is not a valid key".to_string())?;
        let mut cfg = Self::with_key(wallet);
        cfg.daily_gas = number(
            "BUZZ_CHAIN_HELPER_DAILY_GAS",
            cfg.daily_gas,
            21_000,
            u128::from(u64::MAX),
        )?;
        cfg.daily_spend_wei = number(
            "BUZZ_CHAIN_HELPER_DAILY_SPEND_WEI",
            cfg.daily_spend_wei,
            1,
            u128::MAX / 2,
        )?;
        cfg.max_attempts = number("BUZZ_CHAIN_HELPER_MAX_ATTEMPTS", 8, 1, 100)? as u32;
        cfg.call_gas_cap = number(
            "BUZZ_CHAIN_HELPER_CALL_GAS_CAP",
            u128::from(cfg.call_gas_cap),
            21_000,
            u128::from(MAX_GAS_CEILING),
        )? as u64;
        // A day must hold at least one call of the largest size, or a job of
        // that size would be put off every day without end (review B1).
        if cfg.daily_gas < u128::from(cfg.call_gas_cap) {
            return Err(format!(
                "BUZZ_CHAIN_HELPER_DAILY_GAS ({}) must be at least BUZZ_CHAIN_HELPER_CALL_GAS_CAP ({})",
                cfg.daily_gas, cfg.call_gas_cap
            ));
        }
        Ok(Some(cfg))
    }
}
