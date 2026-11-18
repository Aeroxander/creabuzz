// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title TestQuoteToken
/// @notice A free-mint 18-decimal token for TESTNETS ONLY. Anyone can mint any amount to any address, up to
/// `MAX_MINT` in one call, as many times as they like. It is worth nothing, so any price paid in it proves
/// nothing: it exists so a person can try a weekly sale (offers, bids, settling) with money that costs nothing.
/// Never deploy it on a network where tokens carry value, and never present a price in it as real.
///
/// It is a plain OpenZeppelin ERC-20 with one public `mint` and nothing else: no owner, no roles, no pause, no
/// blocklist, no fee, no hook, no way to take tokens from anyone. Transfers move exactly the amount asked, which is
/// what a market's exact-transfer check wants from a quote token.
contract TestQuoteToken is ERC20 {
    /// @notice The most one `mint` call may create: 10,000 tokens.
    uint256 public constant MAX_MINT = 10_000e18;

    /// @notice A single mint asked for more than `MAX_MINT`.
    error MintTooLarge(uint256 asked, uint256 max);

    constructor() ERC20("Creaton test token (free, worth nothing)", "tTEST") {}

    /// @notice Create `amount` new tokens for `to`. Open to everyone; at most `MAX_MINT` per call.
    /// @dev A zero `to` is refused by the ERC-20 itself.
    function mint(address to, uint256 amount) external {
        if (amount > MAX_MINT) revert MintTooLarge(amount, MAX_MINT);
        _mint(to, amount);
    }
}
