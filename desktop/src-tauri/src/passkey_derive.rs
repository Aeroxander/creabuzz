//! Byte-identical desktop port of the web passkey dual-root derivation.
//!
//! The contract to mirror is `web/src/features/identity/lib/passkey.ts`
//! (read it before changing anything here): one PRF output must re-derive the
//! SAME Nostr key and the SAME secp256r1 owner root on desktop and web —
//! "same credential + salt re-derives" is what makes a passkey identity
//! portable across surfaces (docs/identity-token-architecture.md).
//!
//! Parity is enforced by tests below that reuse the pinned vectors from
//! `web/src/features/identity/lib/passkey.test.mjs` verbatim (RFC 5869
//! Appendix A Test Case 3, the 2026-09-24 production-chain Nostr pins, the
//! NIST P-256 base-point attestation vector, and the malformed-COSE table).
//! If a change here fails those pins, it broke the desktop↔web contract.

use hkdf::Hkdf;
use sha2::Sha256;
use sha3::{Digest, Keccak256};

/// HKDF info of the Nostr derivation — the web module's `HKDF_INFO`.
pub const HKDF_INFO: &[u8] = b"buzz-nostr-v1";

/// Derivation/parse failure, mirroring the web module's error classes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeriveError {
    /// Mirrors web `PasskeyAttestationError` (message kept in parity).
    Attestation(String),
    /// HKDF output outside the secp256k1 scalar range (astronomically rare;
    /// the web path throws from nostr-tools in that case).
    InvalidSecretKey,
}

impl std::fmt::Display for DeriveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DeriveError::Attestation(message) => write!(f, "{message}"),
            DeriveError::InvalidSecretKey => write!(
                f,
                "the derived Nostr secret key is not a valid secp256k1 scalar"
            ),
        }
    }
}

impl std::error::Error for DeriveError {}

type Result<T> = std::result::Result<T, DeriveError>;

fn attestation(message: impl Into<String>) -> DeriveError {
    DeriveError::Attestation(message.into())
}

/// Both public roots of one passkey registration (web `PasskeyIdentity`,
/// pre-serde).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdentityRoots {
    pub nostr_pubkey_hex: String,
    pub r1_uncompressed_hex: String,
    pub address_preview: String,
}

/// HKDF-SHA256 (RFC 5869) — expand `prf_output` into exactly 32 bytes with an
/// all-zero 32-byte salt (byte-identical to the web module's WebCrypto call;
/// for HMAC-based HKDF the zero salt equals the RFC's default salt, so RFC 5869
/// Test Case 3 applies verbatim).
pub fn hkdf_sha256(prf_output: &[u8], info: &[u8]) -> [u8; 32] {
    let hk = Hkdf::<Sha256>::new(Some(&[0u8; 32]), prf_output);
    let mut okm = [0u8; 32];
    match hk.expand(info, &mut okm) {
        Ok(()) => okm,
        // Infallible for a 32-byte output (RFC 5869: L ≤ 255 · HashLen).
        Err(_) => unreachable!("32-byte HKDF-Expand output is valid"),
    }
}

/// The Nostr secret key: HKDF-SHA256(PRF output, "buzz-nostr-v1") → 32 bytes.
pub fn derive_nostr_secret_key(prf_output: &[u8]) -> [u8; 32] {
    hkdf_sha256(prf_output, HKDF_INFO)
}

/// secp256k1 pubkey (x-only hex) of a Nostr secret key — the web module's
/// `nostrPubkeyHex` (nostr-tools `getPublicKey`).
pub fn nostr_pubkey_hex(secret_key: &[u8; 32]) -> Result<String> {
    let secret =
        nostr::SecretKey::from_slice(secret_key).map_err(|_| DeriveError::InvalidSecretKey)?;
    Ok(nostr::Keys::new(secret).public_key().to_hex())
}

/// Both public roots from the in-memory Nostr secret + the attested r1 key —
/// the web module's `passkeyIdentityFrom`.
pub fn passkey_identity_from(
    nostr_secret_key: &[u8; 32],
    r1_uncompressed: &[u8],
) -> Result<IdentityRoots> {
    Ok(IdentityRoots {
        nostr_pubkey_hex: nostr_pubkey_hex(nostr_secret_key)?,
        r1_uncompressed_hex: hex::encode(r1_uncompressed),
        address_preview: r1_address_preview(r1_uncompressed)?,
    })
}

/// Preview of the EOA-style address owning the future Kernel: keccak-256 of
/// the 64-byte affine encoding (x‖y), last 20 bytes — web `r1AddressPreview`.
pub fn r1_address_preview(r1_uncompressed: &[u8]) -> Result<String> {
    if r1_uncompressed.len() != 65 || r1_uncompressed[0] != 0x04 {
        return Err(attestation(
            "expected a 65-byte uncompressed secp256r1 public key (0x04‖x‖y)",
        ));
    }
    let digest = Keccak256::digest(&r1_uncompressed[1..]);
    Ok(format!("0x{}", hex::encode(&digest[12..])))
}

// ---------------------------------------------------------------------------
// Minimal CBOR / COSE parse (registration attestation)
//
// Faithful port of the web module's decoder: just enough canonical CBOR to
// walk a WebAuthn attestation object down to the attested credential's
// COSE_Key. Everything outside the supported subset (tags, floats, indefinite
// lengths, absurd sizes) is rejected loudly with the web module's messages.
// ---------------------------------------------------------------------------

const CBOR_MAX_DEPTH: u32 = 8;
const CBOR_MAX_ITEMS: u64 = 256;
const CBOR_MAX_BSTR: u64 = 65_536;

#[derive(Debug, Clone, PartialEq, Eq)]
enum CborValue {
    Int(i64),
    Bytes(Vec<u8>),
    Text(String),
    Array(Vec<CborValue>),
    Map(Vec<(CborValue, CborValue)>),
    Bool(bool),
    Null,
}

struct CborDecode {
    value: CborValue,
    end: usize,
}

fn cbor_fail(reason: &str) -> DeriveError {
    attestation(format!("attestation CBOR: {reason}"))
}

/// Mirror of web `decodeCbor`: same limits, same accepted subset, same errors.
fn decode_cbor(bytes: &[u8], start: usize, depth: u32) -> Result<CborDecode> {
    if depth > CBOR_MAX_DEPTH {
        return Err(cbor_fail("nesting too deep"));
    }
    if start >= bytes.len() {
        return Err(cbor_fail("truncated"));
    }
    let initial = bytes[start];
    let major = initial >> 5;
    let info = initial & 0x1f;
    let arg: u64;
    let mut pos = start + 1;
    if info < 24 {
        arg = u64::from(info);
    } else if info == 24 {
        if pos + 1 > bytes.len() {
            return Err(cbor_fail("truncated"));
        }
        arg = u64::from(bytes[pos]);
        pos += 1;
    } else if info == 25 {
        if pos + 2 > bytes.len() {
            return Err(cbor_fail("truncated"));
        }
        arg = (u64::from(bytes[pos]) << 8) | u64::from(bytes[pos + 1]);
        pos += 2;
    } else if info == 26 {
        if pos + 4 > bytes.len() {
            return Err(cbor_fail("truncated"));
        }
        arg = u64::from(u32::from_be_bytes([
            bytes[pos],
            bytes[pos + 1],
            bytes[pos + 2],
            bytes[pos + 3],
        ]));
        pos += 4;
    } else if info == 27 {
        return Err(cbor_fail(
            "64-bit numbers are not expected in WebAuthn attestation CBOR",
        ));
    } else if info == 31 {
        return Err(cbor_fail("indefinite-length items are not canonical CBOR"));
    } else {
        return Err(cbor_fail("reserved additional information"));
    }

    match major {
        0 => Ok(CborDecode {
            value: CborValue::Int(arg as i64),
            end: pos,
        }),
        1 => Ok(CborDecode {
            value: CborValue::Int(-1 - arg as i64),
            end: pos,
        }),
        2 => {
            if arg > CBOR_MAX_BSTR {
                return Err(cbor_fail("byte string too large"));
            }
            if pos + arg as usize > bytes.len() {
                return Err(cbor_fail("truncated"));
            }
            Ok(CborDecode {
                value: CborValue::Bytes(bytes[pos..pos + arg as usize].to_vec()),
                end: pos + arg as usize,
            })
        }
        3 => {
            if arg > CBOR_MAX_BSTR {
                return Err(cbor_fail("text string too large"));
            }
            if pos + arg as usize > bytes.len() {
                return Err(cbor_fail("truncated"));
            }
            Ok(CborDecode {
                value: CborValue::Text(
                    String::from_utf8_lossy(&bytes[pos..pos + arg as usize]).into_owned(),
                ),
                end: pos + arg as usize,
            })
        }
        4 => {
            if arg > CBOR_MAX_ITEMS {
                return Err(cbor_fail("array too large"));
            }
            let mut items = Vec::new();
            let mut offset = pos;
            for _ in 0..arg {
                let item = decode_cbor(bytes, offset, depth + 1)?;
                items.push(item.value);
                offset = item.end;
            }
            Ok(CborDecode {
                value: CborValue::Array(items),
                end: offset,
            })
        }
        5 => {
            if arg > CBOR_MAX_ITEMS {
                return Err(cbor_fail("map too large"));
            }
            let mut map: Vec<(CborValue, CborValue)> = Vec::new();
            let mut offset = pos;
            for _ in 0..arg {
                let key = decode_cbor(bytes, offset, depth + 1)?;
                let val = decode_cbor(bytes, key.end, depth + 1)?;
                map.push((key.value, val.value));
                offset = val.end;
            }
            Ok(CborDecode {
                value: CborValue::Map(map),
                end: offset,
            })
        }
        6 => Err(cbor_fail(
            "CBOR tags are not expected in WebAuthn attestation CBOR",
        )),
        7 => {
            if arg == 20 {
                Ok(CborDecode {
                    value: CborValue::Bool(false),
                    end: pos,
                })
            } else if arg == 21 {
                Ok(CborDecode {
                    value: CborValue::Bool(true),
                    end: pos,
                })
            } else if arg == 22 {
                Ok(CborDecode {
                    value: CborValue::Null,
                    end: pos,
                })
            } else {
                Err(cbor_fail(
                    "floats and exotic simple values are not expected",
                ))
            }
        }
        _ => Err(cbor_fail("unsupported major type")),
    }
}

/// Last-write-wins lookup (JS `Map.set` semantics): the LAST entry for a key
/// is the effective value.
fn map_get<'a>(map: &'a [(CborValue, CborValue)], key: &CborValue) -> Option<&'a CborValue> {
    map.iter().rev().find(|(k, _)| k == key).map(|(_, v)| v)
}

/// How web formats a missing/wrong-typed lookup in error messages
/// (`String(kty)` over an int, `"undefined"` when absent).
fn lookup_label(value: Option<&CborValue>) -> String {
    match value {
        Some(CborValue::Int(n)) => n.to_string(),
        Some(CborValue::Text(s)) => s.clone(),
        _ => "undefined".to_string(),
    }
}

/// `authenticatorData` out of a WebAuthn `attestationObject` (CBOR map with
/// `fmt` / `attStmt` / `authData`). Works for any `fmt`, including `"none"` —
/// web `parseAttestationAuthData`.
pub fn parse_attestation_auth_data(attestation_object: &[u8]) -> Result<Vec<u8>> {
    let decoded = decode_cbor(attestation_object, 0, 0)?;
    let CborValue::Map(map) = decoded.value else {
        return Err(attestation("attestation object is not a CBOR map"));
    };
    match map_get(&map, &CborValue::Text("authData".to_string())) {
        Some(CborValue::Bytes(auth_data)) => Ok(auth_data.clone()),
        _ => Err(attestation(
            "attestation object has no authData byte string",
        )),
    }
}

/// The attested credential's parts (web `AttestedCredentialData`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttestedCredentialData {
    pub aaguid: Vec<u8>,
    pub credential_id: Vec<u8>,
    /// CBOR-encoded COSE_Key of the new credential.
    pub cose_key: Vec<u8>,
}

/// Split `authenticatorData` (WebAuthn §6.1) down to the attested COSE key —
/// web `parseAttestedCredentialData`.
pub fn parse_attested_credential_data(auth_data: &[u8]) -> Result<AttestedCredentialData> {
    if auth_data.len() < 37 {
        return Err(attestation("authenticator data is truncated"));
    }
    let flags = auth_data[32];
    if (flags & 0x40) == 0 {
        return Err(attestation(
            "the registration response carries no attested credential data (AT flag unset) — the secp256r1 owner key cannot be extracted",
        ));
    }
    let mut offset = 37;
    let need = |n: usize, offset: &mut usize| -> Result<()> {
        if *offset + n > auth_data.len() {
            return Err(attestation("attested credential data is truncated"));
        }
        Ok(())
    };
    need(18, &mut offset)?;
    let aaguid = auth_data[offset..offset + 16].to_vec();
    offset += 16;
    let credential_id_length =
        (usize::from(auth_data[offset]) << 8) | usize::from(auth_data[offset + 1]);
    offset += 2;
    need(credential_id_length, &mut offset)?;
    let credential_id = auth_data[offset..offset + credential_id_length].to_vec();
    offset += credential_id_length;
    let cose = decode_cbor(auth_data, offset, 0)?;
    if !matches!(cose.value, CborValue::Map(_)) {
        return Err(attestation(
            "the credential public key is not a CBOR map (COSE_Key)",
        ));
    }
    Ok(AttestedCredentialData {
        aaguid,
        credential_id,
        cose_key: auth_data[offset..cose.end].to_vec(),
    })
}

/// COSE_Key (RFC 9052) → 65-byte uncompressed secp256r1 point (0x04‖x‖y) —
/// web `coseP256Uncompressed`. Only ES256 (EC2 / P-256) keys pass: the
/// wave-4b WebAuthn validator verifies P-256 signatures in-contract
/// (EIP-7212).
pub fn cose_p256_uncompressed(cose_key: &[u8]) -> Result<Vec<u8>> {
    let decoded = decode_cbor(cose_key, 0, 0)?;
    if decoded.end != cose_key.len() {
        return Err(attestation("trailing bytes after the COSE key"));
    }
    let CborValue::Map(map) = decoded.value else {
        return Err(attestation(
            "the credential public key is not a CBOR map (COSE_Key)",
        ));
    };
    let kty = map_get(&map, &CborValue::Int(1)).cloned();
    let alg = map_get(&map, &CborValue::Int(3)).cloned();
    let crv = map_get(&map, &CborValue::Int(-1)).cloned();
    let x = map_get(&map, &CborValue::Int(-2)).cloned();
    let y = map_get(&map, &CborValue::Int(-3)).cloned();
    if kty != Some(CborValue::Int(2)) {
        return Err(attestation(format!(
            "this passkey's public key is not an EC2 (elliptic-curve) key (kty {}) — only ES256/secp256r1 credentials can own the smart wallet",
            lookup_label(kty.as_ref())
        )));
    }
    if alg != Some(CborValue::Int(-7)) {
        return Err(attestation(format!(
            "this passkey's public key is not ES256 (alg {}) — only ES256/secp256r1 credentials can own the smart wallet",
            lookup_label(alg.as_ref())
        )));
    }
    if crv != Some(CborValue::Int(1)) {
        return Err(attestation(format!(
            "this passkey's public key is not on P-256 (crv {})",
            lookup_label(crv.as_ref())
        )));
    }
    let (Some(CborValue::Bytes(x_bytes)), Some(CborValue::Bytes(y_bytes))) = (x, y) else {
        return Err(attestation(
            "the P-256 public key coordinates are not 32-byte strings",
        ));
    };
    if x_bytes.len() != 32 || y_bytes.len() != 32 {
        return Err(attestation(
            "the P-256 public key coordinates are not 32-byte strings",
        ));
    }
    let mut out = Vec::with_capacity(65);
    out.push(0x04);
    out.extend_from_slice(&x_bytes);
    out.extend_from_slice(&y_bytes);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    // NIST P-256 base point (FIPS 186-4 appendix D.1.2.3) — external truth.
    const GX_HEX: &str = "6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296";
    const GY_HEX: &str = "4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5";

    fn g_uncompressed_hex() -> String {
        format!("04{GX_HEX}{GY_HEX}")
    }

    // Canonical CTAP2-ordered COSE EC2/P-256 key of the base point:
    // {1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x, -3: y} — RFC 9052 §7.1.1.
    fn cose_g() -> String {
        format!("a5010203262001215820{GX_HEX}225820{GY_HEX}")
    }

    // Constructed WebAuthn registration attestation carrying COSE_G — the same
    // vector as web `passkey.test.mjs` (rpIdHash = SHA-256("localhost")).
    fn attestation_hex() -> String {
        let mut out = String::new();
        out.push_str("a363666d74646e6f6e65"); // {"fmt":"none"
        out.push_str("6761747453746d74a0"); //  "attStmt":{}
        out.push_str("6861757468446174615894"); //  "authData": h'148 bytes'
        out.push_str("49960de5880e8c687434170f6476605b8fe4aeb9a28632c7995cf3ba831d9763");
        out.push_str("45"); // flags: UP | UV | AT
        out.push_str("00000000"); // signCount
        out.push_str("00000000000000000000000000000000"); // aaguid
        out.push_str("0010"); // credentialIdLength = 16
        out.push_str("000102030405060708090a0b0c0d0e0f"); // credentialId
        out.push_str(&cose_g());
        out
    }

    const FIXED_PRF_HEX: &str = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
    // Production-chain pins (2026-09-24) — same values as web `passkey.test.mjs`.
    const EXPECTED_NOSTR_SK_HEX: &str =
        "35430cd334f6fe898d7b37886f33a3612edea16fce04fe8bceb92f863e309bf6";
    const EXPECTED_NOSTR_PUB_HEX: &str =
        "489e1b47933dfababa9842058b3a19e2f15cc7f6da0c6f1983688aabe66c2353";
    // keccak-256(Gx‖Gy)[12:] — anchored by the keccak-256("") constant below.
    const EXPECTED_G_ADDRESS: &str = "0xd3a9f047ad43d7e2e4e7e491f1fe2e657a2651b6";

    #[test]
    fn hkdf_sha256_matches_rfc_5869_appendix_a_test_case_3() {
        // IKM = 0x0b × 22, salt = zero-length (≡ all-zero HashLen salt), info = "".
        let okm = hkdf_sha256(&[0x0b; 22], b"");
        // First 32 of the RFC's 42-byte OKM.
        assert_eq!(
            hex::encode(okm),
            "8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d"
        );
    }

    #[test]
    fn a_fixed_prf_output_derives_the_pinned_nostr_key() {
        let prf = hex::decode(FIXED_PRF_HEX).unwrap();
        let sk = derive_nostr_secret_key(&prf);
        assert_eq!(hex::encode(sk), EXPECTED_NOSTR_SK_HEX);
        assert_eq!(nostr_pubkey_hex(&sk).unwrap(), EXPECTED_NOSTR_PUB_HEX);
        // Deterministic: same credential + salt anywhere re-derives the same key.
        let again = derive_nostr_secret_key(&hex::decode(FIXED_PRF_HEX).unwrap());
        assert_eq!(hex::encode(again), EXPECTED_NOSTR_SK_HEX);
        // A different PRF output must not collide into the same key.
        let other = derive_nostr_secret_key(&[0x11; 32]);
        assert_ne!(hex::encode(other), EXPECTED_NOSTR_SK_HEX);
    }

    #[test]
    fn the_r1_address_preview_is_keccak_ethereum_pinned_on_the_base_point() {
        // External anchor: keccak-256("") — the Ethereum keccak, not SHA3-256.
        assert_eq!(
            hex::encode(Keccak256::digest([])),
            "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
        );
        let g = hex::decode(g_uncompressed_hex()).unwrap();
        assert_eq!(r1_address_preview(&g).unwrap(), EXPECTED_G_ADDRESS);
    }

    #[test]
    fn the_attestation_vector_yields_both_identity_roots() {
        let auth_data =
            parse_attestation_auth_data(&hex::decode(attestation_hex()).unwrap()).unwrap();
        let attested = parse_attested_credential_data(&auth_data).unwrap();
        assert_eq!(
            hex::encode(&attested.credential_id),
            "000102030405060708090a0b0c0d0e0f"
        );
        assert_eq!(hex::encode(&attested.aaguid), "00".repeat(16));
        assert_eq!(hex::encode(&attested.cose_key), cose_g());

        let r1 = cose_p256_uncompressed(&attested.cose_key).unwrap();
        assert_eq!(hex::encode(&r1), g_uncompressed_hex());

        let identity = passkey_identity_from(
            &derive_nostr_secret_key(&hex::decode(FIXED_PRF_HEX).unwrap()),
            &r1,
        )
        .unwrap();
        assert_eq!(identity.nostr_pubkey_hex, EXPECTED_NOSTR_PUB_HEX);
        assert_eq!(identity.r1_uncompressed_hex, g_uncompressed_hex());
        assert_eq!(identity.address_preview, EXPECTED_G_ADDRESS);
    }

    #[test]
    fn malformed_attestations_fail_loudly_instead_of_guessing_a_key() {
        // COSE key variants: start from the valid base-point key and break one field.
        let cases: Vec<(String, String, &str)> = vec![
            (
                "non-EC2 kty (RSA credential)".to_string(),
                format!("a50103{}", &cose_g()[6..]),
                "EC2",
            ),
            (
                "non-ES256 alg".to_string(),
                format!("a501020327{}", &cose_g()[10..]),
                "ES256",
            ),
            (
                "non-P-256 curve".to_string(),
                format!("a5010203262002{}", &cose_g()[14..]),
                "P-256",
            ),
            (
                "short x coordinate".to_string(),
                format!("a501020326200121581f{}225820{}", "ab".repeat(31), GY_HEX),
                "32-byte",
            ),
            ("empty key map".to_string(), "a0".to_string(), "EC2"),
            ("non-map key".to_string(), "4100".to_string(), "COSE_Key"),
            (
                "trailing bytes after the key".to_string(),
                format!("{}00", cose_g()),
                "trailing bytes",
            ),
            (
                "truncated key".to_string(),
                cose_g()[..cose_g().len() - 4].to_string(),
                "truncated",
            ),
        ];
        for (name, cose, needle) in cases {
            let err =
                cose_p256_uncompressed(&hex::decode(&cose).expect("case hex")).expect_err(&name);
            let DeriveError::Attestation(message) = &err else {
                panic!("{name}: expected an attestation error, got {err:?}");
            };
            assert!(
                message.contains(needle),
                "{name}: {message:?} does not contain {needle:?}"
            );
        }

        // authData without the AT flag carries no credential key at all.
        let mut no_at = vec![0u8; 37];
        no_at[32] = 0x05; // UP | UV, no AT
        let err = parse_attested_credential_data(&no_at).unwrap_err();
        assert!(
            err.to_string().contains("no attested credential data"),
            "{err}"
        );
        let err = parse_attested_credential_data(&[0u8; 20]).unwrap_err();
        assert!(err.to_string().contains("truncated"), "{err}");
        // AT set but the attested credential data is cut short.
        let mut cut = vec![0u8; 45];
        cut[32] = 0x45;
        let err = parse_attested_credential_data(&cut).unwrap_err();
        assert!(err.to_string().contains("truncated"), "{err}");

        // attestationObject shape failures.
        let err = parse_attestation_auth_data(&hex::decode("4100").unwrap()).unwrap_err();
        assert!(err.to_string().contains("not a CBOR map"), "{err}");
        let err =
            parse_attestation_auth_data(&hex::decode("a163666d74646e6f6e65").unwrap()).unwrap_err();
        assert!(err.to_string().contains("no authData"), "{err}");
        let truncated = &hex::decode(attestation_hex()).unwrap()[..100];
        let err = parse_attestation_auth_data(truncated).unwrap_err();
        assert!(err.to_string().contains("truncated"), "{err}");
    }
}
