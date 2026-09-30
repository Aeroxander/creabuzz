//! Compose unsigned CCA launchpad transactions.
//!
//! Mirror of the web composer (`web/src/features/launchpad/lib/bid-tx.ts`) so
//! an agent (or a human shell) can produce the exact bytes the vendored CCA
//! accepts without an EVM signing library in the CLI. Selectors are pinned
//! and cross-checked with `cast sig`; the Solidity suite
//! (`contracts/test/BidCalldata.t.sol`) binds the same bytes. The contract is
//! the authority — this module never signs, never moves money.

// Selectors and encoders are kept in lockstep with the web composer and the
// vendored CCA contract even where the CLI flow does not call them yet.
#![allow(dead_code)]

use num_bigint::BigUint;
use num_traits::Zero;

/// `submitBid(uint256,uint128,address,uint256,bytes)` selector on the CCA
/// auction (hex, no `0x`).
pub const SELECTOR_SUBMIT_BID: &str = "a52c8728";
/// `exitBid(uint256)` selector on the CCA auction (hex, no `0x`).
pub const SELECTOR_EXIT_BID: &str = "8e4deb17";
/// `claimTokens(uint256)` selector on the CCA auction (hex, no `0x`).
pub const SELECTOR_CLAIM_TOKENS: &str = "46e04a2f";
/// `claimTokensBatch(address,uint256[])` selector on the CCA auction (hex,
/// no `0x`).
pub const SELECTOR_CLAIM_TOKENS_BATCH: &str = "b8f163d6";
/// `approve(address,address,uint160,uint48)` selector on Permit2 (hex,
/// no `0x`).
pub const SELECTOR_PERMIT2_APPROVE: &str = "87517c45";
/// `approve(address,uint256)` selector on the bid currency (hex, no `0x`).
pub const SELECTOR_ERC20_APPROVE: &str = "095ea7b3";
/// The canonical Permit2 deployment (`0x`-prefixed; same on every chain).
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

/// ABI-encode the standard ERC-20 `approve(spender, amount)` — the
/// underlying-token allowance Permit2 needs before it can pull the bid. Without
/// it a first-time bidder's `permit2TransferFrom` reverts even with a Permit2
/// allowance set (a fresh account is always a first-time bidder).
pub fn encode_erc20_approve(spender: &str, amount: &BigUint) -> Result<String, String> {
    Ok(format!(
        "0x{SELECTOR_ERC20_APPROVE}{}{}",
        encode_address(spender)?,
        pad32(amount)
    ))
}

/// Largest amount `Permit2.approve`'s `uint160` field can carry.
fn uint160_max() -> BigUint {
    (BigUint::from(1u8) << 160u32) - BigUint::from(1u8)
}

/// The ordered unsigned calls for one bid, exactly as the desktop and web
/// composers order them:
///
/// - ERC-20 currency: `currency.approve(PERMIT2, amount)` (the underlying
///   allowance; always included because the CLI composes offline and cannot
///   tell a first-time bidder from a returning one — a redundant approve costs
///   gas, a missing one reverts the bid), then
///   `PERMIT2.approve(currency, auction, amount, deadline)`, then
///   `auction.submitBid(..)` with `value = 0`.
/// - Native currency (`currency == None`): just `auction.submitBid(..)` with
///   `value = amount` — the CCA requires `msg.value == amount` for native
///   bids, so the old constant `"0x0"` made every native bid revert.
pub fn compose_bid_calls(
    currency: Option<&str>,
    auction: &str,
    amount: &BigUint,
    bid_data: String,
    permit2_deadline: u64,
) -> Result<Vec<TxCall>, String> {
    let mut calls = Vec::new();
    match currency {
        Some(currency_addr) => {
            if amount > &uint160_max() {
                return Err("bid amount exceeds Permit2's uint160 allowance width".into());
            }
            calls.push(TxCall {
                to: currency_addr.to_string(),
                value: "0x0".to_string(),
                data: encode_erc20_approve(PERMIT2_ADDRESS, amount)?,
            });
            calls.push(TxCall {
                to: PERMIT2_ADDRESS.to_string(),
                value: "0x0".to_string(),
                data: encode_permit2_approve(currency_addr, auction, amount, permit2_deadline)?,
            });
            calls.push(TxCall {
                to: auction.to_string(),
                value: "0x0".to_string(),
                data: bid_data,
            });
        }
        None => calls.push(TxCall {
            to: auction.to_string(),
            value: format!("0x{amount:x}"),
            data: bid_data,
        }),
    }
    Ok(calls)
}

/// The ordered unsigned calls for one bid plus the parameters that produced
/// them — the composer output shape shared with web `bid-tx.ts`.
pub struct BidCompose {
    /// Tick-snapped Q96 maximum price the bidder accepts.
    pub max_price_q96: String,
    /// Bid amount in the currency's base units (wei for native bids).
    pub amount: String,
    /// Address that owns the bid and receives the claimed tokens.
    pub owner: String,
    /// EIP-155 chain id the calls target.
    pub chain_id: String,
    /// Calls to submit in order (currency approvals first).
    pub calls: Vec<TxCall>,
}

/// One unsigned contract call — the wallet-request shape (to/value/data).
pub struct TxCall {
    /// Callee address (`0x`-prefixed).
    pub to: String,
    /// Hex quantity of native value the call carries (`"0x0"` for none).
    pub value: String,
    /// `0x`-prefixed calldata for the call.
    pub data: String,
}

/// Validation mirroring `validateBid`/the contract reverts, no chain needed.
pub fn validate_bid(
    max_price_q96: &BigUint,
    tick_spacing_q96: &BigUint,
    clearing_price_q96: &BigUint,
) -> Result<(), String> {
    if !tick_spacing_q96.is_zero() && !(max_price_q96 % tick_spacing_q96).is_zero() {
        return Err("max price is not on the tick grid (TickPriceNotAtBoundary)".into());
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

    const CURRENCY: &str = "0x3333333333333333333333333333333333333333";
    const AUCTION: &str = "0x4444444444444444444444444444444444444444";

    /// `cast calldata "approve(address,uint256)" 0x000000000022D473030F116dDEE9F6B43aC78BA3 1234567890123456789`
    #[test]
    fn erc20_approve_matches_cast() {
        let got =
            encode_erc20_approve(PERMIT2_ADDRESS, &big("1234567890123456789").unwrap()).unwrap();
        assert_eq!(
            got,
            "0x095ea7b3000000000000000000000000000000000022d473030f116ddee9f6b43ac78ba3\
             000000000000000000000000000000000000000000000000112210f47de98115"
        );
    }

    /// The bug: `launchpad compose-bid` emitted only `Permit2.approve` then
    /// `submitBid`, so a first-time ERC-20 bidder's Permit2 pull reverted. The
    /// ERC-20 `approve(PERMIT2, amount)` must come first, then the Permit2
    /// approve, then the bid. Dropping the first call fails this test.
    #[test]
    fn erc20_bid_composes_underlying_approve_then_permit2_then_bid() {
        let amount = big("50000000000").unwrap();
        let calls = compose_bid_calls(
            Some(CURRENCY),
            AUCTION,
            &amount,
            "0xbeef".into(),
            4102444800,
        )
        .unwrap();
        assert_eq!(calls.len(), 3);
        // 1. currency.approve(PERMIT2, amount)
        assert_eq!(calls[0].to, CURRENCY);
        assert_eq!(calls[0].value, "0x0");
        assert_eq!(
            calls[0].data,
            encode_erc20_approve(PERMIT2_ADDRESS, &amount).unwrap()
        );
        assert!(calls[0].data.starts_with("0x095ea7b3"));
        // 2. PERMIT2.approve(currency, auction, amount, deadline)
        assert_eq!(calls[1].to, PERMIT2_ADDRESS);
        assert!(calls[1].data.starts_with("0x87517c45"));
        assert_eq!(
            calls[1].data,
            encode_permit2_approve(CURRENCY, AUCTION, &amount, 4102444800).unwrap()
        );
        // 3. auction.submitBid — no native value on an ERC-20 bid.
        assert_eq!(calls[2].to, AUCTION);
        assert_eq!(calls[2].value, "0x0");
        assert_eq!(calls[2].data, "0xbeef");
    }

    /// Native-currency auctions: the CCA enforces `msg.value == amount`, so the
    /// bid call must carry the budget as value (it used to be the constant "0x0").
    #[test]
    fn native_bid_carries_the_budget_as_value_and_has_no_allowance_calls() {
        let amount = big("1000000000000000000").unwrap(); // 1 ETH
        let calls = compose_bid_calls(None, AUCTION, &amount, "0xbeef".into(), 0).unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].to, AUCTION);
        assert_eq!(calls[0].value, "0xde0b6b3a7640000");
        assert_eq!(calls[0].data, "0xbeef");
    }

    #[test]
    fn oversized_permit2_amount_is_refused() {
        let too_big = uint160_max() + BigUint::from(1u8);
        assert!(compose_bid_calls(Some(CURRENCY), AUCTION, &too_big, "0x".into(), 1).is_err());
        assert!(compose_bid_calls(Some(CURRENCY), AUCTION, &uint160_max(), "0x".into(), 1).is_ok());
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
