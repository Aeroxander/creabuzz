// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {VotingFixture} from "./helpers/VotingFixture.sol";
import {WeeklyRounds} from "../src/WeeklyRounds.sol";
import {MandateCurrency} from "./TreasuryMandate.t.sol";

/// @notice Says how many of each holder's Shares are locked, and how many in all, like the milestone lock does.
contract CountingLockGuard {
    mapping(address => uint256) public lockedOf;
    uint256 public totalLocked;

    function set(address holder, uint256 amount) external {
        totalLocked = totalLocked - lockedOf[holder] + amount;
        lockedOf[holder] = amount;
    }
}

/// @notice Weekly rounds on a real summoned DAO with its Shares locked: a sale through a round keeps the treasury's
/// money, the price follows one stated rule, partial fills add up exactly, a round nobody settles gives everything back,
/// and leaving is always open, from escrow too.
contract WeeklyRoundsTest is VotingFixture {
    address internal constant ANA = address(0xA4A);
    address internal constant CY = address(0xC4C);
    address internal constant FAY = address(0xFA1);
    address internal constant BEN = address(0xBE4);
    address internal constant DEE = address(0xDEE);
    address internal constant EVE = address(0xE7E);
    uint256 internal constant USD = 1e6;

    MandateCurrency internal usd;
    WeeklyRounds internal rounds;
    CountingLockGuard internal guard;

    function setUp() public override {
        super.setUp();
        // Alice keeps 10 of her 100 Shares; Bob holds 100 Loot. 200 units can leave, so 200 USDC makes a floor of 1.00.
        vm.startPrank(ALICE);
        shares.transfer(ANA, 50e18);
        shares.transfer(CY, 30e18);
        shares.transfer(FAY, 10e18);
        vm.stopPrank();
        usd = new MandateCurrency();
        usd.mint(address(dao), 200 * USD);
        rounds = new WeeklyRounds(IERC20(address(usd)), 1e4);
        guard = new CountingLockGuard();
        vm.startPrank(address(dao));
        shares.lockTransfersWithNotice(address(0));
        shares.setLockGuard(address(guard));
        shares.announceExitExchange(address(rounds));
        vm.stopPrank();
        vm.warp(block.timestamp + 30 days);
        shares.activateExitExchange();
        address[3] memory sellers = [ANA, CY, FAY];
        for (uint256 i; i < sellers.length; ++i) {
            vm.prank(sellers[i]);
            shares.approve(address(rounds), type(uint256).max);
        }
        address[3] memory buyers = [BEN, DEE, EVE];
        for (uint256 i; i < buyers.length; ++i) {
            usd.mint(buyers[i], 1_000 * USD);
            vm.prank(buyers[i]);
            usd.approve(address(rounds), type(uint256).max);
        }
    }

    // ---- helpers -------------------------------------------------------------------------------------------------

    function _sell(uint256 id, address who, uint256 amount, uint256 step) internal {
        vm.prank(who);
        rounds.sell(id, amount, step);
    }

    function _bid(uint256 id, address who, uint256 amount, uint256 step) internal {
        vm.prank(who);
        rounds.bid(id, amount, step);
    }

    function _close(uint256 id) internal {
        (,,, uint64 closesAt,,,,,,,,,,,) = rounds.rounds(id);
        vm.warp(closesAt);
    }

    function _settle(uint256 id) internal returns (uint256 step) {
        _close(id);
        (step,,) = rounds.clearingStep(id);
        rounds.settle(id, step);
    }

    function _usd() internal pure returns (address[] memory tokens) {
        tokens = new address[](1);
        tokens[0] = address(0);
    }

    function _leaveWithUsd() internal view returns (address[] memory tokens) {
        tokens = new address[](1);
        tokens[0] = address(usd);
    }

    // ---- a sale ----------------------------------------------------------------------------------------------------

    function test_a_sale_through_a_round_pays_the_seller_more_and_keeps_the_treasury() public {
        uint256 id = rounds.open(address(dao));
        assertEq(rounds.priceAt(id, 0), 1 * USD, "the floor is what leaving pays");
        assertEq(rounds.priceAt(id, 30), 130 * USD / 100, "steps of 1%");
        _sell(id, ANA, 50e18, 0);
        _bid(id, BEN, 30e18, 30);
        _bid(id, DEE, 30e18, 30);
        (uint256 step, uint256 volume, bool sellersShare) = rounds.clearingStep(id);
        assertEq(step, 30);
        assertEq(volume, 50e18);
        assertFalse(sellersShare, "the buyers at the price share");
        _settle(id);
        rounds.claim(id, ANA);
        rounds.claim(id, BEN);
        rounds.claim(id, DEE);
        // 50 at 1.30 is 65; a fifth of the 15 gained above the floor goes to the treasury.
        assertEq(usd.balanceOf(ANA), 62 * USD, "12 more than leaving would pay");
        assertEq(usd.balanceOf(address(dao)), 203 * USD, "the treasury raised 3 and paid nobody out");
        assertEq(shares.balanceOf(BEN), 25e18);
        assertEq(shares.balanceOf(DEE), 25e18);
        assertEq(usd.balanceOf(BEN), 1_000 * USD - 325 * USD / 10, "pays 32.50 for 25, the rest of 39 comes back");
        assertEq(rounds.floorOf(address(dao)), 1_015_000, "the units are unchanged, so the floor rose");
        assertEq(shares.balanceOf(address(rounds)), 0);
        assertEq(usd.balanceOf(address(rounds)), 0);
    }

    function test_the_price_is_the_highest_at_which_bids_take_everything_offered() public {
        uint256 id = rounds.open(address(dao));
        _sell(id, ANA, 50e18, 0);
        _bid(id, BEN, 50e18, 100);
        _close(id);
        // Every step from the floor to 2.00 suits both; the rule picks 2.00 and nothing else.
        vm.expectRevert(abi.encodeWithSelector(WeeklyRounds.WrongPrice.selector, 50));
        rounds.settle(id, 50);
        vm.expectRevert(abi.encodeWithSelector(WeeklyRounds.WrongPrice.selector, 0));
        rounds.settle(id, 0);
        vm.expectRevert(abi.encodeWithSelector(WeeklyRounds.WrongPrice.selector, 101));
        rounds.settle(id, 101);
        rounds.settle(id, 100);
        vm.expectRevert(abi.encodeWithSelector(WeeklyRounds.AlreadySettled.selector, id));
        rounds.settle(id, 100);
        rounds.claim(id, ANA);
        rounds.claim(id, BEN);
        assertEq(usd.balanceOf(ANA), 90 * USD, "100, less a fifth of the 50 gained");
        assertEq(usd.balanceOf(BEN), 900 * USD, "no more than the buyer's highest price");
        assertEq(shares.balanceOf(BEN), 50e18);
    }

    function test_sellers_at_the_price_share_when_buyers_want_less() public {
        uint256 id = rounds.open(address(dao));
        _sell(id, ANA, 50e18, 10);
        _sell(id, CY, 30e18, 10);
        _bid(id, BEN, 40e18, 20);
        // Nothing trades below step 10; at step 10 the buyer takes 40 of the 80 offered.
        assertEq(_settle(id), 10);
        rounds.claim(id, ANA);
        rounds.claim(id, CY);
        rounds.claim(id, BEN);
        assertEq(shares.balanceOf(BEN), 40e18);
        assertEq(shares.balanceOf(ANA), 25e18, "half of hers came back");
        assertEq(shares.balanceOf(CY), 15e18);
        assertEq(usd.balanceOf(ANA), 27 * USD, "25 at 1.10, less 0.50");
        assertEq(usd.balanceOf(CY), 162 * USD / 10);
        assertEq(usd.balanceOf(BEN), 1_000 * USD - 44 * USD, "pays 1.10, not the 1.20 bid");
        assertEq(usd.balanceOf(address(dao)), 200 * USD + 8 * USD / 10);
        assertEq(shares.balanceOf(address(rounds)), 0);
    }

    function test_shares_at_the_price_add_up_exactly_whoever_claims_first() public {
        uint256 id = rounds.open(address(dao));
        _sell(id, ANA, 10, 0);
        _bid(id, BEN, 4, 5);
        _bid(id, DEE, 4, 5);
        _bid(id, EVE, 4, 5);
        assertEq(_settle(id), 5);
        rounds.claim(id, DEE);
        rounds.claim(id, EVE);
        rounds.claim(id, BEN);
        assertEq(shares.balanceOf(DEE) + shares.balanceOf(EVE) + shares.balanceOf(BEN), 10, "exactly what was sold");
        assertLe(shares.balanceOf(EVE), 4);
        rounds.claim(id, ANA);
        assertEq(shares.balanceOf(address(rounds)), 0);
    }

    // ---- thin demand, no settlement, leaving -----------------------------------------------------------------------

    function test_with_no_buyers_everything_comes_back_and_a_seller_can_leave_from_escrow() public {
        uint256 id = rounds.open(address(dao));
        _sell(id, ANA, 50e18, 0);
        (uint256 step, uint256 volume,) = rounds.clearingStep(id);
        assertEq(volume, 0);
        _close(id);
        rounds.settle(id, step);
        vm.prank(ANA);
        rounds.claimAndLeave(id, _leaveWithUsd());
        assertEq(usd.balanceOf(ANA), 50 * USD, "what leaving pays: 50 of 200 units");
        assertEq(usd.balanceOf(address(dao)), 150 * USD);
        assertEq(shares.balanceOf(address(rounds)), 0);
    }

    function test_a_round_nobody_settles_is_void_and_everyone_takes_back_exactly_theirs() public {
        uint256 id = rounds.open(address(dao));
        _sell(id, ANA, 50e18, 0);
        _bid(id, BEN, 50e18, 10);
        _close(id);
        (,,, uint64 closesAt,,,,,,,,,,,) = rounds.rounds(id);
        vm.expectRevert(abi.encodeWithSelector(WeeklyRounds.NotYet.selector, closesAt + rounds.SETTLE_WINDOW()));
        rounds.claim(id, ANA);
        vm.warp(closesAt + rounds.SETTLE_WINDOW());
        assertTrue(rounds.isVoid(id));
        vm.expectRevert(abi.encodeWithSelector(WeeklyRounds.SettleOver.selector, id));
        rounds.settle(id, 10);
        rounds.claim(id, ANA);
        rounds.claim(id, BEN);
        assertEq(shares.balanceOf(ANA), 50e18);
        assertEq(usd.balanceOf(BEN), 1_000 * USD);
        vm.expectRevert(WeeklyRounds.NothingToClaim.selector);
        rounds.claim(id, BEN);
    }

    function test_while_bidding_a_seller_can_take_back_or_leave_and_a_buyer_take_back() public {
        uint256 id = rounds.open(address(dao));
        _sell(id, ANA, 50e18, 0);
        _sell(id, CY, 30e18, 0);
        _bid(id, BEN, 20e18, 10);
        vm.prank(ANA);
        rounds.cancelSell(id, _leaveWithUsd());
        assertEq(usd.balanceOf(ANA), 50 * USD, "left at once, as leaving pays");
        assertEq(rounds.supplyAt(id, 0), 30e18);
        vm.prank(BEN);
        rounds.cancelBid(id);
        assertEq(usd.balanceOf(BEN), 1_000 * USD);
        assertEq(rounds.demandAt(id, 0), 0);
        _close(id);
        vm.prank(CY);
        vm.expectRevert(abi.encodeWithSelector(WeeklyRounds.BiddingOver.selector, id));
        rounds.cancelSell(id, _usd());
    }

    function test_leaving_from_escrow_works_even_if_the_dao_stops_naming_the_round() public {
        uint256 id = rounds.open(address(dao));
        _sell(id, ANA, 50e18, 0);
        _bid(id, BEN, 50e18, 10);
        vm.prank(address(dao));
        shares.clearExitExchange();
        assertEq(_settle(id), 10);
        // Shares can no longer move to the buyer, but leaving needs no transfer.
        vm.expectRevert();
        rounds.claim(id, BEN);
        vm.prank(BEN);
        rounds.claimAndLeave(id, _leaveWithUsd());
        // Ben paid 55 and leaves with 50 of the 200 units: a quarter of the 200 treasury.
        assertEq(usd.balanceOf(BEN), 1_000 * USD - 55 * USD + 50 * USD);
        rounds.claim(id, ANA);
        assertEq(usd.balanceOf(ANA), 54 * USD, "55, less a fifth of the 5 gained");
        assertEq(usd.balanceOf(address(dao)), 151 * USD);
        assertEq(shares.balanceOf(address(rounds)), 0);
        assertEq(usd.balanceOf(address(rounds)), 0);
    }

    // ---- the treasury moving, many sellers ---------------------------------------------------------------------------

    function test_the_floor_is_read_at_opening_and_a_seller_can_still_leave_if_the_treasury_grows() public {
        uint256 id = rounds.open(address(dao));
        _sell(id, ANA, 50e18, 0);
        usd.mint(address(dao), 200 * USD); // revenue lands while bidding is open
        assertEq(rounds.priceAt(id, 0), 1 * USD, "the round's floor stays what it was at opening");
        assertEq(rounds.floorOf(address(dao)), 2 * USD);
        vm.prank(ANA);
        rounds.cancelSell(id, _leaveWithUsd());
        assertEq(usd.balanceOf(ANA), 100 * USD, "she leaves at the new value instead of selling at the old floor");
    }

    function test_when_everyone_wants_out_the_buyers_take_what_they_bid_for_and_the_rest_can_leave() public {
        uint256 id = rounds.open(address(dao));
        _sell(id, ANA, 50e18, 0);
        _sell(id, CY, 30e18, 0);
        _sell(id, FAY, 10e18, 0);
        _bid(id, BEN, 18e18, 0);
        assertEq(_settle(id), 0);
        vm.prank(ANA);
        rounds.claimAndLeave(id, _leaveWithUsd());
        vm.prank(CY);
        rounds.claimAndLeave(id, _leaveWithUsd());
        vm.prank(FAY);
        rounds.claimAndLeave(id, _leaveWithUsd());
        rounds.claim(id, BEN);
        assertEq(shares.balanceOf(BEN), 18e18, "18 of the 90 offered found a buyer at the floor");
        // 72 units left at the floor: the treasury kept the 18 the buyer took over.
        assertEq(usd.balanceOf(address(dao)), 200 * USD - 72 * USD);
        assertEq(usd.balanceOf(ANA) + usd.balanceOf(CY) + usd.balanceOf(FAY), 90 * USD, "everyone got the floor");
        assertEq(shares.balanceOf(address(rounds)), 0);
    }

    // ---- the DAO, locks, opening -----------------------------------------------------------------------------------

    function test_the_dao_sells_shares_it_holds_two_steps_up_and_keeps_all_the_money() public {
        vm.startPrank(address(dao));
        shares.mintFromMoloch(address(dao), 40e18);
        shares.approve(address(rounds), 40e18);
        vm.stopPrank();
        uint256 id = rounds.open(address(dao));
        assertEq(rounds.priceAt(id, 0), 1 * USD, "the DAO's own Shares are not counted for leaving");
        vm.prank(address(dao));
        vm.expectRevert(abi.encodeWithSelector(WeeklyRounds.BadStep.selector, 1));
        rounds.sell(id, 40e18, 1);
        vm.prank(address(dao));
        rounds.sell(id, 40e18, 2);
        _bid(id, BEN, 40e18, 5);
        assertEq(_settle(id), 5);
        rounds.claim(id, address(dao));
        rounds.claim(id, BEN);
        assertEq(usd.balanceOf(address(dao)), 242 * USD, "40 at 1.05, and no cut to itself");
        assertEq(shares.balanceOf(BEN), 40e18);
        assertEq(rounds.floorOf(address(dao)), 242 * USD * 1e18 / 240e18, "sold above the floor, so the floor rose");
    }

    function test_locked_team_shares_cannot_enter_a_round() public {
        guard.set(ANA, 50e18);
        uint256 id = rounds.open(address(dao));
        assertEq(rounds.priceAt(id, 0), 200 * USD * 1e18 / 150e18, "locked Shares claim nothing yet");
        vm.prank(ANA);
        vm.expectRevert();
        rounds.sell(id, 1, 0);
    }

    function test_rounds_open_only_for_a_dao_that_named_them_and_a_week_apart() public {
        vm.prank(address(dao));
        shares.clearExitExchange();
        vm.expectRevert(WeeklyRounds.NotNamed.selector);
        rounds.open(address(dao));
        vm.prank(address(dao));
        shares.announceExitExchange(address(rounds));
        vm.warp(block.timestamp + 30 days);
        shares.activateExitExchange();
        uint256 id = rounds.open(address(dao));
        (,, uint64 opensAt,,,,,,,,,,,,) = rounds.rounds(id);
        vm.expectRevert(abi.encodeWithSelector(WeeklyRounds.TooSoon.selector, opensAt + rounds.EVERY()));
        rounds.open(address(dao));
        vm.warp(opensAt + rounds.EVERY());
        assertEq(rounds.open(address(dao)), id + 1);
    }

    function test_one_order_a_side_a_person_and_steps_in_range() public {
        uint256 id = rounds.open(address(dao));
        _sell(id, ANA, 10e18, 0);
        vm.prank(ANA);
        vm.expectRevert(WeeklyRounds.AlreadyOrdered.selector);
        rounds.sell(id, 10e18, 0);
        vm.prank(BEN);
        vm.expectRevert(abi.encodeWithSelector(WeeklyRounds.BadStep.selector, 1024));
        rounds.bid(id, 1e18, 1024);
        vm.prank(BEN);
        vm.expectRevert(WeeklyRounds.BadAmount.selector);
        rounds.bid(id, 0, 1);
        vm.expectRevert(abi.encodeWithSelector(WeeklyRounds.BiddingOpen.selector, id));
        rounds.settle(id, 0);
        vm.prank(BEN);
        vm.expectRevert(WeeklyRounds.NoOrder.selector);
        rounds.cancelBid(id);
        vm.expectRevert(abi.encodeWithSelector(WeeklyRounds.UnknownRound.selector, 9));
        rounds.settle(9, 0);
        vm.prank(ANA);
        vm.expectRevert(abi.encodeWithSelector(WeeklyRounds.BadToken.selector, address(0)));
        rounds.claimAndLeave(id, new address[](0));
    }

    // ---- any round -------------------------------------------------------------------------------------------------

    /// @dev Any orders: the step the round settles at trades at least as much as any other step, no one trades past
    /// their limit, buyers get exactly what sellers sold, and every Share and almost every cent comes back out.
    function testFuzz_a_round_trades_the_most_any_step_could_and_pays_out_exactly(
        uint8[3] memory sellSteps,
        uint64[3] memory sellAmounts,
        uint8[3] memory bidSteps,
        uint64[3] memory bidAmounts
    ) public {
        uint256 id = rounds.open(address(dao));
        address[3] memory sellers = [ANA, CY, FAY];
        uint256[3] memory held = [uint256(50e18), 30e18, 10e18];
        address[3] memory buyers = [BEN, DEE, EVE];
        for (uint256 i; i < 3; ++i) {
            uint256 amount = bound(sellAmounts[i], 0, held[i] / 1e12) * 1e12;
            if (amount != 0) _sell(id, sellers[i], amount, bound(sellSteps[i], 0, 40));
            uint256 want = bound(bidAmounts[i], 0, 60e6) * 1e12;
            if (want != 0) _bid(id, buyers[i], want, bound(bidSteps[i], 0, 40));
        }
        (uint256 step, uint256 volume,) = rounds.clearingStep(id);
        for (uint256 s; s <= 42; ++s) {
            uint256 d = rounds.demandAt(id, s);
            uint256 sup = rounds.supplyAt(id, s);
            assertLe(d < sup ? d : sup, volume, "no step trades more");
        }
        _close(id);
        rounds.settle(id, step);
        uint256 bought;
        for (uint256 i; i < 3; ++i) {
            (uint128 amount,,) = rounds.sells(id, sellers[i]);
            if (amount != 0) rounds.claim(id, sellers[i]);
            (uint128 want, uint16 highest,) = rounds.bids(id, buyers[i]);
            if (want != 0) {
                rounds.claim(id, buyers[i]);
                uint256 got = shares.balanceOf(buyers[i]);
                if (got != 0) assertGe(highest, step, "no buyer pays above their highest price");
                bought += got;
            }
        }
        assertEq(bought, volume, "buyers get exactly what sellers sold");
        assertEq(shares.balanceOf(address(rounds)), 0, "every Share comes back out");
        assertLe(usd.balanceOf(address(rounds)), 6, "at most a rounding cent per order stays");
    }
}
