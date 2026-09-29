// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VerifierSet} from "./VerifierSet.sol";
import {IRoyaltyDistributor} from "./RoyaltyDistributor.sol";

/// @title ClaimStake
/// @notice Contributor stakes-to-claim: the paper's "skin in the game" tier
/// (plan C5, conviction-paper §4). A contributor stakes currency to claim a
/// milestone; the treasury RESERVES the payout for that claim (`fund`). Release
/// happens only when the launch's VerifierSet reaches an approval quorum; a
/// claim that collects an objection quorum slashes the contributor's stake
/// (paid to the treasury, together with the payout reserved for the claim);
/// a treasury freeze suspends a claim and `resolveFrozen` unwinds it.
///
/// Money accounting (solvency): the contract holds exactly
/// `sum(open stakes) + sum(funded[claimId])` of `currency`. A claim's `amount`
/// is self-declared by the contributor, so it is NEVER paid from a shared pool:
/// `payout` moves `amount` only out of that claim's own `funded` reservation
/// (`Underfunded` otherwise) plus the contributor's own stake, so one claim can
/// never drain another contributor's stake or another claim's reservation.
///
/// Approved claims may also carry a ROYALTY SCHEDULE request
/// (`submitClaimWithSchedule`): on approval quorum the schedule is minted in
/// the launch's RoyaltyDistributor (docs/token-lifecycle-design.md) — the
/// contributor's income stream, exactly as attested. `freeze` suspends a
/// minted schedule (stops future accrual); it can never touch what the
/// distributor has already CREDITED — "credited is owned" lives in the
/// distributor by construction.
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
        Rejected,  // objection quorum reached; stake slashed to the treasury
        Frozen,    // governance froze the claim (suspicion of fraud)
        Paid,      // approved + paid out
        Recovered  // frozen claim unwound: stake back to contributor, reserve to treasury
    }

    struct MilestoneClaim {
        address contributor;
        uint256 amount;      // currency units claimed (escrowed)
        uint256 stake;       // contributor's collateral, escrowed
        Status status;
        bytes32 evidenceHash; // Nostr→chain binding (Blossom + canonical claim)
    }

    mapping(bytes32 claimId => MilestoneClaim) public claims;

    /// @notice Currency the treasury has reserved for this claim's payout.
    /// `payout` can only ever pay `amount` out of this balance.
    mapping(bytes32 claimId => uint256) public funded;
    /// @notice VerifierSet counters at the moment the claim was submitted:
    /// only attestations made AFTER submission count toward `settle` (an id
    /// cannot be pre-approved and then squatted with different content).
    mapping(bytes32 claimId => uint256) public approvalsAtSubmit;
    mapping(bytes32 claimId => uint256) public objectionsAtSubmit;

    /// @notice Royalty schedule request attached to a claim (0 allocation =
    ///         plain milestone claim, no schedule). Exactly as attested:
    ///         weight/term/band are minted verbatim on approval.
    struct RoyaltyReq {
        uint32 weight;
        uint64 term;
        uint8 band;
        uint128 allocation;
    }

    mapping(bytes32 claimId => RoyaltyReq) public royaltyReq;

    /// @notice The launch's royalty ledger. One-shot wiring by the treasury
    ///         at deploy; unset means royalty-bearing claims fail closed.
    IRoyaltyDistributor public royalties;

    event RoyaltiesSet(address indexed royalties);
    event ScheduleRequested(bytes32 indexed claimId, address indexed contributor, uint128 allocation);

    event ClaimSubmitted(bytes32 indexed claimId, address contributor, uint256 amount, uint256 stake, bytes32 evidenceHash);
    event ClaimReleased(bytes32 indexed claimId, address contributor, uint256 amount);
    event StakeSlashed(bytes32 indexed claimId, address contributor, uint256 stake);
    event ClaimFrozen(bytes32 indexed claimId);
    event ClaimPaid(bytes32 indexed claimId);
    event ClaimFunded(bytes32 indexed claimId, uint256 amount, uint256 totalFunded);
    /// @notice A rejected claim's reserved payout returned to the treasury.
    event ReserveRecovered(bytes32 indexed claimId, uint256 amount);
    /// @notice A frozen claim unwound by the treasury.
    event FrozenClaimResolved(
        bytes32 indexed claimId, address contributor, uint256 stakeReturned, uint256 reserveRecovered
    );

    error AlreadySettled(bytes32 claimId);
    error NotOpen(bytes32 claimId);
    error MintFailed(address token, address recipient, uint256 amount);
    /// @notice No claim exists under this id.
    error UnknownClaim(bytes32 claimId);
    /// @notice A claim needs a non-zero evidence hash (it is also what marks the id taken).
    error NoEvidence();
    /// @notice The claim is not in a state that can take (more) funding.
    error ClaimClosed(bytes32 claimId);
    /// @notice Funding would reserve more than the claim's own `amount`.
    error OverFunded(bytes32 claimId, uint256 funded, uint256 added, uint256 amount);
    /// @notice The treasury has not reserved the claim's full `amount` yet.
    error Underfunded(bytes32 claimId, uint256 funded, uint256 amount);
    /// @notice `resolveFrozen` on a claim that is not frozen.
    error NotFrozen(bytes32 claimId);

    constructor(VerifierSet verifiers_, address treasury_, address currency_) {
        verifiers = verifiers_;
        treasury = treasury_;
        currency = IERC20Minimal(currency_);
    }

    /// @notice One-shot wiring of the launch's RoyaltyDistributor.
    function setRoyalties(address royalties_) external {
        if (msg.sender != treasury) revert NotTreasury();
        if (address(royalties) != address(0) || royalties_ == address(0)) revert AlreadySettled(bytes32(0));
        royalties = IRoyaltyDistributor(royalties_);
        emit RoyaltiesSet(royalties_);
    }

    /// @notice Contributor stakes `stake` and claims `amount` for a milestone
    /// whose evidence is committed by `evidenceHash`.
    function submitClaim(bytes32 claimId, uint256 amount, uint256 stake, bytes32 evidenceHash) external {
        _submit(claimId, amount, stake, evidenceHash);
    }

    /// @notice Same as `submitClaim`, plus a royalty schedule request: on
    ///         approval quorum the schedule is minted in `royalties` and the
    ///         contributor starts earning the attested income stream
    ///         (docs/token-lifecycle-design.md).
    function submitClaimWithSchedule(
        bytes32 claimId,
        uint256 amount,
        uint256 stake,
        bytes32 evidenceHash,
        uint32 weight,
        uint64 term,
        uint8 band,
        uint128 allocation
    ) external {
        if (allocation == 0) revert EmptyClaim();
        _submit(claimId, amount, stake, evidenceHash);
        royaltyReq[claimId] = RoyaltyReq({weight: weight, term: term, band: band, allocation: allocation});
        emit ScheduleRequested(claimId, msg.sender, allocation);
    }

    function _submit(bytes32 claimId, uint256 amount, uint256 stake, bytes32 evidenceHash) internal {
        // The contributor's key is the claim's identity channel: a claim is
        // one-shot per (contributor, claimId) pair because the evidence hash
        // commits the content — a reused id with new evidence is a new claim
        // keyed differently by the caller.
        // A claim with no evidence hash would leave the id "unused" and let anyone
        // overwrite it (and strand the first contributor's stake): refuse it.
        if (evidenceHash == bytes32(0)) revert NoEvidence();
        if (claims[claimId].evidenceHash != bytes32(0)) revert AlreadySettled(claimId);
        if (amount == 0 && stake == 0) revert EmptyClaim();
        // The claimed amount is paid only from what the treasury reserves for
        // THIS claim (`fund`); the contributor's stake is pulled from their own
        // balance into escrow, so a spam claim actually risks something.
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
        approvalsAtSubmit[claimId] = verifiers.approvalCount(claimId);
        objectionsAtSubmit[claimId] = verifiers.objectionCount(claimId);
        emit ClaimSubmitted(claimId, contributor, amount, stake, evidenceHash);
    }

    /// @notice Treasury reserves `amount` of currency for ONE claim's payout,
    /// pulled from the treasury (`msg.sender`) — never from anyone else's
    /// allowance. A claim can be reserved up to its own `amount`, while it is
    /// Open or Approved; the reservation can only ever be paid to that claim's
    /// contributor (`payout`) or returned to the treasury (`settle` on
    /// rejection, `resolveFrozen`).
    function fund(bytes32 claimId, uint256 amount) external {
        if (msg.sender != treasury) revert NotTreasury();
        MilestoneClaim storage claim = claims[claimId];
        if (claim.contributor == address(0)) revert UnknownClaim(claimId);
        if (claim.status != Status.Open && claim.status != Status.Approved) revert ClaimClosed(claimId);
        uint256 already = funded[claimId];
        if (already + amount > claim.amount) revert OverFunded(claimId, already, amount, claim.amount);
        funded[claimId] = already + amount;
        if (!currency.transferFrom(msg.sender, address(this), amount)) {
            revert MintFailed(address(currency), address(this), amount);
        }
        emit ClaimFunded(claimId, amount, already + amount);
    }

    error NotTreasury();
    error EmptyClaim();

    /// @notice Anyone may settle once quorum conditions hold: approval quorum
    /// releases the payout to the contributor (stake returned with it);
    /// objection quorum slashes the stake into the treasury and returns the
    /// claim's reserved payout to it. Only attestations made after the claim
    /// was submitted count.
    function settle(bytes32 claimId) external {
        MilestoneClaim storage claim = claims[claimId];
        if (claim.contributor == address(0)) revert UnknownClaim(claimId);
        if (claim.status != Status.Open) revert AlreadySettled(claimId);
        uint256 quorum = verifiers.quorum();
        if (quorum != 0 && verifiers.approvalCount(claimId) - approvalsAtSubmit[claimId] >= quorum) {
            claim.status = Status.Approved;
            emit ClaimReleased(claimId, claim.contributor, claim.amount);
            // Mint the attested royalty schedule — exactly as claimed and
            // approved. Fail closed if the ledger is not wired.
            RoyaltyReq storage req = royaltyReq[claimId];
            if (req.allocation > 0) {
                IRoyaltyDistributor(royalties).mint(
                    claimId, claim.contributor, req.weight, req.term, req.band, req.allocation
                );
            }
        } else if (quorum != 0 && verifiers.objectionCount(claimId) - objectionsAtSubmit[claimId] >= quorum) {
            claim.status = Status.Rejected;
            // The slash is real: the stake and the payout reserved for this
            // (rejected) claim both go to the treasury, not into limbo.
            uint256 slashed = claim.stake;
            uint256 reserved = funded[claimId];
            claim.stake = 0;
            funded[claimId] = 0;
            emit StakeSlashed(claimId, claim.contributor, slashed);
            if (reserved > 0) emit ReserveRecovered(claimId, reserved);
            uint256 total = slashed + reserved;
            if (total > 0 && !currency.transfer(treasury, total)) {
                revert MintFailed(address(currency), treasury, total);
            }
        } else {
            revert NotOpen(claimId);
        }
    }

    /// @notice After release, the contributor withdraws the approved payout
    /// (out of this claim's own reservation) and their stake. One-shot.
    function payout(bytes32 claimId) external {
        MilestoneClaim storage claim = claims[claimId];
        if (claim.status != Status.Approved) revert NotOpen(claimId);
        if (msg.sender != claim.contributor) revert NotContributor();
        uint256 reserved = funded[claimId];
        if (reserved < claim.amount) revert Underfunded(claimId, reserved, claim.amount);
        claim.status = Status.Paid;
        funded[claimId] = reserved - claim.amount;
        uint256 total = claim.amount + claim.stake;
        if (!currency.transfer(claim.contributor, total)) revert MintFailed(address(currency), claim.contributor, total);
        emit ClaimPaid(claimId);
    }

    error NotContributor();

    /// @notice Governance freeze: suspends a claim suspected of fraud. No
    /// payout, no release; `resolveFrozen` unwinds it. A claim frozen after
    /// approval also suspends its minted royalty schedule (future accrual
    /// only — credited balances are never touched). A paid, slashed or
    /// recovered claim is final and cannot be frozen; re-freezing a frozen
    /// claim is a harmless no-op.
    function freeze(bytes32 claimId) external {
        if (msg.sender != treasury) revert NotTreasury();
        MilestoneClaim storage claim = claims[claimId];
        if (claim.contributor == address(0)) revert UnknownClaim(claimId);
        if (claim.status == Status.Paid || claim.status == Status.Rejected || claim.status == Status.Recovered) {
            revert AlreadySettled(claimId);
        }
        bool wasApproved = claim.status == Status.Approved;
        claim.status = Status.Frozen;
        if (wasApproved && royaltyReq[claimId].allocation > 0) {
            IRoyaltyDistributor(royalties).suspend(claimId);
        }
        emit ClaimFrozen(claimId);
    }

    /// @notice Unwind a frozen claim so nothing is stranded: the payout the
    /// treasury reserved for it returns to the treasury, and the contributor's
    /// stake returns to the contributor. A freeze is a suspension, not a
    /// verdict — only an objection QUORUM slashes a stake, so the treasury can
    /// recover its own money here but can never seize a contributor's.
    function resolveFrozen(bytes32 claimId) external {
        if (msg.sender != treasury) revert NotTreasury();
        MilestoneClaim storage claim = claims[claimId];
        if (claim.status != Status.Frozen || claim.contributor == address(0)) revert NotFrozen(claimId);
        claim.status = Status.Recovered;
        uint256 stakeBack = claim.stake;
        uint256 reserved = funded[claimId];
        claim.stake = 0;
        funded[claimId] = 0;
        emit FrozenClaimResolved(claimId, claim.contributor, stakeBack, reserved);
        if (reserved > 0 && !currency.transfer(treasury, reserved)) {
            revert MintFailed(address(currency), treasury, reserved);
        }
        if (stakeBack > 0 && !currency.transfer(claim.contributor, stakeBack)) {
            revert MintFailed(address(currency), claim.contributor, stakeBack);
        }
    }
}

interface IERC20Minimal {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

// The RoyaltyDistributor surface ClaimStake drives (defined on
// RoyaltyDistributor; declared there as `IRoyaltyDistributor`).
