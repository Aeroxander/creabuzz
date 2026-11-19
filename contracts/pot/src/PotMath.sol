// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Math} from "oz5/utils/math/Math.sol";

/// @title PotMath
/// @notice The integer formulas of the join and leave rules (JOIN-LEAVE-DESIGN.md, sections 2.1 and 2.2), as pure
/// functions so the Treasury's quotes and its actions use the very same code. Every division rounds down (so dust stays
/// with those who stay) except the platform fee, which rounds up by at most one unit.
/// Units: dollars have 6 decimals; Shares and Team Shares have 18.
library PotMath {
    /// @dev The scale of the allowance rate: parts per million of the pot a day.
    uint256 internal constant PPM = 1e6;
    /// @dev The scale of the platform fee: ten-thousandths.
    uint256 internal constant BPS = 1e4;
    /// @dev The virtual dollar added to the money, and to paid-in, in the quote only.
    uint256 internal constant OFFSET_USD = 1e6;
    /// @dev The virtual 100 Shares added to backer Shares in the quote only.
    uint256 internal constant OFFSET_SHARES = 100e18;

    /// @notice The platform's fee on a payment of `a`: `a x feeBps / 10,000` rounded up, so the platform never loses to
    /// rounding and a payment is never charged more than one unit above the exact fee.
    function fee(uint256 a, uint256 feeBps) internal pure returns (uint256) {
        return (a * feeBps + BPS - 1) / BPS;
    }

    /// @notice The price of a Share for a joiner, as a fraction `num / den` of dollar units per Share unit.
    /// It is the leave-value formula on the pot plus money still arriving, with the quote offset (one dollar of money and
    /// of paid-in, 100 Shares), and with the Team Shares announced to burn already taken out (`ge` = G - Z).
    /// `num` is never zero (the offset), so a price always exists.
    /// @param pot The pot P.
    /// @param arriving Outside money not yet in the pot, counted at face.
    /// @param paidIn What backers put in and have not taken back (A).
    /// @param b Backer Shares in existence (B), without the offset.
    /// @param ge Team Shares counted for pricing: all of them minus those announced to burn.
    function quote(uint256 pot, uint256 arriving, uint256 paidIn, uint256 b, uint256 ge)
        internal
        pure
        returns (uint256 num, uint256 den)
    {
        uint256 x = pot + arriving + OFFSET_USD;
        uint256 aq = paidIn + OFFSET_USD;
        uint256 bq = b + OFFSET_SHARES;
        uint256 mn = x < aq ? x : aq;
        uint256 sur = x - mn;
        num = mn * (bq + ge) + sur * bq;
        den = bq * (bq + ge);
    }

    /// @notice Shares minted for `m` dollars at the price `num / den`, rounded down.
    function sharesFor(uint256 m, uint256 num, uint256 den) internal pure returns (uint256) {
        return Math.mulDiv(m, den, num);
    }

    /// @notice How much of `m` counts as paid-in after minting `n` Shares into `b` existing ones: the whole of it for the
    /// first backer, otherwise at most `n x paidIn / b` (the rest buys a slice of the surplus), rounded down.
    function credit(uint256 m, uint256 n, uint256 paidIn, uint256 b) internal pure returns (uint256) {
        if (b == 0) return m;
        uint256 c = Math.mulDiv(n, paidIn, b);
        return c < m ? c : m;
    }

    /// @notice The cash `n` backer Shares are paid: paid-in first (up to `paidIn`), anything above it shared by backer and
    /// Team Shares. Two floors. No offset, no arriving money, no allowance box.
    function cash(uint256 n, uint256 pot, uint256 paidIn, uint256 b, uint256 g) internal pure returns (uint256) {
        uint256 a1 = pot < paidIn ? pot : paidIn;
        uint256 s = pot - a1;
        return Math.mulDiv(n, a1, b) + Math.mulDiv(n, s, b + g);
    }

    /// @notice The cash `n` Team Shares are paid: only the part of the pot above paid-in, shared by all Shares.
    function teamCash(uint256 n, uint256 pot, uint256 paidIn, uint256 b, uint256 g) internal pure returns (uint256) {
        uint256 s = pot > paidIn ? pot - paidIn : 0;
        return Math.mulDiv(n, s, b + g);
    }

    /// @notice What leaves paid-in when `n` of `b` backer Shares leave: `paidIn x n / b` rounded down, so what remains
    /// rounds up and the stayers keep their priority.
    function paidInCut(uint256 paidIn, uint256 n, uint256 b) internal pure returns (uint256) {
        return Math.mulDiv(paidIn, n, b);
    }
}
