//! EIP-712 `NostrSigner` attestation: an EVM account authorizes a Nostr
//! signer keypair ("Design 2" in `docs/protocol-strategy.md`).
//!
//! The attestation digest is fully offline to compute and verify (EOA via
//! `ecrecover`). Smart-account accounts verify the same digest through
//! EIP-1271 (`SignatureVerifier`, RPC-backed implementation planned).

use crate::address::{keccak256, EvmAddress};
use crate::error::EvmAuthError;
use crate::siwe::recover_address;

/// EIP-712 domain for creabuzz attestations.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Eip712Domain {
    /// Human-readable protocol name (e.g. `"creabuzz"`).
    pub name: String,
    /// Version string (e.g. `"1"`).
    pub version: String,
    /// EIP-155 chain id the attestation is valid on.
    pub chain_id: u64,
    /// Verifying contract (use the zero address while attestations are
    /// offchain-only).
    pub verifying_contract: EvmAddress,
}

/// An authorization binding an EVM account to a Nostr signer pubkey.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct NostrSignerAttestation {
    /// EVM account granting the authorization (the identity root).
    pub account: EvmAddress,
    /// Nostr public key (x-only, 32 bytes) authorized to sign events.
    pub npub: [u8; 32],
    /// Unix timestamp after which the attestation is invalid.
    pub expires: u64,
    /// Replay-protection nonce (per account).
    pub nonce: u64,
}

/// EIP-712 type string for the attestation struct.
const TYPE_STRING: &str = "NostrSigner(address account,bytes32 npub,uint256 expires,uint256 nonce)";
/// EIP-712 type string for the domain struct.
const DOMAIN_TYPE_STRING: &str =
    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";

impl Eip712Domain {
    /// `keccak256` of the ABI-encoded domain struct.
    pub fn separator(&self) -> [u8; 32] {
        let mut encoded = Vec::with_capacity(5 * 32);
        encoded.extend_from_slice(&keccak256(DOMAIN_TYPE_STRING.as_bytes()));
        encoded.extend_from_slice(&keccak256(self.name.as_bytes()));
        encoded.extend_from_slice(&keccak256(self.version.as_bytes()));
        encoded.extend_from_slice(&u256(self.chain_id));
        encoded.extend_from_slice(&self.verifying_contract.to_word());
        keccak256(&encoded)
    }
}

impl NostrSignerAttestation {
    /// `keccak256` of the ABI-encoded struct.
    pub fn struct_hash(&self) -> [u8; 32] {
        let mut encoded = Vec::with_capacity(5 * 32);
        encoded.extend_from_slice(&keccak256(TYPE_STRING.as_bytes()));
        encoded.extend_from_slice(&self.account.to_word());
        encoded.extend_from_slice(&self.npub);
        encoded.extend_from_slice(&u256(self.expires));
        encoded.extend_from_slice(&u256(self.nonce));
        keccak256(&encoded)
    }

    /// Full EIP-712 digest: `keccak256("\x19\x01" ‖ domainSeparator ‖ structHash)`.
    pub fn digest(&self, domain: &Eip712Domain) -> [u8; 32] {
        let mut data = Vec::with_capacity(2 + 64);
        data.extend_from_slice(b"\x19\x01");
        data.extend_from_slice(&domain.separator());
        data.extend_from_slice(&self.struct_hash());
        keccak256(&data)
    }

    /// Verify a 65-byte hex signature over the attestation digest and require
    /// the recovered signer to be `account`.
    pub fn verify(&self, domain: &Eip712Domain, signature_hex: &str) -> Result<(), EvmAuthError> {
        let sig = crate::siwe::parse_signature(signature_hex)?;
        let recovered = recover_address(&self.digest(domain), &sig)?;
        if recovered != self.account {
            return Err(EvmAuthError::SignerMismatch {
                expected: self.account.to_hex(),
                got: recovered.to_hex(),
            });
        }
        Ok(())
    }

    /// Whether the attestation is expired at `now` (unix seconds).
    pub fn is_expired(&self, now: u64) -> bool {
        self.expires < now
    }
}

/// A signed, stored attestation: the EIP-712 struct + domain + 65-byte hex
/// signature. This is the JSON shape persisted in `evm_identities.attestation`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct AttestationEnvelope {
    /// The authorized signing relationship.
    pub attestation: NostrSignerAttestation,
    /// The EIP-712 domain the attestation was signed under.
    pub domain: Eip712Domain,
    /// 65-byte hex signature over the attestation digest.
    pub signature: String,
}

impl AttestationEnvelope {
    /// Verify the signature, expiry, and that the authorized npub matches the
    /// publishing device key. Returns the EVM account that granted it.
    pub fn verify_for_npub(&self, npub_hex: &str, now: u64) -> Result<EvmAddress, EvmAuthError> {
        if self.attestation.is_expired(now) {
            return Err(EvmAuthError::Expired);
        }
        if hex::encode(self.attestation.npub) != npub_hex {
            return Err(EvmAuthError::SignerMismatch {
                expected: npub_hex.to_string(),
                got: hex::encode(self.attestation.npub),
            });
        }
        self.attestation.verify(&self.domain, &self.signature)?;
        Ok(self.attestation.account)
    }
}

/// ABI-encode a `uint256` from a `u64` (32-byte big-endian).
fn u256(value: u64) -> [u8; 32] {
    let mut word = [0u8; 32];
    word[24..].copy_from_slice(&value.to_be_bytes());
    word
}

#[cfg(test)]
mod tests {
    use super::*;
    use k256::ecdsa::SigningKey;

    fn test_domain() -> Eip712Domain {
        Eip712Domain {
            name: "creabuzz".into(),
            version: "1".into(),
            chain_id: 8453,
            verifying_contract: EvmAddress::from_bytes([0u8; 20]),
        }
    }

    fn attestation_for(key: &SigningKey) -> NostrSignerAttestation {
        NostrSignerAttestation {
            account: EvmAddress::from_verifying_key(key.verifying_key()),
            npub: [42u8; 32],
            expires: 1_800_000_000,
            nonce: 0,
        }
    }

    fn sign_attestation(key: &SigningKey, att: &NostrSignerAttestation) -> String {
        let digest = att.digest(&test_domain());
        let (sig, recid) = key.sign_prehash_recoverable(&digest).unwrap();
        let mut bytes = sig.to_bytes().to_vec();
        bytes.push(if recid.is_y_odd() { 28 } else { 27 });
        hex::encode(bytes)
    }

    #[test]
    fn verify_roundtrip() {
        let key = SigningKey::from_slice(&[7u8; 32]).unwrap();
        let att = attestation_for(&key);
        let sig = sign_attestation(&key, &att);
        att.verify(&test_domain(), &sig).unwrap();
    }

    #[test]
    fn verify_rejects_wrong_signer() {
        let key = SigningKey::from_slice(&[7u8; 32]).unwrap();
        let other = SigningKey::from_slice(&[9u8; 32]).unwrap();
        // Signed by `key`, but `account` is `other`'s address.
        let att = attestation_for(&other);
        let sig = sign_attestation(&key, &att);
        assert!(matches!(
            att.verify(&test_domain(), &sig),
            Err(EvmAuthError::SignerMismatch { .. })
        ));
    }

    #[test]
    fn verify_rejects_tampered_npub() {
        let key = SigningKey::from_slice(&[7u8; 32]).unwrap();
        let att = attestation_for(&key);
        let sig = sign_attestation(&key, &att);
        let tampered = NostrSignerAttestation {
            npub: [43u8; 32],
            ..att
        };
        assert!(tampered.verify(&test_domain(), &sig).is_err());
    }

    #[test]
    fn digest_is_domain_separated() {
        let key = SigningKey::from_slice(&[7u8; 32]).unwrap();
        let att = attestation_for(&key);
        let sig = sign_attestation(&key, &att);
        let other_chain = Eip712Domain {
            chain_id: 1,
            ..test_domain()
        };
        assert!(att.verify(&other_chain, &sig).is_err());
    }

    #[test]
    fn envelope_roundtrip_json() {
        let key = SigningKey::from_slice(&[7u8; 32]).unwrap();
        let att = attestation_for(&key);
        let sig = sign_attestation(&key, &att);
        let env = AttestationEnvelope {
            attestation: att.clone(),
            domain: test_domain(),
            signature: sig.clone(),
        };
        let json = serde_json::to_string(&env).unwrap();
        let back: AttestationEnvelope = serde_json::from_str(&json).unwrap();
        assert_eq!(back, env);
        assert_eq!(back.signature, sig);
    }

    #[test]
    fn envelope_verifies_for_correct_npub() {
        let key = SigningKey::from_slice(&[7u8; 32]).unwrap();
        let att = attestation_for(&key);
        let sig = sign_attestation(&key, &att);
        let env = AttestationEnvelope {
            attestation: att.clone(),
            domain: test_domain(),
            signature: sig.clone(),
        };
        let now = 1_800_000_100; // after expires in attestation_for
                                 // attestation_for uses expires 1_800_000_000; now slightly after → expired.
        assert!(env.verify_for_npub(&hex::encode(att.npub), now).is_err());
        // Before expiry, correct npub verifies.
        let now_ok = 1_700_000_000;
        let account = env.verify_for_npub(&hex::encode(att.npub), now_ok).unwrap();
        assert_eq!(account, att.account);
    }

    #[test]
    fn envelope_rejects_wrong_npub() {
        let key = SigningKey::from_slice(&[7u8; 32]).unwrap();
        let att = attestation_for(&key);
        let sig = sign_attestation(&key, &att);
        let env = AttestationEnvelope {
            attestation: att.clone(),
            domain: test_domain(),
            signature: sig.clone(),
        };
        // Attestation authorizes npub = [42u8; 32]; presenting a different npub
        // must fail.
        let wrong = hex::encode([43u8; 32]);
        assert_ne!(wrong, hex::encode(att.npub));
        assert!(env.verify_for_npub(&wrong, 1_700_000_000).is_err());
    }

    #[test]
    fn envelope_rejects_bad_signature() {
        let key = SigningKey::from_slice(&[7u8; 32]).unwrap();
        let other = SigningKey::from_slice(&[9u8; 32]).unwrap();
        let att = attestation_for(&other);
        // Signed by `key`, but account is `other` → mismatch.
        let sig = sign_attestation(&key, &att);
        let env = AttestationEnvelope {
            attestation: att.clone(),
            domain: test_domain(),
            signature: sig.clone(),
        };
        assert!(env
            .verify_for_npub(&hex::encode(att.npub), 1_700_000_000)
            .is_err());
    }
}
