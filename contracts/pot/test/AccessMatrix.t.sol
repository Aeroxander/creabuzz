// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {StackBase} from "./helpers/StackBase.sol";
import {Treasury} from "../src/Treasury.sol";
import {Pair} from "../src/Pair.sol";
import {Vester} from "../src/Vester.sol";
import {Launcher} from "../src/Launcher.sol";
import {ITreasuryClock, IShares} from "../src/Interfaces.sol";

/// @notice Who can reach which gated call: a stranger, an agent, a lone Pair signer, the runner, the Launcher and the Vester
/// reach nothing outside their own rights, and no part can be set up twice.
contract AccessMatrixTest is StackBase {
    address internal agent = makeAddr("agent");

    function _expectAllRevert(address caller, address target, bytes[] memory calls, string memory who) internal {
        for (uint256 i; i < calls.length; ++i) {
            vm.prank(caller);
            (bool ok,) = target.call(calls[i]);
            assertFalse(ok, string.concat(who, " reached call #", vm.toString(i)));
        }
    }

    function _treasuryGated() internal view returns (bytes[] memory c) {
        c = new bytes[](20);
        c[0] = abi.encodeCall(Treasury.draw, (stranger, 1));
        c[1] = abi.encodeCall(Treasury.proposeRate, (1500));
        c[2] = abi.encodeCall(Treasury.setRate, (1));
        c[3] = abi.encodeCall(Treasury.setDoor, (false));
        c[4] = abi.encodeCall(Treasury.markWoundDown, ());
        c[5] = abi.encodeCall(Treasury.forfeitAnnounced, (1));
        c[6] = abi.encodeCall(Treasury.forfeitBurn, (1));
        c[7] = abi.encodeCall(Treasury.burnAfterWindDown, (1));
        c[8] = abi.encodeCall(Treasury.announceForfeit, (0));
        c[9] = abi.encodeCall(Treasury.setAgent, (stranger, 1e18, 1e18));
        c[10] = abi.encodeCall(Treasury.authoriseAgent, (stranger));
        c[11] = abi.encodeCall(Treasury.revokeAgent, (agent));
        c[12] = abi.encodeCall(Treasury.handOver, (stranger, false));
        c[13] = abi.encodeCall(Treasury.takeSeat, ());
        c[14] = abi.encodeCall(Treasury.checkIn, (bytes32(uint256(1))));
        c[15] = abi.encodeCall(Treasury.windDown, ());
        c[16] = abi.encodeCall(Treasury.grantTeam, (stranger, 1));
        c[17] = abi.encodeCall(Treasury.onTransferReceived, (stranger, stranger, 1e6, abi.encode(uint256(0), stranger)));
        c[18] = abi.encodeCall(Treasury.leave, (1e18, 0, stranger)); // no shares
        c[19] = abi.encodeCall(Treasury.leaveTeam, (1e18, 0, stranger)); // no team shares
    }

    function test_strangerReachesNothingGated() public {
        _join(alice, 10_000e6);
        _expectAllRevert(stranger, address(t), _treasuryGated(), "stranger");
    }

    function test_agentReachesOnlyDrawAndGrantInsideLimits() public {
        _join(alice, 10_000e6);
        vm.prank(founder);
        t.authoriseAgent(agent);
        bytes[] memory c = _treasuryGated();
        // agent may legitimately call draw (index 0) and grantTeam (16) inside limits; skip those, everything else must fail
        for (uint256 i; i < c.length; ++i) {
            if (i == 0 || i == 16) continue;
            vm.prank(agent);
            (bool ok,) = address(t).call(c[i]);
            assertFalse(ok, string.concat("agent reached call #", vm.toString(i)));
        }
    }

    function test_oneSignerAloneReachesNothingButCheckIn() public {
        _join(alice, 10_000e6);
        Pair pair = _makePair(bob);
        vm.warp(block.timestamp + 5 days);
        bytes[] memory c = _treasuryGated();
        // both signers EOA-call the Treasury directly: not the runner
        _expectAllRevert(founder, address(t), c, "founder direct");
        _expectAllRevert(bob, address(t), c, "bob direct");
        // through the Pair without confirmation: propose only, proposer cannot confirm own call
        vm.prank(founder);
        pair.propose(address(t), c[0]);
        vm.prank(founder);
        vm.expectRevert(Pair.NotAllowed.selector);
        pair.confirm(address(t), c[0], 0);
        // stranger cannot use the Pair at all
        vm.prank(stranger);
        vm.expectRevert(Pair.NotAllowed.selector);
        pair.propose(address(t), c[0]);
        vm.prank(stranger);
        vm.expectRevert(Pair.NotAllowed.selector);
        pair.checkIn(bytes32(0));
        // the Launcher's wind-down needs both
        vm.prank(founder);
        vm.expectRevert(Launcher.NotRunner.selector);
        launcher.windDown(key);
        // a Pair cannot be asked to call anything but the Treasury or the Launcher
        vm.prank(founder);
        vm.expectRevert(Pair.BadTarget.selector);
        pair.propose(address(usd), abi.encodeWithSignature("mint(address,uint256)", founder, 1e30));
        // signer alone may check in
        vm.prank(bob);
        pair.checkIn(bytes32(uint256(7)));
    }

    function test_vesterAndTokensAndLauncherGated() public {
        _join(alice, 10_000e6);
        // Vester
        bytes[] memory vc = new bytes[](3);
        vc[0] = abi.encodeCall(Vester.grant, (stranger, 1e18, false));
        vc[1] = abi.encodeCall(Vester.announceByRunner, (0));
        vc[2] = abi.encodeCall(Vester.exitAll, (founder));
        _expectAllRevert(founder, address(v), vc, "runner->vester");
        _expectAllRevert(address(launcher), address(v), vc, "launcher->vester");
        // tokens
        bytes[] memory sc = new bytes[](2);
        sc[0] = abi.encodeWithSignature("mint(address,uint256)", founder, 1e18);
        sc[1] = abi.encodeWithSignature("burnFor(address,uint256)", alice, 1e18);
        _expectAllRevert(founder, address(shares), sc, "runner->shares");
        _expectAllRevert(address(launcher), address(shares), sc, "launcher->shares");
        _expectAllRevert(founder, address(team), sc, "runner->team");
        _expectAllRevert(address(v), address(team), sc, "vester->team");
        // re-initialisation of everything
        vm.expectRevert();
        shares.initialize("x", "x", stranger, address(0), 0);
        vm.expectRevert();
        team.initialize("x", "x", stranger, stranger, 1e18);
        vm.expectRevert();
        v.initialize(ITreasuryClock(address(t)), IShares(address(team)), 0);
        Treasury.Setup memory su = Treasury.Setup({
            quote: t.quote(),
            shares: t.shares(),
            team: t.team(),
            vester: address(v),
            founder: stranger,
            platform: stranger,
            salePath: stranger,
            unit: 7 days,
            ratePpm: 1,
            feeBps: 0,
            agentUsd: 0,
            agentTeam: 0
        });
        vm.expectRevert(Treasury.BadSetup.selector);
        t.initialize(su);
        // launcher admin
        vm.prank(stranger);
        vm.expectRevert(Launcher.NotAdmin.selector);
        launcher.transferAdmin(stranger);
        vm.prank(founder);
        vm.expectRevert(Launcher.NotAdmin.selector);
        launcher.setSettings(_platform(UNIT));
        // the Launcher itself cannot move a project's money: only markWoundDown (and not for strangers)
        vm.prank(stranger);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.markWoundDown();
    }

    // A Pair of the same signer twice is refused, and the offer to it leaves the founder in the seat.
    function test_pairWithSameSignerTwiceCannotBrickTheSeat() public {
        address predicted = launcher.pairAddress(key, founder, founder);
        vm.prank(founder);
        t.handOver(predicted, false);
        vm.prank(founder);
        vm.expectRevert(Pair.BadSetup.selector);
        launcher.makePair(key, founder);
        assertEq(t.runner(), founder);
        // and the founder can still act
        vm.prank(founder);
        t.setDoor(false);
    }
}
