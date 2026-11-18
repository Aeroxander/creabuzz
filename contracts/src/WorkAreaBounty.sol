// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ClaimStake} from "./ClaimStake.sol";
import {TreasuryMandate, TreasuryMandateFactory} from "./TreasuryMandate.sol";

/// @title WorkAreaBounty
/// @notice Outside money behind a work area (docs/v3-review/NEXT-GEN-DAO.md, N1). Anyone adds the currency to a work area
/// of a work budget (a project in a `TreasuryMandate`) until a deadline. The project's own review decides, exactly as it
/// does for Shares: once a submission bound to that work area was released by the deadline and its challenge window
/// has passed while it is still approved (or paid), anyone can settle, and the whole pot goes to that submission's
/// contributor. If nothing settles in time, every funder takes back what they put in.
///
/// Why there is no vote here: funders rely on the project's reviewers, under the same independence rules as every
/// claim (D39), and on the DAO's freeze during the challenge window. A frozen, rejected or expired submission never
/// pays a bounty.
///
/// The two endings cannot overlap. Settling needs `block.timestamp < refundsFrom`; a refund needs
/// `block.timestamp >= refundsFrom` and no settlement. `refundsFrom` is the deadline plus the budget's challenge window
/// plus `SETTLE_GRACE`, so a submission released at the very deadline still has `SETTLE_GRACE` to be settled.
///
/// The books of each bounty stand alone: `total = paid + refunded + still held`, where a settled bounty pays its whole
/// `total` in the settling call. Each funder's refund is sent to that funder alone, so a funder the currency refuses
/// to pay never blocks anyone else; a contributor it refuses to pay cannot be settled, and the funders are refunded.
///
/// No admin, no pause, no fee: nothing can move money except settling and refunding as described.
contract WorkAreaBounty {
    using SafeERC20 for IERC20;

    /// @notice After the deadline and the challenge window, how long a released submission can still be settled before
    /// the funders may take their money back.
    uint64 public constant SETTLE_GRACE = 14 days;

    IERC20 public immutable currency;
    /// @notice The work budget factory: only budgets it made (and so a real DAO governs) can be funded.
    TreasuryMandateFactory public immutable factory;

    struct Bounty {
        address mandate;
        uint64 openedAt;
        uint64 deadline;
        bytes32 projectId;
        /// @dev The budget's challenge window when the bounty opened, pinned so the terms never move under the funders.
        uint64 window;
        uint64 refundsFrom;
        uint128 total;
        uint128 refunded;
        /// @dev The submission that was paid, or zero.
        bytes32 paidClaim;
        address contributor;
    }

    uint256 public bountyCount;
    mapping(uint256 => Bounty) public bounties;
    mapping(uint256 => mapping(address => uint128)) public fundedBy;
    bool private entered;

    error InvalidSetup();
    error NotAWorkBudget(address mandate);
    error NoSuchWorkArea(bytes32 projectId);
    error BadDeadline(uint64 deadline);
    error NothingToFund();
    error UnknownBounty(uint256 id);
    error FundingClosed(uint256 id);
    error ShortTransfer(uint256 expected, uint256 received);
    error AlreadyPaid(uint256 id);
    error SettleTooLate(uint256 id, uint64 refundsFrom);
    error NotThisWorkArea(bytes32 claimId);
    error NotAccepted(bytes32 claimId);
    error ReleasedOutsideBounty(bytes32 claimId, uint64 releasedAt);
    error InChallengeWindow(bytes32 claimId, uint64 payableAt);
    error RefundsNotOpen(uint256 id, uint64 refundsFrom);
    error NothingToRefund(uint256 id, address funder);
    error Reentrancy();

    event BountyOpened(
        uint256 indexed id,
        address indexed mandate,
        bytes32 indexed projectId,
        address opener,
        uint64 deadline,
        uint64 refundsFrom
    );
    event Funded(uint256 indexed id, address indexed funder, uint256 amount, uint256 total);
    event BountyPaid(uint256 indexed id, bytes32 indexed claimId, address indexed contributor, uint256 amount);
    event Refunded(uint256 indexed id, address indexed funder, uint256 amount);

    modifier nonReentrant() {
        if (entered) revert Reentrancy();
        entered = true;
        _;
        entered = false;
    }

    constructor(IERC20 currency_, TreasuryMandateFactory factory_) {
        if (address(currency_).code.length == 0 || address(factory_).code.length == 0) revert InvalidSetup();
        currency = currency_;
        factory = factory_;
    }

    /// @notice Open a bounty on work area `projectId` of `mandate`, funded with `amount`, paying a submission released
    /// by `deadline` (at most the work area's own expiry: after it, nothing new can be bound to the work area).
    function open(address mandate, bytes32 projectId, uint64 deadline, uint256 amount)
        external
        nonReentrant
        returns (uint256 id)
    {
        if (factory.daos(mandate) == address(0)) revert NotAWorkBudget(mandate);
        (address manager,,, uint64 expiresAt,,,) = TreasuryMandate(mandate).projects(projectId);
        if (manager == address(0)) revert NoSuchWorkArea(projectId);
        if (deadline <= block.timestamp || deadline > expiresAt) revert BadDeadline(deadline);
        if (amount == 0) revert NothingToFund();
        uint64 window = TreasuryMandate(mandate).claims().challengeWindow();
        id = ++bountyCount;
        uint64 refundsFrom = deadline + window + SETTLE_GRACE;
        bounties[id] = Bounty({
            mandate: mandate,
            openedAt: uint64(block.timestamp),
            deadline: deadline,
            projectId: projectId,
            window: window,
            refundsFrom: refundsFrom,
            total: 0,
            refunded: 0,
            paidClaim: bytes32(0),
            contributor: address(0)
        });
        emit BountyOpened(id, mandate, projectId, msg.sender, deadline, refundsFrom);
        _fund(id, amount);
    }

    /// @notice Add `amount` to bounty `id`, before its deadline and before it paid. The money stays until the bounty pays
    /// or refunds.
    function fund(uint256 id, uint256 amount) external nonReentrant {
        Bounty storage b = _bounty(id);
        if (block.timestamp >= b.deadline || b.paidClaim != bytes32(0)) revert FundingClosed(id);
        if (amount == 0) revert NothingToFund();
        _fund(id, amount);
    }

    /// @notice Pay bounty `id` to the contributor of submission `claimId`: bound to this work area, released while the
    /// bounty was open (from its opening to its deadline, both included), its challenge window over, and still approved
    /// or paid. Anyone may call it; the first submission to settle takes the whole pot.
    function settle(uint256 id, bytes32 claimId) external nonReentrant {
        Bounty storage b = _bounty(id);
        if (b.paidClaim != bytes32(0)) revert AlreadyPaid(id);
        if (block.timestamp >= b.refundsFrom) revert SettleTooLate(id, b.refundsFrom);
        TreasuryMandate mandate = TreasuryMandate(b.mandate);
        if (mandate.claimProject(claimId) != b.projectId) revert NotThisWorkArea(claimId);
        (address contributor,,, ClaimStake.Status status,,,, uint64 releasedAt) = mandate.claims().claims(claimId);
        if (status != ClaimStake.Status.Approved && status != ClaimStake.Status.Paid) revert NotAccepted(claimId);
        if (releasedAt < b.openedAt || releasedAt > b.deadline) revert ReleasedOutsideBounty(claimId, releasedAt);
        uint64 payableAt = releasedAt + b.window;
        if (block.timestamp < payableAt) revert InChallengeWindow(claimId, payableAt);
        uint256 amount = b.total;
        b.paidClaim = claimId;
        b.contributor = contributor;
        emit BountyPaid(id, claimId, contributor, amount);
        currency.safeTransfer(contributor, amount);
    }

    /// @notice Send `funder` back everything they put into bounty `id`, once refunds are open and the bounty never paid.
    /// Anyone may call it; the money only ever goes to the funder.
    function refund(uint256 id, address funder) external nonReentrant {
        Bounty storage b = _bounty(id);
        if (b.paidClaim != bytes32(0)) revert AlreadyPaid(id);
        if (block.timestamp < b.refundsFrom) revert RefundsNotOpen(id, b.refundsFrom);
        uint128 amount = fundedBy[id][funder];
        if (amount == 0) revert NothingToRefund(id, funder);
        fundedBy[id][funder] = 0;
        b.refunded += amount;
        emit Refunded(id, funder, amount);
        currency.safeTransfer(funder, amount);
    }

    /// @notice What bounty `id` still holds: its total until it pays, less what was refunded; zero once paid.
    function held(uint256 id) external view returns (uint256) {
        Bounty storage b = bounties[id];
        return b.paidClaim != bytes32(0) ? 0 : b.total - b.refunded;
    }

    function _bounty(uint256 id) private view returns (Bounty storage b) {
        b = bounties[id];
        if (b.mandate == address(0)) revert UnknownBounty(id);
    }

    function _fund(uint256 id, uint256 amount) private {
        if (amount > type(uint128).max) revert NothingToFund();
        Bounty storage b = bounties[id];
        uint256 before = currency.balanceOf(address(this));
        currency.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = currency.balanceOf(address(this)) - before;
        // A currency that keeps a fee would leave the books promising more than is held.
        if (received != amount) revert ShortTransfer(amount, received);
        uint128 added = uint128(amount);
        fundedBy[id][msg.sender] += added;
        b.total += added;
        emit Funded(id, msg.sender, amount, b.total);
    }
}
