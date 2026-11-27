//! EIP-191 `personal_sign` digests and `ecrecover`.
//!
//! Verification is offline: the `personal_sign` digest is recovered with
//! `ecrecover` (k256) and compared against the declared address.
//! Smart-account (EIP-1271) and counterfactual (EIP-6492) signatures plug in
//! via [`crate::verifier::SignatureVerifier`].

use k256::ecdsa::{RecoveryId, Signature, VerifyingKey};

use crate::address::{keccak256, EvmAddress};
use crate::error::EvmAuthError;

/// EIP-191 `personal_sign` digest: `keccak256("\x19Ethereum Signed Message:\n" ‖ len ‖ msg)`.
pub fn personal_sign_digest(message: &[u8]) -> [u8; 32] {
    let prefix = format!("\x19Ethereum Signed Message:\n{}", message.len());
    keccak256(&[prefix.as_bytes(), message].concat())
}

/// Parse a 65-byte hex signature (r‖s‖v), `v` as 27/28 or 0/1.
pub(crate) fn parse_signature(signature_hex: &str) -> Result<[u8; 65], EvmAuthError> {
    let hex_str = signature_hex.strip_prefix("0x").unwrap_or(signature_hex);
    let bytes =
        hex::decode(hex_str).map_err(|_| EvmAuthError::InvalidSignature("not hex".into()))?;
    let sig: [u8; 65] = bytes
        .try_into()
        .map_err(|_| EvmAuthError::InvalidSignature("expected 65 bytes r‖s‖v".into()))?;
    Ok(sig)
}

/// `ecrecover`: recover the address that produced `signature` over `digest`.
///
/// High-S signatures are normalized (flipping the recovery parity), matching
/// the behavior of Ethereum tooling.
pub(crate) fn recover_address(
    digest: &[u8; 32],
    signature: &[u8; 65],
) -> Result<EvmAddress, EvmAuthError> {
    let y_parity = match signature[64] {
        27 => false,
        28 => true,
        0 => false,
        1 => true,
        v => {
            return Err(EvmAuthError::InvalidSignature(format!(
                "bad recovery id {v}"
            )))
        }
    };
    let sig = Signature::from_slice(&signature[..64])
        .map_err(|e| EvmAuthError::InvalidSignature(e.to_string()))?;

    // EIP-2: normalize high-S; recovery parity flips when normalization applies.
    let normalized = sig.normalize_s();
    let y_parity = if normalized == sig {
        y_parity
    } else {
        !y_parity
    };
    let sig = normalized;

    let recid = RecoveryId::new(y_parity, false);
    let key = VerifyingKey::recover_from_prehash(digest, &sig, recid)
        .map_err(|e| EvmAuthError::InvalidSignature(e.to_string()))?;
    Ok(EvmAddress::from_verifying_key(&key))
}

#[cfg(test)]
mod tests {
    use super::*;
    use k256::ecdsa::SigningKey;

    fn test_key() -> SigningKey {
        SigningKey::from_slice(&[7u8; 32]).unwrap()
    }

    fn test_address() -> EvmAddress {
        EvmAddress::from_verifying_key(test_key().verifying_key())
    }

    /// Sign `msg` as Ethereum `personal_sign`; returns 65-byte hex (v = 27/28).
    fn sign_personal(key: &SigningKey, msg: &[u8]) -> String {
        let digest = personal_sign_digest(msg);
        let (sig, recid) = key.sign_prehash_recoverable(&digest);
        let mut bytes = sig.to_bytes().to_vec();
        bytes.push(if recid.is_y_odd() { 28 } else { 27 });
        hex::encode(bytes)
    }

    fn recover(key: &SigningKey, signed: &[u8], claimed: &[u8]) -> EvmAddress {
        let sig = parse_signature(&sign_personal(key, signed)).unwrap();
        recover_address(&personal_sign_digest(claimed), &sig).unwrap()
    }

    #[test]
    fn recovers_the_signer_of_a_personal_sign_message() {
        assert_eq!(
            recover(&test_key(), b"hello", b"hello"),
            test_address(),
            "the signer comes back from the signature"
        );
    }

    #[test]
    fn a_different_message_or_key_recovers_a_different_address() {
        assert_ne!(recover(&test_key(), b"hello", b"hullo"), test_address());
        let other = SigningKey::from_slice(&[9u8; 32]).unwrap();
        assert_ne!(recover(&other, b"hello", b"hello"), test_address());
    }

    #[test]
    fn a_malformed_signature_is_refused() {
        assert!(matches!(
            parse_signature("not hex"),
            Err(EvmAuthError::InvalidSignature(_))
        ));
        assert!(matches!(
            parse_signature("0x1234"),
            Err(EvmAuthError::InvalidSignature(_))
        ));
        let mut sig = parse_signature(&sign_personal(&test_key(), b"hello")).unwrap();
        sig[64] = 7;
        assert!(matches!(
            recover_address(&personal_sign_digest(b"hello"), &sig),
            Err(EvmAuthError::InvalidSignature(_))
        ));
    }
}
