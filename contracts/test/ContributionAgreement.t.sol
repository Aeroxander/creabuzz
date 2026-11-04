// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {AgreementFixture, ICapabilityMarker} from "./helpers/AgreementFixture.sol";
import {Forge as FabricatedMandate} from "./helpers/AgreementFixture.sol";
import {MandateCurrency} from "./TreasuryMandate.t.sol";
import {TreasuryMandate, TreasuryMandateFactory} from "../src/TreasuryMandate.sol";
import {Moloch} from "../src/majeur/MolochPatched.sol";
import {ClaimStake} from "../src/ClaimStake.sol";
import {VerifierSet} from "../src/VerifierSet.sol";

/// @notice The agreed contribution path (docs/v3-review/AWARD-MECHANICS-SPEC.md): terms proposed by a project's
/// manager, accepted by the exact beneficiary they name (the financial moment: the quantity is reserved against both
/// the work area's allowance and the mandate's Share budget), judged by the mandate's own panel over one submission
/// at a time (corrections as an explicit non-final route), and settled by anyone in exactly the reserved quantity
/// through `Moloch.settleAgreement`. Every test exercises the production path the app and contracts call.
contract ContributionAgreementTest is AgreementFixture {
    // ---- authority: who proposes, who accepts, who settles ---------------------------------------------------------

    function test_only_the_project_manager_may_propose_terms() public {
        vm.expectRevert(TreasuryMandate.InvalidProject.selector);
        vm.prank(CAROL);
        mandate.proposeAgreement(PROJECT, DAVE, 10e18, _deadline(), bytes32("slot"), bytes32("policy"), bytes32(0));
    }

    /// The frozen offchain adapters (`packages/creaton-core/src/launchpad`, `scripts/agreement-finalizer`) probe the
    /// capability marker by its exact signature `AGREEMENTS_VERSION()`. The selector is pinned, so a rename can never
    /// silently turn a supporting mandate into an "unknown" deployment.
    function test_the_capability_marker_is_the_frozen_adapters_signature() public view {
        assertEq(TreasuryMandate.AGREEMENTS_VERSION.selector, bytes4(0xf964bc9e), "frozen adapter selector");
        assertEq(ICapabilityMarker(address(mandate)).AGREEMENTS_VERSION(), 1, "this mandate supports version 1");
    }

    function test_the_manager_cannot_reward_themselves() public {
        vm.prank(BOB);
        vm.expectRevert(TreasuryMandate.InvalidProject.selector);
        mandate.proposeAgreement(PROJECT, BOB, 10e18, _deadline(), bytes32("slot"), bytes32("policy"), bytes32(0));
    }

    function test_only_the_exact_beneficiary_may_accept_their_own_agreement() public {
        bytes32 id = _propose(DAVE, bytes32("slot"), 10e18);
        vm.prank(STRANGER);
        vm.expectRevert(abi.encodeWithSelector(TreasuryMandate.UnknownAgreement.selector, id));
        mandate.acceptAgreement(id, new address[](0), new uint16[](0));
        // a stranger's accept left nothing reserved
        assertEq(_rec(id).acceptedAt, 0);
        vm.prank(DAVE);
        mandate.acceptAgreement(id, new address[](0), new uint16[](0));
        assertEq(_rec(id).acceptedAt, vm.getBlockTimestamp());
    }

    /// The delivery step disappears for the beneficiary: once their agreement is accepted and reserved, they file
    /// and bind their own submission (exact check, zero money) with no fresh handoff — the manager may still assist;
    /// neither of them can route anyone else's delivery through the agreement, and no third party can bind.
    function test_the_beneficiary_binds_their_own_delivery_without_a_manager_handoff() public {
        bytes32 id = _proposeAndAccept(DAVE, bytes32("slot"), 10e18);
        // DAVE files and binds the delivery himself, unassisted
        vm.startPrank(DAVE);
        claims.submitClaim("self", 0, 0, keccak256("self"));
        claims.setCheck("self", CHECK);
        mandate.bindSubmission(id, "self");
        vm.stopPrank();
        assertEq(_rec(id).attempts, 1);
        assertEq(uint8(_state(id)), uint8(TreasuryMandate.AgreementState.SUBMITTED));
        // nobody else — not even a panel reviewer — can bind a following attempt into the same agreement
        vm.prank(STRANGER);
        vm.expectRevert(TreasuryMandate.Unauthorized.selector);
        mandate.bindSubmission(id, "stranger-claim");
        vm.prank(CAROL);
        vm.expectRevert(TreasuryMandate.Unauthorized.selector);
        mandate.bindSubmission(id, "reviewer-claim");
        // the wide-open delivery path still ends at the same gated settlement exactly once
        _approve("self");
        _warpPastWindow();
        _settle(id);
        assertEq(shares.balanceOf(DAVE), 10e18);
        assertEq(mandate.mandateSharesAwarded(), 10e18);
    }

    /// The manager keeps the assisting role: whether the manager or the beneficiary binds, the attempt must be the
    /// BENEFICIARY's own claim — nobody can direct someone else's delivery through their agreement.
    function test_a_manager_binding_names_the_beneficiary_not_their_own_delivery() public {
        bytes32 id = _proposeAndAccept(DAVE, bytes32("slot"), 10e18);
        // manager files a claim in their own name and binds it: refused (the claim does not belong to the terms)
        vm.startPrank(BOB);
        claims.submitClaim("manager", 0, 0, keccak256("manager"));
        claims.setCheck("manager", CHECK);
        vm.stopPrank();
        vm.prank(BOB);
        vm.expectRevert(TreasuryMandate.InvalidClaim.selector);
        mandate.bindSubmission(id, "manager");
        assertEq(mandate.agreementOfClaim("manager"), bytes32(0));
        assertEq(_rec(id).attempts, 0);
        // and the unbound claim cannot be awarded at all through any door
        vm.startPrank(address(dao));
        vm.expectRevert(TreasuryMandate.InvalidClaim.selector);
        dao.awardContribution(address(mandate), "manager", 1, false);
        vm.stopPrank();
    }

    function test_only_the_dao_may_enter_the_terms_bound_settler() public {
        bytes32 id = _proposeAndAccept(DAVE, bytes32("slot"), 10e18);
        _bind(id, bytes32("write the docs"));
        _approve(bytes32("write the docs"));
        _warpPastWindow();
        // The record alone mints nothing: the mandate's entry is the DAO's one mint authority.
        vm.prank(STRANGER);
        vm.expectRevert(TreasuryMandate.Unauthorized.selector);
        mandate.settleAgreement(id);
        assertEq(shares.balanceOf(DAVE), 0);
        assertEq(uint8(_state(id)), uint8(TreasuryMandate.AgreementState.READY_TO_SETTLE));
    }

    function test_a_mandate_the_dao_never_approved_settles_nothing() public {
        bytes32 id = _proposeAndAccept(DAVE, bytes32("slot"), 10e18);
        _bind(id, bytes32("write the docs"));
        _approve(bytes32("write the docs"));
        _warpPastWindow();
        FabricatedMandate fake = new FabricatedMandate();
        vm.prank(STRANGER);
        vm.expectRevert(Moloch.NotOk.selector);
        dao.settleAgreement(address(fake), id);
        vm.prank(STRANGER);
        vm.expectRevert(Moloch.NotOk.selector);
        dao.settleAgreement(address(0), id);
        // and the real agreement is untouched by both
        assertEq(mandate.sharesReservedTotal(), 10e18);
        assertEq(shares.balanceOf(DAVE), 0);
    }

    // ---- reservation: atomic against both ceilings ------------------------------------------------------------------

    /// The exact quantity is Shares, and the chain stores supply in uint96: a promised quantity beyond
    /// `type(uint96).max` is intrinsically unmintable in a whole piece and is refused AT PROPOSAL time, before
    /// any effort can land on a promise the chain can never keep. Nothing is recorded: no slot spent, no terms,
    /// no reservation anywhere. The boundary itself is legal — a mandate whose ceiling allows it agrees to and
    /// reserves exactly `type(uint96).max`; settling such a quantity is a chain-mint question, not a terms one.
    function test_a_quantity_the_chain_cannot_mint_is_refused_before_any_effort() public {
        uint128 beyond = uint128(type(uint96).max) + 1;
        vm.prank(BOB);
        vm.expectRevert(TreasuryMandate.InvalidProject.selector);
        mandate.proposeAgreement(
            PROJECT, DAVE, beyond, _deadline(), bytes32("ghost quantity"), bytes32("policy"), bytes32(0)
        );
        TreasuryMandate.Agreement memory ghost = _rec(_id(bytes32("ghost quantity")));
        assertTrue(ghost.beneficiary == address(0) && ghost.shares == 0 && ghost.projectId == bytes32(0));

        // a Shares-only mandate whose ceiling carries the boundary quantity
        TreasuryMandateFactory factory = ledger.mandateFactory();
        address[] memory reviewers = new address[](3);
        reviewers[0] = ALICE;
        reviewers[1] = CAROL;
        reviewers[2] = BOB;
        vm.prank(address(dao));
        TreasuryMandate big = factory.create(
            address(currency),
            0,
            0,
            type(uint96).max,
            type(uint96).max,
            uint64(vm.getBlockTimestamp() + 90 days),
            reviewers,
            2,
            0,
            address(0)
        );
        vm.prank(address(dao));
        big.approveProject(bytes32("big"), BOB, 0, type(uint96).max, uint64(vm.getBlockTimestamp() + 30 days), CHECK);
        vm.prank(BOB);
        big.proposeAgreement(
            bytes32("big"), DAVE, type(uint96).max, _deadline(), bytes32("slot"), bytes32("policy"), bytes32(0)
        );
        bytes32 id = _idOn(big, bytes32("big"), bytes32("slot"));
        vm.prank(DAVE);
        big.acceptAgreement(id, new address[](0), new uint16[](0));
        TreasuryMandate.Agreement memory b = _recOn(big, id);
        assertEq(b.shares, type(uint96).max, "the boundary itself is legal and stored whole");
        assertTrue(b.acceptedAt != 0, "accepted and reserved");
        assertEq(big.sharesReservedTotal(), type(uint96).max);
        assertEq(big.sharesReserved(bytes32("big")), type(uint96).max);
    }

    function _idOn(TreasuryMandate, bytes32 projectId, bytes32 slot) internal pure returns (bytes32) {
        return keccak256(abi.encode(projectId, slot));
    }

    function _recOn(TreasuryMandate which, bytes32 agreementId)
        internal
        view
        returns (TreasuryMandate.Agreement memory a)
    {
        (
            bytes32 projectId,
            address beneficiary,
            uint128 shares,
            bytes32 criteriaHash,
            bytes32 policyRef,
            uint64 acceptedAt,
            uint64 reviewPeriod,
            uint64 workDeadline,
            uint64 revisionDeadline,
            bytes32 claimId,
            uint8 terminalKind,
            uint32 attempts,
            bytes32 splitHash
        ) = which.agreements(agreementId);
        a = TreasuryMandate.Agreement(
            projectId,
            beneficiary,
            shares,
            bytes32(0), // criteriaHash is proven by events; the rest drives the assertions
            policyRef,
            acceptedAt,
            reviewPeriod,
            workDeadline,
            revisionDeadline,
            claimId,
            terminalKind,
            attempts,
            splitHash
        );
    }

    function test_concurrent_acceptances_cannot_overcommit_the_work_area() public {
        bytes32 first = _proposeAndAccept(DAVE, bytes32("first"), 30e18);
        assertEq(mandate.sharesReserved(PROJECT), 30e18);
        assertEq(mandate.sharesReservedTotal(), 30e18);
        _proposal(EVE, bytes32("second"), 25e18);
        bytes32 second = _id(bytes32("second"));
        vm.prank(EVE);
        // 30 + 25 over the 50e18 the project was given: the budget answers at acceptance, not after delivery.
        vm.expectRevert(TreasuryMandate.BudgetExceeded.selector);
        mandate.acceptAgreement(second, new address[](0), new uint16[](0));
        assertEq(mandate.sharesReservedTotal(), 30e18);
        // a second agreement inside the remaining area still accepts
        vm.prank(BOB);
        mandate.proposeAgreement(PROJECT, EVE, 20e18, _deadline(), bytes32("third"), bytes32("policy v1"), bytes32(0));
        vm.prank(EVE);
        mandate.acceptAgreement(_id(bytes32("third")), new address[](0), new uint16[](0));
        assertEq(mandate.sharesReservedTotal(), 50e18);
        TreasuryMandate.Agreement memory unchanged = _rec(first);
        assertEq(unchanged.shares, 30e18, "the first reservation stands unharmed");
        assertEq(unchanged.terminalKind, 0);
    }

    function test_acceptance_fires_after_the_deadline_or_a_closed_mandate() public {
        bytes32 id = _propose(DAVE, bytes32("slot"), 10e18);
        vm.prank(DAVE);
        // Deadline passed: the invitation is dead, and reserving for it would be a phantom commitment.
        vm.warp(_deadline() + 1);
        vm.expectRevert(TreasuryMandate.InvalidProject.selector);
        mandate.acceptAgreement(id, new address[](0), new uint16[](0));
        // A closed mandate takes neither a new acceptance nor a new proposal: nothing new can be reserved on it.
        bytes32 fresh = _propose(DAVE, bytes32("slot2"), 10e18);
        vm.prank(address(dao));
        mandate.close();
        vm.prank(DAVE);
        vm.expectRevert(TreasuryMandate.InvalidProject.selector);
        mandate.acceptAgreement(fresh, new address[](0), new uint16[](0));
        vm.prank(BOB);
        vm.expectRevert(TreasuryMandate.InvalidProject.selector);
        mandate.proposeAgreement(PROJECT, DAVE, 10e18, _deadline(), bytes32("slot3"), bytes32("policy"), bytes32(0));
        assertEq(mandate.sharesReservedTotal(), 0, "a dead or closed invitation reserves nothing");
    }

    /// Delivery can only ride terms that were actually agreed and are still live: a proposal nobody accepted holds no
    /// reservation, and a released agreement is terminal — neither can bind work.
    function test_an_unaccepted_or_terminal_agreement_cannot_bind_a_delivery() public {
        bytes32 id = _propose(DAVE, bytes32("slot"), 10e18);
        vm.startPrank(DAVE);
        claims.submitClaim("early", 0, 0, keccak256("early"));
        claims.setCheck("early", CHECK);
        vm.stopPrank();
        vm.prank(DAVE);
        vm.expectRevert(TreasuryMandate.Unauthorized.selector);
        mandate.bindSubmission(id, "early");
        assertEq(mandate.agreementOfClaim("early"), bytes32(0));
        // once accepted, a released (terminal) agreement is equally closed to new deliveries
        _acceptAlone(id);
        vm.prank(DAVE);
        mandate.releaseAgreement(id);
        vm.prank(DAVE);
        vm.expectRevert(TreasuryMandate.Unauthorized.selector);
        mandate.bindSubmission(id, "early");
        assertEq(mandate.agreementOfClaim("early"), bytes32(0));
    }

    /// The first attempt must land inside the agreed work window: a delivery after it is not the agreed work any more.
    function test_a_first_attempt_after_the_work_deadline_is_refused() public {
        bytes32 id = _proposeAndAccept(DAVE, bytes32("slot"), 10e18);
        vm.startPrank(DAVE);
        claims.submitClaim("late", 0, 0, keccak256("late"));
        claims.setCheck("late", CHECK);
        vm.stopPrank();
        vm.warp(_deadline() + 1);
        vm.prank(DAVE);
        vm.expectRevert(TreasuryMandate.NotSubmittable.selector);
        mandate.bindSubmission(id, "late");
        assertEq(mandate.agreementOfClaim("late"), bytes32(0));
    }

    function test_reservations_and_legacy_awards_share_one_cast_ceiling() public {
        bytes32 id = _proposeAndAccept(DAVE, bytes32("slot"), 30e18);
        // The legacy discretionary lane on the same project is bounded by the SAME headroom: 25 over what is left.
        vm.startPrank(DAVE);
        claims.submitClaim(bytes32("legacy"), 0, 0, keccak256("legacy"));
        claims.setCheck(bytes32("legacy"), CHECK);
        vm.stopPrank();
        vm.prank(BOB);
        mandate.fundMilestone(PROJECT, bytes32("legacy"), DAVE);
        vm.prank(ALICE);
        panel.attest(bytes32("legacy"), true);
        vm.prank(CAROL);
        panel.attest(bytes32("legacy"), true);
        vm.prank(STRANGER);
        claims.settle(bytes32("legacy"));
        _warpPastWindow();
        vm.startPrank(address(dao));
        vm.expectRevert(TreasuryMandate.BudgetExceeded.selector);
        dao.awardContribution(address(mandate), bytes32("legacy"), 25e18, false);
        // inside what is left (20e18) it works as it always did
        dao.awardContribution(address(mandate), bytes32("legacy"), 20e18, false);
        vm.stopPrank();
        assertEq(shares.balanceOf(DAVE), 20e18);
        assertEq(mandate.mandateSharesAwarded(), 20e18, "both lanes count toward the same lifetime authority");
        // and the agreed reservation still holds its own slice
        assertEq(_rec(id).shares, 30e18);
        assertEq(mandate.sharesReservedTotal(), 30e18);
    }

    // ---- the discretionary lane cannot eat an agreed delivery (B2) ----------------------------------------------------

    function test_the_discretionary_award_cannot_consume_an_agreement_attempt_whole_or_in_part() public {
        bytes32 id = _proposeAndAccept(DAVE, bytes32("slot"), 10e18);
        _bind(id, bytes32("write the docs"));
        _approve(bytes32("write the docs"));
        _warpPastWindow();
        // A 1-wei legacy vote cannot consume a promised 10-Share claim: settlement stays whole or nothing.
        vm.startPrank(address(dao));
        vm.expectRevert(TreasuryMandate.InvalidClaim.selector);
        dao.awardContribution(address(mandate), bytes32("write the docs"), 1, false);
        vm.expectRevert(TreasuryMandate.InvalidClaim.selector);
        dao.awardContribution(address(mandate), bytes32("write the docs"), 10e18, false);
        vm.stopPrank();
        assertEq(shares.balanceOf(DAVE), 0);
        assertEq(uint8(_state(id)), uint8(TreasuryMandate.AgreementState.READY_TO_SETTLE));
        // and the terms-bound finalizer still pays the full exact quantity
        _settle(id);
        assertEq(shares.balanceOf(DAVE), 10e18);
        assertEq(mandate.mandateSharesAwarded(), 10e18);
    }

    function test_the_discretionary_award_cannot_consume_a_superseded_attempt_either() public {
        bytes32 id = _proposeAndAccept(DAVE, bytes32("slot"), 10e18);
        _bind(id, bytes32("v1"));
        // corrections route: formal request first, then the replace
        vm.prank(ALICE);
        panel.requestCorrections(bytes32("v1"), keccak256("redo"));
        // the replace retires the old attempt while the new one is bound in the same transaction
        _bind(id, "v2");
        assertTrue(_status(bytes32("v1")) == ClaimStake.Status.Retired);
        // whatever the old claim reaches, the discretionary door stays shut for it
        vm.startPrank(address(dao));
        vm.expectRevert(TreasuryMandate.InvalidClaim.selector);
        dao.awardContribution(address(mandate), bytes32("v1"), 1, false);
        vm.stopPrank();
        // and the agreement itself only settles its CURRENT attempt
        assertEq(_rec(id).claimId, bytes32("v2"));
        assertEq(shares.balanceOf(DAVE), 0);
        assertEq(mandate.mandateSharesAwarded(), 0);
    }

    // ---- terms are fixed: no re-bidding, no altered recipient, reward, criteria or deadline after acceptance ----------

    function test_the_terms_cannot_be_rewritten_after_acceptance() public {
        bytes32 id = _proposeAndAccept(DAVE, bytes32("slot"), 30e18);
        // Same (work area, slot) is one stable identity; new terms for the same work take a fresh slot.
        vm.prank(BOB);
        vm.expectRevert(TreasuryMandate.InvalidProject.selector);
        mandate.proposeAgreement(PROJECT, DAVE, 5e18, _deadline(), bytes32("slot"), bytes32("policy v2"), bytes32(0));
        TreasuryMandate.Agreement memory a = _rec(id); // fixed forever
        assertEq(a.beneficiary, DAVE);
        assertEq(a.shares, 30e18);
        assertEq(a.criteriaHash, CHECK, "the criteria is the project's own check");
        assertEq(a.revisionDeadline, a.workDeadline + 14 days, "the correction window is part of the terms");
    }

    // ---- the deliverable slot is assignable once, and multi-reward needs explicit slots (P8) --------------------------

    function test_one_deliverable_slot_belongs_to_one_agreement() public {
        bytes32 id = _propose(DAVE, bytes32("fix login"), 10e18);
        // the same slot may not be re-offered to somebody else, unaccepted or not
        vm.prank(BOB);
        vm.expectRevert(TreasuryMandate.InvalidProject.selector);
        mandate.proposeAgreement(PROJECT, EVE, 10e18, _deadline(), bytes32("fix login"), bytes32("policy"), bytes32(0));
        _acceptAlone(id);
        // nor re-offered once agreed
        vm.prank(BOB);
        vm.expectRevert(TreasuryMandate.InvalidProject.selector);
        mandate.proposeAgreement(PROJECT, EVE, 10e18, _deadline(), bytes32("fix login"), bytes32("policy"), bytes32(0));
        // an explicitly separate deliverable slot is the way several rewards exist beside one another
        _proposeAndAccept(DAVE, bytes32("fix logout"), 5e18);
        assertEq(mandate.sharesReservedTotal(), 15e18);
    }

    // ---- cancellation and expiry --------------------------------------------------------------------------------------

    function test_cancellation_pre_submission_releases_and_tombstones_the_slot() public {
        bytes32 id = _proposeAndAccept(DAVE, bytes32("slot"), 30e18);
        vm.prank(DAVE);
        mandate.releaseAgreement(id);
        assertEq(mandate.sharesReservedTotal(), 0, "the reservation was released, never re-authorised");
        assertEq(mandate.sharesReserved(PROJECT), 0);
        assertEq(shares.balanceOf(DAVE), 0);
        assertEq(uint8(_state(id)), uint8(TreasuryMandate.AgreementState.CANCELLED));
        // the released slot is spent for good
        vm.prank(BOB);
        vm.expectRevert(TreasuryMandate.InvalidProject.selector);
        mandate.proposeAgreement(PROJECT, EVE, 30e18, _deadline(), bytes32("slot"), bytes32("policy"), bytes32(0));
        // a different slot still reserves
        bytes32 fresh = _proposeAndAccept(DAVE, bytes32("slot2"), 30e18);
        assertEq(mandate.sharesReservedTotal(), 30e18);
        // and the tombstone cannot be resurrected
        vm.prank(DAVE);
        vm.expectRevert(abi.encodeWithSelector(TreasuryMandate.UnknownAgreement.selector, id));
        mandate.acceptAgreement(id, new address[](0), new uint16[](0));
        fresh;
    }

    function test_a_cancelled_draft_tombstones_unreserved_terms_without_subtracting() public {
        _propose(DAVE, bytes32("slot"), 10e18);
        bytes32 id = _id(bytes32("slot"));
        vm.prank(DAVE);
        mandate.releaseAgreement(id);
        // nothing was ever reserved: a cancelled draft must not subtract a phantom quantity
        assertEq(mandate.sharesReservedTotal(), 0);
        assertEq(mandate.sharesReserved(PROJECT), 0);
        // the cancelled draft keeps its record and its slot is spent
        assertEq(uint8(_state(id)), uint8(TreasuryMandate.AgreementState.CANCELLED));
        assertEq(_rec(id).beneficiary, DAVE);
        vm.prank(BOB);
        vm.expectRevert(TreasuryMandate.InvalidProject.selector);
        mandate.proposeAgreement(PROJECT, DAVE, 10e18, _deadline(), bytes32("slot"), bytes32("policy"), bytes32(0));
        // and cancelling twice is refused
        vm.prank(DAVE);
        vm.expectRevert(abi.encodeWithSelector(TreasuryMandate.UnknownAgreement.selector, id));
        mandate.releaseAgreement(id);
    }

    function test_cancellation_after_a_submission_goes_to_the_dispute_path_instead() public {
        bytes32 id = _proposeAndAccept(DAVE, bytes32("slot"), 10e18);
        _bind(id, bytes32("write the docs"));
        vm.prank(DAVE);
        vm.expectRevert(TreasuryMandate.InvalidClaim.selector);
        mandate.releaseAgreement(id);
        vm.prank(BOB);
        vm.expectRevert(TreasuryMandate.InvalidClaim.selector);
        mandate.releaseAgreement(id);
        assertEq(mandate.sharesReservedTotal(), 10e18);
    }

    function test_expiry_past_the_deadline_releases_a_reservation() public {
        bytes32 id = _proposeAndAccept(DAVE, bytes32("slot"), 10e18);
        vm.warp(_deadline() + 1);
        // anyone: unearned reservations release only with nothing due
        _release(id);
        assertEq(mandate.sharesReservedTotal(), 0);
        vm.prank(BOB);
        mandate.proposeAgreement(PROJECT, EVE, 45e18, _deadline(), bytes32("slot2"), bytes32("policy v1"), bytes32(0));
        vm.prank(EVE);
        mandate.acceptAgreement(_id(bytes32("slot2")), new address[](0), new uint16[](0));
        assertEq(mandate.sharesReservedTotal(), 45e18);
    }

    // ---- the corrections route (B1): reviewer-requested changes rebind without a final negative verdict ---------------

    function test_a_correction_request_reopens_a_new_attempt_and_objections_are_never_a_route() public {
        bytes32 id = _proposeAndAccept(DAVE, bytes32("slot"), 10e18);
        _bind(id, "v1");
        // a reviewer votes against the attempt: an objection is an irreversible rejection vote feeding no quorum
        // on its own and does NOT open the corrections route on its own, let alone force a negative verdict
        vm.prank(ALICE);
        panel.attest("v1", false);
        assertEq(uint8(_state(id)), uint8(TreasuryMandate.AgreementState.IN_REVIEW));
        vm.prank(BOB);
        vm.expectRevert(TreasuryMandate.NotSubmittable.selector);
        mandate.bindSubmission(id, "v2");
        // a formal corrections request is the non-final route: view names it, no rejection was ever forced
        vm.prank(CAROL);
        panel.requestCorrections("v1", keccak256("tighten the figures"));
        assertEq(uint8(_state(id)), uint8(TreasuryMandate.AgreementState.CORRECTIONS));
        _bind(id, "v2"); // the beneficiary files the corrected attempt, the manager binds it
        assertEq(_rec(id).attempts, 2);
        assertStatus("v1", ClaimStake.Status.Retired);
        assertEq(panel.approvalCount("v2"), 0, "approvals never carry to a revision");
        // the retired attempt is unpayable from every remaining door
        vm.startPrank(address(dao));
        vm.expectRevert(TreasuryMandate.InvalidClaim.selector);
        dao.awardContribution(address(mandate), "v1", 1, false);
        vm.stopPrank();
        // the fresh attempt is the only one the agreement settles, exactly once
        _approve("v2");
        _warpPastWindow();
        _settle(id);
        assertEq(shares.balanceOf(DAVE), 10e18);
        assertEq(mandate.mandateSharesAwarded(), 10e18, "one delivery, one reward, once");
    }

    function test_a_live_review_without_a_change_request_cannot_be_swapped() public {
        bytes32 id = _proposeAndAccept(DAVE, bytes32("slot"), 10e18);
        _bind(id, "v1");
        vm.prank(ALICE);
        panel.attest("v1", true);
        vm.prank(BOB);
        vm.expectRevert(TreasuryMandate.NotSubmittable.selector);
        mandate.bindSubmission(id, "v2");
        // even a split verdict below quorum is deadlocked, still no swap: nobody cancels the work silently
        vm.prank(CAROL);
        panel.attest("v1", false);
        vm.prank(BOB);
        vm.expectRevert(TreasuryMandate.NotSubmittable.selector);
        mandate.bindSubmission(id, "v2");
        // the panel resolves through its own counters: an objection quorum carries into the escrow and becomes
        // a final rejection — the documented way onward (never an argument-free silent cancel)
        vm.prank(BOB);
        panel.attest("v1", false);
        vm.prank(STRANGER);
        claims.settle("v1");
        assertTrue(_status("v1") == ClaimStake.Status.Rejected);
        // and a rejected attempt is terminal: it can be replaced, but only a fresh attempt with fresh approvals
        _bind(id, "v2");
        assertEq(_rec(id).attempts, 2);
        assertEq(panel.approvalCount("v2"), 0, "approvals never carry");
    }

    function test_a_correction_rebind_may_not_run_a_frozen_swap_nor_outlive_the_revision_window() public {
        bytes32 id = _proposeAndAccept(DAVE, bytes32("slot"), 10e18);
        _bind(id, "v1");
        // a corrections request exists; a frozen (disputed) attempt still cannot be swapped on it
        vm.prank(ALICE);
        panel.requestCorrections("v1", keccak256("redo"));
        vm.prank(address(dao));
        mandate.freezeClaim("v1");
        vm.prank(BOB);
        vm.expectRevert(TreasuryMandate.NotSubmittable.selector);
        mandate.bindSubmission(id, "v2");
        // an unfreeze winds it up to a terminal unapproved attempt, which is replaceable without a retirement
        vm.prank(address(dao));
        mandate.resolveFrozenClaim("v1");
        assertStatus("v1", ClaimStake.Status.Recovered);
        _bind(id, "v2");
        assertTrue(_status("v1") == ClaimStake.Status.Recovered, "a resolved attempt is untouched, never retired");
        // past the revision window (the agreed term), no more swaps: the last attempt resolves its own way
        vm.prank(ALICE);
        panel.attest("v2", false);
        vm.prank(CAROL);
        panel.requestCorrections("v2", keccak256("redo"));
        TreasuryMandate.Agreement memory a = _rec(id);
        vm.warp(a.revisionDeadline + 1);
        vm.prank(BOB);
        vm.expectRevert(TreasuryMandate.NotSubmittable.selector);
        mandate.bindSubmission(id, "v3");
        // and that last attempt still resolves through its own review window: expiry releases, nothing is stranded
        vm.warp(a.revisionDeadline + a.reviewPeriod + 1);
        vm.prank(STRANGER);
        claims.expire("v2");
        _release(id);
        assertEq(mandate.sharesReservedTotal(), 0);
    }

    /// The review timing is chain state: bind pins the attempt's lapse to the accepted period, so an unreviewed
    /// attempt expires by itself (stake back, unearned reservation released by explicit action), a frozen claim is
    /// never accepted silently, and an approved claim freezes its verdict (no expiry move after it).
    function test_the_stated_review_period_bound_the_review_and_releases_only_on_terminal() public {
        bytes32 id = _proposeAndAccept(DAVE, bytes32("slot"), 10e18);
        TreasuryMandate.Agreement memory a = _rec(id);
        assertEq(a.reviewPeriod, 7 days, "the candidate period, disclosed before any effort arrives");
        _bind(id, "work");
        (,,,,,, uint64 claimExpiry,) = claims.claims("work");
        assertEq(claimExpiry, vm.getBlockTimestamp() + 7 days, "the review clock is pinned on the claim itself");
        // the claim cannot sit on the work longer than the pinned window: unreviewed, it expires by itself
        vm.warp(claimExpiry + 1);
        vm.prank(STRANGER);
        claims.expire("work");
        assertStatus("work", ClaimStake.Status.Expired);
        _release(id);
        assertEq(mandate.sharesReservedTotal(), 0, "the unearned reservation released by explicit action");
        // a claim with a verdict can never have its expiry moved, in either direction
        bytes32 id2 = _proposeAndAccept(DAVE, bytes32("slot2"), 5e18);
        _bind(id2, "verdict");
        _approve("verdict");
        (,,,,,, uint64 pinned,) = claims.claims("verdict");
        vm.prank(address(mandate));
        vm.expectPartialRevert(ClaimStake.ClaimClosed.selector);
        claims.setExpiry("verdict", uint64(vm.getBlockTimestamp()) + 30 days);
        (,,,,,, uint64 afterFail,) = claims.claims("verdict");
        assertEq(afterFail, pinned, "the release time of a decided attempt is frozen");
        // a frozen claim is not accepted by anything and stays disputed until governance resolves it
        vm.prank(address(dao));
        mandate.freezeClaim("verdict");
        vm.warp(pinned + 7 days);
        vm.prank(STRANGER);
        vm.expectRevert(TreasuryMandate.InvalidClaim.selector);
        dao.settleAgreement(address(mandate), id2);
        assertEq(uint8(_state(id2)), uint8(TreasuryMandate.AgreementState.DISPUTED));
        assertEq(mandate.sharesReservedTotal(), 5e18, "frozen entitlements are preserved, not swept");
    }

    function test_superseded_attempts_recover_their_stake_and_earn_nothing() public {
        bytes32 id = _proposeAndAccept(DAVE, bytes32("slot"), 10e18);
        // a staked attempt: the contributor answered with their own collateral
        currency.mint(DAVE, 5e18);
        vm.prank(DAVE);
        currency.approve(address(claims), 5e18);
        vm.startPrank(DAVE);
        claims.submitClaim("stake", 0, 5e18, keccak256("stake"));
        claims.setCheck("stake", CHECK);
        vm.stopPrank();
        vm.prank(BOB);
        mandate.bindSubmission(id, "stake");
        assertEq(currency.balanceOf(address(claims)), 5e18, "the escrow holds the stake while the attempt lives");
        vm.prank(ALICE);
        panel.attest("stake", false); // a change request would never be enough: correction requires formal ask
        vm.prank(BOB);
        vm.expectRevert(TreasuryMandate.NotSubmittable.selector);
        mandate.bindSubmission(id, "v2");
        vm.prank(CAROL);
        panel.requestCorrections("stake", keccak256("redo the hard part"));
        assertStatus("stake", ClaimStake.Status.Open);
        assertEq(panel.objectionCount("stake"), 1, "a change request adds no objection vote");
        // the corrections route retires the replaced attempt in the same transaction: terminal, stake straight
        // back unslashed (owed to them when the currency refuses), no verdict by anyone else, never an award
        _bind(id, "v2");
        assertEq(_rec(id).claimId, "v2");
        assertStatus("stake", ClaimStake.Status.Retired);
        assertEq(currency.balanceOf(DAVE), 5e18);
        assertEq(currency.balanceOf(address(claims)), 0);
        // and no superseded attempt can be consumed by another reward door, and it stays unreviewable
        vm.startPrank(address(dao));
        vm.expectRevert(TreasuryMandate.InvalidClaim.selector);
        dao.awardContribution(address(mandate), "stake", 1, false);
        vm.stopPrank();
        vm.prank(DAVE);
        vm.expectPartialRevert(ClaimStake.AlreadySettled.selector);
        claims.settle("stake"); // the escrow's own settle refuses a retired claim: no verdict after a replacement
    }

    // ---- review: the panel binds the verdict; nobody judges work that pays them (P2) -----------------------------------

    function test_the_beneficiary_cannot_review_their_own_work() public {
        bytes32 id = _proposeAndAccept(DAVE, bytes32("slot"), 10e18);
        _bind(id, "work");
        vm.prank(DAVE);
        vm.expectPartialRevert(VerifierSet.ClaimantCannotAttest.selector);
        panel.attest("work", true);
    }

    function test_excluded_recipients_are_exactly_the_declared_ones() public {
        bytes32 id = _proposeAndAccept(DAVE, bytes32("slot"), 10e18);
        _bind(id, "work");
        // the plain legacy claim (paid work, no agreed split) keeps its old review flow entirely
        vm.startPrank(DAVE);
        claims.submitClaim("legacy", 0, 0, keccak256("legacy"));
        claims.setCheck("legacy", CHECK);
        vm.stopPrank();
        vm.prank(BOB);
        mandate.fundMilestone(PROJECT, "legacy", DAVE);
        vm.prank(ALICE);
        panel.attest("legacy", true);
        assertEq(panel.approvalCount("legacy"), 1);
        // and the agreement's own claim excludes exactly its declared recipients, no one wider
        assertEq(panel.excludedFromReview("work", 0), DAVE, "only the beneficiary for a plain agreement");
    }

    // ---- settlement: terms-bound, permissionless, exactly once, and truthful states (P4) ------------------------------

    function test_no_settlement_inside_the_challenge_window() public {
        bytes32 id = _proposeAndAccept(DAVE, bytes32("slot"), 10e18);
        _bind(id, "work");
        _approve("work");
        vm.warp(vm.getBlockTimestamp() + 7 days - 1);
        vm.prank(STRANGER);
        vm.expectPartialRevert(ClaimStake.InChallengeWindow.selector);
        dao.settleAgreement(address(mandate), id);
        assertEq(shares.balanceOf(DAVE), 0);
        assertEq(mandate.sharesReservedTotal(), 10e18, "the reservation stands; only an earned settle consumes it");
        // the truthful in-window state
        assertEq(uint8(_state(id)), uint8(TreasuryMandate.AgreementState.CHALLENGE_WINDOW));
    }

    function test_anyone_settles_on_the_exact_terms_after_the_window() public {
        bytes32 id = _proposeAndAccept(DAVE, bytes32("slot"), 30e18);
        _bind(id, "work");
        _approve("work");
        _warpPastWindow();
        vm.prank(STRANGER);
        // nothing is minted to whoever pressed the button — the terms alone decide
        dao.settleAgreement(address(mandate), id);
        assertEq(shares.balanceOf(DAVE), 30e18, "the exact reserved quantity");
        assertEq(shares.balanceOf(STRANGER), 0);
        assertEq(uint8(_state(id)), uint8(TreasuryMandate.AgreementState.SETTLED));
        assertEq(_rec(id).terminalKind, 1);
        // consumed exactly once: no second settlement, no re-accept, no legacy award of the same delivery
        vm.prank(STRANGER);
        vm.expectRevert(abi.encodeWithSelector(TreasuryMandate.UnknownAgreement.selector, id));
        dao.settleAgreement(address(mandate), id);
        vm.startPrank(address(dao));
        vm.expectRevert(TreasuryMandate.InvalidClaim.selector);
        dao.awardContribution(address(mandate), "work", 1, false);
        vm.stopPrank();
        assertEq(shares.balanceOf(DAVE), 30e18);
        assertEq(mandate.sharesReservedTotal(), 0);
        assertEq(mandate.mandateSharesAwarded(), 30e18);
    }

    function test_settlement_of_a_claim_without_bound_submission_is_refused() public {
        bytes32 id = _proposeAndAccept(DAVE, bytes32("slot"), 10e18);
        // the mandate's entry is the DAO's own: a direct call is the wrong door
        vm.prank(STRANGER);
        vm.expectRevert(TreasuryMandate.Unauthorized.selector);
        mandate.settleAgreement(id);
    }

    function test_a_frozen_claim_freezes_settlement_until_it_is_resolved() public {
        bytes32 id = _proposeAndAccept(DAVE, bytes32("slot"), 10e18);
        _bind(id, "work");
        _approve("work");
        vm.prank(address(dao));
        mandate.freezeClaim("work");
        _warpPastWindow();
        vm.prank(STRANGER);
        vm.expectRevert(TreasuryMandate.InvalidClaim.selector);
        dao.settleAgreement(address(mandate), id);
        // the record keeps its frozen state and its reservation
        assertEq(uint8(_state(id)), uint8(TreasuryMandate.AgreementState.DISPUTED));
        assertEq(mandate.sharesReservedTotal(), 10e18);
        // unwound into a terminal state instead: the reward for an unproven work is off, and what is reserved
        // releases (explicit dispute resolution, not closure)
        vm.prank(address(dao));
        mandate.resolveFrozenClaim("work");
        vm.prank(STRANGER);
        vm.expectRevert(TreasuryMandate.InvalidClaim.selector);
        dao.settleAgreement(address(mandate), id);
        _release(id);
        assertEq(mandate.sharesReservedTotal(), 0);
    }

    function test_closure_never_releases_frozen_or_inflight_submissions() public {
        bytes32 id = _proposeAndAccept(DAVE, bytes32("slot"), 10e18);
        _bind(id, "work");
        vm.prank(address(dao));
        mandate.freezeClaim("work");
        vm.prank(address(dao));
        mandate.close();
        // closure releases nothing in flight, and a disputed claim stays disputed on a closed mandate
        vm.prank(STRANGER);
        vm.expectRevert(TreasuryMandate.InvalidClaim.selector);
        mandate.releaseAgreement(id);
        assertEq(mandate.sharesReservedTotal(), 10e18);
        // explicit dispute resolution puts the attempt in a terminal unapproved state, and the release runs then
        vm.prank(address(dao));
        mandate.resolveFrozenClaim("work");
        _release(id);
        assertEq(mandate.sharesReservedTotal(), 0);
    }

    function test_an_unearned_reservation_is_released_when_the_mandate_closes() public {
        bytes32 live = _proposeAndAccept(DAVE, bytes32("slot"), 10e18);
        _bind(live, "work");
        bytes32 idle = _proposeAndAccept(DAVE, bytes32("slot2"), 5e18);
        vm.prank(address(dao));
        mandate.close();
        // closure stops new bindings: an accepted, unsubmitted agreement can no longer take a delivery
        vm.startPrank(DAVE);
        claims.submitClaim("late", 0, 0, keccak256("late"));
        claims.setCheck("late", CHECK);
        vm.stopPrank();
        vm.prank(DAVE);
        vm.expectRevert(TreasuryMandate.Unauthorized.selector);
        mandate.bindSubmission(idle, "late");
        // closure stops new bindings; what the panel has not yet judged stays in flight and is NOT swept silently
        vm.prank(STRANGER);
        vm.expectRevert(TreasuryMandate.InvalidClaim.selector);
        mandate.releaseAgreement(live);
        // an unsubmitted reservation may be swept by anyone once the mandate has closed
        vm.prank(STRANGER);
        mandate.releaseAgreement(idle);
        assertEq(mandate.sharesReservedTotal(), 10e18);
        // the in-flight attempt still resolves through the panel's own window, and only a final state releases it
        vm.warp(vm.getBlockTimestamp() + 30 days + 1);
        vm.prank(STRANGER);
        claims.expire("work");
        _release(live);
        assertEq(mandate.sharesReservedTotal(), 0);
    }

    function test_an_earned_agreement_still_settles_after_the_mandate_closes() public {
        bytes32 id = _proposeAndAccept(DAVE, bytes32("slot"), 10e18);
        _bind(id, "work");
        _approve("work");
        // closure stops new commitments, never an entitlement the panel already earned: the record still settles.
        vm.prank(address(dao));
        mandate.close();
        _warpPastWindow();
        _settle(id);
        assertEq(shares.balanceOf(DAVE), 10e18, "the earned reward survives closure");
        assertEq(mandate.sharesReservedTotal(), 0);
        assertEq(mandate.mandateSharesAwarded(), 10e18);
    }

    function test_agreement_state_follows_the_reviewed_chain_truthfully() public {
        bytes32 id = _proposeAndAccept(DAVE, bytes32("slot"), 10e18);
        _bind(id, "work");
        assertEq(uint8(_state(id)), uint8(TreasuryMandate.AgreementState.SUBMITTED));
        vm.prank(ALICE);
        panel.attest("work", true);
        assertEq(uint8(_state(id)), uint8(TreasuryMandate.AgreementState.IN_REVIEW));
        vm.prank(CAROL);
        panel.attest("work", true);
        // the quorum stands on the record; the escrow only waits to be told
        assertEq(uint8(_state(id)), uint8(TreasuryMandate.AgreementState.ACCEPTED));
        vm.prank(STRANGER);
        claims.settle("work");
        assertEq(uint8(_state(id)), uint8(TreasuryMandate.AgreementState.CHALLENGE_WINDOW));
        vm.warp(vm.getBlockTimestamp() + 7 days);
        // the window is over: the truthful state is ready-to-settle, not wrapped back into either of the earlier two
        assertEq(uint8(_state(id)), uint8(TreasuryMandate.AgreementState.READY_TO_SETTLE));
        _settle(id);
        assertEq(uint8(_state(id)), uint8(TreasuryMandate.AgreementState.SETTLED));
    }

    /// @dev On a real chain block.timestamp is ~1.7e9, far past the challenge window length. An unreviewed claim
    /// (never released, so releasedAt is 0) must still read as the review chain says, not READY_TO_SETTLE.
    function test_agreement_state_reads_the_review_chain_at_a_realistic_timestamp() public {
        bytes32 id = _proposeAndAccept(DAVE, bytes32("slot"), 10e18);
        _bind(id, "work");
        assertEq(uint8(_state(id)), uint8(TreasuryMandate.AgreementState.SUBMITTED), "bound, unreviewed");
        vm.prank(ALICE);
        panel.attest("work", true);
        assertEq(uint8(_state(id)), uint8(TreasuryMandate.AgreementState.IN_REVIEW), "one approval");
        vm.prank(CAROL);
        panel.attest("work", true);
        assertEq(uint8(_state(id)), uint8(TreasuryMandate.AgreementState.ACCEPTED), "quorum on the record");
        vm.prank(STRANGER);
        claims.settle("work");
        assertEq(uint8(_state(id)), uint8(TreasuryMandate.AgreementState.CHALLENGE_WINDOW), "released, window open");
        _warpPastWindow();
        assertEq(uint8(_state(id)), uint8(TreasuryMandate.AgreementState.READY_TO_SETTLE), "window over");
        _settle(id);
        assertEq(uint8(_state(id)), uint8(TreasuryMandate.AgreementState.SETTLED));
    }

    /// @dev Same realistic clock, corrections route: a formal corrections request reads CORRECTIONS.
    function test_agreement_state_reads_corrections_at_a_realistic_timestamp() public {
        bytes32 id = _proposeAndAccept(DAVE, bytes32("slot"), 10e18);
        _bind(id, "work");
        assertEq(uint8(_state(id)), uint8(TreasuryMandate.AgreementState.SUBMITTED));
        vm.prank(ALICE);
        panel.requestCorrections("work", keccak256("tighten the figures"));
        assertEq(uint8(_state(id)), uint8(TreasuryMandate.AgreementState.CORRECTIONS));
    }

    function test_a_claim_finished_by_anyone_reads_ready_to_settle_and_still_settles() public {
        bytes32 id = _proposeAndAccept(DAVE, bytes32("slot"), 10e18);
        _bind(id, "work");
        _approve("work");
        vm.warp(vm.getBlockTimestamp() + 7 days);
        // somebody (not the settlement) finishes the claim first; the agreement is untouched and remains settleable
        vm.prank(STRANGER);
        claims.payout("work");
        assertStatus("work", ClaimStake.Status.Paid);
        assertEq(uint8(_state(id)), uint8(TreasuryMandate.AgreementState.READY_TO_SETTLE), "paid, not unawarded");
        _settle(id);
        assertEq(shares.balanceOf(DAVE), 10e18);
        assertEq(uint8(_state(id)), uint8(TreasuryMandate.AgreementState.SETTLED));
    }

    // ---- the paid milestone path and the legacy lane remain as they were -------------------------------------------

    function test_agreement_claims_cannot_run_the_paid_milestone_path() public {
        bytes32 id = _proposeAndAccept(DAVE, bytes32("slot"), 10e18);
        // a claim that asks for money belongs to the paid path, not the agreed one
        vm.startPrank(DAVE);
        claims.submitClaim("money", 100e18, 0, keccak256("money"));
        claims.setCheck("money", CHECK);
        vm.stopPrank();
        vm.prank(BOB);
        vm.expectRevert(TreasuryMandate.InvalidClaim.selector);
        mandate.bindSubmission(id, "money");
        // and its own currency reservation, unbound, still works as ever
        vm.prank(BOB);
        mandate.fundMilestone(PROJECT, "money", DAVE);
        assertEq(mandate.sharesReservedTotal(), 10e18);
    }

    function test_the_legacy_lane_is_unchanged_when_no_agreements_exist() public {
        // exhaust nothing: the normal discretionary flow runs its old way
        vm.startPrank(DAVE);
        claims.submitClaim("old work", 0, 0, keccak256("old"));
        claims.setCheck("old work", CHECK);
        vm.stopPrank();
        vm.prank(BOB);
        mandate.fundMilestone(PROJECT, "old work", DAVE);
        vm.prank(ALICE);
        panel.attest("old work", true);
        vm.prank(CAROL);
        panel.attest("old work", true);
        vm.prank(STRANGER);
        claims.settle("old work");
        _warpPastWindow();
        vm.prank(address(dao));
        dao.awardContribution(address(mandate), "old work", 12e18, false);
        assertEq(shares.balanceOf(DAVE), 12e18);
        assertEq(mandate.mandateSharesAwarded(), 12e18);
        assertEq(mandate.sharesReservedTotal(), 0);
    }

    // ---- pre-bind attestation capacity (P7) -------------------------------------------------------------------------

    function test_attestation_before_the_claim_exists_is_refused_and_never_counts() public {
        // a reviewer marks a claim id before any delivery exists: refused outright, so no capacity is burnt
        vm.prank(ALICE);
        vm.expectPartialRevert(VerifierSet.UnknownPanelClaim.selector);
        panel.attest("ghost", true);
        // pre-bound readiness on: even an honest early vote after submit but before bind is refused, and it does
        // not spend the reviewer's one-shot — the reviewers' weight only lands after the mandate's bind has locked
        // the check and installed the payment exclusions, all in one transaction
        vm.startPrank(DAVE);
        claims.submitClaim("work", 0, 0, keccak256("work"));
        claims.setCheck("work", CHECK);
        vm.stopPrank();
        vm.prank(ALICE);
        vm.expectPartialRevert(VerifierSet.NotReadyForReview.selector);
        panel.attest("work", true);
        _proposal(DAVE, "slot", 10e18);
        bytes32 id = _id("slot");
        _acceptAlone(id);
        vm.prank(BOB);
        mandate.bindSubmission(id, "work");
        // same reviewer, first honest vote: the ask is available normally after bind
        vm.prank(ALICE);
        panel.attest("work", true);
        vm.prank(CAROL);
        panel.attest("work", true);
        vm.prank(STRANGER);
        claims.settle("work");
        assertStatus("work", ClaimStake.Status.Approved); // post-bind votes count toward quorum
    }

    // ---- real fuzz: solvency and exactness over random lifecycles (parent validation requirement) -----------------

    /// @dev A seeded fuzz over whole lifecycles, each on its OWN unique slot and claim id (no tombstoned-slot reuse,
    /// no shared identities). Each run picks how the panel goes and whether corrections fire; the running model is
    /// asserted at every step: outstanding == Σ live reservations, the area ceiling binds both lanes, the mandate
    /// lifetime budget binds both lanes, and every settlement pays off EXACTLY the quantity its record reserved.
    /// The drive shortens the claim TTL windows so every run stays inside the fixture project's 30-day lifetime;
    /// those windows are drive timings, not policy.
    function testFuzz_lifecycle_solvency_and_exactness_over_unique_lifecycles(uint256 seed) public {
        vm.prank(address(mandate));
        claims.setWindows(1 days, 12 hours); // drive timings, not policy
        uint256 flows = 1 + (seed % 3); // 1..3 lifecycles per run: all-expiry stays inside the fixture window
        uint128 grant = 1e18;
        uint256 outstanding;
        for (uint256 step; step < flows; ++step) {
            bytes32 slot = keccak256(abi.encode(seed, "flow", step)); // unique identity, never reused
            uint256 roll = uint256(keccak256(abi.encode(seed, "roll", step)));
            bool withCorrections = roll % 3 == 0;
            bool settles = !withCorrections || roll % 2 == 0;
            vm.prank(BOB);
            mandate.proposeAgreement(
                PROJECT, DAVE, grant, uint64(vm.getBlockTimestamp() + 10 days), slot, bytes32("p"), bytes32(0)
            );
            bytes32 id = keccak256(abi.encode(PROJECT, slot));
            vm.prank(DAVE);
            mandate.acceptAgreement(id, new address[](0), new uint16[](0));
            outstanding += grant;
            assertEq(mandate.sharesReservedTotal(), outstanding, "accept reserved exactly its slice");
            (,,,,, uint128 shareBudget, uint128 awardedAtAccept) = mandate.projects(PROJECT);
            assertLe(uint256(mandate.sharesReserved(PROJECT)) + awardedAtAccept, shareBudget, "area ceiling holds");
            // bind: the review clock pins onto the claim itself
            bytes32 claim = keccak256(abi.encode(seed, "claim", step));
            vm.startPrank(DAVE);
            claims.submitClaim(claim, 0, 0, keccak256(abi.encode(claim, "e")));
            claims.setCheck(claim, CHECK);
            vm.stopPrank();
            vm.prank(BOB);
            mandate.bindSubmission(id, claim);
            if (settles) {
                _approve(claim);
                vm.warp(vm.getBlockTimestamp() + 12 hours + 1);
                uint256 before = shares.balanceOf(DAVE);
                _settle(id);
                assertEq(shares.balanceOf(DAVE) - before, grant, "exact reserved quantity, once");
                outstanding -= grant;
            } else if (withCorrections) {
                vm.prank(CAROL);
                panel.requestCorrections(claim, keccak256(abi.encode(seed, "reason", step)));
                bytes32 newer = keccak256(abi.encode(seed, "claim", step, "r"));
                vm.startPrank(DAVE);
                claims.submitClaim(newer, 0, 0, keccak256(abi.encode(newer, "e")));
                claims.setCheck(newer, CHECK);
                vm.stopPrank();
                vm.prank(BOB);
                mandate.bindSubmission(id, newer);
                assertTrue(_status(claim) == ClaimStake.Status.Retired, "superseded attempt retired, unslashed");
                // the replacement waits on its own review clock; when nobody weighs in, it expires and releases
                vm.warp(vm.getBlockTimestamp() + 7 days + 1);
                vm.prank(STRANGER);
                claims.expire(newer);
                _release(id);
                outstanding -= grant;
            } else {
                vm.warp(vm.getBlockTimestamp() + 7 days + 1);
                vm.prank(STRANGER);
                claims.expire(claim);
                _release(id);
                outstanding -= grant;
            }
            assertEq(mandate.sharesReservedTotal(), outstanding, "every release resolved its slice exactly");
            assertLe(
                uint256(mandate.mandateSharesAwarded()) + mandate.sharesReservedTotal(),
                100e18,
                "the mandate lifetime ceiling binds both lanes"
            );
        }
    }
}
