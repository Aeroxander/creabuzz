//! Message encryption for web push: RFC 8291 on the `aes128gcm` content coding of RFC 8188, one record.
//!
//! A push message is encrypted to the device's own keys (the `p256dh` public key and the `auth` secret the browser made),
//! with a fresh key pair and salt per message, so the push service that carries it learns nothing but its size. The
//! unit test `rfc8291_appendix_a_vector` runs the RFC's own inputs and equals the RFC's bytes.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::Aes128Gcm;
use hkdf::Hkdf;
use p256::elliptic_curve::sec1::ToEncodedPoint;
use p256::{ProjectivePoint, PublicKey, SecretKey};
use sha2::Sha256;

/// The record size written in the header and the most a record holds: the plaintext, one delimiter byte and the 16-byte
/// tag fit in it.
pub const RECORD_SIZE: u32 = 4096;
/// The most plaintext this sender encrypts. A push service accepts a body of at most 4096 bytes in all; the header is 86
/// and the record adds 17, so 3993 is the limit; a message here is under 200.
pub const PLAINTEXT_MAX: usize = 3993;
/// The length of the content-coding header: salt (16), record size (4), key length (1) and the sender's key (65).
pub const HEADER_LEN: usize = 16 + 4 + 1 + 65;

/// Why a message could not be encrypted or opened.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EceError {
    /// The device's public key is not a point on the P-256 curve in uncompressed form.
    BadPublicKey,
    /// The plaintext is longer than [`PLAINTEXT_MAX`].
    TooLong,
    /// The body is not a single `aes128gcm` record of this shape.
    BadBody,
    /// The key derivation failed (never expected for these lengths).
    Derive,
    /// The record did not open with these keys.
    Open,
}

impl std::fmt::Display for EceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::BadPublicKey => "the device's public key is not a point on the P-256 curve",
            Self::TooLong => "the message is too long",
            Self::BadBody => "the body is not one aes128gcm record",
            Self::Derive => "the key derivation failed",
            Self::Open => "the record did not open",
        })
    }
}

impl std::error::Error for EceError {}

/// A device public key checked to be a point on the curve: the 65 bytes of its uncompressed form.
pub fn check_public_key(bytes: &[u8]) -> Result<PublicKey, EceError> {
    if bytes.len() != 65 || bytes[0] != 0x04 {
        return Err(EceError::BadPublicKey);
    }
    PublicKey::from_sec1_bytes(bytes).map_err(|_| EceError::BadPublicKey)
}

fn uncompressed(key: &PublicKey) -> [u8; 65] {
    let point = key.to_encoded_point(false);
    let mut out = [0u8; 65];
    out.copy_from_slice(point.as_bytes());
    out
}

/// The x coordinate of `secret * public`: the ECDH shared secret.
fn ecdh(secret: &SecretKey, public: &PublicKey) -> Result<[u8; 32], EceError> {
    let product = ProjectivePoint::from(*public.as_affine()) * *secret.to_nonzero_scalar();
    let point = p256::AffinePoint::from(product).to_encoded_point(false);
    let x = point.x().ok_or(EceError::BadPublicKey)?;
    let mut out = [0u8; 32];
    out.copy_from_slice(x);
    Ok(out)
}

/// The content encryption key and nonce for a message between the sender's key and the device's key (RFC 8291 section 3.4).
fn derive(
    ecdh_secret: &[u8; 32],
    auth: &[u8; 16],
    ua_public: &[u8; 65],
    as_public: &[u8; 65],
    salt: &[u8; 16],
) -> Result<([u8; 16], [u8; 12]), EceError> {
    let mut key_info = Vec::with_capacity(14 + 65 + 65);
    key_info.extend_from_slice(b"WebPush: info\0");
    key_info.extend_from_slice(ua_public);
    key_info.extend_from_slice(as_public);
    let mut ikm = [0u8; 32];
    Hkdf::<Sha256>::new(Some(auth), ecdh_secret)
        .expand(&key_info, &mut ikm)
        .map_err(|_| EceError::Derive)?;
    let prk = Hkdf::<Sha256>::new(Some(salt), &ikm);
    let mut cek = [0u8; 16];
    prk.expand(b"Content-Encoding: aes128gcm\0", &mut cek)
        .map_err(|_| EceError::Derive)?;
    let mut nonce = [0u8; 12];
    prk.expand(b"Content-Encoding: nonce\0", &mut nonce)
        .map_err(|_| EceError::Derive)?;
    Ok((cek, nonce))
}

/// Encrypt `plaintext` to a device with the given sender key pair and salt. The two are fresh for every message in
/// [`encrypt`]; this form exists so a test can run the RFC's fixed inputs.
pub fn encrypt_with(
    plaintext: &[u8],
    ua_public: &[u8; 65],
    auth: &[u8; 16],
    as_secret: &SecretKey,
    salt: &[u8; 16],
) -> Result<Vec<u8>, EceError> {
    if plaintext.len() > PLAINTEXT_MAX {
        return Err(EceError::TooLong);
    }
    let ua_key = check_public_key(ua_public)?;
    let as_public = uncompressed(&as_secret.public_key());
    let shared = ecdh(as_secret, &ua_key)?;
    let (cek, nonce) = derive(&shared, auth, ua_public, &as_public, salt)?;
    let mut record = Vec::with_capacity(plaintext.len() + 1);
    record.extend_from_slice(plaintext);
    record.push(0x02); // the delimiter of the last (and only) record, no padding
    let cipher = Aes128Gcm::new_from_slice(&cek).map_err(|_| EceError::Derive)?;
    let sealed = cipher
        .encrypt(aes_gcm::Nonce::from_slice(&nonce), record.as_slice())
        .map_err(|_| EceError::Derive)?;
    let mut body = Vec::with_capacity(HEADER_LEN + sealed.len());
    body.extend_from_slice(salt);
    body.extend_from_slice(&RECORD_SIZE.to_be_bytes());
    body.push(65);
    body.extend_from_slice(&as_public);
    body.extend_from_slice(&sealed);
    Ok(body)
}

/// A fresh sender key pair: random 32 bytes that are a valid P-256 scalar.
fn fresh_secret() -> Result<SecretKey, EceError> {
    for _ in 0..8 {
        let bytes: [u8; 32] = rand::random();
        if let Ok(secret) = SecretKey::from_slice(&bytes) {
            return Ok(secret);
        }
    }
    Err(EceError::Derive)
}

/// Encrypt `plaintext` to a device, with a fresh sender key pair and a fresh salt.
pub fn encrypt(
    plaintext: &[u8],
    ua_public: &[u8; 65],
    auth: &[u8; 16],
) -> Result<Vec<u8>, EceError> {
    let secret = fresh_secret()?;
    let salt: [u8; 16] = rand::random();
    encrypt_with(plaintext, ua_public, auth, &secret, &salt)
}

/// Open a body made by [`encrypt`] with the device's private key, public key and auth secret: what a browser does, here
/// for tests and for the stand-in that stands in for a push service.
pub fn decrypt(body: &[u8], ua_secret: &SecretKey, auth: &[u8; 16]) -> Result<Vec<u8>, EceError> {
    if body.len() < HEADER_LEN + 17 {
        return Err(EceError::BadBody);
    }
    let salt: [u8; 16] = body[..16].try_into().map_err(|_| EceError::BadBody)?;
    let record_size = u32::from_be_bytes(body[16..20].try_into().map_err(|_| EceError::BadBody)?);
    if record_size != RECORD_SIZE || body[20] != 65 {
        return Err(EceError::BadBody);
    }
    let as_public: [u8; 65] = body[21..HEADER_LEN]
        .try_into()
        .map_err(|_| EceError::BadBody)?;
    let as_key = check_public_key(&as_public)?;
    let ua_public = uncompressed(&ua_secret.public_key());
    let shared = ecdh(ua_secret, &as_key)?;
    let (cek, nonce) = derive(&shared, auth, &ua_public, &as_public, &salt)?;
    let cipher = Aes128Gcm::new_from_slice(&cek).map_err(|_| EceError::Derive)?;
    let mut plain = cipher
        .decrypt(aes_gcm::Nonce::from_slice(&nonce), &body[HEADER_LEN..])
        .map_err(|_| EceError::Open)?;
    // The last byte that is not zero is the delimiter, and it is 0x02 for the last record.
    while plain.last() == Some(&0) {
        plain.pop();
    }
    if plain.pop() != Some(0x02) {
        return Err(EceError::BadBody);
    }
    Ok(plain)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
    use base64::Engine;

    fn b64(text: &str) -> Vec<u8> {
        B64.decode(text.replace([' ', '\n'], ""))
            .expect("base64url")
    }

    // The inputs and outputs of RFC 8291 section 5 and appendix A, copied from the RFC. They are the RFC's published
    // example keys, not keys of anyone's.
    const PLAINTEXT: &str = "V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24";
    const AS_PRIVATE: &str = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw";
    const UA_PUBLIC: &str =
        "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
    const UA_PRIVATE: &str = "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94";
    const SALT: &str = "DGv6ra1nlYgDCS1FRnbzlw";
    const AUTH: &str = "BTBZMqHH6r4Tts7J_aSIgg";
    const ECDH_SECRET: &str = "kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs";
    const IKM: &str = "S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg";
    const CEK: &str = "oIhVW04MRdy2XN9CiKLxTg";
    const NONCE: &str = "4h_95klXJ5E_qnoN";
    const HEADER: &str = "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
    const CIPHERTEXT: &str =
        "8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ";

    fn rfc_inputs() -> (Vec<u8>, [u8; 65], [u8; 16], [u8; 16], SecretKey, SecretKey) {
        let plain = b64(PLAINTEXT);
        let ua_public: [u8; 65] = b64(UA_PUBLIC).try_into().expect("65 bytes");
        let auth: [u8; 16] = b64(AUTH).try_into().expect("16 bytes");
        let salt: [u8; 16] = b64(SALT).try_into().expect("16 bytes");
        let as_secret = SecretKey::from_slice(&b64(AS_PRIVATE)).expect("sender key");
        let ua_secret = SecretKey::from_slice(&b64(UA_PRIVATE)).expect("device key");
        (plain, ua_public, auth, salt, as_secret, ua_secret)
    }

    /// RFC 8291 appendix A: the RFC's inputs give the RFC's intermediate values and bytes, and the RFC's ciphertext
    /// decrypts to the RFC's plaintext.
    #[test]
    fn rfc8291_appendix_a_vector() {
        let (plain, ua_public, auth, salt, as_secret, ua_secret) = rfc_inputs();
        let as_public = uncompressed(&as_secret.public_key());
        // The device's public key is the one its private key makes.
        assert_eq!(uncompressed(&ua_secret.public_key()), ua_public);
        // The intermediate values.
        let shared = ecdh(&as_secret, &check_public_key(&ua_public).expect("point")).expect("ecdh");
        assert_eq!(shared.to_vec(), b64(ECDH_SECRET));
        let again = ecdh(&ua_secret, &as_secret.public_key()).expect("ecdh the other way");
        assert_eq!(again, shared, "both sides reach the same secret");
        let mut key_info = b"WebPush: info\0".to_vec();
        key_info.extend_from_slice(&ua_public);
        key_info.extend_from_slice(&as_public);
        let mut ikm = [0u8; 32];
        Hkdf::<Sha256>::new(Some(&auth), &shared)
            .expand(&key_info, &mut ikm)
            .expect("expand");
        assert_eq!(ikm.to_vec(), b64(IKM));
        let (cek, nonce) = derive(&shared, &auth, &ua_public, &as_public, &salt).expect("derive");
        assert_eq!(cek.to_vec(), b64(CEK));
        assert_eq!(nonce.to_vec(), b64(NONCE));
        // The bytes.
        let body = encrypt_with(&plain, &ua_public, &auth, &as_secret, &salt).expect("encrypt");
        let mut expected = b64(HEADER);
        assert_eq!(expected.len(), HEADER_LEN, "the RFC's header is 86 octets");
        expected.extend(b64(CIPHERTEXT));
        assert_eq!(body, expected, "the RFC's bytes");
        // The RFC's own ciphertext opens.
        assert_eq!(
            decrypt(&expected, &ua_secret, &auth).expect("decrypt"),
            plain
        );
    }

    #[test]
    fn a_fresh_message_opens_with_the_device_key_only() {
        let device = fresh_secret().expect("key");
        let public = uncompressed(&device.public_key());
        let auth: [u8; 16] = rand::random();
        let body = encrypt(b"hello", &public, &auth).expect("encrypt");
        assert_eq!(decrypt(&body, &device, &auth).expect("opens"), b"hello");
        // A second message to the same device uses a new key and a new salt.
        let other = encrypt(b"hello", &public, &auth).expect("encrypt");
        assert_ne!(body[..HEADER_LEN], other[..HEADER_LEN]);
        // Another device, or a wrong auth secret, cannot open it.
        let stranger = fresh_secret().expect("key");
        assert_eq!(decrypt(&body, &stranger, &auth), Err(EceError::Open));
        assert_eq!(decrypt(&body, &device, &[0u8; 16]), Err(EceError::Open));
        // A flipped bit does not open.
        let mut broken = body.clone();
        let last = broken.len() - 1;
        broken[last] ^= 1;
        assert_eq!(decrypt(&broken, &device, &auth), Err(EceError::Open));
    }

    #[test]
    fn a_key_off_the_curve_and_a_long_message_are_refused() {
        let device = fresh_secret().expect("key");
        let mut public = uncompressed(&device.public_key());
        let auth = [7u8; 16];
        public[64] ^= 1; // a point that is not on the curve
        assert_eq!(
            check_public_key(&public).err(),
            Some(EceError::BadPublicKey)
        );
        assert_eq!(
            encrypt(b"x", &public, &auth).err(),
            Some(EceError::BadPublicKey)
        );
        let mut compressed = public.to_vec();
        compressed[0] = 0x02;
        assert_eq!(
            check_public_key(&compressed).err(),
            Some(EceError::BadPublicKey)
        );
        assert_eq!(
            check_public_key(&[4u8; 10]).err(),
            Some(EceError::BadPublicKey)
        );
        let good = uncompressed(&device.public_key());
        assert_eq!(
            encrypt(&vec![b'a'; PLAINTEXT_MAX + 1], &good, &auth).err(),
            Some(EceError::TooLong)
        );
        let at_the_limit = encrypt(&vec![b'a'; PLAINTEXT_MAX], &good, &auth).expect("fits");
        assert_eq!(
            at_the_limit.len(),
            4096,
            "the largest message is exactly the push services' limit"
        );
    }
}
