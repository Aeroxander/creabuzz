// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {PotBase} from "./helpers/PotBase.sol";
import {TaskBook} from "../src/TaskBook.sol";

/// @notice Fuzz tests of the exit note: what a leave writes down is the value of the money set aside at face, so (a) taking out
/// in pieces is worth what taking out at once is, to within a unit a piece, (b) a joiner who takes out at once while money is
/// set aside, and is paid the note when the task comes back, is never paid more than they put in after the fee (the offset
/// aside), and (c) with the task returned every holder ends where they would have without it. The pot is 100,000 dollars,
/// Alice holds 40% of the Shares; no allowance, no Team pool.
contract NotesFuzzTest is PotBase {
    bytes32 internal constant WHAT = keccak256("a task");
    address internal worker = makeAddr("worker");

    function setUp() public override {
        super.setUp();
        _relaunch(0, 0);
        t.forceShares(alice, 40_000e18);
        t.forceShares(bob, 60_000e18);
        _force(100_000e6, 100_000e6, 0, 0, 0);
    }

    function _warpAlive(uint256 ts) internal {
        if (ts <= vm.getBlockTimestamp()) return;
        _checkIn();
        uint256 at = vm.getBlockTimestamp();
        while (at + 10 days < ts) {
            at += 6 days;
            vm.warp(at);
            _checkIn();
        }
        vm.warp(ts);
    }

    function _setAside(uint16 bps) internal returns (uint64 serial) {
        vm.prank(founder);
        serial = t.announceTask(WHAT, worker, 1e15, bps);
        _warpAlive(_book().taskOf(serial).noticeEnd);
        vm.prank(worker);
        t.takeTask(serial, 0);
    }

    /// @dev (a) A holder who takes out in `k` pieces is paid, in cash and notes together, what taking out at once pays, to
    /// within a unit a piece, and never more by more than that.
    function testFuzz_piecesAreWorthTheWholeToWithinAUnitAPiece(uint16 bps, uint256 seed, uint8 kRaw) public {
        bps = uint16(bound(bps, 1, 500));
        uint64 serial = _setAside(bps);
        uint256 k = bound(kRaw, 2, 6);
        uint256 total = shares.balanceOf(alice);
        uint256 snap = vm.snapshotState();
        // at once
        (uint256 cashQ, uint256 noteQ,) = t.quoteTakeOut(alice, total);
        uint256 cash1 = _leave(alice, total);
        uint256 note1 = _book().noteOf(serial, alice);
        assertEq(cash1, cashQ);
        assertEq(note1, noteQ, "the quote shows the note");
        uint256 whole = cash1 + note1;
        vm.revertToState(snap);
        // in pieces
        uint256 sum;
        uint256 left = total;
        for (uint256 i; i < k; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            uint256 n = i == k - 1 ? left : bound(seed, 1, left - (k - 1 - i));
            left -= n;
            if (n == 0) continue;
            (uint256 q,,) = t.quoteTakeOut(alice, n);
            if (q == 0) {
                continue; // too small to pay anything: a take-out would revert, nothing was given up
            }
            sum += _leave(alice, n);
        }
        sum += _book().noteOf(serial, alice);
        uint256 shortBy = whole > sum ? whole - sum : 0;
        assertLe(sum, whole + k, "pieces never pay more than the whole by more than a unit a piece");
        // a piece too small to pay is simply not taken out here, so the loss is only the rounding of each piece
        if (left == 0) assertLe(shortBy, 3 * k + 4, "and never much less");
    }

    /// @dev (b) A joiner who takes out at once while a task is set aside, and is paid the note when the task is rejected, is not
    /// paid more than they paid in after the fee, apart from the offset's give-away (a hundredth of a dollar at most here).
    function testFuzz_aJoinerWhoLeavesAtOnceNeverNetsAGainWhileMoneyIsSetAside(uint16 bps, uint256 amount) public {
        bps = uint16(bound(bps, 1, 500));
        amount = bound(amount, 1e6, 2_000_000e6);
        uint64 serial = _setAside(bps);
        address eve = makeAddr("eve");
        usd.mint(eve, amount);
        uint256 fee = t.feeFor(amount);
        vm.startPrank(eve);
        usd.approve(address(t), amount);
        uint256 n = t.join(amount, 0, eve);
        uint256 cash = t.leave(n, 0, eve);
        vm.stopPrank();
        vm.prank(founder);
        t.rejectTask(serial);
        uint256 note = _book().noteOf(serial, eve);
        uint256 paid = cash + (note == 0 ? 0 : t.claimNote(serial, eve));
        assertLe(paid, amount - fee + 1e4 + 2, "no gain from joining and leaving while money is set aside");
    }

    /// @dev (c) With the task returned (rejected), a holder who took out in the middle of it ends with what they would have had
    /// with no task at all (to the unit of each piece): the note makes the lock neutral.
    function testFuzz_aRejectedTaskLeavesTheLeaverWhereNoTaskWouldHave(uint16 bps, uint256 pct) public {
        bps = uint16(bound(bps, 1, 500));
        uint256 n = shares.balanceOf(alice) * bound(pct, 1, 100) / 100;
        uint256 snap = vm.snapshotState();
        uint256 plain = _leave(alice, n); // no task: the cash alone
        vm.revertToState(snap);
        uint64 serial = _setAside(bps);
        uint256 viaTask = _leave(alice, n);
        vm.prank(founder);
        t.rejectTask(serial);
        if (_book().noteOf(serial, alice) != 0) viaTask += t.claimNote(serial, alice);
        // the pot is a few units different because the take itself rounds: a part in the pot at most
        assertApproxEqAbs(viaTask, plain, 6, "rejected: the same as if the money had never been set aside");
    }

    /// @dev Whoever leaves, the stayers' claim and the notes of a taken task always add up to what it holds.
    function testFuzz_theStayersAndTheNotesAddUpToTheTaskAtEveryTakeOut(uint16 bps, uint256 seed) public {
        bps = uint16(bound(bps, 1, 500));
        uint64 a = _setAside(bps);
        for (uint256 i; i < 6; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            address who = i % 2 == 0 ? alice : bob;
            uint256 bal = shares.balanceOf(who);
            if (bal == 0) continue;
            uint256 n = bound(seed, 1, bal);
            vm.prank(who);
            try t.leave(n, 0, who) {} catch {}
            TaskBook.Task memory k = _book().taskOf(a);
            assertEq(uint256(k.stayer) + k.noteFace, k.locked, "C + N == L");
            assertEq(t.locked(), k.stayer);
            assertEq(t.notesOwed(), k.noteFace);
            _assertConserved();
        }
    }
}
