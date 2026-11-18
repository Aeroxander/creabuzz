// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {WeeklyRoundsTest} from "./WeeklyRounds.t.sol";
import {console} from "forge-std/console.sol";

contract WashTest is WeeklyRoundsTest {
    function test_wash_1wei() public {
        usd.mint(ANA, 10 * USD);
        vm.prank(ANA);
        usd.approve(address(rounds), type(uint256).max);
        uint256 id = rounds.open(address(dao));
        uint256 u0 = usd.balanceOf(ANA);
        uint256 s0 = shares.balanceOf(ANA);
        _sell(id, ANA, 1, 1023);
        _bid(id, ANA, 1, 1023);
        uint256 step = _settle(id);
        vm.prank(ANA);
        rounds.claim(id, ANA);
        console.log("step", step);
        console.log("price", rounds.priceAt(id, step));
        console.log("usd lost", u0 - usd.balanceOf(ANA));
        assertEq(shares.balanceOf(ANA), s0);
        assertEq(step, 1023);
    }
}
