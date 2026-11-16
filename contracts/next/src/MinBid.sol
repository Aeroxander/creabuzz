// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {
    ValidationHookIntrospection
} from "continuous-clearing-auction/src/periphery/validationHooks/ValidationHookIntrospection.sol";

/// @dev The one thing this hook reads from the auction that calls it.
interface IAuctionPrice {
    function clearingPrice() external view returns (uint256);
}

/// @title MinBid
/// @notice Bid rules for a sale, as an auction `IValidationHook`: no bid under a minimum amount, and optionally no
/// top price above a multiple of the current clearing price.
/// @dev The auction calls `validate` on every bid (`ContinuousClearingAuction._submitBid`), after it has checkpointed
/// the block, so `clearingPrice()` is current. `amount` is in raw units of the raised currency, so for a 6-decimal
/// dollar `1_000_000` is one dollar. The auction's own minimum is only "not zero". Stateless and shareable by every
/// sale in the same currency.
contract MinBid is ValidationHookIntrospection {
    /// @notice The smallest accepted bid, in raw units of the raised currency.
    uint128 public immutable minAmount;
    /// @notice The largest accepted top price as a multiple of the clearing price; 0 switches the check off.
    uint256 public immutable maxPriceMultiple;

    /// @notice The bid is under the minimum.
    error BidTooSmall(uint128 amount, uint128 minAmount);
    /// @notice The top price is above `maxPriceMultiple` times the clearing price.
    error TopPriceTooHigh(uint256 maxPrice, uint256 limit);

    /// @param _minAmount Smallest accepted bid in raw currency units (1_000_000 for one 6-decimal dollar).
    /// @param _maxPriceMultiple Top-price limit as a multiple of the clearing price (4 in the plan); 0 for none.
    constructor(uint128 _minAmount, uint256 _maxPriceMultiple) {
        minAmount = _minAmount;
        maxPriceMultiple = _maxPriceMultiple;
    }

    /// @notice Refuse the bid by reverting; the auction wraps the revert in `ValidationHookCallFailed`.
    /// @param maxPrice The bidder's top price (Q96, currency raw units per token raw unit).
    /// @param amount The bid, in raw units of the raised currency.
    function validate(uint256 maxPrice, uint128 amount, address, address, bytes calldata) external view {
        if (amount < minAmount) revert BidTooSmall(amount, minAmount);
        if (maxPriceMultiple != 0) {
            uint256 limit = IAuctionPrice(msg.sender).clearingPrice() * maxPriceMultiple;
            if (maxPrice > limit) revert TopPriceTooHigh(maxPrice, limit);
        }
    }
}
