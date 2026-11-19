// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {StackBase} from "./helpers/StackBase.sol";
import {Treasury} from "../src/Treasury.sol";
import {Pair} from "../src/Pair.sol";
import {Launcher} from "../src/Launcher.sol";
import {ITreasuryRunner} from "../src/Interfaces.sol";

/// @notice A second signer who can sit in the Pair and watch what the Pair does while a proposal executes: it is the Pair's
/// second signer, a hooked dollar receiver, and records what it sees.
contract Probe {
    Pair public pair;
    bool public sawBothSigned;
    bool public sawAfter;
    bytes4 public nestedError;
    address public nestedTarget;
    bytes public nestedData;
    uint256 public nestedN;
    uint256 public hooks;

    function arm(Pair pair_, address target, bytes calldata data, uint256 n) external {
        (pair, nestedTarget, nestedData, nestedN) = (pair_, target, data, n);
    }

    function confirm(address target, bytes calldata data, uint256 n) external {
        pair.confirm(target, data, n);
        sawAfter = pair.bothSigned();
    }

    function onQuoteTransfer(address, address, uint256, bool) external {
        ++hooks;
        sawBothSigned = pair.bothSigned();
        try pair.confirm(nestedTarget, nestedData, nestedN) {}
        catch (bytes memory r) {
            nestedError = bytes4(r);
        }
    }
}

/// @notice The two-signer runner: every call that moves money or changes a rule needs both, either signer alone may check in,
/// a proposal names its exact call and runs once, and a puppet second signer lifts no limit.
contract PairTest is StackBase {
    Pair internal pair;

    function setUp() public override {
        super.setUp();
        _join(alice, 100_000e6);
        pair = _makePair(bob);
        vm.warp(block.timestamp + 5 days);
        _checkIn();
    }

    // ---- birth

    function test_theSecondSignerAcceptsAndThePairBecomesTheRunner() public {
        assertEq(t.runner(), address(pair));
        assertEq(pair.first(), founder);
        assertEq(pair.second(), bob);
        assertTrue(launcher.isPair(address(pair)));
        assertEq(address(pair.treasury()), address(t));
        assertEq(pair.launcher(), address(launcher));
    }

    function test_aPairCannotBeSetUpTwiceOrByAStranger() public {
        vm.prank(stranger);
        vm.expectRevert(Pair.BadSetup.selector);
        pair.initialize(ITreasuryRunner(address(t)), stranger, stranger, alice);
        vm.prank(address(launcher));
        vm.expectRevert(Pair.BadSetup.selector);
        pair.initialize(ITreasuryRunner(address(t)), address(launcher), founder, alice);
        Pair impl = Pair(launcher.pairImpl());
        vm.prank(address(launcher));
        vm.expectRevert(Pair.BadSetup.selector);
        impl.initialize(ITreasuryRunner(address(t)), address(launcher), founder, alice);
    }

    function test_theSecondSignerMustBeSomeoneElseAndTheSeatMustHaveBeenOffered() public {
        _use(_launch(alice, "other", 1000, POOL));
        vm.prank(carol);
        vm.expectRevert(Treasury.NotAllowed.selector); // the seat was never offered to this Pair
        launcher.makePair(key, alice);
        address self = launcher.pairAddress(key, alice, alice);
        vm.prank(alice);
        t.handOver(self, false);
        vm.prank(alice);
        vm.expectRevert(Pair.BadSetup.selector); // two different people
        launcher.makePair(key, alice);
    }

    // ---- both signers for money

    function test_aDrawNeedsBothSignersAndRunsOnce() public {
        t.settle();
        bytes memory data = abi.encodeCall(Treasury.draw, (carol, 50e6));
        uint256 n = pair.nonce();
        vm.prank(founder);
        pair.propose(address(t), data);
        // the proposer cannot confirm their own call
        vm.prank(founder);
        vm.expectRevert(Pair.NotAllowed.selector);
        pair.confirm(address(t), data, n);
        // a stranger can do neither
        vm.prank(stranger);
        vm.expectRevert(Pair.NotAllowed.selector);
        pair.propose(address(t), data);
        vm.prank(stranger);
        vm.expectRevert(Pair.NotAllowed.selector);
        pair.confirm(address(t), data, n);
        assertEq(usd.balanceOf(carol), 0);
        vm.prank(bob);
        pair.confirm(address(t), data, n);
        assertEq(usd.balanceOf(carol), 50e6);
        // the proposal is spent
        vm.prank(bob);
        vm.expectRevert(Pair.UnknownCall.selector);
        pair.confirm(address(t), data, n);
    }

    function test_theOtherSignerMayConfirmToo() public {
        _both(pair, bob, founder, abi.encodeCall(Treasury.draw, (carol, 10e6)));
        assertEq(usd.balanceOf(carol), 10e6);
    }

    function test_noOneSignerLaneExists() public {
        // the Pair has no spend, execute or draw of its own
        bytes[4] memory calls = [
            abi.encodeWithSignature("spend(address,uint256)", carol, 1),
            abi.encodeWithSignature("draw(address,uint256)", carol, 1),
            abi.encodeWithSignature("execute(address,bytes)", address(t), ""),
            abi.encodeWithSignature("spendAlone(address,uint256)", carol, 1)
        ];
        for (uint256 i; i < calls.length; ++i) {
            vm.prank(founder);
            (bool ok,) = address(pair).call(calls[i]);
            assertFalse(ok);
        }
        // and the Treasury refuses the Pair's own address outside a confirmed proposal, for every runner-only call
        vm.startPrank(address(pair));
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.draw(carol, 1e6);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.setRate(1);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.proposeRate(2000);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.setDoor(false);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.handOver(carol, false);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.windDown();
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.setAgent(carol, 1, 1);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.authoriseAgent(carol);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.revokeAgent(carol);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.grantTeam(carol, 1e18);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.announceForfeit(0);
        vm.stopPrank();
    }

    function test_eitherSignerAloneMayCheckInAndNoOneElse() public {
        uint256 before = t.lastCheckIn();
        vm.warp(block.timestamp + 1 days);
        vm.prank(founder);
        pair.checkIn(bytes32(uint256(1)));
        assertEq(t.lastCheckIn(), block.timestamp);
        assertGt(t.lastCheckIn(), before);
        vm.warp(block.timestamp + 1 days);
        vm.prank(bob);
        pair.checkIn(bytes32(uint256(2)));
        assertEq(t.lastCheckIn(), block.timestamp);
        vm.prank(stranger);
        vm.expectRevert(Pair.NotAllowed.selector);
        pair.checkIn(bytes32(0));
    }

    // ---- bothSigned

    function test_bothSignedIsTrueOnlyWhileAConfirmedProposalExecutes() public {
        Probe probe = new Probe();
        usd.setHooked(address(probe), true);
        // a Pair whose second signer is the probe
        _use(_launch(alice, "probed", 1000, POOL));
        _joinIn(t, alice, 100_000e6);
        address predicted = launcher.pairAddress(key, alice, address(probe));
        vm.prank(alice);
        t.handOver(predicted, false);
        vm.prank(address(probe));
        Pair p = Pair(launcher.makePair(key, alice));
        vm.warp(block.timestamp + 5 days);
        vm.prank(alice);
        p.checkIn(bytes32(0));
        t.settle();
        assertFalse(p.bothSigned());
        // two proposals: the outer draw pays the probe (which calls back inside the dollar's transfer); the nested one is
        // what the probe tries to confirm while the outer one runs
        bytes memory outer = abi.encodeCall(Treasury.draw, (address(probe), 10e6));
        bytes memory inner = abi.encodeCall(Treasury.setDoor, (false)); // not guarded by the Treasury's own lock
        vm.startPrank(alice);
        p.propose(address(t), outer); // nonce 0
        p.propose(address(t), inner); // nonce 1
        vm.stopPrank();
        probe.arm(p, address(t), inner, 1);
        probe.confirm(address(t), outer, 0);
        assertEq(probe.hooks(), 1);
        assertTrue(probe.sawBothSigned(), "true while the confirmed proposal runs");
        assertFalse(probe.sawAfter(), "false the moment it is over");
        assertFalse(p.bothSigned());
        assertEq(probe.nestedError(), Pair.Reentrancy.selector, "a nested confirm is refused");
        assertEq(usd.balanceOf(address(probe)), 10e6, "only the outer draw ran");
        assertTrue(t.doorFlag(), "the nested proposal did not run");
    }

    // ---- a proposal names its exact call

    function test_aProposalCannotBeReusedForAnotherCall() public {
        bytes memory data = abi.encodeCall(Treasury.draw, (carol, 10e6));
        uint256 n = pair.nonce();
        vm.prank(founder);
        pair.propose(address(t), data);
        // another amount, another payee, another selector, another target, another number
        bytes[3] memory others = [
            abi.encodeCall(Treasury.draw, (carol, 11e6)),
            abi.encodeCall(Treasury.draw, (stranger, 10e6)),
            abi.encodeCall(Treasury.setRate, (1))
        ];
        for (uint256 i; i < others.length; ++i) {
            vm.prank(bob);
            vm.expectRevert(Pair.UnknownCall.selector);
            pair.confirm(address(t), others[i], n);
        }
        vm.prank(bob);
        vm.expectRevert(Pair.UnknownCall.selector);
        pair.confirm(address(launcher), data, n);
        vm.prank(bob);
        vm.expectRevert(Pair.UnknownCall.selector);
        pair.confirm(address(t), data, n + 1);
        vm.prank(bob);
        pair.confirm(address(t), data, n);
        assertEq(usd.balanceOf(carol), 10e6);
    }

    function test_theSameCallProposedTwiceIsTwoProposals() public {
        bytes memory data = abi.encodeCall(Treasury.draw, (carol, 10e6));
        uint256 n = pair.nonce();
        vm.startPrank(founder);
        pair.propose(address(t), data);
        pair.propose(address(t), data);
        vm.stopPrank();
        vm.prank(bob);
        pair.confirm(address(t), data, n);
        vm.prank(bob);
        pair.confirm(address(t), data, n + 1);
        assertEq(usd.balanceOf(carol), 20e6);
    }

    function test_onlyTheProposerCancelsAndACancelledCallNeverRuns() public {
        bytes memory data = abi.encodeCall(Treasury.draw, (carol, 10e6));
        uint256 n = pair.nonce();
        vm.prank(founder);
        bytes32 id = pair.propose(address(t), data);
        vm.prank(bob);
        vm.expectRevert(Pair.NotAllowed.selector);
        pair.cancel(id);
        vm.prank(founder);
        pair.cancel(id);
        vm.prank(bob);
        vm.expectRevert(Pair.UnknownCall.selector);
        pair.confirm(address(t), data, n);
    }

    function test_callsGoOnlyToTheTreasuryOrTheLauncher() public {
        vm.prank(founder);
        vm.expectRevert(Pair.BadTarget.selector);
        pair.propose(address(usd), abi.encodeWithSignature("mint(address,uint256)", founder, 1e18));
        vm.prank(founder);
        vm.expectRevert(Pair.BadTarget.selector);
        pair.propose(address(shares), "");
    }

    function test_aFailingCallKeepsTheProposalPending() public {
        t.settle();
        uint256 box = t.box();
        bytes memory data = abi.encodeCall(Treasury.draw, (carol, box + 1));
        uint256 n = pair.nonce();
        vm.prank(founder);
        pair.propose(address(t), data);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Treasury.TooMuch.selector, box + 1, box));
        pair.confirm(address(t), data, n);
        assertEq(pair.proposer(pair.callId(address(t), data, n)), founder, "still pending");
        assertFalse(pair.bothSigned());
    }

    // ---- a puppet second signer lifts no limit

    function test_aPuppetSecondSignerLiftsNoLimit() public {
        t.settle();
        uint256 box = t.box();
        // more than the box
        bytes memory tooMuch = abi.encodeCall(Treasury.draw, (carol, box + 1));
        uint256 n = pair.nonce();
        vm.prank(founder);
        pair.propose(address(t), tooMuch);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Treasury.TooMuch.selector, box + 1, box));
        pair.confirm(address(t), tooMuch, n);
        // above the allowance ceiling
        bytes memory rate = abi.encodeCall(Treasury.proposeRate, (2001));
        n = pair.nonce();
        vm.prank(founder);
        pair.propose(address(t), rate);
        vm.prank(bob);
        vm.expectRevert(Treasury.BadInput.selector);
        pair.confirm(address(t), rate, n);
        // more Team Shares than the pool
        bytes memory grant = abi.encodeCall(Treasury.grantTeam, (carol, POOL + 1));
        n = pair.nonce();
        vm.prank(founder);
        pair.propose(address(t), grant);
        vm.prank(bob);
        vm.expectRevert();
        pair.confirm(address(t), grant, n);
        // a raised rate still waits a whole unit
        _both(pair, founder, bob, abi.encodeCall(Treasury.proposeRate, (2000)));
        vm.expectRevert();
        t.applyRate();
        // an agent's limits are the same whoever set it
        _both(pair, founder, bob, abi.encodeCall(Treasury.authoriseAgent, (carol)));
        vm.prank(carol);
        vm.expectRevert();
        t.draw(carol, 26e6);
    }

    function test_theSeatCanBeHandedOnOnlyWithBothSigners() public {
        _both(pair, founder, bob, abi.encodeCall(Treasury.handOver, (carol, false)));
        vm.prank(carol);
        t.takeSeat();
        assertEq(t.runner(), carol);
        // the old Pair can no longer check in
        vm.prank(founder);
        vm.expectRevert(Treasury.NotAllowed.selector);
        pair.checkIn(bytes32(0));
    }

    function test_theClockIsSettledBeforeEitherSignersCheckIn() public {
        // a long lapse then a check-in by one signer alone grows the box only by the time inside the old window
        vm.warp(block.timestamp + 60 days);
        vm.prank(bob);
        pair.checkIn(bytes32(0));
        assertLe(t.box(), t.boxCap());
        assertEq(t.activeNow(), 5 days + 2 * UNIT, "the lapse was not counted: only the old window");
    }
}
