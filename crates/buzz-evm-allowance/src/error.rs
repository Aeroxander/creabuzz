//! Error type for the onchain allowance guard.
//!
//! Every variant is a hard failure: the guard never upgrades an error into
//! an allowance. Callers that map [`AllowanceError`] onto a spend decision
//! must treat any `Err` as "deny" (fail closed).

use thiserror::Error;

#[derive(Debug, Error)]
pub enum AllowanceError {
    /// A caller-supplied value was malformed (bad hex, bad key, ...).
    #[error("invalid input: {0}")]
    InvalidInput(String),

    /// The EVM node answered with a JSON-RPC error or a transport failure.
    #[error("rpc error on {method}: {detail}")]
    Rpc {
        method: &'static str,
        detail: String,
    },

    /// A bounded RPC round-trip did not complete in time.
    #[error("rpc timeout after {timeout_ms}ms on {method}")]
    Timeout {
        method: &'static str,
        timeout_ms: u64,
    },

    /// `record_spend` was called without a configured spender key.
    #[error("spender key required to record a spend (configure BUZZ_SPENDER_KEY)")]
    NoSpender,

    /// Estimated gas exceeded the safety cap — refuse rather than send an
    /// unbounded transaction (bounded-resource rule).
    #[error("gas estimate {estimated} exceeds the {cap} cap")]
    GasEstimateOverCap { estimated: u64, cap: u64 },

    /// The `spend()` transaction mined but reverted (e.g. contract-side
    /// `OverSpend` / `NotSpender`).
    #[error("spend transaction {tx_hash} reverted onchain")]
    SpendReverted { tx_hash: String },

    /// The contract refused the spend at simulation time (e.g. `OverSpend`
    /// surfaced by `eth_estimateGas`). Nothing was broadcast; the refusal is
    /// the chain's answer, not a transport failure.
    #[error("contract refused the spend at simulation: {detail}")]
    SpendRejectedByContract { detail: String },

    /// The spend transaction was broadcast but did not mine within the
    /// bounded wait. The onchain spent counter may or may not include it;
    /// the caller must treat the spend as unsettled and re-check.
    #[error("spend transaction {tx_hash} not mined within {deadline_ms}ms; outcome unknown")]
    SpendUnconfirmed { tx_hash: String, deadline_ms: u64 },

    /// The contract returned data the decoder could not read.
    #[error("contract returned malformed data: {0}")]
    MalformedResponse(String),
}
