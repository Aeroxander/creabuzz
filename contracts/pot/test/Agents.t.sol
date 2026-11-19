// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {StackBase} from "./helpers/StackBase.sol";
import {Treasury} from "../src/Treasury.sol";
import {Vester} from "../src/Vester.sol";
import {Pair} from "../src/Pair.sol";
import {RollingCap} from "../src/RollingCap.sol";

/// @notice Agents act only inside their own daily limits: dollars drawn from the same box as the runner's, and Team Shares
/// granted inside 1/1000 of the pool. A hand-over switches every agent off, and an agent can do nothing else.
contract AgentsTest is StackBase {
    address internal agent = makeAddr("agent");

    function setUp() public override {
        super.setUp();
        _join(alice, 100_000e6);
        vm.warp(block.timestamp + 5 days); // the box holds about 490 dollars
        _checkIn();
        t.settle();
        assertGt(t.box(), 400e6);
    }

    function _authorise() internal {
        vm.prank(founder);
        t.authoriseAgent(agent);
    }

    function _drawAs(address who, uint256 amount) internal {
        vm.prank(who);
        t.draw(who, amount);
    }

    // ---- who sets agents

    function test_onlyTheRunnerSetsAgentsAndTheDefaultsAreTheDocumentedOnes() public {
        vm.prank(stranger);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.authoriseAgent(agent);
        vm.prank(stranger);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.setAgent(agent, 1, 1);
        vm.prank(stranger);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.revokeAgent(agent);
        vm.prank(founder);
        vm.expectRevert(Treasury.BadInput.selector);
        t.setAgent(address(0), 1, 1);
        _authorise();
        (bool active, uint128 usdCap, uint128 shareCap) = t.agents(agent);
        assertTrue(active);
        assertEq(usdCap, 25e6, "25 dollars a day");
        assertEq(shareCap, POOL / 1000, "1/1000 of the Team pool a day");
    }

    // ---- dollars

    function test_anAgentDrawsInsideItsDailyLimitFromTheSameBox() public {
        _authorise();
        uint256 box = t.box();
        _drawAs(agent, 25e6);
        assertEq(usd.balanceOf(agent), 25e6);
        assertEq(t.box(), box - 25e6, "the agent drew from the box");
        assertEq(t.agentUsdUsed(agent), 25e6);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(RollingCap.CapExceeded.selector, 25e6, 1, 25e6));
        t.draw(agent, 1);
    }

    function test_theDailyLimitCountsForAtLeast24HoursAndFreesBy28() public {
        _authorise();
        _drawAs(agent, 25e6);
        vm.warp(block.timestamp + 24 hours - 1);
        _checkIn();
        vm.prank(agent);
        vm.expectRevert();
        t.draw(agent, 1e6);
        vm.warp(block.timestamp + 4 hours + 1);
        _checkIn();
        _drawAs(agent, 25e6); // a new day's limit
        assertEq(usd.balanceOf(agent), 50e6);
    }

    function test_anAgentCannotDrawMoreThanTheBoxHolds() public {
        vm.prank(founder);
        t.setAgent(agent, 1_000_000e6, 0);
        uint256 box = t.box();
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(Treasury.TooMuch.selector, box + 1, box));
        t.draw(agent, box + 1);
    }

    function test_anAgentCannotSendToTheProjectsOwnAddresses() public {
        _authorise();
        address[6] memory bad = [address(0), address(t), address(usd), address(shares), address(team), address(v)];
        for (uint256 i; i < bad.length; ++i) {
            vm.prank(agent);
            vm.expectRevert(Treasury.BadInput.selector);
            t.draw(bad[i], 1e6);
        }
    }

    function test_aStrangerOrAnUnsetOrRevokedAgentDrawsNothing() public {
        vm.prank(stranger);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.draw(stranger, 1e6);
        vm.prank(agent);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.draw(agent, 1e6);
        _authorise();
        vm.prank(founder);
        t.revokeAgent(agent);
        vm.prank(agent);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.draw(agent, 1e6);
    }

    function test_settingAnAgentAgainDoesNotResetWhatItUsed() public {
        _authorise();
        _drawAs(agent, 20e6);
        _authorise(); // set again, as a runner might to change a limit
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(RollingCap.CapExceeded.selector, 20e6, 6e6, 25e6));
        t.draw(agent, 6e6);
        vm.prank(founder);
        t.revokeAgent(agent);
        _authorise();
        vm.prank(agent);
        vm.expectRevert();
        t.draw(agent, 6e6);
    }

    function test_aHandOverSwitchesEveryAgentOff() public {
        _authorise();
        vm.prank(founder);
        t.handOver(bob, false);
        _drawAs(agent, 1e6); // still the founder's agent until the seat is taken
        vm.prank(bob);
        t.takeSeat();
        vm.prank(agent);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.draw(agent, 1e6);
        vm.prank(agent);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.grantTeam(agent, 1e18);
        // the new runner may switch it on again
        vm.prank(bob);
        t.authoriseAgent(agent);
        _drawAs(agent, 1e6);
    }

    // ---- Team Shares

    function test_anAgentGrantsInsideOneThousandthOfThePoolADay() public {
        _authorise();
        uint256 cap = POOL / 1000;
        vm.prank(agent);
        t.grantTeam(bob, cap);
        assertEq(v.grantOf(0).total, cap);
        assertEq(t.agentTeamUsed(agent), cap);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(RollingCap.CapExceeded.selector, cap, 1, cap));
        t.grantTeam(bob, 1);
        vm.warp(block.timestamp + 28 hours);
        _checkIn();
        vm.prank(agent);
        t.grantTeam(carol, cap);
        assertEq(v.grantOf(1).member, carol);
    }

    function test_theTwoDailyLimitsAreSeparate() public {
        _authorise();
        _drawAs(agent, 25e6);
        vm.prank(agent);
        t.grantTeam(bob, POOL / 1000);
        assertEq(t.agentUsdUsed(agent), 25e6);
        assertEq(t.agentTeamUsed(agent), POOL / 1000);
    }

    function test_anAgentCannotGrantMoreThanThePoolEvenWithAHugeLimit() public {
        vm.prank(founder);
        t.setAgent(agent, 0, type(uint128).max);
        vm.prank(agent);
        vm.expectRevert(Vester.NotFunded.selector);
        t.grantTeam(bob, POOL + 1);
    }

    function test_aStrangerAndAnInactiveAgentGrantNothing() public {
        vm.prank(stranger);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.grantTeam(bob, 1e18);
        _authorise();
        vm.prank(founder);
        t.revokeAgent(agent);
        vm.prank(agent);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.grantTeam(bob, 1e18);
    }

    // ---- everything else is the runner's

    function test_anAgentCanDoNothingButDrawAndGrantInsideItsLimits() public {
        _authorise();
        vm.startPrank(agent);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.checkIn(bytes32(0));
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.setRate(1);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.proposeRate(2000);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.setDoor(false);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.handOver(agent, false);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.windDown();
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.markWoundDown();
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.setAgent(agent, type(uint128).max, type(uint128).max);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.announceForfeit(0);
        vm.stopPrank();
    }

    // ---- a Pair runner

    function test_withAPairRunnerAgentsNeedBothSignersToBeSet() public {
        Pair pair = _makePair(bob);
        vm.prank(address(pair));
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.authoriseAgent(agent);
        _both(pair, founder, bob, abi.encodeCall(Treasury.authoriseAgent, (agent)));
        _drawAs(agent, 25e6);
        assertEq(usd.balanceOf(agent), 25e6);
        _both(pair, bob, founder, abi.encodeCall(Treasury.revokeAgent, (agent)));
        vm.prank(agent);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.draw(agent, 1e6);
    }
}
