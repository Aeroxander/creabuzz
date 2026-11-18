// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;
import {WeeklyRoundsTest} from "repo/test/WeeklyRounds.t.sol";
import {console} from "forge-std/console.sol";
contract WashTest is WeeklyRoundsTest {
    function test_wash_one_wei() public {
        uint256 id = rounds.open(address(dao));
        usd.mint(ANA, 10 * USD);
        vm.prank(ANA); usd.approve(address(rounds), type(uint256).max);
        uint256 u0 = usd.balanceOf(ANA); uint256 s0 = shares.balanceOf(ANA);
        _sell(id, ANA, 1, 1023);
        _bid(id, ANA, 1, 1023);
        uint256 step = _settle(id);
        rounds.claim(id, ANA);
        console.log("step", step);
        console.log("price", rounds.priceAt(id, step));
        console.log("usd delta (lost)", u0 - usd.balanceOf(ANA));
        assertEq(shares.balanceOf(ANA), s0);
    }
    function test_wash_with_genuine_orders() public {
        uint256 id = rounds.open(address(dao));
        usd.mint(ANA, 10 * USD);
        vm.prank(ANA); usd.approve(address(rounds), type(uint256).max);
        _sell(id, CY, 10e18, 0);
        _bid(id, BEN, 10e18, 30);
        _sell(id, ANA, 1, 1023);
        _bid(id, ANA, 1, 1023);
        uint256 step = _settle(id);
        console.log("step with real orders", step);
    }
}
