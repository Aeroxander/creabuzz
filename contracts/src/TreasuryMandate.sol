// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ClaimStake} from "./ClaimStake.sol";
import {VerifierSet} from "./VerifierSet.sol";
import {MandatePartsFactory} from "./MandatePartsFactory.sol";
import {PayoutsFactory} from "./Payouts.sol";
import {FundingTerms} from "./FundingTerms.sol";

interface IMandateDao {
    function shares() external view returns (address);
}

interface IMandateShares {
    function lockGuard() external view returns (address);
}

interface IMandateLock {
    function trancheCount(address beneficiary) external view returns (uint256);
    function isOpenMilestone(address beneficiary, bytes32 checkHash) external view returns (bool);
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

    /// @notice How long after a claim is approved before its payout (and a milestone's unlock) can be taken. A freeze is a
    /// DAO decision, and the slowest vote takes 48 hours of review and a day of execution delay before it can run, so the
    /// window must be well past three days or a problem noticed after approval could never be stopped in time.
    uint64 internal constant CHALLENGE_WINDOW = 7 days;
    /// @notice The stand-in "project" every milestone claim in the panel is bound to: a milestone needs no project, because
    /// the lock names the milestone and its exact words and the panel's reviewers judge it.
    bytes32 internal constant MILESTONE_PROJECT = keccak256("creaton.milestone");

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
    address internal immutable reviewerBondToken;
    uint64 public immutable expiresAt;
    /// @notice Whether this is a DAO's milestone panel: no budgets, and projects that hold nothing.
    bool internal immutable milestonePanel;
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

    // ── Agreed contribution rewards (docs/v3-review/AWARD-MECHANICS-SPEC.md; not deployed) ─────────────
    /// @notice An agreed contribution: terms proposed by a project's manager, accepted (and reserved) by the exact
    /// beneficiary it names, judged by the mandate's own panel over one submission at a time, and settled by anyone
    /// in exactly the quantity the record reserved. Offchain description text is not enforced; everything here is.
    struct Agreement {
        bytes32 projectId;
        address beneficiary;
        /// @notice The exact Share quantity reserved at acceptance. The value of those Shares is never promised.
        uint128 shares;
        /// @notice The acceptance check the panel judges this work against, fixed from the project's own check.
        bytes32 criteriaHash;
        /// @notice Reference to the configured panel policy (offchain descriptor; not enforced onchain).
        bytes32 policyRef;
        /// @notice When the beneficiary accepted, reserving `shares`. Zero: proposed, not yet agreed.
        uint64 acceptedAt;
        /// @notice The review period this agreement agreed to (per attempt, applied at bind; candidate constant
        /// below, disclosed before any substantive effort by display of the accepted terms).
        uint64 reviewPeriod;
        /// @notice The first attempt must be submitted by this moment; unsubmitted work past it is expired.
        uint64 workDeadline;
        /// @notice Reviewer-requested corrections may replace an attempt until this moment (`workDeadline` plus
        /// `CORRECTIONS_GRACE`); after it the last attempt must resolve with the review period it already carries.
        uint64 revisionDeadline;
        /// @notice The claim under review (zero until one is bound; a revision rebinds to a new one).
        bytes32 claimId;
        /// @notice 0: active; 1: settled; 2: cancelled; 3: expired (reservation released for 2 and 3).
        uint8 terminalKind;
        /// @notice How many attempts (submissions) this agreement has had; history stays in the claim escrow.
        uint32 attempts;
        /// @notice Canonical commitment to the declared coauthor split (`keccak256(abi.encode(parties, percentages))`;
        /// zero: the beneficiary takes it all). Fixed in the proposal, confirmed by acceptance — a split figures in
        /// the agreed terms both parties signed, never a reward invented at acceptance time.
        bytes32 splitHash;
    }

    /// @notice Split parties of one agreement, outside the struct so acceptance can write them at once. A split is
    /// part of the agreed terms: declared in the proposal, confirmed unchangeably at acceptance. Without a split,
    /// the beneficiary takes the whole agreement. Settlement pays the exact reserved quantity in total: each
    /// declared party takes its stated share rounded down, and the residual goes to the first party (the
    /// beneficiary), so no rounding dust is ever burnt or underpaid.
    struct Splits {
        /// @notice At most four declared parties, `percentages[i]` in basis points, the sum exactly 10000,
        /// and the beneficiary always the first party of a non-empty declaration.
        address[4] parties;
        uint16[4] percentages;
        uint8 count;
    }

    uint256 internal constant SPLIT_MAX_PARTIES = 4;
    uint256 internal constant SPLIT_ALL = 10000;
    /// @notice Candidate parameter (AWARD-MECHANICS-SPEC): reviewer-requested corrections may replace an attempt
    /// for this long after the work deadline; after that the last attempt resolves with the review period it was
    /// bound with, and the agreement releases only on a terminal unapproved attempt or its own resolution — work
    /// under correction is never silently cancelled.
    uint64 internal constant CORRECTIONS_GRACE = 14 days;
    /// @notice Candidate parameter (AWARD-MECHANICS-SPEC, disclosed at acceptance): one attempt's review must
    /// conclude within this period of its bind. Bind pins the claim's own lapse to it (`ClaimStake.setExpiry`), so
    /// an unreviewed attempt expires by itself (stake returned; the unearned reservation releases by explicit
    /// action). Absence, split deadlock and unavailable reviewers recover through the DAO's existing dispute/
    /// freeze resolution or new mutually accepted terms — the panel itself is never silently replaced, and nothing
    /// accepts automatically. The UI labels voluntary review, this deadline and the actual next step.
    uint64 public constant REVIEW_PERIOD = 7 days;
    uint256 internal constant SETTLED = 1;
    uint256 internal constant CANCELLED = 2;
    uint256 internal constant EXPIRED = 3;

    mapping(bytes32 agreementId => Agreement) public agreements;
    /// @notice The declared split of each agreement (empty when the beneficiary takes it all).
    mapping(bytes32 agreementId => Splits) public splits;
    /// @notice Outstanding reservation of the work area's own ceiling: reserved but neither settled nor released.
    mapping(bytes32 projectId => uint128) public sharesReserved;
    /// @notice Outstanding reservations across the whole mandate.
    uint128 public sharesReservedTotal;
    /// @notice Shares this mandate has caused to be awarded in all (discretionary and agreed paths together),
    /// for the aggregate ceiling check. Never replenished.
    uint128 public mandateSharesAwarded;
    /// @notice The agreement a submission was bound to, kept forever: history preserves superseded attempts, and no
    /// superseded delivery can ever be consumed by the discretionary lane instead.
    mapping(bytes32 claimId => bytes32 agreementId) public agreementOfClaim;

    /// @notice No agreement exists under this id (or the slot was spent on another one).
    error UnknownAgreement(bytes32 agreementId);
    /// @notice The codec a declared split must be: at most `SPLIT_MAX_PARTIES` distinct, real parties that are not
    /// the project's manager, exact percentages, quantities the agreement's own quantity can carry (every part at
    /// least one whole unit), and — once the proposal committed a split — the very declaration the proposal hashed.
    error BadSplit();
    /// @notice The attempt meant here cannot be bound any more: past its deadline, its live review is not in a
    /// corrections route, or it was already consumed.
    error NotSubmittable();

    /// @notice Identity, quantity and timing in one event; `criteriaHash`, `policyRef` and `reviewPeriod` are
    /// permanent on the record (`agreement0s(id)`), so the emit stays the allocation-free announcement.
    event AgreementProposed(
        bytes32 indexed agreementId,
        bytes32 indexed projectId,
        address indexed beneficiary,
        uint128 shares,
        uint64 workDeadline,
        uint64 revisionDeadline,
        bytes32 splitHash
    );
    event AgreementAccepted(bytes32 indexed agreementId, address indexed beneficiary, uint128 shares);
    event AgreementBound(bytes32 indexed agreementId, bytes32 indexed claimId, uint32 attempt, uint64 reviewDeadline);
    event AgreementReleased(bytes32 indexed agreementId, uint8 kind, uint128 shares);
    event AgreementSettled(
        bytes32 indexed agreementId, bytes32 indexed claimId, address indexed beneficiary, uint128 shares
    );

    /// @notice Interface marker for readers that must distinguish a mandate carrying the agreed-rewards flow from
    /// one without it. A call that REVERTS means the deployment predates this flow (a legacy deployed budget) —
    /// it must never be read as "supports it, with nothing in it" and not as a failed read implying legacy either;
    /// treat a failed read as an RPC failure and retry, never as an answer.
    function AGREEMENTS_VERSION() external pure returns (uint16) {
        return 1;
    }

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
        bool milestonePanel_,
        MandatePartsFactory parts
    ) {
        // Each budget is all-or-nothing: a cap with no budget (or a budget with no cap) cannot be spent sensibly.
        if (
            dao_.code.length == 0 || currency_.code.length == 0 || (budget_ == 0) != (cap_ == 0) || cap_ > budget_
                || (shareBudget_ == 0) != (shareCap_ == 0) || shareCap_ > shareBudget_
                // Something to spend, unless this is the panel that only judges (then there must be nothing).
                || (budget_ == 0 && shareBudget_ == 0) != milestonePanel_ || expires_ <= block.timestamp
                || reviewers.length > 32 || quorum == 0 || quorum > reviewers.length
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
        // The panel and the escrow come from a separate factory (the budget factory would not fit under the size limit
        // with their code inside); this budget owns both.
        (VerifierSet panel, ClaimStake escrow) = parts.make(address(this), quorum, currency_);
        verifiers = panel;
        claims = escrow;
        claims.setWindows(30 days, CHALLENGE_WINDOW); // an unapproved claim still lapses after 30 days, as before
        panel.setClaimStake(address(claims));
        // New panels judge bound deliveries only: no reviewer weight lands before their check is bound and the
        // payment exclusions are installed (one transaction at bind time). Standalone/legacy sets are untouched.
        panel.setBoundReviews();
        if (reviewerBond_ != 0) panel.setBond(bondToken_, reviewerBond_);
        for (uint256 i; i < reviewers.length; ++i) {
            // A team member whose Shares a milestone lock holds cannot sit on the panel that judges the milestones.
            if (reviewers[i] == address(0) || _isLockedTeamMember(dao_, reviewers[i])) revert InvalidMandate();
            panel.acceptVerifier(reviewers[i]);
        }
    }

    /// @dev The lock guard of `dao_`'s Shares, or zero. A DAO without Shares or a guard, or a caller that is not a DAO at
    /// all, has none; a mandate made by a stranger carries no authority over a real DAO (the lock only honours mandates the
    /// DAO's own factory made for it), so being lenient here is harmless.
    function _guardOf(address dao_) private view returns (address guard) {
        try IMandateDao(dao_).shares() returns (address shares_) {
            try IMandateShares(shares_).lockGuard() returns (address g) {
                return g;
            } catch {}
        } catch {}
    }

    /// @dev Whether the DAO's lock names `who` as a beneficiary.
    function _isLockedTeamMember(address dao_, address who) private view returns (bool) {
        address guard = _guardOf(dao_);
        if (guard == address(0)) return false;
        try IMandateLock(guard).trancheCount(who) returns (uint256 n) {
            return n != 0;
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
            (amount == 0 && shareAmount == 0 && !milestonePanel) || amount > perProjectCap
                || uint256(allocated) + amount > budget || shareAmount > perProjectShareCap
                || uint256(sharesAllocated) + shareAmount > shareBudget
        ) revert BudgetExceeded();
        allocated += amount;
        sharesAllocated += shareAmount;
        projects[id] = Project(manager, amount, 0, expires, checkHash, shareAmount, 0);
        emit ProjectApproved(id, manager, amount, shareAmount, expires, checkHash);
    }

    /// @notice A team member files their own milestone claim into the panel: no vote and no manager. In the milestone panel
    /// only, and only for a claim that
    ///  - is theirs, asks for no money, and is still open;
    ///  - states, as its check, the exact words of one of their tranches the lock has not yet freed or given up.
    /// The lock is what names the milestone, so nothing else needs to approve it before the reviewers judge it; the reviewers
    /// still have to approve it, and it still waits out the challenge window before the lock will honour it.
    function bindMilestone(bytes32 claimId) external {
        if (!milestonePanel) revert Unauthorized();
        if (closed || block.timestamp >= expiresAt || claimProject[claimId] != bytes32(0)) revert InvalidClaim();
        (address contributor, uint256 amount, bytes32 checkHash, ClaimStake.Status status) = claims.claimTerms(claimId);
        if (
            msg.sender != contributor || contributor == address(0) || amount != 0 || status != ClaimStake.Status.Open
                || checkHash == bytes32(0) || !_hasOpenMilestone(contributor, checkHash)
        ) revert InvalidClaim();
        claimProject[claimId] = MILESTONE_PROJECT;
        claims.lockCheck(claimId, checkHash);
    }

    /// @dev Whether the DAO's lock holds a tranche of `who` worded `checkHash` that is neither freed nor given up. A DAO
    /// with no lock has no milestone, and a panel is only ever made by a DAO that has Shares.
    function _hasOpenMilestone(address who, bytes32 checkHash) private view returns (bool) {
        address guard = IMandateShares(IMandateDao(dao).shares()).lockGuard();
        return guard != address(0) && IMandateLock(guard).isOpenMilestone(who, checkHash);
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
        (address contributor, uint256 amount) = _reserveClaim(project, projectId, claimId, expectedContributor);
        if (amount > uint256(project.budget) - project.reserved) revert BudgetExceeded();
        project.reserved += uint128(amount);
        if (amount != 0) {
            currency.forceApprove(address(claims), amount);
            claims.fund(claimId, amount);
            currency.forceApprove(address(claims), 0);
        }
        emit MilestoneReserved(projectId, claimId, uint128(amount));
    }

    /// @dev The binding all deliveries share: the claim is open, states `project.checkHash`, and belongs to
    /// `expectedContributor` (a claim id belongs to whoever filed it first, so the manager names the contributor
    /// they mean and a claim filed by anyone else is refused). Writing `claimProject` and locking the check commits
    /// the work area before any attestation; the caller emits its own event and funds the escrow itself.
    function _reserveClaim(Project storage project, bytes32 projectId, bytes32 claimId, address expectedContributor)
        private
        returns (address contributor, uint256 amount)
    {
        if (claimProject[claimId] != bytes32(0)) revert InvalidClaim();
        bytes32 checkHash;
        ClaimStake.Status status;
        (contributor, amount, checkHash, status) = claims.claimTerms(claimId);
        if (
            contributor == address(0) || contributor != expectedContributor || status != ClaimStake.Status.Open
                || checkHash != project.checkHash
        ) revert InvalidClaim();
        claimProject[claimId] = projectId;
        claims.lockCheck(claimId, project.checkHash);
    }

    /// @notice Consume evidence of a delivery once, counting `shares` against its project's share budget, before
    /// the DAO awards Shares or converts the contributor's Loot through its sole governor. A claim is `Paid` once
    /// its reviewers approved it and its challenge window passed. A claim that asked for no currency and is still
    /// `Approved` is finished here, in the same call (which fails inside its challenge window); one that asked for
    /// currency must have been paid to its contributor first. A closed mandate awards nothing more.
    function consumeContribution(bytes32 claimId, uint128 shares) external onlyDAO returns (address contributor) {
        bytes32 projectId = claimProject[claimId];
        // Closing a mandate stops what it can still cause: no new projects, and no more Shares from its allowances.
        if (closed || projectId == bytes32(0) || contributionAwarded[claimId]) revert InvalidClaim();
        // An agreed (or superseded agreed) delivery has ONE award path, its own terms-bound settlement: the
        // discretionary vote can never eat a promised entitlement, whole or in part.
        if (agreementOfClaim[claimId] != bytes32(0)) revert InvalidClaim();
        uint256 amount;
        ClaimStake.Status status;
        (contributor, amount,, status) = claims.claimTerms(claimId);
        bool finish = status == ClaimStake.Status.Approved && amount == 0;
        if (status != ClaimStake.Status.Paid && !finish) revert InvalidClaim();
        Project storage project = projects[projectId];
        if (
            shares == 0 || uint256(project.sharesAwarded) + sharesReserved[projectId] + shares > project.shareBudget
                || uint256(mandateSharesAwarded) + sharesReservedTotal + shares > shareBudget
        ) revert BudgetExceeded();
        project.sharesAwarded += shares;
        mandateSharesAwarded += shares;
        contributionAwarded[claimId] = true;
        emit ContributionConsumed(claimId, contributor, shares);
        if (finish) claims.payout(claimId);
    }

    // ── Agreed contribution rewards ─────────────────────────────────────────────────────────────────────
    /// @notice Terms for an agreed contribution, proposed by the manager of an approved project. Nothing is reserved
    /// until the exact beneficiary accepts (`acceptAgreement`), which is the moment the budget shows its answer.
    /// The work deadline, the revision window, the exact quantity, the check the panel will judge and the declared
    /// coauthor split (as a canonical hash the acceptance must confirm) are part of the terms. A user learns a
    /// budget is exhausted here, never after delivery.
    /// @param slot The canonical DELIVERABLE key within the work area: one slot is one deliverable, so one work
    /// offer cannot silently reach two beneficiaries — and distinct slots (or a declared split) are the explicit
    /// way several rewards belong to one work. Titles and similarity are not identity; the slot is.
    /// @param policyRef Reference to the configured panel policy (offchain descriptor, recorded but not enforced).
    /// @param splitHash `keccak256(abi.encode(parties, percentages))` of the split the manager commits as part of
    /// the terms; zero declares no split. The beneficiary confirms exactly this declaration at acceptance — new
    /// reward recipients can never appear later than both signatures.
    function proposeAgreement(
        bytes32 projectId,
        address beneficiary,
        uint128 shares,
        uint64 workDeadline,
        bytes32 slot,
        bytes32 policyRef,
        bytes32 splitHash
    ) external {
        Project storage project = projects[projectId];
        // The milestone panel is not on this path: its projects hold nothing and award no Shares.
        if (
            msg.sender != project.manager || closed || block.timestamp >= project.expiresAt
                || block.timestamp >= expiresAt || workDeadline <= block.timestamp || workDeadline > project.expiresAt
                || beneficiary == address(0) || beneficiary == project.manager || shares == 0
                // Beyond one chain-counter capacity: the Shares token stores supply in uint96, so anything the
                // chain could never mint in a single whole quantity is refused here, before any effort.
                || shares >> 96 != 0 || slot == bytes32(0)
        ) revert InvalidProject();
        bytes32 agreementId = keccak256(abi.encode(projectId, slot));
        if (agreements[agreementId].beneficiary != address(0)) revert InvalidProject();
        bytes32 criteriaHash = project.checkHash;
        uint64 revisionDeadline = workDeadline + CORRECTIONS_GRACE;
        agreements[agreementId] = Agreement(
            projectId,
            beneficiary,
            shares,
            criteriaHash,
            policyRef,
            0,
            REVIEW_PERIOD,
            workDeadline,
            revisionDeadline,
            bytes32(0),
            0,
            0,
            splitHash
        );
        emit AgreementProposed(agreementId, projectId, beneficiary, shares, workDeadline, revisionDeadline, splitHash);
    }

    /// @notice The beneficiary accepts their own agreement, now and forever before their work deadline. Acceptance is
    /// the financial moment: the project part manager agreed to is reserved atomically against both the work area's
    /// allowance and the mandate's Share budget (`awarded + outstanding reservations + this` within both), so
    /// concurrent acceptances cannot overcommit, and an exhausted budget ends here. A declared split must reproduce
    /// exactly what the proposal committed (`splitHash`) — the reward's recipients are terms both parties agreed.
    function acceptAgreement(bytes32 agreementId, address[] calldata parties, uint16[] calldata percentages)
        external
        nonReentrant
    {
        Agreement storage a = agreements[agreementId];
        if (a.beneficiary != msg.sender || a.terminalKind != 0 || a.acceptedAt != 0) {
            revert UnknownAgreement(agreementId);
        }
        Project storage project = projects[a.projectId];
        if (closed || block.timestamp >= a.workDeadline) revert InvalidProject();
        // The declared terms are checked first (shape, the proposal's own committed split hash), so a malformed
        // declaration refuses as terms, and only terms-shaped acceptances reach the budget answer.
        _declareSplit(a, project, agreementId, parties, percentages);
        // Acceptance is the financial moment: the quantity is reserved against BOTH ceilings — the work area's own
        // allowance (`awarded + outstanding + this`) and the mandate's lifetime budget — so concurrent acceptances
        // cannot overcommit, and an exhausted budget answers here, never after delivery.
        if (
            uint256(sharesReserved[a.projectId]) + project.sharesAwarded + a.shares > project.shareBudget
                || uint256(sharesReservedTotal) + mandateSharesAwarded + a.shares > shareBudget
        ) revert BudgetExceeded();
        sharesReserved[a.projectId] += a.shares;
        unchecked {
            sharesReservedTotal += a.shares; // bounded by the checks above
        }
        a.acceptedAt = uint64(block.timestamp);
        emit AgreementAccepted(agreementId, msg.sender, a.shares); // == a.beneficiary (checked above)
    }

    /// @dev Fix the split at AGREED by confirming the proposal's own commitment: coauthor shares are explicit and
    /// sum to exactly 100. Parts must name real, distinct people, nobody may reward the project's own manager off
    /// their beneficiary's reservation, and every part — and the residual that lands on the first party — must be
    /// at least one whole unit, so the exact total survives any indivisibility.
    function _declareSplit(
        Agreement storage a,
        Project storage project,
        bytes32 agreementId,
        address[] calldata parties,
        uint16[] calldata percentages
    ) private {
        uint256 count = parties.length;
        if (count != percentages.length || count > SPLIT_MAX_PARTIES) revert BadSplit();
        if (count == 0) {
            // The whole quantity to the beneficiary: only valid where the proposal declared no split.
            if (a.splitHash != bytes32(0)) revert BadSplit();
        } else {
            if (a.splitHash == bytes32(0) || keccak256(abi.encode(parties, percentages)) != a.splitHash) {
                revert BadSplit();
            }
            uint256 total;
            Splits storage s = splits[agreementId];
            for (uint256 i; i < count; ++i) {
                address party = parties[i];
                uint16 share = percentages[i];
                if (party == address(0) || party == project.manager || share == 0) revert BadSplit();
                for (uint256 j; j < i; ++j) {
                    if (parties[j] == party) revert BadSplit();
                }
                // Exactness: every declared part must carry at least one whole unit (an insignificant fraction of
                // the quantity cannot be promised in whole Shares), and the residual to the first party then also
                // carries at least one, because the declared percentages sum to exactly 10000.
                if (uint256(a.shares) * share < SPLIT_ALL) revert BadSplit();
                // The first declared party owns the work: the beneficiary accepts only their own agreement.
                if (i == 0 && party != a.beneficiary) revert BadSplit();
                s.parties[i] = party;
                s.percentages[i] = share;
                total += share;
            }
            if (total != SPLIT_ALL) revert BadSplit();
            s.count = uint8(count);
        }
    }

    /// @notice The project party binds one attempt — the manager, and the beneficiary alone, who may deliver what
    /// their own accepted agreement promised without a second handoff after the effort (the manager may still
    /// assist): the claim is the beneficiary's own, carries no currency ask (paid work runs the milestone path
    /// beside it) and states the agreed check, so there is no new discretion anywhere in the delivery step. A claim
    /// id belongs to a mandate forever, and its panel verdicts bind to that attempt: corrections may replace an
    /// OPEN attempt only while a reviewer has formally requested changes and no decision has landed (the non-final
    /// route — never a forced negative verdict); any replaced attempt is retired for good (terminal, its stake back
    /// unslashed, no verdict and no award, ever) and previous approvals never carry to the attempt that replaces
    /// it. Binding pins the attempt's review deadline (`REVIEW_PERIOD`) onto the claim's own expiration, so the
    /// review clock is part of the chain state.
    function bindSubmission(bytes32 agreementId, bytes32 claimId) external nonReentrant {
        Agreement storage a = agreements[agreementId];
        Project storage project = projects[a.projectId];
        if (
            msg.sender != a.beneficiary && msg.sender != project.manager || closed
                || block.timestamp >= project.expiresAt || block.timestamp >= expiresAt || a.terminalKind != 0
                || a.acceptedAt == 0
        ) revert Unauthorized();
        bool firstAttempt = a.claimId == bytes32(0);
        if (block.timestamp >= (firstAttempt ? a.workDeadline : a.revisionDeadline)) revert NotSubmittable();
        if (!firstAttempt) {
            (bool terminal, bool openCorrections) = _supersedeRoute(a);
            if (!terminal && !openCorrections) revert NotSubmittable();
            // Replace an open corrections-routed attempt atomically by retiring it (terminal: no verdict by
            // anyone else, the unslashed stake straight back or owed). A terminal attempt needs nothing.
            if (openCorrections) claims.retire(a.claimId);
        }
        (, uint256 claimAmount) = _reserveClaim(project, a.projectId, claimId, a.beneficiary);
        // The agreed reward is Shares: a claim that asks currency runs the paid milestone path beside this one.
        if (claimAmount != 0) revert InvalidClaim();
        // The review timing is a chain fact: this attempt's review must conclude within the agreed period, and the
        // claim itself now lapses on it (a treasury-only bounded move while the attempt is open).
        uint64 reviewDeadline = uint64(block.timestamp) + a.reviewPeriod;
        claims.setExpiry(claimId, reviewDeadline);
        _excludePayingParties(a, agreementId, claimId);
        a.claimId = claimId;
        agreementOfClaim[claimId] = agreementId;
        a.attempts++;
        emit AgreementBound(agreementId, claimId, a.attempts, reviewDeadline);
    }

    /// @dev The two ways an attempt may be replaced. Terminal (`true, false`): its own resolved-unapproved state —
    /// rejected, expired, unwound or retired by an earlier correction — owes no reward here and needs no touch.
    /// Open corrections route (`false, true`): the attempt is still open, its review window is unexpired, a
    /// reviewer has a formal `requestCorrections` on record (never an objection vote), no approval quorum stands,
    /// and it being replaces means retiring it: terminal, stake back unslashed, no verdict by anyone else.
    /// Anything else — paid (settle it), frozen (dispute), past the revision window, undiscussed — refuses.
    function _supersedeRoute(Agreement storage a) private view returns (bool terminal, bool openCorrections) {
        (,,, ClaimStake.Status status) = claims.claimTerms(a.claimId);
        terminal = status == ClaimStake.Status.Rejected || status == ClaimStake.Status.Expired
            || status == ClaimStake.Status.Recovered || status == ClaimStake.Status.Retired;
        if (terminal) return (true, false);
        if (status != ClaimStake.Status.Open) return (false, false);
        if (block.timestamp >= a.revisionDeadline) return (false, false);
        bool requested = verifiers.correctionsCount(a.claimId) != 0;
        bool decided = verifiers.approvalCount(a.claimId) >= verifiers.quorum();
        return (false, requested && !decided);
    }

    /// @dev The people a settlement of this agreement would pay — the declared split, or just the beneficiary —
    /// cannot sit in judgment on the claim that pays them.
    function _excludePayingParties(Agreement storage a, bytes32 agreementId, bytes32 claimId) private {
        uint256 count = splits[agreementId].count;
        address[] memory paying = new address[](count == 0 ? 1 : count);
        if (count == 0) {
            paying[0] = a.beneficiary;
        } else {
            Splits memory s = splits[agreementId];
            for (uint256 i; i < count; ++i) {
                paying[i] = s.parties[i];
            }
        }
        verifiers.excludeFromReview(claimId, paying);
    }

    /// @dev When the claim's approval released it (the challenge window starts there).
    function _releasedAt(bytes32 claimId) private view returns (uint64 released) {
        (,,,,,,, released) = claims.claims(claimId);
    }

    /// @notice Cancel (either party, before any submission) or expire (anyone, once the attempt is unrecoverable:
    /// unsubmitted past the work deadline or after the mandate ends, submitted and resolved unapproved): releases
    /// the reservation, never creating new lifetime mint authority. Submitted-but-alive work releases to nothing —
    /// it goes through the dispute path or runs its review; closure never touches it.
    /// @dev An unagreed DRAFT is tombstoned (slot spent, no reservation to subtract), not erased: identity stays.
    function releaseAgreement(bytes32 agreementId) external {
        Agreement storage a = agreements[agreementId];
        Project storage project = projects[a.projectId];
        // A proposal that nobody agreed to yet holds nothing; either party may take it off the board. Its id
        // (the work's deliverable slot) stays spent: the slot was offered with these terms.
        if (a.acceptedAt == 0 && a.terminalKind == 0) {
            if (a.beneficiary == address(0)) revert UnknownAgreement(agreementId);
            if (msg.sender != a.beneficiary && msg.sender != project.manager) revert Unauthorized();
            a.terminalKind = uint8(CANCELLED);
            emit AgreementReleased(agreementId, uint8(CANCELLED), 0);
            return;
        }
        if (a.terminalKind != 0) revert UnknownAgreement(agreementId);
        if (a.claimId == bytes32(0)) {
            // Unsubmitted work: either party cancels, and anyone may expire it once the deadline has passed or the
            // mandate itself has ended (nothing unbound can ever be earned by closed terms).
            bool expired = block.timestamp >= a.workDeadline;
            if (msg.sender != a.beneficiary && msg.sender != project.manager && !expired && !closed) {
                revert Unauthorized();
            }
            // One release: the reservation returns to both ceilings; nothing is paid and no mint authority appears.
            a.terminalKind = expired ? uint8(EXPIRED) : uint8(CANCELLED);
            sharesReserved[a.projectId] -= a.shares;
            unchecked {
                sharesReservedTotal -= a.shares;
            }
            emit AgreementReleased(agreementId, a.terminalKind, a.shares);
            return;
        }
        (,,, ClaimStake.Status status) = claims.claimTerms(a.claimId);
        // Submitted work releases ONLY when its attempt resolved unapproved on the record: rejected by the panel,
        // expired out of its own window, or unwound after a freeze (explicit dispute resolution). Closure, alone,
        // releases nothing that is still in flight — and a frozen claim, disputed or not, releases on nothing but
        // the attempt's own terminal state. Anything Approved (or already finished) belongs to the terms-bound
        // settlement, so the beneficiary keeps the road to their reward.
        if (
            status != ClaimStake.Status.Rejected && status != ClaimStake.Status.Expired
                && status != ClaimStake.Status.Recovered
        ) revert InvalidClaim();
        a.terminalKind = uint8(EXPIRED);
        sharesReserved[a.projectId] -= a.shares;
        unchecked {
            sharesReservedTotal -= a.shares;
        }
        emit AgreementReleased(agreementId, uint8(EXPIRED), a.shares);
    }

    /// @notice Settle an agreed contribution on its exact terms. Anyone may call the DAO's permissionless, one-time
    /// minted path (`Moloch.settleAgreement`); the recipient and the quantity are read from the record, not chosen:
    /// the claim must be the beneficiary's one current attempt (or Paid), approved past the challenge window, with
    /// no blocking dispute, and the agreement unconsumed. Accounting, finishing and consumption are one atomic step,
    /// and an already-earned entitlement survives a closed mandate. The mandate alone can enter here.
    function settleAgreement(bytes32 agreementId)
        external
        onlyDAO
        nonReentrant
        returns (address[] memory parties, uint256[] memory portions)
    {
        Agreement storage a = agreements[agreementId];
        if (a.beneficiary == address(0) || a.terminalKind != 0) revert UnknownAgreement(agreementId);
        bytes32 claimId = a.claimId;
        if (claimId == bytes32(0)) revert InvalidClaim();
        (,, bytes32 checkHash, ClaimStake.Status status) = claims.claimTerms(claimId);
        // The claim under review must still be the terms the agreement fixed: the beneficiary's work, checked
        // against the agreed criteria on its way through the panel. The claim's status decides: only an approved
        // (and window-elapsed) or already finished claim settles; open, rejected, frozen, unwound and expired
        // claims are refused and release instead.
        if (checkHash != a.criteriaHash) revert InvalidClaim();
        if (status != ClaimStake.Status.Approved && status != ClaimStake.Status.Paid) revert InvalidClaim();
        Project storage project = projects[a.projectId];
        project.sharesAwarded += a.shares;
        mandateSharesAwarded += a.shares;
        sharesReserved[a.projectId] -= a.shares;
        unchecked {
            sharesReservedTotal -= a.shares;
        }
        a.terminalKind = uint8(SETTLED);
        emit AgreementSettled(agreementId, claimId, a.beneficiary, a.shares);
        // Finish the claim if nobody did (anyone may, after the window): its own check refuses work inside the
        // window, so settlement waits out the challenge window with it.
        if (status == ClaimStake.Status.Approved) claims.payout(claimId);
        // The exact total: every declared party takes its stated share rounded down, and the residual goes to the
        // first party (the beneficiary), so the minted whole is exactly `a.shares` — no dust burnt, never a
        // different total, with the split fixed by the proposal hash at agreement time.
        uint256 count = splits[agreementId].count;
        if (count != 0) {
            Splits memory s = splits[agreementId];
            parties = new address[](count);
            portions = new uint256[](count);
            uint256 handedOut;
            // Exact total with a deterministic residual: parties 1..n-1 take their stated share rounded down, the
            // first party (the beneficiary) carries the residual: the whole minted is exactly `a.shares`, nothing
            // burnt, the split fixed by the proposal hash at agreement time.
            for (uint256 i; i < count; ++i) {
                parties[i] = s.parties[i];
                if (i != 0) {
                    portions[i] = uint256(a.shares) * s.percentages[i] / SPLIT_ALL;
                    handedOut += portions[i];
                }
            }
            portions[0] = uint256(a.shares) - handedOut;
        } else {
            parties = new address[](1);
            portions = new uint256[](1);
            parties[0] = a.beneficiary;
            portions[0] = a.shares;
        }
    }

    /// @notice The agreed-rewards version marker; see the event schema in AUDIT-SCOPE §13. Agreements are read
    /// through the `agreements` mapping and the events.
    enum AgreementState {
        None,
        DRAFT,
        AGREED,
        SUBMITTED,
        IN_REVIEW,
        CORRECTIONS,
        ACCEPTED,
        CHALLENGE_WINDOW,
        READY_TO_SETTLE,
        SETTLED,
        DISPUTED,
        CANCELLED,
        EXPIRED
    }

    /// @notice Where an agreement stands, derived from the record and its submission: `DRAFT` until the beneficiary
    /// accepts, `AGREED` once reserved, then the claim's own chain: `SUBMITTED` while the panel is untouched;
    /// `CORRECTIONS` the moment a reviewer has asked for changes without a decision (the non-final route — the spin
    /// `bindSubmission` offers shows in the record); `IN_REVIEW` once any verdict stands, or an objection quorum
    /// waits to be carried into the escrow; `ACCEPTED` once the approval quorum is on the record and the claim only
    /// waits to be settled; `CHALLENGE_WINDOW` while the accepted claim runs its window; `READY_TO_SETTLE` truthfully
    /// once the window has passed and the terms-bound settlement may run (also where a claim somebody already
    /// finished by `payout` waits — it is settleable, never back at `SUBMITTED`); `SETTLED` once consumed. The branch
    /// states: `DISPUTED` is the frozen claim, which blocks settlement and closure-release alike; `CANCELLED` and
    /// `EXPIRED` are the terminal releases. A mandate closure leaves this view standing.
    function agreementState(bytes32 agreementId) external view returns (AgreementState) {
        Agreement storage a = agreements[agreementId];
        if (a.beneficiary == address(0)) return AgreementState.None;
        uint8 kind = a.terminalKind;
        // Terminal: settled, or the two released kinds (drafts tombstone as cancelled; releases expire).
        if (kind != 0) {
            return kind == uint8(SETTLED)
                ? AgreementState.SETTLED
                : kind == uint8(CANCELLED) ? AgreementState.CANCELLED : AgreementState.EXPIRED;
        }
        if (a.acceptedAt == 0) return AgreementState.DRAFT;
        if (a.claimId == bytes32(0)) {
            return block.timestamp >= a.workDeadline ? AgreementState.EXPIRED : AgreementState.AGREED;
        }
        (,,, ClaimStake.Status status) = claims.claimTerms(a.claimId);
        if (status == ClaimStake.Status.Frozen) return AgreementState.DISPUTED;
        // A resolved unapproved attempt (rejected, expired, unwound, retired) reads EXPIRED until its sweep.
        if (status == ClaimStake.Status.Rejected || status >= ClaimStake.Status.Recovered) {
            return AgreementState.EXPIRED;
        }
        if (status == ClaimStake.Status.Paid || block.timestamp >= _releasedAt(a.claimId) + claims.challengeWindow()) {
            return AgreementState.READY_TO_SETTLE;
        }
        if (status == ClaimStake.Status.Approved) return AgreementState.CHALLENGE_WINDOW;
        // Open attempt: quorum on the record is accepted; a formal corrections request is the non-final route;
        // any verdict mark in flight reviews; an untouched bound attempt is submitted.
        if (verifiers.approvalCount(a.claimId) >= verifiers.quorum()) return AgreementState.ACCEPTED;
        if (verifiers.correctionsCount(a.claimId) != 0) return AgreementState.CORRECTIONS;
        if (verifiers.objectionCount(a.claimId) != 0 || verifiers.approvalCount(a.claimId) != 0) {
            return AgreementState.IN_REVIEW;
        }
        return AgreementState.SUBMITTED;
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
    /// @notice Makes each budget's reviewer panel and claim escrow (see `MandatePartsFactory`).
    MandatePartsFactory public immutable parts;
    /// @notice The only factory whose payout modules (N10) the DAOs of this summoner accept: its modules are known code,
    /// so none can refuse the DAO's notices and with them every transfer and exit.
    PayoutsFactory public immutable payoutsFactory;
    /// @notice The only funding-terms contract whose sales the DAOs of this summoner turn into new units (D133).
    FundingTerms public immutable fundingTerms;

    constructor() {
        parts = new MandatePartsFactory();
        payoutsFactory = new PayoutsFactory();
        fundingTerms = new FundingTerms();
    }

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
            milestonePanel,
            parts
        );
        if (budget != 0) {
            IERC20(currency).safeTransferFrom(msg.sender, address(mandate), budget);
            if (IERC20(currency).balanceOf(address(mandate)) != budget) revert FundingMismatch();
        }
        daos[address(mandate)] = msg.sender;
        emit MandateCreated(msg.sender, address(mandate), currency, budget, cap, shareBudget, shareCap);
    }
}
