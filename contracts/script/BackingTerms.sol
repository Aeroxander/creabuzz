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

    /// @notice The default opening round: 50,000 blocks (about a week at 12 seconds a block; the number has to
    /// divide 10,000,000) selling 100,000,000 claim tokens, a tenth of the curve's paper units, on the given
    /// auction factory.
    function round(address auctionFactory) internal pure returns (BackingPoolFactory.RoundSettings memory r) {
        r.auctionFactory = auctionFactory;
        r.blocks = 50_000;
        r.supply = 100_000_000e18;
    }
}
