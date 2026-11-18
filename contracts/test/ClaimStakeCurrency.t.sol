// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {ClaimStake} from "../src/ClaimStake.sol";
import {VerifierSet} from "../src/VerifierSet.sol";
import {BlockingCurrency} from "./MilestoneChallengeBlocklist.t.sol";

/// @notice A currency whose `transfer`, `transferFrom` and `approve` return nothing, as USDT's do on Ethereum.
contract NoReturnCurrency {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external {
        allowance[msg.sender][spender] = amount;
    }

    function transfer(address to, uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
    }

    function transferFrom(address from, address to, uint256 amount) external {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

/// @notice The claim escrow must work with the currencies a raise can really use, and must never let one contributor's
/// trouble with the currency strand the budget's money.
///  - ES-2: when a claim lapses or a frozen claim is unwound, the reserve goes back to the budget and the stake back to the
///    contributor in one call. If the currency's issuer has blocked the contributor, that call reverted, and the reserve
///    could never go back. Now the stake waits in `owed` and the reserve still returns.
///  - ES-4: the escrow decoded a `bool` from every transfer, so a currency that returns nothing (USDT on Ethereum) made
///    every stake, reserve and payout revert. Now it uses SafeERC20, like every other contract here.
contract ClaimStakeCurrencyTest is Test {
    address internal constant CONTRIBUTOR = address(0xC0DE);
    address internal constant REVIEWER = address(0x4E01);
    bytes32 internal constant CLAIM = keccak256("claim");
    bytes32 internal constant EVIDENCE = keccak256("evidence");

    VerifierSet internal panel;

    function _escrow(address currency) internal returns (ClaimStake stake) {
        panel = new VerifierSet(address(this), 1);
        stake = new ClaimStake(panel, address(this), currency);
        panel.setClaimStake(address(stake));
        panel.acceptVerifier(REVIEWER);
        stake.setWindows(30 days, 7 days);
    }

    function _blockingSetup() internal returns (ClaimStake stake, BlockingCurrency cash) {
        cash = new BlockingCurrency();
        stake = _escrow(address(cash));
        cash.mint(CONTRIBUTOR, 100e18);
        cash.mint(address(this), 1_000e18);
        vm.prank(CONTRIBUTOR);
        cash.approve(address(stake), type(uint256).max);
        cash.approve(address(stake), type(uint256).max);
        vm.prank(CONTRIBUTOR);
        stake.submitClaim(CLAIM, 500e18, 50e18, EVIDENCE);
        stake.fund(CLAIM, 500e18);
    }

    function test_a_lapsed_claim_returns_its_reserve_even_if_the_contributor_is_blocked() public {
        (ClaimStake stake, BlockingCurrency cash) = _blockingSetup();
        vm.warp(block.timestamp + 31 days);
        cash.setBlocked(CONTRIBUTOR, true);
        uint256 before = cash.balanceOf(address(this));

        stake.expire(CLAIM); // must not revert

        assertEq(cash.balanceOf(address(this)) - before, 500e18, "the reserve went back to the budget");
        assertEq(stake.owed(CONTRIBUTOR), 50e18, "the stake waits for its owner");
        assertEq(cash.balanceOf(address(stake)), 50e18, "the escrow holds exactly what it owes");

        // Only the contributor can take it, only to themselves, and only once the currency lets them.
        vm.prank(CONTRIBUTOR);
        vm.expectRevert();
        stake.withdrawOwed();
        cash.setBlocked(CONTRIBUTOR, false);
        vm.prank(CONTRIBUTOR);
        stake.withdrawOwed();
        assertEq(cash.balanceOf(CONTRIBUTOR), 100e18);
        assertEq(stake.owed(CONTRIBUTOR), 0);
        assertEq(cash.balanceOf(address(stake)), 0);
    }

    function test_an_unwound_claim_returns_its_reserve_even_if_the_contributor_is_blocked() public {
        (ClaimStake stake, BlockingCurrency cash) = _blockingSetup();
        stake.freeze(CLAIM);
        cash.setBlocked(CONTRIBUTOR, true);
        uint256 before = cash.balanceOf(address(this));

        stake.resolveFrozen(CLAIM); // must not revert

        assertEq(cash.balanceOf(address(this)) - before, 500e18, "the reserve went back to the budget");
        assertEq(stake.owed(CONTRIBUTOR), 50e18);
        (,,, ClaimStake.Status status,,,,) = stake.claims(CLAIM);
        assertEq(uint8(status), uint8(ClaimStake.Status.Recovered));
    }

    function test_a_currency_that_returns_nothing_works_end_to_end() public {
        NoReturnCurrency usdt = new NoReturnCurrency();
        ClaimStake stake = _escrow(address(usdt));
        usdt.mint(CONTRIBUTOR, 100e6);
        usdt.mint(address(this), 1_000e6);
        vm.prank(CONTRIBUTOR);
        usdt.approve(address(stake), type(uint256).max);
        usdt.approve(address(stake), type(uint256).max);

        vm.prank(CONTRIBUTOR);
        stake.submitClaim(CLAIM, 500e6, 50e6, EVIDENCE);
        stake.fund(CLAIM, 500e6);
        vm.prank(REVIEWER);
        panel.attest(CLAIM, true);
        stake.settle(CLAIM);
        vm.warp(block.timestamp + 7 days);
        vm.prank(CONTRIBUTOR);
        stake.payout(CLAIM);

        assertEq(usdt.balanceOf(CONTRIBUTOR), 100e6 + 500e6, "paid the claim and the stake back");
        assertEq(usdt.balanceOf(address(stake)), 0);
    }
}
