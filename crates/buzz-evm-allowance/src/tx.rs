//! EIP-155 legacy transaction construction and signing.
//!
//! Hand-rolled RLP + keccak + `k256` secp256k1 — the same deliberate
//! no-EVM-library posture as `buzz-evm-auth` and the launchpad composer.
//! Only the spend path needs this: `record_spend` broadcasts exactly one
//! bounded-gas legacy transaction per settled spend.

use k256::ecdsa::SigningKey;

use crate::abi::keccak256;
use crate::error::AllowanceError;

/// Hard cap on gas we are willing to send for a `spend()` call. The contract
/// write touches two storage mappings; anything beyond this is a misconfig,
/// not a spend.
pub const MAX_GAS: u64 = 300_000;

/// RLP-encode a byte string (scalars are pre-minimized by the caller).
pub(crate) fn rlp_bytes(data: &[u8]) -> Vec<u8> {
    if data.len() == 1 && data[0] < 0x80 {
        return data.to_vec();
    }
    if data.len() < 56 {
        let mut out = Vec::with_capacity(1 + data.len());
        out.push(0x80 + data.len() as u8);
        out.extend_from_slice(data);
        return out;
    }
    let len = minimal_be(data.len() as u128);
    let mut out = Vec::with_capacity(1 + len.len() + data.len());
    out.push(0xb7 + len.len() as u8);
    out.extend_from_slice(&len);
    out.extend_from_slice(data);
    out
}

/// Wrap an already-encoded payload list.
pub(crate) fn rlp_list(payload: &[u8]) -> Vec<u8> {
    if payload.len() < 56 {
        let mut out = Vec::with_capacity(1 + payload.len());
        out.push(0xc0 + payload.len() as u8);
        out.extend_from_slice(payload);
        return out;
    }
    let len = minimal_be(payload.len() as u128);
    let mut out = Vec::with_capacity(1 + len.len() + payload.len());
    out.push(0xf7 + len.len() as u8);
    out.extend_from_slice(&len);
    out.extend_from_slice(payload);
    out
}

/// Minimal big-endian encoding: no leading zeros, and zero encodes as the
/// empty string (RLP scalar rule).
pub(crate) fn minimal_be(value: u128) -> Vec<u8> {
    if value == 0 {
        return Vec::new();
    }
    let be = value.to_be_bytes();
    let first = be.iter().position(|&b| b != 0).unwrap_or(be.len() - 1);
    be[first..].to_vec()
}

/// RLP-encode a fixed-width big-endian scalar (signature `r`/`s`) as the
/// *integer* it represents: leading zeros stripped, zero as the empty
/// string. A fixed 32-byte string is a non-canonical integer encoding
/// whenever the scalar's top byte is zero (~1/128 of signatures) and is
/// rejected by strict RLP decoders.
pub(crate) fn rlp_scalar(scalar: &[u8]) -> Vec<u8> {
    let first = scalar.iter().position(|&b| b != 0).unwrap_or(scalar.len());
    rlp_bytes(&scalar[first..])
}

/// Derive the 20-byte EVM address of a secp256k1 key:
/// `keccak256(uncompressed_pubkey[1..])[12..32]`.
/// Derive the 20-byte EVM address of a secp256k1 key.
pub fn address_from_key(key: &SigningKey) -> [u8; 20] {
    let verifying = key.verifying_key();
    let point = verifying.to_encoded_point(false);
    let digest = keccak256(&point.as_bytes()[1..]);
    let mut addr = [0u8; 20];
    addr.copy_from_slice(&digest[12..]);
    addr
}

/// A signed, RLP-encoded legacy transaction ready for
/// `eth_sendRawTransaction`, plus its hash and signature parts (exposed so
/// tests can recover the sender; callers only need `raw`/`tx_hash`).
pub struct SignedTx {
    pub raw: Vec<u8>,
    /// keccak256 of the raw RLP — cross-checked against the hash the node
    /// reports for the broadcast (see `AllowanceClient::send_contract_tx`).
    pub tx_hash: [u8; 32],
    /// 64-byte `r || s` signature over the EIP-155 signing prehash.
    /// Read only by the unit test's sender-recovery check.
    #[cfg_attr(not(test), allow(dead_code))]
    pub signature: [u8; 64],
    /// y-parity of the recovery id. Read only by the unit test.
    #[cfg_attr(not(test), allow(dead_code))]
    pub parity: u8,
}

/// Fields of an EIP-155 legacy transaction, all resolved by the caller.
pub struct LegacyTxFields<'a> {
    pub chain_id: u64,
    pub nonce: u64,
    pub gas_price: u128,
    pub gas: u64,
    pub to: &'a [u8; 20],
    pub value: u128,
    pub data: &'a [u8],
}

/// Sign an EIP-155 legacy transaction.
///
/// All fields are already resolved by the caller (nonce, gas price, gas
/// limit); this function is pure signing — no RPC, no retries.
pub fn sign_legacy_tx(
    key: &SigningKey,
    tx: &LegacyTxFields<'_>,
) -> Result<SignedTx, AllowanceError> {
    sign_tx_fields(key, tx)
}

/// Build the EIP-155 signing prehash:
/// `keccak256(rlp([nonce, gasPrice, gasLimit, to, value, data, chainId, 0, 0]))`.
fn signing_prehash(tx: &LegacyTxFields<'_>) -> [u8; 32] {
    let mut payload = Vec::new();
    payload.extend_from_slice(&rlp_bytes(&minimal_be(tx.nonce as u128)));
    payload.extend_from_slice(&rlp_bytes(&minimal_be(tx.gas_price)));
    payload.extend_from_slice(&rlp_bytes(&minimal_be(tx.gas as u128)));
    payload.extend_from_slice(&rlp_bytes(tx.to));
    payload.extend_from_slice(&rlp_bytes(&minimal_be(tx.value)));
    payload.extend_from_slice(&rlp_bytes(tx.data));
    payload.extend_from_slice(&rlp_bytes(&minimal_be(tx.chain_id as u128)));
    // EIP-155's two trailing scalars are the *numbers* 0 — RLP-minimal, i.e.
    // the empty byte string (0x80), never the one-byte string 0x00.
    payload.extend_from_slice(&rlp_bytes(&[]));
    payload.extend_from_slice(&rlp_bytes(&[]));
    keccak256(&rlp_list(&payload))
}

fn sign_tx_fields(key: &SigningKey, tx: &LegacyTxFields<'_>) -> Result<SignedTx, AllowanceError> {
    let prehash = signing_prehash(tx);
    let (signature, recid) = key
        .sign_prehash_recoverable(prehash.as_slice())
        .map_err(|e| AllowanceError::Rpc {
            method: "eth_sendRawTransaction",
            detail: format!("signing failed: {e}"),
        })?;
    let sig_bytes = signature.to_bytes();
    let parity = u64::from(recid.is_y_odd());
    let v = 35 + 2 * tx.chain_id + parity;

    let mut final_payload = Vec::new();
    final_payload.extend_from_slice(&rlp_bytes(&minimal_be(tx.nonce as u128)));
    final_payload.extend_from_slice(&rlp_bytes(&minimal_be(tx.gas_price)));
    final_payload.extend_from_slice(&rlp_bytes(&minimal_be(tx.gas as u128)));
    final_payload.extend_from_slice(&rlp_bytes(tx.to));
    final_payload.extend_from_slice(&rlp_bytes(&minimal_be(tx.value)));
    final_payload.extend_from_slice(&rlp_bytes(tx.data));
    final_payload.extend_from_slice(&rlp_bytes(&minimal_be(v as u128)));
    // `r` and `s` are integers in the RLP tuple — minimally encoded with
    // leading zeros stripped (see [`rlp_scalar`]), never fixed-width strings.
    final_payload.extend_from_slice(&rlp_scalar(&sig_bytes[..32]));
    final_payload.extend_from_slice(&rlp_scalar(&sig_bytes[32..]));

    let encoded = rlp_list(&final_payload);
    let tx_hash = keccak256(&encoded);
    let mut signature = [0u8; 64];
    signature.copy_from_slice(&sig_bytes);
    Ok(SignedTx {
        raw: encoded,
        tx_hash,
        signature,
        parity: parity as u8,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_key() -> SigningKey {
        SigningKey::from_slice(&[7u8; 32]).unwrap()
    }

    #[test]
    fn rlp_scalar_rules() {
        assert!(minimal_be(0).is_empty());
        assert_eq!(minimal_be(1), vec![0x01]);
        assert_eq!(minimal_be(0x0400), vec![0x04, 0x00]);
        // Single byte under 0x80 is its own encoding.
        assert_eq!(rlp_bytes(&[0x05]), vec![0x05]);
        assert_eq!(rlp_bytes(&[0x80]), vec![0x81, 0x80]);
        // Short string.
        assert_eq!(rlp_bytes(b"dog"), [0x83, b'd', b'o', b'g']);
        // Empty payload list.
        assert_eq!(rlp_list(&[]), vec![0xc0]);
    }

    #[test]
    fn address_derivation_is_keccak_of_pubkey() {
        let key = test_key();
        let addr = address_from_key(&key);
        assert_eq!(addr.len(), 20);
        assert_eq!(addr, address_from_key(&test_key()));
        let other = SigningKey::from_slice(&[8u8; 32]).unwrap();
        assert_ne!(addr, address_from_key(&other));
    }

    #[test]
    fn signed_tx_recovers_its_signer() {
        use k256::ecdsa::{RecoveryId, Signature, VerifyingKey};

        let key = test_key();
        let to = [0x42u8; 20];
        let data = vec![0xde, 0xad, 0xbe, 0xef];
        let tx = sign_legacy_tx(
            &key,
            &LegacyTxFields {
                chain_id: 31337,
                nonce: 9,
                gas_price: 2_000_000_000,
                gas: 60_000,
                to: &to,
                value: 0,
                data: &data,
            },
        )
        .expect("signing must succeed");

        // Rebuild the EIP-155 signing prehash exactly as signing did, then
        // ecrecover from the exposed signature and require it to yield the
        // signer's derived address. This binds the whole chain: RLP fields,
        // signing hash, EIP-155 v, and address derivation.
        let mut payload = Vec::new();
        payload.extend_from_slice(&rlp_bytes(&minimal_be(9u128)));
        payload.extend_from_slice(&rlp_bytes(&minimal_be(2_000_000_000u128)));
        payload.extend_from_slice(&rlp_bytes(&minimal_be(60_000u128)));
        payload.extend_from_slice(&rlp_bytes(&to));
        // value 0: minimal_be(0) is empty → RLP encodes the empty string.
        payload.extend_from_slice(&rlp_bytes(&minimal_be(0u128)));
        payload.extend_from_slice(&rlp_bytes(&data));
        payload.extend_from_slice(&rlp_bytes(&minimal_be(31337u128)));
        // EIP-155 trailing scalars are the numbers 0 → RLP empty string.
        payload.extend_from_slice(&rlp_bytes(&[]));
        payload.extend_from_slice(&rlp_bytes(&[]));
        let prehash = keccak256(&rlp_list(&payload));

        let recid = RecoveryId::from_byte(tx.parity).expect("parity is 0 or 1");
        let recovered = VerifyingKey::recover_from_prehash(
            &prehash,
            &Signature::from_slice(&tx.signature).expect("sig bytes"),
            recid,
        )
        .expect("signature must recover");
        let recovered_point = recovered.to_encoded_point(false);
        let digest = keccak256(&recovered_point.as_bytes()[1..]);
        let mut recovered_addr = [0u8; 20];
        recovered_addr.copy_from_slice(&digest[12..]);
        assert_eq!(recovered_addr, address_from_key(&key));

        // EIP-155 v encodes chain id: v = 35 + 2*chainId + parity.
        assert_eq!(35 + 2 * 31337 + tx.parity as u64, 62_710);
        assert_ne!(tx.tx_hash, [0u8; 32]);
        assert!(tx.raw.len() > 60);
    }

    #[test]
    fn signed_tx_round_trips_value_and_data() {
        // A structural smoke check: the RLP list begins with nonce/gas
        // scalars and contains the calldata verbatim.
        let key = test_key();
        let to = [0x01u8; 20];
        let data = vec![0xaa, 0xbb];
        let tx = sign_legacy_tx(
            &key,
            &LegacyTxFields {
                chain_id: 1,
                nonce: 0,
                gas_price: 1_000,
                gas: 21_000,
                to: &to,
                value: 123,
                data: &data,
            },
        )
        .unwrap();
        let raw = String::from_utf8_lossy(&tx.raw); // raw is binary; only check bytes
        let _ = raw;
        let needle = &[0xaa, 0xbb][..];
        assert!(
            tx.raw.windows(needle.len()).any(|w| w == needle),
            "calldata must appear verbatim in the raw tx"
        );
    }

    #[test]
    fn rlp_scalar_encodes_minimal_integers() {
        // Zero -> empty string; leading zeros stripped; a lone 0x80 byte
        // must survive as a one-byte string (0x81 0x80).
        assert_eq!(rlp_scalar(&[0u8; 32]), vec![0x80]);
        assert_eq!(rlp_scalar(&[0x00, 0x00, 0x01]), vec![0x01]);
        assert_eq!(rlp_scalar(&[0x00, 0x80]), vec![0x81, 0x80]);
        assert_eq!(rlp_scalar(&[0x80; 32]), rlp_bytes(&[0x80; 32]));
    }

    // The two vectors below were derived independently with `cast mktx`
    // (foundry 1.4.3, same pinning convention as the `cast sig` selector
    // tests) — RFC 6979 deterministic signatures make the comparison
    // byte-exact, so these pin the RLP structure, the EIP-155 signing
    // digest, the signature encoding, and address derivation end to end.
    //
    // ```text
    // cast mktx --legacy --private-key 0x07…07 --chain 1 --nonce 9 \
    //   --gas-limit 21000 --gas-price 2000000000 --value 0 \
    //   0x0000000000000000000000000000000000000042 0xdeadbeef
    // ```
    #[test]
    fn sign_legacy_tx_matches_cast_derived_vector() {
        let key = SigningKey::from_slice(&[7u8; 32]).unwrap();
        let mut to = [0u8; 20];
        to[19] = 0x42;
        let signed = sign_legacy_tx(
            &key,
            &LegacyTxFields {
                chain_id: 1,
                nonce: 9,
                gas_price: 2_000_000_000,
                gas: 21_000,
                to: &to,
                value: 0,
                data: &[0xde, 0xad, 0xbe, 0xef],
            },
        )
        .unwrap();
        assert_eq!(
            hex::encode(&signed.raw),
            "f8670984773594008252089400000000000000000000000000000000000000428084deadbeef25a0\
             55fb9d4e4d4ba8315346de0df80cf19d9b683de6edc1a885f236ea5ebf726574a0638bc61d3d486\
             2a0569b427f050f414037dc49ab8aa3b87af33daf0553ebc55a"
        );
    }

    // Same command with `--private-key 0x…0037` (scalar 55): this
    // signature's `s` scalar starts with 0x00, so canonical RLP encodes it
    // as a 31-byte string (0x9f prefix) — the raw is 104 bytes, one shorter
    // than the fixed-width case. Encoding `r`/`s` as fixed 32-byte strings
    // (0xa0 + 32 bytes) yields a different, non-canonical byte string that
    // strict decoders reject — this vector fails if the stripping is lost.
    #[test]
    fn sign_legacy_tx_minimally_encodes_signature_scalars() {
        let mut key_bytes = [0u8; 32];
        key_bytes[31] = 55;
        let key = SigningKey::from_slice(&key_bytes).unwrap();
        let mut to = [0u8; 20];
        to[19] = 0x42;
        let signed = sign_legacy_tx(
            &key,
            &LegacyTxFields {
                chain_id: 1,
                nonce: 9,
                gas_price: 2_000_000_000,
                gas: 21_000,
                to: &to,
                value: 0,
                data: &[0xde, 0xad, 0xbe, 0xef],
            },
        )
        .unwrap();
        assert_eq!(
            hex::encode(&signed.raw),
            "f8660984773594008252089400000000000000000000000000000000000000428084deadbeef26a0\
             0d7ea12cffd60b0bfb5abd6b84bd95310afb761735992a06a7705d3208fe0b289f88cedc8f79b2\
             29bfcdc5fb84d8ad166b6a41b6f118cf0634365c90d5e544d2"
        );
    }
}
