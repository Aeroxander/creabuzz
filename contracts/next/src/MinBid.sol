// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {
    ValidationHookIntrospection
} from "continuous-clearing-auction/src/periphery/validationHooks/ValidationHookIntrospection.sol";

/// @dev The two things this hook reads from the auction that calls it.
interface IAuctionPrice {
    function clearingPrice() external view returns (uint256);
    function endBlock() external view returns (uint64);
}

/// @title MinBid
/// @notice Bid rules for a sale, as an auction `IValidationHook`: no bid under a minimum amount, optionally no top price
/// above a multiple of the current clearing price, and optionally no bid in the last blocks of the sale.
/// @dev The auction calls `validate` on every bid (`ContinuousClearingAuction._submitBid`), after it has checkpointed
/// the block, so `clearingPrice()` is current. `amount` is in raw units of the raised currency, so for a 6-decimal
/// dollar `1_000_000` is one dollar. The auction's own minimum is only "not zero". Stateless and shareable by every
/// sale in the same currency.
///
/// What the top-price rule is, exactly: a bid may name a top price of at most `maxPriceMultiple` times the clearing price AT THE
/// MOMENT OF THAT BID. It is not a fixed multiple of the floor price: bids placed some blocks apart can each name four times the
/// price the one before them set, so the price can climb 4x, 16x, 64x (measured in `MarketAttacks.t.sol`), and what limits it is
/// what it costs, not this rule. The rule only stops one bid from jumping the price further than that in one step.
///
/// Why the closing window exists: the pool opens at the price the sale ends at, and a bid placed in the last blocks can only
/// buy the last blocks' supply, so a few dollars could lift that final price to the top-price limit, shrink the pool's Shares
/// and let a holder of cheap Shares sell into the pool for its dollars (measured in `AttackM3.t.sol`). A bid placed `closingBlocks`
/// before the end has to pay the lifted price on every block until the end, so the lift costs that many blocks of the sale at
/// the lifted price, more than the pool holds. The window is counted with `block.number`, which is the auction's own clock on
/// Ethereum and Sepolia.
contract MinBid is ValidationHookIntrospection {
    /// @notice The smallest accepted bid, in raw units of the raised currency.
    uint128 public immutable minAmount;
    /// @notice The largest accepted top price as a multiple of the clearing price; 0 switches the check off.
    uint256 public immutable maxPriceMultiple;
    /// @notice No bid is accepted in the last this-many blocks of the sale (a bid in the last block is refused when this is 1);
    /// 0 switches the check off.
    uint64 public immutable closingBlocks;

    /// @notice The bid is under the minimum.
    error BidTooSmall(uint128 amount, uint128 minAmount);
    /// @notice The top price is above `maxPriceMultiple` times the clearing price.
    error TopPriceTooHigh(uint256 maxPrice, uint256 limit);
    /// @notice The sale is in its closing window: no bids in the last `closingBlocks` blocks.
    error BidTooLate(uint256 blockNumber, uint256 lastBlock);

    /// @param _minAmount Smallest accepted bid in raw currency units (1_000_000 for one 6-decimal dollar).
    /// @param _maxPriceMultiple Top-price limit as a multiple of the clearing price (4 in the plan); 0 for none.
    /// @param _closingBlocks No bids in the last this-many blocks of a sale (720: the last tenth of a 7,200-block sale); 0 for none.
    constructor(uint128 _minAmount, uint256 _maxPriceMultiple, uint64 _closingBlocks) {
        minAmount = _minAmount;
        maxPriceMultiple = _maxPriceMultiple;
        closingBlocks = _closingBlocks;
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
        if (closingBlocks != 0) {
            uint256 end = IAuctionPrice(msg.sender).endBlock();
            if (block.number + closingBlocks > end) {
                revert BidTooLate(block.number, end > closingBlocks ? end - closingBlocks : 0);
            }
        }
    }
}
