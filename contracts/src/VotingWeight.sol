// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice The fixed Shares allocation policy used by the sole DAO governor.
/// Previewing never changes a position; canonical ballots authenticate and
/// replace an owner's allocation atomically.
interface IVotingWeight {
    /// @notice Maximum target allocation eligible at the opening snapshot.
    function weightFor(bytes32 proposalId, address owner, uint48 snapshot) external view returns (uint256);
    /// @notice Set an owner's allocation, including zero to withdraw it.
    function allocateWeight(
        bytes32 proposalId,
        address owner,
        address caller,
        uint48 snapshot,
        uint8 support,
        uint256 amount
    ) external returns (uint96);
    /// @notice Economic exit is independent of allocation or conviction.
    function mayExit(address owner) external pure returns (bool, uint256);
}
