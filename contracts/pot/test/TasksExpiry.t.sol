// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Math} from "oz5/utils/math/Math.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "oz5/token/ERC20/IERC20.sol";
import {PotBase} from "./helpers/PotBase.sol";
import {Treasury} from "../src/Treasury.sol";
import {TaskBook} from "../src/TaskBook.sol";
import {TreasuryHarness} from "./helpers/TreasuryHarness.sol";

/// @notice A task that runs out is returned INSIDE `settle()`, which every action does first: no leaver, joiner or anyone
/// else is priced on money that should already be back, whatever call comes first after the deadline, and no one needs to
/// pass an id (design 2.3b5). Each action acted on cold after a deadline must equal settle-then-act and the quote.
contract TasksExpiryTest is PotBase {
    bytes32 internal constant WHAT = keccak256("a task");
    address internal worker = makeAddr("worker");
    address internal dave = makeAddr("dave");
    uint256 internal deadline;
    uint64 internal taken;

    function setUp() public override {
        super.setUp();
        _relaunch(POOL, 1000); // the allowance runs: 0.1% of the pot a day
        _join(alice, 60_000e6);
        _join(bob, 40_000e6);
        _force(100_000e6, 100_000e6, 0, 0, 0);
    }

    function _announce(uint16 bps, uint256 max) internal returns (uint64 serial) {
        vm.prank(founder);
        serial = t.announceTask(WHAT, worker, max, bps);
    }

    function _warpAlive(uint256 ts) internal {
        if (ts <= vm.getBlockTimestamp()) return; // time only runs forward
        _checkIn();
        uint256 at = vm.getBlockTimestamp();
        while (at + 10 days < ts) {
            at += 6 days; // an absolute time: the optimizer may cache a repeated vm.getBlockTimestamp()
            vm.warp(at);
            _checkIn();
        }
        vm.warp(ts);
    }

    /// @dev One 5% task taken at its notice end; the window is kept open with a check-in just before the deadline.
    function _lock() internal {
        taken = _announce(500, 4000e6);
        _warpAlive(_book().taskOf(taken).noticeEnd);
        vm.prank(worker);
        t.takeTask(taken, 0);
        deadline = _book().taskOf(taken).deadline;
        assertEq(t.locked(), 4000e6);
        _warpAlive(deadline - 1 hours);
        _checkIn(); // settles, the task is still out
        assertEq(t.locked(), 4000e6);
    }

    function _digest() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                t.pot(),
                t.box(),
                t.arriving(),
                t.locked(),
                t.notesOwed(),
                t.paidIn(),
                t.feesOwed(),
                t.activeSeconds(),
                t.lastSettle(),
                t.nextExpiry(),
                shares.totalSupply(),
                team.totalSupply(),
                usd.balanceOf(address(t))
            )
        );
    }

    /// @dev Do one kind of action. Returns what it gave back (shares, cash, a serial).
    function _act(uint256 kind) internal returns (uint256 out) {
        if (kind == 0) {
            t.settle();
        } else if (kind == 1) {
            out = _join(carol, 5000e6);
        } else if (kind == 2) {
            uint256 n = shares.balanceOf(bob);
            vm.prank(bob);
            out = t.leave(n, 0, bob);
        } else if (kind == 3) {
            vm.prank(dave);
            out = t.leaveTeam(1_000_000e18, 0, dave);
        } else if (kind == 4) {
            _revenue(carol, 1000e6);
        } else if (kind == 5) {
            _checkIn();
        } else if (kind == 6) {
            usd.mint(address(t), 5000e6);
            vm.prank(address(usd));
            t.onTransferReceived(carol, carol, 5000e6, abi.encode(uint256(0), carol));
        } else if (kind == 7) {
            vm.prank(founder);
            out = t.announceTask(WHAT, worker, 1000e6, 100);
        } else if (kind == 8) {
            t.returnTask(taken);
        } else if (kind == 9) {
            t.collectFees();
        }
    }

    function _arrangeSurplus() internal {
        // Team Shares in hand and a surplus above paid-in, so a Team take-out pays something
        vm.prank(address(vester));
        team.transfer(dave, 1_000_000e18);
        _force(t.pot(), 50_000e6, t.box(), t.arriving(), t.arrivalEnd());
    }

    // ---- every action, cold, after the deadline

    function test_everyActionActedOnColdAfterTheDeadlineEqualsSettleThenAct() public {
        _lock();
        _arrangeSurplus();
        vm.warp(deadline + 3 hours); // no settle since the check-in an hour before the deadline
        for (uint256 kind; kind <= 8; ++kind) {
            uint256 id = vm.snapshotState();
            t.settle();
            uint256 settledFirst = _act(kind);
            bytes32 d1 = _digest();
            vm.revertToState(id);
            uint256 cold = _act(kind);
            bytes32 d2 = _digest();
            assertEq(cold, settledFirst, string.concat("action #", vm.toString(kind), " cold == settle then act"));
            assertEq(d1, d2, string.concat("state after action #", vm.toString(kind)));
            assertEq(t.locked(), 0, string.concat("the task is back after action #", vm.toString(kind)));
            vm.revertToState(id);
        }
    }

    function test_whatAJoinerAndALeaverAreQuotedBeforeTheDeadlineIsWhatTheyGetAfter() public {
        _lock();
        vm.warp(deadline + 3 hours);
        (uint256 sharesQuoted, uint256 outQuoted, uint256 lockedLine,) = t.quoteBack(5000e6);
        assertEq(lockedLine, 0, "the quote already sees the money back");
        uint256 n = shares.balanceOf(bob);
        (uint256 cashQuoted,,) = t.quoteTakeOut(bob, n);
        uint256 lv = t.leaveValue();
        uint256 id = vm.snapshotState();
        assertEq(_join(carol, 5000e6), sharesQuoted);
        vm.revertToState(id);
        assertEq(_leave(bob, n), cashQuoted);
        vm.revertToState(id);
        t.settle();
        assertEq(t.leaveValue(), lv, "and the value of a Share is what the view said before anyone settled");
        (uint256 s2, uint256 o2,,) = t.quoteBack(5000e6);
        assertEq(s2, sharesQuoted);
        assertEq(o2, outQuoted);
    }

    // ---- order inside the settle

    function test_returnedMoneyIsNotChargedAllowanceForTimeItWasNotInThePot() public {
        _lock();
        // empty the box so that no cap interferes, then let the stretch from here to after the deadline accrue
        uint256 inBox = t.box();
        vm.prank(founder);
        t.draw(address(0x51F), inBox);
        uint256 last = t.lastSettle();
        vm.warp(deadline + 5 hours);
        uint256 dt = vm.getBlockTimestamp() - last;
        uint256 potWithout = t.pot();
        assertEq(t.box(), 0);
        t.settle();
        uint256 accrued = Math.mulDiv(potWithout, 1000 * dt, 1e6 * (uint256(UNIT) / 7));
        assertEq(t.box(), accrued, "accrual on the pot without the money that comes back in this settle");
        uint256 charged = Math.mulDiv(potWithout + 4000e6, 1000 * dt, 1e6 * (uint256(UNIT) / 7));
        assertGt(charged, accrued, "it would have been more on the pot with it");
        assertEq(t.pot(), potWithout - accrued + 4000e6);
        assertEq(t.locked(), 0);
    }

    function test_aSecondSettleInTheSameSecondMovesNothing() public {
        _lock();
        vm.warp(deadline + 5 hours);
        t.settle();
        bytes32 d = _digest();
        t.settle();
        assertEq(_digest(), d);
    }

    // ---- what the events say

    function test_settledAnnouncesAReturnEvenWhenNoTimeCountedAndTaskMoneySaysHowMuch() public {
        // a quiet project: the window closed, so a settle after it has no active time; only the return moves money
        uint64 a = _announce(100, 500e6);
        _warpAlive(_book().taskOf(a).noticeEnd);
        vm.prank(worker);
        t.takeTask(a, 0);
        uint256 dl = _book().taskOf(a).deadline;
        vm.warp(t.activeEnd() + 1 days);
        t.settle(); // the active time up to the window's end is counted here
        vm.warp(dl);
        assertGt(dl, t.activeEnd());
        uint256 potBefore = t.pot();
        vm.expectEmit(true, false, false, true, address(t));
        emit Treasury.TaskMoney(4, 0, address(0), 500e6, potBefore + 500e6, 0, 0);
        t.settle();
        assertEq(t.pot(), potBefore + 500e6);
    }

    function test_aReturnEmitsSettledWithThePotThatIncludesIt() public {
        uint64 a = _announce(100, 500e6);
        _warpAlive(_book().taskOf(a).noticeEnd);
        vm.prank(worker);
        t.takeTask(a, 0);
        uint256 dl = _book().taskOf(a).deadline;
        vm.warp(t.activeEnd() + 1 days);
        t.settle();
        vm.warp(dl);
        vm.recordLogs();
        t.settle();
        bool seen;
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(t) && logs[i].topics[0] == Treasury.Settled.selector) {
                (,,, uint256 potAfter,,,,) =
                    abi.decode(logs[i].data, (uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint64));
                assertEq(potAfter, t.pot());
                seen = true;
            }
        }
        assertTrue(seen, "Settled is emitted when only a return moved money");
    }

    // ---- several tasks, some due

    function test_onlyTheTasksThatAreDueComeBack() public {
        uint64 a = _announce(100, 500e6);
        uint64 b = _announce(200, 1000e6);
        uint64 c = _announce(300, 1500e6);
        _warpAlive(_book().taskOf(c).noticeEnd); // the longest notice: all three can be taken now
        vm.startPrank(worker);
        t.takeTask(a, 0);
        vm.stopPrank();
        _warpAlive(vm.getBlockTimestamp() + 1 days);
        vm.prank(worker);
        t.takeTask(b, 0);
        _warpAlive(vm.getBlockTimestamp() + 1 days);
        vm.prank(worker);
        t.takeTask(c, 0);
        uint256 dlA = _book().taskOf(a).deadline;
        uint256 dlB = _book().taskOf(b).deadline;
        assertLt(dlA, dlB);
        assertEq(t.nextExpiry(), dlA);
        _warpAlive(dlA);
        t.settle();
        assertEq(uint8(_book().taskOf(a).state), uint8(TaskBook.State.Returned));
        assertEq(uint8(_book().taskOf(b).state), uint8(TaskBook.State.Taken));
        assertEq(uint8(_book().taskOf(c).state), uint8(TaskBook.State.Taken));
        assertEq(t.nextExpiry(), dlB);
        assertEq(t.locked(), 2500e6);
        _warpAlive(dlB + 10 days);
        t.settle();
        assertEq(t.locked(), 0);
        assertEq(t.nextExpiry(), 0);
        _assertConserved();
    }

    function test_aLapsedTaskMovesNoMoneyAndFreesItsSlot() public {
        uint64 a = _announce(100, 1000e6);
        uint256 end = _book().taskOf(a).expiresAt;
        _warpAlive(end);
        uint256 potBefore = t.pot();
        t.settle();
        assertEq(uint8(_book().taskOf(a).state), uint8(TaskBook.State.Lapsed));
        assertEq(_book().openCount(), 0);
        assertEq(t.nextExpiry(), 0);
        assertEq(t.locked(), 0);
        assertLe(t.pot(), potBefore, "the pot only fell by the allowance");
    }

    // ---- a short time unit on a test network

    function test_aShortTimeUnitRunsTheWholeCycleInMinutes() public {
        // N = 168 s: notice for 1% is 348 s, the take window 168 s, the deadline 336 s after the take
        (TreasuryHarness small,,,) = _launch(IERC20(address(usd)), POOL, 0, 200, 168);
        usd.mint(alice, 100_000e6);
        vm.startPrank(alice);
        usd.approve(address(small), 100_000e6);
        small.join(100_000e6, 0, alice);
        vm.stopPrank();
        uint256 t0 = vm.getBlockTimestamp();
        vm.prank(founder);
        uint64 s = small.announceTask(WHAT, worker, 500e6, 100);
        TaskBook book = TaskBook(address(small.tasks()));
        assertEq(book.taskOf(s).noticeEnd, t0 + 348);
        vm.warp(t0 + 170);
        vm.prank(founder);
        small.checkIn(bytes32(0)); // the window is 336 s
        vm.warp(t0 + 347);
        vm.prank(worker);
        vm.expectRevert(abi.encodeWithSelector(TaskBook.NoticeRunning.selector, t0 + 348));
        small.takeTask(s, 0);
        vm.warp(t0 + 348);
        vm.prank(worker);
        small.takeTask(s, 0);
        assertEq(book.taskOf(s).deadline, t0 + 348 + 336);
        vm.warp(t0 + 348 + 336);
        small.settle();
        assertEq(small.locked(), 0);
        assertEq(uint8(book.taskOf(s).state), uint8(TaskBook.State.Returned));
    }
}
