// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ContributorKit} from "../src/ContributorKit.sol";
import {ClaimStake} from "../src/ClaimStake.sol";
import {TreasuryMandate, TreasuryMandateFactory} from "../src/TreasuryMandate.sol";
import {VerifierSet} from "../src/VerifierSet.sol";
import {WorkAreaBounty} from "../src/WorkAreaBounty.sol";
import {Moloch, Summoner, newSummoner} from "../src/majeur/MolochPatched.sol";
import {MandateCurrency} from "./TreasuryMandate.t.sol";

/// @notice A currency that refuses to move money to or from a blocked address, like USDC's blocklist.
contract BlockingCurrency is ERC20 {
    mapping(address => bool) public blocked;

    constructor() ERC20("Blocking USD", "BUSD") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function block_(address who) external {
        blocked[who] = true;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!blocked[from] && !blocked[to], "blocked");
        super._update(from, to, value);
    }
}

/// @notice A currency that keeps 1% of every transfer between holders.
contract FeeCurrency is ERC20 {
    constructor() ERC20("Fee USD", "FUSD") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0)) return super._update(from, to, value);
        uint256 fee = value / 100;
        super._update(from, to, value - fee);
        super._update(from, address(0), fee);
    }
}

/// @notice Something that answers like a work budget but was not made by the factory.
contract LookalikeMandate {
    function projects(bytes32) external view returns (address, uint128, uint128, uint64, bytes32, uint128, uint128) {
        return (address(this), 0, 0, uint64(block.timestamp + 30 days), bytes32(0), 1, 0);
    }
}

/// @notice Outside money behind a work area (N1), against the real contributor kit, work budget, reviewer panel and
/// claim escrow: the project's own review decides, the whole pot pays one released submission after its challenge
/// window, and otherwise every funder takes back their own money. Each boundary is tested on both sides.
contract WorkAreaBountyTest is Test {
    address internal constant FOUNDER = address(0xF0);
    address internal constant R1 = address(0xA1);
    address internal constant R2 = address(0xA2);
    address internal constant DAVE = address(0xDA7E);
    address internal constant ERIN = address(0xE21);
    address internal constant FAN1 = address(0xFA1);
    address internal constant FAN2 = address(0xFA2);
    bytes32 internal constant DOCS = bytes32("docs");
    bytes32 internal constant SITE = bytes32("site");
    bytes32 internal constant DOCS_CHECK = keccak256("docs merged and reviewed");
    bytes32 internal constant SITE_CHECK = keccak256("site live");

    ContributorKit internal kit;
    TreasuryMandateFactory internal factory;
    MandateCurrency internal currency;
    Moloch internal dao;
    TreasuryMandate internal budget;
    ClaimStake internal claims;
    VerifierSet internal panel;
    WorkAreaBounty internal bounty;
    uint64 internal expires;

    function setUp() public {
        vm.warp(10 days);
        Summoner summoner = newSummoner();
        kit = new ContributorKit(summoner);
        factory = kit.budgetFactory();
        currency = new MandateCurrency();
        (dao, budget) = _launch(currency);
        claims = budget.claims();
        panel = budget.verifiers();
        bounty = new WorkAreaBounty(IERC20(address(currency)), factory);
        currency.mint(FAN1, 1_000e6);
        currency.mint(FAN2, 1_000e6);
        vm.prank(FAN1);
        currency.approve(address(bounty), type(uint256).max);
        vm.prank(FAN2);
        currency.approve(address(bounty), type(uint256).max);
    }

    function _launch(MandateCurrency c) internal returns (Moloch d, TreasuryMandate b) {
        address[] memory reviewers = new address[](2);
        reviewers[0] = R1;
        reviewers[1] = R2;
        expires = uint64(block.timestamp + 90 days);
        ContributorKit.Params memory p;
        p.name = "Docs Commons";
        p.symbol = "DOCS";
        p.founderShares = 200e18;
        p.salt = "bounty-world";
        p.currency = address(c);
        p.shareBudget = 600e18;
        p.shareCap = 40e18;
        p.budgetExpires = expires;
        p.reviewers = reviewers;
        p.quorum = 2;
        p.predictedBudget = vm.computeCreateAddress(address(factory), vm.getNonce(address(factory)));
        p.projects = new ContributorKit.FirstProject[](2);
        p.projects[0] = ContributorKit.FirstProject({
            id: DOCS, manager: FOUNDER, shares: 40e18, expires: expires, check: DOCS_CHECK
        });
        p.projects[1] = ContributorKit.FirstProject({
            id: SITE, manager: FOUNDER, shares: 40e18, expires: expires, check: SITE_CHECK
        });
        vm.prank(FOUNDER);
        (address made, address madeBudget) = kit.launch(p);
        return (Moloch(payable(made)), TreasuryMandate(madeBudget));
    }

    // ---- helpers -----------------------------------------------------------------------------------------------

    /// @dev `who` files `claim` on work area `project` and its manager binds it, as the Work tab does.
    function _file(bytes32 claim, address who, bytes32 project) internal {
        vm.startPrank(who);
        claims.submitClaim(claim, 0, 0, keccak256(abi.encode(claim)));
        claims.setCheck(claim, project == DOCS ? DOCS_CHECK : SITE_CHECK);
        vm.stopPrank();
        vm.prank(FOUNDER);
        budget.fundMilestone(project, claim, who);
    }

    /// @dev Both reviewers approve and the escrow releases it now (`releasedAt` = this block).
    function _approve(bytes32 claim) internal {
        vm.prank(R1);
        panel.attest(claim, true);
        vm.prank(R2);
        panel.attest(claim, true);
        claims.settle(claim);
    }

    function _open(uint64 deadline, uint256 amount) internal returns (uint256 id) {
        vm.prank(FAN1);
        id = bounty.open(address(budget), DOCS, deadline, amount);
    }

    function _bounty(uint256 id) internal view returns (WorkAreaBounty.Bounty memory b) {
        (
            b.mandate,
            b.openedAt,
            b.deadline,
            b.projectId,
            b.window,
            b.refundsFrom,
            b.total,
            b.refunded,
            b.paidClaim,
            b.contributor
        ) = bounty.bounties(id);
    }

    // ---- paying ------------------------------------------------------------------------------------------------

    function test_a_released_submission_is_paid_the_whole_pot_after_its_challenge_window() public {
        uint256 id = _open(uint64(block.timestamp + 30 days), 100e6);
        vm.prank(FAN2);
        bounty.fund(id, 50e6);
        _file("dave-docs", DAVE, DOCS);
        _approve("dave-docs");
        vm.warp(block.timestamp + 7 days);

        vm.prank(ERIN); // anyone can settle; the money goes to the contributor
        bounty.settle(id, "dave-docs");

        assertEq(currency.balanceOf(DAVE), 150e6);
        assertEq(currency.balanceOf(address(bounty)), 0);
        assertEq(bounty.held(id), 0);
        WorkAreaBounty.Bounty memory b = _bounty(id);
        assertEq(b.paidClaim, bytes32("dave-docs"));
        assertEq(b.contributor, DAVE);
        assertEq(b.window, 7 days);
    }

    function test_settling_waits_for_the_whole_challenge_window() public {
        uint256 id = _open(uint64(block.timestamp + 30 days), 100e6);
        _file("dave-docs", DAVE, DOCS);
        _approve("dave-docs");
        uint64 payableAt = uint64(block.timestamp + 7 days);

        vm.warp(payableAt - 1);
        vm.expectRevert(
            abi.encodeWithSelector(WorkAreaBounty.InChallengeWindow.selector, bytes32("dave-docs"), payableAt)
        );
        bounty.settle(id, "dave-docs");

        vm.warp(payableAt);
        bounty.settle(id, "dave-docs");
        assertEq(currency.balanceOf(DAVE), 100e6);
    }

    function test_a_submission_already_paid_out_by_the_escrow_still_settles() public {
        uint256 id = _open(uint64(block.timestamp + 30 days), 100e6);
        _file("dave-docs", DAVE, DOCS);
        _approve("dave-docs");
        vm.warp(block.timestamp + 7 days);
        vm.prank(DAVE);
        claims.payout("dave-docs");
        (,,, ClaimStake.Status status,,,,) = claims.claims("dave-docs");
        assertEq(uint8(status), uint8(ClaimStake.Status.Paid));

        bounty.settle(id, "dave-docs");
        assertEq(currency.balanceOf(DAVE), 100e6);
    }

    function test_only_the_first_submission_to_settle_is_paid() public {
        uint256 id = _open(uint64(block.timestamp + 30 days), 100e6);
        _file("dave-docs", DAVE, DOCS);
        _file("erin-docs", ERIN, DOCS);
        _approve("dave-docs");
        _approve("erin-docs");
        vm.warp(block.timestamp + 7 days);
        bounty.settle(id, "erin-docs");

        vm.expectRevert(abi.encodeWithSelector(WorkAreaBounty.AlreadyPaid.selector, id));
        bounty.settle(id, "dave-docs");
        assertEq(currency.balanceOf(ERIN), 100e6);
        assertEq(currency.balanceOf(DAVE), 0);
    }

    // ---- which submissions count -------------------------------------------------------------------------------

    function test_a_submission_of_another_work_area_is_refused() public {
        uint256 id = _open(uint64(block.timestamp + 30 days), 100e6);
        _file("dave-site", DAVE, SITE);
        _approve("dave-site");
        vm.warp(block.timestamp + 7 days);

        vm.expectRevert(abi.encodeWithSelector(WorkAreaBounty.NotThisWorkArea.selector, bytes32("dave-site")));
        bounty.settle(id, "dave-site");
    }

    function test_a_submission_bound_to_no_work_area_is_refused() public {
        uint256 id = _open(uint64(block.timestamp + 30 days), 100e6);
        vm.startPrank(DAVE);
        claims.submitClaim("loose", 0, 0, keccak256("loose"));
        claims.setCheck("loose", DOCS_CHECK);
        vm.stopPrank();
        _approve("loose");
        vm.warp(block.timestamp + 7 days);

        vm.expectRevert(abi.encodeWithSelector(WorkAreaBounty.NotThisWorkArea.selector, bytes32("loose")));
        bounty.settle(id, "loose");
    }

    function test_a_submission_released_before_the_bounty_opened_is_refused() public {
        _file("dave-docs", DAVE, DOCS);
        _approve("dave-docs");
        // Read from the record: the compiler may move a `block.timestamp` read past the `vm.warp` below.
        (,,,,,,, uint64 released) = claims.claims("dave-docs");
        vm.warp(block.timestamp + 1);
        uint256 id = _open(uint64(block.timestamp + 30 days), 100e6);
        vm.warp(block.timestamp + 7 days);

        vm.expectRevert(
            abi.encodeWithSelector(WorkAreaBounty.ReleasedOutsideBounty.selector, bytes32("dave-docs"), released)
        );
        bounty.settle(id, "dave-docs");
    }

    function test_a_submission_released_in_the_same_second_the_bounty_opened_counts() public {
        uint256 id = _open(uint64(block.timestamp + 30 days), 100e6);
        _file("dave-docs", DAVE, DOCS);
        _approve("dave-docs");
        vm.warp(block.timestamp + 7 days);
        bounty.settle(id, "dave-docs");
        assertEq(currency.balanceOf(DAVE), 100e6);
    }

    function test_a_submission_released_at_the_deadline_counts_and_one_second_later_does_not() public {
        uint64 deadline = uint64(block.timestamp + 10 days);
        uint256 id = _open(deadline, 100e6);
        uint256 late = _open(deadline, 100e6);
        _file("dave-docs", DAVE, DOCS);
        _file("erin-docs", ERIN, DOCS);

        vm.warp(deadline);
        _approve("dave-docs");
        vm.warp(deadline + 1);
        _approve("erin-docs");
        vm.warp(deadline + 1 + 7 days);

        vm.expectRevert(
            abi.encodeWithSelector(WorkAreaBounty.ReleasedOutsideBounty.selector, bytes32("erin-docs"), deadline + 1)
        );
        bounty.settle(late, "erin-docs");
        bounty.settle(id, "dave-docs");
        assertEq(currency.balanceOf(DAVE), 100e6);
    }

    function test_an_open_submission_is_not_accepted() public {
        uint256 id = _open(uint64(block.timestamp + 30 days), 100e6);
        _file("dave-docs", DAVE, DOCS);
        vm.warp(block.timestamp + 7 days);
        vm.expectRevert(abi.encodeWithSelector(WorkAreaBounty.NotAccepted.selector, bytes32("dave-docs")));
        bounty.settle(id, "dave-docs");
    }

    function test_a_frozen_submission_never_pays_and_the_funders_get_their_money_back() public {
        uint64 deadline = uint64(block.timestamp + 30 days);
        uint256 id = _open(deadline, 100e6);
        _file("dave-docs", DAVE, DOCS);
        _approve("dave-docs");
        vm.prank(address(dao)); // stands in for an executed freeze vote
        budget.freezeClaim("dave-docs");
        vm.warp(block.timestamp + 7 days);

        vm.expectRevert(abi.encodeWithSelector(WorkAreaBounty.NotAccepted.selector, bytes32("dave-docs")));
        bounty.settle(id, "dave-docs");

        vm.warp(_bounty(id).refundsFrom);
        bounty.refund(id, FAN1);
        assertEq(currency.balanceOf(FAN1), 1_000e6);
        assertEq(currency.balanceOf(DAVE), 0);
    }

    function test_a_rejected_submission_never_pays() public {
        uint256 id = _open(uint64(block.timestamp + 30 days), 100e6);
        _file("dave-docs", DAVE, DOCS);
        vm.prank(R1);
        panel.attest("dave-docs", false);
        vm.prank(R2);
        panel.attest("dave-docs", false);
        claims.settle("dave-docs");
        vm.warp(block.timestamp + 7 days);

        vm.expectRevert(abi.encodeWithSelector(WorkAreaBounty.NotAccepted.selector, bytes32("dave-docs")));
        bounty.settle(id, "dave-docs");
    }

    function test_an_expired_submission_never_pays() public {
        uint256 id = _open(uint64(block.timestamp + 60 days), 100e6);
        _file("dave-docs", DAVE, DOCS);
        vm.warp(block.timestamp + 31 days);
        claims.expire("dave-docs");

        vm.expectRevert(abi.encodeWithSelector(WorkAreaBounty.NotAccepted.selector, bytes32("dave-docs")));
        bounty.settle(id, "dave-docs");
    }

    // ---- refunds -----------------------------------------------------------------------------------------------

    function test_refunds_open_exactly_at_refundsFrom_and_return_each_funders_own_amount() public {
        uint64 deadline = uint64(block.timestamp + 30 days);
        uint256 id = _open(deadline, 100e6);
        vm.prank(FAN2);
        bounty.fund(id, 40e6);
        uint64 refundsFrom = deadline + 7 days + bounty.SETTLE_GRACE();
        assertEq(_bounty(id).refundsFrom, refundsFrom);

        vm.warp(refundsFrom - 1);
        vm.expectRevert(abi.encodeWithSelector(WorkAreaBounty.RefundsNotOpen.selector, id, refundsFrom));
        bounty.refund(id, FAN1);

        vm.warp(refundsFrom);
        vm.prank(ERIN); // anyone can send a funder's refund; it only ever goes to that funder
        bounty.refund(id, FAN2);
        bounty.refund(id, FAN1);
        assertEq(currency.balanceOf(FAN1), 1_000e6);
        assertEq(currency.balanceOf(FAN2), 1_000e6);
        assertEq(currency.balanceOf(ERIN), 0);
        assertEq(bounty.held(id), 0);

        vm.expectRevert(abi.encodeWithSelector(WorkAreaBounty.NothingToRefund.selector, id, FAN1));
        bounty.refund(id, FAN1);
    }

    function test_settling_closes_the_second_refunds_open() public {
        uint64 deadline = uint64(block.timestamp + 10 days);
        uint256 id = _open(deadline, 100e6);
        uint256 other = _open(deadline, 100e6);
        _file("dave-docs", DAVE, DOCS);
        vm.warp(deadline);
        _approve("dave-docs");
        uint64 refundsFrom = _bounty(id).refundsFrom;

        vm.warp(refundsFrom);
        vm.expectRevert(abi.encodeWithSelector(WorkAreaBounty.SettleTooLate.selector, other, refundsFrom));
        bounty.settle(other, "dave-docs");

        vm.warp(refundsFrom - 1);
        bounty.settle(id, "dave-docs");
        assertEq(currency.balanceOf(DAVE), 100e6);
    }

    function test_a_paid_bounty_refunds_nothing() public {
        uint256 id = _open(uint64(block.timestamp + 30 days), 100e6);
        _file("dave-docs", DAVE, DOCS);
        _approve("dave-docs");
        vm.warp(block.timestamp + 7 days);
        bounty.settle(id, "dave-docs");

        vm.warp(_bounty(id).refundsFrom);
        vm.expectRevert(abi.encodeWithSelector(WorkAreaBounty.AlreadyPaid.selector, id));
        bounty.refund(id, FAN1);
    }

    // ---- funding -----------------------------------------------------------------------------------------------

    function test_funding_closes_at_the_deadline() public {
        uint64 deadline = uint64(block.timestamp + 10 days);
        uint256 id = _open(deadline, 100e6);
        vm.warp(deadline - 1);
        vm.prank(FAN2);
        bounty.fund(id, 1e6);

        vm.warp(deadline);
        vm.prank(FAN2);
        vm.expectRevert(abi.encodeWithSelector(WorkAreaBounty.FundingClosed.selector, id));
        bounty.fund(id, 1e6);
        assertEq(_bounty(id).total, 101e6);
        assertEq(bounty.fundedBy(id, FAN2), 1e6);
    }

    function test_funding_closes_once_the_bounty_paid() public {
        uint256 id = _open(uint64(block.timestamp + 30 days), 100e6);
        _file("dave-docs", DAVE, DOCS);
        _approve("dave-docs");
        vm.warp(block.timestamp + 7 days);
        bounty.settle(id, "dave-docs");

        vm.prank(FAN2);
        vm.expectRevert(abi.encodeWithSelector(WorkAreaBounty.FundingClosed.selector, id));
        bounty.fund(id, 1e6);
    }

    function test_nothing_is_funded_for_free() public {
        vm.prank(FAN1);
        vm.expectRevert(WorkAreaBounty.NothingToFund.selector);
        bounty.open(address(budget), DOCS, uint64(block.timestamp + 1 days), 0);
        uint256 id = _open(uint64(block.timestamp + 1 days), 1e6);
        vm.prank(FAN2);
        vm.expectRevert(WorkAreaBounty.NothingToFund.selector);
        bounty.fund(id, 0);
        vm.expectRevert(abi.encodeWithSelector(WorkAreaBounty.UnknownBounty.selector, id + 1));
        bounty.fund(id + 1, 1e6);
    }

    // ---- opening -----------------------------------------------------------------------------------------------

    function test_only_a_work_budget_the_factory_made_can_be_funded() public {
        LookalikeMandate fake = new LookalikeMandate();
        vm.prank(FAN1);
        vm.expectRevert(abi.encodeWithSelector(WorkAreaBounty.NotAWorkBudget.selector, address(fake)));
        bounty.open(address(fake), DOCS, uint64(block.timestamp + 1 days), 1e6);
    }

    function test_only_a_real_work_area_can_be_funded() public {
        vm.prank(FAN1);
        vm.expectRevert(abi.encodeWithSelector(WorkAreaBounty.NoSuchWorkArea.selector, bytes32("nothing")));
        bounty.open(address(budget), "nothing", uint64(block.timestamp + 1 days), 1e6);
    }

    function test_the_deadline_is_in_the_future_and_within_the_work_areas_expiry() public {
        vm.startPrank(FAN1);
        vm.expectRevert(abi.encodeWithSelector(WorkAreaBounty.BadDeadline.selector, uint64(block.timestamp)));
        bounty.open(address(budget), DOCS, uint64(block.timestamp), 1e6);
        vm.expectRevert(abi.encodeWithSelector(WorkAreaBounty.BadDeadline.selector, expires + 1));
        bounty.open(address(budget), DOCS, expires + 1, 1e6);
        uint256 id = bounty.open(address(budget), DOCS, expires, 1e6);
        vm.stopPrank();
        assertEq(_bounty(id).deadline, expires);
    }

    function test_a_currency_that_keeps_a_fee_is_refused() public {
        FeeCurrency fee = new FeeCurrency();
        WorkAreaBounty feeBounty = new WorkAreaBounty(IERC20(address(fee)), factory);
        fee.mint(FAN1, 100e6);
        vm.startPrank(FAN1);
        fee.approve(address(feeBounty), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(WorkAreaBounty.ShortTransfer.selector, 100e6, 99e6));
        feeBounty.open(address(budget), DOCS, uint64(block.timestamp + 1 days), 100e6);
        vm.stopPrank();
    }

    function test_the_setup_needs_real_contracts() public {
        vm.expectRevert(WorkAreaBounty.InvalidSetup.selector);
        new WorkAreaBounty(IERC20(address(0xBEEF)), factory);
        vm.expectRevert(WorkAreaBounty.InvalidSetup.selector);
        new WorkAreaBounty(IERC20(address(currency)), TreasuryMandateFactory(address(0xBEEF)));
    }

    // ---- recipients the currency refuses -----------------------------------------------------------------------

    function test_a_contributor_the_currency_refuses_cannot_be_paid_and_the_funders_are_refunded() public {
        BlockingCurrency usd = new BlockingCurrency();
        WorkAreaBounty b = new WorkAreaBounty(IERC20(address(usd)), factory);
        usd.mint(FAN1, 100e6);
        vm.startPrank(FAN1);
        usd.approve(address(b), type(uint256).max);
        uint256 id = b.open(address(budget), DOCS, uint64(block.timestamp + 30 days), 100e6);
        vm.stopPrank();
        _file("dave-docs", DAVE, DOCS);
        _approve("dave-docs");
        usd.block_(DAVE);
        vm.warp(block.timestamp + 7 days);

        vm.expectRevert(bytes("blocked"));
        b.settle(id, "dave-docs");

        (,,,,, uint64 refundsFrom,,,,) = b.bounties(id);
        vm.warp(refundsFrom);
        b.refund(id, FAN1);
        assertEq(usd.balanceOf(FAN1), 100e6);
    }

    function test_a_funder_the_currency_refuses_does_not_block_another_funders_refund() public {
        BlockingCurrency usd = new BlockingCurrency();
        WorkAreaBounty b = new WorkAreaBounty(IERC20(address(usd)), factory);
        usd.mint(FAN1, 100e6);
        usd.mint(FAN2, 50e6);
        vm.startPrank(FAN1);
        usd.approve(address(b), type(uint256).max);
        uint256 id = b.open(address(budget), DOCS, uint64(block.timestamp + 10 days), 100e6);
        vm.stopPrank();
        vm.startPrank(FAN2);
        usd.approve(address(b), type(uint256).max);
        b.fund(id, 50e6);
        vm.stopPrank();
        usd.block_(FAN1);
        (,,,,, uint64 refundsFrom,,,,) = b.bounties(id);
        vm.warp(refundsFrom);

        vm.expectRevert(bytes("blocked"));
        b.refund(id, FAN1);
        b.refund(id, FAN2);
        assertEq(usd.balanceOf(FAN2), 50e6);
        assertEq(b.held(id), 100e6);
    }
}
