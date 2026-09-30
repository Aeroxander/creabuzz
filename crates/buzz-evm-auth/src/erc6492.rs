//! ERC-6492 (counterfactual contract signature) helpers and a minimal ABI
//! codec. The relay-side verifier does not need a full Solidity ABI tool —
//! just the handful of encodings used by EIP-1271 and EIP-6492.
//!
//! ## References
//!
//! - [EIP-1271](https://eips.ethereum.org/EIPS/eip-1271): `isValidSignature`.
//! - [EIP-6492](https://eips.ethereum.org/EIPS/eip-6492): predeploy
//!   (counterfactual) signature wrapper.
//!
//! The wrapper format is:
//!
//! ```text
//! concat(abi.encode((factory, factoryCalldata, originalSig), (address, bytes, bytes)), magicBytes)
//! ```
//!
//! where `magicBytes = 0x6492 …6492` (the trailing 32 bytes used for
//! detection). Decoding it back to `(address, bytes, bytes)` is pure and
//! unit-testable without any RPC.

use crate::address::keccak256;
use crate::error::EvmAuthError;
use crate::EvmAddress;

/// EIP-1271 success magic: `isValidSignature` returns this `bytes4` on success.
pub const ERC1271_SUCCESS: [u8; 4] = [0x16, 0x26, 0xba, 0x7e];

/// EIP-6492 detection suffix (trailing 32 bytes of a wrapped signature).
pub const ERC6492_DETECTION_SUFFIX: [u8; 32] = [
    0x64, 0x92, 0x64, 0x92, 0x64, 0x92, 0x64, 0x92, 0x64, 0x92, 0x64, 0x92, 0x64, 0x92, 0x64, 0x92,
    0x64, 0x92, 0x64, 0x92, 0x64, 0x92, 0x64, 0x92, 0x64, 0x92, 0x64, 0x92, 0x64, 0x92, 0x64, 0x92,
];

/// `isValidSignature(bytes32,bytes)` selector.
pub fn erc1271_selector() -> [u8; 4] {
    first4(keccak256(b"isValidSignature(bytes32,bytes)"))
}

/// `isValidSig(address,bytes32,bytes)` selector (universal validator,
/// EIP-6492 reference implementation).
pub fn is_valid_sig_selector() -> [u8; 4] {
    first4(keccak256(b"isValidSig(address,bytes32,bytes)"))
}

/// `isValidSigWithSideEffects(address,bytes32,bytes)` selector.
pub fn is_valid_sig_side_effects_selector() -> [u8; 4] {
    first4(keccak256(
        b"isValidSigWithSideEffects(address,bytes32,bytes)",
    ))
}

/// Is the signature wrapped in the ERC-6492 counterfactual format?
pub fn is_erc6492_wrapped(signature: &[u8]) -> bool {
    signature.len() > 32 && signature[signature.len() - 32..] == ERC6492_DETECTION_SUFFIX
}

/// Decode a ERC-6492 wrapper into `(factory_address, factory_calldata,
/// original_sig)`. Assumes `is_erc6492_wrapped` already returned true.
pub fn decode_erc6492(signature: &[u8]) -> Result<(EvmAddress, Vec<u8>, Vec<u8>), EvmAuthError> {
    if !is_erc6492_wrapped(signature) {
        return Err(EvmAuthError::InvalidSignature(
            "not an ERC-6492 wrapped signature".into(),
        ));
    }
    // Trim the trailing magic bytes before ABI-decoding the (address, bytes, bytes) tuple.
    let inner = &signature[..signature.len() - 32];
    let take = |cursor: usize, n: usize| -> Result<&[u8], EvmAuthError> {
        inner
            .get(cursor..cursor + n)
            .ok_or_else(|| EvmAuthError::InvalidSignature("truncated ABI data".into()))
    };

    // Layout of `(address, bytes, bytes)`:
    //   head word 0 (0..32):   address, inline (static).
    //   head word 1 (32..64):  offset to first `bytes` field.
    //   head word 2 (64..96):  offset to second `bytes` field.
    //   tail (from 96):        the two dynamic bytes fields.
    let word_at =
        |i: usize| -> Result<[u8; 32], EvmAuthError> { Ok(take(i, 32)?.try_into().unwrap()) };
    let offset_of = |i: usize| -> Result<usize, EvmAuthError> {
        let w = word_at(i)?;
        Ok(u32::from_be_bytes(w[28..].try_into().unwrap()) as usize)
    };

    let factory_bytes: [u8; 20] = take(12, 20)?
        .try_into()
        .map_err(|_| EvmAuthError::InvalidSignature("bad factory address".into()))?;
    let calldata_off = offset_of(32)?;
    let sig_off = offset_of(64)?;

    let (calldata, _) = decode_bytes(inner, calldata_off)?;
    let (sig, _) = decode_bytes(inner, sig_off)?;

    Ok((EvmAddress::from_bytes(factory_bytes), calldata, sig))
}

/// ABI-encode a `(bytes32, bytes)` call to `isValidSignature`.
///
/// Layout: `[selector(4)][hash(32)][offset_to_bytes(32)][len(32)][data(padded)]`.
pub fn encode_is_valid_signature(hash: &[u8; 32], signature: &[u8]) -> Vec<u8> {
    let mut out = erc1271_selector().to_vec();
    out.extend_from_slice(hash);
    push_word(&mut out, 0x40); // bytes field begins after the 64-byte head
    push_bytes(&mut out, signature);
    out
}

/// ABI-encode a `(address, bytes32, bytes)` call to the universal validator's
/// `isValidSig`.
///
/// Layout:
/// `[selector(4)][addr(32: 12 pad ‖ 20)][hash(32)][offset_to_bytes(32)][len(32)][data(padded)]`.
pub fn encode_is_valid_sig(signer: &EvmAddress, hash: &[u8; 32], signature: &[u8]) -> Vec<u8> {
    let mut out = is_valid_sig_selector().to_vec();
    out.extend_from_slice(&[0u8; 12]);
    out.extend_from_slice(signer.as_bytes());
    out.extend_from_slice(hash);
    push_word(&mut out, 0x60); // bytes field begins after the 96-byte head
    push_bytes(&mut out, signature);
    out
}

/// Decode the first `bytes4` of a call return. Tolerates both a short returned
/// value and a 32-byte word left-padded as Solidity `bytes4`.
pub fn decode_bytes4_return(data: &[u8]) -> Result<[u8; 4], EvmAuthError> {
    if data.len() < 4 {
        return Err(EvmAuthError::InvalidSignature("short bytes4 return".into()));
    }
    let mut out = [0u8; 4];
    out.copy_from_slice(&data[..4]);
    Ok(out)
}

fn first4(word: [u8; 32]) -> [u8; 4] {
    let mut out = [0u8; 4];
    out.copy_from_slice(&word[..4]);
    out
}

/// Append a 32-byte ABI word holding `value` (right-aligned):
/// `[0x00…][value as u32]`, always 32 bytes total.
fn push_word(out: &mut Vec<u8>, value: u32) {
    let mut word = [0u8; 32];
    word[28..].copy_from_slice(&value.to_be_bytes());
    out.extend_from_slice(&word);
}

/// Append a dynamic bytes field in ABI form: `[len word(32)][data padded to 32]`.
fn push_bytes(out: &mut Vec<u8>, data: &[u8]) {
    push_word(out, data.len() as u32);
    out.extend_from_slice(data);
    while !out.len().is_multiple_of(32) {
        out.push(0);
    }
}

/// Decode a dynamic bytes field at `offset` within an ABI payload, returning
/// the bytes and the cursor just past the data region.
fn decode_bytes(payload: &[u8], offset: usize) -> Result<(Vec<u8>, usize), EvmAuthError> {
    let err = || EvmAuthError::InvalidSignature("bad ABI bytes field".into());
    // Length is a 32-byte word at `offset`; data starts at `offset + 32`.
    let len_word = payload.get(offset..offset + 32).ok_or_else(err)?;
    let len = u32::from_be_bytes(
        len_word[28..]
            .try_into()
            .map_err(|_| EvmAuthError::InvalidSignature("bad ABI length".into()))?,
    ) as usize;
    let data_start = offset + 32;
    let data = payload.get(data_start..data_start + len).ok_or_else(err)?;
    Ok((data.to_vec(), data_start + len))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn magic_constants() {
        assert_eq!(
            hex::encode(ERC1271_SUCCESS),
            "1626ba7e",
            "EIP-1271 success magic"
        );
        assert_eq!(
            hex::encode(ERC6492_DETECTION_SUFFIX),
            "6492649264926492649264926492649264926492649264926492649264926492",
            "EIP-6492 detection suffix"
        );
    }

    #[test]
    fn selectors_are_stable() {
        assert_eq!(hex::encode(erc1271_selector()), "1626ba7e");
        assert_eq!(hex::encode(is_valid_sig_selector()), "98ef1ed8");
        assert_eq!(
            hex::encode(is_valid_sig_side_effects_selector()),
            "8f068430"
        );
    }

    #[test]
    fn detect_wrapper() {
        let plain = [0x30u8; 65];
        assert!(!is_erc6492_wrapped(&plain));
        let mut wrapped = vec![0x30u8; 40];
        wrapped.extend_from_slice(&ERC6492_DETECTION_SUFFIX);
        assert!(is_erc6492_wrapped(&wrapped));
        // Too-short payload can't be wrapped.
        let short = vec![0u8; 32];
        assert!(!is_erc6492_wrapped(&short));
    }

    #[test]
    fn encode_is_valid_signature_roundtrip_shape() {
        let hash = [7u8; 32];
        let sig: Vec<u8> = (0u8..65).collect();
        let call = encode_is_valid_signature(&hash, &sig);
        // selector(4) + head(64) + len(32) + data(65 padded to 96) = 192 (selector 4 + head 64 + len 32 + 96 padded data)
        assert_eq!(call.len(), 192);
        assert_eq!(&call[..4], &erc1271_selector());
        assert_eq!(&call[4..36], &hash);
        // Offset word is 0x40 = 64 (bytes field starts after the 64-byte head).
        let mut offset = [0u8; 32];
        offset[28..].copy_from_slice(&0x40u32.to_be_bytes());
        assert_eq!(&call[36..68], &offset);
    }

    #[test]
    fn encode_is_valid_sig_roundtrip_shape() {
        let addr = EvmAddress::from_bytes([0xabu8; 20]);
        let hash = [9u8; 32];
        let sig: Vec<u8> = (0u8..65).collect();
        let call = encode_is_valid_sig(&addr, &hash, &sig);
        // selector(4) + head(96) + len(32) + data(65 padded to 96) = 224 (selector 4 + head 96 + len 32 + 96 padded data)
        assert_eq!(call.len(), 224);
        assert_eq!(&call[..4], &is_valid_sig_selector());
        assert_eq!(&call[16..36], addr.as_bytes());
    }

    #[test]
    fn decode_wrapper_roundtrip() {
        let factory = EvmAddress::from_bytes([0x11u8; 20]);
        let calldata: Vec<u8> = (0u8..40).collect();
        let inner_sig: Vec<u8> = [0x22u8; 65].to_vec();

        // Build the canonical wrapper: abi.encode((address, bytes, bytes)) then
        // append the ERC-6492 magic bytes.
        let mut tuple = Vec::new();
        // word 0: address (inline). word 1/2: 32-byte offsets to the two bytes fields.
        tuple.extend_from_slice(&[0u8; 12]);
        tuple.extend_from_slice(factory.as_bytes());
        push_word(&mut tuple, 0x60); // calldata begins at byte 96
        push_word(&mut tuple, 0xc0); // sig begins at byte 192 (96 + 32 + 64)
        push_bytes(&mut tuple, &calldata);
        push_bytes(&mut tuple, &inner_sig);
        tuple.extend_from_slice(&ERC6492_DETECTION_SUFFIX);

        assert!(is_erc6492_wrapped(&tuple));
        let (factory_out, calldata_out, sig_out) = decode_erc6492(&tuple).unwrap();
        assert_eq!(factory_out, factory);
        assert_eq!(calldata_out, calldata);
        assert_eq!(sig_out, inner_sig);
    }

    #[test]
    fn decode_wrapper_rejects_unwrapped() {
        let plain = [0x30u8; 65];
        assert!(decode_erc6492(&plain).is_err());
    }
}
