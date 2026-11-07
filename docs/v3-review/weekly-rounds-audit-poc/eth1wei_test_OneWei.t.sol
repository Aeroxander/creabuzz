// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {FundingTermsTest} from "./FundingTerms.t.sol";
import {FundingTerms} from "../src/FundingTerms.sol";

contract Griefer { function go(address d) external payable { (bool ok,) = d.call{value: msg.value}(""); require(ok, "rejected"); } }

contract OneWeiTest is FundingTermsTest {
    address constant EVE = address(0xE7E);
    function test_one_wei_blocks_settlement() public {
        uint256 id = _selling(40e18, uint128(USD));
        _bid(id, BEN, 40e18, 2);
        vm.deal(EVE, 1);
        Griefer g = new Griefer();
        vm.prank(EVE);
        g.go{value: 1}(address(dao)); // plain transfer via receive()
        assertEq(address(dao).balance, 1);
        vm.warp(_closesAt(id));
        (uint256 step,,) = rounds.clearingStep(id);
        // every step: the right one reverts with OtherAssets, others with WrongPrice/BelowFloor
        vm.expectRevert(abi.encodeWithSelector(FundingTerms.OtherAssets.selector, address(0)));
        rounds.settle(id, step);
        vm.warp(_closesAt(id) + rounds.SETTLE_WINDOW());
        assertTrue(rounds.isVoid(id));
        rounds.claim(id, BEN);
        assertEq(usd.balanceOf(BEN), 1_000 * USD, "full refund");
        assertEq(_sold(), 0);
        (, uint128 taken,,) = terms.tranches(address(dao));
        assertEq(taken, 0);
        vm.warp(block.timestamp + 7 days);
        vm.expectRevert(abi.encodeWithSelector(FundingTerms.OtherAssets.selector, address(0)));
        rounds.openFunding(address(dao));
    }
}
