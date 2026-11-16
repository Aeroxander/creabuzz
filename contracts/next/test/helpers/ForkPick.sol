// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Decides what the Sepolia fork suites do with the node they are given, so that a node that cannot serve the
/// pinned block makes them skip or move to a recent block with a plain message, never fail inside `setUp` with a
/// database error. Pure on purpose: `Stack` gathers the three facts by asking the node, and `ForkPick.t.sol` tests
/// every answer without a network.
library ForkPick {
    /// @notice How far behind the node's head the fallback block is. The public node serves state only for the last few
    /// dozen blocks, so a block a few behind the head is always inside it.
    uint256 internal constant RECENT_LAG = 3;

    /// @param skip True when the fork suites should not run.
    /// @param blockNumber The block to fork at (meaningful when `skip` is false).
    /// @param message Why the suites skip or why the block differs from the pin; empty when nothing to say.
    struct Plan {
        bool skip;
        uint256 blockNumber;
        string message;
    }

    /// @param reachable The node answered a block-number request.
    /// @param head The node's latest block (only read when `reachable`).
    /// @param requested `SEPOLIA_FORK_BLOCK`, or 0 when unset.
    /// @param pin The block the suites are written against.
    /// @param served The node returns state (the pool manager's code) at the chosen block.
    /// @param trustCache `SEPOLIA_FORK_TRUST_CACHE` is set: the person says Foundry's local cache holds that block.
    function decide(bool reachable, uint256 head, uint256 requested, uint256 pin, bool served, bool trustCache)
        internal
        pure
        returns (Plan memory)
    {
        if (!reachable) {
            return Plan({
                skip: true,
                blockNumber: 0,
                message: "SEPOLIA_RPC_URL is set but the node did not answer: the Sepolia fork tests are skipped. "
                "Forking needs a live node even when the state is cached."
            });
        }
        uint256 chosen = requested != 0 ? requested : pin;
        if (served || trustCache) return Plan({skip: false, blockNumber: chosen, message: ""});
        if (requested == 0) {
            // The pin has aged out of this node's window and nobody asked for it by name: use a recent block. The
            // suites assert code sizes and behaviour, not one block's numbers, so any recent block does.
            return Plan({
                skip: false,
                blockNumber: head - RECENT_LAG,
                message: "The pinned Sepolia block is no longer served by this node (it keeps state for only a few "
                "dozen blocks), so the fork tests run at a recent block instead. To repeat the pin, use an "
                "archive node, or set SEPOLIA_FORK_TRUST_CACHE=true on the machine whose Foundry cache holds it."
            });
        }
        return Plan({
            skip: true,
            blockNumber: 0,
            message: "The node does not serve state at SEPOLIA_FORK_BLOCK (it is older than the node's window): the "
            "Sepolia fork tests are skipped. Use an archive node, a recent block, or set SEPOLIA_FORK_TRUST_CACHE=true "
            "if Foundry's local cache holds that block."
        });
    }
}
