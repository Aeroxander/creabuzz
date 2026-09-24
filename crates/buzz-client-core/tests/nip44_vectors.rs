//! NIP-44 v2 conformance and interop tests for `buzz-client-core`.
//!
//! Covers three independent claims:
//!
//! 1. **Spec conformance** — the official NIP-44 test vectors
//!    (`data/nip44.vectors.json`, the vector set vendored by `nostr` 0.44 at
//!    `src/nips/nip44/nip44.vectors.json`, originating from the NIP-44 spec).
//!    Note: this vendored copy predates the spec's extended length-prefix
//!    update (its sha256 does not match the checksum published in the spec),
//!    so length-boundary semantics are asserted separately below against the
//!    implementation's documented cap rather than from these vectors.
//! 2. **Seam interop** — payloads produced and consumed through this crate's
//!    conversation-key API interoperate with `nostr::nips::nip44`'s keys-level
//!    API, the seam the relay and desktop backend use today.
//! 3. **Boundary behavior** — length limits and malformed payload rejection
//!    match the spec's invalid vectors.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use buzz_client_core::{get_conversation_key, nip44_decrypt, nip44_encrypt, ClientCoreError};
use nostr::nips::nip44::{self, v2, v2::ConversationKey, Version};
use nostr::secp256k1::rand::{Error as RngError, RngCore};
use nostr::{Keys, PublicKey, SecretKey};
use serde_json::Value;

fn vectors() -> Value {
    serde_json::from_str(include_str!("data/nip44.vectors.json")).expect("vectors JSON parses")
}

fn hex_field(case: &Value, field: &str) -> Vec<u8> {
    let raw = case[field]
        .as_str()
        .unwrap_or_else(|| panic!("{field} missing"));
    hex::decode(raw).unwrap_or_else(|err| panic!("{field} not hex: {err}"))
}

/// Deterministic RNG that serves one fixed 32-byte nonce, so encrypt output
/// can be compared byte-for-byte against the official vectors.
struct FixedNonceRng {
    nonce: [u8; 32],
    served: bool,
}

impl FixedNonceRng {
    fn new(nonce: &[u8]) -> Self {
        let mut buf = [0u8; 32];
        buf.copy_from_slice(nonce);
        Self {
            nonce: buf,
            served: false,
        }
    }
}

impl RngCore for FixedNonceRng {
    fn next_u32(&mut self) -> u32 {
        let mut buf = [0u8; 4];
        self.fill_bytes(&mut buf);
        u32::from_le_bytes(buf)
    }

    fn next_u64(&mut self) -> u64 {
        let mut buf = [0u8; 8];
        self.fill_bytes(&mut buf);
        u64::from_le_bytes(buf)
    }

    fn fill_bytes(&mut self, dest: &mut [u8]) {
        for (i, byte) in dest.iter_mut().enumerate() {
            *byte = if !self.served && i < self.nonce.len() {
                self.nonce[i]
            } else {
                0
            };
        }
        self.served = true;
    }

    fn try_fill_bytes(&mut self, dest: &mut [u8]) -> Result<(), RngError> {
        self.fill_bytes(dest);
        Ok(())
    }
}

fn keys_from_case(case: &Value) -> (SecretKey, PublicKey, SecretKey, PublicKey) {
    let sec1 = SecretKey::from_slice(&hex_field(case, "sec1")).expect("sec1 valid");
    let sec2 = SecretKey::from_slice(&hex_field(case, "sec2")).expect("sec2 valid");
    let pub1 = Keys::new(sec1.clone()).public_key();
    let pub2 = Keys::new(sec2.clone()).public_key();
    (sec1, pub1, sec2, pub2)
}

#[test]
fn get_conversation_key_matches_official_vectors() {
    for case in vectors()["v2"]["valid"]["get_conversation_key"]
        .as_array()
        .expect("vector array")
    {
        let derived = get_conversation_key(
            case["sec1"].as_str().expect("sec1").to_string(),
            case["pub2"].as_str().expect("pub2").to_string(),
        )
        .unwrap_or_else(|err| panic!("derivation failed ({}): {err}", case["note"]));
        assert_eq!(
            hex::encode(&derived),
            case["conversation_key"].as_str().expect("conversation_key"),
            "case: {}",
            case["note"]
        );
    }
}

#[test]
fn get_conversation_key_rejects_invalid_keys() {
    for case in vectors()["v2"]["invalid"]["get_conversation_key"]
        .as_array()
        .expect("vector array")
    {
        let result = get_conversation_key(
            case["sec1"].as_str().expect("sec1").to_string(),
            case["pub2"].as_str().expect("pub2").to_string(),
        );
        assert!(result.is_err(), "case should be rejected: {}", case["note"]);
    }

    let valid_sec = "0000000000000000000000000000000000000000000000000000000000000001".to_string();
    let valid_pub = "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdeb".to_string();
    assert!(get_conversation_key("not-hex".to_string(), valid_pub.clone()).is_err());
    assert!(get_conversation_key(valid_sec.clone(), "deadbeef".to_string()).is_err());
    assert!(get_conversation_key(String::new(), valid_pub).is_err());
    let _ = valid_sec;
}

#[test]
fn conversation_key_is_symmetric() {
    for case in vectors()["v2"]["valid"]["encrypt_decrypt"]
        .as_array()
        .expect("vector array")
    {
        let (_, pub1, _, pub2) = keys_from_case(case);
        let forward = get_conversation_key(
            case["sec1"].as_str().expect("sec1").to_string(),
            pub2.to_string(),
        )
        .expect("forward derivation");
        let reverse = get_conversation_key(
            case["sec2"].as_str().expect("sec2").to_string(),
            pub1.to_string(),
        )
        .expect("reverse derivation");
        assert_eq!(forward, reverse);
        assert_eq!(
            hex::encode(&forward),
            case["conversation_key"].as_str().expect("conversation_key")
        );
    }
}

#[test]
fn nip44_decrypt_matches_official_vectors() {
    for case in vectors()["v2"]["valid"]["encrypt_decrypt"]
        .as_array()
        .expect("vector array")
    {
        let key = hex_field(case, "conversation_key");
        let plaintext = nip44_decrypt(
            key,
            case["ciphertext"].as_str().expect("ciphertext").to_string(),
        )
        .unwrap_or_else(|err| panic!("decrypt failed: {err}"));
        assert_eq!(plaintext, case["plaintext"].as_str().expect("plaintext"));
    }
}

#[test]
fn nip44_encrypt_matches_official_ciphertexts() {
    for case in vectors()["v2"]["valid"]["encrypt_decrypt"]
        .as_array()
        .expect("vector array")
    {
        let key = ConversationKey::from_slice(&hex_field(case, "conversation_key"))
            .expect("conversation key parses");
        let mut rng = FixedNonceRng::new(&hex_field(case, "nonce"));
        let payload = v2::encrypt_to_bytes_with_rng(
            &mut rng,
            &key,
            case["plaintext"].as_str().unwrap().as_bytes(),
        )
        .expect("encrypt");
        assert_eq!(
            BASE64.encode(payload),
            case["ciphertext"].as_str().expect("ciphertext"),
            "plaintext: {:?}",
            case["plaintext"]
        );
    }
}

#[test]
fn round_trips_at_boundary_lengths() {
    let case = &vectors()["v2"]["valid"]["encrypt_decrypt"][0];
    let key = hex_field(case, "conversation_key");

    // `nostr` caps plaintext at 65,408 bytes (MAX_SUPPORTED_PLAINTEXT_SIZE =
    // 65_536 - 128); the cap is asserted in `enforces_plaintext_size_cap`.
    for len in [1usize, 32, 100, 1000, 65_408] {
        let plaintext = "a".repeat(len);
        let payload = nip44_encrypt(key.clone(), plaintext.clone()).expect("encrypt");
        let recovered = nip44_decrypt(key.clone(), payload).expect("decrypt");
        assert_eq!(recovered, plaintext, "length {len}");
    }
}

#[test]
fn interops_with_nostr_keys_level_api() {
    // The direction every vector pair exercises, via the exact seam that
    // `buzz-core` (relay, desktop backend) uses today.
    for case in vectors()["v2"]["valid"]["encrypt_decrypt"]
        .as_array()
        .expect("vector array")
    {
        let (sec1, pub1, sec2, pub2) = keys_from_case(case);
        let key = get_conversation_key(
            case["sec1"].as_str().expect("sec1").to_string(),
            pub2.to_string(),
        )
        .expect("derivation");

        // nostr keys-level encrypt -> this crate decrypts.
        let foreign = nip44::encrypt(&sec1, &pub2, "from-the-relay-side", Version::V2)
            .expect("keys-level encrypt");
        let recovered = nip44_decrypt(key.clone(), foreign).expect("decrypt foreign");
        assert_eq!(recovered, "from-the-relay-side");

        // This crate encrypts -> nostr keys-level decrypt.
        let ours = nip44_encrypt(key, "from-the-client-core".to_string()).expect("encrypt");
        let recovered = nip44::decrypt(&sec2, &pub1, &ours).expect("keys-level decrypt");
        assert_eq!(recovered, "from-the-client-core");
    }
}

#[test]
fn nip44_decrypt_rejects_invalid_payloads() {
    // Official invalid vectors (corrupted MACs and friends).
    for case in vectors()["v2"]["invalid"]["decrypt"]
        .as_array()
        .expect("vector array")
    {
        let key = hex_field(case, "conversation_key");
        let result = nip44_decrypt(
            key,
            case["ciphertext"].as_str().expect("ciphertext").to_string(),
        );
        assert!(result.is_err(), "case should be rejected: {}", case["note"]);
    }

    // Structural cases.
    let valid_case = &vectors()["v2"]["valid"]["encrypt_decrypt"][0];
    let key = hex_field(valid_case, "conversation_key");
    let valid_payload = valid_case["ciphertext"].as_str().expect("ciphertext");

    assert!(matches!(
        nip44_decrypt(key.clone(), "!!! not base64 !!!".to_string()),
        Err(ClientCoreError::InvalidPayloadEncoding(_))
    ));

    let mut raw = BASE64.decode(valid_payload).expect("payload decodes");
    raw[0] = 0x03; // unsupported version
    assert!(matches!(
        nip44_decrypt(key.clone(), BASE64.encode(&raw)),
        Err(ClientCoreError::UnsupportedVersion(3))
    ));

    let truncated = BASE64.encode(&raw[..50.min(raw.len())]);
    assert!(nip44_decrypt(key.clone(), truncated).is_err());

    let mut tampered = BASE64.decode(valid_payload).expect("payload decodes");
    let last = tampered.len() - 1;
    tampered[last] ^= 0xff; // corrupt MAC
    assert!(nip44_decrypt(key.clone(), BASE64.encode(&tampered)).is_err());

    // An unrelated conversation key must not authenticate. (Some vector
    // cases share a keypair, so use a fabricated key rather than another
    // case's conversation key.)
    let unrelated_key = vec![0x42u8; 32];
    assert!(nip44_decrypt(unrelated_key, valid_payload.to_string()).is_err());

    // Conversation keys must be exactly 32 bytes.
    assert!(matches!(
        nip44_decrypt(vec![0u8; 31], valid_payload.to_string()),
        Err(ClientCoreError::InvalidConversationKey)
    ));
}

#[test]
fn nip44_encrypt_enforces_message_length_limits() {
    let case = &vectors()["v2"]["valid"]["encrypt_decrypt"][0];
    let key = hex_field(case, "conversation_key");

    for len in vectors()["v2"]["invalid"]["encrypt_msg_lengths"]
        .as_array()
        .expect("vector array")
    {
        let len = len.as_u64().expect("length") as usize;
        let plaintext = "a".repeat(len);
        assert!(
            nip44_encrypt(key.clone(), plaintext).is_err(),
            "length {len} should be rejected"
        );
    }
}

#[test]
fn enforces_plaintext_size_cap() {
    // `nostr` enforces its own plaintext cap of 65,408 bytes
    // (MAX_SUPPORTED_PLAINTEXT_SIZE), below both the stale vectors' 65,535
    // boundary and the current spec's extended-prefix maximum. Divergent caps
    // across the Rust and Dart implementations are one of the duplications
    // this shared core exists to remove.
    let case = &vectors()["v2"]["valid"]["encrypt_decrypt"][0];
    let key = hex_field(case, "conversation_key");

    let at_cap = "a".repeat(65_408);
    let payload = nip44_encrypt(key.clone(), at_cap.clone()).expect("cap length encrypts");
    assert_eq!(
        nip44_decrypt(key.clone(), payload).expect("decrypt"),
        at_cap
    );

    for len in [65_409usize, 65_535, 65_536] {
        assert!(
            nip44_encrypt(key.clone(), "a".repeat(len)).is_err(),
            "length {len} exceeds the implementation cap and must be rejected"
        );
    }
}
