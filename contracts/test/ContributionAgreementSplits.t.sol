// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {AgreementFixture} from "./helpers/AgreementFixture.sol";
import {MandateCurrency} from "./TreasuryMandate.t.sol";
import {TreasuryMandate, TreasuryMandateFactory} from "../src/TreasuryMandate.sol";
import {Moloch} from "../src/majeur/MolochPatched.sol";
import {ClaimStake} from "../src/ClaimStake.sol";
import {VerifierSet} from "../src/VerifierSet.sol";

/// @notice The split side of the agreed contribution path (docs/v3-review/AWARD-MECHANICS-SPEC.md): exact total
/// with a deterministic residual to the first party, whole-unit parts, codec checks, and nobody weighing in on
/// work that pays them — running on the same fixture family and the same production calls.
contract ContributionAgreementSplitsTest is AgreementFixture {
    function test_a_declared_coauthor_cannot_review_a_claim_that_pays_them() public {
        // the coauthor may even be an active reviewer of the panel: they only step back from THIS claim
        address[] memory parties = new address[](2);
        parties[0] = DAVE;
        parties[1] = ALICE;
        uint16[] memory percentages = new uint16[](2);
        percentages[0] = 5000;
        percentages[1] = 5000;
        bytes32 id = _proposeSplitLocked(DAVE, bytes32("slot"), 30e18, parties, percentages);
        _accept(id, parties, percentages);
        // the contributor files the attempt body; the corrections request cannot land before the manager binds
        vm.startPrank(DAVE);
        claims.submitClaim("work", 0, 0, keccak256("work"));
        claims.setCheck("work", CHECK);
        vm.stopPrank();
        // bound-review readiness: pre-bind, the corrections request cannot even land (the check is not locked yet)
        vm.prank(ALICE);
        vm.expectPartialRevert(VerifierSet.NotReadyForReview.selector);
        panel.requestCorrections("work", keccak256("why"));
        vm.prank(BOB);
        mandate.bindSubmission(id, "work");
        vm.prank(ALICE);
        vm.expectPartialRevert(VerifierSet.PaidPartyCannotJudge.selector);
        panel.attest("work", true);
        // quorum is still reachable through the non-paying reviewers, and the terms-bound settlement pays both
        vm.prank(CAROL);
        panel.attest("work", true);
        vm.prank(BOB);
        panel.attest("work", true);
        vm.prank(STRANGER);
        claims.settle("work");
        _warpPastWindow();
        uint256 aliceStart = shares.balanceOf(ALICE); // the fixture's own standing shares are not an award
        _settle(id);
        assertEq(shares.balanceOf(DAVE), 15e18);
        assertEq(shares.balanceOf(ALICE) - aliceStart, 15e18, "the declared coauthor's exact part");
    }

    // ---- splits: committed in the proposal, confirmed at acceptance, exact in total (P1, P2) ----------------------

    /// @dev A split proposal commits `keccak256(abi.encode(parties, percentages))`; acceptance must confirm it.
    function _proposeSplitLocked(
        address beneficiary,
        bytes32 slot,
        uint128 shares,
        address[] memory parties,
        uint16[] memory percentages
    ) internal returns (bytes32 id) {
        vm.prank(BOB);
        mandate.proposeAgreement(
            PROJECT,
            beneficiary,
            shares,
            _deadline(),
            slot,
            bytes32("policy v1"),
            keccak256(abi.encode(parties, percentages))
        );
        id = _id(slot);
    }

    function test_a_split_settles_the_exact_total_with_a_deterministic_residual() public {
        // 101 raw units, 33/67: floors alone would pay 100 — the residual goes to the first party, so the total
        // paid is exactly the reserved 101. Nothing is burnt, nothing re-weighted.
        address[] memory parties = new address[](2);
        parties[0] = DAVE;
        parties[1] = EVE;
        uint16[] memory percentages = new uint16[](2);
        percentages[0] = 3300;
        percentages[1] = 6700;
        bytes32 id = _proposeSplitLocked(DAVE, bytes32("slot"), 101, parties, percentages);
        _accept(id, parties, percentages);
        _bind(id, "work");
        _approve("work");
        _warpPastWindow();
        vm.prank(STRANGER);
        dao.settleAgreement(address(mandate), id);
        assertEq(shares.balanceOf(DAVE), 34, "floor 33 plus the one-unit residual");
        assertEq(shares.balanceOf(EVE), 67);
        assertEq(shares.balanceOf(DAVE) + shares.balanceOf(EVE), 101, "exact total, every time");
        assertEq(mandate.mandateSharesAwarded(), 101);
    }

    function test_acceptance_must_confirm_the_proposals_committed_split() public {
        (address[] memory committed, uint16[] memory halves_) = (_pair(), _halves());
        bytes32 id = _proposeSplitLocked(DAVE, bytes32("slot"), 30e18, committed, halves_);
        // a DIFFERENT declaration cannot be confirmed: the terms were signed at proposal, never at acceptance
        address[] memory diverged = new address[](2);
        diverged[0] = DAVE;
        diverged[1] = CAROL;
        vm.prank(DAVE);
        vm.expectRevert(TreasuryMandate.BadSplit.selector);
        mandate.acceptAgreement(id, diverged, halves_);
        // a no-split confirmation over a split commitment is refused too
        vm.prank(DAVE);
        vm.expectRevert(TreasuryMandate.BadSplit.selector);
        mandate.acceptAgreement(id, new address[](0), new uint16[](0));
        // and a split offer over no-split terms is refused the other way
        _propose(DAVE, bytes32("plain"), 5e18);
        vm.prank(DAVE);
        vm.expectRevert(TreasuryMandate.BadSplit.selector);
        mandate.acceptAgreement(_id(bytes32("plain")), committed, halves_);
        // confirming the committed declaration is the acceptance that reserves
        _accept(id, committed, halves_);
        assertEq(mandate.sharesReservedTotal(), 30e18);
    }

    function test_a_declared_split_must_name_real_distinct_non_manager_parties_whose_shares_sum_to_the_whole() public {
        // every malformed declaration is committed by its own proposal and refused at the same acceptance,
        // so the codec rules fire where they must and nothing is ever reserved
        (address[] memory parties, uint16[] memory halves_) = (_pair(), _halves());
        uint16[] memory notTheWhole = _halves();
        notTheWhole[1] = 4001; // 10001 of 10000
        _refuseCommitted("a", parties, notTheWhole);
        uint16[] memory zeroShare = _halves();
        zeroShare[0] = 0; // a zero share promises nothing to nobody
        zeroShare[1] = 10000;
        _refuseCommitted("b", parties, zeroShare);
        address[] memory manager = _pair();
        manager[1] = BOB; // the manager may not be paid from the beneficiary's reservation
        _refuseCommitted("c", manager, halves_);
        address[] memory twice = _pair();
        twice[1] = DAVE; // the same person twice is not two people
        _refuseCommitted("d", twice, halves_);
        address[] memory nobody = _pair();
        nobody[0] = address(0);
        _refuseCommitted("e", nobody, halves_);
        address[] memory many = new address[](5);
        many[0] = DAVE;
        for (uint256 i = 1; i < 5; ++i) {
            many[i] = address(uint160(0xB000 + i));
        }
        _refuseCommitted("f", many, _quarters(5)); // a settlement record can name at most four parties
        uint16[] memory short2 = new uint16[](1);
        short2[0] = 10000;
        _refuseCommitted("g", parties, short2); // mismatched tuple lengths
        assertEq(mandate.sharesReservedTotal(), 0, "no codec breach ever reserved anything");
    }

    function test_the_split_total_is_exact_even_when_the_quantity_is_odd() public {
        // 10_001 raw units, 50/50: floors 5000 + 5000 and the residual to the first party — exact 10_001, once.
        (address[] memory parties, uint16[] memory percentages) = (_pair(), _halves());
        bytes32 id = _proposeSplitLocked(DAVE, bytes32("odd"), 10_001, parties, percentages);
        _accept(id, parties, percentages);
        _bind(id, "work");
        _approve("work");
        _warpPastWindow();
        _settle(id);
        assertEq(shares.balanceOf(DAVE) + shares.balanceOf(EVE), 10_001, "exact total");
        assertEq(shares.balanceOf(EVE), 5000);
        assertEq(shares.balanceOf(DAVE), 5001);
    }

    function test_a_split_part_that_cannot_carry_a_whole_unit_is_refused() public {
        // extremes: a quantity that cannot carry every declared part at one whole unit is refused at acceptance
        (address[] memory parties, uint16[] memory halves_) = (_pair(), _halves());
        {
            bytes32 id = _proposeSplitLocked(DAVE, bytes32("tiny"), 1, parties, halves_);
            vm.prank(DAVE); // 1 x 5000/10000 < 1 whole unit per part: nothing promiseable in whole Shares
            vm.expectRevert(TreasuryMandate.BadSplit.selector);
            mandate.acceptAgreement(id, parties, halves_);
            assertEq(mandate.sharesReservedTotal(), 0);
        }
        // an indivisible quantity with a tiny residual still accepts exactly (the first party carries the residual)
        uint128 odd = 1 ether + 101;
        bytes32 wide = _proposeSplitLocked(DAVE, bytes32("oddGrain"), odd, parties, halves_);
        _accept(wide, parties, halves_);
        assertEq(mandate.sharesReservedTotal(), uint256(odd));
    }

    function _pair() private pure returns (address[] memory parties) {
        parties = new address[](2);
        parties[0] = DAVE;
        parties[1] = EVE;
    }

    function _halves() private pure returns (uint16[] memory percentages) {
        percentages = new uint16[](2);
        percentages[0] = 5000;
        percentages[1] = 5000;
    }

    function _quarters(uint256 count) internal pure returns (uint16[] memory percentages) {
        percentages = new uint16[](count);
        for (uint256 i; i < count; ++i) {
            percentages[i] = uint16(10000 / count);
        }
    }

    function _refuseCommitted(bytes32 slot, address[] memory parties, uint16[] memory percentages) internal {
        vm.prank(BOB);
        mandate.proposeAgreement(
            PROJECT, DAVE, 100e18, _deadline(), slot, bytes32("policy v1"), keccak256(abi.encode(parties, percentages))
        );
        vm.prank(DAVE);
        vm.expectRevert(TreasuryMandate.BadSplit.selector);
        mandate.acceptAgreement(_id(slot), parties, percentages);
    }
}
