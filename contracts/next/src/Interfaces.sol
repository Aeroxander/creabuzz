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
    /// @notice Destroy your own Shares.
    function burn(uint256 value) external;
    /// @notice Let `spender` move up to `value` of your Shares.
    function approve(address spender, uint256 value) external returns (bool);
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

/// @notice What a project's Finisher asks of its Treasury: say the pool is open, say the sale was abandoned, say the sale
/// is closed, and put sale money into the buckets. The Treasury accepts the three `mark` calls only from the Finisher.
interface ITreasuryFinish {
    /// @notice The pool is proven open; starts the Vester's clock.
    function markPoolOpen() external;
    /// @notice No pool will ever open; starts the Vester's clock.
    function markAbandoned() external;
    /// @notice The sale's finish is complete; exits may open.
    function markSaleClosed() external;
    /// @notice Split arrived sale money 15 : 60.
    function settle(uint256 amount) external;
    /// @notice Put arrived money wholly into the melting floor (abandoned sales only).
    function settleToFloor(uint256 amount) external;
    /// @notice Dollars held that no bucket accounts for.
    function unaccounted() external view returns (uint256);
    /// @notice The project's dollar token.
    function quote() external view returns (address);
    /// @notice The platform's address for fees.
    function platform() external view returns (address);
    /// @notice Add dollars to the spendable bucket (pulls from the caller).
    function topUp(uint256 amount) external;
}

/// @notice What the Launcher asks of a project's Finisher.
interface IFinisher {
    /// @notice Set up the clone, once.
    function initialize(address treasury_, address shares_, address quote_) external;
    /// @notice Open the sale with the Launcher's finished settings.
    function open(bytes calldata configData) external returns (address auction, uint64 endBlock);
    /// @notice True when a new sale may open now.
    function canOpen() external view returns (bool);
}

/// @notice What the LiquidityHolder asks of the Launcher: which Treasury a project's Shares belong to.
interface ILauncherView {
    /// @notice The Treasury of the project whose Shares these are; zero for any other token.
    function treasuryOfShares(address shares) external view returns (address);
}
