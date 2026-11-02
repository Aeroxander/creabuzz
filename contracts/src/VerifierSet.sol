// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title VerifierSet
/// @notice The paper's "expert panels" tier, made concrete and slashable
/// (plan C5, conviction-paper §4). Verifiers (accepted by the treasury) attest
/// milestone claims; a claim resolves only once a quorum of *distinct*
/// verifiers has attested. Slashing is for objectively checkable acts (spam
/// claims, false verdicts), never for honest judgment.
///
/// Launch-scoped: the treasury (owner) accepts verifiers, sets quorum, and
/// slashes. After graduation this authority would sit behind the Moloch DAO;
/// the owner here is the same treasury the GraduationExecutor forwards to.
///
/// A verifier's stake is a real bond when the owner turns bonding on (`setBond`):
/// the verifier posts the bond currency themselves, cannot attest while their stake
/// is under the minimum, can only take it back after an unbonding delay, and loses
/// it to the owner when slashed. The bond can be any ERC-20 the owner names; the safe
/// choice is the claim's own currency, because a token whose price an insider can set
/// is a weak deterrent, but that is the owner's call.
/// Without `setBond` the set behaves as it always did and nobody has stake.
contract VerifierSet {
    using SafeERC20 for IERC20;

    /// @notice How long a verifier's bond stays slashable after they ask for it back. It outlasts a claim's
    /// challenge window and the vote that would freeze it.
    uint64 public constant UNBOND_DELAY = 14 days;

    address public immutable owner;
    /// @notice The bond currency, once bonding is on (zero while it is off).
    IERC20 public bondToken;
    /// @notice The least stake a verifier must hold to attest while bonding is on.
    uint256 public minBond;

    struct Unbond {
        uint256 amount;
        uint64 availableAt;
    }

    /// @notice Bond a verifier has asked back and is waiting out; still slashable until `availableAt`.
    mapping(address => Unbond) public unbonds;

    struct Verifier {
        bool active;
        uint256 stake;
        uint256 attestedCount;
        uint256 slashed;
    }

    struct Claim {
        uint256 approvals;
        uint256 objections;
    }

    /// @notice Where the claimant of a claim is looked up, so a reviewer who
    /// is also the claimant can be turned away (plan G1: reviewer recusal).
    address public claimStake;

    mapping(address => Verifier) public verifiers;
    mapping(bytes32 claimId => Claim) public claims;
    mapping(bytes32 claimId => mapping(address => bool)) public attested;
    uint256 public quorum;

    /// @notice For each claim the owner registered, the addresses a settlement of it would pay (the mandate names
    /// them when it binds the delivery): none of them may attest that claim. Empty for claims nobody excluded —
    /// legacy paid-work claims and every pre-existing deployment behave exactly as they did.
    mapping(bytes32 claimId => address[]) public excludedFromReview;

    /// @notice Set once at birth by the owner: bound-review readiness on the panel (see `setBoundReviews`).
    bool public boundReviews;
    /// @notice Who has asked for ordinary corrections on a claim, once each: a non-final request for changes,
    /// recorded beside the verdict counters and never counted into any quorum. The mandate's corrections route
    /// reads only `correctionsCount`.
    mapping(bytes32 claimId => mapping(address => bool)) public correctionsAsked;
    mapping(bytes32 claimId => uint256) public correctionsCount;

    event VerifierAccepted(address indexed verifier, uint256 stake);
    event VerifierRemoved(address indexed verifier);
    event Attested(bytes32 indexed claimId, address indexed verifier, bool approve);
    event QuorumSet(uint256 quorum);
    event Slashed(address indexed verifier, uint256 amount);
    event BondSet(address indexed token, uint256 minBond);
    event Bonded(address indexed verifier, uint256 amount);
    event UnbondRequested(address indexed verifier, uint256 amount, uint64 availableAt);
    event Withdrawn(address indexed verifier, uint256 amount);
    /// @notice The mandate names, once per claim, the recipients a settlement of it would pay (no one of them may
    /// attest that claim).
    event ExcludedFromReview(bytes32 indexed claimId, address[] parties);
    /// @notice A reviewer asked for ordinary corrections on an open attempt (never a rejection, never in a quorum).
    event CorrectionsRequested(bytes32 indexed claimId, address indexed verifier, bytes32 reasonHash);
    event BoundReviewsSet();

    error OnlyOwner(address caller);
    /// @notice A reviewer cannot pass judgment on their own work.
    error ClaimantCannotAttest(bytes32 claimId, address claimant);
    /// @notice The claim the attestation names does not exist in the wired claim escrow: a mark placed before the
    /// delivery exists can never be taken back, so the escrow's counter snapshot would only be half the protection —
    /// the reviewer's one mark per claim id would be burnt on content that may never exist.
    error UnknownPanelClaim(bytes32 claimId);
    /// @notice Nobody shares a claim's payment and judges it: a declared settlement recipient of this claim is
    /// barred from attesting it (recusal beyond the claimant, who is otherwise the only read-back guard).
    error PaidPartyCannotJudge(bytes32 claimId, address party);
    /// @notice The panel requires bound review readiness: no reviewer may weigh in — attest or formally request
    /// corrections — on a claim whose check the mandate has not locked (exclusions included) yet.
    error NotReadyForReview(bytes32 claimId);
    /// @notice Corrections requests are a non-final route on an *open* attempt: once the review resolved — verdict,
    /// retirement, freeze, payout or expiry — there is no change request left to file.
    error ReviewResolved(bytes32 claimId);
    error AlreadyRequestedCorrections(bytes32 claimId, address verifier);
    /// @notice The mandate names a claim's paying parties once, at bind time.
    error AlreadyExcluded(bytes32 claimId);
    error NotClaimStake(address caller);
    error NotAVerifier(address verifier);
    error AlreadyAttested(bytes32 claimId, address verifier);
    error AlreadyVerifier(address verifier);
    /// @notice A quorum of zero would let anyone settle any claim with no
    /// attestation at all (`approvals >= 0` is always true).
    error BadQuorum(uint256 quorum);
    /// @notice The panel's bound-review readiness flag is once-only: set at birth by the owner, never unset.
    error BoundReviewsAlreadySet();
    error BondAlreadySet();
    error BondNotEnabled();
    /// @notice A verifier below the minimum bond cannot attest.
    error BondTooLow(uint256 stake, uint256 minBond);
    /// @notice The bond currency delivered less than asked (a fee on transfer): the stake would be a lie.
    error ShortTransfer(uint256 asked, uint256 received);
    error NothingToWithdraw();
    error NotYetAvailable(uint64 availableAt);
    error InsufficientStake(uint256 stake, uint256 asked);

    constructor(address owner_, uint256 quorum_) {
        if (owner_ == address(0)) revert OnlyOwner(address(0));
        if (quorum_ == 0) revert BadQuorum(quorum_);
        owner = owner_;
        quorum = quorum_;
    }

    function acceptVerifier(address verifier) external {
        if (msg.sender != owner) revert OnlyOwner(msg.sender);
        if (verifiers[verifier].active) revert AlreadyVerifier(verifier);
        verifiers[verifier].active = true;
        emit VerifierAccepted(verifier, verifiers[verifier].stake);
    }

    function removeVerifier(address verifier) external {
        if (msg.sender != owner) revert OnlyOwner(msg.sender);
        verifiers[verifier].active = false;
        emit VerifierRemoved(verifier);
    }

    function setQuorum(uint256 quorum_) external {
        if (msg.sender != owner) revert OnlyOwner(msg.sender);
        if (quorum_ == 0) revert BadQuorum(quorum_);
        quorum = quorum_;
        emit QuorumSet(quorum_);
    }

    /// @notice A verifier attests (or objects to) a milestone claim. One
    /// attestation per claim per verifier, either side. Approvals accumulate
    /// into the claim's counter so quorum is O(1) to read.
    /// @dev The attestation binds only the `claimId` — the verifier is vouching
    /// for whatever claim `ClaimStake` holds under that id, so verifiers must
    /// read the on-chain claim (contributor, amount, evidence) BEFORE attesting.
    /// `ClaimStake` ignores any attestation made before the claim was submitted
    /// (it snapshots the counters at submit), so an id cannot be pre-approved
    /// and then squatted with different content.
    /// @notice Point at the `ClaimStake` holding the claims, so recusal can
    /// be checked against who actually filed them. Once only.
    function setClaimStake(address claimStake_) external {
        if (msg.sender != owner) revert OnlyOwner(msg.sender);
        if (claimStake != address(0) || claimStake_ == address(0)) revert OnlyOwner(msg.sender);
        claimStake = claimStake_;
    }

    /// @notice Set once at birth (every new TreasuryMandate panel turns it on in its constructor): a reviewer may
    /// attest or formally request corrections only on a claim whose acceptance check the mandate has already bound
    /// and whose payment exclusions are installed — the same atomic transaction, so no reviewer can spend their
    /// one-shot or bless a self-rewarding draft. Standalone and legacy sets keep their old behaviour.
    function setBoundReviews() external {
        if (msg.sender != owner) revert OnlyOwner(msg.sender);
        if (boundReviews) revert BoundReviewsAlreadySet();
        boundReviews = true;
        emit BoundReviewsSet();
    }

    /// @notice The owner (the mandate) names, once per claim, the addresses a settlement of that claim would pay:
    /// none of them may attest it. Called when a delivery is bound to its agreed reward, so the exclusion is
    /// exactly the terms both parties already signed and never wider than the payment they commit.
    function excludeFromReview(bytes32 claimId, address[] calldata parties) external {
        if (msg.sender != owner) revert OnlyOwner(msg.sender);
        if (excludedFromReview[claimId].length != 0) revert AlreadyExcluded(claimId);
        for (uint256 i; i < parties.length; ++i) {
            excludedFromReview[claimId].push(parties[i]);
        }
        emit ExcludedFromReview(claimId, parties);
    }

    function attest(bytes32 claimId, bool approve) external {
        _weighInChecks(claimId);
        if (attested[claimId][msg.sender]) revert AlreadyAttested(claimId, msg.sender);
        attested[claimId][msg.sender] = true;
        if (approve) {
            claims[claimId].approvals++;
        } else {
            claims[claimId].objections++;
        }
        verifiers[msg.sender].attestedCount++;
        emit Attested(claimId, msg.sender, approve);
    }

    /// @notice A reviewer asks for ordinary corrections on a claim: a NON-final request for changes, recorded
    /// beside the verdict counters and never counted into any quorum, never a rejection vote. The mandate's
    /// corrections route (`bindSubmission`) reads `correctionsCount` and may then replace the open attempt with a
    /// new one (retiring the old attempt: no verdict, the contributor's stake, if any, back unslashed, no further
    /// award from it), inside the agreement's own revision window. Same guards as `attest`, on an open attempt
    /// whose acceptance check the mandate has bound.
    /// @param reasonHash Offchain descriptor of what to change (recorded, not enforced).
    function requestCorrections(bytes32 claimId, bytes32 reasonHash) external {
        _weighInChecks(claimId);
        (,,, uint8 status) = IClaimClaimant(claimStake).claimTerms(claimId);
        if (status != uint8(0)) revert ReviewResolved(claimId); // only an Open attempt takes a corrections request
        if (correctionsAsked[claimId][msg.sender]) revert AlreadyRequestedCorrections(claimId, msg.sender);
        correctionsAsked[claimId][msg.sender] = true;
        correctionsCount[claimId] += 1;
        emit CorrectionsRequested(claimId, msg.sender, reasonHash);
    }

    /// @dev The shared weight-in gates for both verdicts (`attest`) and non-final corrections requests: the claim
    /// exists in the wired escrow and is not the reviewer's own work; a declared recipient of its settlement
    /// cannot weigh in on it; with bound review readiness on, the mandate must have gotten to the check lock
    /// (and exclusions, one atomic transaction at bind time) before any reviewer weight lands; the reviewer
    /// must be active and bonded where bonding is on.
    function _weighInChecks(bytes32 claimId) private view {
        address claimant = claimStake == address(0) ? address(0) : IClaimClaimant(claimStake).claimantOf(claimId);
        if (claimant != address(0) && msg.sender == claimant) {
            revert ClaimantCannotAttest(claimId, claimant);
        }
        // A claim that does not exist yet cannot be judged at all — even an honest early vote cannot land
        // arithmetically (the escrow's counter snapshot only discounts it), yet it would spend this reviewer's
        // one attestation per claim id on content that may never exist.
        if (claimStake != address(0) && claimant == address(0)) {
            revert UnknownPanelClaim(claimId);
        }
        _notAPayingParty(claimId);
        if (boundReviews && claimStake != address(0) && !acceptanceLockedOf(claimId)) {
            revert NotReadyForReview(claimId);
        }
        if (!verifiers[msg.sender].active) revert NotAVerifier(msg.sender);
        if (address(bondToken) != address(0) && verifiers[msg.sender].stake < minBond) {
            revert BondTooLow(verifiers[msg.sender].stake, minBond);
        }
    }

    /// @dev The claim's mandate-bound state, as the escrow sees it (the inherited `acceptanceLocked[claimId]`).
    function acceptanceLockedOf(bytes32 claimId) internal view returns (bool) {
        return IClaimClaimant(claimStake).acceptanceLocked(claimId);
    }

    /// @dev A declared recipient of this claim's settlement cannot pass judgment on work that would pay them.
    function _notAPayingParty(bytes32 claimId) internal view {
        for (uint256 i; i < excludedFromReview[claimId].length; ++i) {
            if (excludedFromReview[claimId][i] == msg.sender) {
                revert PaidPartyCannotJudge(claimId, msg.sender);
            }
        }
    }

    /// @notice Whether a claim has reached the approval quorum.
    function hasQuorum(bytes32 claimId) external view returns (bool) {
        return claims[claimId].approvals >= quorum;
    }

    function approvalCount(bytes32 claimId) external view returns (uint256) {
        return claims[claimId].approvals;
    }

    function objectionCount(bytes32 claimId) external view returns (uint256) {
        return claims[claimId].objections;
    }

    /// @notice Turn real bonding on, once: verifiers must hold `minBond_` of `token` to attest. Owner only.
    function setBond(address token, uint256 minBond_) external {
        if (msg.sender != owner) revert OnlyOwner(msg.sender);
        if (address(bondToken) != address(0)) revert BondAlreadySet();
        if (token == address(0)) revert BondNotEnabled();
        bondToken = IERC20(token);
        minBond = minBond_;
        emit BondSet(token, minBond_);
    }

    /// @notice An accepted verifier posts bond, in the bond currency, from their own wallet.
    function bond(uint256 amount) external {
        if (address(bondToken) == address(0)) revert BondNotEnabled();
        if (!verifiers[msg.sender].active) revert NotAVerifier(msg.sender);
        uint256 before = bondToken.balanceOf(address(this));
        bondToken.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = bondToken.balanceOf(address(this)) - before;
        if (received != amount) revert ShortTransfer(amount, received);
        verifiers[msg.sender].stake += amount;
        emit Bonded(msg.sender, amount);
    }

    /// @notice Ask for `amount` of bond back. It leaves the stake at once (so it no longer counts toward
    /// attesting) but stays slashable until `UNBOND_DELAY` has passed.
    function requestUnbond(uint256 amount) external {
        Verifier storage v = verifiers[msg.sender];
        if (v.stake < amount || amount == 0) revert InsufficientStake(v.stake, amount);
        v.stake -= amount;
        Unbond storage u = unbonds[msg.sender];
        u.amount += amount;
        u.availableAt = uint64(block.timestamp) + UNBOND_DELAY;
        emit UnbondRequested(msg.sender, amount, u.availableAt);
    }

    /// @notice Take back what was asked back, once the delay has passed.
    function withdraw() external {
        Unbond memory u = unbonds[msg.sender];
        if (u.amount == 0) revert NothingToWithdraw();
        if (block.timestamp < u.availableAt) revert NotYetAvailable(u.availableAt);
        delete unbonds[msg.sender];
        bondToken.safeTransfer(msg.sender, u.amount);
        emit Withdrawn(msg.sender, u.amount);
    }

    /// @notice Slash a verifier: their stake first, then bond they are waiting to take back. The slashed bond is
    /// paid to the owner (the treasury's side). Owner only; returns what was actually taken.
    function slash(address verifier, uint256 amount) external returns (uint256 taken) {
        if (msg.sender != owner) revert OnlyOwner(msg.sender);
        Verifier storage v = verifiers[verifier];
        uint256 fromStake = v.stake < amount ? v.stake : amount;
        v.stake -= fromStake;
        taken = fromStake;
        Unbond storage u = unbonds[verifier];
        if (taken < amount && u.amount != 0) {
            uint256 rest = amount - taken;
            uint256 fromUnbond = u.amount < rest ? u.amount : rest;
            u.amount -= fromUnbond;
            taken += fromUnbond;
        }
        v.slashed += taken;
        if (taken != 0 && address(bondToken) != address(0)) bondToken.safeTransfer(owner, taken);
        emit Slashed(verifier, taken);
    }
}

/// @notice The one lookup `VerifierSet` needs from `ClaimStake`: who filed it.
interface IClaimClaimant {
    function claimantOf(bytes32 claimId) external view returns (address);
    /// @notice Public mapping getter on `ClaimStake`: whether the mandate bound this claim's acceptance check.
    function acceptanceLocked(bytes32 claimId) external view returns (bool);
    /// @notice Public mapping getter on `ClaimStake`: the claim's (contributor, amount, check, status) shape.
    function claimTerms(bytes32 claimId) external view returns (address, uint256, bytes32, uint8);
}
