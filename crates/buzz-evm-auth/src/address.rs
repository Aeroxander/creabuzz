//! Ethereum address type and the Keccak-256 helper used across the crate.

use std::fmt;

use k256::ecdsa::VerifyingKey;
use serde::{de, Deserialize, Deserializer, Serialize, Serializer};
use sha3::{Digest, Keccak256};

use crate::error::EvmAuthError;

/// Keccak-256 digest.
pub(crate) fn keccak256(data: &[u8]) -> [u8; 32] {
    Keccak256::digest(data).into()
}

/// A 20-byte Ethereum address.
///
/// Hex parsing accepts an optional `0x` prefix and any casing (EIP-55
/// checksums are accepted but not enforced). Display/serialization uses
/// lowercase `0x`-prefixed hex.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct EvmAddress([u8; 20]);

impl EvmAddress {
    /// Build an address from raw bytes.
    pub fn from_bytes(bytes: [u8; 20]) -> Self {
        Self(bytes)
    }

    /// Derive the address for a secp256k1 verifying (public) key:
    /// `address = keccak256(uncompressed_pubkey[1..])[12..]`.
    pub fn from_verifying_key(key: &VerifyingKey) -> Self {
        let point = key.to_encoded_point(false);
        let uncompressed = &point.as_bytes()[1..]; // skip 0x04 tag
        let hash = keccak256(uncompressed);
        let mut addr = [0u8; 20];
        addr.copy_from_slice(&hash[12..]);
        Self(addr)
    }

    /// Parse a `0x`-prefixed (or bare) 40-char hex address.
    pub fn parse(input: &str) -> Result<Self, EvmAuthError> {
        let hex_str = input.strip_prefix("0x").unwrap_or(input);
        if hex_str.len() != 40 {
            return Err(EvmAuthError::InvalidAddress(input.to_string()));
        }
        let decoded =
            hex::decode(hex_str).map_err(|_| EvmAuthError::InvalidAddress(input.to_string()))?;
        let mut addr = [0u8; 20];
        addr.copy_from_slice(&decoded);
        Ok(Self(addr))
    }

    /// Raw 20 bytes.
    pub fn as_bytes(&self) -> &[u8; 20] {
        &self.0
    }

    /// Lowercase `0x`-prefixed hex string.
    pub fn to_hex(&self) -> String {
        format!("0x{}", hex::encode(self.0))
    }

    /// 32-byte left-padded word (ABI encoding).
    pub(crate) fn to_word(&self) -> [u8; 32] {
        let mut word = [0u8; 32];
        word[12..].copy_from_slice(&self.0);
        word
    }
}

impl fmt::Display for EvmAddress {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.to_hex())
    }
}

impl Serialize for EvmAddress {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_hex())
    }
}

impl<'de> Deserialize<'de> for EvmAddress {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let s = String::deserialize(deserializer)?;
        EvmAddress::parse(&s).map_err(de::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_roundtrip() {
        let addr = EvmAddress::parse("0xDeaDbeefdEAdbeefdEadbEEFdeadbeEFdEaDbeeF").unwrap();
        assert_eq!(addr.to_hex(), "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
    }

    #[test]
    fn parse_without_prefix() {
        let addr = EvmAddress::parse("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef").unwrap();
        assert_eq!(addr.as_bytes()[0], 0xde);
    }

    #[test]
    fn parse_rejects_bad_input() {
        assert!(EvmAddress::parse("0x1234").is_err());
        assert!(EvmAddress::parse("0xZZadbeefdeadbeefdeadbeefdeadbeefdeadbeef").is_err());
    }

    #[test]
    fn serde_roundtrip() {
        let addr = EvmAddress::parse("0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef").unwrap();
        let json = serde_json::to_string(&addr).unwrap();
        assert_eq!(json, "\"0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef\"");
        let back: EvmAddress = serde_json::from_str(&json).unwrap();
        assert_eq!(back, addr);
    }

    #[test]
    fn address_from_key_matches_known_vector() {
        // Well-known Hardhat account #0 private key → address.
        let secret =
            hex::decode("ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80")
                .unwrap();
        let key = k256::ecdsa::SigningKey::from_slice(&secret).unwrap();
        let addr = EvmAddress::from_verifying_key(key.verifying_key());
        assert_eq!(addr.to_hex(), "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266");
    }
}
