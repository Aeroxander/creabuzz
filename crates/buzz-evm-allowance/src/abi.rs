//! Hand-rolled ABI encoding for the `OrgAllowance.sol` surface.
//!
//! Selectors are computed from the canonical signatures with keccak256 at
//! runtime (same approach as `buzz-evm-auth`'s EIP-1271 encoders); the
//! integration test pins them against `cast sig` output. No EVM library —
//! the repo deliberately ships without alloy/ethers.

use sha3::{Digest, Keccak256};

use crate::error::AllowanceError;

pub(crate) const SELECTOR_REMAINING_OF: &str = "remainingOf(bytes32,address,uint64)";
pub(crate) const SELECTOR_SPEND: &str = "spend(bytes32,address,uint64,uint256)";
/// The ENFORCED payout: debits the ledger and moves tokens
/// `transferFrom(treasury, to, amount)` in one call.
pub(crate) const SELECTOR_SPEND_TO: &str = "spendTo(bytes32,address,uint64,uint256,address)";
#[cfg(feature = "test-support")]
pub(crate) const SELECTOR_SET_SPENDER: &str = "setSpender(bytes32,address)";
#[cfg(feature = "test-support")]
pub(crate) const SELECTOR_SET_ALLOWANCE: &str = "setAllowance(bytes32,address,uint64,uint256)";

/// keccak256 of `data`.
pub fn keccak256(data: &[u8]) -> [u8; 32] {
    let mut hasher = Keccak256::new();
    hasher.update(data);
    hasher.finalize().into()
}

/// The 4-byte function selector for a canonical signature string.
pub fn selector(signature: &str) -> [u8; 4] {
    let digest = keccak256(signature.as_bytes());
    [digest[0], digest[1], digest[2], digest[3]]
}

/// Parse a `0x…` hex address (20 bytes).
pub fn parse_address(hex_addr: &str) -> Result<[u8; 20], AllowanceError> {
    let clean = hex_addr
        .trim()
        .trim_start_matches("0x")
        .to_ascii_lowercase();
    let bytes = hex::decode(&clean)
        .map_err(|e| AllowanceError::InvalidInput(format!("bad address hex {hex_addr:?}: {e}")))?;
    bytes.try_into().map_err(|_| {
        AllowanceError::InvalidInput(format!("address must be 20 bytes: {hex_addr:?}"))
    })
}

/// Parse a 32-byte hex subject (the agent's Nostr pubkey, verbatim bytes).
pub fn parse_subject(hex_subject: &str) -> Result<[u8; 32], AllowanceError> {
    let clean = hex_subject
        .trim()
        .trim_start_matches("0x")
        .to_ascii_lowercase();
    if clean.len() != 64 {
        return Err(AllowanceError::InvalidInput(format!(
            "subject must be a 64-char hex pubkey, got {} chars",
            clean.len()
        )));
    }
    let bytes = hex::decode(&clean)
        .map_err(|e| AllowanceError::InvalidInput(format!("bad subject hex: {e}")))?;
    bytes
        .try_into()
        .map_err(|_| AllowanceError::InvalidInput("subject must be 32 bytes".into()))
}

/// A u128 value as one 32-byte ABI word (big-endian, left-padded).
pub fn encode_uint256(value: u128) -> [u8; 32] {
    let mut word = [0u8; 32];
    word[16..].copy_from_slice(&value.to_be_bytes());
    word
}

/// A 20-byte address as one 32-byte ABI word (left-padded).
pub fn encode_address_word(address: &[u8; 20]) -> [u8; 32] {
    let mut word = [0u8; 32];
    word[12..].copy_from_slice(address);
    word
}

/// ABI-encode a `(bytes32, address, uint64)` call — the shape shared by
/// `allowanceOf`, `spentOf` and `remainingOf`.
pub fn encode_view_call(
    selector_hex_sig: &str,
    subject: &[u8; 32],
    token: &[u8; 20],
    epoch: u64,
) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + 96);
    out.extend_from_slice(&selector(selector_hex_sig));
    out.extend_from_slice(subject);
    out.extend_from_slice(&encode_address_word(token));
    out.extend_from_slice(&encode_uint256(epoch as u128));
    out
}

/// ABI-encode `spend(bytes32,address,uint64,uint256)`.
pub fn encode_spend(subject: &[u8; 32], token: &[u8; 20], epoch: u64, amount: u128) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + 128);
    out.extend_from_slice(&selector(SELECTOR_SPEND));
    out.extend_from_slice(subject);
    out.extend_from_slice(&encode_address_word(token));
    out.extend_from_slice(&encode_uint256(epoch as u128));
    out.extend_from_slice(&encode_uint256(amount));
    out
}

/// ABI-encode `spendTo(bytes32,address,uint64,uint256,address)` — the ENFORCED
/// payout (`OrgAllowance.spendTo`): the contract debits the subject's allowance
/// and then moves `amount` of `token` from its treasury to `to`, or reverts as a
/// whole. Unlike [`encode_spend`] (accounting only), a spender key cannot move
/// treasury money any other way.
pub fn encode_spend_to(
    subject: &[u8; 32],
    token: &[u8; 20],
    epoch: u64,
    amount: u128,
    to: &[u8; 20],
) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + 160);
    out.extend_from_slice(&selector(SELECTOR_SPEND_TO));
    out.extend_from_slice(subject);
    out.extend_from_slice(&encode_address_word(token));
    out.extend_from_slice(&encode_uint256(epoch as u128));
    out.extend_from_slice(&encode_uint256(amount));
    out.extend_from_slice(&encode_address_word(to));
    out
}

/// ABI-encode `setSpender(bytes32,address)` (owner administration — used by
/// the deployment/tests, never by the spend-time guard path).
#[cfg(feature = "test-support")]
pub fn encode_set_spender(subject: &[u8; 32], spender: &[u8; 20]) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + 64);
    out.extend_from_slice(&selector(SELECTOR_SET_SPENDER));
    out.extend_from_slice(subject);
    out.extend_from_slice(&encode_address_word(spender));
    out
}

/// ABI-encode `setAllowance(bytes32,address,uint64,uint256)` (owner
/// administration — used by the deployment/tests).
#[cfg(feature = "test-support")]
pub fn encode_set_allowance(
    subject: &[u8; 32],
    token: &[u8; 20],
    epoch: u64,
    amount: u128,
) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + 128);
    out.extend_from_slice(&selector(SELECTOR_SET_ALLOWANCE));
    out.extend_from_slice(subject);
    out.extend_from_slice(&encode_address_word(token));
    out.extend_from_slice(&encode_uint256(epoch as u128));
    out.extend_from_slice(&encode_uint256(amount));
    out
}

/// Decode a 32-byte ABI word into a `u128`.
///
/// A counter value wider than `u128` cannot be represented here; that is an
/// error (which every caller turns into a deny), never a truncation.
pub fn decode_uint256(word: &[u8]) -> Result<u128, AllowanceError> {
    if word.len() != 32 {
        return Err(AllowanceError::MalformedResponse(format!(
            "expected a 32-byte word, got {} bytes",
            word.len()
        )));
    }
    if word[..16].iter().any(|&b| b != 0) {
        return Err(AllowanceError::MalformedResponse(
            "counter value exceeds u128; refusing to truncate".into(),
        ));
    }
    let mut buf = [0u8; 16];
    buf.copy_from_slice(&word[16..]);
    Ok(u128::from_be_bytes(buf))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::epoch::Window;

    /// Selectors pinned against `cast sig` output (foundry 1.4.3) so a
    /// keccak regression cannot silently change the wire format:
    ///
    /// ```text
    /// remainingOf(bytes32,address,uint64)      -> 0xb529bdc5
    /// allowanceOf(bytes32,address,uint64)      -> 0x90f42eed
    /// spentOf(bytes32,address,uint64)          -> 0x5f85ed9c
    /// spend(bytes32,address,uint64,uint256)    -> 0x571d55cd
    /// spenderOf(bytes32)                       -> 0x6a986708
    /// setSpender(bytes32,address)              -> 0x6a66f095
    /// setAllowance(bytes32,address,uint64,uint256) -> 0xae06f5af
    /// ```
    #[test]
    fn selectors_match_cast_sig() {
        let cases: [(&str, [u8; 4], &str); 7] = [
            (
                "remainingOf(bytes32,address,uint64)",
                selector(SELECTOR_REMAINING_OF),
                "0xb529bdc5",
            ),
            (
                "allowanceOf(bytes32,address,uint64)",
                selector("allowanceOf(bytes32,address,uint64)"),
                "0x90f42eed",
            ),
            (
                "spentOf(bytes32,address,uint64)",
                selector("spentOf(bytes32,address,uint64)"),
                "0x5f85ed9c",
            ),
            (
                "spend(bytes32,address,uint64,uint256)",
                selector(SELECTOR_SPEND),
                "0x571d55cd",
            ),
            (
                "spenderOf(bytes32)",
                selector("spenderOf(bytes32)"),
                "0x6a986708",
            ),
            (
                "setSpender(bytes32,address)",
                selector("setSpender(bytes32,address)"),
                "0x6a66f095",
            ),
            (
                "setAllowance(bytes32,address,uint64,uint256)",
                selector("setAllowance(bytes32,address,uint64,uint256)"),
                "0xae06f5af",
            ),
        ];
        for (sig, got, pinned) in cases {
            assert_eq!(hex::encode(got), &pinned[2..], "selector drift for {sig}");
        }
        // keccak sanity: empty input must be the well-known digest.
        assert_eq!(
            hex::encode(keccak256(b"")),
            "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
        );
    }

    /// `spendTo` is the enforced payout: its selector and full calldata are
    /// pinned to `cast` (foundry 1.5.1) so the wire format cannot drift from the
    /// contract:
    ///
    /// ```text
    /// cast sig      "spendTo(bytes32,address,uint64,uint256,address)" -> 0xcea045bd
    /// cast calldata "spendTo(bytes32,address,uint64,uint256,address)" \
    ///   0x11aa…11aa 0x…0042 20000 1500000 0x…00d3
    /// ```
    #[test]
    fn spend_to_selector_and_calldata_match_cast() {
        assert_eq!(hex::encode(selector(SELECTOR_SPEND_TO)), "cea045bd");
        let subject =
            parse_subject("11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa")
                .unwrap();
        let token = parse_address("0x0000000000000000000000000000000000000042").unwrap();
        let to = parse_address("0x00000000000000000000000000000000000000d3").unwrap();
        let data = encode_spend_to(&subject, &token, 20_000, 1_500_000, &to);
        assert_eq!(
            format!("0x{}", hex::encode(&data)),
            "0xcea045bd\
             11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa\
             0000000000000000000000000000000000000000000000000000000000000042\
             0000000000000000000000000000000000000000000000000000000000004e20\
             000000000000000000000000000000000000000000000000000000000016e360\
             00000000000000000000000000000000000000000000000000000000000000d3"
        );
        // The advisory `spend` selector is a DIFFERENT function: a caller that
        // asks for the enforced path can never silently get accounting-only.
        assert_ne!(selector(SELECTOR_SPEND_TO), selector(SELECTOR_SPEND));
        assert_eq!(data.len(), 4 + 5 * 32);
    }

    #[test]
    fn view_call_encoding_shape() {
        let subject = [0x11u8; 32];
        let token = [0x22u8; 20];
        let data = encode_view_call(SELECTOR_REMAINING_OF, &subject, &token, 5);
        assert_eq!(data.len(), 4 + 96);
        // selector
        assert_eq!(&data[..4], &selector(SELECTOR_REMAINING_OF));
        // subject word, verbatim
        assert_eq!(&data[4..36], &subject[..]);
        // address word: 12 zero bytes then the address
        assert!(data[36..48].iter().all(|&b| b == 0));
        assert_eq!(&data[48..68], &token[..]);
        // epoch word
        assert_eq!(&data[68..], &encode_uint256(5));
    }

    #[test]
    fn decode_round_trips_and_rejects_overflow() {
        let word = encode_uint256(u128::MAX);
        assert_eq!(decode_uint256(&word).unwrap(), u128::MAX);
        let mut too_big = encode_uint256(u128::MAX);
        too_big[15] = 0x01; // value above u128::MAX
        assert!(decode_uint256(&too_big).is_err());
        assert!(decode_uint256(&word[..31]).is_err());
    }

    #[test]
    fn bad_inputs_are_errors_not_panics() {
        assert!(parse_address("0x1234").is_err());
        assert!(parse_address("nothex").is_err());
        assert!(parse_subject("0x1234").is_err());
        assert!(parse_subject(&"z".repeat(64)).is_err());
        assert!(parse_subject(&"a".repeat(63)).is_err());
    }

    #[tokio::test]
    async fn window_epoch_used_by_spend_encoding() {
        // spend() epoch field must match the window derivation the check uses.
        let subject = [0u8; 32];
        let token = [0u8; 20];
        let epoch = Window::Day.epoch_at(100_000_000);
        let data = encode_spend(&subject, &token, epoch, 42);
        assert_eq!(data.len(), 4 + 128);
        assert_eq!(&data[68..100], &encode_uint256(epoch as u128));
        assert_eq!(&data[100..], &encode_uint256(42));
    }
}
