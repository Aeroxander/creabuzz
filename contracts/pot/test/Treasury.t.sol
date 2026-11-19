// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "oz5/token/ERC20/IERC20.sol";
import {Clones} from "oz5/proxy/Clones.sol";
import {PotBase} from "./helpers/PotBase.sol";
import {Treasury} from "../src/Treasury.sol";
import {IShares} from "../src/Interfaces.sol";
import {ShareToken} from "../src/ShareToken.sol";
import {TreasuryHarness} from "./helpers/TreasuryHarness.sol";
import {MockPair, MockVester} from "./helpers/Mocks.sol";

/// @notice Setup, the runner seat, the Pair money check, the Team Share burn hooks and the dollars-conserved script.
contract TreasuryTest is PotBase {
    // ---- initialize

    function _setup() internal view returns (Treasury.Setup memory s) {
        s = Treasury.Setup({
            quote: IERC20(address(usd)),
            shares: IShares(address(shares)),
            team: IShares(address(team)),
            vester: address(vester),
            founder: founder,
            platform: platform,
            salePath: address(sale),
            unit: UNIT,
            ratePpm: 1000,
            feeBps: 200,
            agentUsd: 25e6,
            agentTeam: 1
        });
    }

    function _fresh() internal returns (Treasury tr, Treasury.Setup memory s) {
        tr = Treasury(Clones.clone(address(treasuryImpl)));
        ShareToken sh = ShareToken(Clones.clone(address(tokenImpl)));
        ShareToken tm = ShareToken(Clones.clone(address(tokenImpl)));
        sh.initialize("S", "S", address(tr), address(0), 0);
        tm.initialize("T", "T", address(tr), address(vester), 100e18);
        s = _setup();
        s.shares = IShares(address(sh));
        s.team = IShares(address(tm));
    }

    function test_initializeOnceAndTheImplementationIsLocked() public {
        vm.expectRevert(Treasury.BadSetup.selector);
        t.initialize(_setup());
        vm.expectRevert(Treasury.BadSetup.selector);
        treasuryImpl.initialize(_setup());
    }

    function test_initializeRefusesBadInput() public {
        for (uint256 i; i < 10; ++i) {
            (Treasury tr, Treasury.Setup memory s) = _fresh();
            if (i == 0) s.founder = address(0);
            if (i == 1) s.platform = address(0);
            if (i == 2) s.salePath = address(0);
            if (i == 3) s.vester = address(0);
            if (i == 4) s.unit = 0;
            if (i == 5) s.unit = 7 days + 1; // not a multiple of 168
            if (i == 6) s.ratePpm = 2001;
            if (i == 7) s.feeBps = 501;
            if (i == 8) s.shares = IShares(address(shares)); // controlled by another Treasury
            if (i == 9) s.team = IShares(address(team));
            vm.expectRevert(Treasury.BadSetup.selector);
            tr.initialize(s);
        }
        // the limits themselves are allowed, and a short unit for a test network
        (Treasury ok, Treasury.Setup memory s2) = _fresh();
        s2.ratePpm = 2000;
        s2.feeBps = 500;
        s2.unit = 168;
        ok.initialize(s2);
        assertEq(ok.unit(), 168);
        assertEq(ok.runner(), founder);
        assertTrue(ok.doorFlag());
        assertEq(ok.lastCheckIn(), block.timestamp);
    }

    // ---- the runner seat

    function test_onlyTheRunnerMovesTheSwitches() public {
        vm.startPrank(stranger);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.setDoor(false);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.handOver(stranger, false);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.checkIn(bytes32(0));
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.takeSeat();
        vm.stopPrank();
    }

    function test_setDoorEmitsAndSticks() public {
        vm.expectEmit(false, false, false, true, address(t));
        emit Treasury.DoorSet(false);
        vm.prank(founder);
        t.setDoor(false);
        assertFalse(t.doorFlag());
    }

    function test_handOverAndTakeSeat() public {
        vm.startPrank(founder);
        vm.expectRevert(Treasury.BadInput.selector);
        t.handOver(address(0), false);
        vm.expectRevert(Treasury.BadInput.selector);
        t.handOver(founder, false);
        t.handOver(bob, false);
        vm.stopPrank();
        assertEq(t.pendingRunner(), bob);
        assertEq(t.runner(), founder, "nothing moves until the next runner takes the seat");
        vm.prank(carol);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.takeSeat();
        vm.expectEmit(true, true, false, true, address(t));
        emit Treasury.RunnerChanged(founder, bob);
        vm.prank(bob);
        t.takeSeat();
        assertEq(t.runner(), bob);
        assertEq(t.pendingRunner(), address(0));
        assertEq(t.agentEpoch(), 1, "agents set by earlier runners switch off");
        vm.prank(founder);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.setDoor(false);
        vm.prank(bob);
        t.setDoor(false);
    }

    function test_theFounderTrimRunsTheVestersOwnExit() public {
        vm.prank(founder);
        t.handOver(bob, true);
        assertEq(vester.exitCalls(), 0);
        vm.prank(bob);
        t.takeSeat();
        assertEq(vester.exitCalls(), 1);
        assertEq(vester.exited(), founder);
        // a later runner cannot cut the founder's grants
        vm.prank(bob);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.handOver(carol, true);
    }

    function test_aPairWithTheFounderMayOfferATrim() public {
        MockPair pair = new MockPair(founder, bob);
        sale.setPair(address(pair), true);
        vm.prank(founder);
        t.handOver(address(pair), false);
        (bool ok,) = pair.exec(address(t), abi.encodeCall(Treasury.takeSeat, ()), false);
        assertTrue(ok);
        (ok,) = pair.exec(address(t), abi.encodeCall(Treasury.handOver, (carol, true)), true);
        assertTrue(ok, "the founder is one of the two signers");
        MockPair strangers = new MockPair(alice, bob);
        sale.setPair(address(strangers), true);
        vm.prank(carol);
        t.takeSeat();
        vm.prank(carol);
        t.handOver(address(strangers), false);
        (ok,) = strangers.exec(address(t), abi.encodeCall(Treasury.takeSeat, ()), false);
        assertTrue(ok);
        (ok,) = strangers.exec(address(t), abi.encodeCall(Treasury.handOver, (alice, true)), true);
        assertFalse(ok, "a Pair without the founder cannot offer a trim");
    }

    // ---- the Pair money check

    function test_aPairRunnerNeedsBothSignersForMoneyAndRuleCallsButNotForCheckIn() public {
        _join(alice, 100_000e6);
        MockPair pair = new MockPair(founder, bob);
        sale.setPair(address(pair), true);
        vm.prank(founder);
        t.handOver(address(pair), false);
        pair.exec(address(t), abi.encodeCall(Treasury.takeSeat, ()), false);
        vm.warp(T0 + 1 days);
        bytes[5] memory calls = [
            abi.encodeCall(Treasury.draw, (bob, 1e6)),
            abi.encodeCall(Treasury.setRate, (500)),
            abi.encodeCall(Treasury.proposeRate, (2000)),
            abi.encodeCall(Treasury.setDoor, (false)),
            abi.encodeCall(Treasury.handOver, (carol, false))
        ];
        for (uint256 i; i < calls.length; ++i) {
            (bool ok,) = pair.exec(address(t), calls[i], false);
            assertFalse(ok, "one signer is not enough");
            (ok,) = pair.exec(address(t), calls[i], true);
            assertTrue(ok, "both signers are");
        }
        // a direct call by the Pair outside a confirmed proposal is the one-signer path: it fails
        vm.prank(address(pair));
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.draw(bob, 1);
        // either signer may check in: no both-signed flag needed
        (bool ok2,) = pair.exec(address(t), abi.encodeCall(Treasury.checkIn, (bytes32(uint256(1)))), false);
        assertTrue(ok2);
        assertEq(t.lastCheckIn(), block.timestamp);
    }

    // ---- Team Share burn hooks (called by the Vester)

    function test_burnHooksAreForTheVesterOnly() public {
        address[3] memory who = [stranger, founder, address(t)];
        for (uint256 i; i < who.length; ++i) {
            vm.startPrank(who[i]);
            vm.expectRevert(Treasury.NotAllowed.selector);
            t.forfeitAnnounced(1);
            vm.expectRevert(Treasury.NotAllowed.selector);
            t.forfeitBurn(1);
            vm.expectRevert(Treasury.NotAllowed.selector);
            t.burnAfterWindDown(1);
            vm.stopPrank();
        }
    }

    function test_announceThenBurnMovesZAndG() public {
        vm.expectEmit(false, false, false, true, address(t));
        emit Treasury.BurnAnnounced(3_000_000e18, 3_000_000e18);
        vm.prank(address(vester));
        t.forfeitAnnounced(3_000_000e18);
        assertEq(t.Z(), 3_000_000e18);
        assertEq(team.totalSupply(), POOL, "still counted in G until it burns");
        vm.prank(address(vester));
        t.forfeitBurn(3_000_000e18);
        assertEq(t.Z(), 0);
        assertEq(team.totalSupply(), POOL - 3_000_000e18);
        assertEq(team.balanceOf(address(vester)), POOL - 3_000_000e18);
    }

    function test_zCannotPassGAndABurnCannotPassZ() public {
        vm.startPrank(address(vester));
        vm.expectRevert(Treasury.BadInput.selector);
        t.forfeitAnnounced(POOL + 1);
        t.forfeitAnnounced(POOL);
        vm.expectRevert(Treasury.BadInput.selector);
        t.forfeitAnnounced(1);
        t.forfeitBurn(POOL / 2);
        vm.expectRevert(Treasury.BadInput.selector);
        t.forfeitBurn(POOL / 2 + 1);
        vm.stopPrank();
    }

    function test_burnAfterWindDownNeedsAWindDownAndLeavesZAlone() public {
        vm.startPrank(address(vester));
        t.forfeitAnnounced(1_000e18);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.burnAfterWindDown(5e18);
        vm.stopPrank();
        vm.prank(founder);
        t.windDown();
        vm.prank(address(vester));
        t.burnAfterWindDown(5e18);
        assertEq(team.totalSupply(), POOL - 5e18);
        assertEq(t.Z(), 1_000e18);
    }

    /// @dev Must-bind 6: after an announce, a join is priced as if the burn had already happened. A project with the
    /// smaller pool from the start gives the very same Shares; a leave still pays on all of G until the burn.
    function test_aJoinIsPricedWithTheAnnouncedBurnTakenOut() public {
        _join(alice, 100_000e6);
        _force(120_000e6, 98_000e6, 0, 0, 0);
        TreasuryHarness x = t;
        ShareToken xShares = shares;
        ShareToken xTeam = team;
        // the same project with a 7M pool from birth
        _relaunch(POOL - 3_000_000e18, 1000);
        _join(alice, 100_000e6);
        _force(120_000e6, 98_000e6, 0, 0, 0);
        TreasuryHarness y = t;
        ShareToken yShares = shares;

        vm.prank(address(vester)); // y's own Vester announces nothing here; x's does
        y.forfeitAnnounced(0);

        MockVester xv = MockVester(x.vester());
        vm.prank(address(xv));
        x.forfeitAnnounced(3_000_000e18);

        // identical joins
        (uint256 qx,,,) = x.quoteBack(10_000e6);
        (uint256 qy,,,) = y.quoteBack(10_000e6);
        assertEq(qx, qy, "priced as if the 3M were already burnt");
        assertEq(_joinOn(x, bob, 10_000e6), _joinOn(y, bob, 10_000e6));
        assertEq(xShares.balanceOf(bob), yShares.balanceOf(bob));

        // a leave on x still pays on the full G (the burn has not happened): less than on y
        uint256 n = xShares.balanceOf(bob);
        vm.prank(bob);
        uint256 cashX = x.leave(n, 0, bob);
        vm.prank(bob);
        uint256 cashY = y.leave(n, 0, bob);
        assertLt(cashX, cashY);
        xTeam; // silence
    }

    function _joinOn(TreasuryHarness tr, address who, uint256 amount) internal returns (uint256 n) {
        usd.mint(who, amount);
        vm.startPrank(who);
        usd.approve(address(tr), amount);
        n = tr.join(amount, 0, who);
        vm.stopPrank();
    }

    // ---- settle, events and views

    function test_settleIsPublicAndEmitsTheNumbersToRebuildFrom() public {
        _join(alice, 100_000e6);
        vm.warp(T0 + 1 days);
        vm.expectEmit(false, false, false, true, address(t));
        emit Treasury.Settled(98e6, 0, 0, 98_000e6 - 98e6, 98e6, 0, 1 days, uint64(T0 + 1 days));
        vm.prank(stranger);
        t.settle();
        assertEq(t.lastSettle(), T0 + 1 days);
    }

    function test_settleInTheSameSecondMovesNothingAndEmitsNothing() public {
        _join(alice, 100_000e6);
        vm.recordLogs();
        t.settle();
        assertEq(vm.getRecordedLogs().length, 0);
    }

    function test_checkedInEventCarriesTheRecordHash() public {
        vm.expectEmit(true, false, false, true, address(t));
        emit Treasury.CheckedIn(founder, bytes32(uint256(0xabc)), uint64(T0));
        vm.prank(founder);
        t.checkIn(bytes32(uint256(0xabc)));
    }

    function test_quoteTakeOutIsZeroForMoreThanTheHolderHas() public {
        uint256 n = _join(alice, 100e6);
        (uint256 c,,) = t.quoteTakeOut(alice, n + 1);
        assertEq(c, 0);
        (c,,) = t.quoteTakeOut(bob, 1);
        assertEq(c, 0);
        (c,,) = t.quoteTakeOut(alice, 0);
        assertEq(c, 0);
        (c,,) = t.quoteTakeOut(alice, n);
        assertEq(c, 98e6);
    }

    function test_leaveValueAndTeamValue() public {
        assertEq(t.leaveValue(), 0);
        _join(alice, 100e6);
        assertEq(t.leaveValue(), 10_000, "0.01 a Share");
        assertEq(t.teamValue(), 0);
        _force(120e6, 98e6, 0, 0, 0);
        assertGt(t.teamValue(), 0);
    }

    // ---- dollars are conserved (must-bind 10)

    function test_dollarsAreConservedThroughAMixedScript() public {
        uint256 inflow;
        uint256 outflow;
        uint256 a = _join(alice, 50_000e6);
        inflow += 50_000e6;
        uint256 b = _join(bob, 7_777_777);
        inflow += 7_777_777;
        _assertExact();
        _revenue(carol, 3_000e6);
        inflow += 3_000e6;
        vm.warp(T0 + 2 days);
        _checkIn();
        _assertExact();
        uint256 held = t.box();
        vm.prank(founder);
        t.draw(stranger, held);
        outflow += held;
        _assertExact();
        outflow += _leave(alice, a / 3);
        vm.warp(T0 + 4 days);
        _checkIn();
        vm.prank(address(vester));
        team.transfer(carol, 1_000_000e18);
        _force(t.pot() + 20_000e6, t.paidIn(), t.box(), t.arriving(), t.arrivalEnd());
        inflow += 20_000e6; // _force funds the contract with the surplus
        vm.prank(carol);
        outflow += t.leaveTeam(1_000_000e18, 0, carol);
        _assertExact();
        outflow += _leave(bob, b);
        _revenue(carol, 5e6);
        inflow += 5e6;
        vm.warp(T0 + 12 days);
        t.settle();
        t.collectFees();
        outflow += usd.balanceOf(platform);
        outflow += _leave(alice, shares.balanceOf(alice));
        _assertExact();
        assertEq(inflow, outflow + usd.balanceOf(address(t)), "every dollar that went in is out or held");
    }

    function _assertExact() internal view {
        assertEq(usd.balanceOf(address(t)), t.pot() + t.box() + t.arriving() + t.feesOwed(), "held == accounted");
    }
}
