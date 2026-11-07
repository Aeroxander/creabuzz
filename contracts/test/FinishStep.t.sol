// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {VotingFixture} from "./helpers/VotingFixture.sol";
import {MandateCurrency} from "./TreasuryMandate.t.sol";
import {BlockingCurrency} from "./MilestoneChallengeBlocklist.t.sol";
import {TreasuryMandate, TreasuryMandateFactory} from "../src/TreasuryMandate.sol";
import {Moloch} from "../src/majeur/MolochPatched.sol";
import {ClaimStake} from "../src/ClaimStake.sol";
import {VerifierSet} from "../src/VerifierSet.sol";

/// @notice The award follows approval without a separate finish step (docs/v3-review/FINISH-STEP-CONTRACT.md).
/// A claim that asks for no money used to need its contributor to call `payout` ("Mark it finished") after the
/// challenge window before the DAO could award it Shares, although that call moves nothing. Now:
///  - anyone may finish a claim that asks for no money once its window has passed (its stake, if any, still goes only
///    to its contributor);
///  - the award itself finishes such a claim when it is still Approved and its window has passed.
/// Everything else holds: no award inside the window, none for a frozen, rejected or unwound claim, none twice, and a
/// claim that asks for money is finished only by its contributor, exactly as before.
contract FinishStepTest is VotingFixture {
    address internal constant DAVE = address(0xDA7E);
    address internal constant STRANGER = address(0x5757);
    bytes32 internal constant CHECK = keccak256("work accepted");
    bytes32 internal constant PROJECT = bytes32("docs");

    TreasuryMandate internal mandate;
    MandateCurrency internal currency;
    ClaimStake internal claims;
    VerifierSet internal panel;

    function setUp() public override {
        super.setUp();
        vm.prank(address(dao));
        dao.setQuorumBps(500);
        currency = new MandateCurrency();
        TreasuryMandateFactory factory = ledger.mandateFactory();
        currency.mint(address(dao), 1000e18);
        vm.prank(address(dao));
        currency.approve(address(factory), 1000e18);
        address[] memory reviewers = new address[](3);
        reviewers[0] = ALICE;
        reviewers[1] = CAROL;
        reviewers[2] = BOB;
        // A budget with both money and Shares, so claims of both kinds can be compared side by side.
        vm.prank(address(dao));
        mandate = factory.create(
            address(currency),
            1000e18,
            300e18,
            100e18,
            50e18,
            uint64(vm.getBlockTimestamp() + 90 days),
            reviewers,
            2,
            0,
            address(0)
        );
        claims = mandate.claims();
        panel = mandate.verifiers();
        vm.prank(address(dao));
        mandate.approveProject(PROJECT, BOB, 300e18, 50e18, uint64(vm.getBlockTimestamp() + 30 days), CHECK);
    }

    /// DAVE files a claim for `amount` (0: Shares only) with `stake`; the manager binds it; two reviewers approve it.
    function _approved(bytes32 claim, uint256 amount, uint256 stake) internal {
        if (stake != 0) {
            currency.mint(DAVE, stake);
            vm.prank(DAVE);
            currency.approve(address(claims), stake);
        }
        vm.startPrank(DAVE);
        claims.submitClaim(claim, amount, stake, keccak256(abi.encode(claim)));
        claims.setCheck(claim, CHECK);
        vm.stopPrank();
        vm.prank(BOB);
        mandate.fundMilestone(PROJECT, claim, DAVE);
        vm.prank(ALICE);
        panel.attest(claim, true);
        vm.prank(CAROL);
        panel.attest(claim, true);
        claims.settle(claim);
    }

    function _status(bytes32 claim) internal view returns (ClaimStake.Status status) {
        (,,, status) = claims.claimTerms(claim);
    }

    function _award(bytes32 claim, uint96 amount) internal {
        vm.prank(address(dao));
        dao.awardContribution(address(mandate), claim, amount, false);
    }

    // ---- the award finishes the claim -----------------------------------------------------------------------------

    /// The production path: the bounded-lane award vote, opened while the claim is still in its window, executes after
    /// the window with no "Mark it finished" in between.
    function test_the_award_vote_needs_no_finish_step() public {
        bytes32 claim = bytes32("write the docs");
        _approved(claim, 0, 0);
        bytes memory data = abi.encodeCall(Moloch.awardContribution, (address(mandate), claim, uint96(15e18), false));
        bytes32 nonce = bytes32("recognise dave");
        vm.prank(ALICE);
        uint256 id = dao.openProposalWithAction(0, address(dao), 0, data, nonce);
        vote(ALICE, id, 20e18);
        vm.warp(vm.getBlockTimestamp() + 7 days);
        dao.queue(id);
        vm.warp(vm.getBlockTimestamp() + 1 days);
        assertEq(uint8(_status(claim)), uint8(ClaimStake.Status.Approved), "nobody marked it finished");

        dao.executeByVotes(0, address(dao), 0, data, nonce);

        assertEq(shares.balanceOf(DAVE), 15e18);
        assertTrue(mandate.contributionAwarded(claim));
        assertEq(uint8(_status(claim)), uint8(ClaimStake.Status.Paid), "the award finished it");
        // Finished once: neither the contributor nor a second award can do it again.
        vm.prank(DAVE);
        vm.expectRevert(abi.encodeWithSelector(ClaimStake.NotOpen.selector, claim));
        claims.payout(claim);
        vm.prank(address(dao));
        vm.expectRevert(TreasuryMandate.InvalidClaim.selector);
        dao.awardContribution(address(mandate), claim, 1, false);
    }

    function test_the_award_returns_a_shares_only_claims_stake_to_its_contributor() public {
        bytes32 claim = bytes32("staked");
        _approved(claim, 0, 5e18);
        vm.warp(vm.getBlockTimestamp() + 7 days);
        _award(claim, 10e18);
        assertEq(currency.balanceOf(DAVE), 5e18, "the stake went back to the contributor, not to the DAO");
        assertEq(currency.balanceOf(address(claims)), 0, "nothing is left in escrow");
    }

    function test_no_award_inside_the_challenge_window() public {
        bytes32 claim = bytes32("early");
        _approved(claim, 0, 0);
        vm.warp(vm.getBlockTimestamp() + 7 days - 1);
        vm.prank(address(dao));
        vm.expectPartialRevert(ClaimStake.InChallengeWindow.selector);
        dao.awardContribution(address(mandate), claim, 10e18, false);
        assertEq(uint8(_status(claim)), uint8(ClaimStake.Status.Approved));
        assertFalse(mandate.contributionAwarded(claim));
        assertEq(shares.balanceOf(DAVE), 0);
    }

    function test_no_award_for_a_frozen_or_unwound_claim() public {
        bytes32 claim = bytes32("questioned");
        _approved(claim, 0, 0);
        vm.prank(address(dao));
        mandate.freezeClaim(claim);
        vm.warp(vm.getBlockTimestamp() + 7 days);
        vm.prank(address(dao));
        vm.expectRevert(TreasuryMandate.InvalidClaim.selector);
        dao.awardContribution(address(mandate), claim, 10e18, false);
        vm.prank(STRANGER);
        vm.expectRevert(abi.encodeWithSelector(ClaimStake.NotOpen.selector, claim));
        claims.payout(claim);

        vm.prank(address(dao));
        mandate.resolveFrozenClaim(claim);
        vm.prank(address(dao));
        vm.expectRevert(TreasuryMandate.InvalidClaim.selector);
        dao.awardContribution(address(mandate), claim, 10e18, false);
        assertEq(shares.balanceOf(DAVE), 0);
    }

    function test_no_award_for_a_rejected_claim() public {
        bytes32 claim = bytes32("rejected");
        vm.startPrank(DAVE);
        claims.submitClaim(claim, 0, 0, keccak256("rejected"));
        claims.setCheck(claim, CHECK);
        vm.stopPrank();
        vm.prank(BOB);
        mandate.fundMilestone(PROJECT, claim, DAVE);
        vm.prank(ALICE);
        panel.attest(claim, false);
        vm.prank(CAROL);
        panel.attest(claim, false);
        claims.settle(claim);
        vm.warp(vm.getBlockTimestamp() + 7 days);
        vm.prank(address(dao));
        vm.expectRevert(TreasuryMandate.InvalidClaim.selector);
        dao.awardContribution(address(mandate), claim, 10e18, false);
    }

    /// A claim that asks for money is unchanged: only its contributor finishes it (and takes the money), and the DAO
    /// cannot award it before they have.
    function test_a_money_claim_still_waits_for_its_contributor() public {
        bytes32 claim = bytes32("paid work");
        _approved(claim, 100e18, 0);
        vm.warp(vm.getBlockTimestamp() + 7 days);
        vm.prank(address(dao));
        vm.expectRevert(TreasuryMandate.InvalidClaim.selector);
        dao.awardContribution(address(mandate), claim, 10e18, false);
        vm.prank(STRANGER);
        vm.expectRevert(ClaimStake.NotContributor.selector);
        claims.payout(claim);
        assertEq(uint8(_status(claim)), uint8(ClaimStake.Status.Approved));

        vm.prank(DAVE);
        claims.payout(claim);
        assertEq(currency.balanceOf(DAVE), 100e18);
        _award(claim, 10e18);
        assertEq(shares.balanceOf(DAVE), 10e18);
    }

    // ---- anyone may finish a claim that asks for no money ---------------------------------------------------------

    function test_anyone_may_finish_a_shares_only_claim_once_its_window_has_passed() public {
        bytes32 claim = bytes32("by anyone");
        _approved(claim, 0, 5e18);
        vm.prank(STRANGER);
        vm.expectPartialRevert(ClaimStake.InChallengeWindow.selector);
        claims.payout(claim);
        vm.warp(vm.getBlockTimestamp() + 7 days);
        vm.prank(STRANGER);
        claims.payout(claim);
        assertEq(uint8(_status(claim)), uint8(ClaimStake.Status.Paid));
        assertEq(currency.balanceOf(DAVE), 5e18, "the stake went to the contributor");
        assertEq(currency.balanceOf(STRANGER), 0, "and nothing to whoever pressed the button");
        // An award after that works as it always did.
        _award(claim, 10e18);
        assertEq(shares.balanceOf(DAVE), 10e18);
    }
}

/// @notice Finishing someone else's claim must not be held up by the currency refusing to pay that someone: the stake
/// waits for them in `owed`, as it does when a claim lapses or is unwound.
contract FinishStepBlockedTest is VotingFixture {
    address internal constant DAVE = address(0xDA7E);

    function test_a_blocked_contributors_stake_waits_and_the_claim_still_finishes() public {
        BlockingCurrency cash = new BlockingCurrency();
        VerifierSet panel = new VerifierSet(address(this), 1);
        ClaimStake stake = new ClaimStake(panel, address(this), address(cash));
        panel.setClaimStake(address(stake));
        panel.acceptVerifier(ALICE);
        stake.setWindows(30 days, 7 days);
        cash.mint(DAVE, 5e18);
        vm.prank(DAVE);
        cash.approve(address(stake), type(uint256).max);
        vm.prank(DAVE);
        stake.submitClaim(bytes32("c"), 0, 5e18, keccak256("e"));
        vm.prank(ALICE);
        panel.attest(bytes32("c"), true);
        stake.settle(bytes32("c"));
        vm.warp(vm.getBlockTimestamp() + 7 days);
        cash.setBlocked(DAVE, true);

        stake.payout(bytes32("c")); // must not revert

        (,,, ClaimStake.Status status) = stake.claimTerms(bytes32("c"));
        assertEq(uint8(status), uint8(ClaimStake.Status.Paid));
        assertEq(stake.owed(DAVE), 5e18);
        cash.setBlocked(DAVE, false);
        vm.prank(DAVE);
        stake.withdrawOwed();
        assertEq(cash.balanceOf(DAVE), 5e18);
    }
}
