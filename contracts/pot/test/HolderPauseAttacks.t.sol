// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {IShares} from "../src/Interfaces.sol";
import {HolderPause} from "../src/HolderPause.sol";
import {Launcher} from "../src/Launcher.sol";
import {Treasury} from "../src/Treasury.sol";
import {ShareToken} from "../src/ShareToken.sol";
import {PauseBase} from "./helpers/PauseBase.sol";
import {Proj} from "./helpers/StackBase.sol";

/// @notice A gate that can be broken, for the row about a gate that fails (a deployer-bound implementation other than the
/// real one). Both questions revert while it is broken.
contract BrokenGate {
    error GateBroken();

    bool public broken;
    bool public lying;

    function initialize(IShares, uint32) external {}

    function setBroken(bool on) external {
        broken = on;
    }

    function setLying(bool on) external {
        lying = on;
    }

    function paused() external view returns (bool) {
        if (broken) revert GateBroken();
        return lying;
    }

    function poke() external view {
        if (broken) revert GateBroken();
    }
}

/// @notice A holder that is a contract: it holds Shares, parks them and, in one call, parks and takes them back (a loan that
/// must be repaid in the same transaction).
contract ParkingContract {
    function park(ShareToken s, HolderPause p, uint256 n) external {
        s.approve(address(p), n);
        p.park(n);
    }

    function unpark(HolderPause p, uint256 n) external {
        p.unpark(n);
    }

    function parkAndRepay(ShareToken s, HolderPause p, uint256 n, address lender)
        external
        returns (uint64 armedInside)
    {
        s.approve(address(p), n);
        p.park(n);
        armedInside = p.armedAt();
        p.unpark(n);
        s.transfer(lender, n);
    }
}

/// @notice Section 2 of docs/next-version/STEP4-PLAN.md: every row of the attack table (rows 1 to 17) as a test that holds
/// the claim the plan makes, with the cost of the attack in dollars pinned. The pot of the base case is 10,000 dollars
/// (Alice, the only backer) or 1,000,000; "the line" is a third of the backers' Shares.
contract HolderPauseAttacksTest is PauseBase {
    address internal worker = makeAddr("worker");

    function setUp() public override {
        super.setUp();
    }

    // ================================================================ helpers

    /// @dev Gross dollars that give Alice a pot of `potDollars` after the fee.
    function _grossForPot(uint256 potDollars) internal pure returns (uint256) {
        return (potDollars * 1e6 * 50 + 48) / 49;
    }

    /// @dev A fresh project (default for the test) in which Alice alone backs with a pot of `potDollars`.
    function _freshProject(string memory id, uint256 potDollars) internal {
        _use(_launch(founder, keccak256(bytes(id)), 1000, POOL));
        pause = HolderPause(t.pauseGate());
        _join(alice, _grossForPot(potDollars));
    }

    /// @dev The smallest payment that gives a newcomer Shares with `n * den >= num * (B + n)`: the newcomer then holds at
    /// least `num / den` of all backer Shares after joining.
    function _grossFor(uint256 num, uint256 den) internal view returns (uint256 gross) {
        uint256 b0 = shares.totalSupply();
        uint256 lo = 1e6;
        uint256 hi = 1e13;
        while (hi - lo > 1000) {
            uint256 mid = (lo + hi) / 2;
            (uint256 n,,,) = t.quoteBack(mid);
            if (n * den >= num * (b0 + n)) hi = mid;
            else lo = mid;
        }
        return hi;
    }

    /// @dev The smallest payment that gives at least `target` Shares.
    function _grossForShares(uint256 target) internal view returns (uint256 gross) {
        uint256 lo = 1e6;
        uint256 hi = 1e13;
        while (hi - lo > 1000) {
            uint256 mid = (lo + hi) / 2;
            (uint256 n,,,) = t.quoteBack(mid);
            if (n >= target) hi = mid;
            else lo = mid;
        }
        return hi;
    }

    /// @dev Bob joins until he holds at least `num / den` of all backer Shares and parks all of them.
    function _whale(uint256 num, uint256 den) internal returns (uint256 gross) {
        gross = _grossFor(num, den);
        _join(bob, gross);
        _park(bob, shares.balanceOf(bob));
    }

    function _drawIsRefused() internal {
        vm.prank(founder);
        vm.expectRevert(Treasury.Paused.selector);
        t.draw(founder, 1);
        vm.prank(founder);
        vm.expectRevert(Treasury.Paused.selector);
        t.announceTask(bytes32(uint256(7)), address(0), 100e6, 10);
    }

    function _drawWorks() internal {
        t.settle();
        assertGt(t.box(), 1, "something to draw");
        vm.prank(founder);
        t.draw(founder, 1);
        vm.prank(founder);
        t.announceTask(bytes32(uint256(7)), address(0), 100e6, 10);
    }

    // ================================================== 1. a late large buyer

    function _lateWhale(uint256 potDollars) internal returns (uint256 gross, uint256 fee) {
        _freshProject(string.concat("late", vm.toString(potDollars)), potDollars);
        gross = _grossFor(1, 3);
        fee = t.feeFor(gross);
        _join(bob, gross);
        _park(bob, shares.balanceOf(bob));
        assertEq(pause.armedAt(), clock, "a third parked arms the clock");
        _checkIn();
    }

    function test_lateWhaleCostsOnlyTheFee() public {
        (uint256 gross, uint256 fee) = _lateWhale(10_000);
        emit log_named_uint("pot 10,000: the whale's fee in units", fee);
        assertApproxEqAbs(fee, 102e6, 1e6, "fee 102 on a pot of 10,000");
        assertEq(fee, gross * 200 / 10_000 + (gross * 200 % 10_000 == 0 ? 0 : 1), "two per cent of the gross");
        _oneDay();
        assertTrue(pause.paused());
        _drawIsRefused();
        (gross, fee) = _lateWhale(1_000_000);
        emit log_named_uint("pot 1,000,000: the whale's fee in units", fee);
        assertApproxEqAbs(fee, 10_204e6, 2e6, "fee 10,204 on a pot of 1,000,000");
        _oneDay();
        assertTrue(pause.paused());
        _drawIsRefused();
    }

    function test_whaleRoundTripReturnsNinetyEightPerHundred() public {
        for (uint256 i; i < 2; ++i) {
            uint256 potDollars = i == 0 ? 10_000 : 1_000_000;
            _freshProject(string.concat("rt", vm.toString(potDollars)), potDollars);
            uint256 gross = _grossFor(1, 3);
            _join(bob, gross);
            uint256 n = shares.balanceOf(bob);
            _park(bob, n);
            _unpark(bob, n);
            uint256 cash = _leave(bob, n);
            // what the whale paid in total comes back less the platform's two per cent (rounded up) and the rounding of
            // the price: 98.00 per 100
            assertApproxEqAbs(cash, gross * 98 / 100, 5e4, "98.00 per 100 of what was paid");
            assertGe(gross - cash, t.feeFor(gross), "the fee is the cost, no more than a rounding on top");
            assertLe(gross - cash, t.feeFor(gross) + 5e4);
        }
    }

    function test_pauseStartsOnlyAfterADayOfSeeingTheLine() public {
        _freshProject("day", 10_000);
        _checkIn();
        _whale(1, 3);
        uint256 armed = pause.armedAt();
        _warpTo(armed + 3 hours);
        _checkIn();
        assertFalse(pause.paused());
        _warpTo(armed + _day() - 1);
        assertFalse(pause.paused());
        _drawWorks(); // the box can still be drawn and a task announced during the 24 hours
        _warpTo(armed + _day());
        assertTrue(pause.paused());
        _drawIsRefused();
    }

    // ========================================== 2. a founder with many accounts

    function test_manyAccountsCostTheSameAsOne() public {
        _freshProject("many", 10_000);
        uint256 gross = _grossFor(1, 3);
        uint256 oneAccountFee = t.feeFor(gross);
        // twenty accounts of the founder's together put in a hair over the same money (the margin covers rounding)
        uint256 each = gross * 1001 / 1000 / 20;
        uint256 feeSum;
        for (uint256 i; i < 20; ++i) {
            address a = makeAddr(string.concat("founder-account-", vm.toString(i)));
            feeSum += t.feeFor(each);
            _join(a, each);
            _park(a, shares.balanceOf(a));
        }
        assertGe(feeSum, oneAccountFee, "no cheaper than one account");
        assertLe(feeSum, oneAccountFee * 1002 / 1000 + 20, "and no dearer by more than the margin and the rounding");
        assertEq(pause.armedAt(), clock, "parking counts Shares, not accounts: the line is reached");
        _checkIn();
        _oneDay();
        assertTrue(pause.paused());
    }

    function test_splittingSharesAcrossAccountsChangesNothing() public {
        // two projects with the same Alice; in one she parks a third from one account, in the other from five accounts
        _freshProject("split-a", 10_000);
        HolderPause pa = pause;
        Treasury ta = t;
        ShareToken sa = shares;
        _freshProject("split-b", 10_000);
        HolderPause pb = pause;
        ShareToken sb = shares;
        uint256 need = pa.line();
        assertEq(pb.line(), need);
        vm.startPrank(alice);
        sa.approve(address(pa), need);
        pa.park(need);
        for (uint256 i; i < 5; ++i) {
            address a = makeAddr(string.concat("split-", vm.toString(i)));
            uint256 part = i == 4 ? need - 4 * (need / 5) : need / 5;
            sb.transfer(a, part);
            vm.stopPrank();
            vm.startPrank(a);
            sb.approve(address(pb), part);
            pb.park(part);
            vm.stopPrank();
            vm.startPrank(alice);
        }
        vm.stopPrank();
        (uint256 p1, uint256 b1, uint256 l1, uint64 ar1, uint256 pf1, bool x1) = pa.state();
        (uint256 p2, uint256 b2, uint256 l2, uint64 ar2, uint256 pf2, bool x2) = pb.state();
        assertEq(p1, p2);
        assertEq(b1, b2);
        assertEq(l1, l2);
        assertEq(ar1, ar2);
        assertEq(pf1, pf2);
        assertEq(x1, x2);
        assertEq(ar1, clock, "split or not, the same line, the same clock");
        ta;
    }

    // ============================================ 3. a whale parks to grief the team

    function test_dilutionEndsThePauseTheSameBlock() public {
        _freshProject("dilute", 10_000);
        _checkIn();
        _whale(2, 5); // the whale holds 40% and parks it all
        _oneDay();
        assertTrue(pause.paused());
        _drawIsRefused();
        // the team backs with its own money: the join that pushes parked under a third lifts the pause in the same block
        uint256 k = pause.parkedTotal();
        uint256 b = shares.totalSupply();
        uint256 target = 3 * k - b + 1;
        uint256 gross = _grossForShares(target);
        uint256 fee = t.feeFor(gross);
        _join(founder, gross);
        assertFalse(pause.paused(), "ended in the same block");
        assertEq(pause.armedAt(), 0);
        _drawWorks();
        emit log_named_uint("pot 10,000, whale at 40 per cent: the team's dilution fee in units", fee);
        assertApproxEqAbs(fee, 68e6, 1e6, "fee 68 on a pot of 10,000");
    }

    function test_whaleAtFortyPerCentNeedsTwentyPerCentOfPotToBeDiluted() public {
        _freshProject("forty", 10_000);
        uint256 whaleGross = _whale(2, 5);
        uint256 whaleFee = t.feeFor(whaleGross);
        assertApproxEqAbs(whaleFee, 136e6, 1e6, "the whale's own fee at 40 per cent: 136");
        uint256 potBefore = t.pot();
        uint256 k = pause.parkedTotal();
        uint256 gross = _grossForShares(3 * k - shares.totalSupply() + 1);
        uint256 fee = t.feeFor(gross);
        uint256 net = gross - fee;
        // the dilution is 20 per cent of the pot the whale made (16,667): net about 3,333
        assertApproxEqRel(net, potBefore / 5, 0.01e18, "a fifth of the pot");
        assertApproxEqAbs(net, 3333e6, 2e6);
        _join(founder, gross);
        assertEq(pause.armedAt(), 0);
        // the dilution is real backing the project keeps: it is in the pot
        assertEq(t.pot(), potBefore + net);
    }

    function test_pausedAllowanceReturnsToPotAndRaisesEveryTakeOut() public {
        Proj memory a = _launch(founder, "ctl", 1000, POOL); // nobody parks here
        Proj memory b = _launch(founder, "par", 1000, POOL); // Alice parks a third here
        _joinIn(a.t, alice, _grossForPot(10_000));
        _joinIn(b.t, alice, _grossForPot(10_000));
        HolderPause pb = HolderPause(b.t.pauseGate());
        uint256 need = pb.line();
        vm.startPrank(alice);
        b.shares.approve(address(pb), need);
        pb.park(need);
        vm.stopPrank();
        uint256 drawnA;
        for (uint256 d; d < 30; ++d) {
            _warp(1 days); // time through the test's own clock
            vm.startPrank(founder);
            a.t.checkIn(bytes32(0));
            b.t.checkIn(bytes32(0));
            vm.stopPrank();
            a.t.settle();
            uint256 boxA = a.t.box();
            if (boxA != 0) {
                vm.prank(founder);
                a.t.draw(founder, boxA);
                drawnA += boxA;
            }
            if (clock >= pb.pausesFrom()) {
                vm.prank(founder);
                vm.expectRevert(Treasury.Paused.selector);
                b.t.draw(founder, 1);
            }
        }
        b.t.settle();
        assertGt(drawnA, 0, "the team of the project nobody paused drew its allowance");
        // the paused project kept its allowance in the pot (the box sits at its seven-day cap, the rest went back)
        assertEq(b.t.box(), b.t.boxCap(), "the box sits at its cap");
        assertGt(b.t.pot() + b.t.box(), a.t.pot() + a.t.box(), "more money stays in the paused project");
        assertGt(b.t.leaveValue(), a.t.leaveValue(), "so every take-out is worth more");
        emit log_named_uint("30 days: leaveValue not paused, per Share (units)", a.t.leaveValue());
        emit log_named_uint("30 days: leaveValue paused, per Share (units)", b.t.leaveValue());
    }

    // ========================================= 4. park and un-park flapping

    function test_flappingNeverPausesBeforeADayOfUnbrokenLine() public {
        _freshProject("flap", 10_000);
        for (uint256 i; i < 6; ++i) {
            _parkToLine(alice); // arms
            uint256 armed = pause.armedAt();
            _warpTo(armed + _day() - 3600);
            _checkIn();
            assertFalse(pause.paused(), "an hour short of a day");
            _unpark(alice, 1); // one Wei under the line: disarmed
            assertEq(pause.armedAt(), 0);
            _warp(1 hours + 1);
            assertFalse(pause.paused(), "more than a day since the first arming, but never unbroken");
        }
        _parkToLine(alice);
        _oneDay();
        assertTrue(pause.paused(), "an unbroken day pauses");
    }

    function test_aTopUpAfterAnUnseenDipRestartsTheDay() public {
        // the line is reached, a joiner pushes it under, the joiner leaves again, and nobody calls anything: the old clock
        // must not run on
        _freshProject("dip", 10_000);
        _parkToLine(alice);
        uint256 armed = pause.armedAt();
        _warpTo(armed + _day() - 100);
        _checkIn();
        usd.mint(carol, 50_000e6);
        vm.startPrank(carol);
        usd.approve(address(t), 50_000e6);
        t.join(50_000e6, 0, carol);
        t.leave(shares.balanceOf(carol), 0, carol);
        vm.stopPrank();
        assertGe(pause.parkedTotal() * 3, shares.totalSupply(), "the ratio is back over the line");
        _warpTo(armed + _day() + 1);
        _checkIn();
        assertFalse(pause.paused(), "the old clock ran out, but the dip cleared it");
        pause.poke();
        assertEq(pause.armedAt(), clock, "a new clock");
        assertFalse(pause.paused());
        _warp(_day());
        assertTrue(pause.paused());
    }

    function test_pausedEndsTheSecondParkedFallsUnderTheLine() public {
        _freshProject("end", 10_000);
        _parkToLine(alice);
        _oneDay();
        assertTrue(pause.paused());
        _unpark(alice, 1);
        assertFalse(pause.paused());
        _drawWorks();
    }

    // ================================================ 5. parked Shares then sent

    function test_parkedSharesCannotBeSent() public {
        _freshProject("sent", 10_000);
        uint256 n = shares.balanceOf(alice);
        _park(alice, n);
        vm.prank(alice);
        vm.expectRevert(ShareToken.InsufficientBalance.selector);
        shares.transfer(bob, 1);
        assertEq(shares.balanceOf(address(pause)), n);
    }

    function test_unparkThenSendEndsTheCount() public {
        _freshProject("unsent", 10_000);
        uint256 n = shares.balanceOf(alice);
        _park(alice, n);
        assertEq(pause.parkedTotal(), n);
        _unpark(alice, n);
        vm.prank(alice);
        shares.transfer(bob, n);
        assertEq(pause.parkedTotal(), 0);
        assertEq(pause.parkedOf(alice), 0);
        assertEq(pause.parkedOf(bob), 0, "Shares that were parked do not stay counted for whoever they go to");
        assertEq(pause.armedAt(), 0);
    }

    // ========================================== 6. parked Shares then taken out

    function test_takeOutWithParkedSharesPaysTheQuoteInOneBatch() public {
        _freshProject("batch", 10_000);
        _join(bob, 2000e6); // someone else stays
        uint256 total = shares.balanceOf(alice);
        uint256 parked = total / 3;
        uint256 wallet = total - parked;
        _park(alice, parked);
        (uint256 cw,,) = t.quoteTakeOut(alice, wallet);
        (uint256 cp,,) = t.quoteTakeOut(address(pause), parked);
        uint256 guard = (cw + cp) * 999 / 1000;
        uint256 before_ = usd.balanceOf(alice);
        // the batch the app sends: [unpark(p), leave(w + p, minCash, to)], from the holder's own account
        vm.startPrank(alice);
        pause.unpark(parked);
        uint256 cash = t.leave(wallet + parked, guard, alice);
        vm.stopPrank();
        assertEq(usd.balanceOf(alice) - before_, cash);
        assertApproxEqAbs(cash, cw + cp, 2, "the two quotes add up to the one take-out, to within two units");
        assertEq(shares.balanceOf(alice), 0);
        assertEq(pause.parkedOf(alice), 0);
    }

    function test_exitNotesGoToTheHolderNotThePause() public {
        _freshProject("notes", 100_000);
        _join(bob, 20_000e6);
        vm.prank(founder);
        uint64 serial = t.announceTask(bytes32(uint256(5)), worker, 100_000e6, 500); // 5% of the pot
        _warpTo(_book().taskOf(serial).noticeEnd);
        _checkIn();
        vm.prank(worker);
        t.takeTask(serial, 0); // money is now set aside
        uint256 parked = shares.balanceOf(alice) / 2;
        _park(alice, parked);
        vm.recordLogs();
        vm.startPrank(alice);
        pause.unpark(parked);
        t.leave(shares.balanceOf(alice), 0, alice);
        vm.stopPrank();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool saw;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(t) && logs[i].topics[0] == Treasury.TaskMoney.selector) {
                (uint8 kind, address who, uint256 amount,,,) =
                    abi.decode(logs[i].data, (uint8, address, uint256, uint256, uint256, uint256));
                if (kind == 5) {
                    assertEq(who, alice, "the note is written to the holder");
                    assertGt(amount, 0);
                    saw = true;
                }
            }
        }
        assertTrue(saw, "a note was written");
        assertEq(_book().claimableNote(serial, address(pause)), 0, "none to the pause");
    }

    function test_unparkWorksWhenPausedWoundDownAndShut() public {
        _freshProject("woundup", 10_000);
        _join(bob, 1000e6);
        _parkToLine(alice);
        _oneDay();
        assertTrue(pause.paused());
        vm.startPrank(founder);
        t.setDoor(false);
        t.windDown();
        vm.stopPrank();
        assertEq(t.windDownKind(), 1);
        assertFalse(t.doorOpenNow());
        uint256 parked = pause.parkedOf(alice);
        uint256 total = parked + shares.balanceOf(alice);
        vm.startPrank(alice);
        pause.unpark(parked);
        uint256 cash = t.leave(total, 0, alice);
        vm.stopPrank();
        assertGt(cash, 0);
        assertEq(pause.parkedOf(alice), 0);
    }

    // ================================================== 7. a pause aimed at a task mid-notice

    function test_aTaskAnnouncedBeforeThePauseCanBeTakenAndPaidDuringIt() public {
        _freshProject("midnotice", 100_000);
        _checkIn();
        vm.prank(founder);
        uint64 serial = t.announceTask(bytes32(uint256(9)), worker, 2000e6, 100); // 1% of the pot, a longer notice
        _whale(1, 3);
        _oneDay();
        assertTrue(pause.paused());
        uint64 noticeEnd = _book().taskOf(serial).noticeEnd;
        assertGt(noticeEnd, clock, "the notice is still running when the pause begins");
        // keep the project alive until the notice is over, with the pause on throughout
        _warpAlive(noticeEnd);
        assertTrue(pause.paused());
        vm.prank(worker);
        t.takeTask(serial, 0);
        vm.prank(founder);
        t.acceptTask(serial, 1000e6);
        assertEq(usd.balanceOf(worker), 1000e6, "paid while paused");
        assertTrue(pause.paused(), "and the pause was on the whole time");
    }

    function test_everyOtherCallWorksWhilePaused() public {
        _freshProject("other", 100_000);
        _grant(carol, 1_000_000e18);
        _join(dave, 1000e6);
        _checkIn();
        vm.prank(founder);
        uint64 open = t.announceTask(bytes32(uint256(3)), address(0), 100e6, 10);
        vm.prank(founder);
        uint64 other = t.announceTask(bytes32(uint256(4)), address(0), 100e6, 10);
        vm.prank(founder);
        uint64 third = t.announceTask(bytes32(uint256(6)), address(0), 100e6, 10);
        _whale(2, 5); // a margin over the line, so a small join does not lift the pause
        _oneDay();
        assertTrue(pause.paused());
        // join and leave
        _join(erin(), 50e6);
        assertTrue(pause.paused(), "a small join does not lift it");
        _leave(dave, shares.balanceOf(dave) / 2);
        assertTrue(pause.paused());
        // the allowance's clock and records
        t.settle();
        _checkIn();
        vm.prank(founder);
        t.proposeRate(1500);
        vm.prank(founder);
        t.setRate(900);
        vm.prank(founder);
        t.setDoor(false);
        vm.prank(founder);
        t.setDoor(true);
        // money in and fees out
        _revenue(carol, 5e6);
        t.collectFees();
        // Team Shares and agents
        _grant(dave, 2000e18);
        vm.prank(founder);
        t.authoriseAgent(makeAddr("agent"));
        vm.prank(founder);
        t.revokeAgent(makeAddr("agent"));
        // the tasks that were already announced: cancel one, take the other when its notice is over
        vm.prank(founder);
        t.cancelTask(third);
        uint64 noticeEnd = _book().taskOf(open).noticeEnd;
        _warpAlive(noticeEnd);
        vm.prank(worker);
        t.takeTask(open, 0);
        vm.prank(founder);
        t.rejectTask(open);
        _warpAlive(noticeEnd + UNIT + 1); // the other task's take window ends: it lapses, and anyone may say so
        t.returnTask(other);
        assertTrue(pause.paused(), "the pause was on for every one of those calls");
        // the seat changes hands and the project is wound down
        vm.prank(founder);
        t.handOver(dave, false);
        vm.prank(dave);
        t.takeSeat();
        vm.prank(dave);
        t.windDown();
        assertEq(t.windDownKind(), 1);
    }

    function erin() internal returns (address) {
        return makeAddr("erin");
    }

    // ======================================== 8. the team parks its own Shares

    function test_teamSharesCannotBeParkedOrCounted() public {
        _freshProject("teamsh", 10_000);
        uint256 id = _grant(bob, POOL);
        _wait(104 * UNIT);
        v.claim(id);
        uint256 g = team.balanceOf(bob);
        assertEq(g, POOL);
        vm.startPrank(bob);
        team.approve(address(pause), g);
        vm.expectRevert(ShareToken.InsufficientBalance.selector); // park pulls backer Shares only; bob holds none
        pause.park(g);
        vm.stopPrank();
        assertEq(pause.parkedTotal(), 0);
    }

    function test_aTeamDonationOfTeamSharesChangesNothing() public {
        _freshProject("teamgift", 10_000);
        uint256 id = _grant(bob, POOL);
        _wait(104 * UNIT);
        v.claim(id);
        (uint256 p0, uint256 b0, uint256 l0,,,) = pause.state();
        vm.prank(bob);
        team.transfer(address(pause), POOL);
        (uint256 p1, uint256 b1, uint256 l1, uint64 ar, uint256 pf, bool paused_) = pause.state();
        assertEq(p1, p0, "Team Shares sit on neither side");
        assertEq(b1, b0);
        assertEq(l1, l0);
        assertEq(ar, 0);
        assertEq(pf, 0);
        assertFalse(paused_);
        // and a team member who also backed with their own money parks backer Shares like anyone: it costs the same fee
        _join(bob, 5000e6);
        _park(bob, shares.balanceOf(bob));
        assertEq(pause.parkedOf(bob), shares.balanceOf(address(pause)), "only backer Shares are parked");
    }

    // ======================================================= 9. parking through a contract

    function test_aContractParksOnlyWhatItHoldsAndItCountsOnce() public {
        _freshProject("contract", 10_000);
        ParkingContract c = new ParkingContract();
        uint256 n = shares.balanceOf(alice) / 2;
        vm.prank(alice);
        shares.transfer(address(c), n);
        vm.expectRevert(ShareToken.InsufficientBalance.selector);
        c.park(shares, pause, n + 1); // it cannot park what it was not given
        c.park(shares, pause, n);
        assertEq(pause.parkedOf(address(c)), n);
        assertEq(pause.parkedTotal(), n, "counted once");
        assertEq(pause.parkedOf(alice), 0, "the person who gave them is not counted for them");
        c.unpark(pause, n);
        assertEq(pause.parkedTotal(), 0);
    }

    function test_aOneBlockLoanNeverArms() public {
        _freshProject("loan", 10_000);
        ParkingContract c = new ParkingContract();
        uint256 n = shares.balanceOf(alice); // everything: a third is easily reached
        vm.prank(alice);
        shares.transfer(address(c), n);
        uint64 inside = c.parkAndRepay(shares, pause, n, alice);
        assertGt(inside, 0, "the line was reached inside the loan");
        assertEq(pause.armedAt(), 0, "and gone by the end of it");
        _warp(3 * _day());
        assertFalse(pause.paused());
        assertEq(shares.balanceOf(alice), n);
    }

    function test_noOneCanParkForSomeoneElse() public {
        _freshProject("nofor", 10_000);
        vm.prank(alice);
        shares.approve(address(pause), type(uint256).max);
        vm.prank(bob);
        vm.expectRevert(ShareToken.InsufficientBalance.selector);
        pause.park(1);
        assertEq(pause.parkedTotal(), 0);
    }

    // ============================================ 10. a project's own contracts

    function test_projectContractsCannotChangeTheCount() public {
        _freshProject("own", 10_000);
        // Shares sent to the project's own contracts are not parked
        uint256 n = shares.balanceOf(alice) / 3;
        address[4] memory own = [address(t), address(v), address(_book()), launcher.pairImpl()];
        for (uint256 i; i < 4; ++i) {
            vm.prank(alice);
            shares.transfer(own[i], n / 4);
        }
        assertEq(pause.parkedTotal(), 0);
        assertEq(pause.armedAt(), 0);
        // and none of the project's contracts can ever call park or unpark: their code has no such call (the four-byte
        // selector is not in it)
        address[5] memory code = [
            launcher.treasuryImpl(), launcher.vesterImpl(), launcher.tasksImpl(), launcher.pairImpl(), address(launcher)
        ];
        for (uint256 i; i < 5; ++i) {
            assertFalse(_has(code[i].code, HolderPause.park.selector), "park(uint256) appears in a project contract");
            assertFalse(
                _has(code[i].code, HolderPause.unpark.selector), "unpark(uint256) appears in a project contract"
            );
        }
        assertTrue(_has(address(pauseImpl).code, HolderPause.park.selector), "the scan finds a selector that is there");
    }

    function _has(bytes memory code, bytes4 sel) internal pure returns (bool) {
        for (uint256 i; i + 4 <= code.length; ++i) {
            if (code[i] == sel[0] && code[i + 1] == sel[1] && code[i + 2] == sel[2] && code[i + 3] == sel[3]) {
                return true;
            }
        }
        return false;
    }

    // ======================================= 11. others leaving lets a holder reach the line

    function test_othersLeavingCanBringAHolderToTheLine() public {
        _freshProject("leaving", 1_000_000);
        // Alice holds all the Shares so far; Bob and Carol join to make her about 27%
        _join(bob, _grossForPot(200_000));
        _join(carol, _grossForPot(530_000));
        uint256 b = shares.totalSupply();
        uint256 a = shares.balanceOf(alice);
        // Alice is 1,000,000 of 1,730,000: far above a third; make the test exact instead: she parks 27% of everyone's
        uint256 park = b * 27 / 100;
        assertGe(a, park);
        _park(alice, park);
        assertEq(pause.armedAt(), 0, "27 per cent is under a third");
        _leave(bob, shares.balanceOf(bob)); // 11.6% of the Shares leave: B falls to 88.4%, the parked share is 30.5%
        _leave(carol, shares.balanceOf(carol) / 4); // and more: B is now low enough
        assertGe(pause.parkedTotal() * 3, shares.totalSupply(), "no one bought anything: the holder is at the line");
        assertEq(pause.armedAt(), 0, "nobody has looked yet");
        pause.poke();
        assertEq(pause.armedAt(), clock, "the look arms the clock");
        _oneDay();
        assertTrue(pause.paused());
    }

    // ================================================ 12. a hidden dip and recovery

    function test_dipThroughAJoinIsRecordedWithoutAPoke() public {
        _freshProject("hidden", 10_000);
        _parkToLine(alice);
        assertGt(pause.armedAt(), 0);
        _join(carol, 5000e6);
        assertEq(pause.armedAt(), 0, "the join's own look cleared it: no poke was called by anyone else");
    }

    function test_aDipByJoinThenLeaveNeverPausesWithoutANewDay() public {
        test_aTopUpAfterAnUnseenDipRestartsTheDay(); // the same sequence, the pause only after a new full day
    }

    function test_pokeArmsALineReachedByLeaving() public {
        _freshProject("pokeleave", 10_000);
        _join(bob, 5000e6);
        uint256 need = pause.line();
        _park(alice, need - 1);
        assertEq(pause.armedAt(), 0);
        _leave(bob, shares.balanceOf(bob));
        assertEq(pause.armedAt(), 0, "a leave does not call the pause");
        pause.poke();
        assertEq(pause.armedAt(), clock);
        _drawIsNotRefusedYet();
    }

    function _drawIsNotRefusedYet() internal {
        _checkIn();
        assertFalse(pause.paused(), "armed is not paused");
    }

    // ================================================= 13. the gate fails or lies

    function test_aRevertingGateStopsOnlyDrawAndAnnounce() public {
        BrokenGate impl = new BrokenGate();
        Launcher l = new Launcher(admin, _platform(UNIT), parts);
        l.bindPause(address(impl));
        bytes32 h = l.settingsHash();
        vm.prank(founder);
        (address sh, address tm, address tr, address vs) =
            l.launch("broken", "Project", "PRJ", Launcher.Terms({ratePpm: 1000, teamPool: POOL}), h);
        Treasury tt = Treasury(tr);
        BrokenGate gate = BrokenGate(tt.pauseGate());
        sh;
        tm;
        vs;
        _joinIn(tt, alice, 10_000e6);
        _joinIn(tt, carol, 10e6);
        _warp(2 days);
        vm.prank(founder);
        tt.checkIn(bytes32(0));
        gate.setBroken(true);
        vm.startPrank(founder);
        vm.expectRevert(BrokenGate.GateBroken.selector);
        tt.draw(founder, 1);
        vm.expectRevert(BrokenGate.GateBroken.selector);
        tt.announceTask(bytes32(uint256(1)), address(0), 100e6, 10);
        // nothing that leaves or settles reads the gate
        tt.checkIn(bytes32(0));
        vm.stopPrank();
        tt.settle();
        vm.prank(alice);
        tt.leave(1e18, 0, alice);
        // a join calls poke and so also fails closed: it never strands money, it only keeps new money out
        usd.mint(dave, 10e6);
        vm.startPrank(dave);
        usd.approve(tr, 10e6);
        vm.expectRevert(BrokenGate.GateBroken.selector);
        tt.join(10e6, 0, dave);
        vm.stopPrank();
        // mended, it all works again
        gate.setBroken(false);
        vm.prank(founder);
        tt.draw(founder, 1);
    }

    function test_aLyingGateCanOnlyRefuseDrawAndAnnounce() public {
        BrokenGate impl = new BrokenGate();
        Launcher l = new Launcher(admin, _platform(UNIT), parts);
        l.bindPause(address(impl));
        bytes32 h = l.settingsHash();
        vm.prank(founder);
        (,, address tr,) = l.launch("lying", "Project", "PRJ", Launcher.Terms({ratePpm: 1000, teamPool: POOL}), h);
        Treasury tt = Treasury(tr);
        BrokenGate(tt.pauseGate()).setLying(true);
        _joinIn(tt, alice, 10_000e6);
        _warp(2 days);
        vm.startPrank(founder);
        tt.checkIn(bytes32(0));
        vm.expectRevert(Treasury.Paused.selector);
        tt.draw(founder, 1);
        vm.stopPrank();
        vm.prank(alice);
        uint256 cash = tt.leave(1e18, 0, alice);
        assertGt(cash, 0, "a gate that says paused for ever still lets everybody out");
    }

    // ================================================ 14. using the pause to steal

    function test_nothingTheTreasuryHoldsMovesBecauseOfThePause() public {
        _freshProject("steal", 10_000);
        uint256 held = usd.balanceOf(address(t));
        uint256[6] memory before_ = [t.pot(), t.box(), t.arriving(), t.feesOwed(), t.locked(), t.notesOwed()];
        _parkToLine(alice);
        pause.poke();
        _unpark(alice, 1);
        _park(alice, 1);
        assertEq(usd.balanceOf(address(t)), held);
        uint256[6] memory after_ = [t.pot(), t.box(), t.arriving(), t.feesOwed(), t.locked(), t.notesOwed()];
        for (uint256 i; i < 6; ++i) {
            assertEq(after_[i], before_[i]);
        }
        assertEq(usd.balanceOf(address(pause)), 0);
    }

    // ========================================== 15. a task announced in the warning day

    function test_aTaskAnnouncedInTheWarningDayStandsAndCanBeTakenAfter() public {
        _freshProject("warn", 100_000);
        _checkIn();
        _whale(1, 3);
        _warp(_day() - 10);
        _checkIn();
        vm.prank(founder);
        uint64 serial = t.announceTask(bytes32(uint256(11)), worker, 1000e6, 50); // inside the 24 hours
        _warp(10);
        assertTrue(pause.paused());
        uint64 noticeEnd = _book().taskOf(serial).noticeEnd;
        _warpAlive(noticeEnd);
        vm.prank(worker);
        t.takeTask(serial, 0);
        vm.prank(founder);
        t.acceptTask(serial, 500e6);
        assertEq(usd.balanceOf(worker), 500e6);
    }

    // ================================ 16. the team dilutes in the same transaction as the draw

    /// @dev The cost, in dollar units, of the team lifting a pause by backing, drawing and leaving at once, when Alice (the
    /// only holder) has parked `eBps` ten-thousandths over a third of all Shares, on a pot of `potDollars`.
    function _sandwichCost(string memory id, uint256 potDollars, uint256 eBps) internal returns (uint256 cost) {
        _freshProject(id, potDollars);
        uint256 b = shares.totalSupply();
        uint256 k = b * (10_000 + eBps) / 30_000 + 1;
        _park(alice, k);
        assertEq(pause.armedAt(), clock);
        _oneDay();
        assertTrue(pause.paused());
        _drawIsRefused();
        uint256 target = 3 * k - b + 1; // the Shares that push parked under a third
        uint256 gross = _grossForShares(target);
        uint256 cash;
        usd.mint(founder, gross);
        vm.startPrank(founder);
        usd.approve(address(t), gross);
        uint256 n = t.join(gross, 0, founder);
        assertFalse(pause.paused(), "the join lifted it in the same transaction");
        t.settle();
        uint256 box = t.box();
        assertGt(box, 0);
        t.draw(founder, box); // the whole box, unlocked
        t.announceTask(bytes32(uint256(8)), address(0), 100e6, 10); // and a plan
        cash = t.leave(n, 0, founder);
        vm.stopPrank();
        cost = gross - cash;
    }

    function test_oneTxJoinDrawLeaveLiftsAPause() public {
        // the plan's table: pot 10,000: 2 / 20 / 102 at margins 1% / 10% / 50%; pot 1,000,000: 204 / 2,041 / 10,204
        uint256[3] memory e = [uint256(100), 1000, 5000];
        uint256[3] memory want10k = [uint256(2.04e6), 20.4e6, 102.04e6];
        for (uint256 i; i < 3; ++i) {
            uint256 c = _sandwichCost(string.concat("sw10k", vm.toString(i)), 10_000, e[i]);
            emit log_named_uint(string.concat("pot 10,000 margin ", vm.toString(e[i]), " bps: cost in units"), c);
            assertApproxEqRel(c, want10k[i], 0.05e18, "pinned cost on a pot of 10,000");
        }
        for (uint256 i; i < 3; ++i) {
            uint256 c = _sandwichCost(string.concat("sw1m", vm.toString(i)), 1_000_000, e[i]);
            emit log_named_uint(string.concat("pot 1,000,000 margin ", vm.toString(e[i]), " bps: cost in units"), c);
            assertApproxEqRel(c, want10k[i] * 100, 0.05e18, "pinned cost on a pot of 1,000,000");
        }
    }

    function test_teamDilutionCostMatchesTheFormula() public {
        // cost = fee / (1 - fee) x (margin x pot): 0.020408 x e x P
        uint256 c = _sandwichCost("formula", 10_000, 2000);
        uint256 expected = 10_000e6 * 2000 / 10_000 * 2041 / 100_000; // 0.02041 x 20% x 10,000 dollars
        assertApproxEqRel(c, expected, 0.05e18);
    }

    function test_oneTxSandwichResetsTheDay() public {
        _freshProject("reset", 10_000);
        uint256 b = shares.totalSupply();
        uint256 k = b * 11 / 30 + 1; // 10 per cent over a third
        _park(alice, k);
        uint256 armed = pause.armedAt();
        _warpTo(armed + _day() - 1);
        _checkIn();
        assertFalse(pause.paused());
        // one second before it begins, the team backs (the join clears the clock), draws, and leaves; then pokes
        uint256 gross = _grossForShares(3 * k - b + 1);
        usd.mint(founder, gross);
        vm.startPrank(founder);
        usd.approve(address(t), gross);
        uint256 n = t.join(gross, 0, founder);
        uint256 cash = t.leave(n, 0, founder);
        vm.stopPrank();
        pause.poke();
        assertEq(pause.armedAt(), clock, "the clock restarted");
        assertEq(pause.pausesFrom(), clock + _day(), "a full day later than it was");
        assertGt(pause.pausesFrom(), armed + _day());
        assertGt(gross - cash, 0, "and it cost the fee");
        assertApproxEqRel(gross - cash, 20.4e6, 0.1e18);
    }

    // ============================================ 17. the team appeases or is extorted

    function test_theTeamCouldGrantButThePauseGivesNothing() public {
        _freshProject("appease", 10_000);
        _parkToLine(alice);
        _oneDay();
        assertTrue(pause.paused());
        uint256 aliceUsd = usd.balanceOf(alice);
        uint256 id = _grant(alice, 1000e18); // the team may choose to: nothing in the contracts gives it
        assertEq(usd.balanceOf(alice), aliceUsd);
        assertEq(usd.balanceOf(address(pause)), 0);
        id;
    }
}
