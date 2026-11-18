// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {FundingTermsTest} from "./FundingTerms.t.sol";
import {FundingTerms} from "src/FundingTerms.sol";

contract DustGrief is FundingTermsTest {
    function test_one_wei_voids_round() public {
        _publish(false, 100e18);
        vm.warp(block.timestamp + terms.NOTICE());
        _tranche(40e18, uint128(USD));
        uint256 id = rounds.openFunding(address(dao));
        _bid(id, BEN, 40e18, 2);
        address griefer = address(0xBAD);
        vm.deal(griefer, 1);
        vm.prank(griefer);
        (bool ok,) = address(dao).call{value: 1}("");
        assertTrue(ok);
        vm.warp(_closesAt(id));
        (uint256 step,,) = rounds.clearingStep(id);
        vm.expectRevert(abi.encodeWithSelector(FundingTerms.OtherAssets.selector, address(0)));
        rounds.settle(id, step);
        vm.warp(_closesAt(id) + rounds.SETTLE_WINDOW());
        assertTrue(rounds.isVoid(id));
        vm.warp(block.timestamp + 7 days);
        // accept(address(0)) does not help
        address[] memory a = new address[](1);
        vm.prank(address(dao));
        terms.accept(a, true);
        vm.expectRevert(abi.encodeWithSelector(FundingTerms.OtherAssets.selector, address(0)));
        rounds.openFunding(address(dao));
    }
}
