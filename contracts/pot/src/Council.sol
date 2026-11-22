// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ITreasuryRunner} from "./Interfaces.sol";
import {Treasury} from "./Treasury.sol";

/// @notice The one Launcher call a Council may make: wind the project down by choice.
interface ILauncherWindDown {
    /// @notice Wind the project down, for good; only its runner.
    function windDown(bytes32 key) external;
}

/// @title Council
/// @notice The runner of a project that has grown past one or two people: five seats, three of five needed for every
/// action. It holds the Treasury's runner seat the way a Pair does, and has NO power a runner does not already have: every
/// limit of the Treasury (the allowance ceiling and box, the task caps and notice, the check-in window, the pause) binds it
/// unchanged. It holds no dollars, has no owner, no upgrade, no payable function and no way to move a token or an approval.
/// A seat is an account. An action is proposed by one seat (which counts as its agreement), sent the moment a third seat
/// agrees, can be taken back by an agreeing seat before that, and runs out two time units after it was proposed. Seats
/// cannot be sold or lent: there is no transfer of a seat, only `resign`, an election (`seat`, by the project's vote contract)
/// or a whole hand-on of the runner seat.
/// @dev A clone per project, made by the Launcher (`makeCouncil` for a hand-over, `councilByVote` for a holder vote). Calls
/// go only to the project's Treasury or the Launcher, and only a call on a short list (`listed`): `announceForfeit` and the
/// hand-over that trims the founder are Pair-only powers and are not on it. `bothSigned()` is true only while a proposal
/// three seats agreed to executes, which is what the Treasury reads on every runner-only call. Whenever a seat changes,
/// `generation` goes up and every older proposal is dead.
contract Council {
    /// @notice A proposal: when it was made, the generation it was made in, and which seats agreed (one bit per seat).
    struct Proposal {
        uint48 at;
        uint32 generation;
        uint8 mask;
    }

    /// @notice One seat: who holds it (zero when open), since when, and when it last came up for a vote or changed.
    struct Seat {
        address who;
        uint48 seatedAt;
        uint48 lastUp;
    }

    /// @notice The number of seats.
    uint8 public constant SEATS = 5;
    /// @notice How many seats must agree to an action.
    uint8 public constant THRESHOLD = 3;
    /// @notice A proposal lives this many time units of the project.
    uint256 public constant PROPOSAL_UNITS = 2;
    /// @notice Two seats come up for a vote every this many time units.
    uint256 public constant ELECTION_UNITS = 26;
    uint8 private constant NONE = type(uint8).max;

    /// @notice The project's Treasury.
    ITreasuryRunner public treasury;
    /// @notice The Launcher (wind down).
    address public launcher;
    /// @notice The project's vote contract (its `pauseGate` at birth); zero when the project has none. Only it may open an
    /// election or put winners in seats.
    address public vote;
    /// @notice Goes up whenever any seat changes; a proposal made in an older generation can never run.
    uint32 public generation;
    /// @notice The project's time unit in seconds.
    uint32 public unit;
    /// @notice When two seats may next come up for a vote.
    uint64 public nextElection;
    /// @notice A proposal can be agreed to for this long, then it is dead: old consent is not consent. Two time units.
    uint256 public PROPOSAL_TTL;
    /// @notice Calls proposed so far; makes each proposal's id different.
    uint256 public nonce;
    /// @notice The pending proposals (keyed by `callId`); a proposal with no agreement left is deleted.
    mapping(bytes32 => Proposal) public proposals;

    Seat[5] private _seats;
    bool private transient _executing;

    /// @notice A seat proposed a call; it counts as that seat's agreement. The same signature as a Pair's, so one decoder reads
    /// both.
    event Proposed(bytes32 indexed id, address indexed by, address target, bytes data, uint256 nonce);
    /// @notice A seat agreed to a pending call; `count` is how many seats have agreed after it.
    event Agreed(bytes32 indexed id, address indexed by, uint8 count);
    /// @notice A seat took its agreement back before the call ran; `count` is how many are left (zero with `Cancelled`).
    event Withdrawn(bytes32 indexed id, address indexed by, uint8 count);
    /// @notice The third agreement came and the call ran.
    event Executed(bytes32 indexed id, address indexed by);
    /// @notice The last agreement was taken back and the proposal is gone.
    event Cancelled(bytes32 indexed id);
    /// @notice The whole picture of the seats, at birth and after every change (and when an election is opened, which moves
    /// `nextElection`), so a reader never rebuilds the seats from deltas. An open seat is the zero address with time zero.
    event SeatsSet(address[5] seats, uint64[5] seatedAt, uint32 generation, uint64 nextElection);
    /// @notice The holder of seat `seat` gave it up.
    event Resigned(uint8 seat, address indexed who);

    /// @notice Set up twice, on the implementation, by anyone but the Launcher, or with a missing or repeated seat.
    error BadSetup();
    /// @notice The caller is not a seat (or not the vote contract), or has not agreed to what it takes back.
    error NotAllowed();
    /// @notice Calls may go only to the project's Treasury or the Launcher.
    error BadTarget();
    /// @notice The call, or one of its arguments, is not on the list a Council may make.
    error BadCall();
    /// @notice No such pending call (it may have run already).
    error UnknownCall();
    /// @notice This seat has already agreed to this call.
    error AlreadyAgreed();
    /// @notice The call was proposed more than `PROPOSAL_TTL` ago; propose it again.
    error Expired();
    /// @notice A seat changed since the call was proposed; propose it again.
    error SeatsChanged();
    /// @notice A call is already executing.
    error Reentrancy();
    /// @notice No election is due yet.
    error NotDue(uint64 at);
    /// @notice The two seats, or a winner, are not usable (the same seat twice, a seat past five, a winner twice).
    error BadSeat();
    /// @notice A winner already holds a seat that is not up.
    error AlreadySeated(address who);

    modifier onlyVote() {
        if (msg.sender != vote || msg.sender == address(0)) revert NotAllowed();
        _;
    }

    constructor() {
        launcher = address(1); // locks the implementation
    }

    /// @notice Set up the clone. Only the Launcher, in the transaction that creates it, so nobody can reach a clone before it
    /// is set up. All five seats are seated now. With `takeSeat_` it also takes the runner seat the founder offered to its
    /// address (the hand-over path, as a Pair does); without it, the project's vote contract seats it by `Treasury.seatByVote`.
    /// @param treasury_ The project's Treasury.
    /// @param launcher_ The Launcher (the caller).
    /// @param members The five seat holders: five distinct non-zero accounts.
    /// @param takeSeat_ True to take the offered runner seat now.
    function initialize(ITreasuryRunner treasury_, address launcher_, address[5] calldata members, bool takeSeat_)
        external
    {
        if (launcher != address(0) || msg.sender != launcher_) revert BadSetup();
        for (uint256 i; i < SEATS; ++i) {
            if (members[i] == address(0)) revert BadSetup();
            for (uint256 j = i + 1; j < SEATS; ++j) {
                if (members[i] == members[j]) revert BadSetup();
            }
        }
        (treasury, launcher) = (treasury_, launcher_);
        uint32 u = treasury_.unit();
        unit = u;
        vote = treasury_.pauseGate();
        PROPOSAL_TTL = PROPOSAL_UNITS * uint256(u);
        uint48 nowAt = uint48(block.timestamp);
        for (uint256 i; i < SEATS; ++i) {
            _seats[i] = Seat(members[i], nowAt, nowAt);
        }
        nextElection = uint64(block.timestamp + ELECTION_UNITS * uint256(u));
        _emitSeats();
        if (takeSeat_) treasury_.takeSeat();
    }

    // ================================================ proposals ======================================================

    /// @notice Propose a call to the Treasury or the Launcher. It counts as your agreement and runs when a third seat agrees.
    /// @param target The project's Treasury or the Launcher.
    /// @param data The call; it must be on the list (`listed`).
    /// @return id The proposal's id (`callId(target, data, nonce)`).
    function propose(address target, bytes calldata data) external returns (bytes32 id) {
        uint8 i = _indexOf(msg.sender);
        if (i == NONE) revert NotAllowed();
        if (target != address(treasury) && target != launcher) revert BadTarget();
        if (!listed(target, data)) revert BadCall();
        uint256 n = nonce++;
        id = callId(target, data, n);
        proposals[id] = Proposal(uint48(block.timestamp), generation, uint8(1 << i));
        emit Proposed(id, msg.sender, target, data, n);
    }

    /// @notice Agree to a pending call. The call must be exactly the one proposed (the id commits to the Council, the target,
    /// the bytes and the proposal's number). When the third seat agrees the record is deleted first, then the call runs once.
    /// A call that fails reverts everything, with its own error, and the proposal stays pending.
    /// @param target The call's target.
    /// @param data The call.
    /// @param n The proposal's number (from `Proposed`).
    /// @return result What the call returned (empty when this agreement did not run it).
    function agree(address target, bytes calldata data, uint256 n) external returns (bytes memory result) {
        if (_executing) revert Reentrancy();
        uint8 i = _indexOf(msg.sender);
        if (i == NONE) revert NotAllowed();
        bytes32 id = callId(target, data, n);
        Proposal memory p = proposals[id];
        if (p.mask == 0) revert UnknownCall();
        if (p.generation != generation) revert SeatsChanged();
        if (block.timestamp > uint256(p.at) + PROPOSAL_TTL) revert Expired();
        uint8 bit = uint8(1 << i);
        if (p.mask & bit != 0) revert AlreadyAgreed();
        p.mask |= bit;
        uint8 count = _count(p.mask);
        emit Agreed(id, msg.sender, count);
        if (count < THRESHOLD) {
            proposals[id] = p;
            return result;
        }
        delete proposals[id];
        _executing = true;
        bool ok;
        (ok, result) = target.call(data);
        _executing = false;
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(result, 0x20), mload(result))
            }
        }
        emit Executed(id, msg.sender);
    }

    /// @notice Take your agreement back before the call has run. A proposal with no agreement left is deleted.
    /// @param id The proposal's id.
    function withdraw(bytes32 id) external {
        uint8 i = _indexOf(msg.sender);
        if (i == NONE) revert NotAllowed();
        Proposal memory p = proposals[id];
        if (p.mask == 0) revert UnknownCall();
        if (p.generation != generation) revert SeatsChanged();
        uint8 bit = uint8(1 << i);
        if (p.mask & bit == 0) revert NotAllowed();
        p.mask &= ~bit;
        emit Withdrawn(id, msg.sender, _count(p.mask));
        if (p.mask == 0) {
            delete proposals[id];
            emit Cancelled(id);
        } else {
            proposals[id] = p;
        }
    }

    /// @notice Give up your own seat. It becomes open (it comes up first at the next election) and every pending proposal is
    /// dead.
    function resign() external {
        uint8 i = _indexOf(msg.sender);
        if (i == NONE) revert NotAllowed();
        _seats[i] = Seat(address(0), 0, 0);
        ++generation;
        emit Resigned(i, msg.sender);
        _emitSeats();
    }

    // ================================================ elections ======================================================

    /// @notice Open the election that is due: say which two seats come up (the two that have gone longest without coming up,
    /// open seats first, ties to the lower number), move their time to now and the next election 26 time units on. Only the
    /// project's vote contract.
    /// @return upA The seat that has gone longest.
    /// @return upB The next one.
    function openElection() external onlyVote returns (uint8 upA, uint8 upB) {
        if (block.timestamp < nextElection) revert NotDue(nextElection);
        (upA, upB) = _up();
        uint48 nowAt = uint48(block.timestamp);
        _seats[upA].lastUp = nowAt;
        _seats[upB].lastUp = nowAt;
        nextElection = uint64(block.timestamp + ELECTION_UNITS * uint256(unit));
        _emitSeats();
    }

    /// @notice Put the winners of a ballot for the two seats `upA` and `upB` in place. A winner who now holds one of the two
    /// seats stays in it; any other winner takes a seat of the two nobody has just kept, the lower-numbered first; a seat with
    /// no winner keeps its holder. A zero winner is no winner. Only the project's vote contract.
    /// @param upA One of the two seats that came up.
    /// @param upB The other.
    /// @param winnerA The first winner, or zero.
    /// @param winnerB The second winner, or zero.
    function seat(uint8 upA, uint8 upB, address winnerA, address winnerB) external onlyVote {
        if (upA >= SEATS || upB >= SEATS || upA == upB) revert BadSeat();
        if (winnerA != address(0) && winnerA == winnerB) revert BadSeat();
        (uint8 lo, uint8 hi) = upA < upB ? (upA, upB) : (upB, upA);
        address[2] memory w = [winnerA, winnerB];
        bool[2] memory placed;
        bool loTaken;
        bool hiTaken;
        for (uint256 k; k < 2; ++k) {
            if (w[k] == address(0)) continue;
            uint8 at = _indexOf(w[k]);
            if (at == lo) {
                (loTaken, placed[k]) = (true, true);
            } else if (at == hi) {
                (hiTaken, placed[k]) = (true, true);
            } else if (at != NONE) {
                revert AlreadySeated(w[k]);
            }
        }
        bool changed;
        for (uint256 k; k < 2; ++k) {
            if (w[k] == address(0) || placed[k]) continue;
            uint8 s;
            if (!loTaken) {
                (s, loTaken) = (lo, true);
            } else {
                (s, hiTaken) = (hi, true);
            }
            _seats[s] = Seat(w[k], uint48(block.timestamp), uint48(block.timestamp));
            changed = true;
        }
        if (changed) {
            ++generation;
            _emitSeats();
        }
    }

    // ================================================ views ==========================================================

    /// @notice True only while a proposal three seats agreed to is executing.
    function bothSigned() external view returns (bool) {
        return _executing;
    }

    /// @notice True when `a` holds a seat. Never true for the zero address (an open seat is stored as zero).
    function isSeat(address a) external view returns (bool) {
        return _indexOf(a) != NONE;
    }

    /// @notice Seat `i` (0 to 4): who holds it (zero when open), since when, and when it last came up or changed.
    function seatOf(uint8 i) external view returns (address who, uint64 seatedAt, uint64 lastUp) {
        Seat memory s = _seats[i];
        return (s.who, s.seatedAt, s.lastUp);
    }

    /// @notice The five seats and when each was taken (zero for an open seat).
    function seatList() external view returns (address[5] memory seats, uint64[5] memory seatedAt) {
        for (uint256 i; i < SEATS; ++i) {
            (seats[i], seatedAt[i]) = (_seats[i].who, _seats[i].seatedAt);
        }
    }

    /// @notice The two seats that would come up at the next election, the one that has gone longest first.
    function upNext() external view returns (uint8, uint8) {
        return _up();
    }

    /// @notice How many seats have agreed to pending call `id` (zero when there is none).
    function agreedCount(bytes32 id) external view returns (uint8) {
        return _count(proposals[id].mask);
    }

    /// @notice True when a call is on the list a Council may make: the Treasury's runner calls (`draw`, `checkIn`,
    /// `proposeRate`, `setRate`, `setDoor`, `announceTask`, `acceptTask`, `rejectTask`, `cancelTask`, `grantTeam`, `setAgent`,
    /// `authoriseAgent`, `revokeAgent`, `handOver` without the founder leaving, `windDown`) and the Launcher's `windDown`.
    /// `announceForfeit` and a hand-over that trims the founder are Pair-only and are not on it.
    function listed(address target, bytes calldata data) public view returns (bool) {
        if (data.length < 4) return false;
        bytes4 sel = bytes4(data);
        if (target == address(treasury)) {
            if (sel == Treasury.handOver.selector) return data.length == 68 && uint256(bytes32(data[36:68])) == 0;
            return sel == Treasury.draw.selector || sel == Treasury.checkIn.selector
                || sel == Treasury.proposeRate.selector || sel == Treasury.setRate.selector
                || sel == Treasury.setDoor.selector || sel == Treasury.announceTask.selector
                || sel == Treasury.acceptTask.selector || sel == Treasury.rejectTask.selector
                || sel == Treasury.cancelTask.selector || sel == Treasury.grantTeam.selector
                || sel == Treasury.setAgent.selector || sel == Treasury.authoriseAgent.selector
                || sel == Treasury.revokeAgent.selector || sel == Treasury.windDown.selector;
        }
        return target == launcher && sel == ILauncherWindDown.windDown.selector;
    }

    /// @notice The id of a proposal.
    function callId(address target, bytes calldata data, uint256 n) public view returns (bytes32) {
        return keccak256(abi.encode(address(this), target, data, n));
    }

    // ================================================ plumbing =======================================================

    /// @dev The seat number of `a`, or `NONE`. The zero address is never a seat.
    function _indexOf(address a) private view returns (uint8) {
        if (a == address(0)) return NONE;
        for (uint8 i; i < SEATS; ++i) {
            if (_seats[i].who == a) return i;
        }
        return NONE;
    }

    /// @dev The two seats that have gone longest without coming up (open seats first); strict comparison keeps the lower number on
    /// a tie.
    function _up() private view returns (uint8 a, uint8 b) {
        uint48 la = type(uint48).max;
        uint48 lb = type(uint48).max;
        for (uint8 i; i < SEATS; ++i) {
            // an open seat counts as time zero, so it comes up at every election until someone is elected to it
            uint48 l = _seats[i].who == address(0) ? 0 : _seats[i].lastUp;
            if (l < la) {
                (b, lb) = (a, la);
                (a, la) = (i, l);
            } else if (l < lb) {
                (b, lb) = (i, l);
            }
        }
    }

    function _count(uint8 mask) private pure returns (uint8 c) {
        for (; mask != 0; mask &= mask - 1) {
            ++c;
        }
    }

    function _emitSeats() private {
        address[5] memory seats;
        uint64[5] memory at;
        for (uint256 i; i < SEATS; ++i) {
            (seats[i], at[i]) = (_seats[i].who, _seats[i].seatedAt);
        }
        emit SeatsSet(seats, at, generation, nextElection);
    }
}
