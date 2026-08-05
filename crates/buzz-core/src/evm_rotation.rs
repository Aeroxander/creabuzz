//! EVM key-rotation continuity (creabuzz).
//!
//! When a user rotates their device key, the **old** npub publishes a
//! NIP-33 parameterized-replaceable event (kind [`crate::kind::KIND_EVM_ROTATION`])
//! declaring the **new** npub as its successor. The event carries a NIP-26
//! `delegation` tag signed by the old npub, binding the two npubs together so
//! EVM-aware clients can resolve continuity:
//!
//! ```text
//! ["delegation", <delegator=old-npub>, <conditions>, <token>]
//! ```
//!
//! where `token` is the delegator's Schnorr signature over
//! `sha256("nostr:delegation:<delegatee=new-npub>:<conditions>")` (NIP-26).
//!
//! ## Event shape
//!
//! - `kind` — [`KIND_EVM_ROTATION`] (30200)
//! - `pubkey` — old npub (the delegator)
//! - `d` tag — `evm-rotation:<new-npub>` (replaceable per target)
//! - `delegation` tag — `[delegation, old-npub, conditions, token]`
//! - `p` tag — the new npub (the delegatee) for indexability
//! - `content` — the shared EVM account address (0x-hex)

use sha2::{Digest, Sha256};

use crate::kind::KIND_EVM_ROTATION;
use nostr::{Event, Tag};

/// A validated rotation-delegation claim extracted from an event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RotationDelegation {
    /// The old npub (delegator / event author).
    pub delegator: String,
    /// The new npub (delegatee / successor).
    pub delegatee: String,
    /// The NIP-26 conditions query string.
    pub conditions: String,
    /// The shared EVM account address (0x-hex), from event content.
    pub evm_address: String,
}

/// Error returned by rotation-delegation verification.
#[derive(Debug, thiserror::Error)]
pub enum RotationDelegationError {
    /// The event kind is not [`KIND_EVM_ROTATION`].
    #[error("wrong kind: expected {KIND_EVM_ROTATION}, got {got}")]
    WrongKind {
        /// The event's actual kind.
        got: u32,
    },
    /// No `delegation` tag is present.
    #[error("missing `delegation` tag")]
    MissingDelegationTag,
    /// The `delegation` tag has the wrong shape.
    #[error("malformed `delegation` tag: {0}")]
    MalformedTag(String),
    /// The event author is not the tag's delegator.
    #[error("delegator mismatch: event author {author} ≠ tag delegator {tag}")]
    DelegatorMismatch {
        /// The event author (old npub).
        author: String,
        /// The delegator named in the tag.
        tag: String,
    },
    /// No new-npub `p` tag is present.
    #[error("missing new-npub `p` tag")]
    MissingNewNpub,
    /// The delegation token signature failed verification.
    #[error("invalid delegation token: {0}")]
    InvalidToken(String),
    /// The conditions query string is malformed.
    #[error("invalid conditions query string: {0}")]
    InvalidConditions(String),
}

/// The NIP-26 delegation string the token signs:
/// `nostr:delegation:<delegatee>:<conditions>`.
pub fn delegation_string(delegatee: &str, conditions: &str) -> String {
    format!("nostr:delegation:{delegatee}:{conditions}")
}

/// Parse a `delegation` tag into `(delegator, conditions, token)`.
fn parse_delegation_tag(tag: &Tag) -> Result<(String, String, String), RotationDelegationError> {
    let parts = tag.as_slice();
    if parts.len() != 4 {
        return Err(RotationDelegationError::MalformedTag(format!(
            "expected 4 elements, got {}",
            parts.len()
        )));
    }
    let delegator = parts[1].clone();
    let conditions = parts[2].clone();
    let token = parts[3].clone();
    if delegator.is_empty() || conditions.is_empty() || token.is_empty() {
        return Err(RotationDelegationError::MalformedTag(
            "empty element".into(),
        ));
    }
    Ok((delegator, conditions, token))
}

/// Verify a rotation-delegation event.
///
/// Checks:
/// 1. kind == [`KIND_EVM_ROTATION`]
/// 2. a `delegation` tag exists with delegator == event author
/// 3. a `p` tag names the new npub (delegatee)
/// 4. the delegation token is the author's Schnorr signature over
///    `sha256("nostr:delegation:<new>:<conditions>")`
/// 5. the conditions query string is parseable (kind + created_at clauses)
///
/// Returns the extracted [`RotationDelegation`] on success.
pub fn verify_rotation_delegation(
    event: &Event,
) -> Result<RotationDelegation, RotationDelegationError> {
    let kind_u32 = event.kind.as_u16() as u32;
    if kind_u32 != KIND_EVM_ROTATION {
        return Err(RotationDelegationError::WrongKind { got: kind_u32 });
    }

    let author = event.pubkey.to_hex();

    // The new npub is carried in a `p` tag (indexable by filter `#p`).
    let delegatee = event
        .tags
        .iter()
        .find(|t| t.kind().as_str() == "p" && t.as_slice().len() >= 2)
        .and_then(|t| t.content().map(|s| s.to_string()))
        .ok_or(RotationDelegationError::MissingNewNpub)?;

    let delegation = event
        .tags
        .iter()
        .find(|t| t.kind().as_str() == "delegation")
        .ok_or(RotationDelegationError::MissingDelegationTag)?;

    let (delegator, conditions, token_hex) = parse_delegation_tag(delegation)?;
    if delegator != author {
        return Err(RotationDelegationError::DelegatorMismatch {
            author,
            tag: delegator,
        });
    }

    validate_conditions(&conditions)?;

    let message = delegation_string(&delegatee, &conditions);
    verify_token(&delegator, &message, &token_hex)
        .map_err(RotationDelegationError::InvalidToken)?;

    Ok(RotationDelegation {
        delegator: author,
        delegatee,
        conditions,
        evm_address: event.content.trim().to_string(),
    })
}

/// Verify a NIP-26 delegation token: the delegator's Schnorr signature over
/// `sha256(message)`.
fn verify_token(delegator_hex: &str, message: &str, token_hex: &str) -> Result<(), String> {
    use k256::schnorr::{Signature, VerifyingKey};
    use signature::hazmat::PrehashVerifier;

    let vk = VerifyingKey::from_bytes(
        &hex::decode(delegator_hex).map_err(|e| format!("delegator not hex: {e}"))?,
    )
    .map_err(|e| format!("bad delegator pubkey: {e}"))?;

    let token = hex::decode(token_hex).map_err(|e| format!("token not hex: {e}"))?;
    let sig =
        Signature::try_from(token.as_slice()).map_err(|e| format!("bad token signature: {e}"))?;

    let digest = Sha256::digest(message.as_bytes());
    vk.verify_prehash(&digest, &sig)
        .map_err(|e| format!("signature verification failed: {e}"))
}

/// Validate a NIP-26 conditions query string: zero or more `kind=<n>` /
/// `created_at<ts>` / `created_at>ts` clauses joined by `&`.
fn validate_conditions(conditions: &str) -> Result<(), RotationDelegationError> {
    if conditions.is_empty() {
        return Err(RotationDelegationError::InvalidConditions("empty".into()));
    }
    for clause in conditions.split('&') {
        let Some((field, op, value)) = split_clause(clause) else {
            return Err(RotationDelegationError::InvalidConditions(clause.into()));
        };
        match (field, op) {
            ("kind", "=") => {
                value.parse::<u64>().map_err(|_| {
                    RotationDelegationError::InvalidConditions(format!("kind value: {value}"))
                })?;
            }
            ("created_at", "<" | ">") => {
                value.parse::<u64>().map_err(|_| {
                    RotationDelegationError::InvalidConditions(format!("created_at value: {value}"))
                })?;
            }
            _ => {
                return Err(RotationDelegationError::InvalidConditions(clause.into()));
            }
        }
    }
    Ok(())
}

/// Split a clause into `(field, operator, value)`, e.g. `kind=1` → `(kind, =, 1)`.
fn split_clause(clause: &str) -> Option<(&str, &str, &str)> {
    for op in ["=", "<", ">"] {
        if let Some((field, value)) = split_once_on(clause, op) {
            if !field.is_empty() && !value.is_empty() {
                return Some((field, op, value));
            }
        }
    }
    None
}

/// Split `clause` on the first occurrence of `op`, returning (before, after).
fn split_once_on<'a>(clause: &'a str, op: &str) -> Option<(&'a str, &'a str)> {
    let idx = clause.find(op)?;
    Some((&clause[..idx], &clause[idx + op.len()..]))
}

/// Build the `d` tag value for a rotation event targeting `new_npub`.
pub fn rotation_d_tag(new_npub: &str) -> String {
    format!("evm-rotation:{new_npub}")
}

/// Build a `delegation` tag for a rotation event. Exposed for tests and
/// clients constructing rotation events.
pub fn make_delegation_tag(delegator: &str, conditions: &str, token: &str) -> Tag {
    Tag::parse(["delegation", delegator, conditions, token]).expect("valid delegation tag")
}

#[cfg(test)]
mod tests {
    use super::*;
    use k256::schnorr::SigningKey as SchnorrSigningKey;
    use nostr::{EventBuilder, Keys, Kind, Tag};

    fn schnorr_signer() -> (SchnorrSigningKey, nostr::PublicKey) {
        // Deterministic secret for reproducible tests.
        let secret = [7u8; 32];
        let sk = SchnorrSigningKey::from_bytes(&secret).unwrap();
        // The Nostr x-only pubkey is the Schnorr verifying key's bytes.
        let vk = sk.verifying_key();
        let pubkey = nostr::PublicKey::from_hex(&hex::encode(vk.to_bytes())).unwrap();
        (sk, pubkey)
    }

    fn sign_delegation(sk: &SchnorrSigningKey, delegatee: &str, conditions: &str) -> String {
        use signature::hazmat::PrehashSigner;
        let message = delegation_string(delegatee, conditions);
        let digest = Sha256::digest(message.as_bytes());
        let sig = sk.sign_prehash(&digest).unwrap();
        hex::encode(sig.to_bytes())
    }

    fn build_rotation_event(
        old_keys: &Keys,
        new_npub: &str,
        conditions: &str,
        token: &str,
        evm: &str,
    ) -> Event {
        let d_tag = Tag::parse(["d", &rotation_d_tag(new_npub)]).unwrap();
        let p_tag = Tag::parse(["p", new_npub]).unwrap();
        let delegation_tag =
            make_delegation_tag(&old_keys.public_key().to_hex(), conditions, token);
        EventBuilder::new(Kind::Custom(KIND_EVM_ROTATION as u16), evm)
            .tags([d_tag, p_tag, delegation_tag])
            .sign_with_keys(old_keys)
            .unwrap()
    }

    #[test]
    fn verify_valid_rotation() {
        let (sk, old_pk) = schnorr_signer();
        let old_keys = Keys::parse(&hex::encode([7u8; 32])).unwrap();
        // new npub = another key
        let new_keys = Keys::parse(&hex::encode([9u8; 32])).unwrap();
        let new_npub = new_keys.public_key().to_hex();
        let conditions = "kind=1&created_at>1674834236&created_at<2000000000";
        let token = sign_delegation(&sk, &new_npub, conditions);

        // old_keys.public_key() must equal old_pk (from the same secret).
        assert_eq!(old_keys.public_key(), old_pk);

        let event = build_rotation_event(&old_keys, &new_npub, conditions, &token, "0xdeadbeef");
        let parsed = verify_rotation_delegation(&event).unwrap();
        assert_eq!(parsed.delegator, old_pk.to_hex());
        assert_eq!(parsed.delegatee, new_npub);
        assert_eq!(parsed.conditions, conditions);
        assert_eq!(parsed.evm_address, "0xdeadbeef");
    }

    #[test]
    fn rejects_wrong_kind() {
        let keys = Keys::parse(&hex::encode([7u8; 32])).unwrap();
        let event = EventBuilder::new(Kind::TextNote, "hi")
            .sign_with_keys(&keys)
            .unwrap();
        assert!(matches!(
            verify_rotation_delegation(&event),
            Err(RotationDelegationError::WrongKind { .. })
        ));
    }

    #[test]
    fn rejects_missing_delegation_tag() {
        let keys = Keys::parse(&hex::encode([7u8; 32])).unwrap();
        let new_keys = Keys::parse(&hex::encode([9u8; 32])).unwrap();
        let event = EventBuilder::new(Kind::Custom(KIND_EVM_ROTATION as u16), "0xdead")
            .tags([
                Tag::parse(["d", &rotation_d_tag(&new_keys.public_key().to_hex())]).unwrap(),
                Tag::parse(["p", &new_keys.public_key().to_hex()]).unwrap(),
            ])
            .sign_with_keys(&keys)
            .unwrap();
        assert!(matches!(
            verify_rotation_delegation(&event),
            Err(RotationDelegationError::MissingDelegationTag)
        ));
    }

    #[test]
    fn rejects_forged_token() {
        let (sk, old_pk) = schnorr_signer();
        let old_keys = Keys::parse(&hex::encode([7u8; 32])).unwrap();
        let new_keys = Keys::parse(&hex::encode([9u8; 32])).unwrap();
        let new_npub = new_keys.public_key().to_hex();
        let conditions = "kind=1";
        let token = sign_delegation(&sk, &new_npub, conditions);
        assert_eq!(old_keys.public_key(), old_pk);

        // Tamper with the conditions after signing → token no longer matches.
        let event = build_rotation_event(&old_keys, &new_npub, "kind=7", &token, "0xdeadbeef");
        assert!(verify_rotation_delegation(&event).is_err());
    }

    #[test]
    fn rejects_bad_conditions() {
        let keys = Keys::parse(&hex::encode([7u8; 32])).unwrap();
        let new_keys = Keys::parse(&hex::encode([9u8; 32])).unwrap();
        let new_npub = new_keys.public_key().to_hex();
        let conditions = "foo=bar";
        let token = "00".repeat(64);
        let event = build_rotation_event(&keys, &new_npub, conditions, &token, "0xdead");
        assert!(verify_rotation_delegation(&event).is_err());
    }
}
