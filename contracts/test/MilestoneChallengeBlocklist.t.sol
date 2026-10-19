// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {VotingFixture} from "./helpers/VotingFixture.sol";
import {MilestoneChallenge} from "../src/MilestoneChallenge.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice A sale currency whose issuer can block an address, as USDC's can: a transfer to or from it reverts.
contract BlockingCurrency is ERC20 {
    mapping(address => bool) public blocked;

    constructor() ERC20("Blocking USD", "BUSD") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setBlocked(address who, bool on) external {
        blocked[who] = on;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!blocked[from] && !blocked[to], "blocked");
        super._update(from, to, value);
    }
}

/// @notice Settling a milestone vote must not depend on whether the currency's issuer lets the objector (or the DAO) be
/// paid. Before this test, an upheld objection whose objector was blocked afterwards could never be settled: `resolve`
/// reverted on the payment, the objection stayed open for good, and so (D58) no later milestone could ever be published,
/// the bond and the deposit stayed in the lock, and an upheld late objection never burned what it should have.
contract MilestoneChallengeBlocklistTest is VotingFixture {
    address internal constant DAVE = address(0xDA7E);
    uint128 internal constant BOND = 100e18;
    uint128 internal constant DEPOSIT = 10e18;

    MilestoneChallenge internal lock;
    BlockingCurrency internal cash;

    function setUp() public override {
        super.setUp();
        cash = new BlockingCurrency();
        vm.startPrank(address(dao));
        shares.mintFromMoloch(BOB, 60e18);
        shares.mintFromMoloch(CAROL, 30e18);
        vm.stopPrank();
        address[] memory team = new address[](1);
        team[0] = ALICE;
        uint256[] memory totals = new uint256[](1);
        totals[0] = 100e18;
        bytes32[] memory checks = new bytes32[](2);
        (checks[0], checks[1]) = (keccak256("one"), keccak256("two"));
        uint16[] memory bps = new uint16[](2);
        (bps[0], bps[1]) = (4000, 4000);
        lock = new MilestoneChallenge(
            address(dao),
            team,
            totals,
            checks,
            bps,
            MilestoneChallenge.Terms(7 days, 5 days, 30 days, 300, uint64(block.number), address(cash), BOND, DEPOSIT)
        );
        vm.prank(address(dao));
        shares.setLockGuard(address(lock));
        for (uint256 i; i < 3; ++i) {
            address who = i == 0 ? ALICE : i == 1 ? BOB : CAROL;
            cash.mint(who, 1_000e18);
            vm.prank(who);
            cash.approve(address(lock), type(uint256).max);
        }
        vm.roll(block.number + 1);
    }

    function _pass(uint256 s) internal {
        vm.warp(block.timestamp + s);
        vm.roll(block.number + 1);
    }

    function _toVoteEnd() internal {
        (,,,, uint64 voteEnds,,,,) = lock.objection(0);
        vm.warp(voteEnds);
        vm.roll(block.number + 1);
    }

    function _toWindowEnd() internal {
        (,,,,, uint64 windowEnds,,) = lock.milestone(0);
        vm.warp(windowEnds);
        vm.roll(block.number + 1);
    }

    function test_an_upheld_objection_settles_even_if_the_objector_is_blocked_by_then() public {
        vm.prank(ALICE);
        lock.submit(0, keccak256("evidence"));
        _pass(1 hours);
        vm.prank(BOB);
        lock.object(0);
        vm.prank(CAROL);
        lock.vote(0, true);
        _toVoteEnd();
        cash.setBlocked(BOB, true); // the issuer blocks the objector before anyone settles the vote

        uint256 daoBefore = cash.balanceOf(address(dao));
        lock.resolve(0); // must not revert
        (bool open,,,,,,,,) = lock.objection(0);
        assertFalse(open, "the objection is settled");
        (MilestoneChallenge.Phase phase,,,,,,, uint128 bond) = lock.milestone(0);
        assertEq(uint8(phase), uint8(MilestoneChallenge.Phase.None), "upheld: the milestone goes back");
        assertEq(bond, 0);
        // The DAO is paid as usual; the objector's bounty waits for them instead of being lost or redirected.
        assertEq(cash.balanceOf(address(dao)) - daoBefore, BOND / 2);
        assertEq(lock.owed(BOB), DEPOSIT + BOND / 2);
        assertEq(cash.balanceOf(address(lock)), DEPOSIT + BOND / 2, "the lock holds exactly what it owes");

        // While blocked they cannot take it, and nobody can take it for them or send it elsewhere.
        vm.prank(BOB);
        vm.expectRevert();
        lock.withdrawOwed();
        vm.prank(CAROL);
        lock.withdrawOwed();
        assertEq(lock.owed(BOB), DEPOSIT + BOND / 2);

        // Once unblocked, it is theirs.
        cash.setBlocked(BOB, false);
        uint256 before = cash.balanceOf(BOB);
        vm.prank(BOB);
        lock.withdrawOwed();
        assertEq(cash.balanceOf(BOB) - before, DEPOSIT + BOND / 2);
        assertEq(lock.owed(BOB), 0);
        assertEq(cash.balanceOf(address(lock)), 0);
    }

    function test_an_upheld_late_objection_still_burns_and_lets_the_schedule_go_on_with_a_blocked_objector() public {
        vm.prank(ALICE);
        lock.submit(0, keccak256("evidence"));
        _toWindowEnd();
        lock.finish(0);
        _pass(1 days);
        vm.prank(BOB);
        lock.object(0); // late, inside the month
        _toVoteEnd();
        cash.setBlocked(BOB, true);

        uint256 supplyBefore = shares.totalSupply();
        uint256 locked = lock.lockedOf(ALICE);
        lock.resolve(0);
        assertEq(supplyBefore - shares.totalSupply(), locked, "what was still locked is burned");
        assertEq(lock.lockedOf(ALICE), 0);
        (bool open,,,,,,,,) = lock.objection(0);
        assertFalse(open);
        assertEq(lock.owed(BOB), DEPOSIT + BOND / 2);
    }
}
