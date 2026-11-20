//! The operator's identity toward push services: VAPID (RFC 8292), an ES256 token signed with a P-256 key.
//!
//! The private key comes from the environment, never from a file, and is never printed (`Debug` says `[REDACTED]`). Only
//! the public half is published (`/info`). The same key's bytes also derive the secret that keys the per-device topic
//! (`topic`), so a push service cannot work a topic back to a project.

use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine;
use hkdf::Hkdf;
use hmac::{Hmac, KeyInit, Mac};
use p256::ecdsa::signature::{Signer, Verifier};
use p256::ecdsa::{Signature, SigningKey, VerifyingKey};
use sha2::Sha256;

/// A token is valid for at most this long (RFC 8292 allows 24 hours; 12 keeps the margin for a clock that is off).
pub const TOKEN_LIFETIME_SECS: u64 = 12 * 3600;

/// The label the topic key is derived with.
const TOPIC_LABEL: &[u8] = b"buzz web push topic v1";

/// The operator's VAPID key. Debug output never shows it.
#[derive(Clone)]
pub struct VapidKey {
    signing: SigningKey,
    secret: [u8; 32],
}

impl std::fmt::Debug for VapidKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("VapidKey([REDACTED])")
    }
}

impl PartialEq for VapidKey {
    fn eq(&self, other: &Self) -> bool {
        self.public_bytes() == other.public_bytes()
    }
}

impl Eq for VapidKey {}

impl VapidKey {
    /// A key from its 32 bytes written as base64url (with or without padding). The error never contains the text.
    pub fn from_base64url(text: &str) -> Result<Self, String> {
        let trimmed = text.trim().trim_end_matches('=');
        let bytes = B64
            .decode(trimmed)
            .map_err(|_| "it is not base64url".to_owned())?;
        let secret: [u8; 32] = bytes
            .try_into()
            .map_err(|_| "it must be 32 bytes".to_owned())?;
        let signing = SigningKey::from_slice(&secret)
            .map_err(|_| "it is not a valid P-256 private key".to_owned())?;
        Ok(Self { signing, secret })
    }

    /// The public key: 65 bytes, uncompressed. This is the `applicationServerKey` a browser subscribes with.
    pub fn public_bytes(&self) -> [u8; 65] {
        let point = self.signing.verifying_key().to_encoded_point(false);
        let mut out = [0u8; 65];
        out.copy_from_slice(point.as_bytes());
        out
    }

    /// The public key as base64url, what `/info` carries.
    pub fn public_base64url(&self) -> String {
        B64.encode(self.public_bytes())
    }

    /// A signed token for pushes to the origin `aud` (`scheme://host[:port]`), valid until `exp` (unix seconds), naming the
    /// operator's contact `sub`.
    pub fn token(&self, aud: &str, exp: u64, sub: &str) -> String {
        let header = B64.encode(br#"{"typ":"JWT","alg":"ES256"}"#);
        let claims = serde_json::json!({ "aud": aud, "exp": exp, "sub": sub });
        let body = B64.encode(claims.to_string());
        let signing_input = format!("{header}.{body}");
        let signature: Signature = self.signing.sign(signing_input.as_bytes());
        format!("{signing_input}.{}", B64.encode(signature.to_bytes()))
    }

    /// The `Authorization` header of a push to `aud`, made at `now` (unix seconds).
    pub fn authorization(&self, aud: &str, now: u64, sub: &str) -> String {
        let token = self.token(aud, now.saturating_add(TOKEN_LIFETIME_SECS), sub);
        format!("vapid t={token}, k={}", self.public_base64url())
    }

    /// The topic of one alert for one device: 32 base64url characters of a keyed hash of the device, the project and the
    /// serial. A later alert about the same task replaces one the device has not received yet; two devices never share a
    /// topic; nobody without this server's key can work a topic back to a project (a plain hash of the project and the
    /// serial, which are public, would let a push service tell which project a device holds a stake in).
    pub fn topic(&self, endpoint_hash: &[u8; 32], project_key: &[u8; 32], serial: u64) -> String {
        let mut key = [0u8; 32];
        // The expansion of 32 bytes from HKDF-SHA-256 cannot fail.
        let _ = Hkdf::<Sha256>::new(None, &self.secret).expand(TOPIC_LABEL, &mut key);
        // HMAC accepts a key of any length, so this cannot fail; the fallback only keeps the function total.
        let mut mac = Hmac::<Sha256>::new_from_slice(&key)
            .unwrap_or_else(|_| Hmac::<Sha256>::new_from_slice(&[0u8]).expect("one byte is a key"));
        mac.update(endpoint_hash);
        mac.update(project_key);
        mac.update(&serial.to_be_bytes());
        let tag = mac.finalize().into_bytes();
        B64.encode(&tag[..24])
    }
}

/// The claims of a token that verified.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Claims {
    /// The origin the token is for.
    pub aud: String,
    /// When it ends, unix seconds.
    pub exp: u64,
    /// The operator's contact.
    pub sub: String,
}

/// Check a token's signature against a public key (65 bytes, uncompressed) and read its claims. It does not check the
/// time: the caller compares `exp` with its own clock. This is what a push service does, here for tests and the stand-in.
pub fn verify_token(token: &str, public: &[u8]) -> Result<Claims, String> {
    let mut parts = token.split('.');
    let (Some(header), Some(body), Some(signature), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err("a token has three parts".into());
    };
    let header_json: serde_json::Value = serde_json::from_slice(
        &B64.decode(header)
            .map_err(|_| "the header is not base64url")?,
    )
    .map_err(|_| "the header is not JSON")?;
    if header_json.get("alg").and_then(|v| v.as_str()) != Some("ES256") {
        return Err("the algorithm is not ES256".into());
    }
    let key = VerifyingKey::from_sec1_bytes(public).map_err(|_| "the key is not a P-256 point")?;
    let signature = Signature::from_slice(
        &B64.decode(signature)
            .map_err(|_| "the signature is not base64url")?,
    )
    .map_err(|_| "the signature is not 64 bytes")?;
    key.verify(format!("{header}.{body}").as_bytes(), &signature)
        .map_err(|_| "the signature does not verify".to_owned())?;
    let claims: serde_json::Value = serde_json::from_slice(
        &B64.decode(body)
            .map_err(|_| "the claims are not base64url")?,
    )
    .map_err(|_| "the claims are not JSON")?;
    Ok(Claims {
        aud: claims
            .get("aud")
            .and_then(|v| v.as_str())
            .ok_or("no aud")?
            .to_owned(),
        exp: claims.get("exp").and_then(|v| v.as_u64()).ok_or("no exp")?,
        sub: claims
            .get("sub")
            .and_then(|v| v.as_str())
            .ok_or("no sub")?
            .to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A key made for the test; no key is written into any file.
    fn throwaway() -> VapidKey {
        loop {
            let bytes: [u8; 32] = rand::random();
            if let Ok(key) = VapidKey::from_base64url(&B64.encode(bytes)) {
                return key;
            }
        }
    }

    /// RFC 8292 section 2: the token of the RFC's example verifies against the RFC's public key, and a token of ours
    /// verifies the same way (the shape is the shape the RFC shows).
    #[test]
    fn the_rfc8292_example_token_verifies() {
        let token = "eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiJ9.eyJhdWQiOiJodHRwczovL3B1c2guZXhhbXBsZS5uZXQiLCJleHAiOjE0NTM1MjM3NjgsInN1YiI6Im1haWx0bzpwdXNoQGV4YW1wbGUuY29tIn0.i3CYb7t4xfxCDquptFOepC9GAu_HLGkMlMuCGSK2rpiUfnK9ojFwDXb1JrErtmysazNjjvW2L9OkSSHzvoD1oA";
        let public = B64
            .decode("BA1Hxzyi1RUM1b5wjxsn7nGxAszw2u61m164i3MrAIxHF6YK5h4SDYic-dRuU_RCPCfA5aq9ojSwk5Y2EmClBPs")
            .expect("the RFC's key");
        let claims = verify_token(token, &public).expect("the RFC's token verifies");
        assert_eq!(
            claims,
            Claims {
                aud: "https://push.example.net".into(),
                exp: 1_453_523_768,
                sub: "mailto:push@example.com".into(),
            }
        );
        // A changed claim does not verify.
        let forged = token.replace(
            "eyJhdWQiOiJodHRwczovL3B1c2guZXhhbXBsZS5uZXQi",
            "eyJhdWQiOiJodHRwczovL3B1c2guZXhhbXBsZS5uZXRY",
        );
        assert!(verify_token(&forged, &public).is_err());
    }

    #[test]
    fn a_token_carries_aud_exp_and_sub_and_lasts_at_most_twelve_hours() {
        let key = throwaway();
        let header = key.authorization(
            "https://push.example.net",
            1_000_000,
            "mailto:ops@example.org",
        );
        let (t, k) = header
            .strip_prefix("vapid t=")
            .and_then(|rest| rest.split_once(", k="))
            .expect("the header shape of RFC 8292");
        assert_eq!(k, key.public_base64url());
        assert_eq!(B64.decode(k).expect("base64url").len(), 65);
        let claims = verify_token(t, &key.public_bytes()).expect("verifies");
        assert_eq!(claims.aud, "https://push.example.net");
        assert_eq!(claims.sub, "mailto:ops@example.org");
        assert_eq!(claims.exp, 1_000_000 + TOKEN_LIFETIME_SECS);
        assert!(
            claims.exp - 1_000_000 <= 12 * 3600,
            "at most 12 hours ahead"
        );
        // Another key's public half does not verify it.
        assert!(verify_token(t, &throwaway().public_bytes()).is_err());
    }

    #[test]
    fn the_key_is_never_printed_and_a_bad_key_is_refused_without_echoing_it() {
        let key = throwaway();
        assert_eq!(format!("{key:?}"), "VapidKey([REDACTED])");
        for bad in [
            "",
            "AAAA",
            "not base64!!",
            &B64.encode([0u8; 32]),
            &B64.encode([7u8; 31]),
        ] {
            let message = VapidKey::from_base64url(bad).expect_err("refused");
            assert!(!message.contains(bad) || bad.is_empty(), "{message}");
        }
    }

    #[test]
    fn topics_are_per_device_stable_for_one_alert_and_not_a_plain_hash() {
        let key = throwaway();
        let (device_a, device_b, project) = ([1u8; 32], [2u8; 32], [3u8; 32]);
        let topic = key.topic(&device_a, &project, 7);
        assert_eq!(topic.len(), 32, "a topic is 32 url-safe characters");
        assert!(topic
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'));
        assert_eq!(
            topic,
            key.topic(&device_a, &project, 7),
            "stable for one device and alert"
        );
        assert_ne!(
            topic,
            key.topic(&device_b, &project, 7),
            "two devices never share a topic"
        );
        assert_ne!(topic, key.topic(&device_a, &project, 8));
        assert_ne!(
            topic,
            throwaway().topic(&device_a, &project, 7),
            "another operator, another topic"
        );
        // Not a plain hash of the public values.
        use sha2::Digest;
        let mut plain = sha2::Sha256::new();
        plain.update(project);
        plain.update(7u64.to_be_bytes());
        assert_ne!(topic, B64.encode(&plain.finalize()[..24]));
    }
}
