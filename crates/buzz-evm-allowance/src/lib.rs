//! `buzz-evm-allowance` — the onchain value layer for NIP-ORG budgets.
//!
//! Kind-37012 budgets store spend ceilings, but until this crate nothing
//! enforced them where value actually moves. This crate is the guard: a
//! fail-closed client over the `OrgAllowance.sol` enforcement ledger
//! (`contracts/src/OrgAllowance.sol`), wired at the agent's spend path.
//!
//! # Contract surface (fixed)
//!
//! - `subject` = the agent's 32-byte Nostr pubkey, **verbatim** as `bytes32`.
//! - `allowanceOf/spentOf/remainingOf(subject, token, uint64 epoch)`.
//! - `spendTo(subject, token, epoch, amount, to)` — the ENFORCED payout: the
//!   contract debits the allowance and moves the tokens
//!   `transferFrom(treasury, to, amount)` in one call (only the authorized
//!   spender; the treasury approves the contract). [`AllowanceClient::record_spend_to`].
//! - `spend(subject, token, epoch, amount)` — accounting only / ADVISORY: it
//!   records consumption but moves no tokens, so it binds nothing on whoever
//!   holds the funds. [`AllowanceClient::record_spend`].
//! - Epoch mapping: day = `unix/86400`, week = `unix/604800`,
//!   month = `unix/2592000`; the all-time `"epoch"` window is contract
//!   epoch `0`. The contract rejects an epoch that has not begun
//!   (`epoch > block.timestamp / epochSeconds`, per-subject `epochSeconds`,
//!   default 86400), so the subject's `epochSeconds` must match the window the
//!   client uses.
//!
//! # Failure posture
//!
//! Fail closed. [`AllowanceClient::check`] answers
//! [`AllowanceDecision::Allowed`] only when the contract says the spend
//! fits; every error path — RPC failure, timeout, malformed response, bad
//! input — is [`AllowanceDecision::Denied`]. [`AllowanceClient::record_spend`]
//! returns errors for unset spender keys, gas over-cap, reverted, and
//! unconfirmed transactions; a caller must treat all of them as "the spend
//! did not settle".
//!
//! # No EVM library
//!
//! Like `buzz-evm-auth` and the launchpad composer, this crate ships without
//! alloy/ethers: JSON-RPC over `reqwest`, keccak256/ABI/RLP by hand, signing
//! via `k256`. Selectors are computed from canonical signatures and pinned
//! by tests against `cast sig`. The [`wallet`] module extends the same stack
//! to general-purpose EIP-1559 signing and broadcast (local keys, type-2
//! transactions, bounded receipts) for the desktop app.

// `abi` and `tx` are public so downstream value-layer surfaces (the
// ragequit/exit path in buzz-cli) can reuse the pinned encoders and the
// bounded EIP-155 signing path instead of re-deriving them.
pub mod abi;
mod client;
mod epoch;
mod error;
mod rpc;
pub mod tx;
pub mod wallet;

pub use client::{
    AllowanceClient, AllowanceDecision, SpendReceipt, DEFAULT_RECEIPT_DEADLINE, DEFAULT_RPC_TIMEOUT,
};
pub use epoch::Window;
pub use error::{AllowanceError, WalletError};
pub use rpc::{EvmRpc, HttpEvmRpc};
pub use wallet::{Eip1559TxFields, FeeSuggestion, TxReceipt, Wallet, WalletClient};

#[cfg(feature = "test-support")]
pub mod test_support;
