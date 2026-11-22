// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {Clones} from "oz5/proxy/Clones.sol";
import {CouncilBase, FakeTreasury} from "./helpers/CouncilBase.sol";
import {Council} from "../src/Council.sol";
import {Treasury} from "../src/Treasury.sol";
import {Launcher} from "../src/Launcher.sol";
import {ITreasuryRunner} from "../src/Interfaces.sol";

/// @notice A seat that is a contract: when it is paid dollars by the Treasury (the dollar token calls it back) it tries to
/// agree to another pending call, as a hostile seat would to run a call inside a call.
contract ReenterSeat {
    Council public council;
    address public target;
    bytes public data;
    uint256 public n;
    bool public tried;
    bytes4 public caught;

    function arm(Council c, address target_, bytes calldata data_, uint256 n_) external {
        (council, target, data, n, tried, caught) = (c, target_, data_, n_, false, bytes4(0));
    }

    function onQuoteTransfer(address, address, uint256, bool after_) external {
        if (!after_ || tried) return;
        tried = true;
        try council.agree(target, data, n) {
            caught = bytes4(0xffffffff); // it ran: the guard is missing
        } catch (bytes memory r) {
            caught = bytes4(r);
        }
    }
}

/// @notice The Council as a runner of a real project: three of five, one call at a time, the generation fence, the expiry.
contract CouncilTest is CouncilBase {
    address internal worker = makeAddr("worker");
    bytes32 internal constant WHAT = keccak256("a task a council plans");

    function setUp() public override {
        super.setUp();
        _join(alice, 100_000e6);
        _join(bob, 50_000e6);
        _makeCouncil();
        _warp(2 days);
        _councilCheckIn();
    }

    function _drawData(uint256 amount) internal view returns (bytes memory) {
        return abi.encodeCall(Treasury.draw, (worker, amount));
    }

    function _ready() internal returns (uint256 amount) {
        _warp(1 days);
        t.settle();
        amount = t.box() / 2;
        assertGt(amount, 0);
    }

    // ---- birth

    function test_aCouncilIsBornWithFiveSeatsTheSeatAndItsDates() public view {
        assertEq(t.runner(), address(council), "the Council holds the runner seat");
        assertEq(launcher.runnerKindOf(address(council)), 2);
        assertFalse(launcher.isPair(address(council)));
        assertTrue(launcher.isCouncil(address(council)));
        (address[5] memory seats, uint64[5] memory at_) = council.seatList();
        address[5] memory m = _five();
        for (uint256 i; i < 5; ++i) {
            assertEq(seats[i], m[i]);
            assertEq(at_[i], T0, "seated at birth");
            assertTrue(council.isSeat(m[i]));
        }
        assertEq(council.vote(), t.pauseGate(), "the vote contract is the project's pause gate");
        assertTrue(council.vote() != address(0));
        assertEq(council.unit(), UNIT);
        assertEq(council.PROPOSAL_TTL(), 2 * uint256(UNIT));
        assertEq(council.nextElection(), T0 + 26 * uint256(UNIT));
        assertEq(council.generation(), 0);
        assertEq(council.THRESHOLD(), 3);
        assertEq(council.SEATS(), 5);
        assertEq(address(council.treasury()), address(t));
        assertEq(council.launcher(), address(launcher));
        assertFalse(council.isSeat(founder), "the founder who handed the seat over holds none");
        assertFalse(council.isSeat(stranger));
    }

    function test_birthSaysSeatsSetAndRunnerChanged() public {
        // a second project, so the events of the birth can be recorded
        _use(_launch(alice, "second", 1000, POOL));
        address[5] memory m = _five();
        address predicted = launcher.councilAddress(key, m, bytes32(uint256(5)));
        vm.prank(alice);
        t.handOver(predicted, false);
        vm.recordLogs();
        launcher.makeCouncil(key, m, bytes32(uint256(5)));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 seatsSet;
        uint256 runner;
        uint256 made;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == predicted && logs[i].topics[0] == Council.SeatsSet.selector) {
                ++seatsSet;
                (address[5] memory sx, uint64[5] memory at_, uint32 g, uint64 next) =
                    abi.decode(logs[i].data, (address[5], uint64[5], uint32, uint64));
                assertEq(sx[3], s4);
                assertEq(at_[0], clock);
                assertEq(g, 0);
                assertEq(next, clock + 26 * uint256(UNIT));
            }
            if (logs[i].emitter == address(t) && logs[i].topics[0] == Treasury.RunnerChanged.selector) {
                ++runner;
                assertEq(address(uint160(uint256(logs[i].topics[1]))), alice);
                assertEq(address(uint160(uint256(logs[i].topics[2]))), predicted);
            }
            if (logs[i].emitter == address(launcher) && logs[i].topics[0] == Launcher.CouncilMade.selector) {
                ++made;
                assertEq(logs[i].topics[1], key);
                assertEq(address(uint160(uint256(logs[i].topics[2]))), predicted);
                bool byVote = abi.decode(logs[i].data, (bool));
                assertFalse(byVote);
            }
        }
        assertEq(seatsSet, 1);
        assertEq(runner, 1);
        assertEq(made, 1);
    }

    function test_theImplementationIsLockedAndACloneIsSetUpOnlyByItsLauncherOnce() public {
        address[5] memory m = _five();
        vm.expectRevert(Council.BadSetup.selector);
        councilImpl.initialize(ITreasuryRunner(address(t)), address(this), m, false);
        vm.expectRevert(Council.BadSetup.selector);
        vm.prank(address(launcher));
        councilImpl.initialize(ITreasuryRunner(address(t)), address(launcher), m, false);
        Council c = Council(Clones.clone(address(councilImpl)));
        vm.expectRevert(Council.BadSetup.selector); // not the launcher it names
        vm.prank(stranger);
        c.initialize(ITreasuryRunner(address(t)), address(launcher), m, false);
        vm.prank(address(launcher));
        c.initialize(ITreasuryRunner(address(t)), address(launcher), m, false);
        vm.expectRevert(Council.BadSetup.selector); // twice
        vm.prank(address(launcher));
        c.initialize(ITreasuryRunner(address(t)), address(launcher), m, false);
        vm.expectRevert(Council.BadSetup.selector); // a made Council cannot be set up again
        vm.prank(address(launcher));
        council.initialize(ITreasuryRunner(address(t)), address(launcher), m, false);
    }

    function test_aMissingOrRepeatedSeatIsRefused() public {
        for (uint256 i; i < 10; ++i) {
            address[5] memory m = _five();
            if (i < 5) m[i] = address(0);
            else m[i - 5] = m[(i - 4) % 5]; // account i-5 repeats its neighbour
            bytes32 salt = bytes32(uint256(100 + i));
            Council c = Council(Clones.clone(address(councilImpl)));
            vm.expectRevert(Council.BadSetup.selector);
            vm.prank(address(launcher));
            c.initialize(ITreasuryRunner(address(t)), address(launcher), m, false);
            salt;
        }
    }

    // ---- three of five

    function test_threeOfFiveRunAnActionAndTwoDoNot() public {
        uint256 amount = _ready();
        bytes memory data = _drawData(amount);
        uint256 n = _propose(s1, data);
        assertEq(council.agreedCount(council.callId(address(t), data, n)), 1, "the proposer's own agreement");
        _agree(s2, data, n);
        assertEq(usd.balanceOf(worker), 0, "two seats move no money");
        assertEq(council.agreedCount(council.callId(address(t), data, n)), 2);
        _agree(s3, data, n);
        assertEq(usd.balanceOf(worker), amount, "the third seat sends it");
        assertEq(council.agreedCount(council.callId(address(t), data, n)), 0, "the record is gone after it ran");
        (uint48 at_, uint32 gen, uint8 mask) = council.proposals(council.callId(address(t), data, n));
        assertEq(uint256(at_) + gen + mask, 0);
    }

    /// @dev Any subset of the five seats agrees one after the other (the lowest of them proposes): the call runs exactly when
    /// the third distinct seat agrees, and never before, and never twice.
    function testFuzz_aCallRunsExactlyWhenTheThirdDistinctSeatAgrees(uint8 subset, uint8 extra) public {
        address[5] memory m = _five();
        uint256 amount = _ready() / 4;
        bytes memory data = _drawData(amount);
        uint256 n = council.nonce();
        uint256 agreed;
        uint256 runs;
        for (uint256 i; i < 5; ++i) {
            if (subset & (1 << i) == 0) continue;
            vm.prank(m[i]);
            if (agreed == 0) {
                council.propose(address(t), data);
            } else {
                if (agreed >= 3) {
                    vm.expectRevert(Council.UnknownCall.selector); // it has run: there is no record
                    council.agree(address(t), data, n);
                    continue;
                }
                council.agree(address(t), data, n);
            }
            ++agreed;
            if (agreed == 3) runs = 1;
            assertEq(usd.balanceOf(worker), runs * amount, "money moved exactly when the third agreed");
        }
        // an agreement by one of the seats that already agreed is refused while the call is still pending
        if (agreed != 0 && agreed < 3) {
            for (uint256 i; i < 5; ++i) {
                if (subset & (1 << i) != 0) {
                    vm.expectRevert(Council.AlreadyAgreed.selector);
                    vm.prank(m[i]);
                    council.agree(address(t), data, n);
                    break;
                }
            }
        }
        extra;
    }

    function test_anyThreeSeatsCanRunIt() public {
        uint256 amount = _ready() / 2;
        _run3(s5, s2, s4, _drawData(amount));
        assertEq(usd.balanceOf(worker), amount);
        _run3(s3, s5, s1, _drawData(1e6));
        assertEq(usd.balanceOf(worker), amount + 1e6);
    }

    function test_aProposalRunsOnceAndSeatsFourAndFiveFindNoRecord() public {
        uint256 amount = _ready() / 2;
        bytes memory data = _drawData(amount);
        uint256 n = _propose(s1, data);
        _agree(s2, data, n);
        _agree(s3, data, n);
        assertEq(usd.balanceOf(worker), amount);
        vm.expectRevert(Council.UnknownCall.selector);
        _agree(s4, data, n);
        vm.expectRevert(Council.UnknownCall.selector);
        _agree(s5, data, n);
        assertEq(usd.balanceOf(worker), amount, "nothing ran twice");
        assertEq(council.nonce(), n + 1);
    }

    function test_aSeatCannotAgreeTwiceAndTheProposerCountsOnce() public {
        bytes memory data = _drawData(1e6);
        uint256 n = _propose(s1, data);
        vm.expectRevert(Council.AlreadyAgreed.selector);
        _agree(s1, data, n);
        _agree(s2, data, n);
        vm.expectRevert(Council.AlreadyAgreed.selector);
        _agree(s2, data, n);
        vm.expectRevert(Council.AlreadyAgreed.selector);
        _agree(s1, data, n);
    }

    function test_onlyASeatProposesOrAgrees() public {
        bytes memory data = _drawData(1e6);
        vm.expectRevert(Council.NotAllowed.selector);
        _propRaw(founder, address(t), data);
        vm.expectRevert(Council.NotAllowed.selector);
        _propRaw(stranger, address(t), data);
        vm.expectRevert(Council.NotAllowed.selector);
        _propRaw(address(0), address(t), data);
        uint256 n = _propose(s1, data);
        vm.expectRevert(Council.NotAllowed.selector);
        _agree(founder, data, n);
        vm.expectRevert(Council.NotAllowed.selector);
        _agree(stranger, data, n);
    }

    function test_theCallMustBeExactlyTheOneProposed() public {
        bytes memory data = _drawData(1e6);
        uint256 n = _propose(s1, data);
        vm.expectRevert(Council.UnknownCall.selector);
        _agree(s2, _drawData(2e6), n); // other bytes
        vm.expectRevert(Council.UnknownCall.selector);
        _agree(s2, data, n + 1); // other number
        vm.expectRevert(Council.UnknownCall.selector);
        vm.prank(s2);
        council.agree(address(launcher), data, n); // other target
        _agree(s2, data, n); // the right one still works
    }

    function test_theSameCallProposedTwiceHasTwoIds() public {
        bytes memory data = _drawData(1e6);
        uint256 n1 = _propose(s1, data);
        uint256 n2 = _propose(s1, data);
        assertEq(n2, n1 + 1);
        assertTrue(council.callId(address(t), data, n1) != council.callId(address(t), data, n2));
        _agree(s2, data, n1);
        assertEq(council.agreedCount(council.callId(address(t), data, n1)), 2);
        assertEq(council.agreedCount(council.callId(address(t), data, n2)), 1);
    }

    function test_proposeStoresWhenAndInWhichGenerationAndSaysSo() public {
        bytes memory data = _drawData(1e6);
        vm.recordLogs();
        uint256 n = _propose(s3, data);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 id = council.callId(address(t), data, n);
        (uint48 at_, uint32 gen, uint8 mask) = council.proposals(id);
        assertEq(at_, clock);
        assertEq(gen, council.generation());
        assertEq(mask, uint8(1 << 2), "seat three's bit");
        assertEq(logs.length, 1);
        assertEq(logs[0].emitter, address(council));
        assertEq(logs[0].topics[0], Council.Proposed.selector);
        assertEq(logs[0].topics[1], id);
        assertEq(address(uint160(uint256(logs[0].topics[2]))), s3);
        (address target, bytes memory d, uint256 nn) = abi.decode(logs[0].data, (address, bytes, uint256));
        assertEq(target, address(t));
        assertEq(d, data);
        assertEq(nn, n);
    }

    function test_agreeingAndRunningSayAgreedAndExecuted() public {
        uint256 amount = _ready() / 2;
        bytes memory data = _drawData(amount);
        uint256 n = _propose(s1, data);
        bytes32 id = council.callId(address(t), data, n);
        vm.recordLogs();
        _agree(s2, data, n);
        Vm.Log[] memory a = vm.getRecordedLogs();
        assertEq(a.length, 1);
        assertEq(a[0].topics[0], Council.Agreed.selector);
        assertEq(a[0].topics[1], id);
        assertEq(address(uint160(uint256(a[0].topics[2]))), s2);
        assertEq(abi.decode(a[0].data, (uint8)), 2);
        _agree(s3, data, n);
        Vm.Log[] memory b = vm.getRecordedLogs();
        uint256 agreed;
        uint256 executed;
        for (uint256 i; i < b.length; ++i) {
            if (b[i].emitter != address(council)) continue;
            if (b[i].topics[0] == Council.Agreed.selector) {
                ++agreed;
                assertEq(abi.decode(b[i].data, (uint8)), 3);
            }
            if (b[i].topics[0] == Council.Executed.selector) {
                ++executed;
                assertEq(b[i].topics[1], id);
                assertEq(address(uint160(uint256(b[i].topics[2]))), s3);
            }
        }
        assertEq(agreed, 1);
        assertEq(executed, 1);
    }

    // ---- taking an agreement back

    function test_aSeatTakesItsAgreementBackAndTheCallThenNeedsAnother() public {
        uint256 amount = _ready() / 2;
        bytes memory data = _drawData(amount);
        uint256 n = _propose(s1, data);
        bytes32 id = council.callId(address(t), data, n);
        _agree(s2, data, n);
        vm.recordLogs();
        vm.prank(s2);
        council.withdraw(id);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].topics[0], Council.Withdrawn.selector);
        assertEq(abi.decode(logs[0].data, (uint8)), 1);
        assertEq(council.agreedCount(id), 1);
        _agree(s3, data, n); // two again: s1 and s3
        assertEq(usd.balanceOf(worker), 0, "s2's agreement is gone, so a third seat is still needed");
        _agree(s2, data, n); // s2 agrees again: three
        assertEq(usd.balanceOf(worker), amount);
    }

    function test_theLastAgreementTakenBackDeletesTheProposal() public {
        bytes memory data = _drawData(1e6);
        uint256 n = _propose(s1, data);
        bytes32 id = council.callId(address(t), data, n);
        vm.recordLogs();
        vm.prank(s1);
        council.withdraw(id);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 2);
        assertEq(logs[0].topics[0], Council.Withdrawn.selector);
        assertEq(abi.decode(logs[0].data, (uint8)), 0);
        assertEq(logs[1].topics[0], Council.Cancelled.selector);
        assertEq(logs[1].topics[1], id);
        assertEq(council.agreedCount(id), 0);
        vm.expectRevert(Council.UnknownCall.selector);
        _agree(s2, data, n);
        vm.expectRevert(Council.UnknownCall.selector);
        vm.prank(s1);
        council.withdraw(id);
    }

    function test_onlyASeatThatAgreedTakesBackAndAnUnknownCallIsRefused() public {
        bytes memory data = _drawData(1e6);
        uint256 n = _propose(s1, data);
        bytes32 id = council.callId(address(t), data, n);
        vm.expectRevert(Council.NotAllowed.selector);
        vm.prank(s2); // a seat that did not agree
        council.withdraw(id);
        vm.expectRevert(Council.NotAllowed.selector);
        vm.prank(stranger);
        council.withdraw(id);
        vm.expectRevert(Council.UnknownCall.selector);
        vm.prank(s1);
        council.withdraw(bytes32(uint256(123)));
        assertEq(council.agreedCount(id), 1, "nothing changed");
    }

    function test_aCallThatRanCannotBeTakenBack() public {
        uint256 amount = _ready() / 2;
        bytes memory data = _drawData(amount);
        uint256 n = _propose(s1, data);
        _agree(s2, data, n);
        _agree(s3, data, n);
        bytes32 id = council.callId(address(t), data, n);
        vm.expectRevert(Council.UnknownCall.selector);
        vm.prank(s1);
        council.withdraw(id);
    }

    // ---- running out

    function test_aProposalLivesTwoUnitsAndNotOneSecondMore() public {
        uint256 amount = _ready() / 2;
        bytes memory data = _drawData(amount);
        uint256 n = _propose(s1, data);
        _agree(s2, data, n);
        uint256 born = clock;
        _warpTo(born + 2 * uint256(UNIT)); // the last second it may be agreed to
        _agree(s3, data, n);
        assertEq(usd.balanceOf(worker), amount, "agreed to at the last second");
    }

    function test_aProposalOneSecondOlderIsDead() public {
        bytes memory data = _drawData(1e6);
        uint256 n = _propose(s1, data);
        _agree(s2, data, n);
        _warpTo(clock + 2 * uint256(UNIT) + 1);
        vm.expectRevert(Council.Expired.selector);
        _agree(s3, data, n);
        // and it can be taken back or left; a new one works
        n = _propose(s1, data);
        _agree(s2, data, n);
    }

    // ---- the fence

    function test_aReplacedSeatsAgreementIsDead() public {
        bytes memory data = _drawData(1e6);
        uint256 n = _propose(s1, data);
        _agree(s2, data, n);
        uint32 g = council.generation();
        vm.prank(s5);
        council.resign();
        assertEq(council.generation(), g + 1);
        vm.expectRevert(Council.SeatsChanged.selector);
        _agree(s3, data, n);
        bytes32 id = council.callId(address(t), data, n);
        vm.expectRevert(Council.SeatsChanged.selector);
        vm.prank(s1);
        council.withdraw(id);
        // propose again in the new generation: three of the four that remain
        _run3(s1, s2, s3, _drawData(1e6));
    }

    // ---- resigning

    function test_aSeatHolderGivesUpTheSeatAndItIsOpen() public {
        uint32 g = council.generation();
        vm.recordLogs();
        vm.prank(s4);
        council.resign();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(council.generation(), g + 1);
        assertFalse(council.isSeat(s4));
        (address who, uint64 seatedAt_, uint64 lastUp) = council.seatOf(3);
        assertEq(who, address(0));
        assertEq(seatedAt_, 0);
        assertEq(lastUp, 0, "an open seat counts as time zero");
        uint256 resigned;
        uint256 seatsSet;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == Council.Resigned.selector) {
                ++resigned;
                assertEq(abi.decode(logs[i].data, (uint8)), 3);
                assertEq(address(uint160(uint256(logs[i].topics[1]))), s4);
            }
            if (logs[i].topics[0] == Council.SeatsSet.selector) {
                ++seatsSet;
                (address[5] memory sx, uint64[5] memory ax, uint32 gg,) =
                    abi.decode(logs[i].data, (address[5], uint64[5], uint32, uint64));
                assertEq(sx[3], address(0));
                assertEq(ax[3], 0);
                assertEq(gg, g + 1);
            }
        }
        assertEq(resigned, 1);
        assertEq(seatsSet, 1);
        vm.expectRevert(Council.NotAllowed.selector);
        vm.prank(s4); // a second time
        council.resign();
        vm.expectRevert(Council.NotAllowed.selector);
        vm.prank(stranger);
        council.resign();
        vm.expectRevert(Council.NotAllowed.selector);
        vm.prank(address(0));
        council.resign();
    }

    function test_theZeroAddressIsNoSeatEvenWithAnOpenSeat() public {
        vm.prank(s2);
        council.resign();
        assertFalse(council.isSeat(address(0)), "an open seat is stored as zero and is nobody's");
        bytes memory dd = _drawData(1);
        vm.expectRevert(Council.NotAllowed.selector);
        vm.prank(address(0));
        council.propose(address(t), dd);
    }

    function test_fourSeatsStillRunAnActionAndTwoCannot() public {
        vm.prank(s5);
        council.resign();
        vm.prank(s4);
        council.resign();
        uint256 amount = _ready() / 2;
        _run3(s1, s2, s3, _drawData(amount));
        assertEq(usd.balanceOf(worker), amount, "three live seats are enough");
        vm.prank(s3);
        council.resign();
        bytes memory data = _drawData(1e6);
        uint256 n = _propose(s1, data);
        _agree(s2, data, n);
        assertEq(usd.balanceOf(worker), amount, "with two live seats nothing can run");
        vm.expectRevert(Council.NotAllowed.selector);
        _agree(s3, data, n);
    }

    // ---- a call that fails

    function test_aCallThatFailsRevertsEverythingAndStaysPending() public {
        uint256 tooMuch = t.box() + 1e6;
        bytes memory data = _drawData(tooMuch);
        uint256 n = _propose(s1, data);
        _agree(s2, data, n);
        bytes32 id = council.callId(address(t), data, n);
        uint256 box = t.box();
        vm.expectRevert(abi.encodeWithSelector(Treasury.TooMuch.selector, tooMuch, box));
        _agree(s3, data, n);
        assertEq(council.agreedCount(id), 2, "the third agreement was not kept: it stays at two");
        (,, uint8 mask) = council.proposals(id);
        assertEq(mask, uint8(0x03));
        assertFalse(council.bothSigned(), "and nothing is left executing");
    }

    // ---- who runs, and when

    function test_bothSignedIsTrueOnlyWhileACallRunsAndASeatAloneIsNotTheRunner() public {
        assertFalse(council.bothSigned());
        vm.prank(s1);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.draw(s1, 1e6);
        vm.prank(address(council)); // even the Council itself, outside a run, is refused
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.draw(s1, 1e6);
        vm.prank(s1);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.setDoor(false);
    }

    function test_aSeatThatIsAContractCannotRunACallInsideACall() public {
        ReenterSeat re = new ReenterSeat();
        address[5] memory m = [s1, s2, s3, address(re), s5];
        // a second project run by a Council that has the contract as a seat
        _use(_launch(alice, "reentry", 1000, POOL));
        _join(bob, 100_000e6);
        council = _handOverTo(m, bytes32(uint256(77)));
        _warp(2 days);
        t.settle();
        uint256 amount = t.box() / 2;
        // call B: closing the door (not guarded by the Treasury's own lock, so a nested run would succeed)
        bytes memory dataB = abi.encodeCall(Treasury.setDoor, (false));
        uint256 nB = _propose(s1, dataB);
        _agree(s2, dataB, nB);
        // call A: pay the contract seat; the dollar token calls the contract back during the payment
        bytes memory dataA = abi.encodeCall(Treasury.draw, (address(re), amount));
        uint256 nA = _propose(s1, dataA);
        _agree(s2, dataA, nA);
        re.arm(council, address(t), dataB, nB);
        usd.setHooked(address(re), true);
        _agree(s3, dataA, nA);
        assertTrue(re.tried(), "the dollar token called the seat back");
        assertEq(re.caught(), Council.Reentrancy.selector, "a seat cannot agree while a call runs");
        assertEq(usd.balanceOf(address(re)), amount, "the draw itself went through");
        assertTrue(t.doorFlag(), "call B did not run inside call A");
        assertEq(council.agreedCount(council.callId(address(t), dataB, nB)), 2, "call B is still pending");
    }

    function test_theCouncilHoldsNoDollarsAndTakesNoValue() public {
        assertEq(usd.balanceOf(address(council)), 0);
        assertEq(address(council).balance, 0);
        vm.deal(s1, 1 ether);
        vm.prank(s1);
        (bool ok,) = address(council).call{value: 1}(abi.encodeCall(Council.propose, (address(t), _drawData(1))));
        assertFalse(ok, "propose is not payable");
        (ok,) = address(council).call{value: 1}("");
        assertFalse(ok, "there is no receive function");
        assertEq(address(council).balance, 0);
    }

    // ---- the list

    function _word(bytes4 sel, uint256 words) internal pure returns (bytes memory) {
        return abi.encodePacked(sel, new bytes(32 * words));
    }

    function test_theListIsTheRunnersCallsAndNothingElse() public view {
        bytes4[15] memory ok = [
            Treasury.draw.selector,
            Treasury.checkIn.selector,
            Treasury.proposeRate.selector,
            Treasury.setRate.selector,
            Treasury.setDoor.selector,
            Treasury.announceTask.selector,
            Treasury.acceptTask.selector,
            Treasury.rejectTask.selector,
            Treasury.cancelTask.selector,
            Treasury.grantTeam.selector,
            Treasury.setAgent.selector,
            Treasury.authoriseAgent.selector,
            Treasury.revokeAgent.selector,
            Treasury.handOver.selector,
            Treasury.windDown.selector
        ];
        for (uint256 i; i < ok.length; ++i) {
            assertTrue(council.listed(address(t), _word(ok[i], 2)), "on the list");
        }
        // a hand-over that trims the founder is Pair-only
        assertFalse(council.listed(address(t), abi.encodeCall(Treasury.handOver, (s6, true))));
        assertTrue(council.listed(address(t), abi.encodeCall(Treasury.handOver, (s6, false))));
        // a malformed hand-over (a flag word that is not zero, or a wrong length) is not on the list
        assertFalse(
            council.listed(address(t), abi.encodePacked(Treasury.handOver.selector, uint256(uint160(s6)), uint256(2)))
        );
        assertFalse(council.listed(address(t), abi.encodePacked(Treasury.handOver.selector, uint256(uint160(s6)))));
        assertFalse(
            council.listed(address(t), abi.encodePacked(abi.encodeCall(Treasury.handOver, (s6, false)), uint8(0)))
        );
        // a forfeit without the member's say is Pair-only
        assertFalse(council.listed(address(t), abi.encodeCall(Treasury.announceForfeit, (1))));
        assertFalse(council.listed(address(t), abi.encodeCall(Treasury.takeSeat, ())));
        assertFalse(council.listed(address(t), abi.encodeCall(Treasury.join, (1e6, 0, s6))));
        assertFalse(council.listed(address(t), abi.encodeCall(Treasury.settle, ())));
        assertFalse(council.listed(address(t), hex"01"), "no selector");
        assertFalse(council.listed(address(t), ""));
        // the Launcher: only the wind-down
        assertTrue(council.listed(address(launcher), abi.encodeWithSignature("windDown(bytes32)", key)));
        assertFalse(council.listed(address(launcher), abi.encodeWithSignature("makePair(bytes32,address)", key, s6)));
        assertFalse(
            council.listed(
                address(launcher), abi.encodeWithSignature("setSettings((address,address,uint16,uint32,uint128))", 0)
            )
        );
        assertFalse(council.listed(address(launcher), abi.encodeCall(Treasury.draw, (s6, 1))));
        // any other target
        assertFalse(council.listed(s6, abi.encodeCall(Treasury.draw, (s6, 1))));
    }

    function test_aCallOffTheListOrToAnotherTargetCannotBeProposed() public {
        uint256 stored = council.nonce();
        vm.expectRevert(Council.BadTarget.selector);
        _propRaw(s1, s6, _drawData(1));
        vm.expectRevert(Council.BadTarget.selector);
        _propRaw(s1, address(usd), abi.encodeWithSignature("transfer(address,uint256)", s6, 1));
        vm.expectRevert(Council.BadCall.selector);
        _propRaw(s1, address(t), abi.encodeCall(Treasury.announceForfeit, (0)));
        vm.expectRevert(Council.BadCall.selector);
        _propRaw(s1, address(t), abi.encodeCall(Treasury.handOver, (s6, true)));
        vm.expectRevert(Council.BadCall.selector);
        _propRaw(s1, address(t), abi.encodeCall(Treasury.takeSeat, ()));
        vm.expectRevert(Council.BadCall.selector);
        _propRaw(s1, address(t), "");
        vm.expectRevert(Council.BadCall.selector);
        _propRaw(s1, address(launcher), abi.encodeWithSignature("makePair(bytes32,address)", key, s6));
        assertEq(council.nonce(), stored, "nothing was stored");
    }

    function test_aProposalToTheLauncherToWindDownRunsAndDoesNotRunForOneSeat() public {
        bytes memory data = abi.encodeWithSignature("windDown(bytes32)", key);
        uint256 n = _proposeTo(s1, address(launcher), data);
        vm.prank(s2);
        council.agree(address(launcher), data, n);
        assertEq(t.windDownKind(), 0);
        vm.prank(s3);
        council.agree(address(launcher), data, n);
        assertEq(t.windDownKind(), 1, "wound down by choice, by three seats");
        // a seat on its own cannot wind it down, and neither can the Council outside a run
        vm.expectRevert(Launcher.NotRunner.selector);
        vm.prank(s1);
        launcher.windDown(key);
    }

    // ---- the Council through a bare clone

    function test_aBareCouncilReadsItsGateAndRunsAFakeTreasuryCall() public {
        FakeTreasury fake = new FakeTreasury(UNIT, address(this));
        Council c = _bareCouncil(fake, address(launcher), _five());
        fake.setCouncil(address(c));
        assertEq(c.vote(), address(this));
        assertFalse(fake.sawBothSigned());
        bytes memory data = abi.encodeCall(FakeTreasury.draw, (s6, 7));
        uint256 n = c.nonce();
        vm.prank(s1);
        c.propose(address(fake), data);
        vm.prank(s2);
        c.agree(address(fake), data, n);
        vm.prank(s3);
        c.agree(address(fake), data, n);
        assertEq(fake.draws(), 1);
        assertEq(fake.drawnAmount(), 7);
        assertTrue(fake.sawBothSigned(), "the Council was executing when the Treasury asked");
        assertFalse(c.bothSigned(), "and is not any more");
    }
}
