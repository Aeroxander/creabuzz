// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {WeeklyRoundsTest} from "../WeeklyRounds.t.sol";
import "forge-std/console.sol";
contract WashPoC is WeeklyRoundsTest {
    function test_wash_poc() public {
        uint256 id = rounds.open(address(dao));
        usd.mint(ANA, 10 * USD);
        vm.prank(ANA); usd.approve(address(rounds), type(uint256).max);
        uint256 u0 = usd.balanceOf(ANA); uint256 s0 = shares.balanceOf(ANA); uint256 t0 = usd.balanceOf(address(dao));
        _sell(id, ANA, 1, 1023);
        _bid(id, ANA, 1, 1023);
        uint256 step = _settle(id);
        rounds.claim(id, ANA);
        (step,,) = (step, 0, false);
        console.log("step", step);
        console.log("price", rounds.priceAt(id, step));
        console.log("ana usdc spent", u0 - usd.balanceOf(ANA));
        assertEq(shares.balanceOf(ANA), s0);
        console.log("treasury delta", usd.balanceOf(address(dao)) - t0);
    }
    function test_wash_one_share() public {
        uint256 id = rounds.open(address(dao));
        usd.mint(ANA, 20 * USD);
        vm.prank(ANA); usd.approve(address(rounds), type(uint256).max);
        uint256 u0 = usd.balanceOf(ANA);
        _sell(id, ANA, 1e18, 1023);
        _bid(id, ANA, 1e18, 1023);
        _settle(id);
        rounds.claim(id, ANA);
        console.log("ana cost 1 share", u0 - usd.balanceOf(ANA));
    }
}
