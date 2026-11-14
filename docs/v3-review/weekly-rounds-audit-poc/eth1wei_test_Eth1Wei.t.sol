// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {FundingTermsTest} from "./FundingTerms.t.sol";
import {FundingTerms} from "../src/FundingTerms.sol";

contract Forcer {
    constructor(address payable to) payable { selfdestruct(to); }
}

contract Eth1WeiTest is FundingTermsTest {
    address internal constant MALLORY = address(0xBAD);

    function _run(bool forced) internal {
        uint256 id = _selling(40e18, uint128(USD));
        _bid(id, BEN, 40e18, 2);
        uint256 benBefore = usd.balanceOf(BEN);
        vm.deal(MALLORY, 1);
        vm.prank(MALLORY);
        if (forced) {
            new Forcer{value: 1}(payable(address(dao)));
        } else {
            (bool ok,) = address(dao).call{value: 1}("");
            assertTrue(ok, "receive accepts 1 wei");
        }
        assertEq(address(dao).balance, 1);
        vm.warp(_closesAt(id));
        (uint256 step,,) = rounds.clearingStep(id);
        vm.expectRevert(abi.encodeWithSelector(FundingTerms.OtherAssets.selector, address(0)));
        rounds.settle(id, step);
        // every step fails the same way
        for (uint256 s; s < 8; ++s) {
            try rounds.settle(id, s) { fail(); } catch {}
        }
        vm.warp(uint256(_closesAt(id)) + rounds.SETTLE_WINDOW());
        assertTrue(rounds.isVoid(id));
        rounds.claim(id, BEN);
        (, uint128 taken,,) = terms.tranches(address(dao));
        assertEq(taken, 0, "tranche back");
        assertEq(_sold(), 0);
        emit log_named_uint("ben refunded", usd.balanceOf(BEN) - benBefore);
        // and the next open is blocked too while 1 wei sits there
        vm.warp(5875200);
        vm.expectRevert(abi.encodeWithSelector(FundingTerms.OtherAssets.selector, address(0)));
        rounds.openFunding(address(dao));
    }

    function test_1wei_via_receive_voids_round() public { _run(false); }
    function test_1wei_forced_selfdestruct_voids_round() public { _run(true); }
}
