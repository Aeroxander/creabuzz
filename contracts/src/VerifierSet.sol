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
/// it to the owner when slashed. The bond is always the claim's own currency, never
/// the project's token: a token whose price an insider can set is no deterrent.
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

    event VerifierAccepted(address indexed verifier, uint256 stake);
    event VerifierRemoved(address indexed verifier);
    event Attested(bytes32 indexed claimId, address indexed verifier, bool approve);
    event QuorumSet(uint256 quorum);
    event Slashed(address indexed verifier, uint256 amount);
    event BondSet(address indexed token, uint256 minBond);
    event Bonded(address indexed verifier, uint256 amount);
    event UnbondRequested(address indexed verifier, uint256 amount, uint64 availableAt);
    event Withdrawn(address indexed verifier, uint256 amount);

    error OnlyOwner(address caller);
    /// @notice A reviewer cannot pass judgment on their own work.
    error ClaimantCannotAttest(bytes32 claimId, address claimant);
    error NotClaimStake(address caller);
    error NotAVerifier(address verifier);
    error AlreadyAttested(bytes32 claimId, address verifier);
    error AlreadyVerifier(address verifier);
    /// @notice A quorum of zero would let anyone settle any claim with no
    /// attestation at all (`approvals >= 0` is always true).
    error BadQuorum(uint256 quorum);
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

    function attest(bytes32 claimId, bool approve) external {
        // G1: a claimant cannot attest to their own claim. The claimant is
        // read from ClaimStake, so this holds whoever is holding the pen.
        address claimant = claimStake == address(0)
            ? address(0)
            : IClaimClaimant(claimStake).claimantOf(claimId);
        if (claimant != address(0) && msg.sender == claimant) {
            revert ClaimantCannotAttest(claimId, claimant);
        }
        if (!verifiers[msg.sender].active) revert NotAVerifier(msg.sender);
        if (address(bondToken) != address(0) && verifiers[msg.sender].stake < minBond) {
            revert BondTooLow(verifiers[msg.sender].stake, minBond);
        }
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
}
