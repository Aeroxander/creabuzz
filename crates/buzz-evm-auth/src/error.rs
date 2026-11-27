//! Error types for EVM authentication.

use thiserror::Error;

/// Errors produced by signature / attestation verification.
#[derive(Debug, Error)]
pub enum EvmAuthError {
    /// An Ethereum address failed to parse (expected 20 bytes / 40 hex chars).
    #[error("invalid address: {0}")]
    InvalidAddress(String),

    /// A signature failed to parse (expected 65 bytes: r‖s‖v) or recovery failed.
    #[error("invalid signature: {0}")]
    InvalidSignature(String),

    /// The recovered signer does not match the declared account.
    #[error("signer mismatch: expected {expected}, recovered {got}")]
    SignerMismatch {
        /// Declared account address.
        expected: String,
        /// Recovered signer address.
        got: String,
    },

    /// The attestation is past its expiry.
    #[error("message expired")]
    Expired,

    /// An RPC-backed verification step failed (transport or on-chain error).
    #[error("rpc: {0}")]
    Rpc(String),
}
