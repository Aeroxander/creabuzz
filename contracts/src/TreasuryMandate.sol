// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ClaimStake} from "./ClaimStake.sol";
import {VerifierSet} from "./VerifierSet.sol";

interface IMandateDao {
    function shares() external view returns (address);
}

interface IMandateShares {
    function lockGuard() external view returns (address);
}

interface IMandateLock {
    function trancheCount(address beneficiary) external view returns (uint256);
}

/// @notice A DAO-approved, finite mandate over two budgets: currency to pay for work, and Shares to recognise it.
/// Team managers reserve milestone payments and bind claims; independent reviewers and a challenge window release
/// them. Returned funds never silently replenish the mandate's allocation authority.
///
/// Either budget may be zero, but not both, except the one kind of mandate that holds nothing at all: the milestone
/// panel a DAO names at launch to judge its team's milestones. Its projects hold no money and award no Shares; they
/// exist so a milestone claim can be bound and judged. A mandate with no currency is how a project with no treasury (one that
/// never raised) rewards contributors: the work is verified exactly as paid work is, and the DAO then awards Shares
/// out of the project's share budget, which the broad vote that created the mandate capped.
///
/// The reviewers are fixed when the mandate is made. None may be someone whose own Shares a milestone lock holds
/// (a team member cannot judge the team's milestones), and each can be made to post a real bond before they may
/// attest; the DAO can slash a bond after a disputed approval. The bond is in whichever ERC-20 the vote that made the
/// mandate names: the claim currency (the default, and the safest: nobody prices it), the project's own token, or any
/// other. What the bond is worth as a deterrent is the DAO's call, and the vote says which token it chose.
contract TreasuryMandate {
    using SafeERC20 for IERC20;

    address public immutable dao;
    IERC20 public immutable currency;
    uint128 public immutable budget;
    uint128 public immutable perProjectCap;
    /// @notice Most Shares this mandate can ever cause to be awarded, in total and per project.
    uint128 public immutable shareBudget;
    uint128 public immutable perProjectShareCap;
    /// @notice The bond, in `reviewerBondToken`, each reviewer must hold to attest (zero: reviewers need no bond).
    uint128 public immutable reviewerBond;
    /// @notice What the bond is paid in (zero exactly when there is no bond).
    address public immutable reviewerBondToken;
    uint64 public immutable expiresAt;
    /// @notice Whether this is a DAO's milestone panel: no budgets, and projects that hold nothing.
    bool public immutable milestonePanel;
    VerifierSet public immutable verifiers;
    ClaimStake public immutable claims;
    uint128 public allocated;
    /// @notice Share budget already handed to approved projects (never replenished, like `allocated`).
    uint128 public sharesAllocated;
    bool public closed;
    bool private entered;

    struct Project {
        address manager;
        uint128 budget;
        uint128 reserved;
        uint64 expiresAt;
        bytes32 checkHash;
        uint128 shareBudget;
        uint128 sharesAwarded;
    }

    mapping(bytes32 => Project) public projects;
    mapping(bytes32 => bytes32) public claimProject;
    mapping(bytes32 => bool) public contributionAwarded;

    error Unauthorized();
    error InvalidMandate();
    error BudgetExceeded();
    error InvalidProject();
    error InvalidClaim();
    error Reentrancy();
    event ProjectApproved(
        bytes32 indexed projectId,
        address indexed manager,
        uint128 amount,
        uint128 shareAmount,
        uint64 expiresAt,
        bytes32 checkHash
    );
    event MilestoneReserved(bytes32 indexed projectId, bytes32 indexed claimId, uint128 amount);
    event ContributionConsumed(bytes32 indexed claimId, address indexed contributor, uint128 shares);
    event UnusedReturned(uint256 amount);
    event MandateClosed();
    event ReviewerSlashed(address indexed reviewer, uint256 amount);

    modifier onlyDAO() {
        if (msg.sender != dao) revert Unauthorized();
        _;
    }

    modifier nonReentrant() {
        if (entered) revert Reentrancy();
        entered = true;
        _;
        entered = false;
    }

    constructor(
        address dao_,
        address currency_,
        uint128 budget_,
        uint128 cap_,
        uint128 shareBudget_,
        uint128 shareCap_,
        uint64 expires_,
        address[] memory reviewers,
        uint256 quorum,
        uint128 reviewerBond_,
        address bondToken_,
        bool milestonePanel_
    ) {
        // Each budget is all-or-nothing: a cap with no budget (or a budget with no cap) cannot be spent sensibly.
        if (
            dao_.code.length == 0 || currency_.code.length == 0 || (budget_ == 0) != (cap_ == 0) || cap_ > budget_
                || (shareBudget_ == 0) != (shareCap_ == 0) || shareCap_ > shareBudget_
                // Something to spend, unless this is the panel that only judges (then there must be nothing).
                || (budget_ == 0 && shareBudget_ == 0) != milestonePanel_ || expires_ <= block.timestamp
                || reviewers.length > 32
                || quorum == 0 || quorum > reviewers.length
                // A bond needs a real token to be paid in, and no bond needs none named.
                || (reviewerBond_ == 0) != (bondToken_ == address(0))
                || (bondToken_ != address(0) && bondToken_.code.length == 0)
        ) revert InvalidMandate();
        dao = dao_;
        currency = IERC20(currency_);
        budget = budget_;
        perProjectCap = cap_;
        shareBudget = shareBudget_;
        perProjectShareCap = shareCap_;
        expiresAt = expires_;
        reviewerBond = reviewerBond_;
        reviewerBondToken = bondToken_;
        milestonePanel = milestonePanel_;
        VerifierSet panel = new VerifierSet(address(this), quorum);
        verifiers = panel;
        claims = new ClaimStake(panel, address(this), currency_);
        panel.setClaimStake(address(claims));
        if (reviewerBond_ != 0) panel.setBond(bondToken_, reviewerBond_);
        for (uint256 i; i < reviewers.length; ++i) {
            // A team member whose Shares a milestone lock holds cannot sit on the panel that judges the milestones.
            if (reviewers[i] == address(0) || _isLockedTeamMember(dao_, reviewers[i])) revert InvalidMandate();
            panel.acceptVerifier(reviewers[i]);
        }
    }

    /// @dev Whether the DAO's Shares name `who` as a beneficiary of their lock guard. A DAO without a guard, or a
    /// caller that is not a DAO at all, locks nobody; a mandate made by a stranger carries no authority over a real DAO
    /// (the lock only honours mandates the DAO's own factory made for it), so being lenient here is harmless.
    function _isLockedTeamMember(address dao_, address who) private view returns (bool) {
        try IMandateDao(dao_).shares() returns (address shares_) {
            try IMandateShares(shares_).lockGuard() returns (address guard) {
                if (guard == address(0)) return false;
                try IMandateLock(guard).trancheCount(who) returns (uint256 n) {
                    return n != 0;
                } catch {
                    return false;
                }
            } catch {
                return false;
            }
        } catch {
            return false;
        }
    }

    /// @notice The one operation eligible for bounded-project voting. Its total
    /// lifetime authority and each project remain limited by the parent mandate.
    function approveProject(
        bytes32 id,
        address manager,
        uint128 amount,
        uint128 shareAmount,
        uint64 expires,
        bytes32 checkHash
    ) external onlyDAO {
        if (
            id == bytes32(0) || projects[id].manager != address(0) || manager == address(0) || checkHash == bytes32(0)
                || closed || block.timestamp >= expiresAt || expires <= block.timestamp || expires > expiresAt
        ) revert InvalidProject();
        if (
            (amount == 0 && shareAmount == 0 && !milestonePanel) || amount > perProjectCap || uint256(allocated) + amount > budget
                || shareAmount > perProjectShareCap || uint256(sharesAllocated) + shareAmount > shareBudget
        ) revert BudgetExceeded();
        allocated += amount;
        sharesAllocated += shareAmount;
        projects[id] = Project(manager, amount, 0, expires, checkHash, shareAmount, 0);
        emit ProjectApproved(id, manager, amount, shareAmount, expires, checkHash);
    }

    /// @notice Bind a submitted claim to a team's approved project, reserving its payment if it asks for one.
    /// This binds its acceptance check before anything can be released. A claim that asks for no currency (work
    /// recognised in Shares alone) reserves nothing and is bound the same way. A claim id belongs to whoever filed it
    /// first, so the manager names the contributor they mean and a claim filed by anyone else is refused.
    function fundMilestone(bytes32 projectId, bytes32 claimId, address expectedContributor) external nonReentrant {
        Project storage project = projects[projectId];
        if (
            msg.sender != project.manager || closed || block.timestamp >= project.expiresAt
                || block.timestamp >= expiresAt
        ) revert Unauthorized();
        if (claimProject[claimId] != bytes32(0)) revert InvalidClaim();
        (address contributor, uint256 amount, bytes32 checkHash, ClaimStake.Status status) = claims.claimTerms(claimId);
        if (
            contributor == address(0) || contributor != expectedContributor || status != ClaimStake.Status.Open
                || checkHash != project.checkHash
        ) revert InvalidClaim();
        if (amount > uint256(project.budget) - project.reserved) revert BudgetExceeded();
        project.reserved += uint128(amount);
        claimProject[claimId] = projectId;
        claims.lockCheck(claimId, project.checkHash);
        if (amount != 0) {
            currency.forceApprove(address(claims), amount);
            claims.fund(claimId, amount);
            currency.forceApprove(address(claims), 0);
        }
        emit MilestoneReserved(projectId, claimId, uint128(amount));
    }

    /// @notice Consume evidence of a delivery once, counting `shares` against its project's share budget, before
    /// the DAO awards Shares or converts the contributor's Loot through its sole governor. A claim is `Paid` once
    /// its reviewers approved it and its challenge window passed, whether or not it asked for currency. A closed
    /// mandate awards nothing more.
    function consumeContribution(bytes32 claimId, uint128 shares) external onlyDAO returns (address contributor) {
        bytes32 projectId = claimProject[claimId];
        // Closing a mandate stops what it can still cause: no new projects, and no more Shares from its allowances.
        if (closed || projectId == bytes32(0) || contributionAwarded[claimId]) revert InvalidClaim();
        ClaimStake.Status status;
        (contributor,,, status) = claims.claimTerms(claimId);
        if (status != ClaimStake.Status.Paid) revert InvalidClaim();
        Project storage project = projects[projectId];
        if (shares == 0 || shares > project.shareBudget - project.sharesAwarded) revert BudgetExceeded();
        project.sharesAwarded += shares;
        contributionAwarded[claimId] = true;
        emit ContributionConsumed(claimId, contributor, shares);
    }

    /// @notice A disputed payment can be frozen by the same DAO governance.
    function freezeClaim(bytes32 claimId) external onlyDAO {
        claims.freeze(claimId);
    }

    /// @notice Take `amount` of a reviewer's bond after a disputed approval, and pay it to the DAO. The DAO votes this
    /// like any treasury-scale action; nobody else can.
    function slashReviewer(address reviewer, uint256 amount) external onlyDAO nonReentrant {
        uint256 taken = verifiers.slash(reviewer, amount);
        if (taken != 0 && reviewerBond != 0) IERC20(reviewerBondToken).safeTransfer(dao, taken);
        emit ReviewerSlashed(reviewer, taken);
    }

    /// @notice Unwind a frozen claim without taking money already paid.
    function resolveFrozenClaim(bytes32 claimId) external onlyDAO {
        claims.resolveFrozen(claimId);
    }

    /// @notice Unrestricted DAO governance can stop new commitments and recover
    /// unused currency early. Existing claim escrows retain their settlement rules.
    function close() external onlyDAO nonReentrant {
        closed = true;
        emit MandateClosed();
        _returnUnused();
    }

    /// @notice After the mandate ends, anyone can return its unreserved funds
    /// to the DAO. Individual claim reservations remain in the claim escrow.
    function returnUnused() external nonReentrant {
        if (!closed && block.timestamp < expiresAt) revert InvalidMandate();
        _returnUnused();
    }

    function _returnUnused() private {
        uint256 amount = currency.balanceOf(address(this));
        currency.safeTransfer(dao, amount);
        emit UnusedReturned(amount);
    }
}

/// @notice Provenance for bounded voting targets. The factory only records its
/// own immutable mandates, with the caller as their governing DAO.
contract TreasuryMandateFactory {
    using SafeERC20 for IERC20;
    mapping(address => address) public daos;
    /// @notice The mandate a DAO named, when it was born, as the panel that judges the milestones its team's Shares are
    /// locked behind (zero for a DAO that named none). Set once, by the DAO itself; the milestone lock honours no other.
    mapping(address => address) public milestoneMandate;
    error FundingMismatch();
    error PanelAlreadyNamed();
    event MandateCreated(
        address indexed dao,
        address indexed mandate,
        address currency,
        uint128 budget,
        uint128 perProjectCap,
        uint128 shareBudget,
        uint128 perProjectShareCap
    );
    event MilestonePanelNamed(address indexed dao, address indexed mandate);

    /// @notice Create and fund a mandate atomically via a broadly approved DAO
    /// action. The DAO first approves this factory for exactly the budget.
    /// Currencies that deliver less than the requested amount fail closed.
    /// A mandate with no currency budget (Shares only) needs no approval and moves no money.
    function create(
        address currency,
        uint128 budget,
        uint128 cap,
        uint128 shareBudget,
        uint128 shareCap,
        uint64 expires,
        address[] calldata reviewers,
        uint256 quorum,
        uint128 reviewerBond,
        address bondToken
    ) external returns (TreasuryMandate mandate) {
        mandate = _make(
            currency, budget, cap, shareBudget, shareCap, expires, reviewers, quorum, reviewerBond, bondToken, false
        );
    }

    /// @notice The DAO names, once, the panel that judges its team's milestones. It is a mandate that moves no money and
    /// awards no Shares (its projects hold nothing); it exists for its reviewers, their bond and the claims they judge. Called from the DAO's own initialization, so the
    /// panel is part of the terms the backers see before they buy, and no later vote can change it.
    function createMilestonePanel(
        address currency,
        uint64 expires,
        address[] calldata reviewers,
        uint256 quorum,
        uint128 reviewerBond,
        address bondToken
    ) external returns (TreasuryMandate mandate) {
        if (milestoneMandate[msg.sender] != address(0)) revert PanelAlreadyNamed();
        mandate = _make(currency, 0, 0, 0, 0, expires, reviewers, quorum, reviewerBond, bondToken, true);
        milestoneMandate[msg.sender] = address(mandate);
        emit MilestonePanelNamed(msg.sender, address(mandate));
    }

    function _make(
        address currency,
        uint128 budget,
        uint128 cap,
        uint128 shareBudget,
        uint128 shareCap,
        uint64 expires,
        address[] calldata reviewers,
        uint256 quorum,
        uint128 reviewerBond,
        address bondToken,
        bool milestonePanel
    ) private returns (TreasuryMandate mandate) {
        mandate = new TreasuryMandate(
            msg.sender,
            currency,
            budget,
            cap,
            shareBudget,
            shareCap,
            expires,
            reviewers,
            quorum,
            reviewerBond,
            bondToken,
            milestonePanel
        );
        if (budget != 0) {
            IERC20(currency).safeTransferFrom(msg.sender, address(mandate), budget);
            if (IERC20(currency).balanceOf(address(mandate)) != budget) revert FundingMismatch();
        }
        daos[address(mandate)] = msg.sender;
        emit MandateCreated(msg.sender, address(mandate), currency, budget, cap, shareBudget, shareCap);
    }
}
