// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import {FundingTermsTest} from "../FundingTerms.t.sol";
import {FundingTerms} from "../../src/FundingTerms.sol";

contract ExpiryScratch is FundingTermsTest {
    function test_scratch_units_created_after_expiry() public {
        _publish(false, 100e18);
        vm.warp(block.timestamp + terms.NOTICE());
        uint64 expiry = uint64(block.timestamp + 1 days);
        vm.prank(address(dao));
        terms.openTranche(40e18, uint128(110 * USD / 100), expiry);
        vm.warp(expiry - 1);
        uint256 id = rounds.openFunding(address(dao));
        _bid(id, BEN, 40e18, 20);
        // DAO cannot close it either
        vm.prank(address(dao));
        vm.expectRevert(FundingTerms.RoundOpen.selector);
        terms.closeTranche();
        uint256 settleAt = uint256(_closesAt(id)) + rounds.SETTLE_WINDOW() - 1;
        vm.warp(settleAt);
        (uint256 step,,) = rounds.clearingStep(id);
        rounds.settle(id, step);
        assertEq(loot.balanceOf(address(rounds)), 40e18);
        emit log_named_uint("seconds after expiry units created", settleAt - expiry);
    }
}
