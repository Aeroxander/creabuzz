// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {VotingFixture} from "./helpers/VotingFixture.sol";
import {MandateCurrency} from "./TreasuryMandate.t.sol";
import {TreasuryMandate, TreasuryMandateFactory} from "../src/TreasuryMandate.sol";
import {MilestoneLock} from "../src/MilestoneLock.sol";
import {ClaimStake} from "../src/ClaimStake.sol";
import {VerifierSet} from "../src/VerifierSet.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice A currency that keeps 1% of every transfer, to show a short bond is refused instead of recorded.
contract FeeCurrency is ERC20 {
    constructor() ERC20("Fee cash", "FEE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = value / 100;
            super._update(from, address(0xFEE), fee);
            value -= fee;
        }
        super._update(from, to, value);
    }
}

/// @notice A reviewer's stake is a real bond (in the claim's own currency unless the vote names another token): it must
/// be posted before they may attest, it comes back only after a delay, and the DAO can take it. And a team member
/// whose Shares a milestone lock holds cannot be on the panel at all.
contract ReviewerBondTest is VotingFixture {
    address internal constant DAVE = address(0xDA7E);
    address internal constant ERIN = address(0xE41);
    bytes32 internal constant CHECK_ONE = keccak256("alpha shipped");
    bytes32 internal constant PROJECT = bytes32("founders");
    uint128 internal constant BOND = 50e18;

    MilestoneLock internal lock;
    MandateCurrency internal currency;
    TreasuryMandate internal mandate;
    VerifierSet internal panel;

    function _reviewers() internal pure returns (address[] memory reviewers) {
        reviewers = new address[](3);
        reviewers[0] = CAROL;
        reviewers[1] = DAVE;
        reviewers[2] = ERIN;
    }

    function setUp() public override {
        super.setUp();
        // ALICE is the team: her Shares are held back by a milestone lock.
        address[] memory who = new address[](1);
        who[0] = ALICE;
        uint256[] memory totals = new uint256[](1);
        totals[0] = 100e18;
        bytes32[] memory checks = new bytes32[](1);
        checks[0] = CHECK_ONE;
        uint16[] memory bps = new uint16[](1);
        bps[0] = 5000;
        lock = new MilestoneLock(address(dao), who, totals, checks, bps);
        vm.prank(address(dao));
        shares.setLockGuard(address(lock));

        currency = new MandateCurrency();
        mandate = _create(address(currency), _reviewers(), BOND);
        panel = mandate.verifiers();
        vm.prank(address(dao));
        mandate.approveProject(PROJECT, BOB, 0, 2, uint64(vm.getBlockTimestamp() + 300 days), CHECK_ONE);
    }

    /// The DAO makes the mandate, its bond (if any) in the claim currency itself (the factory is read first: a prank
    /// covers only the next call).
    function _create(address cash, address[] memory reviewers, uint128 bond) internal returns (TreasuryMandate made) {
        made = _createWithBondToken(cash, bond == 0 ? address(0) : cash, reviewers, bond);
    }

    function _createWithBondToken(address cash, address bondToken, address[] memory reviewers, uint128 bond)
        internal
        returns (TreasuryMandate made)
    {
        TreasuryMandateFactory factory = ledger.mandateFactory();
        vm.prank(address(dao));
        made = factory.create(
            cash, 0, 0, 10, 10, uint64(vm.getBlockTimestamp() + 365 days), reviewers, 2, bond, bondToken
        );
    }

    function _bond(address reviewer, uint256 amount) internal {
        currency.mint(reviewer, amount);
        vm.startPrank(reviewer);
        currency.approve(address(panel), amount);
        panel.bond(amount);
        vm.stopPrank();
    }

    /// A claim for the first milestone, filed by the team member and bound to the project by its manager.
    function _claim(bytes32 claim) internal {
        ClaimStake claims = mandate.claims();
        vm.startPrank(ALICE);
        claims.submitClaim(claim, 0, 0, keccak256(abi.encode(claim)));
        claims.setCheck(claim, CHECK_ONE);
        vm.stopPrank();
        vm.prank(BOB);
        mandate.fundMilestone(PROJECT, claim, ALICE);
    }

    // ---- the panel -----------------------------------------------------------------------------

    function test_a_team_member_cannot_sit_on_the_panel_that_judges_the_milestones() public {
        address[] memory withTeam = new address[](3);
        withTeam[0] = CAROL;
        withTeam[1] = ALICE; // her Shares are held back by the lock
        withTeam[2] = ERIN;
        TreasuryMandateFactory factory = ledger.mandateFactory();
        vm.prank(address(dao));
        vm.expectRevert(TreasuryMandate.InvalidMandate.selector);
        factory.create(
            address(currency), 0, 0, 10, 10, uint64(vm.getBlockTimestamp() + 30 days), withTeam, 2, 0, address(0)
        );
        // Outsiders are fine.
        _create(address(currency), _reviewers(), 0);
    }

    // ---- posting the bond ----------------------------------------------------------------------

    function test_a_reviewer_cannot_attest_until_the_bond_is_posted() public {
        _claim("a");
        vm.prank(CAROL);
        vm.expectRevert(abi.encodeWithSelector(VerifierSet.BondTooLow.selector, 0, uint256(BOND)));
        panel.attest("a", true);

        _bond(CAROL, BOND);
        vm.prank(CAROL);
        panel.attest("a", true);
        assertEq(panel.approvalCount("a"), 1);
        assertEq(currency.balanceOf(address(panel)), BOND);
    }

    function test_a_stranger_cannot_bond() public {
        currency.mint(address(0xBEEF), BOND);
        vm.startPrank(address(0xBEEF));
        currency.approve(address(panel), BOND);
        vm.expectRevert(abi.encodeWithSelector(VerifierSet.NotAVerifier.selector, address(0xBEEF)));
        panel.bond(BOND);
        vm.stopPrank();
    }

    function test_a_bond_that_arrives_short_is_refused_not_recorded() public {
        FeeCurrency fee = new FeeCurrency();
        TreasuryMandate bonded = _create(address(fee), _reviewers(), BOND);
        VerifierSet feePanel = bonded.verifiers();
        fee.mint(CAROL, 100e18);
        vm.startPrank(CAROL);
        fee.approve(address(feePanel), 100e18);
        vm.expectRevert(abi.encodeWithSelector(VerifierSet.ShortTransfer.selector, uint256(BOND), uint256(BOND) * 99 / 100));
        feePanel.bond(BOND);
        vm.stopPrank();
        (, uint256 stake,,) = feePanel.verifiers(CAROL);
        assertEq(stake, 0);
    }

    function test_a_mandate_with_no_bond_behaves_as_before() public {
        TreasuryMandate plain = _create(address(currency), _reviewers(), 0);
        VerifierSet plainPanel = plain.verifiers();
        assertEq(address(plainPanel.bondToken()), address(0));
        vm.prank(CAROL);
        vm.expectRevert(VerifierSet.BondNotEnabled.selector);
        plainPanel.bond(1);
    }

    // ---- taking it back ------------------------------------------------------------------------

    function test_a_reviewer_who_takes_bond_back_waits_and_cannot_attest_below_the_minimum() public {
        _bond(CAROL, 80e18);
        vm.prank(CAROL);
        panel.requestUnbond(40e18); // 40 left: under the 50 minimum

        _claim("a");
        vm.prank(CAROL);
        vm.expectRevert(abi.encodeWithSelector(VerifierSet.BondTooLow.selector, 40e18, uint256(BOND)));
        panel.attest("a", true);

        vm.prank(CAROL);
        vm.expectRevert();
        panel.withdraw();

        vm.warp(vm.getBlockTimestamp() + 14 days);
        vm.prank(CAROL);
        panel.withdraw();
        assertEq(currency.balanceOf(CAROL), 40e18);
        vm.prank(CAROL);
        vm.expectRevert(VerifierSet.NothingToWithdraw.selector);
        panel.withdraw();
    }

    function test_a_reviewer_cannot_ask_back_more_than_they_hold() public {
        _bond(CAROL, BOND);
        vm.prank(CAROL);
        vm.expectRevert(abi.encodeWithSelector(VerifierSet.InsufficientStake.selector, uint256(BOND), uint256(BOND) + 1));
        panel.requestUnbond(BOND + 1);
    }

    // ---- slashing ------------------------------------------------------------------------------

    function test_only_the_dao_can_slash_and_what_is_taken_goes_to_the_dao() public {
        _bond(CAROL, BOND);
        vm.prank(CAROL);
        vm.expectRevert(TreasuryMandate.Unauthorized.selector);
        mandate.slashReviewer(CAROL, 10e18);
        vm.prank(address(0xBAD));
        vm.expectRevert(abi.encodeWithSelector(VerifierSet.OnlyOwner.selector, address(0xBAD)));
        panel.slash(CAROL, 10e18);

        uint256 before = currency.balanceOf(address(dao));
        vm.prank(address(dao));
        mandate.slashReviewer(CAROL, 30e18);
        assertEq(currency.balanceOf(address(dao)) - before, 30e18);
        (, uint256 stake,, uint256 slashed) = panel.verifiers(CAROL);
        assertEq(stake, 20e18);
        assertEq(slashed, 30e18);
        assertEq(currency.balanceOf(address(panel)), 20e18);
    }

    function test_a_reviewer_cannot_escape_a_slash_by_asking_the_bond_back() public {
        _bond(CAROL, BOND);
        vm.prank(CAROL);
        panel.requestUnbond(40e18); // 10 in stake, 40 waiting out the delay
        vm.prank(address(dao));
        mandate.slashReviewer(CAROL, 30e18); // the stake first (10), then the waiting bond (20)
        (, uint256 stake,, uint256 slashed) = panel.verifiers(CAROL);
        (uint256 waiting,) = panel.unbonds(CAROL);
        assertEq(stake, 0);
        assertEq(waiting, 20e18);
        assertEq(slashed, 30e18);
        vm.warp(vm.getBlockTimestamp() + 14 days);
        vm.prank(CAROL);
        panel.withdraw();
        assertEq(currency.balanceOf(CAROL), 20e18);
    }

    function test_a_slash_larger_than_the_bond_takes_only_what_is_there() public {
        _bond(CAROL, BOND);
        uint256 before = currency.balanceOf(address(dao));
        vm.prank(address(dao));
        mandate.slashReviewer(CAROL, 1000e18);
        assertEq(currency.balanceOf(address(dao)) - before, BOND);
        assertEq(currency.balanceOf(address(panel)), 0);
    }

    function test_bonding_can_only_be_turned_on_once_by_the_mandate() public {
        vm.prank(address(mandate));
        vm.expectRevert(VerifierSet.BondAlreadySet.selector);
        panel.setBond(address(currency), 1);
        vm.prank(address(0xBAD));
        vm.expectRevert(abi.encodeWithSelector(VerifierSet.OnlyOwner.selector, address(0xBAD)));
        panel.setBond(address(currency), 1);
    }

    // ---- the bond can be in another token ------------------------------------------------------

    function test_the_bond_can_be_in_a_token_other_than_the_claim_currency() public {
        // The DAO's vote names the project's own token (or any other) as the bond; claims are still paid in `currency`.
        MandateCurrency projectToken = new MandateCurrency();
        TreasuryMandate other = _createWithBondToken(address(currency), address(projectToken), _reviewers(), BOND);
        VerifierSet otherPanel = other.verifiers();
        assertEq(address(otherPanel.bondToken()), address(projectToken));
        // (the panel itself names its bond token; the mandate does not repeat it)
        assertEq(address(other.currency()), address(currency));

        // Bonding in the claim currency does nothing for this panel: only the named token counts.
        currency.mint(CAROL, BOND);
        vm.startPrank(CAROL);
        currency.approve(address(otherPanel), BOND);
        vm.expectRevert();
        otherPanel.bond(BOND);
        vm.stopPrank();

        projectToken.mint(CAROL, 2 * BOND);
        vm.startPrank(CAROL);
        projectToken.approve(address(otherPanel), 2 * BOND);
        otherPanel.bond(BOND);
        vm.stopPrank();
        assertEq(projectToken.balanceOf(address(otherPanel)), BOND);

        // A slash pays the DAO in the bond's token, and the claim currency is untouched.
        uint256 projectBefore = projectToken.balanceOf(address(dao));
        uint256 cashBefore = currency.balanceOf(address(dao));
        vm.prank(address(dao));
        other.slashReviewer(CAROL, 20e18);
        assertEq(projectToken.balanceOf(address(dao)) - projectBefore, 20e18);
        assertEq(currency.balanceOf(address(dao)), cashBefore);

        // What is left comes back after the delay, in the bond's token.
        vm.prank(CAROL);
        otherPanel.requestUnbond(30e18);
        vm.warp(vm.getBlockTimestamp() + 14 days);
        vm.prank(CAROL);
        otherPanel.withdraw();
        assertEq(projectToken.balanceOf(CAROL), 2 * BOND - BOND + 30e18);
    }

    function test_a_bond_and_its_token_must_be_named_together_and_the_token_must_exist() public {
        TreasuryMandateFactory factory = ledger.mandateFactory();
        uint64 expires = uint64(vm.getBlockTimestamp() + 30 days);
        address[] memory reviewers = _reviewers();
        vm.startPrank(address(dao));
        // A bond with no token to pay it in.
        vm.expectRevert(TreasuryMandate.InvalidMandate.selector);
        factory.create(address(currency), 0, 0, 10, 10, expires, reviewers, 2, BOND, address(0));
        // A token with no bond to pay.
        vm.expectRevert(TreasuryMandate.InvalidMandate.selector);
        factory.create(address(currency), 0, 0, 10, 10, expires, reviewers, 2, 0, address(currency));
        // A bond token that is no contract.
        vm.expectRevert(TreasuryMandate.InvalidMandate.selector);
        factory.create(address(currency), 0, 0, 10, 10, expires, reviewers, 2, BOND, address(0xDEAD0));
        vm.stopPrank();
    }
}
