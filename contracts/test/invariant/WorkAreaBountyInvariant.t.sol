// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test, console} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ContributorKit} from "../../src/ContributorKit.sol";
import {ClaimStake} from "../../src/ClaimStake.sol";
import {TreasuryMandate, TreasuryMandateFactory} from "../../src/TreasuryMandate.sol";
import {VerifierSet} from "../../src/VerifierSet.sol";
import {WorkAreaBounty} from "../../src/WorkAreaBounty.sol";
import {Moloch, Summoner, newSummoner} from "../../src/majeur/MolochPatched.sol";
import {MandateCurrency} from "../TreasuryMandate.t.sol";

/// @notice Drives a few bounties on two work areas through random orders of funding, reviews, freezes, settlements,
/// refunds and time, recording what each call actually moved.
contract WorkAreaBountyHandler is Test {
    address internal constant R1 = address(0xA1);
    address internal constant R2 = address(0xA2);

    WorkAreaBounty public bounty;
    MandateCurrency public currency;
    TreasuryMandate public budget;
    ClaimStake public claims;
    VerifierSet public panel;
    Moloch public dao;

    uint256[] public ids;
    address[] public funders;
    bytes32[] public claimIds;

    mapping(uint256 => uint256) public funded;
    mapping(uint256 => uint256) public paid;
    mapping(uint256 => uint256) public refunded;
    /// @notice How many settlements and refunds went through, so a run that never reached them is visible.
    uint256 public settles;
    uint256 public refunds;

    constructor(
        WorkAreaBounty bounty_,
        MandateCurrency currency_,
        TreasuryMandate budget_,
        Moloch dao_,
        uint256[] memory ids_,
        address[] memory funders_,
        bytes32[] memory claimIds_
    ) {
        bounty = bounty_;
        currency = currency_;
        budget = budget_;
        claims = budget_.claims();
        panel = budget_.verifiers();
        dao = dao_;
        ids = ids_;
        funders = funders_;
        claimIds = claimIds_;
        for (uint256 i; i < ids_.length; ++i) {
            (,,,,,, uint128 total,,,) = bounty_.bounties(ids_[i]);
            funded[ids_[i]] = total;
        }
    }

    function idCount() external view returns (uint256) {
        return ids.length;
    }

    function fund(uint256 bSeed, uint256 fSeed, uint256 amount) external {
        uint256 id = ids[bSeed % ids.length];
        address funder = funders[fSeed % funders.length];
        amount = bound(amount, 1, 100e6);
        currency.mint(funder, amount);
        vm.startPrank(funder);
        currency.approve(address(bounty), amount);
        try bounty.fund(id, amount) {
            funded[id] += amount;
        } catch {}
        vm.stopPrank();
    }

    /// @dev Three in four reviews approve, so settlements are reached often.
    function review(uint256 cSeed, uint256 verdict) external {
        bytes32 claim = claimIds[cSeed % claimIds.length];
        bool approve = verdict % 4 != 0;
        vm.prank(R1);
        try panel.attest(claim, approve) {} catch {}
        vm.prank(R2);
        try panel.attest(claim, approve) {} catch {}
        try claims.settle(claim) {} catch {}
    }

    function freeze(uint256 cSeed) external {
        bytes32 claim = claimIds[cSeed % claimIds.length];
        vm.prank(address(dao));
        try budget.freezeClaim(claim) {} catch {}
    }

    function settle(uint256 bSeed, uint256 cSeed) external {
        uint256 id = ids[bSeed % ids.length];
        // Mostly a submission of the bounty's own work area (claims alternate docs, site), sometimes any.
        bytes32 claim = cSeed % 5 == 0
            ? claimIds[cSeed % claimIds.length]
            : claimIds[(cSeed % 3) * 2 + (bSeed % ids.length == 2 ? 1 : 0)];
        (,,,,,, uint128 total,,,) = bounty.bounties(id);
        try bounty.settle(id, claim) {
            paid[id] = total;
            ++settles;
        } catch {}
    }

    function refund(uint256 bSeed, uint256 fSeed) external {
        uint256 id = ids[bSeed % ids.length];
        address funder = funders[fSeed % funders.length];
        uint256 owed = bounty.fundedBy(id, funder);
        try bounty.refund(id, funder) {
            refunded[id] += owed;
            ++refunds;
        } catch {}
    }

    function wait(uint256 seconds_) external {
        vm.warp(block.timestamp + bound(seconds_, 1 hours, 12 days));
    }
}

/// @notice A bounty's books hold over any order of events: the contract holds exactly what was funded less what was paid
/// and refunded; a bounty either pays its whole pot or refunds, never both; and nothing is refunded beyond what came in.
///
/// forge-config: default.invariant.runs = 64
/// forge-config: default.invariant.depth = 120
/// forge-config: default.invariant.fail-on-revert = true
contract WorkAreaBountyInvariantTest is Test {
    address internal constant FOUNDER = address(0xF0);
    address internal constant R1 = address(0xA1);
    address internal constant R2 = address(0xA2);
    bytes32 internal constant DOCS = bytes32("docs");
    bytes32 internal constant SITE = bytes32("site");
    bytes32 internal constant DOCS_CHECK = keccak256("docs merged and reviewed");
    bytes32 internal constant SITE_CHECK = keccak256("site live");

    WorkAreaBountyHandler internal handler;
    WorkAreaBounty internal bounty;
    MandateCurrency internal currency;

    function setUp() public {
        vm.warp(10 days);
        ContributorKit kit = new ContributorKit(newSummoner());
        TreasuryMandateFactory factory = kit.budgetFactory();
        currency = new MandateCurrency();
        (Moloch dao, TreasuryMandate budget) = _launch(kit, factory);
        bounty = new WorkAreaBounty(IERC20(address(currency)), factory);

        address[] memory funders = new address[](3);
        for (uint256 i; i < funders.length; ++i) {
            funders[i] = address(uint160(0xFA1 + i));
        }
        bytes32[] memory claimIds = new bytes32[](6);
        ClaimStake claims = budget.claims();
        for (uint256 i; i < claimIds.length; ++i) {
            bytes32 claim = keccak256(abi.encode("claim", i));
            address who = address(uint160(0xC001 + i % 3));
            bytes32 project = i % 2 == 0 ? DOCS : SITE;
            vm.startPrank(who);
            claims.submitClaim(claim, 0, 0, keccak256(abi.encode(claim)));
            claims.setCheck(claim, project == DOCS ? DOCS_CHECK : SITE_CHECK);
            vm.stopPrank();
            vm.prank(FOUNDER);
            budget.fundMilestone(project, claim, who);
            claimIds[i] = claim;
        }

        uint256[] memory ids = new uint256[](3);
        currency.mint(funders[0], 300e6);
        vm.startPrank(funders[0]);
        currency.approve(address(bounty), type(uint256).max);
        ids[0] = bounty.open(address(budget), DOCS, uint64(block.timestamp + 20 days), 100e6);
        ids[1] = bounty.open(address(budget), DOCS, uint64(block.timestamp + 40 days), 100e6);
        ids[2] = bounty.open(address(budget), SITE, uint64(block.timestamp + 30 days), 100e6);
        vm.stopPrank();

        handler = new WorkAreaBountyHandler(bounty, currency, budget, dao, ids, funders, claimIds);
        targetContract(address(handler));
    }

    function _launch(ContributorKit kit, TreasuryMandateFactory factory)
        internal
        returns (Moloch dao, TreasuryMandate budget)
    {
        address[] memory reviewers = new address[](2);
        reviewers[0] = R1;
        reviewers[1] = R2;
        uint64 expires = uint64(block.timestamp + 90 days);
        ContributorKit.Params memory p;
        p.name = "Docs Commons";
        p.symbol = "DOCS";
        p.founderShares = 200e18;
        p.salt = "bounty-invariant";
        p.currency = address(currency);
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
        (address d, address b) = kit.launch(p);
        return (Moloch(payable(d)), TreasuryMandate(b));
    }

    function invariant_the_contract_holds_exactly_what_is_still_owed() public view {
        uint256 owed;
        for (uint256 i; i < handler.idCount(); ++i) {
            uint256 id = handler.ids(i);
            owed += handler.funded(id) - handler.paid(id) - handler.refunded(id);
            assertEq(bounty.held(id), handler.funded(id) - handler.paid(id) - handler.refunded(id));
        }
        assertEq(currency.balanceOf(address(bounty)), owed);
    }

    /// @dev Totals across a run, printed with -vv: a run where nothing settled or refunded tests nothing.
    function afterInvariant() public view {
        console.log("settles", handler.settles(), "refunds", handler.refunds());
    }

    function invariant_a_bounty_pays_its_whole_pot_or_refunds_never_both() public view {
        for (uint256 i; i < handler.idCount(); ++i) {
            uint256 id = handler.ids(i);
            uint256 paidOut = handler.paid(id);
            assertTrue(paidOut == 0 || handler.refunded(id) == 0);
            assertTrue(paidOut == 0 || paidOut == handler.funded(id));
            assertLe(handler.refunded(id), handler.funded(id));
        }
    }
}
