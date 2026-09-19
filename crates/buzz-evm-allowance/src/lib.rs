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
//! - `spend(subject, token, epoch, amount)` — only the authorized spender.
//! - Epoch mapping: day = `unix/86400`, week = `unix/604800`,
//!   month = `unix/2592000`; the all-time `"epoch"` window is contract
//!   epoch `0`.
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
//! by tests against `cast sig`.

mod abi;
mod client;
mod epoch;
mod error;
mod rpc;
mod tx;

pub use client::{
    AllowanceClient, AllowanceDecision, SpendReceipt, DEFAULT_RECEIPT_DEADLINE, DEFAULT_RPC_TIMEOUT,
};
pub use epoch::Window;
pub use error::AllowanceError;
pub use rpc::{EvmRpc, HttpEvmRpc};

#[cfg(feature = "test-support")]
pub mod test_support;
