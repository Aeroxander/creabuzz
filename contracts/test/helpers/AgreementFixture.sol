// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {VotingFixture} from "./VotingFixture.sol";
import {MandateCurrency} from "../TreasuryMandate.t.sol";
import {TreasuryMandate, TreasuryMandateFactory} from "../../src/TreasuryMandate.sol";
import {Moloch} from "../../src/majeur/MolochPatched.sol";
import {ClaimStake} from "../../src/ClaimStake.sol";
import {VerifierSet} from "../../src/VerifierSet.sol";

interface ICapabilityMarker {
    function AGREEMENTS_VERSION() external pure returns (uint16);
}

/// @notice A fabricated "mandate" with the right record shape and a caller-chosen mint list: the DAO's provenance
/// gate must refuse it regardless of what it returns.
contract Forge {
    function settleAgreement(bytes32) external pure returns (address[] memory, uint256[] memory) {
        address[] memory parties = new address[](1);
        uint256[] memory portions = new uint256[](1);
        parties[0] = address(0xDA7E);
        portions[0] = 1e18;
        return (parties, portions);
    }

    function agreements(bytes32)
        external
        pure
        returns (
            bytes32,
            address,
            uint128,
            bytes32,
            bytes32,
            uint64,
            uint64,
            uint64,
            bytes32,
            uint8,
            uint32,
            bytes32,
            bytes32
        )
    {
        return (bytes32(0), address(0), 1, bytes32(0), bytes32(0), 0, 0, 0, bytes32(0), 0, 0, bytes32(0), bytes32(0));
    }

    function projects(bytes32) external pure returns (address, uint128, uint128, uint64, bytes32, uint128, uint128) {
        return (address(0), 0, 0, 0, bytes32(0), 0, 0);
    }
}

/// @notice The agreed contribution path (docs/v3-review/AWARD-MECHANICS-SPEC.md): terms proposed by a project's
/// manager, accepted by the exact beneficiary they name (the financial moment: the quantity is reserved against both
/// the work area's allowance and the mandate's Share budget), judged by the mandate's own panel over one submission
/// at a time (with a non-final corrections route), and settled by anyone in exactly the reserved quantity through
/// `Moloch.settleAgreement`. Every test exercises the production path the app and contracts call: the real mandate,
/// panel, claim escrow and mint gate, not test-only helpers.
contract AgreementFixture is VotingFixture {
    // `ICapabilityMarker` and the `Forge` fake mandate (below) are the exact struts the browser/finalizer lanes use
    // to probe whether a deployment carries the agreed-rewards flow and to prove fabricated mandates settle nothing.
    address internal constant DAVE = address(0xDA7E);
    address internal constant STRANGER = address(0x5757);
    address internal constant EVE = address(0xE0E0);
    uint64 internal constant DAY = 1 days;

    TreasuryMandate internal mandate;
    MandateCurrency internal currency;
    ClaimStake internal claims;
    VerifierSet internal panel;
    bytes32 internal constant PROJECT = bytes32("docs");
    bytes32 internal constant CHECK = keccak256("docs accepted");
    uint256 internal constant QUORUM = 2;

    function setUp() public override {
        super.setUp();
        // A real chain's clock (~1.7e9) is far past any window length; a tiny fixture clock would make the
        // "elapsed since release" arithmetic pass vacuously for claims that were never released.
        vm.warp(1_700_000_000);
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
        vm.prank(address(dao));
        mandate = factory.create(
            address(currency),
            1000e18,
            300e18,
            100e18,
            50e18,
            uint64(vm.getBlockTimestamp() + 90 days),
            reviewers,
            QUORUM,
            0,
            address(0)
        );
        claims = mandate.claims();
        panel = mandate.verifiers();
        vm.prank(address(dao));
        mandate.approveProject(PROJECT, BOB, 300e18, 50e18, uint64(vm.getBlockTimestamp() + 30 days), CHECK);
    }

    // ---- fixture helpers -----------------------------------------------------------------------------------------

    /// @dev The agreement id is scoped to the work area and its deliverable slot: one slot is one deliverable.
    function _id(bytes32 slot) internal view returns (bytes32) {
        return keccak256(abi.encode(PROJECT, slot));
    }

    function _deadline() internal view returns (uint64) {
        return uint64(vm.getBlockTimestamp() + 10 days);
    }

    function _proposal(address beneficiary, bytes32 slot, uint128 shares) internal {
        vm.prank(BOB);
        mandate.proposeAgreement(PROJECT, beneficiary, shares, _deadline(), slot, bytes32("policy v1"), bytes32(0));
    }

    function _propose(address beneficiary, bytes32 slot, uint128 shares) internal returns (bytes32) {
        _proposal(beneficiary, slot, shares);
        return _id(slot);
    }

    function _accept(bytes32 agreementId, address[] memory parties, uint16[] memory percentages) internal {
        TreasuryMandate.Agreement memory b = _rec(agreementId);
        vm.prank(b.beneficiary);
        mandate.acceptAgreement(agreementId, parties, percentages);
    }

    function _acceptAlone(bytes32 id) internal {
        _accept(id, new address[](0), new uint16[](0));
    }

    function _proposeAndAccept(address beneficiary, bytes32 slot, uint128 shares) internal returns (bytes32) {
        _proposal(beneficiary, slot, shares);
        bytes32 id = _id(slot);
        _acceptAlone(id);
        return id;
    }

    /// @dev Reads one agreement record as a struct, so tests can use normal member access.
    function _rec(bytes32 agreementId) internal view returns (TreasuryMandate.Agreement memory a) {
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
        ) = mandate.agreements(agreementId);
        a = TreasuryMandate.Agreement(
            projectId,
            beneficiary,
            shares,
            criteriaHash,
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

    /// @dev Bind an attempt: the beneficiary files an open Share-only claim stating the agreed check, the manager binds.
    function _bind(bytes32 agreementId, bytes32 claim) internal {
        vm.startPrank(DAVE);
        claims.submitClaim(claim, 0, 0, keccak256(abi.encode(claim)));
        claims.setCheck(claim, CHECK);
        vm.stopPrank();
        vm.prank(BOB);
        mandate.bindSubmission(agreementId, claim);
    }

    /// @dev Two panel approvals settle the claim into `Approved` (this launch panel is 2-of-3).
    function _approve(bytes32 claim) internal {
        vm.prank(ALICE);
        panel.attest(claim, true);
        vm.prank(CAROL);
        panel.attest(claim, true);
        vm.prank(STRANGER);
        claims.settle(claim);
    }

    function _settle(bytes32 agreementId) internal {
        vm.prank(STRANGER);
        dao.settleAgreement(address(mandate), agreementId);
    }

    function _release(bytes32 agreementId) internal {
        vm.prank(STRANGER);
        mandate.releaseAgreement(agreementId);
    }

    function _state(bytes32 agreementId) internal view returns (TreasuryMandate.AgreementState) {
        return mandate.agreementState(agreementId);
    }

    function _status(bytes32 claim) internal view returns (ClaimStake.Status status) {
        (,,, status) = claims.claimTerms(claim);
    }

    function assertStatus(bytes32 claim, ClaimStake.Status expected) internal view {
        ClaimStake.Status got = _status(claim);
        assertTrue(got == expected, "claim status mismatch");
    }

    function _warpPastWindow() internal {
        vm.warp(vm.getBlockTimestamp() + 7 days);
    }

    // ---- capability detection --------------------------------------------------------------------------------------
}
