//! EIP-4361 "Sign-In with Ethereum" (SIWE) message parsing and verification.
//!
//! Verification is offline: the EIP-191 `personal_sign` digest is recovered
//! with `ecrecover` (k256) and compared against the declared address.
//! Smart-account (EIP-1271) and counterfactual (EIP-6492) signatures plug in
//! via [`crate::verifier::SignatureVerifier`].

use chrono::{DateTime, Utc};
use k256::ecdsa::{RecoveryId, Signature, VerifyingKey};

use crate::address::{keccak256, EvmAddress};
use crate::error::EvmAuthError;

/// Suffix of the SIWE header line (EIP-4361 ABNF `domain` production).
const HEADER_SUFFIX: &str = " wants you to sign in with your Ethereum account:";

/// Default clock leeway applied to time-window checks (5 minutes).
pub const DEFAULT_LEEWAY_SECS: i64 = 300;

/// A parsed SIWE message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SiweMessage {
    /// Domain requesting the signing (must match the relay host).
    pub domain: String,
    /// Ethereum address requesting the signing.
    pub address: EvmAddress,
    /// Optional human-readable statement.
    pub statement: Option<String>,
    /// RFC 3986 URI referring to the resource that is the subject of the signing.
    pub uri: String,
    /// SIWE version (must be `1`).
    pub version: u8,
    /// EIP-155 chain id.
    pub chain_id: u64,
    /// Server-issued nonce (the relay validates its value; we validate shape).
    pub nonce: String,
    /// ISO 8601 issuance time.
    pub issued_at: DateTime<Utc>,
    /// Optional ISO 8601 expiration time.
    pub expiration_time: Option<DateTime<Utc>>,
    /// Optional ISO 8601 not-before time.
    pub not_before: Option<DateTime<Utc>>,
    /// Optional system-specific request id.
    pub request_id: Option<String>,
    /// Optional list of resources (URIs).
    pub resources: Vec<String>,
}

/// What the caller requires a SIWE login to satisfy.
#[derive(Debug, Clone)]
pub struct SiweRequirements {
    /// Domain that must appear in the header (e.g. the relay's host).
    pub domain: String,
    /// Expected EIP-155 chain id; `None` accepts any chain.
    pub chain_id: Option<u64>,
}

impl SiweMessage {
    /// Parse a canonical SIWE message (structure only — no signature or
    /// time-window validation).
    pub fn parse(raw: &str) -> Result<Self, EvmAuthError> {
        let mut lines = raw.split('\n');

        let header = lines
            .next()
            .ok_or_else(|| EvmAuthError::InvalidMessage("empty message".into()))?;
        let domain = header
            .strip_suffix(HEADER_SUFFIX)
            .ok_or_else(|| EvmAuthError::InvalidMessage("bad header line".into()))?;
        if domain.is_empty() {
            return Err(EvmAuthError::InvalidMessage("empty domain".into()));
        }

        let address = EvmAddress::parse(
            lines
                .next()
                .ok_or_else(|| EvmAuthError::InvalidMessage("missing address line".into()))?,
        )?;

        expect_blank(&mut lines, "after address")?;

        // Optional statement: everything up to the next blank line.
        let mut statement = String::new();
        for line in lines.by_ref() {
            if line.is_empty() {
                break;
            }
            if !statement.is_empty() {
                statement.push('\n');
            }
            statement.push_str(line);
        }
        let statement = (!statement.is_empty()).then_some(statement);

        let uri = take_field(&mut lines, "URI: ")?.to_string();
        let version: u8 = take_field(&mut lines, "Version: ")?
            .parse()
            .map_err(|_| EvmAuthError::InvalidMessage("bad version".into()))?;
        if version != 1 {
            return Err(EvmAuthError::InvalidMessage(format!(
                "unsupported version {version}"
            )));
        }
        let chain_id: u64 = take_field(&mut lines, "Chain ID: ")?
            .parse()
            .map_err(|_| EvmAuthError::InvalidMessage("bad chain id".into()))?;
        let nonce = take_field(&mut lines, "Nonce: ")?.to_string();
        if nonce.len() < 8 || !nonce.chars().all(|c| c.is_ascii_alphanumeric()) {
            return Err(EvmAuthError::InvalidMessage("bad nonce".into()));
        }
        let issued_at = parse_time(take_field(&mut lines, "Issued At: ")?)?;

        let mut expiration_time = None;
        let mut not_before = None;
        let mut request_id = None;
        let mut resources = Vec::new();

        for line in lines {
            if let Some(v) = line.strip_prefix("Expiration Time: ") {
                expiration_time = Some(parse_time(v)?);
            } else if let Some(v) = line.strip_prefix("Not Before: ") {
                not_before = Some(parse_time(v)?);
            } else if let Some(v) = line.strip_prefix("Request ID: ") {
                request_id = Some(v.to_string());
            } else if line == "Resources:" {
                // Remaining lines are "- <uri>" entries.
            } else if let Some(v) = line.strip_prefix("- ") {
                resources.push(v.to_string());
            } else {
                return Err(EvmAuthError::InvalidMessage(format!(
                    "unexpected line: {line:?}"
                )));
            }
        }

        Ok(Self {
            domain: domain.to_string(),
            address,
            statement,
            uri,
            version,
            chain_id,
            nonce,
            issued_at,
            expiration_time,
            not_before,
            request_id,
            resources,
        })
    }

    /// Check the issuance/expiration/not-before window against `now`
    /// (with [`DEFAULT_LEEWAY_SECS`] of clock leeway).
    pub fn validate_window(&self, now: DateTime<Utc>) -> Result<(), EvmAuthError> {
        let leeway = chrono::Duration::seconds(DEFAULT_LEEWAY_SECS);
        if let Some(exp) = self.expiration_time {
            if now > exp + leeway {
                return Err(EvmAuthError::Expired);
            }
        }
        if let Some(nbf) = self.not_before {
            if now + leeway < nbf {
                return Err(EvmAuthError::NotYetValid);
            }
        }
        if now + leeway < self.issued_at {
            return Err(EvmAuthError::NotYetValid);
        }
        Ok(())
    }
}

/// Full SIWE login verification: parse → requirements → signature → window.
///
/// Returns the verified message on success. The caller owns nonce issuance
/// and must additionally check `message.nonce` against its nonce store.
pub fn verify(
    raw_message: &str,
    signature_hex: &str,
    requirements: &SiweRequirements,
    now: DateTime<Utc>,
) -> Result<SiweMessage, EvmAuthError> {
    let message = SiweMessage::parse(raw_message)?;

    if message.domain != requirements.domain {
        return Err(EvmAuthError::DomainMismatch {
            expected: requirements.domain.clone(),
            got: message.domain.clone(),
        });
    }
    if let Some(expected_chain) = requirements.chain_id {
        if message.chain_id != expected_chain {
            return Err(EvmAuthError::ChainIdMismatch {
                expected: expected_chain,
                got: message.chain_id,
            });
        }
    }

    let recovered = recover_siwe_signer(raw_message, signature_hex)?;
    if recovered != message.address {
        return Err(EvmAuthError::SignerMismatch {
            expected: message.address.to_hex(),
            got: recovered.to_hex(),
        });
    }

    message.validate_window(now)?;
    Ok(message)
}

/// EIP-191 `personal_sign` digest: `keccak256("\x19Ethereum Signed Message:\n" ‖ len ‖ msg)`.
pub fn personal_sign_digest(message: &[u8]) -> [u8; 32] {
    let prefix = format!("\x19Ethereum Signed Message:\n{}", message.len());
    keccak256(&[prefix.as_bytes(), message].concat())
}

/// Recover the signer of a SIWE message given a 65-byte hex `personal_sign` signature.
pub fn recover_siwe_signer(
    raw_message: &str,
    signature_hex: &str,
) -> Result<EvmAddress, EvmAuthError> {
    let sig = parse_signature(signature_hex)?;
    let digest = personal_sign_digest(raw_message.as_bytes());
    recover_address(&digest, &sig)
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
    let (sig, y_parity) = match sig.normalize_s() {
        Some(normalized) => (normalized, !y_parity),
        None => (sig, y_parity),
    };

    let recid = RecoveryId::new(y_parity, false);
    let key = VerifyingKey::recover_from_prehash(digest, &sig, recid)
        .map_err(|e| EvmAuthError::InvalidSignature(e.to_string()))?;
    Ok(EvmAddress::from_verifying_key(&key))
}

fn expect_blank<'a, I>(lines: &mut I, ctx: &str) -> Result<(), EvmAuthError>
where
    I: Iterator<Item = &'a str>,
{
    match lines.next() {
        Some("") => Ok(()),
        _ => Err(EvmAuthError::InvalidMessage(format!(
            "expected blank line {ctx}"
        ))),
    }
}

fn take_field<'a, I>(lines: &mut I, prefix: &str) -> Result<&'a str, EvmAuthError>
where
    I: Iterator<Item = &'a str>,
{
    lines
        .next()
        .and_then(|line| line.strip_prefix(prefix))
        .ok_or_else(|| EvmAuthError::InvalidMessage(format!("expected `{prefix}` line")))
}

fn parse_time(value: &str) -> Result<DateTime<Utc>, EvmAuthError> {
    DateTime::parse_from_rfc3339(value)
        .map(|dt| dt.with_timezone(&Utc))
        .map_err(|_| EvmAuthError::InvalidMessage(format!("bad timestamp: {value:?}")))
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
        let (sig, recid) = key.sign_prehash_recoverable(&digest).unwrap();
        let mut bytes = sig.to_bytes().to_vec();
        bytes.push(if recid.is_y_odd() { 28 } else { 27 });
        hex::encode(bytes)
    }

    fn build_message(address: &EvmAddress) -> String {
        format!(
            "login.example.com wants you to sign in with your Ethereum account:\n\
             {address}\n\
             \n\
             I accept the creabuzz Terms of Service.\n\
             \n\
             URI: https://login.example.com\n\
             Version: 1\n\
             Chain ID: 8453\n\
             Nonce: abc123xy\n\
             Issued At: 2026-07-28T10:00:00Z\n\
             Expiration Time: 2026-07-28T10:10:00Z"
        )
    }

    fn req() -> SiweRequirements {
        SiweRequirements {
            domain: "login.example.com".into(),
            chain_id: Some(8453),
        }
    }

    fn now(iso: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(iso)
            .unwrap()
            .with_timezone(&Utc)
    }

    #[test]
    fn parse_full_message() {
        let addr = test_address();
        let msg = SiweMessage::parse(&build_message(&addr)).unwrap();
        assert_eq!(msg.domain, "login.example.com");
        assert_eq!(msg.address, addr);
        assert_eq!(
            msg.statement.as_deref(),
            Some("I accept the creabuzz Terms of Service.")
        );
        assert_eq!(msg.chain_id, 8453);
        assert_eq!(msg.nonce, "abc123xy");
        assert!(msg.expiration_time.is_some());
    }

    #[test]
    fn parse_without_statement() {
        let addr = test_address();
        let raw = format!(
            "login.example.com wants you to sign in with your Ethereum account:\n\
             {addr}\n\
             \n\
             \n\
             URI: https://login.example.com\n\
             Version: 1\n\
             Chain ID: 1\n\
             Nonce: abc123xy\n\
             Issued At: 2026-07-28T10:00:00Z"
        );
        let msg = SiweMessage::parse(&raw).unwrap();
        assert_eq!(msg.statement, None);
        assert_eq!(msg.chain_id, 1);
    }

    #[test]
    fn verify_roundtrip() {
        let addr = test_address();
        let raw = build_message(&addr);
        let sig = sign_personal(&test_key(), raw.as_bytes());
        let msg = verify(&raw, &sig, &req(), now("2026-07-28T10:05:00Z")).unwrap();
        assert_eq!(msg.address, addr);
    }

    #[test]
    fn verify_rejects_wrong_domain() {
        let addr = test_address();
        let raw = build_message(&addr);
        let sig = sign_personal(&test_key(), raw.as_bytes());
        let req = SiweRequirements {
            domain: "other.example.com".into(),
            chain_id: None,
        };
        assert!(matches!(
            verify(&raw, &sig, &req, now("2026-07-28T10:05:00Z")),
            Err(EvmAuthError::DomainMismatch { .. })
        ));
    }

    #[test]
    fn verify_rejects_wrong_chain() {
        let addr = test_address();
        let raw = build_message(&addr);
        let sig = sign_personal(&test_key(), raw.as_bytes());
        let req = SiweRequirements {
            domain: "login.example.com".into(),
            chain_id: Some(1),
        };
        assert!(matches!(
            verify(&raw, &sig, &req, now("2026-07-28T10:05:00Z")),
            Err(EvmAuthError::ChainIdMismatch { .. })
        ));
    }

    #[test]
    fn verify_rejects_expired() {
        let addr = test_address();
        let raw = build_message(&addr);
        let sig = sign_personal(&test_key(), raw.as_bytes());
        assert!(matches!(
            verify(&raw, &sig, &req(), now("2026-07-28T11:00:00Z")),
            Err(EvmAuthError::Expired)
        ));
    }

    #[test]
    fn verify_rejects_tampered_message() {
        let addr = test_address();
        let raw = build_message(&addr);
        let sig = sign_personal(&test_key(), raw.as_bytes());
        let tampered = raw.replace("Chain ID: 8453", "Chain ID: 1");
        let req = SiweRequirements {
            domain: "login.example.com".into(),
            chain_id: None,
        };
        assert!(matches!(
            verify(&tampered, &sig, &req, now("2026-07-28T10:05:00Z")),
            Err(EvmAuthError::SignerMismatch { .. })
        ));
    }

    #[test]
    fn verify_rejects_signature_from_other_key() {
        let addr = test_address();
        let raw = build_message(&addr);
        let other = SigningKey::from_slice(&[9u8; 32]).unwrap();
        let sig = sign_personal(&other, raw.as_bytes());
        assert!(matches!(
            verify(&raw, &sig, &req(), now("2026-07-28T10:05:00Z")),
            Err(EvmAuthError::SignerMismatch { .. })
        ));
    }

    #[test]
    fn verify_rejects_bad_nonce_shape() {
        let addr = test_address();
        let raw = build_message(&addr).replace("Nonce: abc123xy", "Nonce: x!");
        assert!(matches!(
            SiweMessage::parse(&raw),
            Err(EvmAuthError::InvalidMessage(_))
        ));
    }
}


