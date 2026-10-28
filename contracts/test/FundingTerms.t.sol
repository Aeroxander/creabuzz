// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {VotingFixture} from "./helpers/VotingFixture.sol";
import {FundingTerms} from "../src/FundingTerms.sol";
import {WeeklyRounds} from "../src/WeeklyRounds.sol";
import {MandateCurrency} from "./TreasuryMandate.t.sol";

/// @notice A stand-in rounds contract: any contract can be named, so the terms must not trust whichever is the exchange.
contract OtherRounds {
    IERC20 public immutable currency;

    constructor(IERC20 currency_) {
        currency = currency_;
    }
}

/// @notice Funding terms (D133) on a real summoned DAO under the issuance rule, as the kits make them: nothing new is sold
/// without terms published 30 days ahead; a tranche sells only through the rounds contract the terms name, never below
/// two steps over what leaving pays, and only while the treasury holds the round's currency alone; settling creates the
/// units and pays the treasury at once; a void round can be finished by anyone; the terms narrow at once and widen only
/// with new notice.
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
        terms.publish(asShares, cap, address(rounds));
    }

    function _tranche(uint128 quantity, uint128 leastPrice) internal {
        vm.prank(address(dao));
        terms.openTranche(quantity, leastPrice, uint64(block.timestamp + 60 days));
    }

    function _selling(uint128 quantity, uint128 leastPrice) internal returns (uint256 id) {
        _publish(false, 100e18);
        vm.warp(block.timestamp + terms.NOTICE());
        _tranche(quantity, leastPrice);
        id = rounds.openFunding(address(dao));
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
        (,,,, sold,) = terms.terms(address(dao));
    }

    function _activeFrom() internal view returns (uint64 activeFrom) {
        (,, activeFrom,,,) = terms.terms(address(dao));
    }

    function _leaveWithUsd() internal view returns (address[] memory tokens) {
        tokens = new address[](1);
        tokens[0] = address(usd);
    }

    // ---- nothing without terms ---------------------------------------------------------------------------------

    function test_nothing_new_is_sold_without_terms_and_not_before_their_notice() public {
        vm.expectRevert(FundingTerms.NotTheRounds.selector);
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
        uint64 activeFrom = _activeFrom();
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

    function test_settling_creates_the_units_and_pays_the_treasury_then_buyers_collect_them() public {
        uint256 id = _selling(40e18, uint128(110 * USD / 100));
        // The tranche is the only offer: 40 units at 1.10 or more (step 10 of a 1.00 floor).
        assertEq(rounds.supplyAt(id, 9), 0);
        assertEq(rounds.supplyAt(id, 10), 40e18);
        _bid(id, BEN, 30e18, 20);
        _bid(id, DEE, 30e18, 15);
        assertEq(_settle(id), 15, "1.15: the highest price at which bids take all 40");
        assertEq(loot.balanceOf(address(rounds)), 40e18, "created at settling, held for the buyers");
        assertEq(usd.balanceOf(address(dao)), 246 * USD, "40 at 1.15, paid to the treasury at settling");
        assertEq(_sold(), 40e18);
        rounds.claim(id, BEN);
        rounds.claim(id, DEE);
        assertEq(loot.balanceOf(BEN), 30e18, "bid above the price: filled whole");
        assertEq(loot.balanceOf(DEE), 10e18, "at the price: the 10 left");
        assertEq(shares.balanceOf(BEN), 0, "no vote bought");
        assertEq(usd.balanceOf(BEN), 1_000 * USD - 345 * USD / 10);
        assertEq(usd.balanceOf(DEE), 1_000 * USD - 115 * USD / 10);
        assertEq(loot.balanceOf(address(rounds)), 0);
        assertEq(usd.balanceOf(address(rounds)), 0);
        assertEq(rounds.floorOf(address(dao)), 246 * USD * 1e18 / 240e18, "sold above the floor, so it rose");
    }

    /// @dev The review's second case: revenue arriving between settling and collecting. The units already exist and were
    /// paid for at settling, so the revenue is shared by every holder, the buyer included, and the buyer cannot be sold
    /// units at a price below what leaving pays when they collect.
    function test_revenue_after_settling_is_shared_by_every_holder_and_sells_nobody_anything_cheaper() public {
        uint256 id = _selling(40e18, uint128(105 * USD / 100));
        _bid(id, BEN, 40e18, 5);
        _settle(id);
        uint256 floorAtSettling = rounds.floorOf(address(dao));
        assertEq(floorAtSettling, 242 * USD * 1e18 / 240e18, "the 40 units count from settling");
        usd.mint(address(dao), 240 * USD); // revenue lands before anyone collects
        // The 40 units already count, so the revenue is shared by 240 units, not handed to the first 200.
        assertEq(rounds.floorOf(address(dao)), 482 * USD * 1e18 / 240e18);
        vm.prank(BEN);
        rounds.claimAndLeave(id, _leaveWithUsd());
        // Ben leaves with 40 of 240 units of a 482 treasury: the same per unit as every other holder.
        assertEq(usd.balanceOf(BEN), 1_000 * USD - 42 * USD + 482 * USD * 40 / 240);
        // Every other unit is worth what it was just before Ben left: 482 over 240.
        assertApproxEqAbs(rounds.floorOf(address(dao)), 482 * USD * 1e18 / 240e18, 1, "nobody else's part was taken");
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
        uint256 id = _selling(40e18, uint128(USD));
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

    // ---- the treasury's other assets (the review's first case) --------------------------------------------------

    function test_nothing_sells_while_the_treasury_holds_eth_or_a_watched_token() public {
        _publish(false, 100e18);
        vm.warp(block.timestamp + terms.NOTICE());
        _tranche(40e18, uint128(USD));
        // 10 ETH in the treasury: a price set in USDC would give buyers part of it for nothing.
        vm.deal(address(dao), 10 ether);
        vm.expectRevert(abi.encodeWithSelector(FundingTerms.OtherAssets.selector, address(0)));
        rounds.openFunding(address(dao));
        vm.deal(address(dao), 0);
        MandateCurrency other = new MandateCurrency();
        address[] memory watched = new address[](2);
        watched[0] = address(other);
        watched[1] = address(usd); // the round's own currency is never a reason to stop
        vm.prank(address(dao));
        terms.watch(watched);
        other.mint(address(dao), 1);
        vm.expectRevert(abi.encodeWithSelector(FundingTerms.OtherAssets.selector, address(other)));
        rounds.openFunding(address(dao));
        vm.prank(address(dao));
        other.transfer(address(0xdead), 1);
        uint256 id = rounds.openFunding(address(dao));
        _bid(id, BEN, 40e18, 2);
        // ETH arriving during bidding stops settling too; the round goes void and the tranche comes back.
        vm.deal(address(dao), 1 ether);
        vm.warp(_closesAt(id));
        (uint256 step,,) = rounds.clearingStep(id);
        vm.expectRevert(abi.encodeWithSelector(FundingTerms.OtherAssets.selector, address(0)));
        rounds.settle(id, step);
    }

    // ---- recovery (the review's third case) ---------------------------------------------------------------------

    function test_a_void_round_is_finished_by_anyone_and_frees_the_tranche() public {
        uint256 id = _selling(40e18, uint128(USD));
        vm.prank(address(dao));
        vm.expectRevert(FundingTerms.RoundOpen.selector);
        terms.closeTranche();
        vm.warp(uint256(_closesAt(id)) - 1);
        vm.expectRevert(abi.encodeWithSelector(WeeklyRounds.NotOver.selector, id));
        rounds.finishFunding(id);
        // Nobody bids and nobody settles; the tranche even expires. Anyone finishes the round.
        vm.warp(block.timestamp + 61 days);
        vm.prank(BEN);
        rounds.finishFunding(id);
        assertEq(terms.reserved(address(dao)), 0);
        vm.expectRevert(WeeklyRounds.NothingToClaim.selector);
        rounds.finishFunding(id);
        vm.prank(address(dao));
        terms.closeTranche();
        _tranche(20e18, uint128(USD));
        assertGt(rounds.openFunding(address(dao)), id, "and sell again");
    }

    // ---- who may sell (the review's fourth case) ---------------------------------------------------------------

    function test_only_the_rounds_contract_the_terms_name_reserves_and_settles_and_terms_name_a_contract() public {
        vm.prank(address(dao));
        vm.expectRevert(FundingTerms.BadTerms.selector);
        terms.publish(false, 100e18, BEN); // a wallet can't be named
        _publish(false, 100e18);
        vm.warp(block.timestamp + terms.NOTICE());
        _tranche(40e18, uint128(USD));
        // Naming another exchange gives it no power to sell new units.
        OtherRounds other = new OtherRounds(IERC20(address(usd)));
        vm.prank(address(other));
        vm.expectRevert(FundingTerms.NotTheRounds.selector);
        terms.reserve(address(dao));
        vm.prank(BEN);
        vm.expectRevert(FundingTerms.NotTheRounds.selector);
        terms.settle(address(dao), 0);
        // The rounds contract named can't be swapped by widening the terms.
        vm.prank(address(dao));
        vm.expectRevert(FundingTerms.BadTerms.selector);
        terms.publish(false, 200e18, address(other));
        uint256 id = rounds.openFunding(address(dao));
        vm.prank(ALICE);
        vm.expectRevert(WeeklyRounds.NotForFunding.selector);
        rounds.sell(id, 1, 0);
    }

    // ---- narrowing and widening ---------------------------------------------------------------------------------

    function test_terms_narrow_at_once_but_widen_only_with_new_notice_and_never_change_instrument() public {
        _publish(false, 100e18);
        vm.prank(address(dao));
        vm.expectRevert(FundingTerms.BadTerms.selector);
        terms.publish(true, 200e18, address(rounds));
        vm.prank(address(dao));
        vm.expectRevert(FundingTerms.BadTerms.selector);
        terms.publish(false, 100e18, address(rounds));
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
        uint64 activeFrom = _activeFrom();
        assertEq(activeFrom, block.timestamp + terms.NOTICE(), "widening restarts the notice");
        vm.prank(address(dao));
        vm.expectRevert(abi.encodeWithSelector(FundingTerms.NotYet.selector, activeFrom));
        terms.openTranche(10e18, uint128(USD), uint64(block.timestamp + 60 days));
    }

    // ---- Loot through the exchange -------------------------------------------------------------------------------

    function test_loot_moves_only_through_the_exchange_the_dao_named() public {
        // The kits lock Loot as they lock Shares.
        vm.prank(address(dao));
        loot.setTransfersLocked(true);
        vm.prank(BOB);
        vm.expectRevert();
        loot.transfer(BEN, 1e18);
        vm.prank(BOB);
        loot.approve(address(rounds), 1e18);
        vm.prank(address(rounds));
        loot.transferFrom(BOB, BEN, 1e18);
        assertEq(loot.balanceOf(BEN), 1e18);
    }
}
