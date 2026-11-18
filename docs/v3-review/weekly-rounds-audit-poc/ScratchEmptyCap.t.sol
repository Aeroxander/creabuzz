// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {WeeklyRoundsTest} from "./WeeklyRounds.t.sol";
import {WeeklyRounds} from "../src/WeeklyRounds.sol";
contract ScratchEmptyCap is WeeklyRoundsTest {
    function test_empty_treasury_cap() public {
        vm.prank(address(dao));
        usd.transfer(address(0xdead), 200 * USD);
        assertEq(rounds.floorOf(address(dao)), 0);
        uint256 id = rounds.open(address(dao));
        assertEq(rounds.priceAt(id, 1023), 1023e4, "10.23 USDC top");
        _sell(id, ANA, 10e18, 1023);
        vm.expectRevert(abi.encodeWithSelector(WeeklyRounds.BadStep.selector, 1024));
        _bid(id, BEN, 10e18, 1024);
        _bid(id, BEN, 10e18, 1023);
        _settle(id);
        rounds.claim(id, ANA);
        // 10 * 10.23 = 102.3; cut = 20.46
        assertEq(usd.balanceOf(ANA), 8184e4, "81.84 to the seller");
        assertEq(usd.balanceOf(address(dao)), 2046e4, "20.46 cut = 20% of whole price");
    }
}
