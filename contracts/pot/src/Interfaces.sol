// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// @notice The part of a ShareToken the other contracts use (backer Shares and Team Shares are the same code).
interface IShares {
    /// @notice Shares in existence.
    function totalSupply() external view returns (uint256);
    /// @notice Shares held by an address.
    function balanceOf(address who) external view returns (uint256);
    /// @notice Move your Shares.
    function transfer(address to, uint256 value) external returns (bool);
    /// @notice The one address that may mint and burn: the project's Treasury.
    function controller() external view returns (address);
    /// @notice Create Shares. Only the controller.
    function mint(address to, uint256 value) external;
    /// @notice Destroy `value` of `from`'s Shares. Only the controller, and the Treasury calls it only for the caller's own
    /// Shares inside a leave, or for the Vester's own forfeited Team Shares.
    function burnFor(address from, uint256 value) external;
}

/// @notice What the Treasury asks of the project's Vester.
interface IVester {
    /// @notice Set aside `amount` Team Shares for `member` on a clock of its own; returns the grant's id. Only the Treasury.
    /// A protected grant vests on calendar time over 365 days, with no cliff, and can never be forfeited or burned.
    function grant(address member, uint256 amount, bool protected_) external returns (uint256 id);
    /// @notice Both signers of a Pair runner announce the forfeit of grant `id` (the Treasury has checked them). Only the
    /// Treasury.
    function announceByRunner(uint256 id) external;
    /// @notice A leaving founder's grants are all announced as an own exit (the hand-over trim). Bounded: at most 8 grants.
    function exitAll(address member) external;
}

/// @notice What the Vester reads of, and tells, the Treasury: the clock and the burn hooks.
interface ITreasuryClock {
    /// @notice Active seconds so far, counting the slice since the last settle (the Vester's vesting clock).
    function activeNow() external view returns (uint256);
    /// @notice When the project was wound down; zero while it is not.
    function windDownAt() external view returns (uint64);
    /// @notice Zero not wound down, 1 wound down by choice, 2 wound down after quiet.
    function windDownKind() external view returns (uint8);
    /// @notice The time unit N in seconds.
    function unit() external view returns (uint32);
    /// @notice Team Shares announced to burn.
    function Z() external view returns (uint256);
    /// @notice The Vester announces `amount` Team Shares to burn: joiners are priced as if they were gone.
    function forfeitAnnounced(uint256 amount) external;
    /// @notice The Vester burns `amount` announced Team Shares it holds.
    function forfeitBurn(uint256 amount) external;
    /// @notice The Vester burns `amount` unannounced Team Shares it holds, after a wind-down.
    function burnAfterWindDown(uint256 amount) external;
}

/// @notice What the Treasury asks of the Launcher: which addresses are Pairs it made.
interface ILauncherPairs {
    /// @notice True for a Pair the Launcher made.
    function isPair(address who) external view returns (bool);
}

/// @notice The two signers of a Pair.
interface IPairSigners {
    /// @notice The first signer (the founder who offered the seat).
    function first() external view returns (address);
    /// @notice The second signer (who accepted).
    function second() external view returns (address);
}

/// @notice What the Treasury reads of a Pair that is the runner.
interface IPair {
    /// @notice True only while a proposal both signers agreed to is executing.
    function bothSigned() external view returns (bool);
}

/// @notice What a Pair asks of the project's Treasury: take the seat, and check in.
interface ITreasuryRunner {
    /// @notice Take the runner seat that was offered to the caller.
    function takeSeat() external;
    /// @notice The weekly check-in with the hash of the signed record.
    function checkIn(bytes32 recordHash) external;
}
