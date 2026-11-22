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

/// @notice What the Treasury asks of the project's holder pause (see HolderPause): one question and one nudge.
interface IHolderPause {
    /// @notice True while `draw` and `announceTask` must refuse.
    function paused() external view returns (bool);
    /// @notice Look at the ratio of parked to all backer Shares and re-arm or disarm. Anyone may call it.
    function poke() external;
}

/// @notice What the Treasury asks of the project's Vester.
interface IVester {
    /// @notice Set aside `amount` Team Shares for `member`; returns the grant's id. Called by the Treasury (an ordinary grant on
    /// a clock of its own) and by the earlier backers' claim contract (a protected grant out of the reserve, whatever the flag
    /// says). A protected grant vests on calendar time over 365 days, with no cliff, and can never be forfeited or burned.
    function grant(address member, uint256 amount, bool protected_) external returns (uint256 id);
    /// @notice Both signers of a Pair runner announce the forfeit of grant `id` (the Treasury has checked them). Only the
    /// Treasury.
    function announceByRunner(uint256 id) external;
    /// @notice A leaving founder's grants are all announced as an own exit (the hand-over trim). Bounded: at most 16 grants.
    function exitAll(address member) external;
}

/// @notice What the Launcher reads of the earlier backers' claim contract, and tells it.
interface IEarlierGrants {
    /// @notice The Launcher this claim contract serves.
    function launcher() external view returns (address);
    /// @notice The key (`Launcher.keyOf(founder, projectId)`) of the one project whose Team pool it funds.
    function key() external view returns (bytes32);
    /// @notice The pool in Team Share wei: the most the rows can claim in all.
    function total() external view returns (uint256);
    /// @notice Tie the claim contract to the project's Vester, once. Only the Launcher, in the launch transaction.
    function bind(address vester) external;
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

/// @notice What the Treasury asks of the Launcher: which addresses are runner contracts it made.
interface ILauncherPairs {
    /// @notice True for a Pair the Launcher made.
    function isPair(address who) external view returns (bool);
    /// @notice What kind of runner contract `who` is: 0 not one the Launcher made, 1 a Pair, 2 a Council. The Treasury asks it
    /// for both runner-seat checks, so a Council is read the same way a Pair is.
    function runnerKindOf(address who) external view returns (uint8);
}

/// @notice The seats of a runner contract that is run by more than one account (a Pair or a Council).
interface IPairSigners {
    /// @notice The first signer (the founder who offered the seat). A Pair only.
    function first() external view returns (address);
    /// @notice The second signer (who accepted). A Pair only.
    function second() external view returns (address);
    /// @notice True when `who` holds a seat of this runner (both signers of a Pair, any of the five seats of a Council). Never
    /// true for the zero address.
    function isSeat(address who) external view returns (bool);
}

/// @notice What the Treasury reads of a Pair that is the runner.
interface IPair {
    /// @notice True only while a proposal both signers agreed to is executing.
    function bothSigned() external view returns (bool);
}

/// @notice What a Pair or a Council asks of the project's Treasury: take the seat, check in, and read the gate.
interface ITreasuryRunner {
    /// @notice The time unit N in seconds (a Pair's proposals live two units).
    function unit() external view returns (uint32);
    /// @notice Take the runner seat that was offered to the caller.
    function takeSeat() external;
    /// @notice The weekly check-in with the hash of the signed record.
    function checkIn(bytes32 recordHash) external;
    /// @notice The project's holder pause (the vote contract when the deployment has one); zero when there is none.
    function pauseGate() external view returns (address);
}

/// @notice What the project's vote contract asks of a Council: which two seats come up and who takes them. Only the vote
/// contract the Council was born with may call either.
interface ICouncilVote {
    /// @notice Open the election that is due: say which two seats come up and move the next date on. Returns the two seat
    /// numbers.
    function openElection() external returns (uint8 upA, uint8 upB);
    /// @notice Put the winners of the ballot for the two seats `upA` and `upB` in place (a zero winner leaves its seat as it was).
    function seat(uint8 upA, uint8 upB, address winnerA, address winnerB) external;
    /// @notice True when `who` holds a seat.
    function isSeat(address who) external view returns (bool);
    /// @notice When two seats next come up for a vote.
    function nextElection() external view returns (uint64);
    /// @notice The project's vote contract; only it may open an election or put winners in seats.
    function vote() external view returns (address);
    /// @notice Seat `i`: who holds it (zero when open), and when it was taken and last came up.
    function seatOf(uint8 i) external view returns (address who, uint64 seatedAt, uint64 lastUp);
}

/// @notice What the project's vote contract asks of its Treasury: where the seat is now, and the numbers a ballot fixes at
/// opening. Nothing here writes a number a ballot did not fix at opening.
interface IVoteTreasury {
    /// @notice The time unit N in seconds.
    function unit() external view returns (uint32);
    /// @notice Who holds the runner seat now.
    function runner() external view returns (address);
    /// @notice The project's pause (this vote contract); zero when the project has none.
    function pauseGate() external view returns (address);
    /// @notice 0 while the project runs; 1 for a wind-down by choice, 2 for one by a quiet project. A ballot of a wound-down
    /// project cannot be carried out (`lapse` says so).
    function windDownKind() external view returns (uint8);
    /// @notice The notice a task of `shareBps` gets: its first value is the warning a won vote waits (the longest, 500).
    function noticeFor(uint16 shareBps)
        external
        view
        returns (uint256 noticeSecs, uint256 takeWindowSecs, uint256 dueSecs);
    /// @notice Move the runner seat to `council`, a Council the Launcher made for this project's winning list.
    function seatByVote(address council) external;
}

/// @notice What the project's vote contract asks of the Launcher: make the Council a won replace vote chose.
interface IVoteLauncher {
    /// @notice Make the Council of `members` that won ballot `ballotId` of project `key`; only the project's vote contract.
    function councilByVote(bytes32 key, address[5] calldata members, uint256 ballotId)
        external
        returns (address council);
    /// @notice True when `who` is one of the project's own contracts: such an account can never hold a seat.
    function isProjectAccount(bytes32 key, address who) external view returns (bool);
    /// @notice What kind of runner contract `who` is: 0 none, 1 a Pair, 2 a Council.
    function runnerKindOf(address who) external view returns (uint8);
}

/// @notice What the Launcher, the Council and the app ask of a project's pause: whether it is also a vote contract, and which
/// project it was bound to.
interface IHolderVote {
    /// @notice True for the vote contract (a `HolderVote`), false for a plain pause.
    function isVote() external view returns (bool);
    /// @notice Bind the clone to its project; the Launcher, once, in the launch transaction.
    function bindProject(ITreasuryRunner treasury_, bytes32 key_) external;
    /// @notice The project's Treasury.
    function treasury() external view returns (IVoteTreasury);
    /// @notice The project's key.
    function key() external view returns (bytes32);
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
    /// @notice A leaver's exit note: spread `note` dollars over the taken tasks, each part in proportion to the task's stayers'
    /// claim (`stay` is the Treasury's own sum of those claims; the book checks it). Returns what was minted (the parts are
    /// rounded down, so a few units stay with the stayers).
    function mintNotes(address holder, uint256 note, uint256 stay) external returns (uint256 minted);
    /// @notice Settle `holder`'s note against task `serial`, which must have ended with money returned. Returns what is paid to
    /// the holder and, when this was the last note against the task, the rounding left over (it goes to the pot).
    function claim(uint64 serial, address holder) external returns (uint256 paid, uint256 dust);
    /// @notice What a leave of `note` dollars would mint right now: the sum of the parts over the tasks that are still running
    /// (a task whose time is up this second is skipped, as the leave's own settle would have returned it first).
    function spreadSum(uint256 note, uint256 stay) external view returns (uint256 minted);
    /// @notice What a claim of `holder`'s note against `serial` would pay now; zero while the task is open, when the task was
    /// paid in full, or when there is no note.
    function claimableNote(uint64 serial, address holder) external view returns (uint256);
    /// @notice Reverts unless task `serial` has ended without being paid in full (its money is back).
    function requireReturned(uint64 serial) external view;
    /// @notice The stayers' claim that comes back to the pot if the book is settled at time `when`.
    function dueC(uint256 when) external view returns (uint256 sumC);
    /// @notice The notice, the take window and the time a taken task is due, for a task of `shareBps`.
    function noticeFor(uint16 shareBps)
        external
        view
        returns (uint256 noticeSecs, uint256 takeWindowSecs, uint256 dueSecs);
}
