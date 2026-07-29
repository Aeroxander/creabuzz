//! Pluggable EVM signature verification.
//!
//! The relay will hold an implementation of [`SignatureVerifier`]:
//!
//! | Implementation | Covers | Status |
//! |----------------|--------|--------|
//! | [`EoaVerifier`] | EOAs via offline `ecrecover` | shipped |
//! | RPC verifier | EIP-1271 `isValidSignature` (deployed smart accounts) | planned (`rpc` feature) |
//! | EIP-6492 wrapper | counterfactual (undeployed) ERC-4337 accounts | planned (`rpc` feature) |

use crate::error::EvmAuthError;
use crate::siwe::{parse_signature, personal_sign_digest, recover_address};
use crate::EvmAddress;

/// Verifies that `signature` over `message` was produced by `address`.
pub trait SignatureVerifier: Send + Sync {
    /// Verify an EIP-191 `personal_sign` signature.
    fn verify_personal_sign(
        &self,
        address: &EvmAddress,
        message: &[u8],
        signature_hex: &str,
    ) -> Result<bool, EvmAuthError>;
}

/// Offline verifier for externally-owned accounts (plain `ecrecover`).
#[derive(Debug, Default, Clone, Copy)]
pub struct EoaVerifier;

impl SignatureVerifier for EoaVerifier {
    fn verify_personal_sign(
        &self,
        address: &EvmAddress,
        message: &[u8],
        signature_hex: &str,
    ) -> Result<bool, EvmAuthError> {
        let sig = parse_signature(signature_hex)?;
        let recovered = recover_address(&personal_sign_digest(message), &sig)?;
        Ok(&recovered == address)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use k256::ecdsa::SigningKey;

    #[test]
    fn eoa_verifier_roundtrip() {
        let key = SigningKey::from_slice(&[7u8; 32]).unwrap();
        let address = EvmAddress::from_verifying_key(key.verifying_key());
        let message = b"hello creabuzz";

        let digest = personal_sign_digest(message);
        let (sig, recid) = key.sign_prehash_recoverable(&digest).unwrap();
        let mut bytes = sig.to_bytes().to_vec();
        bytes.push(if recid.is_y_odd() { 28 } else { 27 });
        let sig_hex = hex::encode(bytes);

        assert!(EoaVerifier
            .verify_personal_sign(&address, message, &sig_hex)
            .unwrap());

        let other = EvmAddress::from_bytes([1u8; 20]);
        assert!(!EoaVerifier
            .verify_personal_sign(&other, message, &sig_hex)
            .unwrap());
    }
}
