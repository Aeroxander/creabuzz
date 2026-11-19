// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {StackBase} from "./helpers/StackBase.sol";

/// @notice What the task calls cost, measured inside the call with the contracts made cold first (the transaction's own 21,000
/// and calldata are not counted). The numbers are logged; the assertions are generous ceilings that a heavy regression would
/// break. The real receipts on a local chain are in `scripts/pot-chain-loop.sh`.
contract GasTasksTest is StackBase {
    address internal worker = makeAddr("worker");
    bytes32 internal constant WHAT = keccak256("a task");

    function _cold() internal {
        vm.cool(address(t));
        vm.cool(address(_book()));
        vm.cool(address(usd));
        vm.cool(address(shares));
    }

    function setUp() public override {
        super.setUp();
        _join(alice, 50_000e6);
        _join(bob, 20_000e6);
    }

    function _keepAlive(uint256 ts) internal {
        _checkIn();
        uint256 at = vm.getBlockTimestamp();
        while (at + 10 days < ts) {
            at += 6 days; // an absolute time: the optimizer may cache a repeated block.timestamp
            vm.warp(at);
            _checkIn();
        }
        vm.warp(ts);
    }

    function _takenTask() internal returns (uint64 serial) {
        vm.prank(founder);
        serial = t.announceTask(WHAT, worker, 1000e6, 100);
        _keepAlive(_book().taskOf(serial).noticeEnd);
        vm.prank(worker);
        t.takeTask(serial, 0);
    }

    function test_gas_announce() public {
        vm.startPrank(founder);
        _cold();
        uint256 g = gasleft();
        t.announceTask(WHAT, worker, 1000e6, 100);
        uint256 used = g - gasleft();
        vm.stopPrank();
        emit log_named_uint("announce a task, gas", used);
        assertLt(used, 260_000);
    }

    function test_gas_take() public {
        vm.prank(founder);
        uint64 serial = t.announceTask(WHAT, worker, 1000e6, 100);
        _keepAlive(_book().taskOf(serial).noticeEnd);
        vm.startPrank(worker);
        _cold();
        uint256 g = gasleft();
        t.takeTask(serial, 0);
        uint256 used = g - gasleft();
        vm.stopPrank();
        emit log_named_uint("take a task (the ring of takes is empty), gas", used);
        assertLt(used, 300_000);
    }

    function test_gas_acceptRejectAndTheReturnInsideASettle() public {
        uint64 a = _takenTask();
        vm.startPrank(founder);
        _cold();
        uint256 g = gasleft();
        t.acceptTask(a, 400e6);
        uint256 used = g - gasleft();
        emit log_named_uint("accept a task in part, gas", used);
        assertLt(used, 200_000);
        vm.stopPrank();
        uint64 b = _takenTask();
        vm.startPrank(founder);
        _cold();
        g = gasleft();
        t.rejectTask(b);
        used = g - gasleft();
        emit log_named_uint("reject a task, gas", used);
        assertLt(used, 150_000);
        vm.stopPrank();
        // a task that ran out is returned by whatever comes first: what that adds to a take-out
        uint64 c = _takenTask();
        vm.warp(_book().taskOf(c).deadline + 1);
        uint256 n = shares.balanceOf(bob) / 2;
        vm.startPrank(bob);
        _cold();
        g = gasleft();
        t.leave(n, 0, bob);
        used = g - gasleft();
        vm.stopPrank();
        emit log_named_uint("a take-out that also returns one task that ran out, gas", used);
        assertLt(used, 260_000);
    }

    function test_gas_aSettleWithNothingDueCostsOneMoreStorageRead() public {
        _takenTask();
        vm.startPrank(alice);
        _cold();
        uint256 g = gasleft();
        t.settle();
        uint256 used = g - gasleft();
        vm.stopPrank();
        emit log_named_uint("settle with an open task not yet due, gas", used);
        assertLt(used, 120_000);
    }
}
