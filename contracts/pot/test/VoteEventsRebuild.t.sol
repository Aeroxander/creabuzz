// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {VoteBase} from "./helpers/VoteBase.sol";
import {VoteHandler} from "./helpers/VoteHandler.sol";
import {Council} from "../src/Council.sol";
import {HolderVote} from "../src/HolderVote.sol";
import {Launcher} from "../src/Launcher.sol";

/// @notice A ledger that sees only the vote contract's events — `BallotOpened`, `Stood`, `Voted` (with `optionTally`, and for a
/// move `fromOption`/`fromTally`), `Fell`, `BallotFinished`, `BallotCarriedOut`, `BallotLapsed` — plus the Launcher's
/// `CouncilMade` and a Council's `SeatsSet`, and never a view of its own. Over 400 random steps driven by `VoteHandler` (moves
/// among them), after every step it must hold the same tallies, the same options, the same phase (stand window, vote, ended,
/// waiting for the effective date, carried out, lapsed) and the same runner and Council seats as the contract's own views.
///
/// The ledger's starting point is the state at the moment recording begins: the founder runs the project and no ballot exists.
/// A hand-over before the window has no vote event, so the fuzz driver never hands the seat over; the replay tests reach a
/// Council through a carried-out vote, which the ledger does rebuild.
contract VoteEventsRebuildTest is VoteBase {
    VoteHandler internal h;
    address[] internal who;
    address internal eve = makeAddr("eve");
    address internal frank = makeAddr("frank");

    // ---------------------------------------------------------------- the ledger

    /// @dev One ballot as the events describe it.
    struct L {
        bool seen;
        uint8 kind;
        uint64 openedAt;
        uint64 standEnd;
        uint64 voteEnd;
        uint64 effectiveAt;
        uint256 supply;
        uint256 floor;
        uint8 upA;
        uint8 upB;
        uint8 optionCount;
        uint256 cast;
        uint8 outcome;
        uint8 winner;
        uint8 winnerB;
        bool finished;
        bool carried;
        bool lapsed;
        address council; // a replace vote's winning Council (from BallotCarriedOut); zero otherwise
    }

    mapping(uint32 => L) internal l;
    mapping(uint32 => mapping(uint8 => uint256)) internal lTally;
    mapping(uint32 => mapping(uint8 => address[5])) internal lMembers;
    mapping(uint32 => mapping(uint8 => address)) internal lProposer;
    mapping(uint32 => mapping(uint8 => uint8)) internal lOptionKind;
    uint32 internal lCurrent;
    address internal lRunner;
    mapping(address => address[5]) internal lSeats;
    mapping(address => uint32) internal lGeneration;
    mapping(address => uint64) internal lNextElection;
    mapping(address => bool) internal lMade;
    mapping(address => bool) internal lMadeByVote;

    // ------------------------------------------------------------------- setup

    function setUp() public override {
        super.setUp();
        _join(eve, 300_000e6);
        _join(frank, 200_000e6);
        who = new address[](7);
        who[0] = alice;
        who[1] = bob;
        who[2] = carol;
        who[3] = dave;
        who[4] = stranger;
        who[5] = eve;
        who[6] = frank;
        address[5] memory st = [s1, s2, s3, s4, s5];
        h = new VoteHandler(usd, t, shares, vote, launcher, key, founder, who, st);
    }

    /// @dev The ledger's starting point: no ballot yet, the founder runs the project.
    function _initLedger() internal {
        lCurrent = 0;
        lRunner = t.runner();
    }

    // -------------------------------------------------------------- the events

    function _feed(Vm.Log[] memory logs) internal {
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory log = logs[i];
            if (log.emitter == address(vote)) {
                _feedVote(log);
            } else if (log.emitter == address(launcher)) {
                if (log.topics[0] == Launcher.CouncilMade.selector) {
                    address c = address(uint160(uint256(log.topics[2])));
                    bool byVote = abi.decode(log.data, (bool));
                    lMade[c] = true;
                    if (byVote) lMadeByVote[c] = true;
                }
            } else if (log.topics[0] == Council.SeatsSet.selector) {
                (address[5] memory seats, uint64[5] memory at, uint32 generation, uint64 nextElection) =
                    abi.decode(log.data, (address[5], uint64[5], uint32, uint64));
                lSeats[log.emitter] = seats;
                lGeneration[log.emitter] = generation;
                lNextElection[log.emitter] = nextElection;
                at; // the dates are in the log but no view of the contract's is compared here
            }
        }
    }

    function _feedVote(Vm.Log memory log) internal {
        bytes32 sig = log.topics[0];
        if (sig == HolderVote.BallotOpened.selector) {
            uint32 id = uint32(uint256(log.topics[1]));
            (
                uint8 kind,
                uint64 openedAt,
                uint64 standEnd,
                uint64 voteEnd,
                uint64 effectiveAt,
                uint256 supply,
                uint256 floor,
                uint8 upA,
                uint8 upB,
            ) = abi.decode(log.data, (uint8, uint64, uint64, uint64, uint64, uint256, uint256, uint8, uint8, address));
            L storage e = l[id];
            e.seen = true;
            e.kind = kind;
            e.openedAt = openedAt;
            e.standEnd = standEnd;
            e.voteEnd = voteEnd;
            e.effectiveAt = effectiveAt;
            e.supply = supply;
            e.floor = floor;
            e.upA = upA;
            e.upB = upB;
            e.optionCount = 1; // "keep" is always option 0
            lCurrent = id;
        } else if (sig == HolderVote.Stood.selector) {
            uint32 id = uint32(uint256(log.topics[1]));
            address by = address(uint160(uint256(log.topics[2])));
            (uint8 option, address[5] memory members, uint8 count,, address displaced) =
                abi.decode(log.data, (uint8, address[5], uint8, bytes32, address));
            // a place taken from a smaller stake keeps that option's number: the entry is replaced in place
            if (displaced != address(0)) {
                require(lProposer[id][option] == displaced, "a displacement that does not match the option it names");
            }
            lMembers[id][option] = members;
            lProposer[id][option] = by;
            lOptionKind[id][option] = count == 1 ? 2 : 1; // a person, or a list of five
            if (option + 1 > l[id].optionCount) l[id].optionCount = option + 1;
        } else if (sig == HolderVote.Voted.selector) {
            uint32 id = uint32(uint256(log.topics[1]));
            (
                uint8 option,
                uint256 weight,
                uint256 optionTally,
                uint256 castTotal,
                uint8 fromOption,
                uint256 fromTally
            ) = abi.decode(log.data, (uint8, uint256, uint256, uint256, uint8, uint256));
            weight; // the voter's whole weight: the absolute numbers below are what a reader needs
            // a move first empties the option it left (the old tally is given, so no per-voter state is needed) ...
            if (fromOption != 255) lTally[id][fromOption] = fromTally;
            // ... and then the new option's tally is the absolute one the event names
            lTally[id][option] = optionTally;
            l[id].cast = castTotal;
        } else if (sig == HolderVote.Fell.selector) {
            uint32 id = uint32(uint256(log.topics[1]));
            (uint8 option,, uint256 optionTally, uint256 castTotal) =
                abi.decode(log.data, (uint8, uint256, uint256, uint256));
            lTally[id][option] = optionTally;
            l[id].cast = castTotal;
        } else if (sig == HolderVote.BallotFinished.selector) {
            uint32 id = uint32(uint256(log.topics[1]));
            (uint8 outcome, uint8 winner, uint8 winnerB,) = abi.decode(log.data, (uint8, uint8, uint8, uint256));
            L storage e = l[id];
            e.outcome = outcome;
            e.winner = winner;
            e.winnerB = winnerB;
            e.finished = true;
        } else if (sig == HolderVote.BallotCarriedOut.selector) {
            uint32 id = uint32(uint256(log.topics[1]));
            address council = abi.decode(log.data, (address));
            l[id].carried = true;
            l[id].council = council;
            if (council != address(0)) lRunner = council; // a replace vote moved the runner seat
        } else if (sig == HolderVote.BallotLapsed.selector) {
            uint32 id = uint32(uint256(log.topics[1]));
            l[id].lapsed = true;
        }
    }

    // ---------------------------------------------------------------- the phase

    /// @dev The phase the contract's own numbers and clock give.
    function _phaseView(HolderVote.Ballot memory b) internal view returns (uint8) {
        if (b.openedAt == 0) return 0;
        uint256 nowT = block.timestamp;
        if (nowT < b.standEnd) return 1; // names may still be put forward
        if (nowT < b.voteEnd) return 2; // voting
        if (!b.finished) return 3; // ended, the result not recorded yet
        if (b.carried) return 6;
        if (b.lapsed) return 7;
        if (b.outcome == vote.OUTCOME_MOVED() || b.outcome == vote.OUTCOME_SEATED()) {
            return nowT < b.effectiveAt ? 4 : 5; // the wait, then the date it may be carried out
        }
        return 8; // nothing to carry out
    }

    /// @dev The phase the events and the clock give.
    function _phaseLedger(uint32 id) internal view returns (uint8) {
        L storage e = l[id];
        if (!e.seen) return 0;
        uint256 nowT = block.timestamp;
        if (nowT < e.standEnd) return 1;
        if (nowT < e.voteEnd) return 2;
        if (!e.finished) return 3;
        if (e.carried) return 6;
        if (e.lapsed) return 7;
        if (e.outcome == 3 || e.outcome == 4) return nowT < e.effectiveAt ? 4 : 5;
        return 8;
    }

    // ------------------------------------------------------------- the compare

    /// @dev Every field of one ballot, its options, its tallies and its phase: what the events say against what the contract
    /// says.
    function _compareBallot(uint32 id, uint256 step) internal view {
        L storage e = l[id];
        assertTrue(
            e.seen, string.concat("the ledger never saw ballot ", vm.toString(id), " at step ", vm.toString(step))
        );
        HolderVote.Ballot memory b = vote.ballot(id);
        assertEq(uint256(b.kind), uint256(e.kind), "kind");
        assertEq(uint256(b.openedAt), uint256(e.openedAt), "openedAt");
        assertEq(uint256(b.standEnd), uint256(e.standEnd), "standEnd");
        assertEq(uint256(b.voteEnd), uint256(e.voteEnd), "voteEnd");
        assertEq(uint256(b.effectiveAt), uint256(e.effectiveAt), "effectiveAt");
        assertEq(b.supply, e.supply, "supply");
        assertEq(b.floor, e.floor, "floor");
        assertEq(uint256(b.upA), uint256(e.upA), "upA");
        assertEq(uint256(b.upB), uint256(e.upB), "upB");
        assertEq(uint256(b.optionCount), uint256(e.optionCount), "optionCount");
        assertEq(uint256(b.outcome), uint256(e.outcome), string.concat("outcome at step ", vm.toString(step)));
        assertEq(uint256(b.winner), uint256(e.winner), "winner");
        assertEq(uint256(b.winnerB), uint256(e.winnerB), "winnerB");
        assertEq(b.finished, e.finished, string.concat("finished at step ", vm.toString(step)));
        assertEq(b.carried, e.carried, "carried");
        assertEq(b.lapsed, e.lapsed, "lapsed");
        assertEq(vote.castOf(id), e.cast, "cast total");
        for (uint8 i; i < b.optionCount; ++i) {
            (HolderVote.Option memory o, uint256 tally) = vote.optionOf(id, i);
            assertEq(tally, lTally[id][i], string.concat("tally of option ", vm.toString(i)));
            assertEq(o.proposer, lProposer[id][i], string.concat("proposer of option ", vm.toString(i)));
            assertEq(uint256(o.kind), uint256(lOptionKind[id][i]), string.concat("kind of option ", vm.toString(i)));
            for (uint256 k; k < 5; ++k) {
                assertEq(o.members[k], lMembers[id][i][k], "a member of an option");
            }
        }
        assertEq(uint256(_phaseView(b)), uint256(_phaseLedger(id)), "phase");
        if (e.carried && e.council != address(0)) {
            assertTrue(lMade[e.council], "a carried-out vote made a Council the Launcher never said it made");
            assertTrue(lMadeByVote[e.council], "the carried-out Council was not made by the vote");
        }
    }

    /// @dev The current ballot, the runner, and the runner Council's seats, generation and rotation.
    function _compareStep(uint256 step) internal view {
        uint32 cur = vote.current();
        assertEq(uint256(cur), uint256(lCurrent), "the current ballot");
        if (cur != 0) _compareBallot(cur, step);
        assertEq(t.runner(), lRunner, "the runner");
        address r = t.runner();
        if (launcher.runnerKindOf(r) == 2) {
            (address[5] memory seats,) = Council(r).seatList();
            for (uint256 i; i < 5; ++i) {
                assertEq(seats[i], lSeats[r][i], "a seat of the runner Council");
            }
            assertEq(uint256(Council(r).generation()), uint256(lGeneration[r]), "the Council's generation");
            assertEq(uint256(Council(r).nextElection()), uint256(lNextElection[r]), "the Council's next election");
        }
    }

    /// @dev Every ballot ever opened, once the run is over.
    function _compareAll(uint256 step) internal view {
        uint32 n = vote.nextBallot();
        for (uint32 id = 1; id <= n; ++id) {
            if (!l[id].seen) continue;
            _compareBallot(id, step);
        }
    }

    // --------------------------------------------------------------- the tests

    /// @dev 400 steps of the handler's own mixed sequence (`step`): no hand-over (its runner move has no vote event, so a
    /// ledger of these events cannot be asked to rebuild it) and no storage-access probe (it would disturb the log
    /// recording). Every step's logs go through the ledger, and after every step the ledger is compared with the views.
    /// forge-config: default.fuzz.runs = 150
    function testFuzz_aLedgerOfTheEventsRebuildsTheTalliesThePhasesAndTheSeats(uint256 seed) public {
        _initLedger();
        uint256 x = uint256(keccak256(abi.encode(seed)));
        for (uint256 step; step < 400; ++step) {
            x = uint256(keccak256(abi.encode(x, step)));
            vm.recordLogs();
            h.step(x);
            _feed(vm.getRecordedLogs());
            _compareStep(step);
        }
        _compareAll(400);
        assertEq(bytes(h.violation()).length, 0, h.violation());
    }

    // ------------------------------------------------------------- the replays

    /// @dev Every holder parks every Share it has: enough for the open floor and the turnout floor.
    function _parkAll() internal {
        for (uint256 i; i < who.length; ++i) {
            _park(who[i], shares.balanceOf(who[i]));
        }
    }

    /// @dev Every holder puts its whole weight on `option`.
    function _castAll(uint8 option) internal {
        for (uint256 i; i < who.length; ++i) {
            _cast(who[i], option);
        }
    }

    /// @dev A voter moves: the ledger takes the old tally from `fromTally` and the new one from `optionTally`, so after the
    /// move it holds exactly what the contract holds.
    function test_replay_aVoterMoves() public {
        _initLedger();
        _park(alice, 10_000_000e18);
        _park(bob, 6_000_000e18);
        vm.recordLogs();
        uint32 id = _openReplace(alice, _list());
        _feed(vm.getRecordedLogs());
        _compareStep(1);
        _toStandEnd(id);

        vm.recordLogs();
        _cast(alice, 1);
        _feed(vm.getRecordedLogs());
        _compareStep(2);
        assertEq(lTally[id][1], 10_000_000e18, "the vote is on the list");

        vm.recordLogs();
        _cast(alice, 0); // the move
        _feed(vm.getRecordedLogs());
        _compareStep(3);
        assertEq(lTally[id][1], 0, "the list's tally is emptied by the move");
        assertEq(lTally[id][0], 10_000_000e18, "the whole weight is on 'keep'");
        assertEq(l[id].cast, 10_000_000e18, "a move does not double the cast total");
        _compareAll(3);
    }

    /// @dev A voter's weight falls: `Fell` gives the option's tally and the cast total after the fall, and the ledger needs
    /// nothing else to stay right.
    function test_replay_aVotersWeightFalls() public {
        _initLedger();
        _park(alice, 10_000_000e18);
        vm.recordLogs();
        uint32 id = _openReplace(alice, _list());
        _feed(vm.getRecordedLogs());
        _toStandEnd(id);
        vm.recordLogs();
        _cast(alice, 1);
        _feed(vm.getRecordedLogs());
        _compareStep(1);
        assertEq(l[id].cast, 10_000_000e18, "all of the weight is cast");

        vm.recordLogs();
        _unpark(alice, 4_000_000e18); // one call, one transaction: the tally falls with the custody
        _feed(vm.getRecordedLogs());
        _compareStep(2);
        assertEq(lTally[id][1], 6_000_000e18, "the list's tally fell with the weight");
        assertEq(l[id].cast, 6_000_000e18, "the cast total fell with the weight");
        _compareAll(2);
    }

    /// @dev A replace vote carried out: the ledger gets the Council from `BallotCarriedOut`, the five accounts from `Stood`
    /// and the seats from `SeatsSet`, and all of it is what the contract says.
    function test_replay_aCarriedOutReplaceVoteRebuildsTheCouncilAndItsSeats() public {
        _initLedger();
        _parkAll();
        vm.recordLogs();
        uint32 id = _openReplace(alice, _list());
        _feed(vm.getRecordedLogs());
        _toStandEnd(id);
        vm.recordLogs();
        _castAll(1);
        _feed(vm.getRecordedLogs());
        _toVoteEnd(id);
        vm.recordLogs();
        vote.finish(id);
        _feed(vm.getRecordedLogs());
        _toEffective(id);
        vm.recordLogs();
        vote.carryOut(id);
        _feed(vm.getRecordedLogs());
        _compareAll(4);
        address c = lRunner;
        assertEq(t.runner(), c, "the ledger's runner is the contract's");
        (address[5] memory seats,) = Council(c).seatList();
        for (uint256 i; i < 5; ++i) {
            assertEq(seats[i], lMembers[id][l[id].winner][i], "the Council's seats are the winning list's accounts");
        }
        assertTrue(lMadeByVote[c]);
    }

    /// @dev A seat election carried out: the ledger gets the two seats that came up from `BallotOpened` and the new holders
    /// from the Council's own `SeatsSet`; the generation and the next election date follow the same logs.
    function test_replay_aSeatElectionCarriedOutRebuildsTheSeats() public {
        // a Council first, through a carried-out replace vote (which the ledger rebuilt in the test above)
        _initLedger();
        _parkAll();
        vm.recordLogs();
        uint32 first = _openReplace(alice, _list());
        _feed(vm.getRecordedLogs());
        _toStandEnd(first);
        vm.recordLogs();
        _castAll(1);
        _feed(vm.getRecordedLogs());
        _toVoteEnd(first);
        _toEffective(first);
        vm.recordLogs();
        vote.carryOut(first);
        _feed(vm.getRecordedLogs());
        _compareAll(1);

        address c = t.runner();
        _warpTo(uint256(Council(c).nextElection()));
        vm.recordLogs();
        uint32 id = _openSeats();
        _feed(vm.getRecordedLogs());
        _compareStep(2);
        HolderVote.Ballot memory b = _ballotAt(id);
        assertEq(uint256(l[id].upA), uint256(b.upA), "the seat the election names first");
        assertEq(uint256(l[id].upB), uint256(b.upB), "the second seat");

        vm.recordLogs();
        vm.prank(alice);
        uint8 o1 = vote.stand(keccak256("alice"));
        vm.prank(bob);
        uint8 o2 = vote.stand(keccak256("bob"));
        _feed(vm.getRecordedLogs());
        _compareStep(3);
        _toStandEnd(id);

        vm.recordLogs();
        _cast(alice, o1);
        _cast(bob, o2);
        for (uint256 i = 2; i < who.length; ++i) {
            _cast(who[i], i % 2 == 0 ? o1 : o2); // the turnout floor needs the rest of the holders too
        }
        _feed(vm.getRecordedLogs());
        _toVoteEnd(id);
        vm.recordLogs();
        vote.finish(id);
        _feed(vm.getRecordedLogs());
        _toEffective(id);
        vm.recordLogs();
        vote.carryOut(id);
        _feed(vm.getRecordedLogs());
        _compareAll(4);
        (address[5] memory seats,) = Council(c).seatList();
        uint8 lo = b.upA < b.upB ? b.upA : b.upB;
        assertEq(seats[lo], alice, "the first winner took the lower seat");
        assertEq(lSeats[c][lo], alice, "the ledger's seat for it");
    }
}
