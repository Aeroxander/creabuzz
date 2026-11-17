// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @dev Today's prices, as the tests pass them to `Launcher.openRound` and `Launcher.openAuction` (founder-set prices,
/// `docs/next-version/FOUNDER-PRICE.md`): a round at 3,000 Shares a dollar (333,333 dollars for the whole project, the lowest
/// round price) and the auction at the lowest start (0.0004 dollars a Share, `Launcher.salePrices`; the minimum is then
/// exactly 100,000 dollars). Constants, so a test can pass them right after `vm.expectRevert` without an extra call.
uint256 constant BASE_SHARES_PER_RAW_DOLLAR = 3e15;
/// @dev `Launcher.salePrices()`'s floor: 100,000 dollars over the 250M auction Shares, rounded up to a whole hundredth.
uint256 constant BASE_START_Q96 = ((uint256(100_000e6) << 96) / 250_000_000e18 + 99) / 100 * 100;

/// @dev A starting price of `dollarsPerShareMicro` millionths of a dollar a Share (400 is 0.0004, 6,000 is 0.006), in Q96.
function startQ96(uint256 dollarsPerShareMicro) pure returns (uint256) {
    return (dollarsPerShareMicro << 96) / 1e18;
}

/// @dev Raw Share units one raw dollar unit buys at `wholeProjectDollars` for all 1,000,000,000 Shares, rounded down
/// (6,000,000 gives 166,666,666,666,666).
function sharesPerRawDollar(uint256 wholeProjectDollars) pure returns (uint256) {
    return 1_000_000_000e18 / (wholeProjectDollars * 1e6);
}
