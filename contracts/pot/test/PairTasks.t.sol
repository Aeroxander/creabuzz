// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {StackBase} from "./helpers/StackBase.sol";
import {Treasury} from "../src/Treasury.sol";
import {TaskBook} from "../src/TaskBook.sol";
import {Pair} from "../src/Pair.sol";

/// @notice A project run by a REAL Pair (made by the Launcher) through the whole task queue and exit notes: announce, take, a
/// take-out that is written a note, accept in part, claim. Every money call of the runner needs both signers; either one alone
/// is refused; and the proposal a second signer is shown (the call data in the Pair's `Proposed` event) carries everything an
/// app must say: for an announce the payee, the dollar maximum, the share of the pot and (with `noticeFor` and `unit`) the
/// notice and the deadline; for an accept the serial (and from the book: who was taken from, how much is set aside, the
/// deadline).
contract PairTasksTest is StackBase {
    bytes32 internal constant WHAT = keccak256("a task run by a pair");
    address internal worker = makeAddr("worker");
    address internal second = makeAddr("second signer");
    Pair internal pair;

    function setUp() public override {
        super.setUp();
        pair = _makePair(second);
        _join(alice, 60_000e6);
        _join(bob, 40_000e6);
    }

    function _keepAlive(uint256 ts) internal {
        _checkIn();
        uint256 at = vm.getBlockTimestamp();
        while (at + 10 days < ts) {
            at += 6 days; // an absolute time: the optimizer may cache a repeated vm.getBlockTimestamp()
            vm.warp(at);
            _checkIn();
        }
        vm.warp(ts);
    }

    /// @dev The call data of the last proposal, read from the Pair's own event (what an app shows the second signer).
    function _lastProposal(Vm.Log[] memory logs) internal view returns (bytes memory data) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(pair) && logs[i].topics[0] == Pair.Proposed.selector) {
                (, data,) = abi.decode(logs[i].data, (address, bytes, uint256));
            }
        }
    }

    function _announceViaPair(uint16 bps, uint256 max) internal returns (uint64 serial) {
        bytes memory call_ = abi.encodeCall(Treasury.announceTask, (WHAT, worker, max, bps));
        uint256 n = pair.nonce();
        vm.prank(founder);
        pair.propose(address(t), call_);
        vm.prank(second);
        pair.confirm(address(t), call_, n);
        serial = _book().nextSerial() - 1;
    }

    function test_theSecondSignerIsShownThePayeeTheMaximumTheShareAndTheDeadline() public {
        bytes memory call_ = abi.encodeCall(Treasury.announceTask, (WHAT, worker, 1500e6, 250));
        vm.recordLogs();
        vm.prank(founder);
        pair.propose(address(t), call_);
        bytes memory data = _lastProposal(vm.getRecordedLogs());
        assertEq(bytes4(data), Treasury.announceTask.selector, "the selector says what is proposed");
        bytes memory args = new bytes(data.length - 4);
        for (uint256 i; i < args.length; ++i) {
            args[i] = data[i + 4];
        }
        (bytes32 what, address payee, uint256 max, uint16 bps) = abi.decode(args, (bytes32, address, uint256, uint16));
        assertEq(what, WHAT, "the record the task is tied to");
        assertEq(payee, worker, "who is paid");
        assertEq(max, 1500e6, "the dollar maximum");
        assertEq(bps, 250, "the share of the pot, in ten-thousandths: 2.5%");
        // the dates: from the notice the Treasury will give a task of that share and the time unit
        (uint256 notice, uint256 window, uint256 dueAfterTake) = t.noticeFor(bps);
        assertEq(
            notice,
            2 * uint256(UNIT) + 250 * uint256(UNIT) / 1400,
            "14 days and 12 hours for each 1% (2.5% waits 15.25 days)"
        );
        assertEq(window, UNIT, "a task nobody takes in a time unit lapses");
        assertEq(dueAfterTake, 2 * uint256(UNIT), "once taken it is due two time units later");
        // and once confirmed the book says the same
        vm.prank(second);
        pair.confirm(address(t), call_, 0);
        TaskBook.Task memory k = _book().taskOf(1);
        assertEq(k.noticeEnd - k.announcedAt, notice);
        assertEq(k.expiresAt - k.noticeEnd, window);
    }

    function test_everyMoneyCallNeedsBothSignersAndNoOneSignerCanSpendOrPay() public {
        vm.prank(founder);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.announceTask(WHAT, worker, 1000e6, 100); // a signer alone
        vm.prank(second);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.announceTask(WHAT, worker, 1000e6, 100);
        uint64 a = _announceViaPair(100, 1000e6);
        _keepAlive(_book().taskOf(a).noticeEnd);
        vm.prank(worker);
        t.takeTask(a, 0);
        bytes4[3] memory sels =
            [Treasury.acceptTask.selector, Treasury.rejectTask.selector, Treasury.cancelTask.selector];
        for (uint256 i; i < sels.length; ++i) {
            vm.prank(founder);
            (bool ok,) = address(t).call(abi.encodeWithSelector(sels[i], a, 1));
            assertFalse(ok, "a signer alone is refused");
        }
        // a proposer cannot confirm their own call
        bytes memory call_ = abi.encodeCall(Treasury.acceptTask, (a, 100e6));
        uint256 n = pair.nonce();
        vm.prank(founder);
        pair.propose(address(t), call_);
        vm.prank(founder);
        vm.expectRevert(Pair.NotAllowed.selector);
        pair.confirm(address(t), call_, n);
        // the other signer's confirmation runs it, and the worker is paid
        vm.prank(second);
        pair.confirm(address(t), call_, n);
        assertEq(usd.balanceOf(worker), 100e6);
    }

    function test_theWholeQueueThroughAPair() public {
        uint64 a = _announceViaPair(500, 10_000e6);
        _keepAlive(_book().taskOf(a).noticeEnd);
        vm.prank(worker);
        t.takeTask(a, 0);
        uint256 set = t.locked();
        assertGt(set, 0);
        // a holder takes out and is written a note
        uint256 n = shares.balanceOf(alice) / 2;
        (uint256 q, uint256 qNote,) = t.quoteTakeOut(alice, n);
        vm.prank(alice);
        uint256 cash = t.leave(n, 0, alice);
        assertEq(cash, q);
        assertEq(_book().noteOf(a, alice), qNote);
        assertGt(qNote, 0);
        // both signers pay part of it
        uint256 pay = set / 2;
        bytes memory call_ = abi.encodeCall(Treasury.acceptTask, (a, pay));
        uint256 nn = pair.nonce();
        vm.prank(second);
        pair.propose(address(t), call_);
        vm.prank(founder);
        pair.confirm(address(t), call_, nn);
        assertEq(usd.balanceOf(worker), pay);
        uint256 claim = _book().claimableNote(a, alice);
        assertEq(claim, qNote * (set - pay) / set, "the note gets its share of what came back, at the stayers' ratio");
        t.claimNote(a, alice);
        assertEq(usd.balanceOf(alice), cash + claim);
        _assertConserved();
    }

    function test_aProposalToAcceptOneSerialCanTouchOnlyThatSerial() public {
        uint64 a = _announceViaPair(100, 1000e6);
        uint64 b = _announceViaPair(100, 1000e6);
        _keepAlive(_book().taskOf(b).noticeEnd);
        vm.startPrank(worker);
        t.takeTask(a, 0);
        t.takeTask(b, 0);
        vm.stopPrank();
        bytes memory call_ = abi.encodeCall(Treasury.acceptTask, (a, 1e6));
        uint256 n = pair.nonce();
        vm.prank(founder);
        pair.propose(address(t), call_);
        // meanwhile task a is rejected (both signers), then the old proposal is confirmed: it finds `a` ended and moves nothing
        bytes memory rej = abi.encodeCall(Treasury.rejectTask, (a));
        _both(pair, second, founder, rej);
        uint256 lockedB = _book().taskOf(b).locked;
        vm.prank(second);
        vm.expectRevert(TaskBook.WrongTaskState.selector);
        pair.confirm(address(t), call_, n);
        assertEq(_book().taskOf(b).locked, lockedB, "task b was not touched");
        assertEq(usd.balanceOf(worker), 0);
    }

    function test_aProposalLivesTwoTimeUnitsAndThenDies() public {
        bytes memory call_ = abi.encodeCall(Treasury.announceTask, (WHAT, worker, 1000e6, 100));
        uint256 n = pair.nonce();
        vm.prank(founder);
        pair.propose(address(t), call_);
        assertEq(pair.PROPOSAL_TTL(), 2 * uint256(UNIT));
        vm.warp(vm.getBlockTimestamp() + 2 * uint256(UNIT) + 1);
        vm.prank(second);
        vm.expectRevert(Pair.Expired.selector);
        pair.confirm(address(t), call_, n);
    }
}
