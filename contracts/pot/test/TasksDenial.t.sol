// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {StackBase} from "./helpers/StackBase.sol";
import {Treasury} from "../src/Treasury.sol";
import {TaskBook} from "../src/TaskBook.sol";

/// @notice Can anything stop a holder taking out or stop the queue clearing? Slots are never held forever, taken tasks come back
/// without the runner, a worker or a holder that cannot receive blocks only his own payment, gas does not grow with leavers or
/// notes, and the edges of the clock agree with the quotes. (The cap of the queue is in `TasksCaps.t.sol`.)
contract TasksDenialTest is StackBase {
    address internal worker = makeAddr("worker");
    address internal worker2 = makeAddr("worker2");
    address internal bot = makeAddr("bot");

    function setUp() public override {
        super.setUp();
        _join(alice, 60_000e6);
        _join(bob, 40_000e6);
    }

    function _warpAlive(uint256 ts) internal {
        if (ts <= block.timestamp) return;
        _checkIn();
        uint256 at = block.timestamp;
        while (at + 10 days < ts) {
            at += 6 days;
            vm.warp(at);
            _checkIn();
        }
        vm.warp(ts);
    }

    function _ann(address payee, uint16 bps) internal returns (uint64 s) {
        vm.prank(founder);
        s = t.announceTask(keccak256(abi.encode(block.timestamp, bps, payee)), payee, 1e15, bps);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // the cap and the slots
    // ---------------------------------------------------------------------------------------------------------------

    /// @dev The same with money left for 2N: no one but the runner can return a stranger's take early; the cost to the bot is
    /// only gas. Measures what is locked.
    function test_slotsAreNeverHeldForever() public {
        for (uint256 i; i < 8; ++i) {
            _ann(address(0), 500);
        }
        vm.prank(founder);
        vm.expectRevert(TaskBook.TooManyOpen.selector);
        t.announceTask(keccak256("9"), address(0), 1e6, 1);
        // nothing is taken: the notice of a 5% task is 16.5 days, the take window 7 more; then every slot is free again
        _warpAlive(block.timestamp + 24 days);
        vm.prank(founder);
        t.announceTask(keccak256("9"), address(0), 1e6, 1);
        assertEq(_book().openCount(), 1);
        assertEq(_book().nextSerial(), 10);
    }

    /// @dev Eight tasks taken (eight times 1.25%), the runner is gone: they come back by themselves 14 days after the take.
    function test_takenTasksComeBackWithoutTheRunner() public {
        uint64[8] memory ids;
        for (uint256 i; i < 8; ++i) {
            ids[i] = _ann(worker, 125);
        }
        _warpAlive(_book().taskOf(ids[7]).noticeEnd);
        for (uint256 i; i < 8; ++i) {
            vm.prank(worker);
            t.takeTask(ids[i], 0);
        }
        assertEq(_book().openCount(), 8);
        uint256 lk = t.locked();
        assertGt(lk, 0);
        // everyone leaves while it is out: notes are written against all eight
        uint256 g = gasleft();
        uint256 half = shares.balanceOf(alice) / 2;
        vm.prank(alice);
        t.leave(half, 0, alice);
        emit log_named_uint("gas: a take-out that writes notes against 8 tasks", g - gasleft());
        // nobody checks in again; at the deadline anyone settles and the money is back
        vm.warp(block.timestamp + 14 days);
        g = gasleft();
        vm.prank(stranger);
        t.settle();
        emit log_named_uint("gas: settle that returns 8 tasks with notes", g - gasleft());
        assertEq(t.locked(), 0);
        assertEq(_book().openCount(), 0);
        for (uint256 i; i < 8; ++i) {
            vm.prank(stranger);
            t.claimNote(ids[i], alice);
        }
        assertEq(t.notesOwed(), 0, "the notes were claimed in full");
    }

    // ---------------------------------------------------------------------------------------------------------------
    // a payee or a holder who cannot receive
    // ---------------------------------------------------------------------------------------------------------------

    function test_aWorkerWhoCannotReceiveBlocksOnlyHisOwnPayment() public {
        uint64 a = _ann(worker, 300);
        uint64 b = _ann(worker2, 300);
        _warpAlive(_book().taskOf(b).noticeEnd);
        vm.prank(worker);
        t.takeTask(a, 0);
        vm.prank(worker2);
        t.takeTask(b, 0);
        uint256 nb = shares.balanceOf(bob);
        vm.prank(bob);
        t.leave(nb / 2, 0, bob); // a note against both
        usd.setBlocked(worker, true);
        vm.prank(founder);
        vm.expectRevert();
        t.acceptTask(a, 1e6); // stuck for him
        vm.prank(founder);
        t.acceptTask(b, 1000e6); // the other worker is paid
        vm.prank(founder);
        t.rejectTask(a); // and the stuck task can still be cleared by the runner
        // a holder who cannot receive cannot claim, the others can
        usd.setBlocked(bob, true);
        vm.expectRevert();
        t.claimNote(a, bob);
        assertGt(_book().noteOf(b, bob), 0);
    }

    /// @dev A blocked holder cannot claim, but everyone else can take out, claim, and the project can wind down.
    function test_aBlockedHolderBlocksNobodyElse() public {
        uint64 a = _ann(worker, 300);
        _warpAlive(_book().taskOf(a).noticeEnd);
        vm.prank(worker);
        t.takeTask(a, 0);
        uint256 hb = shares.balanceOf(bob) / 2;
        uint256 ha = shares.balanceOf(alice) / 2;
        vm.prank(bob);
        t.leave(hb, 0, bob);
        vm.prank(alice);
        t.leave(ha, 0, alice);
        usd.setBlocked(bob, true);
        vm.prank(founder);
        t.rejectTask(a);
        vm.expectRevert();
        t.claimNote(a, bob);
        t.claimNote(a, alice);
        vm.prank(founder);
        t.windDown();
        uint256 left = shares.balanceOf(alice);
        vm.prank(alice);
        assertGt(t.leave(left, 0, alice), 0);
        // what stays unclaimed is only bob's own note, and the rounding of the last claim
        assertEq(t.notesOwed(), _book().taskOf(a).notesLeft);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // gas that grows
    // ---------------------------------------------------------------------------------------------------------------

    /// @dev Many leavers and many notes: a take-out does not loop over them.
    function test_gasDoesNotGrowWithLeaversOrNotes() public {
        uint64[8] memory ids;
        for (uint256 i; i < 8; ++i) {
            ids[i] = _ann(worker, 125);
        }
        _warpAlive(_book().taskOf(ids[7]).noticeEnd);
        for (uint256 i; i < 8; ++i) {
            vm.prank(worker);
            t.takeTask(ids[i], 0);
        }
        uint256 first;
        uint256 last;
        for (uint256 i; i < 60; ++i) {
            address who = makeAddr(string.concat("leaver", vm.toString(i)));
            _join(who, 1000e6);
            uint256 all = shares.balanceOf(who);
            uint256 g = gasleft();
            vm.prank(who);
            t.leave(all, 0, who);
            uint256 used = g - gasleft();
            if (i == 0) first = used;
            last = used;
        }
        emit log_named_uint("gas of the first take-out", first);
        emit log_named_uint("gas of the 60th take-out", last);
        assertLe(last, first + first / 10, "gas grew with the number of leavers");
        uint256 big = shares.balanceOf(alice);
        vm.prank(alice);
        t.leave(big, 0, alice);
    }

    /// @dev Sweep of a wind-down with eight taken tasks that carry notes.
    function test_gasOfAWindDownWithEightTakenTasks() public {
        uint64[8] memory ids;
        for (uint256 i; i < 8; ++i) {
            ids[i] = _ann(worker, 125);
        }
        _warpAlive(_book().taskOf(ids[7]).noticeEnd);
        for (uint256 i; i < 8; ++i) {
            vm.prank(worker);
            t.takeTask(ids[i], 0);
        }
        uint256 third = shares.balanceOf(bob) / 3;
        vm.prank(bob);
        t.leave(third, 0, bob);
        uint256 g = gasleft();
        vm.prank(founder);
        t.windDown();
        emit log_named_uint("gas: wind-down that returns 8 taken tasks with notes", g - gasleft());
        assertEq(t.locked(), 0);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // the seconds at the edges
    // ---------------------------------------------------------------------------------------------------------------

    /// @dev At the very last second of the take window, at the deadline minus one and at the deadline: take-out, quote, claim.
    function test_edgesOfTheClock() public {
        uint64 a = _ann(worker, 300);
        TaskBook.Task memory k0 = _book().taskOf(a);
        _warpAlive(k0.expiresAt - 1);
        vm.prank(worker);
        t.takeTask(a, 0); // the last second of the window
        TaskBook.Task memory k = _book().taskOf(a);
        assertEq(k.deadline, k0.expiresAt - 1 + 2 * uint256(UNIT));
        uint256 id = vm.snapshotState();
        // one second before the deadline: a take-out writes a note, the quote agrees, a payment is still possible
        _checkIn();
        vm.warp(k.deadline - 1);
        uint256 n = shares.balanceOf(bob) / 2;
        (uint256 qc, uint256 qn,) = t.quoteTakeOut(bob, n);
        vm.prank(bob);
        uint256 cash = t.leave(n, 0, bob);
        assertEq(cash, qc);
        assertEq(_book().noteOf(a, bob), qn, "quote = note, one second before");
        assertGt(qn, 0);
        vm.prank(founder);
        t.acceptTask(a, 1000e6);
        t.claimNote(a, bob);
        vm.revertToState(id);
        // at the deadline: the money is back before anything else, no note, the payment is refused
        vm.warp(k.deadline);
        (qc, qn,) = t.quoteTakeOut(bob, n);
        assertEq(qn, 0, "the quote skips a task that is due this second");
        vm.prank(bob);
        cash = t.leave(n, 0, bob);
        assertEq(cash, qc);
        assertEq(_book().noteOf(a, bob), 0);
        vm.prank(founder);
        vm.expectRevert();
        t.acceptTask(a, 1e6);
        vm.prank(stranger);
        t.returnTask(a);
        vm.revertToState(id);
        // a note taken one second before the deadline is claimable at the deadline, in full
        vm.warp(k.deadline - 1);
        vm.prank(bob);
        t.leave(n, 0, bob);
        uint256 note = _book().noteOf(a, bob);
        vm.warp(k.deadline);
        vm.prank(stranger);
        assertEq(t.claimNote(a, bob), note, "an unpaid task pays the note at its face");
        assertEq(t.notesOwed(), 0);
    }
}
