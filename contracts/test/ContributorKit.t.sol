// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {ContributorKit} from "../src/ContributorKit.sol";
import {ClaimStake} from "../src/ClaimStake.sol";
import {TreasuryMandate, TreasuryMandateFactory} from "../src/TreasuryMandate.sol";
import {VerifierSet} from "../src/VerifierSet.sol";
import {AllocationVoting} from "../src/AllocationVoting.sol";
import {Moloch, Shares, Summoner, newSummoner} from "../src/majeur/MolochPatched.sol";
import {MandateCurrency} from "./TreasuryMandate.t.sol";

/// @notice A contributor project made in one transaction: no sale, a Shares-only budget and a first project at birth,
/// Shares locked against transfers, and the first claim possible the same day. Against the real factory, budget factory
/// and voting policy.
contract ContributorKitTest is Test {
    address internal constant FOUNDER = address(0xF0);
    address internal constant R1 = address(0xA1);
    address internal constant R2 = address(0xA2);
    address internal constant DAVE = address(0xDA7E);
    bytes32 internal constant CHECK = keccak256("docs merged and reviewed");
    bytes32 internal constant PROJECT = bytes32("docs");

    ContributorKit internal kit;
    TreasuryMandateFactory internal factory;
    MandateCurrency internal currency;

    function setUp() public {
        vm.warp(10 days);
        Summoner summoner = newSummoner();
        kit = new ContributorKit(summoner);
        factory = kit.budgetFactory();
        currency = new MandateCurrency();
    }

    /// @dev Where the factory's next budget will land: `CREATE(factory, nonce)`, as the app predicts it.
    function _nextBudget() internal view returns (address) {
        return vm.computeCreateAddress(address(factory), vm.getNonce(address(factory)));
    }

    function _reviewers() internal pure returns (address[] memory r) {
        r = new address[](2);
        r[0] = R1;
        r[1] = R2;
    }

    function _params(bytes32 salt) internal view returns (ContributorKit.Params memory p) {
        p.name = "Docs Commons";
        p.symbol = "DOCS";
        p.founderShares = 200e18;
        p.salt = salt;
        p.currency = address(currency);
        p.shareBudget = 100e18;
        p.shareCap = 40e18;
        p.budgetExpires = uint64(block.timestamp + 90 days);
        p.reviewers = _reviewers();
        p.quorum = 2;
        p.predictedBudget = _nextBudget();
        p.projectId = PROJECT;
        p.projectManager = FOUNDER;
        p.projectShares = 40e18;
        p.projectExpires = uint64(block.timestamp + 90 days);
        p.projectCheck = CHECK;
    }

    function _launch(ContributorKit.Params memory p) internal returns (Moloch dao, TreasuryMandate budget) {
        vm.prank(FOUNDER);
        (address d, address b) = kit.launch(p);
        return (Moloch(payable(d)), TreasuryMandate(b));
    }

    function test_one_transaction_gives_a_dao_ready_for_work_with_no_sale() public {
        ContributorKit.Params memory p = _params("docs-commons");
        address predicted = kit.predictDao(FOUNDER, p.founderShares, p.salt);
        (Moloch dao, TreasuryMandate budget) = _launch(p);

        assertEq(address(dao), predicted, "the address the app predicted");
        Shares shares = dao.shares();
        assertEq(shares.balanceOf(FOUNDER), 200e18, "the founder holds the starting Shares");
        assertEq(shares.totalSupply(), 200e18, "and nobody else holds any");
        assertEq(dao.proposalThreshold(), 2e18, "1% of the starting Shares opens a decision");
        assertEq(dao.proposalTTL(), 14 days);
        assertEq(dao.timelockDelay(), 1 days);
        (uint256 price,,,,) = dao.sales(address(currency));
        assertEq(price, 0, "no sale: nothing can be bought from the DAO");
        assertTrue(shares.transfersLocked(), "Shares cannot be sent between wallets");
        assertTrue(shares.unlockNoticeRequired(), "and lifting that takes 30 days' notice (D77)");
        assertEq(shares.transferExempt(), address(0));

        assertEq(factory.daos(address(budget)), address(dao), "the budget is the DAO's own");
        assertEq(budget.shareBudget(), 100e18);
        assertEq(budget.perProjectShareCap(), 40e18);
        assertEq(budget.budget(), 0, "no money in the budget");
        assertEq(budget.reviewerBond(), 0);
        (address manager,,,,, uint128 projectShares,) = budget.projects(PROJECT);
        assertEq(manager, FOUNDER);
        assertEq(projectShares, 40e18);
        assertEq(AllocationVoting(dao.votingWeight()).dao(), address(dao));
    }

    function test_no_lock_guard_is_chosen_at_birth_so_no_vote_can_install_one() public {
        (Moloch dao,) = _launch(_params("no-guard"));
        Shares shares = dao.shares();
        assertEq(shares.lockGuard(), address(0));
        assertTrue(shares.lockGuardSet(), "the choice of no lock is made at birth and is final (D73)");
        // Shares only from reviewed awards, with no yearly limit (D79): a vote the founder carries cannot mint.
        assertTrue(shares.awardsOnly());
        assertEq(shares.issuanceCapBps(), shares.NO_CAP());
        vm.prank(address(dao));
        vm.expectRevert(bytes4(keccak256("Unauthorized()")));
        shares.mintFromMoloch(FOUNDER, 1);
        vm.prank(address(dao));
        vm.expectRevert(Shares.LockGuardSet.selector);
        shares.setLockGuard(address(this));
        assertEq(kit.sharesImplementation().code.length > 0, true);
    }

    function test_the_first_claim_is_filed_bound_and_approved_on_day_one_and_an_award_still_mints() public {
        (Moloch dao, TreasuryMandate budget) = _launch(_params("day-one"));
        ClaimStake claims = budget.claims();
        VerifierSet panel = budget.verifiers();
        bytes32 claim = bytes32("write-docs");

        // No vote, no waiting: the claim goes straight in, the manager takes it on, the reviewers approve it.
        vm.startPrank(DAVE);
        claims.submitClaim(claim, 0, 0, keccak256("the docs"));
        claims.setCheck(claim, CHECK);
        vm.stopPrank();
        vm.prank(FOUNDER);
        budget.fundMilestone(PROJECT, claim, DAVE);
        vm.prank(R1);
        panel.attest(claim, true);
        vm.prank(R2);
        panel.attest(claim, true);
        claims.settle(claim);
        vm.warp(block.timestamp + 7 days);
        vm.prank(DAVE);
        claims.payout(claim);

        // The award is still the DAO's decision (`vm.prank(dao)` stands in for an executed vote), and the lock does not
        // stop it: awards mint.
        vm.prank(address(dao));
        dao.awardContribution(address(budget), claim, 25e18, false);
        Shares shares = dao.shares();
        assertEq(shares.balanceOf(DAVE), 25e18);

        // But the Shares cannot be moved between wallets, by the contributor or the founder.
        vm.prank(DAVE);
        vm.expectRevert();
        shares.transfer(FOUNDER, 1e18);
        vm.prank(FOUNDER);
        vm.expectRevert();
        shares.transfer(DAVE, 1e18);
        assertEq(shares.balanceOf(DAVE), 25e18);

        // Leaving still works: ragequit burns, and the lock does not touch burning.
        address[] memory tokens = new address[](1);
        tokens[0] = address(currency);
        vm.prank(DAVE);
        dao.ragequit(tokens, 25e18, 0);
        assertEq(shares.balanceOf(DAVE), 0);
    }

    function test_a_budget_made_first_by_someone_else_reverts_the_whole_launch() public {
        ContributorKit.Params memory p = _params("raced");
        // Another DAO makes a budget in between: the prediction now names that one.
        Moloch other = _otherDao();
        vm.prank(address(other));
        factory.create(
            address(currency), 0, 0, 1e18, 1e18, uint64(block.timestamp + 1 days), _reviewers(), 1, 0, address(0)
        );
        address predicted = kit.predictDao(FOUNDER, p.founderShares, p.salt);
        vm.prank(FOUNDER);
        vm.expectRevert();
        kit.launch(p);
        assertEq(predicted.code.length, 0, "no DAO was left behind");
        // Pressed again with a fresh prediction, it goes through.
        p.predictedBudget = _nextBudget();
        _launch(p);
    }

    function test_a_project_can_launch_without_a_first_project() public {
        ContributorKit.Params memory p = _params("no-project");
        p.projectId = bytes32(0);
        (, TreasuryMandate budget) = _launch(p);
        assertEq(budget.sharesAllocated(), 0);
    }

    function test_the_same_project_is_made_once_and_the_address_is_the_callers_own() public {
        ContributorKit.Params memory p = _params("once");
        _launch(p);
        p.predictedBudget = _nextBudget();
        vm.prank(FOUNDER);
        vm.expectRevert();
        kit.launch(p);
        // Someone else with the same salt gets a different address, so they cannot take the founder's first.
        assertTrue(kit.predictDao(DAVE, p.founderShares, p.salt) != kit.predictDao(FOUNDER, p.founderShares, p.salt));
    }

    function test_bad_terms_are_refused() public {
        ContributorKit.Params memory p;
        p = _params("bad");
        p.reviewers = new address[](0);
        _expectInvalid(p);
        p = _params("bad");
        p.quorum = 3;
        _expectInvalid(p);
        p = _params("bad");
        p.projectShares = 50e18; // above the per-project limit
        _expectInvalid(p);
        p = _params("bad");
        p.shareCap = 200e18; // above the whole budget
        _expectInvalid(p);
        p = _params("bad");
        p.founderShares = 0;
        _expectInvalid(p);
        p = _params("bad");
        p.currency = address(0xBEEF); // not a token
        _expectInvalid(p);
    }

    function _expectInvalid(ContributorKit.Params memory p) internal {
        vm.prank(FOUNDER);
        vm.expectRevert(ContributorKit.InvalidTerms.selector);
        kit.launch(p);
    }

    function _otherDao() internal returns (Moloch) {
        ContributorKit.Params memory p = _params("other");
        p.projectId = bytes32(0);
        vm.prank(DAVE);
        (address d,) = kit.launch(p);
        return Moloch(payable(d));
    }
}
