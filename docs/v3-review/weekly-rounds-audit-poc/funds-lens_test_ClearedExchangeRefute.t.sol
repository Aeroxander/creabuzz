// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {FundsLensTest} from "./FundsLens.t.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract ClearedExchangeRefute is FundsLensTest {
    function test_cleared_then_renamed_claims_recover() public {
        uint256 id = rounds.open(address(dao));
        vm.prank(ALICE); shares.approve(address(rounds), 50e18);
        vm.prank(ALICE); rounds.sell(id, 50e18, 0);
        vm.prank(BEN); rounds.bid(id, 20e18, 0);
        (,,, uint64 closesAt,,,,,,,,,,,,,,) = rounds.rounds(id);
        vm.warp(closesAt);
        (uint256 step,,) = rounds.clearingStep(id);
        rounds.settle(id, step);
        vm.prank(address(dao)); shares.clearExitExchange();
        uint256 a0 = usd.balanceOf(ALICE);
        vm.expectRevert(); rounds.claim(id, ALICE);
        vm.expectRevert(); rounds.claim(id, BEN);
        assertEq(usd.balanceOf(ALICE), a0, "no money without leaving");
        // Only way back: a new vote to re-announce plus 30 days.
        vm.prank(address(dao)); shares.announceExitExchange(address(rounds));
        vm.warp(block.timestamp + 29 days);
        vm.expectRevert(); shares.activateExitExchange();
        vm.warp(block.timestamp + 1 days);
        shares.activateExitExchange();
        rounds.claim(id, ALICE);
        rounds.claim(id, BEN);
        assertGt(usd.balanceOf(ALICE), a0);
        assertEq(shares.balanceOf(BEN), 20e18);
        emit log_named_uint("alice money", usd.balanceOf(ALICE) - a0);
    }
}
