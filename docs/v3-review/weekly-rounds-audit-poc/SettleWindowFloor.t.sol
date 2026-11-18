// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {WeeklyRoundsTest} from "./WeeklyRounds.t.sol";

contract SettleWindowFloorTest is WeeklyRoundsTest {
    function _run(bool revenueFirst) internal returns (uint256 anaUsd, uint256 benUnits, uint256 deeUnits, uint256 benUsd) {
        uint256 id = rounds.open(address(dao));
        _sell(id, ANA, 50e18, 0);
        _bid(id, BEN, 30e18, 30);
        _bid(id, DEE, 30e18, 30);
        _close(id);
        if (revenueFirst) {
            vm.warp(block.timestamp + 1 days);
            usd.mint(address(dao), 100 * USD);
            assertEq(rounds.floorOf(address(dao)), 1_500_000);
            vm.prank(BEN);
            rounds.settle(id, 30);
        } else {
            rounds.settle(id, 30); // at closesAt, no delay at all
            vm.warp(block.timestamp + 1 days);
            usd.mint(address(dao), 100 * USD);
        }
        rounds.claim(id, ANA);
        rounds.claim(id, BEN);
        rounds.claim(id, DEE);
        return (usd.balanceOf(ANA), shares.balanceOf(BEN), shares.balanceOf(DEE), usd.balanceOf(BEN));
    }

    function test_settle_timing_does_not_change_anyone() public {
        uint256 snap = vm.snapshotState();
        (uint256 a1, uint256 b1, uint256 d1, uint256 bu1) = _run(true);
        vm.revertToState(snap);
        (uint256 a2, uint256 b2, uint256 d2, uint256 bu2) = _run(false);
        assertEq(a1, a2); assertEq(b1, b2); assertEq(d1, d2); assertEq(bu1, bu2);
        assertEq(a1, 62 * USD);
        emit log_named_uint("ana usd", a1);
    }
}
