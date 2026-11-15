// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {BackingPool} from "../src/BackingPool.sol";
import {BackingPoolFactory} from "../src/BackingPoolFactory.sol";

/// @title BackingTerms
/// @notice The default terms of a backing pool, each explained in docs/v3-review/BACKING-POOL.md. One place, so the
/// deploy script and the local fixture cannot drift apart. A factory fixes its terms for good when it is deployed.
library BackingTerms {
    /// @notice The default terms for a quote token with `quoteDecimals` decimals.
    function defaults(uint8 quoteDecimals) internal pure returns (BackingPool.Params memory p) {
        uint256 one = 10 ** uint256(quoteDecimals);
        p.virtualQuote = 25_000 * one;
        p.virtualUnits = 1_000_000_000e18;
        p.projectBps = 1000;
        p.feeBps = 100;
        p.trancheBps = 2500;
        p.objectionWindow = 7 days;
        p.resolveWindow = 7 days;
        p.claimInterval = 28 days;
        p.abandonAfter = 180 days;
        p.voteSeasoning = 30 days;
        p.voteAfter = 90 days;
        p.earlyWindow = 1 days;
        p.earlyCap = 1_000 * one;
    }

    /// @notice The curve depth tiers a founder may choose from, in whole quote units, in the order
    /// `BackingPoolFactory.depthTiers()` returns them. The factory derives them from the default depth
    /// (`defaults(..).virtualQuote`, 25,000 whole units) as fifths: a fifth, two fifths, once, twice, 4, 10 and 20 times.
    /// Rule of thumb for the app: pick the first tier at or above twice the raise the founder hopes for. At that
    /// depth a sale of half the units moves the price down by about a third, whatever the size of the raise
    /// (docs/v3-review/BACKING-POOL.md, "Curve depth").
    function depthTiersWhole() internal pure returns (uint256[7] memory t) {
        t[0] = 5_000;
        t[1] = 10_000;
        t[2] = 25_000;
        t[3] = 50_000;
        t[4] = 100_000;
        t[5] = 250_000;
        t[6] = 500_000;
    }

    /// @notice A tier in quote base units: `wholeUnits` of a token with `quoteDecimals` decimals.
    function depthOf(uint8 quoteDecimals, uint256 wholeUnits) internal pure returns (uint256) {
        return wholeUnits * 10 ** uint256(quoteDecimals);
    }

    /// @notice The default opening round: 50,000 blocks (about a week at 12 seconds a block; the number has to
    /// divide 10,000,000) selling 100,000,000 claim tokens, a tenth of the curve's paper units, on the given
    /// auction factory.
    function round(address auctionFactory) internal pure returns (BackingPoolFactory.RoundSettings memory r) {
        r.auctionFactory = auctionFactory;
        r.blocks = 50_000;
        r.supply = 100_000_000e18;
    }
}
