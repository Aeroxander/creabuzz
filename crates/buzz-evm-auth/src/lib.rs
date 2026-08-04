#![deny(unsafe_code)]
#![warn(missing_docs)]
//! `buzz-evm-auth` — EVM identity for the Buzz relay (creabuzz).
//!
//! ## Auth paths
//!
//! | Path | Transport | Description |
//! |------|-----------|-------------|
//! | SIWE (EIP-4361) | HTTP | `personal_sign` login; EOA verified via `ecrecover` |
//! | Signer attestation (EIP-712) | Nostr event | EVM account authorizes a Nostr signer key |
//!
//! ## Design
//!
//! Identity root = an EVM account (EOA or counterfactual ERC-4337 smart
//! account). Nostr keys are hot, per-device, revocable signers authorized by
//! an EIP-712 attestation. See `docs/protocol-strategy.md` (Design 2).
//!
//! EIP-1271 (smart-account `isValidSignature`) and EIP-6492 (counterfactual
//! accounts) plug in via [`verifier::SignatureVerifier`]; the offline EOA
//! verifier ships first. The RPC-backed verifier is intentionally a separate
//! step so this crate stays hermetic and fast to test.

/// Ethereum address type and Keccak-256 helper.
pub mod address;
/// EIP-712 `NostrSigner` attestation (EVM account → Nostr signer key).
pub mod attestation;
/// Error types.
pub mod error;
/// EIP-4361 "Sign-In with Ethereum" parsing and verification.
pub mod siwe;
/// Pluggable signature verification (EOA now; EIP-1271/6492 later).
pub mod verifier;

/// ERC-6492 wrapper + ABI helpers.
pub mod erc6492;

/// RPC-backed verification (EIP-1271/6492) for smart accounts.
#[cfg(feature = "rpc")]
pub mod rpc;

pub use address::EvmAddress;
pub use attestation::{Eip712Domain, NostrSignerAttestation};
pub use error::EvmAuthError;
pub use siwe::{
    personal_sign_digest, verify as verify_siwe, SiweMessage, SiweRequirements, DEFAULT_LEEWAY_SECS,
};

#[cfg(feature = "rpc")]
pub use siwe::verify_siwe_smart;
pub use verifier::{EoaVerifier, SignatureVerifier};

#[cfg(feature = "rpc")]
pub use rpc::{HttpJsonRpc, JsonRpc, RpcSignatureVerifier};
