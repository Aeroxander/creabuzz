// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {FundingTermsTest} from "repo/test/FundingTerms.t.sol";
import {WeeklyRounds} from "repo/src/WeeklyRounds.sol";
import {console} from "forge-std/console.sol";

contract Step2Test is FundingTermsTest {
    function test_step2_odd_floor() public {
        // treasury 200.034567 USDC over 200 units: floor 1000172 (not divisible by 100)
        usd.mint(address(dao), 34567);
        uint256 id = _selling(40e18, uint128(USD)); // least 1.00 <= floor, so lowest = 2
        uint256 f = rounds.floorOf(address(dao));
        console.log("floor", f, "price2", rounds.priceAt(id, 2));
        _bid(id, BEN, 20e18, 2); // undersubscribed at step 2
        vm.warp(_closesAt(id));
        (uint256 step,,) = rounds.clearingStep(id);
        console.log("clearing step", step);
        vm.expectRevert(abi.encodeWithSelector(WeeklyRounds.BelowFloor.selector, f));
        rounds.settle(id, step);
        // no step-2 settle possible at all; is step 3 the next? settle(id,3) is WrongPrice presumably
    }
}
