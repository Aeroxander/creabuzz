//! 32-byte ABI words: hex, decimal and small-integer views.
//!
//! Every amount the contracts emit fits in a `u128` (the largest is the
//! 1,000,000,000 x 1e18 Shares supply), but a few fields (`sqrtPriceX96`, Q96
//! prices) do not, so words are kept and stored as decimal strings of the full
//! 256 bits and narrowed to `u128` only where the numbers are worked out.

/// One ABI word.
pub type Word = [u8; 32];

/// `0x`-prefixed lowercase hex.
pub fn hex0x(bytes: &[u8]) -> String {
    format!("0x{}", hex::encode(bytes))
}

/// The decimal digits of an unsigned 256-bit big-endian word.
pub fn word_to_decimal(word: &Word) -> String {
    // Long division by 10 over the big-endian bytes, one digit per pass.
    let mut n = *word;
    let mut digits = Vec::with_capacity(78);
    loop {
        let mut rem: u32 = 0;
        let mut all_zero = true;
        for byte in n.iter_mut() {
            let cur = (rem << 8) | u32::from(*byte);
            *byte = (cur / 10) as u8;
            rem = cur % 10;
            if *byte != 0 {
                all_zero = false;
            }
        }
        digits.push(b'0' + rem as u8);
        if all_zero {
            break;
        }
    }
    digits.reverse();
    // `digits` holds ASCII digits only.
    String::from_utf8(digits).unwrap_or_default()
}

/// The word as a `u128`, or `None` when it does not fit.
pub fn word_to_u128(word: &Word) -> Option<u128> {
    if word[..16].iter().any(|b| *b != 0) {
        return None;
    }
    let mut low = [0u8; 16];
    low.copy_from_slice(&word[16..]);
    Some(u128::from_be_bytes(low))
}

/// The last 20 bytes of a word (an address argument).
pub fn word_to_address(word: &Word) -> [u8; 20] {
    let mut out = [0u8; 20];
    out.copy_from_slice(&word[12..]);
    out
}

/// Parse `0x`-prefixed (or bare) hex of exactly `N` bytes.
pub fn parse_fixed<const N: usize>(text: &str) -> Option<[u8; N]> {
    let raw = text.strip_prefix("0x").unwrap_or(text);
    let bytes = hex::decode(raw).ok()?;
    bytes.try_into().ok()
}

/// Parse `0x`-prefixed hex of any length.
pub fn parse_bytes(text: &str) -> Option<Vec<u8>> {
    hex::decode(text.strip_prefix("0x").unwrap_or(text)).ok()
}

/// Parse a JSON-RPC quantity (`0x`-prefixed hex) as a `u64`.
pub fn parse_quantity(text: &str) -> Option<u64> {
    let raw = text.strip_prefix("0x")?;
    if raw.is_empty() {
        return None;
    }
    u64::from_str_radix(raw, 16).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn word_of(value: u128) -> Word {
        let mut w = [0u8; 32];
        w[16..].copy_from_slice(&value.to_be_bytes());
        w
    }

    #[test]
    fn decimals_of_small_large_and_full_words() {
        assert_eq!(word_to_decimal(&[0u8; 32]), "0");
        assert_eq!(word_to_decimal(&word_of(58_639_010)), "58639010");
        assert_eq!(word_to_decimal(&word_of(u128::MAX)), u128::MAX.to_string());
        assert_eq!(
            word_to_decimal(&[0xff; 32]),
            "115792089237316195423570985008687907853269984665640564039457584007913129639935"
        );
        // 2^160 - 1, a full sqrtPriceX96 range value, does not fit a u128.
        let mut w = [0u8; 32];
        w[12..].copy_from_slice(&[0xff; 20]);
        assert_eq!(
            word_to_decimal(&w),
            "1461501637330902918203684832716283019655932542975"
        );
        assert_eq!(word_to_u128(&w), None);
        assert_eq!(word_to_u128(&word_of(7)), Some(7));
    }

    #[test]
    fn quantities_and_fixed_hex() {
        assert_eq!(parse_quantity("0x10"), Some(16));
        assert_eq!(parse_quantity("10"), None);
        assert_eq!(parse_quantity("0x"), None);
        assert_eq!(parse_fixed::<2>("0xabcd"), Some([0xab, 0xcd]));
        assert_eq!(parse_fixed::<2>("0xabcdef"), None);
    }
}
