//! Compose unsigned CCA launchpad transactions.
//!
//! Mirror of the web composer (`web/src/features/launchpad/lib/bid-tx.ts`) so
//! an agent (or a human shell) can produce the exact bytes the vendored CCA
//! accepts without an EVM signing library in the CLI. Selectors are pinned
//! and cross-checked with `cast sig`; the Solidity suite
//! (`contracts/test/BidCalldata.t.sol`) binds the same bytes. The contract is
//! the authority — this module never signs, never moves money.

use num_bigint::BigUint;
use num_traits::Zero;

pub const SELECTOR_SUBMIT_BID: &str = "a52c8728"; // submitBid(uint256,uint128,address,uint256,bytes)
pub const SELECTOR_EXIT_BID: &str = "8e4deb17"; // exitBid(uint256)
pub const SELECTOR_CLAIM_TOKENS: &str = "46e04a2f"; // claimTokens(uint256)
pub const SELECTOR_CLAIM_TOKENS_BATCH: &str = "b8f163d6"; // claimTokensBatch(address,uint256[])
pub const SELECTOR_PERMIT2_APPROVE: &str = "87517c45"; // approve(address,address,uint160,uint48) on Permit2
pub const PERMIT2_ADDRESS: &str = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const Q96: u32 = 96;

fn big(input: &str) -> Result<BigUint, String> {
    let clean = input.trim().trim_start_matches("0x");
    if clean.is_empty() || !clean.bytes().all(|b| b.is_ascii_digit()) {
        return Err(format!("not a decimal integer: {input:?}"));
    }
    BigUint::parse_bytes(clean.as_bytes(), 10)
        .ok_or_else(|| format!("cannot parse integer: {input:?}"))
}

fn pad32(n: &BigUint) -> String {
    format!("{:0>64}", format!("{n:x}"))
}

fn pad32_u64(n: u64) -> String {
    pad32(&BigUint::from(n))
}

fn encode_address(a: &str) -> Result<String, String> {
    let h = a.trim().trim_start_matches("0x").to_ascii_lowercase();
    if h.len() != 40 || !h.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(format!("not a 0x address: {a:?}"));
    }
    Ok(pad32(&BigUint::parse_bytes(h.as_bytes(), 16).unwrap()))
}

/// `keccak256(abi.encode(address, uint256))` — the leaf the CCA hooks use.
/// ABI encoding: both fields left-padded to 32 bytes, concatenated.
pub fn trustgraph_leaf(member: &str, score: u64) -> Result<Vec<u8>, String> {
    let member_big = BigUint::parse_bytes(member.trim().trim_start_matches("0x").as_bytes(), 16)
        .ok_or_else(|| format!("cannot parse member: {member:?}"))?;
    let mut buf = Vec::with_capacity(64);
    buf.extend_from_slice(&pad32(&member_big).into_bytes());
    buf.extend_from_slice(&pad32(&BigUint::from(score)).into_bytes());
    Ok(buf)
}

/// Snap a desired Q96 price up to the tick grid (mirror `_getTick`).
pub fn snap_max_price_to_tick(desired: &BigUint, tick_spacing: &BigUint) -> BigUint {
    if tick_spacing.is_zero() {
        return desired.clone();
    }
    let rem = desired % tick_spacing;
    if rem.is_zero() {
        desired.clone()
    } else {
        desired + tick_spacing - rem
    }
}

/// ABI-encode `submitBid(uint256,uint128,address,uint256,bytes)`.
pub fn encode_submit_bid(
    max_price_q96: &BigUint,
    amount: &BigUint,
    owner: &str,
    prev_tick_price_q96: Option<&BigUint>,
    hook_data: &str,
) -> Result<String, String> {
    let hook = hook_data
        .trim()
        .trim_start_matches("0x")
        .to_ascii_lowercase();
    if !hook.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(format!("hookData must be hex: {hook_data:?}"));
    }
    let prev = match prev_tick_price_q96 {
        Some(p) => p.clone(),
        // The 4-arg overload defaults the hint to the floor; by convention the
        // callers pass the launch floor. Populate via the caller.
        None => return Err("prev_tick_price_q96 is required (pass the launch floor)".into()),
    };
    let tail_len = BigUint::from(hook.len() / 2);
    let mut out = String::with_capacity(16 + 5 * 64 + 64 + hook.len());
    out.push_str(SELECTOR_SUBMIT_BID);
    out.push_str(&pad32(max_price_q96));
    out.push_str(&pad32(amount));
    out.push_str(&encode_address(owner)?);
    out.push_str(&pad32(&prev));
    out.push_str(&pad32_u64(0xa0)); // offset of the dynamic tail
    out.push_str(&pad32(&tail_len));
    // ABI right-pads bytes to a multiple of 32 bytes.
    let padded = format!("{hook:0<width$}", width = hook.len().div_ceil(64) * 64);
    out.push_str(&padded);
    Ok(format!("0x{out}"))
}

/// ABI-encode `exitBid(uint256)`.
pub fn encode_exit_bid(bid_id: u64) -> String {
    format!("0x{SELECTOR_EXIT_BID}{}", pad32_u64(bid_id))
}

/// ABI-encode `claimTokens(uint256)`.
pub fn encode_claim_tokens(bid_id: u64) -> String {
    format!("0x{SELECTOR_CLAIM_TOKENS}{}", pad32_u64(bid_id))
}

/// ABI-encode `approve(address,address,uint160,uint48)` on Permit2 — the
/// allowance a USDC bid needs before `submitBid`.
pub fn encode_permit2_approve(
    token: &str,
    spender: &str,
    amount: &BigUint,
    deadline: u64,
) -> Result<String, String> {
    Ok(format!(
        "0x{SELECTOR_PERMIT2_APPROVE}{}{}{}{}",
        encode_address(token)?,
        encode_address(spender)?,
        pad32(amount),
        pad32_u64(deadline)
    ))
}

pub struct BidCompose {
    pub max_price_q96: String,
    pub amount: String,
    pub owner: String,
    pub chain_id: String,
    pub calls: Vec<TxCall>,
}

pub struct TxCall {
    pub to: String,
    pub data: String,
}

/// Validation mirroring `validateBid`/the contract reverts, no chain needed.
pub fn validate_bid(
    max_price_q96: &BigUint,
    tick_spacing_q96: &BigUint,
    clearing_price_q96: &BigUint,
) -> Result<(), String> {
    if !tick_spacing_q96.is_zero() {
        if !(max_price_q96 % tick_spacing_q96).is_zero() {
            return Err("max price is not on the tick grid (TickPriceNotAtBoundary)".into());
        }
    }
    if max_price_q96 <= clearing_price_q96 {
        return Err("max price must be above the current clearing price".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn submit_bid_matches_cast_empty_hook() {
        // cast calldata "submitBid(uint256,uint128,address,uint256,bytes)"
        // 1000000000000000000000 50000000000 0x1111.. 4294967297 0x
        let expected = "0xa52c872800000000000000000000000000000000000000000000003635c9adc5dea000000000000000000000000000000000000000000000000000000000000ba43b74000000000000000000000000001111111111111111111111111111111111111111000000000000000000000000000000000000000000000000000000010000000100000000000000000000000000000000000000000000000000000000000000a00000000000000000000000000000000000000000000000000000000000000000";
        let got = encode_submit_bid(
            &big("1000000000000000000000").unwrap(),
            &big("50000000000").unwrap(),
            "0x1111111111111111111111111111111111111111",
            Some(&big("4294967297").unwrap()),
            "0x",
        )
        .unwrap();
        assert_eq!(got, expected);
    }

    #[test]
    fn exit_and_claim_selectors() {
        assert_eq!(
            encode_exit_bid(42),
            "0x8e4deb17000000000000000000000000000000000000000000000000000000000000002a"
        );
        assert_eq!(
            encode_claim_tokens(7),
            "0x46e04a2f0000000000000000000000000000000000000000000000000000000000000007"
        );
    }

    #[test]
    fn snap_rounds_up_to_the_grid() {
        let s = snap_max_price_to_tick(&big("1050").unwrap(), &big("100").unwrap());
        assert_eq!(s, big("1100").unwrap());
        let aligned = snap_max_price_to_tick(&big("1100").unwrap(), &big("100").unwrap());
        assert_eq!(aligned, big("1100").unwrap());
    }

    #[test]
    fn validate_rejects_off_grid_and_sub_clearing() {
        assert!(validate_bid(
            &big("1050").unwrap(),
            &big("100").unwrap(),
            &big("900").unwrap()
        )
        .is_err());
        assert!(validate_bid(
            &big("900").unwrap(),
            &big("100").unwrap(),
            &big("900").unwrap()
        )
        .is_err());
        assert!(validate_bid(
            &big("1100").unwrap(),
            &big("100").unwrap(),
            &big("900").unwrap()
        )
        .is_ok());
    }

    #[test]
    fn permit2_approve_selector_shape() {
        let got = encode_permit2_approve(
            "0x3333333333333333333333333333333333333333",
            "0x4444444444444444444444444444444444444444",
            &big("1234567890123456789").unwrap(),
            4102444800,
        )
        .unwrap();
        assert!(got.starts_with("0x87517c45"));
    }
}
