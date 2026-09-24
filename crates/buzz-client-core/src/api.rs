//! FFI-friendly NIP-44 v2 encryption for Buzz clients.
//!
//! This module is the shared client-core seam meant to replace the
//! per-platform re-implementations of NIP-44. The Flutter app consumes it
//! through `flutter_rust_bridge`; Rust consumers (desktop backend, CLI) call
//! it directly. It is a thin, side-effect-free wrapper over
//! `nostr::nips::nip44` — the same implementation the relay uses — so client
//! and server payloads are interoperable by construction.
//!
//! The API shape mirrors `mobile/lib/shared/crypto/nip44.dart`
//! (conversation-key based, base64 payloads) so Dart call sites migrate
//! mechanically.

use std::str::FromStr;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use flutter_rust_bridge::frb;
use nostr::nips::nip44::v2::{self, ConversationKey};
use nostr::{PublicKey, SecretKey};

/// Errors returned by the NIP-44 API.
///
/// Every variant surfaces as a Dart exception across the FFI boundary.
#[derive(Debug, thiserror::Error)]
pub enum ClientCoreError {
    /// A secret or public key hex string was malformed or out of range.
    #[error("invalid key: {0}")]
    InvalidKey(String),
    /// The conversation key was not a valid 32-byte key.
    #[error("invalid conversation key: expected 32 bytes")]
    InvalidConversationKey,
    /// The payload was not valid base64.
    #[error("invalid payload encoding: {0}")]
    InvalidPayloadEncoding(#[from] base64::DecodeError),
    /// The decrypted plaintext was not valid UTF-8.
    #[error("plaintext is not valid UTF-8")]
    NonUtf8Plaintext,
    /// The encoded payload exceeded the maximum accepted size.
    #[error("payload too long")]
    PayloadTooLong,
    /// The payload declared a NIP-44 version other than V2 (0x02).
    #[error("unsupported nip44 version: {0:#04x} (only V2 is supported)")]
    UnsupportedVersion(u8),
    /// NIP-44 processing failed (bad length, unknown version, MAC mismatch…).
    #[error("nip44 error: {0}")]
    Nip44(#[from] nostr::nips::nip44::Error),
}

/// NIP-44 v2 payload version byte.
const VERSION_V2: u8 = 0x02;

/// Largest accepted base64 payload, matching the pre-decode bound enforced by
/// the keys-level `nostr::nips::nip44` API. NIP-44 recommends bounding the
/// payload before base64 decoding to prevent denial-of-service; a v2 payload
/// is at most 65,603 raw bytes, i.e. 87,472 base64 characters.
const MAX_ENCODED_PAYLOAD_LEN: usize = 87_472;

fn conversation_key_from_slice(bytes: &[u8]) -> Result<ConversationKey, ClientCoreError> {
    ConversationKey::from_slice(bytes).map_err(|_| ClientCoreError::InvalidConversationKey)
}

/// Derive a NIP-44 v2 conversation key from a sender secret key and the
/// receiver public key (both hex-encoded).
///
/// Returns the raw 32-byte conversation key. The derivation is symmetric:
/// `(secret_a, public_b)` and `(secret_b, public_a)` yield the same key, so
/// callers can cache one key per peer pair.
#[frb(sync)]
pub fn get_conversation_key(
    sender_secret_hex: String,
    receiver_public_hex: String,
) -> Result<Vec<u8>, ClientCoreError> {
    let secret = SecretKey::from_str(&sender_secret_hex)
        .map_err(|err| ClientCoreError::InvalidKey(err.to_string()))?;
    let public = PublicKey::from_str(&receiver_public_hex)
        .map_err(|err| ClientCoreError::InvalidKey(err.to_string()))?;
    let key = ConversationKey::derive(&secret, &public)?;
    Ok(key.as_bytes().to_vec())
}

/// Encrypt `plaintext` with NIP-44 v2 under `conversation_key`.
///
/// `plaintext` must be 1-65535 UTF-8 bytes. Returns the standard base64
/// payload: `version(1) || nonce(32) || ciphertext || mac(32)`.
#[frb(sync)]
pub fn nip44_encrypt(
    conversation_key: Vec<u8>,
    plaintext: String,
) -> Result<String, ClientCoreError> {
    let key = conversation_key_from_slice(&conversation_key)?;
    let payload = v2::encrypt_to_bytes(&key, plaintext.as_bytes())?;
    Ok(BASE64.encode(payload))
}

/// Decrypt a standard base64 NIP-44 v2 `payload_base64` under
/// `conversation_key`.
///
/// The payload is size-bounded and version-checked before decoding per the
/// NIP-44 guidance, then authenticated (HMAC) before decrypting. Returns the
/// UTF-8 plaintext.
#[frb(sync)]
pub fn nip44_decrypt(
    conversation_key: Vec<u8>,
    payload_base64: String,
) -> Result<String, ClientCoreError> {
    let key = conversation_key_from_slice(&conversation_key)?;
    if payload_base64.len() > MAX_ENCODED_PAYLOAD_LEN {
        return Err(ClientCoreError::PayloadTooLong);
    }
    let payload = BASE64.decode(payload_base64.as_bytes())?;
    match payload.first() {
        Some(&VERSION_V2) => {}
        Some(&version) => return Err(ClientCoreError::UnsupportedVersion(version)),
        // Empty payloads fall through so the size check reports the error.
        None => {}
    }
    let plaintext = v2::decrypt_to_bytes(&key, &payload)?;
    String::from_utf8(plaintext).map_err(|_| ClientCoreError::NonUtf8Plaintext)
}
