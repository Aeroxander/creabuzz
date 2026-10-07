// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ISnapshotVotes
/// @notice The minimum a token must offer for its balance to count toward
/// voting weight at a past block. `Shares` already satisfies this through its
/// ERC20Votes-like checkpoints; `Loot` needs the same treatment in the fork
/// (docs/token-voting-design.md §7).
interface ISnapshotVotes {
    function getPastVotes(address account, uint48 blockNumber)
        external
        view
        returns (uint256);
}

/// @title IBackingWeight
/// @notice The `backing` term of the voting weight — capital an account has
/// directed to a specific proposal and that is still at risk
/// (`ProposalVault.backingWeightAt`).
interface IBackingWeight {
    function backingWeightAt(bytes32 proposalId, address backer, uint48 atBlock)
        external
        view
        returns (uint256);

    /// @notice Tokens still at risk behind unresolved proposals. The exit gate
    /// reads this instead of walking every position.
    function tokensAtRisk(address backer) external view returns (uint256);
}

/// @title VotingWeight
/// @notice Where the voting weight of one account on one proposal comes from
/// (docs/token-voting-design.md §3):
///
/// ```
/// votes(a, b) = work(a, b) + held(a, b) + backing(a, p, b)
/// ```
///
/// - **work**    `Shares`, earned by verified work — Majeur's own machinery.
/// - **held**    `Loot`, flat, at the snapshot. Waiting earns nothing.
/// - **backing** `Loot` committed to proposal `p`, compounding while at risk.
///
/// This contract is the whole divergence surface: the fork's `vote()` calls
/// `weightFor` instead of reading `shares.getPastVotes` directly, and nothing
/// else in Majeur changes. Keeping the policy here rather than in the fork is
/// what stops the divergence growing as the mechanism evolves.
///
/// ## G6
///
/// Nothing in this contract reads a score, a badge tier or a reputation root.
/// Every term is capital or verified work. That invariant is the reason this
/// is three additions and not a weighted formula, and any future term must
/// keep it (docs/legitimacy-synthesis.md G6).
contract VotingWeight {
    ISnapshotVotes public immutable shares;
    ISnapshotVotes public immutable loot;
    IBackingWeight public immutable backing;

    error ZeroAddress();

    constructor(ISnapshotVotes shares_, ISnapshotVotes loot_, IBackingWeight backing_) {
        if (address(shares_) == address(0) || address(loot_) == address(0)) {
            revert ZeroAddress();
        }
        shares = shares_;
        loot = loot_;
        backing = backing_;
    }

    /// @notice The weight one account casts on one proposal at a snapshot
    /// block. `proposalId` is what makes backing weight per-proposal: capital
    /// you directed to a decision buys you voice on *that* decision.
    function weightFor(bytes32 proposalId, address account, uint48 snapshot)
        public
        view
        returns (uint256)
    {
        uint256 total = shares.getPastVotes(account, snapshot)
            + loot.getPastVotes(account, snapshot);
        if (address(backing) != address(0)) {
            total += backing.backingWeightAt(proposalId, account, snapshot);
        }
        return total;
    }

    /// @notice Whether this account may exit: false while any of its capital
    /// is still at risk behind an unresolved proposal
    /// (docs/token-voting-design.md §6). Returns the amount at risk rather
    /// than a bare boolean so a caller can say *why* the exit is refused.
    function mayExit(address account) public view returns (bool, uint256 atRisk) {
        if (address(backing) == address(0)) return (true, 0);
        atRisk = backing.tokensAtRisk(account);
        return (atRisk == 0, atRisk);
    }
}
