// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {PotBase} from "./helpers/PotBase.sol";
import {MockPair} from "./helpers/Mocks.sol";
import {Treasury} from "../src/Treasury.sol";

/// @notice A stand-in for the project's vote contract (its `pauseGate`): it can say "move the seat to this Council".
contract MockGate {
    function go(Treasury t, address council) external {
        t.seatByVote(council);
    }

    function paused() external pure returns (bool) {
        return false;
    }

    function poke() external {}
}

/// @notice `Treasury.seatByVote`: only the project's gate, only a runner contract the Launcher says is a Council, and what the
/// move leaves behind (nothing the old runner left can reach the new one), and that `takeSeat` is untouched by it.
contract SeatByVoteTest is PotBase {
    MockGate internal gate;
    MockPair internal council;
    MockPair internal pair;
    address internal puppet = makeAddr("puppet");
    address internal agent = makeAddr("agent");

    function setUp() public override {
        super.setUp();
        gate = new MockGate();
        vm.prank(address(sale));
        t.bindPause(address(gate));
        council = new MockPair(alice, bob);
        sale.setCouncilLike(address(council), true);
        pair = new MockPair(founder, bob);
        sale.setPair(address(pair), true);
        _join(alice, 50_000e6);
        vm.warp(block.timestamp + 2 days);
        vm.prank(founder);
        t.checkIn(bytes32(0));
    }

    function test_onlyTheProjectsGateMayMoveTheSeat() public {
        address[4] memory nobody = [stranger, founder, address(council), alice];
        for (uint256 i; i < nobody.length; ++i) {
            vm.expectRevert(Treasury.NotAllowed.selector);
            vm.prank(nobody[i]);
            t.seatByVote(address(council));
        }
        assertEq(t.runner(), founder);
        gate.go(t, address(council));
        assertEq(t.runner(), address(council));
    }

    function test_aProjectWithNoGateCannotBeMovedByAnyone() public {
        _relaunch(POOL, 1000); // a new Treasury with no gate bound
        assertEq(t.pauseGate(), address(0));
        vm.expectRevert(Treasury.NotAllowed.selector);
        gate.go(t, address(council));
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.seatByVote(address(council));
        vm.expectRevert(Treasury.NotAllowed.selector);
        vm.prank(address(0));
        t.seatByVote(address(council));
    }

    function test_onlyARunnerContractOfKindTwoCanTakeTheSeat() public {
        vm.expectRevert(Treasury.NotAllowed.selector);
        gate.go(t, stranger); // not a runner contract at all
        vm.expectRevert(Treasury.NotAllowed.selector);
        gate.go(t, address(pair)); // a Pair
        vm.expectRevert(Treasury.NotAllowed.selector);
        gate.go(t, address(0));
        gate.go(t, address(council));
    }

    function test_theMoveSaysWhoLostAndWhoWonAndSwitchesTheHelpersOff() public {
        vm.prank(founder);
        t.authoriseAgent(agent);
        uint256 epoch = t.agentEpoch();
        vm.recordLogs();
        gate.go(t, address(council));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 changed;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(t) && logs[i].topics[0] == Treasury.RunnerChanged.selector) {
                ++changed;
                assertEq(address(uint160(uint256(logs[i].topics[1]))), founder);
                assertEq(address(uint160(uint256(logs[i].topics[2]))), address(council));
            }
        }
        assertEq(changed, 1);
        assertEq(t.agentEpoch(), epoch + 1, "the old runner's helpers are switched off");
        vm.warp(block.timestamp + 1 days);
        vm.prank(agent);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.draw(agent, 1e6);
    }

    function test_anOfferTheOldRunnerMadeToAPuppetDiesAtTheSeat() public {
        vm.prank(founder);
        t.handOver(puppet, true); // a trimming offer, to a puppet, made during the wait
        assertEq(t.pendingRunner(), puppet);
        gate.go(t, address(council));
        assertEq(t.pendingRunner(), address(0));
        assertFalse(t.pendingTrim());
        assertEq(t.pendingSeatAt(), 0);
        vm.prank(puppet);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.takeSeat();
        assertEq(t.runner(), address(council));
        assertEq(vester.exitCalls(), 0, "a vote never trims a grant");
    }

    function test_aRateTheOldRunnerProposedDiesAtTheSeat() public {
        vm.prank(founder);
        t.proposeRate(1800);
        assertEq(t.pendingRatePpm(), 1800);
        assertGt(t.pendingAt(), 0);
        gate.go(t, address(council));
        assertEq(t.pendingRatePpm(), 0);
        assertEq(t.pendingAt(), 0);
        vm.warp(block.timestamp + 7 days);
        vm.expectRevert();
        t.applyRate();
        assertEq(t.ratePpm(), 1000, "the rate stayed where it was");
    }

    function test_aPlainHandOverStillLeavesTheRateAndTheEarlierRulesAlone() public {
        // `takeSeat` shares the move with the vote, but only the vote clears a pending rate
        vm.prank(founder);
        t.proposeRate(1800);
        vm.prank(founder);
        t.handOver(puppet, false);
        vm.prank(puppet);
        t.takeSeat();
        assertEq(t.runner(), puppet);
        assertEq(t.pendingRatePpm(), 1800, "a hand-over does not clear a pending rate");
        assertGt(t.pendingAt(), 0);
        assertEq(t.pendingRunner(), address(0), "but it does clear the offer");
    }

    function test_theVoteMovesTheSeatWhoeverHoldsItAPairIncluded() public {
        vm.prank(founder);
        t.handOver(address(pair), false);
        pair.exec(address(t), abi.encodeCall(Treasury.takeSeat, ()), false);
        assertEq(t.runner(), address(pair));
        gate.go(t, address(council));
        assertEq(t.runner(), address(council));
        // and again: a Council can be replaced by another Council
        MockPair council2 = new MockPair(carol, bob);
        sale.setCouncilLike(address(council2), true);
        gate.go(t, address(council2));
        assertEq(t.runner(), address(council2));
    }

    function test_theVoteDoesNotTouchAGrantOrAnyDollar() public {
        uint256 pot = t.pot();
        uint256 box = t.box();
        uint256 held = usd.balanceOf(address(t));
        gate.go(t, address(council));
        assertEq(vester.exitCalls(), 0);
        assertEq(t.pot(), pot);
        assertEq(t.box(), box);
        assertEq(usd.balanceOf(address(t)), held);
    }
}
