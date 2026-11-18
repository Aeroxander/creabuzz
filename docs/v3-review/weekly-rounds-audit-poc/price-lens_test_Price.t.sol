// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {WeeklyRounds} from "../src/WeeklyRounds.sol";

contract Tok {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalSupply;
    address public exitExchange;
    address public lockGuard;

    function setExchange(address x) external { exitExchange = x; }
    function mint(address to, uint256 a) external { balanceOf[to] += a; totalSupply += a; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a; balanceOf[to] += a; return true;
    }
    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        allowance[f][msg.sender] -= a; balanceOf[f] -= a; balanceOf[to] += a; return true;
    }
}

contract Terms {
    uint256 public units;
    uint256 public least;
    Tok public token;
    uint256 public settled = type(uint256).max;

    constructor(Tok t) { token = t; }
    function set(uint256 u, uint256 l) external { units = u; least = l; }
    function reserve(address) external view returns (uint256, uint256, address) { return (units, least, address(token)); }
    function settle(address, uint256 sold) external { settled = sold; if (sold != 0) token.mint(msg.sender, sold); }
}

contract Dao {
    Tok public shares;
    Tok public loot;
    address public payouts;
    Terms public terms;

    constructor(Tok s, Tok l, Terms t) { shares = s; loot = l; terms = t; }
    function votingWeight() external view returns (address) { return address(this); }
    function mandateFactory() external view returns (address) { return address(this); }
    function fundingTerms() external view returns (address) { return address(terms); }
}

contract PriceTest is Test {
    Tok usd;
    Tok shares;
    Tok loot;
    Terms terms;
    Dao dao;
    WeeklyRounds rounds;
    address S1 = address(0x51);
    address S2 = address(0x52);
    address S3 = address(0x53);
    address B1 = address(0xB1);
    address B2 = address(0xB2);
    address B3 = address(0xB3);

    function setUp() public {
        vm.warp(100 days);
        usd = new Tok();
        shares = new Tok();
        loot = new Tok();
        terms = new Terms(loot);
        dao = new Dao(shares, loot, terms);
        rounds = new WeeklyRounds(IERC20(address(usd)), 1e4);
        shares.setExchange(address(rounds));
        // 200 units can leave.
        shares.mint(S1, 100e18);
        shares.mint(S2, 50e18);
        shares.mint(S3, 50e18);
        address[3] memory s = [S1, S2, S3];
        address[3] memory b = [B1, B2, B3];
        for (uint256 i; i < 3; ++i) {
            vm.prank(s[i]);
            shares.approve(address(rounds), type(uint256).max);
            usd.mint(b[i], 1e15);
            vm.prank(b[i]);
            usd.approve(address(rounds), type(uint256).max);
        }
    }

    function _close(uint256 id) internal {
        (,,, uint64 closesAt,,,,,,,,,,,,,,) = rounds.rounds(id);
        vm.warp(closesAt);
    }

    // ---- funding round: the bps check against a rounded-down step -------------------------------------------------

    /// Treasury 200.01 USDC over 200 units: floor 1_000_050, step 10_000 (rounded down from 10_000.5).
    /// The tranche is offered at step 2 (least price below it). One buyer wants less than the tranche: clears at step 2.
    function test_funding_round_at_lowest_step_cannot_settle_when_floor_not_multiple_of_100() public {
        usd.mint(address(dao), 200_010_000);
        terms.set(40e18, 1e6);
        uint256 id = rounds.openFunding(address(dao));
        assertEq(rounds.priceAt(id, 0), 1_000_050);
        assertEq(rounds.priceAt(id, 2), 1_020_050);
        (, uint16 lowest,) = rounds.sells(id, address(terms));
        assertEq(lowest, 2);
        vm.prank(B1);
        rounds.bid(id, 30e18, 5);
        _close(id);
        (uint256 step, uint256 volume,) = rounds.clearingStep(id);
        assertEq(step, 2);
        assertEq(volume, 30e18);
        // Floor unchanged since opening, yet:
        assertEq(rounds.floorOf(address(dao)), 1_000_050);
        vm.expectRevert(abi.encodeWithSelector(WeeklyRounds.BelowFloor.selector, 1_000_050));
        rounds.settle(id, step);
        // No other step is accepted.
        for (uint256 s; s < 1024; ++s) {
            if (s == step) continue;
            vm.expectRevert();
            rounds.settle(id, s);
        }
        vm.warp(block.timestamp + 2 days);
        assertTrue(rounds.isVoid(id));
    }

    /// Floor exactly 1.00 (divisible): one extra unit of currency per 1e18... a $0.0002 donation voids the round.
    function test_funding_round_at_lowest_step_voided_by_dust_donation() public {
        usd.mint(address(dao), 200e6);
        terms.set(40e18, 1e6);
        uint256 id = rounds.openFunding(address(dao));
        vm.prank(B1);
        rounds.bid(id, 30e18, 5);
        _close(id);
        (uint256 step,,) = rounds.clearingStep(id);
        assertEq(step, 2);
        uint256 snap = vm.snapshotState();
        rounds.settle(id, step); // works untouched
        vm.revertToState(snap);
        usd.mint(address(dao), 200); // 200 wei = $0.0002 raises the floor by 1 wei per unit
        vm.expectRevert();
        rounds.settle(id, step);
    }

    /// Full subscription with every bid at step 2 also clears at 2 (case 1), same failure.
    function test_funding_round_full_at_step_two_cannot_settle() public {
        usd.mint(address(dao), 200_010_000);
        terms.set(40e18, 0);
        uint256 id = rounds.openFunding(address(dao));
        vm.prank(B1);
        rounds.bid(id, 60e18, 2);
        _close(id);
        (uint256 step,,) = rounds.clearingStep(id);
        assertEq(step, 2);
        vm.expectRevert();
        rounds.settle(id, step);
    }

    // ---- "among equal volumes, favours sellers" ------------------------------------------------------------------

    function test_excess_supply_clears_at_the_marginal_ask_not_the_highest_equal_volume_step() public {
        usd.mint(address(dao), 200e6);
        uint256 id = rounds.open(address(dao));
        vm.prank(S1);
        rounds.sell(id, 100e18, 10);
        vm.prank(B1);
        rounds.bid(id, 60e18, 50);
        _close(id);
        (uint256 step, uint256 volume,) = rounds.clearingStep(id);
        assertEq(step, 10);
        assertEq(volume, 60e18);
        // Step 50 trades the same 60 units at a higher price.
        uint256 d = rounds.demandAt(id, 50);
        uint256 s = rounds.supplyAt(id, 50);
        assertEq(d < s ? d : s, 60e18);
        rounds.settle(id, 10);
        rounds.claim(id, S1);
        // seller gets 60 * 1.10 less 20% of 0.10 gain = 66 - 1.2 = 64.8
        assertEq(usd.balanceOf(S1), 64_800_000);
    }

    function test_tie_between_s_and_s_plus_one_picks_the_lower_price() public {
        usd.mint(address(dao), 200e6);
        uint256 id = rounds.open(address(dao));
        vm.prank(S1);
        rounds.sell(id, 50e18, 0);
        vm.prank(S2);
        rounds.sell(id, 50e18, 21);
        vm.prank(B1);
        rounds.bid(id, 50e18, 30);
        vm.prank(B2);
        rounds.bid(id, 10e18, 20);
        _close(id);
        // demand(20)=60 >= supply(20)=50; demand(21)=50 < supply(21)=100, and 50 == 50 -> tie
        (uint256 step, uint256 volume,) = rounds.clearingStep(id);
        assertEq(step, 20);
        assertEq(volume, 50e18);
        // step 21 trades 50 too, at a higher price; and so does every step up to 30
        for (uint256 x = 21; x <= 30; ++x) {
            uint256 d = rounds.demandAt(id, x);
            uint256 s = rounds.supplyAt(id, x);
            assertEq(d < s ? d : s, 50e18);
        }
    }

    // ---- empty treasury: floor 0 -----------------------------------------------------------------------------------

    function test_empty_treasury_excess_supply_at_step_zero_gives_units_away() public {
        uint256 id = rounds.open(address(dao));
        assertEq(rounds.priceAt(id, 0), 0);
        assertEq(rounds.priceAt(id, 1), 1e4);
        assertEq(rounds.priceAt(id, 1023), 10_230_000);
        vm.prank(S1);
        rounds.sell(id, 100e18, 0);
        vm.prank(B1);
        rounds.bid(id, 60e18, 500); // willing to pay $5.00
        _close(id);
        (uint256 step, uint256 volume,) = rounds.clearingStep(id);
        assertEq(step, 0);
        assertEq(volume, 60e18);
        rounds.settle(id, 0);
        uint256 before = usd.balanceOf(B1);
        rounds.claim(id, B1);
        assertEq(shares.balanceOf(B1), 60e18);
        assertEq(usd.balanceOf(B1) - before, 60 * 5_000_000, "full escrow back: paid nothing");
        rounds.claim(id, S1);
        assertEq(usd.balanceOf(S1), 0);
    }

    // ---- fuzz: across the full 0..1023 range ----------------------------------------------------------------------

    function testFuzz_unique_accepted_step_and_max_volume(
        uint16[3] memory ss,
        uint64[3] memory sa,
        uint16[3] memory bs,
        uint64[3] memory ba,
        uint16 probe
    ) public {
        usd.mint(address(dao), 200e6);
        uint256 id = rounds.open(address(dao));
        address[3] memory sl = [S1, S2, S3];
        address[3] memory by = [B1, B2, B3];
        uint256[3] memory held = [uint256(100e18), 50e18, 50e18];
        for (uint256 i; i < 3; ++i) {
            uint256 a = bound(sa[i], 0, held[i] / 1e12) * 1e12;
            uint256 st = bound(ss[i], 0, 1023);
            if (i == 0) st = st % 4 == 0 ? 0 : (st % 4 == 1 ? 1023 : st);
            if (a != 0) { vm.prank(sl[i]); rounds.sell(id, a, st); }
            uint256 w = bound(ba[i], 0, 100e6) * 1e12;
            uint256 bt = bound(bs[i], 0, 1023);
            if (i == 0) bt = bt % 4 == 0 ? 0 : (bt % 4 == 1 ? 1023 : bt);
            if (w != 0) { vm.prank(by[i]); rounds.bid(id, w, bt); }
        }
        (uint256 step, uint256 volume,) = rounds.clearingStep(id);
        _close(id);
        uint256 p = bound(probe, 0, 1023);
        if (p != step) {
            vm.expectRevert();
            rounds.settle(id, p);
        }
        // neighbours too
        if (step > 0) { vm.expectRevert(); rounds.settle(id, step - 1); }
        if (step < 1023) { vm.expectRevert(); rounds.settle(id, step + 1); }
        uint256 v = volume;
        uint256 dp = rounds.demandAt(id, p);
        uint256 sp = rounds.supplyAt(id, p);
        assertLe(dp < sp ? dp : sp, v);
        rounds.settle(id, step);
        uint256 bought;
        uint256 sold;
        for (uint256 i; i < 3; ++i) {
            (uint128 a,,) = rounds.sells(id, sl[i]);
            if (a != 0) { uint256 b0 = shares.balanceOf(sl[i]); rounds.claim(id, sl[i]); sold += a - (shares.balanceOf(sl[i]) - b0); }
            (uint128 w,,) = rounds.bids(id, by[i]);
            if (w != 0) { uint256 b0 = shares.balanceOf(by[i]); rounds.claim(id, by[i]); bought += shares.balanceOf(by[i]) - b0; }
        }
        assertEq(bought, volume);
        assertEq(sold, volume);
        assertEq(shares.balanceOf(address(rounds)), 0);
    }
}
