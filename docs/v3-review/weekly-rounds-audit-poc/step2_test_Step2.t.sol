// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {FundingTermsTest} from "C/test/FundingTerms.t.sol";
import {WeeklyRounds} from "C/src/WeeklyRounds.sol";

contract Step2Test is FundingTermsTest {
    function test_step2_floor_not_div_100() public {
        // 200 units outside; make treasury 246.913400 USDC -> floor 1_234_567 per unit
        usd.mint(address(dao), 246_913_400 - 200 * USD);
        assertEq(rounds.floorOf(address(dao)), 1_234_567);
        // least price at or below 1.02x floor -> lowest = 2
        uint256 id = _selling(10e18, 1);
        _bid(id, BEN, 5e18, 2);
        vm.warp(_closesAt(id));
        (uint256 step,,) = rounds.clearingStep(id);
        emit log_named_uint("clearing step", step);
        emit log_named_uint("price", rounds.priceAt(id, step));
        emit log_named_uint("floorNow", rounds.floorOf(address(dao)));
        vm.expectRevert(abi.encodeWithSelector(WeeklyRounds.BelowFloor.selector, uint256(1_234_567)));
        rounds.settle(id, step);
        // no other step settles either
        for (uint256 s; s < 6; ++s) {
            try rounds.settle(id, s) { emit log_named_uint("settled at", s); fail(); } catch {}
        }
    }

    function test_step2_floor_div_100_settles() public {
        uint256 id = _selling(10e18, 1);
        _bid(id, BEN, 5e18, 2);
        _settle(id);
    }

    function test_one_cent_donation_voids_at_exact_line() public {
        uint256 id = _selling(10e18, 1);
        _bid(id, BEN, 5e18, 2);
        usd.mint(address(dao), 1e4); // one cent
        vm.warp(_closesAt(id));
        (uint256 step,,) = rounds.clearingStep(id);
        vm.expectRevert();
        rounds.settle(id, step);
    }
}
