// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

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
contract VerifierSet {
    address public immutable owner;

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

    mapping(address => Verifier) public verifiers;
    mapping(bytes32 claimId => Claim) public claims;
    mapping(bytes32 claimId => mapping(address => bool)) public attested;
    uint256 public quorum;

    event VerifierAccepted(address indexed verifier, uint256 stake);
    event VerifierRemoved(address indexed verifier);
    event Attested(bytes32 indexed claimId, address indexed verifier, bool approve);
    event QuorumSet(uint256 quorum);
    event Slashed(address indexed verifier, uint256 amount);

    error OnlyOwner(address caller);
    error NotAVerifier(address verifier);
    error AlreadyAttested(bytes32 claimId, address verifier);
    error AlreadyVerifier(address verifier);

    constructor(address owner_, uint256 quorum_) {
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
        quorum = quorum_;
        emit QuorumSet(quorum_);
    }

    /// @notice A verifier attests (or objects to) a milestone claim. One
    /// attestation per claim per verifier, either side. Approvals accumulate
    /// into the claim's counter so quorum is O(1) to read.
    function attest(bytes32 claimId, bool approve) external {
        if (!verifiers[msg.sender].active) revert NotAVerifier(msg.sender);
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

    /// @notice Slash a verifier's stake. Console-authority (treasury) only.
    function slash(address verifier, uint256 amount) external {
        if (msg.sender != owner) revert OnlyOwner(msg.sender);
        if (verifiers[verifier].stake < amount) amount = verifiers[verifier].stake;
        verifiers[verifier].stake -= amount;
        verifiers[verifier].slashed += amount;
        emit Slashed(verifier, amount);
    }

    /// @notice Verifier adds stake to their own account (a real
    /// implementation would pull an ERC-20; this escrow tracks the number the
    /// ClaimStake contract gates on).
    function addStake(address verifier, uint256 amount) external {
        if (msg.sender != owner) revert OnlyOwner(msg.sender);
        verifiers[verifier].stake += amount;
    }
}
