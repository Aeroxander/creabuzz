// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {WeeklyRoundsTest} from "./WeeklyRounds.t.sol";
import {WeeklyRounds} from "src/WeeklyRounds.sol";

contract StrandTest is WeeklyRoundsTest {
    function test_strand_after_settle_buyer_and_partial_seller() public {
        uint256 id = rounds.open(address(dao));
        _sell(id, ANA, 50e18, 10);
        _bid(id, BEN, 30e18, 30);
        assertEq(_settle(id), 10); // ANA sells 30 of 50 at 1.10
        uint256 benBefore = usd.balanceOf(BEN);
        vm.prank(address(dao));
        shares.clearExitExchange(); // after settlement, no notice
        vm.expectRevert();
        rounds.claim(id, BEN);
        vm.expectRevert();
        rounds.claim(id, ANA); // partly filled seller: money also stuck
        vm.prank(BEN);
        rounds.claimAndLeave(id, _leaveWithUsd());
        emit log_named_uint("BEN paid (escrow 39)", 39 * USD);
        emit log_named_uint("BEN got back by leaving", usd.balanceOf(BEN) - benBefore);
        // re-naming restores claims after 30 days
        vm.prank(address(dao));
        shares.announceExitExchange(address(rounds));
        vm.warp(block.timestamp + 30 days);
        shares.activateExitExchange();
        rounds.claim(id, ANA);
        emit log_named_uint("ANA usd after renaming", usd.balanceOf(ANA));
        emit log_named_uint("ANA shares after renaming", shares.balanceOf(ANA));
    }
}
