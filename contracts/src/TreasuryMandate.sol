// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ClaimStake} from "./ClaimStake.sol";
import {VerifierSet} from "./VerifierSet.sol";

/// @notice A DAO-approved, finite spending mandate. Team managers reserve
/// milestone payments; independent reviewers and a challenge window release them.
/// Returned funds never silently replenish the mandate's allocation authority.
contract TreasuryMandate {
    using SafeERC20 for IERC20;

    address public immutable dao;
    IERC20 public immutable currency;
    uint128 public immutable budget;
    uint128 public immutable perProjectCap;
    uint64 public immutable expiresAt;
    VerifierSet public immutable verifiers;
    ClaimStake public immutable claims;
    uint128 public allocated;
    bool public closed;
    bool private entered;

    struct Project {
        address manager;
        uint128 budget;
        uint128 reserved;
        uint64 expiresAt;
        bytes32 checkHash;
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
        bytes32 indexed projectId, address indexed manager, uint128 amount, uint64 expiresAt, bytes32 checkHash
    );
    event MilestoneReserved(bytes32 indexed projectId, bytes32 indexed claimId, uint128 amount);
    event ContributionConsumed(bytes32 indexed claimId, address indexed contributor);
    event UnusedReturned(uint256 amount);
    event MandateClosed();

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
        uint64 expires_,
        address[] memory reviewers,
        uint256 quorum
    ) {
        if (
            dao_.code.length == 0 || currency_.code.length == 0 || budget_ == 0 || cap_ == 0 || cap_ > budget_
                || expires_ <= block.timestamp || reviewers.length > 32 || quorum == 0 || quorum > reviewers.length
        ) revert InvalidMandate();
        dao = dao_;
        currency = IERC20(currency_);
        budget = budget_;
        perProjectCap = cap_;
        expiresAt = expires_;
        VerifierSet panel = new VerifierSet(address(this), quorum);
        verifiers = panel;
        claims = new ClaimStake(panel, address(this), currency_);
        panel.setClaimStake(address(claims));
        for (uint256 i; i < reviewers.length; ++i) {
            if (reviewers[i] == address(0)) revert InvalidMandate();
            panel.acceptVerifier(reviewers[i]);
        }
    }

    /// @notice The one operation eligible for bounded-project voting. Its total
    /// lifetime authority and each project remain limited by the parent mandate.
    function approveProject(bytes32 id, address manager, uint128 amount, uint64 expires, bytes32 checkHash)
        external
        onlyDAO
    {
        if (
            id == bytes32(0) || projects[id].manager != address(0) || manager == address(0) || checkHash == bytes32(0)
                || closed || block.timestamp >= expiresAt || expires <= block.timestamp || expires > expiresAt
        ) revert InvalidProject();
        if (amount == 0 || amount > perProjectCap || uint256(allocated) + amount > budget) revert BudgetExceeded();
        allocated += amount;
        projects[id] = Project(manager, amount, 0, expires, checkHash);
        emit ProjectApproved(id, manager, amount, expires, checkHash);
    }

    /// @notice Reserve a submitted claim within a team's approved project.
    /// Funding binds its acceptance check before any payment can be released.
    function fundMilestone(bytes32 projectId, bytes32 claimId) external nonReentrant {
        Project storage project = projects[projectId];
        if (
            msg.sender != project.manager || closed || block.timestamp >= project.expiresAt
                || block.timestamp >= expiresAt
        ) revert Unauthorized();
        if (claimProject[claimId] != bytes32(0)) revert InvalidClaim();
        (address contributor, uint256 amount, bytes32 checkHash, ClaimStake.Status status) = claims.claimTerms(claimId);
        if (contributor == address(0) || status != ClaimStake.Status.Open || checkHash != project.checkHash) {
            revert InvalidClaim();
        }
        if (amount == 0 || amount > uint256(project.budget) - project.reserved) revert BudgetExceeded();
        project.reserved += uint128(amount);
        claimProject[claimId] = projectId;
        claims.lockCheck(claimId, project.checkHash);
        currency.forceApprove(address(claims), amount);
        claims.fund(claimId, amount);
        currency.forceApprove(address(claims), 0);
        emit MilestoneReserved(projectId, claimId, uint128(amount));
    }

    /// @notice Consume evidence of a paid delivery once, before the DAO awards
    /// Shares or converts the contributor's Loot through its sole governor.
    function consumeContribution(bytes32 claimId) external onlyDAO returns (address contributor) {
        if (claimProject[claimId] == bytes32(0) || contributionAwarded[claimId]) revert InvalidClaim();
        ClaimStake.Status status;
        (contributor,,, status) = claims.claimTerms(claimId);
        if (status != ClaimStake.Status.Paid) revert InvalidClaim();
        contributionAwarded[claimId] = true;
        emit ContributionConsumed(claimId, contributor);
    }

    /// @notice A disputed payment can be frozen by the same DAO governance.
    function freezeClaim(bytes32 claimId) external onlyDAO {
        claims.freeze(claimId);
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
    error FundingMismatch();
    event MandateCreated(
        address indexed dao, address indexed mandate, address currency, uint128 budget, uint128 perProjectCap
    );

    /// @notice Create and fund a mandate atomically via a broadly approved DAO
    /// action. The DAO first approves this factory for exactly the budget.
    /// Currencies that deliver less than the requested amount fail closed.
    function create(
        address currency,
        uint128 budget,
        uint128 cap,
        uint64 expires,
        address[] calldata reviewers,
        uint256 quorum
    ) external returns (TreasuryMandate mandate) {
        mandate = new TreasuryMandate(msg.sender, currency, budget, cap, expires, reviewers, quorum);
        IERC20(currency).safeTransferFrom(msg.sender, address(mandate), budget);
        if (IERC20(currency).balanceOf(address(mandate)) != budget) revert FundingMismatch();
        daos[address(mandate)] = msg.sender;
        emit MandateCreated(msg.sender, address(mandate), currency, budget, cap);
    }
}
