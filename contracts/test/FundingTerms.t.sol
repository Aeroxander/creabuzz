// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {VotingFixture} from "./helpers/VotingFixture.sol";
import {FundingTerms} from "../src/FundingTerms.sol";
import {WeeklyRounds} from "../src/WeeklyRounds.sol";
import {MandateCurrency} from "./TreasuryMandate.t.sol";

/// @notice Funding terms (D133) on a real summoned DAO under the issuance rule, as the kits make them: nothing new is sold
/// without terms published 30 days ahead; a tranche sells only through a funding round of the weekly rounds the DAO
/// named, never below two steps over what leaving pays; the units are created at each buyer's claim and their money goes
/// to the treasury; the terms can be narrowed at once but widened only with new notice.
contract FundingTermsTest is VotingFixture {
    address internal constant BEN = address(0xBE4);
    address internal constant DEE = address(0xDEE);
    uint256 internal constant USD = 1e6;
    uint16 internal constant NO_CAP = type(uint16).max;

    MandateCurrency internal usd;
    WeeklyRounds internal rounds;
    FundingTerms internal terms;

    function setUp() public override {
        super.setUp();
        // Alice holds 100 Shares and Bob 100 Loot: with 200 USDC in the treasury, leaving pays 1.00 a unit.
        usd = new MandateCurrency();
        usd.mint(address(dao), 200 * USD);
        rounds = new WeeklyRounds(IERC20(address(usd)), 1e4);
        terms = ledger.mandateFactory().fundingTerms();
        vm.startPrank(address(dao));
        shares.setIssuanceRule(NO_CAP);
        shares.lockTransfersWithNotice(address(0));
        shares.setLockGuard(address(0));
        shares.announceExitExchange(address(rounds));
        vm.stopPrank();
        vm.warp(block.timestamp + 30 days);
        shares.activateExitExchange();
        address[2] memory buyers = [BEN, DEE];
        for (uint256 i; i < buyers.length; ++i) {
            usd.mint(buyers[i], 1_000 * USD);
            vm.prank(buyers[i]);
            usd.approve(address(rounds), type(uint256).max);
        }
    }

    // ---- helpers -------------------------------------------------------------------------------------------------

    function _publish(bool asShares, uint128 cap) internal {
        vm.prank(address(dao));
        terms.publish(asShares, cap);
    }

    function _tranche(uint128 quantity, uint128 leastPrice) internal {
        vm.prank(address(dao));
        terms.openTranche(quantity, leastPrice, uint64(block.timestamp + 60 days));
    }

    function _bid(uint256 id, address who, uint256 amount, uint256 step) internal {
        vm.prank(who);
        rounds.bid(id, amount, step);
    }

    function _closesAt(uint256 id) internal view returns (uint64 closesAt) {
        (,,, closesAt,,,,,,,,,,,,,,) = rounds.rounds(id);
    }

    function _settle(uint256 id) internal returns (uint256 step) {
        vm.warp(_closesAt(id));
        (step,,) = rounds.clearingStep(id);
        rounds.settle(id, step);
    }

    function _sold() internal view returns (uint128 sold) {
        (,,,, sold) = terms.terms(address(dao));
    }

    // ---- nothing without terms ---------------------------------------------------------------------------------

    function test_nothing_new_is_sold_without_terms_and_not_before_their_notice() public {
        vm.expectRevert(FundingTerms.NothingToSell.selector);
        rounds.openFunding(address(dao));
        // No one else can create units: not a stranger, and not the DAO's own mint under the issuance rule.
        vm.expectRevert();
        loot.mintForFunding(BEN, 1);
        vm.expectRevert();
        shares.mintForFunding(BEN, 1);
        vm.prank(address(dao));
        vm.expectRevert();
        loot.mintFromMoloch(BEN, 1);

        _publish(false, 100e18);
        (,, uint64 activeFrom,,) = terms.terms(address(dao));
        vm.prank(address(dao));
        vm.expectRevert(abi.encodeWithSelector(FundingTerms.NotYet.selector, activeFrom));
        terms.openTranche(40e18, uint128(USD), uint64(block.timestamp + 60 days));
        vm.warp(activeFrom);
        vm.prank(address(dao));
        vm.expectRevert(abi.encodeWithSelector(FundingTerms.OverCap.selector, 100e18));
        terms.openTranche(101e18, uint128(USD), uint64(block.timestamp + 60 days));
        _tranche(40e18, uint128(USD));
        assertGt(rounds.openFunding(address(dao)), 0);
    }

    // ---- a funding round ---------------------------------------------------------------------------------------

    function test_a_funding_round_sells_loot_and_the_money_goes_to_the_treasury() public {
        _publish(false, 100e18);
        vm.warp(block.timestamp + terms.NOTICE());
        _tranche(40e18, uint128(110 * USD / 100));
        uint256 id = rounds.openFunding(address(dao));
        // The tranche is the only offer: 40 units at 1.10 or more (step 10 of a 1.00 floor).
        assertEq(rounds.supplyAt(id, 9), 0);
        assertEq(rounds.supplyAt(id, 10), 40e18);
        _bid(id, BEN, 30e18, 20);
        _bid(id, DEE, 30e18, 15);
        assertEq(_settle(id), 15, "1.15: the highest price at which bids take all 40");
        rounds.claim(id, BEN);
        rounds.claim(id, DEE);
        assertEq(loot.balanceOf(BEN), 30e18, "bid above the price: filled whole");
        assertEq(loot.balanceOf(DEE), 10e18, "at the price: the 10 left");
        assertEq(shares.balanceOf(BEN), 0, "no vote bought");
        assertEq(usd.balanceOf(BEN), 1_000 * USD - 345 * USD / 10);
        assertEq(usd.balanceOf(DEE), 1_000 * USD - 115 * USD / 10);
        assertEq(usd.balanceOf(address(dao)), 246 * USD, "40 at 1.15, all of it to the treasury");
        assertEq(_sold(), 40e18);
        assertEq(terms.owed(address(dao), address(rounds)), 0, "every unit sold was delivered");
        assertEq(usd.balanceOf(address(rounds)), 0);
        assertEq(rounds.floorOf(address(dao)), 246 * USD * 1e18 / 240e18, "sold above the floor, so it rose");
    }

    function test_terms_that_chose_shares_create_voting_shares_outside_the_award_allowance() public {
        _publish(true, 50e18);
        vm.warp(block.timestamp + terms.NOTICE());
        _tranche(20e18, uint128(USD));
        uint256 id = rounds.openFunding(address(dao));
        _bid(id, BEN, 20e18, 2);
        assertEq(_settle(id), 2);
        rounds.claim(id, BEN);
        assertEq(shares.balanceOf(BEN), 20e18);
        assertEq(shares.getVotes(BEN), 20e18, "a vote, delegated to themselves");
        assertEq(loot.balanceOf(BEN), 0);
    }

    function test_a_funding_round_settles_only_two_steps_above_what_leaving_pays_then() public {
        _publish(false, 100e18);
        vm.warp(block.timestamp + terms.NOTICE());
        _tranche(40e18, uint128(USD));
        uint256 id = rounds.openFunding(address(dao));
        _bid(id, BEN, 40e18, 5);
        // Revenue lands while bidding is open: leaving now pays 1.50, so 1.05 would sell below it.
        usd.mint(address(dao), 100 * USD);
        vm.warp(_closesAt(id));
        (uint256 step,,) = rounds.clearingStep(id);
        vm.expectRevert(abi.encodeWithSelector(WeeklyRounds.BelowFloor.selector, 150 * USD / 100));
        rounds.settle(id, step);
        // Nobody can settle it, so it is void: the buyer takes their money back, and the tranche returns.
        vm.warp(uint256(_closesAt(id)) + rounds.SETTLE_WINDOW());
        rounds.claim(id, BEN);
        assertEq(usd.balanceOf(BEN), 1_000 * USD);
        assertEq(terms.reserved(address(dao)), 0);
        (, uint128 taken,,) = terms.tranches(address(dao));
        assertEq(taken, 0, "the whole tranche can be offered again");
        assertEq(_sold(), 0);
    }

    function test_a_void_funding_round_nobody_touched_gives_its_tranche_back_to_the_next() public {
        _publish(false, 100e18);
        vm.warp(block.timestamp + terms.NOTICE());
        _tranche(40e18, uint128(USD));
        uint256 first = rounds.openFunding(address(dao));
        (,, uint64 opensAt,,,,,,,,,,,,,,,) = rounds.rounds(first);
        vm.warp(opensAt + rounds.EVERY());
        uint256 next = rounds.openFunding(address(dao));
        assertEq(rounds.supplyAt(next, 1023), 40e18, "the same 40 again");
    }

    // ---- narrowing, widening, who may act ----------------------------------------------------------------------

    function test_terms_narrow_at_once_but_widen_only_with_new_notice_and_never_change_instrument() public {
        _publish(false, 100e18);
        vm.prank(address(dao));
        vm.expectRevert(FundingTerms.BadTerms.selector);
        terms.publish(true, 200e18);
        vm.prank(address(dao));
        vm.expectRevert(FundingTerms.BadTerms.selector);
        terms.publish(false, 100e18);
        vm.warp(block.timestamp + terms.NOTICE());
        _tranche(40e18, uint128(USD));
        uint256 id = rounds.openFunding(address(dao));
        _bid(id, BEN, 40e18, 2);
        _settle(id);
        rounds.claim(id, BEN);
        assertEq(_sold(), 40e18);
        vm.prank(address(dao));
        vm.expectRevert(FundingTerms.BadTerms.selector);
        terms.lowerCap(39e18);
        vm.prank(address(dao));
        terms.lowerCap(50e18);
        _publish(false, 80e18);
        (,, uint64 activeFrom,,) = terms.terms(address(dao));
        assertEq(activeFrom, block.timestamp + terms.NOTICE(), "widening restarts the notice");
        vm.prank(address(dao));
        vm.expectRevert(abi.encodeWithSelector(FundingTerms.NotYet.selector, activeFrom));
        terms.openTranche(10e18, uint128(USD), uint64(block.timestamp + 60 days));
    }

    function test_only_the_named_exchange_reserves_and_only_the_one_that_reserved_settles_and_delivers() public {
        _publish(false, 100e18);
        vm.warp(block.timestamp + terms.NOTICE());
        _tranche(40e18, uint128(USD));
        vm.prank(BEN);
        vm.expectRevert(FundingTerms.NotTheExchange.selector);
        terms.reserve(address(dao));
        uint256 id = rounds.openFunding(address(dao));
        vm.prank(BEN);
        vm.expectRevert(FundingTerms.NotTheExchange.selector);
        terms.settle(address(dao), 0);
        vm.prank(BEN);
        vm.expectRevert(FundingTerms.TooMuch.selector);
        terms.deliver(address(dao), BEN, 1);
        // Holders do not sell in a funding round, and a buyer does not leave from it.
        vm.prank(ALICE);
        vm.expectRevert(WeeklyRounds.NotForFunding.selector);
        rounds.sell(id, 1, 0);
        _bid(id, BEN, 10e18, 2);
        _settle(id);
        address[] memory leaveWith = new address[](1);
        leaveWith[0] = address(usd);
        vm.prank(BEN);
        vm.expectRevert(WeeklyRounds.NotForFunding.selector);
        rounds.claimAndLeave(id, leaveWith);
    }
}
