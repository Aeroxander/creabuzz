//! Agent identity derived from the payload nsec (spec §Deploy step 0:
//! identity before any substrate contact).
//!
//! Mirrors `buzz-backend-kubernetes/src/naming.rs`: a malformed or blank key
//! is a refusal before anything is created, and the derived pubkey names the
//! deployment so I4 (at most one live instance per key per scope) is a
//! deterministic-name property rather than a locking mechanism.

use nostr::nips::nip19::FromBech32;
use nostr::Keys;

pub struct AgentIdentity {
    pubkey_hex: String,
}

impl AgentIdentity {
    /// Accepts bech32 `nsec1…`; anything else is an immediate error.
    pub fn from_nsec(nsec: &str) -> Result<Self, String> {
        if nsec.trim().is_empty() {
            return Err(
                "private_key_nsec is empty: refusing to deploy an identityless agent (I1)".into(),
            );
        }
        let secret = nostr::SecretKey::from_bech32(nsec.trim())
            .map_err(|_| "private_key_nsec is not a decodable nsec1 key".to_string())?;
        let keys = Keys::new(secret);
        Ok(Self {
            pubkey_hex: keys.public_key().to_hex(),
        })
    }

    pub fn pubkey_hex(&self) -> &str {
        &self.pubkey_hex
    }

    /// Deterministic Task name: one live Task per agent key per atespace
    /// (I4). AX task names must be DNS-ish; hex is safe.
    pub fn task_name(&self) -> String {
        format!("buzz-{}", &self.pubkey_hex[..32])
    }
}
