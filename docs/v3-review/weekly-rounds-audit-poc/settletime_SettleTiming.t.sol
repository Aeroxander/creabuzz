// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {FundingTermsTest} from "/Volumes/ExternalSSD/Applications/creabuzz/contracts/test/FundingTerms.t.sol";
import {Payouts} from "/Volumes/ExternalSSD/Applications/creabuzz/contracts/src/Payouts.sol";

contract SettleTimingTest is FundingTermsTest {
    function _run(bool sellerFirst) internal returns (uint256 aliceGot, uint256 benGot) {
        Payouts module = _payouts();
        uint256 id = rounds.open(address(dao));
        vm.prank(ALICE);
        shares.approve(address(rounds), 50e18);
        vm.prank(ALICE);
        rounds.sell(id, 50e18, 0);
        _bid(id, BEN, 30e18, 0);
        vm.warp(_closesAt(id) + 1 days);
        // Revenue lands at the module after bidding closed, not yet distributed: 40 USDC, half to holders.
        usd.mint(address(module), 40 * USD);
        (uint256 step,,) = rounds.clearingStep(id);
        if (sellerFirst) {
            vm.startPrank(ALICE);
            module.distribute();
            rounds.settle(id, step);
            vm.stopPrank();
        } else {
            vm.startPrank(BEN);
            rounds.settle(id, step);
            module.distribute();
            vm.stopPrank();
        }
        uint256 a = usd.balanceOf(ALICE);
        rounds.claim(id, ALICE);
        aliceGot = usd.balanceOf(ALICE) - a;
        uint256 b = usd.balanceOf(BEN);
        rounds.claim(id, BEN);
        benGot = usd.balanceOf(BEN) - b;
    }

    function test_seller_orders_distribute_then_settle() public {
        (uint256 a, uint256 b) = _run(true);
        emit log_named_uint("alice (seller) got", a);
        emit log_named_uint("ben (buyer) got", b);
    }

    function test_buyer_settles_first() public {
        (uint256 a, uint256 b) = _run(false);
        emit log_named_uint("alice (seller) got", a);
        emit log_named_uint("ben (buyer) got", b);
    }
}
