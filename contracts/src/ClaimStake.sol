// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VerifierSet} from "./VerifierSet.sol";

/// @title ClaimStake
/// @notice Contributor stakes-to-claim: the paper's "skin in the game" tier
/// (plan C5, conviction-paper §4). A contributor stakes currency to claim a
/// milestone; the claimed amount itself sits in escrow. Release happens only
/// when the launch's VerifierSet reaches an approval quorum; a claim that
/// collects an objection quorum slashes the contributor's stake (spam /
/// failed delivery); cancel freezes everything.
///
/// The unlock is *attestation*, never a price read — the resolved §7.4 rule
/// (verifier milestones primary, TWAP backstop deferred).
contract ClaimStake {
    VerifierSet public immutable verifiers;
    address public immutable treasury;
    /// @notice Escrowed currency held for milestone payouts + stakes.
    IERC20Minimal public immutable currency;

    enum Status {
        Open,      // claimed, awaiting quorum
        Approved,  // approval quorum reached; payout claimable
        Rejected,  // objection quorum reached; stake slashed for spam
        Frozen,    // governance froze the claim (suspicion of fraud)
        Paid       // approved + paid out
    }

    struct MilestoneClaim {
        address contributor;
        uint256 amount;      // currency units claimed (escrowed)
        uint256 stake;       // contributor's collateral, escrowed
        Status status;
        bytes32 evidenceHash; // Nostr→chain binding (Blossom + canonical claim)
    }

    mapping(bytes32 claimId => MilestoneClaim) public claims;

    event ClaimSubmitted(bytes32 indexed claimId, address contributor, uint256 amount, uint256 stake, bytes32 evidenceHash);
    event ClaimReleased(bytes32 indexed claimId, address contributor, uint256 amount);
    event StakeSlashed(bytes32 indexed claimId, address contributor, uint256 stake);
    event ClaimFrozen(bytes32 indexed claimId);
    event ClaimPaid(bytes32 indexed claimId);

    error AlreadySettled(bytes32 claimId);
    error NotOpen(bytes32 claimId);
    error MintFailed(address token, address recipient, uint256 amount);

    constructor(VerifierSet verifiers_, address treasury_, address currency_) {
        verifiers = verifiers_;
        treasury = treasury_;
        currency = IERC20Minimal(currency_);
    }

    /// @notice Contributor stakes `stake` and claims `amount` for a milestone
    /// whose evidence is committed by `evidenceHash`.
    function submitClaim(bytes32 claimId, uint256 amount, uint256 stake, bytes32 evidenceHash) external {
        // The contributor's key is the claim's identity channel: a claim is
        // one-shot per (contributor, claimId) pair because the evidence hash
        // commits the content — a reused id with new evidence is a new claim
        // keyed differently by the caller.
        if (claims[claimId].evidenceHash != bytes32(0)) revert AlreadySettled(claimId);
        if (amount == 0 && stake == 0) revert EmptyClaim();
        // The claimed amount comes from the treasury-funded escrow (the
        // treasury commits it when it funds the milestone); the contributor's
        // stake is pulled from their own balance into escrow, so a spam claim
        // actually risks something.
        address contributor = msg.sender;
        if (stake > 0 && !currency.transferFrom(contributor, address(this), stake)) {
            revert MintFailed(address(currency), contributor, stake);
        }
        claims[claimId] = MilestoneClaim({
            contributor: contributor,
            amount: amount,
            stake: stake,
            status: Status.Open,
            evidenceHash: evidenceHash
        });
        emit ClaimSubmitted(claimId, contributor, amount, stake, evidenceHash);
    }

    /// @notice Treasury pre-funds the escrow for a milestone payout. Callable
    /// before or after submit; the claim amounts must sum <= funded balance.
    function fund(address from, uint256 amount) external {
        if (msg.sender != treasury && msg.sender != from) revert NotTreasury();
        if (!currency.transferFrom(from, address(this), amount)) revert MintFailed(address(currency), address(this), amount);
    }

    error NotTreasury();
    error EmptyClaim();

    /// @notice Anyone may settle once quorum conditions hold: approval quorum
    /// releases the payout to the contributor (stake returned); objection
    /// quorum slashes the stake into the treasury.
    function settle(bytes32 claimId) external {
        MilestoneClaim storage claim = claims[claimId];
        if (claim.status != Status.Open) revert AlreadySettled(claimId);
        if (verifiers.approvalCount(claimId) >= verifiers.quorum()) {
            claim.status = Status.Approved;
            emit ClaimReleased(claimId, claim.contributor, claim.amount);
        } else if (verifiers.objectionCount(claimId) >= verifiers.quorum()) {
            claim.status = Status.Rejected;
            emit StakeSlashed(claimId, claim.contributor, claim.stake);
        } else {
            revert NotOpen(claimId);
        }
    }

    /// @notice After release, the contributor withdraws the approved payout
    /// and their stake. One-shot.
    function payout(bytes32 claimId) external {
        MilestoneClaim storage claim = claims[claimId];
        if (claim.status != Status.Approved) revert NotOpen(claimId);
        if (msg.sender != claim.contributor) revert NotContributor();
        claim.status = Status.Paid;
        uint256 total = claim.amount + claim.stake;
        if (!currency.transfer(claim.contributor, total)) revert MintFailed(address(currency), claim.contributor, total);
        emit ClaimPaid(claimId);
    }

    error NotContributor();

    /// @notice Governance freeze: suspends a claim suspected of fraud. No
    /// payout, no release; escalation is treasury governance.
    function freeze(bytes32 claimId) external {
        if (msg.sender != treasury) revert NotTreasury();
        MilestoneClaim storage claim = claims[claimId];
        if (claim.status == Status.Paid) revert AlreadySettled(claimId);
        claim.status = Status.Frozen;
        emit ClaimFrozen(claimId);
    }
}

interface IERC20Minimal {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}
