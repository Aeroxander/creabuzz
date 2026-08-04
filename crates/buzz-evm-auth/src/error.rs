//! Error types for EVM authentication.

use thiserror::Error;

/// Errors produced by SIWE / attestation verification.
#[derive(Debug, Error)]
pub enum EvmAuthError {
    /// An Ethereum address failed to parse (expected 20 bytes / 40 hex chars).
    #[error("invalid address: {0}")]
    InvalidAddress(String),

    /// A signature failed to parse (expected 65 bytes: r‖s‖v) or recovery failed.
    #[error("invalid signature: {0}")]
    InvalidSignature(String),

    /// A SIWE message is structurally invalid (EIP-4361).
    #[error("invalid SIWE message: {0}")]
    InvalidMessage(String),

    /// The SIWE message domain does not match the expected (relay) domain.
    #[error("domain mismatch: expected {expected}, got {got}")]
    DomainMismatch {
        /// Domain the verifier requires.
        expected: String,
        /// Domain found in the message.
        got: String,
    },

    /// The chain id does not match the expected chain.
    #[error("chain id mismatch: expected {expected}, got {got}")]
    ChainIdMismatch {
        /// Chain id the verifier requires.
        expected: u64,
        /// Chain id found in the message.
        got: u64,
    },

    /// The recovered signer does not match the declared account.
    #[error("signer mismatch: expected {expected}, recovered {got}")]
    SignerMismatch {
        /// Declared account address.
        expected: String,
        /// Recovered signer address.
        got: String,
    },

    /// The message is past its `Expiration Time`.
    #[error("message expired")]
    Expired,

    /// The message is not valid yet (`Not Before` or future `Issued At`).
    #[error("message not yet valid")]
    NotYetValid,

    /// An RPC-backed verification step failed (transport or on-chain error).
    #[error("rpc: {0}")]
    Rpc(String),
}
