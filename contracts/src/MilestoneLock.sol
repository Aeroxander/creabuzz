// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MilestoneBadge} from "./MilestoneBadge.sol";

interface IMilestoneDao {
    function votingWeight() external view returns (address);
    function shares() external view returns (address);
}

interface IMilestoneShares {
    function burnForfeited(address from, uint256 amount) external;
}

interface IMilestonePolicy {
    function mandateFactory() external view returns (address);
}

interface IMilestoneFactory {
    function daos(address mandate) external view returns (address);
    function milestoneMandate(address dao) external view returns (address);
}

interface IMilestoneMandate {
    function claims() external view returns (address);
    function claimProject(bytes32 claimId) external view returns (bytes32);
}

interface IMilestoneClaims {
    function claimTerms(bytes32 claimId)
        external
        view
        returns (address contributor, uint256 amount, bytes32 checkHash, uint8 status);
}

/// @title MilestoneLock
/// @notice The founders' Shares are minted to them at launch and they vote with them from the first block, but part of
/// them cannot be sold or ragequit until a milestone is reached. This contract is the DAO's lock guard (see `Shares.lockGuard`): it
/// says how many of each beneficiary's Shares are still locked, and the Shares contract refuses to move or burn
/// below that floor. A holder's own purchases and the part not covered by a milestone are never locked.
///
/// A milestone is a work claim, judged like any other: filed by the beneficiary, bound to a project inside a mandate
/// this DAO created, approved by that mandate's independent reviewers and past its challenge window (status `Paid`),
/// and filed against the exact acceptance check the tranche names. Anyone can then call `unlock`, which frees the
/// tranche and mints the beneficiary a soulbound `MilestoneBadge` as the receipt. No vote is needed to unlock:
/// the DAO already agreed to the schedule at launch.
///
/// Whose reviewers? When the DAO named a milestone panel at launch (the launch kit does, whenever there are milestones),
/// only that panel's mandate can unlock a tranche: a later vote cannot swap in a friendlier panel, and the panel is
/// the one the backers saw before they bought. A lock made without one (tests, older DAOs) accepts any mandate the
/// DAO's own factory made.
///
/// The DAO can `forfeit` a beneficiary's remaining tranches (a founder who left). Forfeiting burns those Shares on
/// the spot: they never become free to sell or take out, so a vote cannot release the team from its own lock, only
/// remove what the team has not earned.
contract MilestoneLock {
    uint256 public constant MAX_TRANCHES = 8;
    uint256 internal constant BPS = 10_000;

    struct Tranche {
        bytes32 checkHash;
        uint96 amount;
        bool unlocked;
        bool forfeited;
    }

    address public immutable dao;
    MilestoneBadge public immutable badge;

    mapping(address beneficiary => Tranche[]) private _tranches;
    mapping(address claims => mapping(bytes32 claimId => bool)) public claimUsed;

    event Unlocked(address indexed beneficiary, uint256 indexed index, uint96 amount, bytes32 claimId, uint256 badgeId);
    event Forfeited(address indexed beneficiary, uint96 amount);

    error OnlyDao();
    error BadSchedule();
    error UnknownTranche();
    error AlreadyResolved();
    error NotThisDaosMandate();
    error ClaimNotEligible();
    error ClaimAlreadyUsed();

    /// @param beneficiaries The wallets whose Shares are locked.
    /// @param totals        Each wallet's whole allocation, in Share base units.
    /// @param checks        The acceptance check of each milestone, in order (shared by every beneficiary).
    /// @param bps           The part of the allocation each milestone unlocks. They add up to at most 10,000; what they
    ///                      leave out is not locked at all.
    constructor(
        address dao_,
        address[] memory beneficiaries,
        uint256[] memory totals,
        bytes32[] memory checks,
        uint16[] memory bps
    ) {
        if (
            dao_ == address(0) || beneficiaries.length != totals.length || checks.length != bps.length
                || checks.length == 0 || checks.length > MAX_TRANCHES
        ) revert BadSchedule();
        uint256 sum;
        for (uint256 i; i < bps.length; ++i) {
            if (bps[i] == 0 || checks[i] == bytes32(0)) revert BadSchedule();
            sum += bps[i];
            for (uint256 j; j < i; ++j) {
                if (checks[j] == checks[i]) revert BadSchedule(); // one check, one milestone
            }
        }
        if (sum > BPS) revert BadSchedule();
        dao = dao_;
        badge = new MilestoneBadge(address(this));
        for (uint256 b; b < beneficiaries.length; ++b) {
            address who = beneficiaries[b];
            if (who == address(0) || _tranches[who].length != 0 || totals[b] > type(uint96).max) revert BadSchedule();
            for (uint256 i; i < checks.length; ++i) {
                uint256 amount = (totals[b] * bps[i]) / BPS;
                if (amount == 0) revert BadSchedule();
                _tranches[who].push(Tranche(checks[i], uint96(amount), false, false));
                totalLocked += amount;
            }
        }
    }

    // ---- what the Shares contract asks ------------------------------------------------------------

    /// @notice Every tranche still neither unlocked nor forfeited, across the team: the Shares the DAO's exit leaves out of its
    /// total (D72). Kept as a counter so an exit reads one slot, not every tranche; it always equals the sum of `lockedOf`.
    uint256 public totalLocked;

    /// @notice How many of `holder`'s Shares cannot leave yet: the tranches neither unlocked nor forfeited.
    function lockedOf(address holder) external view returns (uint256 locked) {
        Tranche[] storage t = _tranches[holder];
        for (uint256 i; i < t.length; ++i) {
            if (!t[i].unlocked && !t[i].forfeited) locked += t[i].amount;
        }
    }

    function trancheCount(address beneficiary) external view returns (uint256) {
        return _tranches[beneficiary].length;
    }

    /// @notice Whether `beneficiary` holds a tranche worded `checkHash` that is neither unlocked nor given up: a milestone
    /// their claim could still reach.
    function isOpenMilestone(address beneficiary, bytes32 checkHash) external view returns (bool) {
        Tranche[] storage t = _tranches[beneficiary];
        for (uint256 i; i < t.length; ++i) {
            if (t[i].checkHash == checkHash && !t[i].unlocked && !t[i].forfeited) return true;
        }
        return false;
    }

    function trancheOf(address beneficiary, uint256 index) external view returns (Tranche memory) {
        if (index >= _tranches[beneficiary].length) revert UnknownTranche();
        return _tranches[beneficiary][index];
    }

    // ---- reaching a milestone ---------------------------------------------------------------------

    /// @notice Unlock `beneficiary`'s tranche `index` with a paid claim of theirs. Anyone may call it.
    /// @param mandate The mandate (created by this DAO) whose reviewers judged the claim.
    function unlock(address beneficiary, uint256 index, address mandate, bytes32 claimId) external {
        if (index >= _tranches[beneficiary].length) revert UnknownTranche();
        Tranche storage tranche = _tranches[beneficiary][index];
        if (tranche.unlocked || tranche.forfeited) revert AlreadyResolved();

        // The mandate must be one this DAO created: anyone can create a mandate for themselves with friendly reviewers.
        IMilestoneFactory factory = IMilestoneFactory(IMilestonePolicy(IMilestoneDao(dao).votingWeight()).mandateFactory());
        if (factory.daos(mandate) != dao) revert NotThisDaosMandate();
        // And when the DAO named its panel at launch, no other mandate will do.
        address panel = factory.milestoneMandate(dao);
        if (panel != address(0) && mandate != panel) revert NotThisDaosMandate();

        address claims = IMilestoneMandate(mandate).claims();
        if (claimUsed[claims][claimId]) revert ClaimAlreadyUsed();
        (address contributor,, bytes32 checkHash, uint8 status) = IMilestoneClaims(claims).claimTerms(claimId);
        // Status 4 is `Paid`: approved by the reviewers and past the challenge window.
        if (
            contributor != beneficiary || status != 4 || checkHash != tranche.checkHash
                || IMilestoneMandate(mandate).claimProject(claimId) == bytes32(0)
        ) revert ClaimNotEligible();

        claimUsed[claims][claimId] = true;
        tranche.unlocked = true;
        totalLocked -= tranche.amount;
        uint256 id = badge.mint(beneficiary, tranche.checkHash, uint16(index), tranche.amount);
        emit Unlocked(beneficiary, index, tranche.amount, claimId, id);
    }

    // ---- the DAO ---------------------------------------------------------------------------------

    /// @notice The DAO gives up on `beneficiary`'s remaining tranches (a founder who left): those Shares are burned.
    /// They are never free in between, so the DAO cannot use this to let the team sell what it has not earned. Returns
    /// the amount burned.
    function forfeit(address beneficiary) external returns (uint96 total) {
        if (msg.sender != dao) revert OnlyDao();
        Tranche[] storage t = _tranches[beneficiary];
        for (uint256 i; i < t.length; ++i) {
            if (!t[i].unlocked && !t[i].forfeited) {
                t[i].forfeited = true;
                total += t[i].amount;
            }
        }
        totalLocked -= total;
        if (total != 0) IMilestoneShares(IMilestoneDao(dao).shares()).burnForfeited(beneficiary, total);
        emit Forfeited(beneficiary, total);
    }
}
