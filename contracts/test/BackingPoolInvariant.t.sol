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
    /// @dev What leavers took from the escrow during the milestone that is open now.
    uint256 public leftThisMilestone;
    /// @dev How often each path was really taken, so a green run is known to have exercised them.
    uint256 public leaves;
    uint256 public releases;
    uint256 public voids;
    uint256 public abandonments;

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
        uint256 mine = pool.escrowOf(actor);
        bool couldLeave = s.holderCanLeave;
        vm.prank(actor);
        pool.buy(amount, units, block.timestamp);
        paidIn += amount;
        escrowIn += toEscrow;
        // A buy is worth what it adds, to the buyer and to nobody else, whatever milestone is open.
        if (!couldLeave) {
            assertLe(pool.escrowOf(actor), mine + toEscrow);
            // (to within what one unit of weight is worth, which is all a buy can lose to rounding)
            assertGe(pool.escrowOf(actor) + 2 + pool.escrow() / 1e12, mine + toEscrow);
        }
    }

    function sell(uint256 who, uint256 part) external {
        address actor = actors[who % 5];
        uint256 held = pool.balanceOf(actor);
        if (held == 0) return;
        uint256 units = bound(part, 1, held);
        bool wasAbandoned = pool.abandoned();
        (uint256 out, uint256 fee, uint256 refund,) = pool.quoteSell(actor, units);
        // Once the clock has run out a sale is a refund with no fee, declared or not.
        if (wasAbandoned) assertEq(fee, 0);
        else assertEq(refund, 0);
        vm.prank(actor);
        assertEq(pool.sell(units, out, block.timestamp), out);
        paidOut += out;
        if (wasAbandoned && abandonments == 0) abandonments = 1;
    }

    function leave(uint256 who) external {
        address actor = actors[who % 5];
        if (!pool.canLeave(actor)) return;
        uint256 mine = pool.escrowOf(actor);
        (uint256 out, uint256 fromCurve, uint256 fromEscrow,, uint256 fee) = pool.quoteLeave(actor);
        assertEq(fromEscrow, mine);
        uint256 fees = pool.feesTaken();
        vm.prank(actor);
        assertEq(pool.leave(out, block.timestamp), out);
        assertEq(out, fromCurve + fromEscrow);
        assertEq(pool.feesTaken(), fees + fee);
        assertEq(pool.balanceOf(actor), 0);
        paidOut += out;
        leftThisMilestone += fromEscrow;
        ++leaves;
    }

    function post(uint256 ref) external {
        if (pool.abandoned() || block.timestamp < pool.nextClaimAt()) return;
        if (_status() == BackingPool.MilestoneStatus.Open) return;
        vm.prank(founder);
        pool.postMilestone(keccak256(abi.encode(ref)));
        leftThisMilestone = 0;
    }

    function resolve() external {
        uint256 id = pool.milestoneCount();
        (,, uint64 endsAt, uint64 resolveBy, BackingPool.MilestoneStatus status, uint256 escrowAtPost,,) =
            pool.milestones(id);
        if (status != BackingPool.MilestoneStatus.Open || block.timestamp < endsAt) return;
        uint256 pending = pool.pending();
        (bool wasReleased, uint256 amount) = pool.resolveMilestone();
        if (wasReleased) {
            assertLt(block.timestamp, resolveBy);
            assertEq(amount, pending);
            // Never more than the tranche of what was held at the post, less what leavers took of it.
            assertLe(amount, escrowAtPost * pool.trancheBps() / 10_000);
            ++releases;
        } else {
            assertEq(amount, 0);
            ++voids;
        }
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
        try pool.declareAbandoned() {
            abandonments = 1;
        } catch {}
    }

    function donate(uint256 amount) external {
        amount = bound(amount, 1, 1_000e18);
        quote.mint(address(pool), amount);
        donated += amount;
    }

    function wait(uint256 time) external {
        vm.warp(block.timestamp + bound(time, 1 hours, 5 days));
    }

    function waitLong(uint256 time) external {
        vm.warp(block.timestamp + bound(time, 10 days, 40 days));
    }

    /// @dev Go to the next moment a milestone can be posted and post it, then let one backer who can leave
    /// do so: the leave path is taken in most runs and not only when the random waits line up.
    function postAndLeave(uint256 ref, uint256 who) external {
        if (_status() != BackingPool.MilestoneStatus.Open) {
            if (pool.abandoned()) return;
            uint256 state = vm.snapshotState();
            if (block.timestamp < pool.nextClaimAt()) vm.warp(pool.nextClaimAt());
            if (pool.abandoned()) {
                vm.revertToState(state);
                return;
            }
            vm.deleteStateSnapshot(state);
            vm.prank(founder);
            pool.postMilestone(keccak256(abi.encode(ref)));
            leftThisMilestone = 0;
        }
        this.leave(who);
    }

    /// @dev Bring the open milestone to the end of its window and resolve it in time, so releases happen
    /// in most runs and not only when the random waits line up.
    function resolveInTime() external {
        (,, uint64 endsAt, uint64 resolveBy, BackingPool.MilestoneStatus status,,,) =
            pool.milestones(pool.milestoneCount());
        if (status != BackingPool.MilestoneStatus.Open || block.timestamp >= resolveBy) return;
        if (block.timestamp < endsAt) vm.warp(endsAt);
        this.resolve();
    }

    function _status() private view returns (BackingPool.MilestoneStatus status) {
        (,,,, status,,,) = pool.milestones(pool.milestoneCount());
    }
}

/// @notice What must hold after any sequence of buys, sales, leaving, milestone posts, releases, voids, votes,
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
        p.projectBps = 1000;
        p.feeBps = 100;
        p.trancheBps = 2500;
        p.objectionWindow = 7 days;
        p.resolveWindow = 7 days;
        p.claimInterval = 28 days;
        p.abandonAfter = 180 days;
        p.voteSeasoning = 30 days;
        p.voteAfter = 90 days;
        p.earlyWindow = 1 days;
        p.earlyCap = 1_000e18;
        pool = new BackingPool(treasury, address(0xF0), IERC20(address(quote)), p, 0);
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

    /// @dev The project money alone: what entered the escrow is still there, was released, or was handed
    /// back (to leavers, or after abandonment).
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

    /// @dev The open tranche is always covered by the escrow, never more than a tranche of what was held at
    /// the post, and carried by weight that includes every wallet that can still leave. With no milestone
    /// open there is no tranche.
    function invariant_the_open_tranche_is_covered_and_bounded() public view {
        uint256 id = pool.milestoneCount();
        (,,,, BackingPool.MilestoneStatus status, uint256 escrowAtPost, uint256 leftWith,) = pool.milestones(id);
        if (status != BackingPool.MilestoneStatus.Open) {
            assertEq(pool.pending(), 0);
            assertEq(pool.staked(), 0);
            return;
        }
        assertLe(pool.pending(), pool.escrow());
        assertLe(pool.pending(), escrowAtPost * pool.trancheBps() / 10_000);
        assertEq(leftWith, handler.leftThisMilestone());
        uint256 canStillLeave;
        for (uint256 i; i < handler.actorCount(); ++i) {
            address actor = handler.actors(i);
            if (pool.canLeave(actor)) canStillLeave += pool.weightOf(actor);
        }
        assertLe(canStillLeave, pool.staked());
    }

    /// @dev What the backers are owed in project money never adds up to more than the escrow, in any state:
    /// milestone open or not, abandoned or not.
    function invariant_the_backers_parts_never_exceed_the_escrow() public view {
        uint256 owed;
        for (uint256 i; i < handler.actorCount(); ++i) {
            owed += pool.escrowOf(handler.actors(i));
        }
        assertLe(owed, pool.escrow());
    }

    /// @dev From any state, every wallet that can leave does, and then every holder sells everything, in
    /// either order, and the pool still holds its books; once abandoned, that empties the escrow too.
    function invariant_everyone_can_always_get_out() public {
        uint256 state = vm.snapshotState();
        for (uint256 pass; pass < 2; ++pass) {
            uint256 n = handler.actorCount();
            for (uint256 i; i < n; ++i) {
                address actor = handler.actors(pass == 0 ? i : n - 1 - i);
                uint256 held = pool.balanceOf(actor);
                if (held == 0) continue;
                bool leaves = pool.canLeave(actor);
                vm.prank(actor);
                if (leaves) pool.leave(0, block.timestamp);
                else pool.sell(held, 0, block.timestamp);
            }
            assertEq(pool.totalSupply(), 0);
            assertEq(pool.totalWeight(), 0);
            if (pool.abandoned()) assertEq(pool.escrow(), 0);
            assertGe(quote.balanceOf(address(pool)), pool.reserve() + pool.escrow() + pool.treasuryOwed());
            vm.revertToState(state);
        }
    }

    /// @dev Not a property of the pool: a check that the run above really took the paths it claims to cover.
    /// Kept loose (a single short run may miss one), and printed by `forge test -vv`.
    function invariant_the_handler_reaches_the_leave_path() public {
        emit log_named_uint("leaves", handler.leaves());
        emit log_named_uint("releases", handler.releases());
        emit log_named_uint("voids", handler.voids());
        emit log_named_uint("abandonments", handler.abandonments());
    }
}
