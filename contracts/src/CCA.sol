// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal view of the Uniswap Continuous Clearing Auction surface the
/// launchpad integrates with. Mirrors
/// `Uniswap/continuous-clearing-auction` (factory v2.1.0). Full auction logic
/// lives upstream; this interface binds only the handoff points.
interface IContinuousClearingAuction {
    struct LBPInitializationParams {
        uint256 initialPriceX96;
        uint256 tokensSold;
        uint256 currencyRaised;
    }

    function isGraduated() external view returns (bool);
    function currencyRaised() external view returns (uint256);
    function lbpInitializationParams() external view returns (LBPInitializationParams memory);
    /// @notice The currency bid in (address(0) = native).
    function currency() external view returns (address);
    /// @notice The token the sale distributes.
    function token() external view returns (address);
    /// @notice Recipient allowed to call `sweepCurrency` after the auction ends.
    function fundsRecipient() external view returns (address);
    /// @notice Recipient allowed to call `sweepUnsoldTokens` after the auction ends.
    function tokensRecipient() external view returns (address);
    /// @notice Push the net raised currency to `fundsRecipient` (recipient only).
    function sweepCurrency() external;
    /// @notice Push unsold tokens to `tokensRecipient` (recipient only).
    function sweepUnsoldTokens() external;
}

/// @notice Finalization handoff points the executor drives at the close of an
/// auction. Kept separate from `IContinuousClearingAuction` so minimal mocks
/// and sweep-only consumers need not implement them.
interface ICcaFinalization {
    /// @notice Materialize the checkpoint at the current block; after the end
    /// block this records the final raise that `isGraduated()` reads (which
    /// otherwise only sees the latest stale checkpoint). Anyone may call it.
    /// @dev Mirrors upstream `checkpoint()`, whose returned checkpoint data
    /// this binding intentionally ignores (same selector).
    function checkpoint() external;
    /// @notice The block at which the auction ends; the auction is over once
    /// `block.number >= endBlock()`.
    function endBlock() external view returns (uint64);
}

/// @notice Downstream strategy consumed by a graduated auction. The canonical
/// implementation seeds a Uniswap v4 pool; the launchpad deploys
/// `AppTokenLBPInitializer` instead to seed apptoken rails.
interface ILBPInitializer {
    function onGraduation(address auction, IContinuousClearingAuction.LBPInitializationParams calldata params) external;
}

/// @notice Bid-gating hook called by the auction before accepting a bid.
/// Mirrors `IValidationHook` upstream: revert to reject the bid.
interface IValidationHook {
    function validate(uint256 maxPrice, uint128 amount, address owner, address sender, bytes calldata hookData) external;
}
