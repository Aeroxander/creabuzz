// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IArbitrator, OpenBounty} from "../src/OpenBounty.sol";
import {MandateCurrency} from "./TreasuryMandate.t.sol";
import {BlockingCurrency, FeeCurrency} from "./WorkAreaBounty.t.sol";

/// @notice A bounty on a post (N2), against docs/v3-review/OPEN-BOUNTY-STATES.md: each row of its boundary table on both
/// sides, the example that made a claimant's money leave the count, and its eight walked-through cases.
contract OpenBountyTest is Test {
    address internal constant BEN = address(0xBE11);
    address internal constant CARA = address(0xCA2A);
    address internal constant DEV = address(0xDE7);
    address internal constant EVE = address(0xE7E);
    address internal constant ANA = address(0xA11A);
    bytes32 internal constant POST = keccak256("ben's post");
    string internal constant WORDS = "A one-minute video of the bike lane painted on Elm Street.";

    MandateCurrency internal usd;
    OpenBounty internal bounty;
    uint64 internal deadline;

    function setUp() public {
        vm.warp(100 days);
        usd = new MandateCurrency();
        bounty = new OpenBounty(IERC20(address(usd)), IArbitrator(address(0)));
        address[5] memory people = [BEN, CARA, DEV, EVE, ANA];
        for (uint256 i; i < people.length; ++i) {
            usd.mint(people[i], 1_000e6);
            vm.prank(people[i]);
            usd.approve(address(bounty), type(uint256).max);
        }
        deadline = uint64(block.timestamp + 30 days);
    }

    // ---- helpers -------------------------------------------------------------------------------------------------

    function _open(address who, uint256 amount) internal returns (uint256 id) {
        vm.prank(who);
        id = bounty.open(POST, WORDS, deadline, amount);
    }

    function _fund(uint256 id, address who, uint256 amount) internal {
        vm.prank(who);
        bounty.fund(id, amount);
    }

    function _file(uint256 id, address who) internal returns (uint32 claim) {
        vm.prank(who);
        claim = bounty.fileClaim(id, "https://example.com/video");
    }

    function _back(uint256 id, address who, uint32 claim) internal {
        vm.prank(who);
        bounty.back(id, claim);
    }

    function _b(uint256 id) internal view returns (OpenBounty.Bounty memory b) {
        (
            b.creator,
            b.openedAt,
            b.deadline,
            b.refundsFrom,
            b.post,
            b.wordsHash,
            b.total,
            b.refunded,
            b.counting,
            b.claimCount,
            b.runClaim,
            b.runSince,
            b.paidClaim
        ) = bounty.bounties(id);
    }

    function _backing(uint256 id, uint32 claim) internal view returns (uint128 backing) {
        (,, backing,) = bounty.claims(id, claim);
    }

    // ---- opening -------------------------------------------------------------------------------------------------

    function test_opening_fixes_the_words_both_dates_and_the_first_money() public {
        uint256 id = _open(BEN, 50e6);
        OpenBounty.Bounty memory b = _b(id);
        assertEq(b.creator, BEN);
        assertEq(b.post, POST);
        assertEq(b.wordsHash, keccak256(bytes(WORDS)));
        assertEq(b.deadline, deadline);
        assertEq(b.refundsFrom, deadline + 9 days + 14 days);
        assertEq(b.total, 50e6);
        assertEq(b.counting, 50e6);
        assertEq(bounty.funded(id, BEN), 50e6);
        assertEq(usd.balanceOf(address(bounty)), 50e6);
    }

    function test_opening_needs_words_of_at_most_1000_bytes_a_deadline_within_a_year_and_money() public {
        vm.startPrank(BEN);
        vm.expectRevert(OpenBounty.BadText.selector);
        bounty.open(POST, "", deadline, 1e6);
        vm.expectRevert(OpenBounty.BadText.selector);
        bounty.open(POST, string(new bytes(1001)), deadline, 1e6);
        bounty.open(POST, string(new bytes(1000)), deadline, 1e6);

        uint64 now_ = uint64(block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(OpenBounty.BadDeadline.selector, now_));
        bounty.open(POST, WORDS, now_, 1e6);
        vm.expectRevert(abi.encodeWithSelector(OpenBounty.BadDeadline.selector, now_ + 365 days + 1));
        bounty.open(POST, WORDS, now_ + 365 days + 1, 1e6);
        bounty.open(POST, WORDS, now_ + 365 days, 1e6);

        vm.expectRevert(OpenBounty.NothingToFund.selector);
        bounty.open(POST, WORDS, deadline, 0);
        vm.stopPrank();
    }

    function test_a_currency_that_keeps_a_fee_is_refused() public {
        FeeCurrency fee = new FeeCurrency();
        OpenBounty b = new OpenBounty(IERC20(address(fee)), IArbitrator(address(0)));
        fee.mint(BEN, 100e6);
        vm.startPrank(BEN);
        fee.approve(address(b), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(OpenBounty.ShortTransfer.selector, 100e6, 99e6));
        b.open(POST, WORDS, deadline, 100e6);
        vm.stopPrank();
        vm.expectRevert(OpenBounty.InvalidSetup.selector);
        new OpenBounty(IERC20(address(0xBEEF)), IArbitrator(address(0)));
    }

    // ---- money in ------------------------------------------------------------------------------------------------

    function test_money_comes_in_until_the_deadline() public {
        uint256 id = _open(BEN, 50e6);
        vm.warp(deadline - 1);
        _fund(id, CARA, 1e6);
        vm.warp(deadline);
        vm.prank(CARA);
        vm.expectRevert(abi.encodeWithSelector(OpenBounty.PastDeadline.selector, id));
        bounty.fund(id, 1e6);
    }

    function test_money_pauses_while_a_run_is_on_and_comes_in_again_once_it_ends() public {
        uint256 id = _open(BEN, 50e6);
        uint32 claim = _file(id, DEV);
        _back(id, BEN, claim); // 50 of 50: a run
        assertEq(_b(id).runClaim, claim);
        vm.prank(CARA);
        vm.expectRevert(abi.encodeWithSelector(OpenBounty.RunOn.selector, id));
        bounty.fund(id, 10e6);
        vm.prank(BEN);
        bounty.unback(id);
        assertEq(_b(id).runClaim, 0);
        _fund(id, CARA, 10e6);
        assertEq(_b(id).total, 60e6);
    }

    function test_more_money_from_a_backer_adds_to_the_claim_and_can_start_its_run() public {
        uint256 id = _open(BEN, 50e6);
        _fund(id, CARA, 50e6);
        uint32 claim = _file(id, DEV);
        _back(id, BEN, claim); // 50 of 100: exactly half, no run
        assertEq(_b(id).runClaim, 0);
        _fund(id, BEN, 1e6); // 51 of 101
        assertEq(_backing(id, claim), 51e6);
        assertEq(_b(id).runClaim, claim);
    }

    function test_a_claimants_money_is_in_the_pot_but_never_in_the_count() public {
        uint256 id = _open(BEN, 50e6);
        _file(id, DEV);
        _fund(id, DEV, 30e6);
        OpenBounty.Bounty memory b = _b(id);
        assertEq(b.total, 80e6);
        assertEq(b.counting, 50e6);
    }

    // ---- claims --------------------------------------------------------------------------------------------------

    function test_claims_close_at_the_deadline_one_open_claim_per_wallet() public {
        uint256 id = _open(BEN, 50e6);
        uint32 first = _file(id, DEV);
        vm.prank(DEV);
        vm.expectRevert(abi.encodeWithSelector(OpenBounty.HasOpenClaim.selector, id, first));
        bounty.fileClaim(id, "again");
        vm.prank(DEV);
        bounty.withdrawClaim(id);
        uint32 second = _file(id, DEV);
        assertEq(second, first + 1);

        vm.startPrank(CARA);
        vm.expectRevert(OpenBounty.BadText.selector);
        bounty.fileClaim(id, "");
        vm.expectRevert(OpenBounty.BadText.selector);
        bounty.fileClaim(id, string(new bytes(1001)));
        vm.stopPrank();

        vm.warp(deadline - 1);
        _file(id, EVE);
        vm.warp(deadline);
        vm.prank(CARA);
        vm.expectRevert(abi.encodeWithSelector(OpenBounty.PastDeadline.selector, id));
        bounty.fileClaim(id, "late");
    }

    function test_filing_a_claim_takes_the_filers_money_out_of_the_count_and_their_backing() public {
        uint256 id = _open(BEN, 50e6);
        _fund(id, CARA, 30e6);
        uint32 claim = _file(id, DEV);
        _back(id, CARA, claim);
        assertEq(_backing(id, claim), 30e6);
        _file(id, CARA);
        assertEq(_backing(id, claim), 0);
        assertEq(_b(id).counting, 50e6);
        assertEq(bounty.backs(id, CARA), 0);
        vm.prank(CARA);
        vm.expectRevert(abi.encodeWithSelector(OpenBounty.HasOpenClaim.selector, id, uint32(2)));
        bounty.back(id, claim);
        vm.prank(CARA);
        bounty.withdrawClaim(id);
        assertEq(_b(id).counting, 80e6);
    }

    // ---- backing and majorities ------------------------------------------------------------------------------------

    function test_exactly_half_is_not_a_majority_and_one_unit_more_is() public {
        uint256 id = _open(BEN, 50e6);
        _fund(id, CARA, 50e6);
        uint32 claim = _file(id, DEV);
        _back(id, BEN, claim);
        assertFalse(bounty.qualifies(id, claim));
        assertEq(_b(id).runClaim, 0);
        vm.prank(DEV);
        vm.expectRevert(abi.encodeWithSelector(OpenBounty.NotQualified.selector, id, claim));
        bounty.start(id, claim);
        _fund(id, EVE, 1); // the count grows by one: still not a majority
        _fund(id, BEN, 2); // 50e6 + 2 of 100e6 + 3
        assertTrue(bounty.qualifies(id, claim));
        assertEq(_b(id).runClaim, claim);
    }

    /// @dev The case in the spec's change 1: Ana put in 60, filed claim A and backs claim B. Under the old rule (each claim
    /// leaving out only its own claimant's money) both would have a majority. With one count, Ana's 60 counts for nobody.
    function test_a_claimant_backs_nothing_so_two_claims_never_both_have_a_majority() public {
        uint256 id = _open(BEN, 15e6);
        _fund(id, ANA, 60e6);
        _fund(id, CARA, 25e6);
        uint32 claimB = _file(id, DEV);
        _back(id, ANA, claimB);
        assertEq(_b(id).runClaim, claimB); // 60 of 100
        uint32 claimA = _file(id, ANA); // Ana files: her 60 leaves the count and B's backing
        assertEq(_b(id).counting, 40e6);
        assertEq(_backing(id, claimB), 0);
        assertEq(_b(id).runClaim, 0); // B's run ends
        _back(id, CARA, claimA); // 25 of 40: A has a majority, B has none
        assertTrue(bounty.qualifies(id, claimA));
        assertFalse(bounty.qualifies(id, claimB));
        assertEq(_b(id).runClaim, claimA);
    }

    function test_backing_closes_at_the_deadline_but_withdrawing_it_does_not() public {
        uint256 id = _open(BEN, 50e6);
        _fund(id, CARA, 50e6);
        uint32 claim = _file(id, DEV);
        vm.warp(deadline - 1);
        _back(id, BEN, claim);
        vm.warp(deadline);
        vm.prank(CARA);
        vm.expectRevert(abi.encodeWithSelector(OpenBounty.PastDeadline.selector, id));
        bounty.back(id, claim);
        vm.prank(BEN);
        bounty.unback(id);
        assertEq(_backing(id, claim), 0);
    }

    function test_moving_backing_ends_one_run_and_starts_another_in_the_same_step() public {
        uint256 id = _open(BEN, 60e6);
        _fund(id, CARA, 40e6);
        uint32 dev = _file(id, DEV);
        uint32 eve = _file(id, EVE);
        _back(id, BEN, dev);
        assertEq(_b(id).runClaim, dev);
        _back(id, BEN, eve);
        assertEq(_backing(id, dev), 0);
        assertEq(_b(id).runClaim, eve);
        assertEq(_b(id).runSince, block.timestamp);
        vm.prank(BEN);
        vm.expectRevert(abi.encodeWithSelector(OpenBounty.AlreadyBacking.selector, id, eve));
        bounty.back(id, eve);
        vm.prank(DEV);
        vm.expectRevert(abi.encodeWithSelector(OpenBounty.NoWeight.selector, id));
        bounty.back(id, eve);
    }

    // ---- paying --------------------------------------------------------------------------------------------------

    /// @dev Walked through, case 1.
    function test_the_usual_case_pays_the_whole_pot_exactly_nine_days_into_the_run() public {
        uint256 id = _open(BEN, 50e6);
        vm.warp(block.timestamp + 3 days);
        _fund(id, CARA, 50e6);
        vm.warp(block.timestamp + 7 days);
        uint32 claim = _file(id, DEV);
        vm.warp(block.timestamp + 1 days);
        _back(id, BEN, claim);
        assertEq(_b(id).runClaim, 0);
        vm.warp(block.timestamp + 1 days);
        _back(id, CARA, claim);
        uint64 payableAt = _b(id).runSince + 9 days;

        vm.warp(payableAt - 1);
        vm.expectRevert(abi.encodeWithSelector(OpenBounty.NotPayableYet.selector, id, payableAt));
        bounty.pay(id);
        vm.warp(payableAt);
        vm.prank(EVE); // anyone; the money goes to the claimant
        bounty.pay(id);
        assertEq(usd.balanceOf(DEV), 1_100e6);
        assertEq(usd.balanceOf(address(bounty)), 0);
        assertEq(_b(id).paidClaim, claim);
        vm.expectRevert(abi.encodeWithSelector(OpenBounty.AlreadyPaid.selector, id));
        bounty.pay(id);
        vm.warp(_b(id).refundsFrom);
        vm.expectRevert(abi.encodeWithSelector(OpenBounty.AlreadyPaid.selector, id));
        bounty.refund(id, BEN);
    }

    /// @dev Walked through, case 2: new evidence during the hold, a backer withdraws, nothing is paid.
    function test_a_dip_during_the_hold_ends_the_run_and_nothing_is_paid() public {
        uint256 id = _open(BEN, 50e6);
        _fund(id, CARA, 50e6);
        uint32 claim = _file(id, DEV);
        _back(id, BEN, claim);
        _back(id, CARA, claim);
        vm.warp(block.timestamp + 5 days);
        vm.prank(CARA);
        bounty.unback(id);
        assertEq(_b(id).runClaim, 0);
        vm.warp(block.timestamp + 5 days);
        vm.expectRevert(abi.encodeWithSelector(OpenBounty.NoRun.selector, id));
        bounty.pay(id);
        _fund(id, EVE, 1e6); // money comes in again
    }

    function test_withdrawing_the_running_claim_ends_its_run() public {
        uint256 id = _open(BEN, 50e6);
        uint32 claim = _file(id, DEV);
        _back(id, BEN, claim);
        vm.prank(DEV);
        bounty.withdrawClaim(id);
        assertEq(_b(id).runClaim, 0);
        vm.prank(BEN);
        vm.expectRevert(abi.encodeWithSelector(OpenBounty.NotOpen.selector, id, claim));
        bounty.back(id, claim);
    }

    /// @dev Walked through, case 3: one funder holds most of the money and decides alone.
    function test_one_big_funder_decides_alone() public {
        uint256 id = _open(BEN, 100e6);
        _fund(id, CARA, 10e6);
        uint32 claim = _file(id, DEV);
        _back(id, BEN, claim);
        assertEq(_b(id).runClaim, claim);
        vm.warp(block.timestamp + 9 days);
        bounty.pay(id);
        assertEq(usd.balanceOf(DEV), 1_110e6);
    }

    /// @dev Walked through, case 4: a run that started before the deadline goes on after it; a dip then opens refunds.
    function test_a_run_across_the_deadline_goes_on_and_a_dip_after_it_opens_refunds() public {
        uint256 id = _open(BEN, 50e6);
        _fund(id, CARA, 50e6);
        uint32 claim = _file(id, DEV);
        _back(id, BEN, claim);
        vm.warp(deadline - 1 days);
        _back(id, CARA, claim);
        vm.warp(deadline + 3 days);
        vm.expectRevert(abi.encodeWithSelector(OpenBounty.RefundsNotOpen.selector, id));
        bounty.refund(id, BEN);
        vm.prank(CARA);
        bounty.unback(id);
        assertEq(_b(id).runClaim, 0);
        vm.prank(CARA);
        vm.expectRevert(abi.encodeWithSelector(OpenBounty.PastDeadline.selector, id));
        bounty.back(id, claim);
        vm.expectRevert(abi.encodeWithSelector(OpenBounty.PastDeadline.selector, id));
        bounty.start(id, claim);
        bounty.refund(id, CARA);
        assertEq(usd.balanceOf(CARA), 1_000e6);
    }

    function test_a_run_across_the_deadline_is_paid_when_it_keeps_its_majority() public {
        uint256 id = _open(BEN, 50e6);
        uint32 claim = _file(id, DEV);
        vm.warp(deadline - 1);
        _back(id, BEN, claim);
        vm.warp(deadline - 1 + 9 days);
        bounty.pay(id);
        assertEq(usd.balanceOf(DEV), 1_050e6);
    }

    function test_payment_closes_exactly_at_refundsFrom() public {
        uint256 id = _open(BEN, 50e6);
        uint256 late = _open(CARA, 50e6);
        uint32 claim = _file(id, DEV);
        uint32 lateClaim = _file(late, DEV);
        vm.warp(deadline - 1);
        _back(id, BEN, claim);
        _back(late, CARA, lateClaim);
        uint64 refundsFrom = _b(id).refundsFrom;

        vm.warp(refundsFrom);
        vm.expectRevert(abi.encodeWithSelector(OpenBounty.PayTooLate.selector, late, refundsFrom));
        bounty.pay(late);
        bounty.refund(late, CARA);

        vm.warp(refundsFrom - 1);
        bounty.pay(id);
        assertEq(usd.balanceOf(DEV), 1_050e6);
    }

    /// @dev Walked through, case 8: a funder files a claim, the count falls, anyone starts the wait; withdrawing the
    /// claim makes the funder's money count again and the run ends.
    function test_a_majority_that_no_backing_gave_is_started_by_anyone() public {
        uint256 id = _open(BEN, 40e6);
        _fund(id, CARA, 30e6);
        _fund(id, EVE, 30e6);
        uint32 dev = _file(id, DEV);
        _back(id, BEN, dev); // 40 of 100
        assertEq(_b(id).runClaim, 0);
        _file(id, EVE); // Eve's 30 leaves the count: 40 of 70
        assertTrue(bounty.qualifies(id, dev));
        assertEq(_b(id).runClaim, 0);
        vm.prank(CARA);
        bounty.start(id, dev);
        assertEq(_b(id).runClaim, dev);
        vm.prank(CARA);
        vm.expectRevert(abi.encodeWithSelector(OpenBounty.RunOn.selector, id));
        bounty.start(id, dev);
        vm.prank(EVE);
        bounty.withdrawClaim(id); // 40 of 100 again
        assertEq(_b(id).runClaim, 0);
    }

    // ---- refunds -------------------------------------------------------------------------------------------------

    /// @dev Walked through, case 5.
    function test_with_no_run_refunds_open_exactly_at_the_deadline_each_funder_their_own() public {
        uint256 id = _open(BEN, 50e6);
        _fund(id, CARA, 50e6);
        uint32 dev = _file(id, DEV);
        uint32 eve = _file(id, EVE);
        _back(id, BEN, dev);
        _back(id, CARA, eve); // 50 and 50 of 100: neither has a majority
        assertEq(_b(id).runClaim, 0);
        vm.warp(deadline - 1);
        assertFalse(bounty.refundsOpen(id));
        vm.expectRevert(abi.encodeWithSelector(OpenBounty.RefundsNotOpen.selector, id));
        bounty.refund(id, BEN);
        vm.warp(deadline);
        assertTrue(bounty.refundsOpen(id));
        vm.prank(DEV); // anyone; the money goes to the funder
        bounty.refund(id, BEN);
        bounty.refund(id, CARA);
        assertEq(usd.balanceOf(BEN), 1_000e6);
        assertEq(usd.balanceOf(CARA), 1_000e6);
        assertEq(usd.balanceOf(DEV), 1_000e6);
        assertEq(bounty.held(id), 0);
        vm.expectRevert(abi.encodeWithSelector(OpenBounty.NothingToRefund.selector, id, BEN));
        bounty.refund(id, BEN);
    }

    /// @dev Walked through, case 6.
    function test_when_every_funder_is_a_claimant_nothing_qualifies_and_refunds_open_at_the_deadline() public {
        uint256 id = _open(BEN, 50e6);
        _fund(id, CARA, 50e6);
        uint32 ben = _file(id, BEN);
        _file(id, CARA);
        assertEq(_b(id).counting, 0);
        assertFalse(bounty.qualifies(id, ben));
        vm.warp(deadline);
        bounty.refund(id, BEN);
        bounty.refund(id, CARA);
        assertEq(usd.balanceOf(address(bounty)), 0);
    }

    /// @dev Walked through, case 7.
    function test_a_claimant_the_currency_refuses_is_never_paid_and_funders_get_refunds_at_refundsFrom() public {
        BlockingCurrency blocking = new BlockingCurrency();
        OpenBounty b = new OpenBounty(IERC20(address(blocking)), IArbitrator(address(0)));
        blocking.mint(BEN, 50e6);
        vm.startPrank(BEN);
        blocking.approve(address(b), type(uint256).max);
        uint256 id = b.open(POST, WORDS, deadline, 50e6);
        vm.stopPrank();
        vm.prank(DEV);
        uint32 claim = b.fileClaim(id, "evidence");
        vm.prank(BEN);
        b.back(id, claim);
        blocking.block_(DEV);
        vm.warp(block.timestamp + 9 days);
        vm.expectRevert(bytes("blocked"));
        b.pay(id);
        (,,, uint64 refundsFrom,,,,,,,,,) = b.bounties(id);
        vm.warp(refundsFrom - 1);
        vm.expectRevert(abi.encodeWithSelector(OpenBounty.RefundsNotOpen.selector, id));
        b.refund(id, BEN);
        vm.warp(refundsFrom);
        b.refund(id, BEN);
        assertEq(blocking.balanceOf(BEN), 50e6);
    }

    function test_a_funder_the_currency_refuses_does_not_block_another_funders_refund() public {
        BlockingCurrency blocking = new BlockingCurrency();
        OpenBounty b = new OpenBounty(IERC20(address(blocking)), IArbitrator(address(0)));
        blocking.mint(BEN, 50e6);
        blocking.mint(CARA, 30e6);
        vm.startPrank(BEN);
        blocking.approve(address(b), type(uint256).max);
        uint256 id = b.open(POST, WORDS, deadline, 50e6);
        vm.stopPrank();
        vm.startPrank(CARA);
        blocking.approve(address(b), type(uint256).max);
        b.fund(id, 30e6);
        vm.stopPrank();
        blocking.block_(BEN);
        vm.warp(deadline);
        vm.expectRevert(bytes("blocked"));
        b.refund(id, BEN);
        b.refund(id, CARA);
        assertEq(blocking.balanceOf(CARA), 30e6);
        assertEq(b.held(id), 50e6);
    }

    function test_an_unknown_bounty_is_refused_everywhere() public {
        vm.expectRevert(abi.encodeWithSelector(OpenBounty.UnknownBounty.selector, 7));
        bounty.fund(7, 1);
        vm.expectRevert(abi.encodeWithSelector(OpenBounty.UnknownBounty.selector, 7));
        bounty.pay(7);
        vm.expectRevert(abi.encodeWithSelector(OpenBounty.UnknownBounty.selector, 7));
        bounty.refund(7, BEN);
        assertFalse(bounty.refundsOpen(7));
    }
}
