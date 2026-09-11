// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IValidationHook} from "../CCA.sol";

/// @title TrustGatedHook
/// @notice Community-track bid gate: bidders prove membership in an accepted
/// trustgraph score root with a Merkle proof. The launch treasury rotates the
/// root each epoch; proofs bind (bidder, minScore) leaves.
contract TrustGatedHook is IValidationHook {
    address public immutable owner;
    bytes32 public scoreRoot;
    uint256 public minScore;

    event ScoreRootUpdated(bytes32 scoreRoot, uint256 minScore);

    error OnlyOwner(address caller);
    error BadProof();
    error BelowMinScore(uint256 score, uint256 minScore);

    constructor(address owner_, bytes32 scoreRoot_, uint256 minScore_) {
        owner = owner_;
        scoreRoot = scoreRoot_;
        minScore = minScore_;
    }

    function setScoreRoot(bytes32 scoreRoot_, uint256 minScore_) external {
        if (msg.sender != owner) revert OnlyOwner(msg.sender);
        scoreRoot = scoreRoot_;
        minScore = minScore_;
        emit ScoreRootUpdated(scoreRoot_, minScore_);
    }

    /// @notice `hookData` = abi.encode(score, bytes32[] proof). Leaf =
    /// keccak256(abi.encode(bidder, score)). Reverts on bad proof or low score.
    function validate(uint256, uint128, address owner_, address, bytes calldata hookData) external view override {
        (uint256 score, bytes32[] memory proof) = abi.decode(hookData, (uint256, bytes32[]));
        if (score < minScore) revert BelowMinScore(score, minScore);
        bytes32 node = keccak256(abi.encode(owner_, score));
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 sibling = proof[i];
            node = node <= sibling
                ? keccak256(abi.encodePacked(node, sibling))
                : keccak256(abi.encodePacked(sibling, node));
        }
        if (node != scoreRoot) revert BadProof();
    }
}
