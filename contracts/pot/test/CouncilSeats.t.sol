// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {CouncilBase, FakeTreasury} from "./helpers/CouncilBase.sol";
import {Council} from "../src/Council.sol";
import {Treasury} from "../src/Treasury.sol";
import {Pair} from "../src/Pair.sol";

/// @notice How seats change hands: which two seats come up, in what order, who takes which seat, the one-seat-per-account rule
/// and the fence. The test contract is the Council's vote contract (a fake Treasury names it as its gate), so it can open an
/// election and put winners in.
contract CouncilSeatsTest is CouncilBase {
    FakeTreasury internal fake;
    Council internal bare;
    address internal w1 = makeAddr("winner one");
    address internal w2 = makeAddr("winner two");
    address internal w3 = makeAddr("winner three");

    function setUp() public override {
        super.setUp();
        fake = new FakeTreasury(UNIT, address(this));
        bare = _bareCouncil(fake, address(launcher), _five());
    }

    function _holders() internal view returns (address[5] memory s) {
        (s,) = bare.seatList();
    }

    function _open() internal returns (uint8 a, uint8 b) {
        _warpTo(bare.nextElection());
        (a, b) = bare.openElection();
    }

    // ---- which two seats come up

    function test_theTwoLongestWithoutAVoteComeUpAndRotationMovesOn() public {
        uint8[2][6] memory want = [[0, 1], [2, 3], [4, 0], [1, 2], [3, 0], [4, 1]];
        for (uint256 i; i < want.length; ++i) {
            (uint8 a, uint8 b) = bare.upNext();
            (uint8 oa, uint8 ob) = _open();
            assertEq(oa, a, "the view says what opening does");
            assertEq(ob, b);
            assertEq(oa, want[i][0], "first seat");
            assertEq(ob, want[i][1], "second seat");
        }
    }

    function test_anElectionOpensOnlyWhenDueAndTheNextOneIsTwentySixUnitsFromNow() public {
        uint64 due = bare.nextElection();
        assertEq(due, T0 + 26 * uint256(UNIT));
        _warpTo(due - 1);
        vm.expectRevert(abi.encodeWithSelector(Council.NotDue.selector, due));
        bare.openElection();
        _warpTo(due + 3 days); // late: the next one counts from the day it opened
        bare.openElection();
        assertEq(bare.nextElection(), due + 3 days + 26 * uint256(UNIT));
        vm.expectRevert(abi.encodeWithSelector(Council.NotDue.selector, bare.nextElection()));
        bare.openElection();
    }

    function test_openingSetsTheTwoSeatsTimeToNowAndSaysSo() public {
        _warpTo(bare.nextElection());
        vm.recordLogs();
        (uint8 a, uint8 b) = bare.openElection();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        (,, uint64 la) = bare.seatOf(a);
        (,, uint64 lb) = bare.seatOf(b);
        assertEq(la, clock);
        assertEq(lb, clock);
        (,, uint64 other) = bare.seatOf(2);
        assertEq(other, T0, "a seat that did not come up keeps its time");
        assertEq(logs.length, 1);
        assertEq(logs[0].topics[0], Council.SeatsSet.selector);
        (,,, uint64 next) = abi.decode(logs[0].data, (address[5], uint64[5], uint32, uint64));
        assertEq(next, clock + 26 * uint256(UNIT), "the next date is in the event, so a reader needs no view");
    }

    function test_anOpenSeatComesUpFirst() public {
        vm.prank(s4);
        bare.resign();
        (uint8 a, uint8 b) = _open();
        assertEq(a, 3, "the open seat has gone longest");
        assertEq(b, 0);
    }

    function test_anOpenSeatNobodyWonComesUpAgainAtTheNextElection() public {
        vm.prank(s4);
        bare.resign();
        (uint8 a, uint8 b) = _open();
        assertEq(a, 3);
        assertEq(b, 0);
        bare.seat(a, b, address(0), address(0)); // nobody stood
        (a, b) = _open();
        assertEq(a, 3, "the seat is still open, so it is still first");
        assertEq(b, 1, "and the other seat is the next in turn");
    }

    function test_onlyTheVoteContractOpensAnElectionOrPutsWinnersIn() public {
        _warpTo(bare.nextElection());
        address[4] memory nobody = [stranger, founder, s1, address(0xdead)];
        for (uint256 i; i < nobody.length; ++i) {
            vm.expectRevert(Council.NotAllowed.selector);
            vm.prank(nobody[i]);
            bare.openElection();
            vm.expectRevert(Council.NotAllowed.selector);
            vm.prank(nobody[i]);
            bare.seat(0, 1, w1, w2);
        }
        // a project with no vote contract: nobody is the vote
        FakeTreasury none = new FakeTreasury(UNIT, address(0));
        Council c = _bareCouncil(none, address(launcher), _five());
        vm.expectRevert(Council.NotAllowed.selector);
        c.openElection();
        vm.expectRevert(Council.NotAllowed.selector);
        c.seat(0, 1, w1, w2);
        vm.expectRevert(Council.NotAllowed.selector);
        vm.prank(address(0));
        c.seat(0, 1, w1, w2);
    }

    // ---- who takes which seat

    function test_twoNewWinnersTakeTheLowerNumberedSeatFirstWhateverTheOrderOfTheArguments() public {
        _warpTo(clock + 1 days);
        uint32 g = bare.generation();
        bare.seat(3, 1, w1, w2);
        address[5] memory h = _holders();
        assertEq(h[1], w1, "the first winner takes the lower seat");
        assertEq(h[3], w2);
        assertEq(h[0], s1);
        assertEq(h[2], s3);
        assertEq(h[4], s5);
        assertEq(bare.generation(), g + 1);
        (, uint64 at, uint64 lastUp) = bare.seatOf(1);
        assertEq(at, clock, "a new seat counts from the day it was filled");
        assertEq(lastUp, clock);
        (, at,) = bare.seatOf(0);
        assertEq(at, T0, "a seat that did not change keeps its date");
    }

    function test_aWinnerWhoHoldsOneOfTheTwoSeatsStaysAndTheOtherWinnerTakesTheOther() public {
        bare.seat(1, 3, s4, w1); // s4 is the holder of seat 3 (index 3)
        address[5] memory h = _holders();
        assertEq(h[3], s4);
        assertEq(h[1], w1, "the new winner takes the seat nobody kept");
        bare.seat(1, 3, w2, w1); // the order of the winners does not matter: w1 holds seat 1 and stays
        h = _holders();
        assertEq(h[1], w1);
        assertEq(h[3], w2);
    }

    function test_whenBothHoldersWinNothingChangesAndNoGenerationIsSpent() public {
        uint32 g = bare.generation();
        vm.recordLogs();
        bare.seat(1, 3, s2, s4);
        assertEq(vm.getRecordedLogs().length, 0, "nothing to say");
        assertEq(bare.generation(), g);
        address[5] memory h = _holders();
        assertEq(h[1], s2);
        assertEq(h[3], s4);
    }

    function test_noWinnerLeavesTheHoldersAndOneWinnerTakesTheLowerSeat() public {
        uint32 g = bare.generation();
        bare.seat(1, 3, address(0), address(0));
        assertEq(bare.generation(), g);
        address[5] memory h = _holders();
        assertEq(h[1], s2);
        assertEq(h[3], s4);
        bare.seat(3, 1, address(0), w1);
        h = _holders();
        assertEq(h[1], w1, "a single winner, named second, takes the lower seat");
        assertEq(h[3], s4, "the seat with no winner keeps its holder");
        assertEq(bare.generation(), g + 1);
    }

    function test_anOpenSeatIsFilledByAWinner() public {
        vm.prank(s2);
        bare.resign();
        bare.seat(1, 3, w1, address(0));
        assertEq(_holders()[1], w1);
        assertTrue(bare.isSeat(w1));
    }

    function test_aWinnerThatHoldsAnotherSeatIsRefused() public {
        vm.expectRevert(abi.encodeWithSelector(Council.AlreadySeated.selector, s5));
        bare.seat(1, 3, s5, w1);
        vm.expectRevert(abi.encodeWithSelector(Council.AlreadySeated.selector, s1));
        bare.seat(1, 3, w1, s1);
        address[5] memory h = _holders();
        assertEq(h[0], s1);
        assertEq(h[4], s5);
    }

    function test_badSeatsOrWinnersAreRefused() public {
        vm.expectRevert(Council.BadSeat.selector);
        bare.seat(2, 2, w1, w2);
        vm.expectRevert(Council.BadSeat.selector);
        bare.seat(5, 1, w1, w2);
        vm.expectRevert(Council.BadSeat.selector);
        bare.seat(1, 9, w1, w2);
        vm.expectRevert(Council.BadSeat.selector);
        bare.seat(1, 3, w1, w1);
    }

    function testFuzz_aWinnerNeverHoldsTwoSeatsAndTheGenerationMovesOnlyWithTheSeats(
        uint8 upA,
        uint8 upB,
        uint8 wa,
        uint8 wb,
        uint8 resignWho
    ) public {
        address[9] memory cand = [address(0), s1, s2, s3, s4, s5, w1, w2, w3];
        if (resignWho % 3 == 0) {
            vm.prank(cand[1 + resignWho % 5]);
            bare.resign();
        }
        address[5] memory before = _holders();
        uint32 g = bare.generation();
        try bare.seat(upA % 6, upB % 6, cand[wa % 9], cand[wb % 9]) {
            address[5] memory afterH = _holders();
            bool changed;
            for (uint256 i; i < 5; ++i) {
                if (before[i] != afterH[i]) changed = true;
                for (uint256 j = i + 1; j < 5; ++j) {
                    assertTrue(afterH[i] == address(0) || afterH[i] != afterH[j], "one account on two seats");
                }
            }
            assertEq(bare.generation(), changed ? g + 1 : g);
        } catch {
            address[5] memory afterH = _holders();
            for (uint256 i; i < 5; ++i) {
                assertEq(afterH[i], before[i], "a refused call changes nothing");
            }
            assertEq(bare.generation(), g);
        }
    }

    function test_theZeroAddressIsNeverASeatEvenWhenSeatsAreOpen() public {
        for (uint256 i; i < 5; ++i) {
            vm.prank(_five()[i]);
            bare.resign();
        }
        assertFalse(bare.isSeat(address(0)));
        bare.seat(0, 1, w1, w2);
        assertFalse(bare.isSeat(address(0)));
        assertTrue(bare.isSeat(w1));
        assertTrue(bare.isSeat(w2));
    }

    // ---- an election kills older proposals

    function test_aSeatThatChangedKillsEveryOlderProposalOfTheCouncil() public {
        bytes memory data = abi.encodeCall(FakeTreasury.draw, (s6, 1));
        fake.setCouncil(address(bare));
        uint256 n = bare.nonce();
        vm.prank(s1);
        bare.propose(address(fake), data);
        vm.prank(s2);
        bare.agree(address(fake), data, n);
        bare.seat(0, 1, w1, w2); // seats 0 and 1 change hands
        vm.expectRevert(Council.SeatsChanged.selector);
        vm.prank(s3);
        bare.agree(address(fake), data, n);
        assertEq(fake.draws(), 0, "the agreement of a seat that left was never counted");
    }
}

/// @notice The five seats of a real Council are barred from the tasks the way a Pair's two signers are, and a former runner is not.
contract CouncilTeamSeatTest is CouncilBase {
    bytes32 internal constant WHAT = keccak256("a task");

    function setUp() public override {
        super.setUp();
        _join(alice, 100_000e6);
        _makeCouncil();
        _warp(2 days);
        _councilCheckIn();
    }

    function test_noSeatHolderCanBeNamedThePayeeOfATask() public {
        address[5] memory m = _five();
        for (uint256 i; i < 5; ++i) {
            bytes memory data = abi.encodeCall(Treasury.announceTask, (WHAT, m[i], 100e6, 10));
            uint256 n = _propose(s1, data);
            _agree(s2, data, n);
            vm.expectRevert(Treasury.NotAllowed.selector);
            _agree(s3, data, n);
        }
        // the founder who handed the seat over is no seat, and a sixth account is not either
        _run(abi.encodeCall(Treasury.announceTask, (WHAT, founder, 100e6, 10)));
        _run(abi.encodeCall(Treasury.announceTask, (WHAT, s6, 100e6, 10)));
    }

    function test_noSeatHolderCanTakeAnOpenTaskButAnyoneElseCan() public {
        _run(abi.encodeCall(Treasury.announceTask, (WHAT, address(0), 1000e6, 100)));
        uint64 serial = _book().nextSerial() - 1;
        _warpAlive(_book().taskOf(serial).noticeEnd - clock);
        address[5] memory m = _five();
        for (uint256 i; i < 5; ++i) {
            vm.expectRevert(Treasury.NotAllowed.selector);
            vm.prank(m[i]);
            t.takeTask(serial, 0);
        }
        vm.prank(founder);
        t.takeTask(serial, 0); // the earlier runner is a stranger to the new seat
        assertEq(_book().taskOf(serial).takenBy, founder);
    }

    function test_aSeatHolderResignsAndIsFreeToTakeATask() public {
        _run(abi.encodeCall(Treasury.announceTask, (WHAT, address(0), 1000e6, 100)));
        uint64 serial = _book().nextSerial() - 1;
        _warpAlive(_book().taskOf(serial).noticeEnd - clock);
        vm.prank(s5);
        council.resign();
        vm.prank(s5);
        t.takeTask(serial, 0);
        assertEq(_book().taskOf(serial).takenBy, s5);
    }
}

/// @notice A Pair's two signers are seats too (`Pair.isSeat`), and nobody else is: the Treasury's bar on the tasks reads it.
contract PairIsSeatTest is CouncilBase {
    function test_aPairsTwoSignersAreSeatsAndNobodyElseNorTheZeroAddress() public {
        Pair pair = _makePair(s2);
        assertTrue(pair.isSeat(founder));
        assertTrue(pair.isSeat(s2));
        assertFalse(pair.isSeat(s3));
        assertFalse(pair.isSeat(address(0)));
    }

    function test_neitherSignerOfAPairCanBeThePayeeOfATask() public {
        Pair pair = _makePair(s2);
        _join(alice, 50_000e6);
        _warp(1 days);
        _checkIn();
        bytes memory toFounder = abi.encodeCall(Treasury.announceTask, (bytes32(uint256(1)), founder, 100e6, 10));
        bytes memory toSecond = abi.encodeCall(Treasury.announceTask, (bytes32(uint256(2)), s2, 100e6, 10));
        uint256 n = pair.nonce();
        vm.prank(founder);
        pair.propose(address(t), toFounder);
        vm.expectRevert(Treasury.NotAllowed.selector);
        vm.prank(s2);
        pair.confirm(address(t), toFounder, n);
        n = pair.nonce();
        vm.prank(founder);
        pair.propose(address(t), toSecond);
        vm.expectRevert(Treasury.NotAllowed.selector);
        vm.prank(s2);
        pair.confirm(address(t), toSecond, n);
    }
}
