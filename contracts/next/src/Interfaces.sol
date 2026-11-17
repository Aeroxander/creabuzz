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

/// @notice The part of a project's Vester the treasury and the Rounds use.
interface IVester {
    /// @notice Shares granted that the schedule has not released yet (depends only on the clock, not on claims).
    function unreleased() external view returns (uint256);
    /// @notice Start the release clock now, once.
    function startNow() external;
    /// @notice When the clock started; zero until then.
    function start() external view returns (uint256);
    /// @notice Set aside Shares (already sent here) for a beneficiary, before the clock starts.
    function grant(address beneficiary, uint256 amount) external;
    /// @notice Cut a leaving founder's birth grant to the days served out of 365; the cut goes to the caller (the treasury).
    function trimFounder() external returns (uint256 cut);
    /// @notice Set aside Shares (already sent here) that `backer` bought in round `round`.
    function grantHeld(uint256 round, address backer, uint256 amount) external;
    /// @notice Cancel what is still held for `backer` in round `round`; returns the Shares cancelled and the grant before.
    function cancelHeld(uint256 round, address backer) external returns (uint256 cancelled, uint256 total);
    /// @notice A backer grant and how much of it was claimed.
    function heldGrants(uint256 round, address backer) external view returns (uint256 total, uint256 claimed);
}

/// @notice What a project's Treasury tells its Rounds, and what the Rounds ask of it.
interface ITreasuryRounds {
    /// @notice The end of the active window right now: the last check-in plus 14 days, or zero while payments are paused or
    /// after the project wound down. Release time counts only up to it.
    function activeEnd() external view returns (uint256);
    /// @notice Add dollars to `spendable` (pulls from the caller).
    function topUp(uint256 amount) external;
    /// @notice The market opened or "no market" was declared: the sale phase is over.
    function poolOpen() external view returns (bool);
    /// @notice The project wound down.
    function woundDown() external view returns (bool);
}

/// @notice What a project's Treasury asks of its Rounds.
interface IRounds {
    /// @notice Work the shared release clock out up to now (the treasury calls it before it changes the active window).
    function sync() external;
    /// @notice The project wound down: releases stop for good and the refund fee falls to the platform's part.
    function windDown() external;
}

/// @notice The runner seat of a project's Treasury, as the Pair and the Launcher see it.
interface ITreasuryRunner {
    /// @notice Who runs the project: the founder, a Pair, later a Council.
    function runner() external view returns (address);
    /// @notice Send dollars out of `spendable`.
    function spend(address to, uint256 amount) external;
    /// @notice Press check-in.
    function checkIn() external;
    /// @notice Take the runner seat that was offered to the caller.
    function takeSeat() external;
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
