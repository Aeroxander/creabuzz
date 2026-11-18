// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;
import {FundingTermsTest} from "./FundingTerms.t.sol";
contract ExpiryPoC is FundingTermsTest {
    function test_poc_settles_after_tranche_expiry() public {
        _publish(false, 100e18);
        vm.warp(block.timestamp + terms.NOTICE());
        uint64 expiry = uint64(block.timestamp + 1 days);
        vm.prank(address(dao));
        terms.openTranche(40e18, uint128(110 * USD / 100), expiry);
        vm.warp(expiry - 1);
        uint256 id = rounds.openFunding(address(dao));
        _bid(id, BEN, 40e18, 15);
        vm.warp(uint256(_closesAt(id)) + 2 days - 1);
        assertGt(block.timestamp, expiry);
        emit log_named_uint("seconds after expiry", block.timestamp - expiry);
        (uint256 step,,) = rounds.clearingStep(id);
        rounds.settle(id, step);
        assertEq(loot.balanceOf(address(rounds)), 40e18, "units created after expiry");
    }
}
