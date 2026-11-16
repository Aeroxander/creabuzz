// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

// The largest either part of the 15 : 60 split may be. Both parts are `uint16`, so this keeps their sum far from
// overflowing; a ratio on a larger scale (say 40000 : 40000) would make `settle` revert for ever.
uint16 constant MAX_SPLIT_PART = 10_000;

/// @notice The part of a project's ShareToken the other contracts use.
interface IShares {
    /// @notice Shares in existence.
    function totalSupply() external view returns (uint256);
    /// @notice Shares held by an address.
    function balanceOf(address who) external view returns (uint256);
    /// @notice Move your Shares.
    function transfer(address to, uint256 value) external returns (bool);
    /// @notice Destroy Shares you were allowed to burn.
    function burnFrom(address from, uint256 value) external;
}

/// @notice The part of a project's Vester the treasury uses.
interface IVester {
    /// @notice Shares granted that the schedule has not released yet (depends only on the clock, not on claims).
    function unreleased() external view returns (uint256);
    /// @notice Start the release clock now, once.
    function startNow() external;
    /// @notice Set aside Shares (already sent here) for a beneficiary, before the clock starts.
    function grant(address beneficiary, uint256 amount) external;
}
