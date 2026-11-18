// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice The new kit's amount-specific voting and sale policy. Legacy policies do not implement this interface.
interface ISecondaryPolicy {
    /// @notice The DAO this policy belongs to.
    function dao() external view returns (address);
    /// @notice Its single creation-bound market.
    function market() external view returns (address);

    /// @notice Existing Shares `holder` may offer now, independently of their voting maturity.
    function saleCapacity(address holder) external view returns (uint256);
    /// @notice The holder's deposited Shares whose original acquisition history is still held for return.
    function escrowedBalance(address holder) external view returns (uint256);
    /// @notice Market only: consume sold units' seller-age credit; buyers acquire fresh voting history.
    function consumeSoldEscrow(address seller, uint256 amount) external;
    /// @notice Market only: prepare one same-transaction return to its original seller, never to a buyer.
    function prepareEscrowReturn(address seller, uint256 amount) external;
}
