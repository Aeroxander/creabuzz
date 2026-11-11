// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BackingPool} from "../src/BackingPool.sol";
import {PoolQuote, TreasuryStub} from "./helpers/BackingPoolFixture.sol";

/// @dev Drives one pool with five backers and a founder through every action in random order, keeping its
/// own count of the money that went in and came out.
contract BackingPoolHandler is Test {
    BackingPool public immutable pool;
    PoolQuote public immutable quote;
    address public immutable founder;
    address[5] public actors;

    uint256 public paidIn;
    uint256 public paidOut;
    uint256 public escrowIn;
    uint256 public donated;

    constructor(BackingPool pool_, PoolQuote quote_, address founder_) {
        pool = pool_;
        quote = quote_;
        founder = founder_;
        for (uint256 i; i < 5; ++i) {
            actors[i] = address(uint160(0xAC700 + i));
            quote.mint(actors[i], 1e30);
            vm.prank(actors[i]);
            quote.approve(address(pool), type(uint256).max);
        }
    }

    function actorCount() external pure returns (uint256) {
        return 5;
    }

    function buy(uint256 who, uint256 amount) external {
        if (pool.abandoned()) return;
        address actor = actors[who % 5];
        amount = bound(amount, 1e6, 3_000_000e18);
        BackingPool.Snapshot memory s = pool.snapshot(actor);
        if (amount > s.holderEarlyLeft) amount = s.holderEarlyLeft;
        (uint256 units,, uint256 toEscrow,) = pool.quoteBuy(amount);
        if (units == 0) return;
        vm.prank(actor);
        pool.buy(amount, units, block.timestamp);
        paidIn += amount;
        escrowIn += toEscrow;
    }

    function sell(uint256 who, uint256 part) external {
        address actor = actors[who % 5];
        uint256 held = pool.balanceOf(actor);
        if (held == 0) return;
        uint256 units = bound(part, 1, held);
        (uint256 out,,,) = pool.quoteSell(actor, units);
        vm.prank(actor);
        assertEq(pool.sell(units, out, block.timestamp), out);
        paidOut += out;
    }

    function post(uint256 ref) external {
        if (pool.abandoned() || block.timestamp < pool.nextClaimAt()) return;
        (,,, BackingPool.MilestoneStatus status,,,) = pool.milestones(pool.milestoneCount());
        if (status == BackingPool.MilestoneStatus.Open) return;
        vm.prank(founder);
        pool.postMilestone(keccak256(abi.encode(ref)));
    }

    function object(uint256 who) external {
        address actor = actors[who % 5];
        if (!pool.snapshot(actor).holderCanObject) return;
        vm.prank(actor);
        pool.object();
    }

    function resolve() external {
        if (pool.abandoned()) return;
        (,, uint64 endsAt, BackingPool.MilestoneStatus status,,,) = pool.milestones(pool.milestoneCount());
        if (status != BackingPool.MilestoneStatus.Open || block.timestamp < endsAt) return;
        pool.resolveMilestone();
    }

    function voteAbandon(uint256 who) external {
        address actor = actors[who % 5];
        if (
            pool.abandoned() || pool.weightOf(actor) == 0 || pool.votedAbandon(actor)
                || block.timestamp < uint256(pool.lastBuyAt(actor)) + pool.voteSeasoning()
        ) return;
        vm.prank(actor);
        pool.voteAbandon();
    }

    function declare() external {
        if (pool.abandoned()) return;
        try pool.declareAbandoned() {} catch {}
    }

    function donate(uint256 amount) external {
        amount = bound(amount, 1, 1_000e18);
        quote.mint(address(pool), amount);
        donated += amount;
    }

    function wait(uint256 time) external {
        vm.warp(block.timestamp + bound(time, 1 hours, 40 days));
    }
}

/// @notice What must hold after any sequence of buys, sales, milestone posts, objections, releases, votes,
/// abandonment, stray transfers and waiting.
contract BackingPoolInvariantTest is Test {
    BackingPool internal pool;
    PoolQuote internal quote;
    BackingPoolHandler internal handler;
    address internal treasury;

    function setUp() public {
        vm.warp(1_800_000_000);
        quote = new PoolQuote();
        treasury = address(new TreasuryStub());
        BackingPool.Params memory p;
        p.virtualQuote = 25_000e18;
        p.virtualUnits = 1_000_000_000e18;
        p.projectBps = 3000;
        p.feeBps = 100;
        p.trancheBps = 2500;
        p.objectionBps = 2000;
        p.objectionWindow = 7 days;
        p.claimInterval = 28 days;
        p.abandonAfter = 180 days;
        p.voteSeasoning = 30 days;
        p.voteAfter = 90 days;
        p.earlyWindow = 1 days;
        p.earlyCap = 1_000e18;
        pool = new BackingPool(treasury, address(0xF0), IERC20(address(quote)), p);
        handler = new BackingPoolHandler(pool, quote, address(0xF0));
        targetContract(address(handler));
    }

    /// @dev Solvency: the pool holds exactly the reserve, the escrow, what it owes the treasury, and whatever
    /// strangers sent it. Nothing a backer or the project is owed is ever missing.
    function invariant_the_pool_holds_what_its_books_say() public view {
        assertEq(
            quote.balanceOf(address(pool)),
            pool.reserve() + pool.escrow() + pool.treasuryOwed() + handler.donated()
        );
    }

    /// @dev Every quote that came in is in the reserve, in the escrow, the project's (released, or a fee), or
    /// was paid out.
    function invariant_money_in_equals_money_held_released_and_paid_out() public view {
        assertEq(
            handler.paidIn(),
            pool.reserve() + pool.escrow() + pool.released() + pool.feesTaken() + handler.paidOut()
        );
    }

    /// @dev The project money alone: what entered the escrow is still there, was released, or was refunded.
    function invariant_escrow_released_and_refunded_add_up() public view {
        assertEq(handler.escrowIn(), pool.escrow() + pool.released() + pool.refunded());
        assertEq(quote.balanceOf(treasury) + pool.treasuryOwed(), pool.released() + pool.feesTaken());
    }

    function invariant_balances_add_up_to_the_supply_and_weights_to_the_total() public view {
        uint256 units;
        uint256 weight;
        uint256 votes;
        for (uint256 i; i < handler.actorCount(); ++i) {
            address actor = handler.actors(i);
            units += pool.balanceOf(actor);
            weight += pool.weightOf(actor);
            if (pool.votedAbandon(actor)) votes += pool.weightOf(actor);
            // No weight without units: a wallet that sold everything has no claim left.
            if (pool.balanceOf(actor) == 0) assertEq(pool.weightOf(actor), 0);
        }
        assertEq(units, pool.totalSupply());
        assertEq(weight, pool.totalWeight());
        assertEq(votes, pool.abandonVotes());
    }

    /// @dev The curve's product never falls below where it started, which is what keeps the reserve from
    /// ever going short.
    function invariant_the_curve_constant_never_falls() public view {
        uint256 k = (pool.virtualQuote() + pool.reserve()) * (pool.virtualUnits() - pool.totalSupply());
        assertGe(k, pool.virtualQuote() * pool.virtualUnits());
        assertLt(pool.totalSupply(), pool.virtualUnits());
    }

    /// @dev An open milestone's count is exactly the wallets that still have a say and those that objected.
    function invariant_the_objection_count_matches_the_wallets() public view {
        uint256 id = pool.milestoneCount();
        (,, uint64 endsAt, BackingPool.MilestoneStatus status, uint256 eligible, uint256 objections,) =
            pool.milestones(id);
        assertLe(objections, eligible);
        if (status != BackingPool.MilestoneStatus.Open || block.timestamp >= endsAt) return;
        uint256 sumEligible;
        uint256 sumObjecting;
        for (uint256 i; i < handler.actorCount(); ++i) {
            address actor = handler.actors(i);
            if (pool.boughtDuring(actor) == id) continue;
            sumEligible += pool.weightOf(actor);
            if (pool.objectedTo(actor) == id) sumObjecting += pool.weightOf(actor);
        }
        assertEq(eligible, sumEligible);
        assertEq(objections, sumObjecting);
    }

    /// @dev From any state, every holder can sell everything, in either order, and the pool still holds its
    /// books afterwards; once abandoned, that empties the escrow too.
    function invariant_everyone_can_always_sell_everything() public {
        uint256 state = vm.snapshotState();
        for (uint256 pass; pass < 2; ++pass) {
            uint256 n = handler.actorCount();
            for (uint256 i; i < n; ++i) {
                address actor = handler.actors(pass == 0 ? i : n - 1 - i);
                uint256 held = pool.balanceOf(actor);
                if (held == 0) continue;
                vm.prank(actor);
                pool.sell(held, 0, block.timestamp);
            }
            assertEq(pool.totalSupply(), 0);
            assertEq(pool.totalWeight(), 0);
            if (pool.abandoned()) assertEq(pool.escrow(), 0);
            assertGe(quote.balanceOf(address(pool)), pool.reserve() + pool.escrow() + pool.treasuryOwed());
            vm.revertToState(state);
        }
    }
}
