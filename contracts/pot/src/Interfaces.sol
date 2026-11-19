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
    /// @notice The time unit N in seconds (a Pair's proposals live two units).
    function unit() external view returns (uint32);
    /// @notice Take the runner seat that was offered to the caller.
    function takeSeat() external;
    /// @notice The weekly check-in with the hash of the signed record.
    function checkIn(bytes32 recordHash) external;
}

/// @notice What the Treasury asks of the project's TaskBook (the task queue). Every call that changes the book comes from the
/// Treasury alone, which has settled, checked the seat and moved the dollars; the book keeps the rules of the queue.
interface ITaskBook {
    /// @notice What a task's end leaves for the Treasury to book, in dollar units.
    /// @dev `to` is the taker (`takenBy`), `pay` what goes to it. `c` was the stayers' claim and `n` the note face the task
    /// held; `np` of the returned money is now owed to notes (still held, as `notesOwed`) and `pp` goes back to the pot.
    /// `next` is the earliest end of any task still open, zero when none.
    struct Resolved {
        address to;
        uint256 pay;
        uint256 c;
        uint256 n;
        uint256 np;
        uint256 pp;
        uint64 next;
    }

    /// @notice The Treasury the book serves.
    function treasury() external view returns (address);
    /// @notice The time unit N the book was set up with (the Treasury's own).
    function unit() external view returns (uint32);
    /// @notice Set up the clone, once. `treasury_` is the only caller of every other state-changing function.
    function initialize(address treasury_, uint32 unit_) external;
    /// @notice A new task is announced. The Treasury has checked who may announce and who may be the payee.
    function announce(bytes32 what, address payee, uint256 maxDollars, uint16 shareBps)
        external
        returns (uint64 serial, uint64 next);
    /// @notice `who` takes task `serial` against the settled pot `pot`; returns the dollars to set aside.
    function take(uint64 serial, address who, uint256 pot, uint256 minAmount)
        external
        returns (uint256 amount, uint64 next);
    /// @notice Pay `pay` of the taken task's money to its taker; the rest comes back.
    function accept(uint64 serial, uint256 pay) external returns (Resolved memory r);
    /// @notice Send a taken task's money back at once.
    function reject(uint64 serial) external returns (Resolved memory r);
    /// @notice Withdraw a task nobody has taken.
    function cancel(uint64 serial) external returns (uint64 next);
    /// @notice End every task whose time is up: taken ones return their money, announced ones lapse.
    function expireDue() external returns (uint256 sumC, uint64 next);
    /// @notice End every open task now (a wind-down): announced ones are cancelled, taken ones return their money.
    function sweepAll() external returns (uint256 sumC);
    /// @notice Reverts unless task `serial` has ended without being paid in full (its money is back).
    function requireReturned(uint64 serial) external view;
    /// @notice The stayers' claim that comes back to the pot if the book is settled at time `at`.
    function dueC(uint256 when) external view returns (uint256 sumC);
    /// @notice The notice, the take window and the time a taken task is due, for a task of `shareBps`.
    function noticeFor(uint16 shareBps)
        external
        view
        returns (uint256 noticeSecs, uint256 takeWindowSecs, uint256 dueSecs);
}
