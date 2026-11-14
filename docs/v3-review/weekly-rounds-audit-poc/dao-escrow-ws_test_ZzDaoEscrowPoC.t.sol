// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {WeeklyRoundsTest} from "./WeeklyRounds.t.sol";

contract DaoEscrowPoC is WeeklyRoundsTest {
    function test_poc_dao_escrow_dilutes_leavers() public {
        // 200 leavable units, 200 USDC, floor 1.00. DAO gets 200 own Shares (not counted).
        vm.startPrank(address(dao));
        shares.mintFromMoloch(address(dao), 200e18);
        shares.approve(address(rounds), 200e18);
        vm.stopPrank();
        assertEq(rounds.floorOf(address(dao)), 1 * USD);
        uint256 id = rounds.open(address(dao));
        vm.prank(address(dao));
        rounds.sell(id, 200e18, 1023);
        assertEq(rounds.floorOf(address(dao)), USD / 2, "floor halves while DAO shares escrowed");
        uint256 before = usd.balanceOf(CY);
        vm.prank(CY);
        dao.ragequit(_leaveWithUsd(), 10e18, 0);
        emit log_named_uint("CY got for 10 Shares (USDC 6dp)", usd.balanceOf(CY) - before);
        // round voids; anyone returns DAO's shares
        _close(id);
        vm.warp(block.timestamp + rounds.SETTLE_WINDOW());
        rounds.claim(id, address(dao));
        emit log_named_uint("floor after (6dp)", rounds.floorOf(address(dao)));
    }
}
