// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IProtocolFeeController} from "liquidity-launcher/src/interfaces/IProtocolFeeController.sol";

/// @title FixedFeeController
/// @notice The fee source for our own deployment of the auction factory: one rate and one recipient, both set when
/// this contract is deployed and never changeable. The vendored `ProtocolFeeController` is owner-controlled and lets
/// its owner pick any rate up to 100 percent; the auction reads the controller again at every sweep, so a mutable one
/// could change the platform's cut in the middle of a sale. This one has no owner and no setters.
/// @dev The auction swallows a reverting fee call as "no fee" (`ProtocolFeeLib.getProtocolFeeAmount`), so nothing here
/// may revert. The setters of the interface exist only to refuse.
contract FixedFeeController is IProtocolFeeController {
    /// @notice Pips are millionths: 1,000,000 is 100 percent.
    uint256 public constant PIPS_DENOMINATOR = 1_000_000;
    /// @notice Hard ceiling for any deployment, 5 percent, so a typo in a deploy script cannot take more.
    uint24 public constant MAX_FEE_PIPS = 50_000;

    /// @notice Where the auction sends the fee.
    address public immutable protocolFeeRecipient;
    /// @notice The fee in pips (30,000 is 3 percent).
    uint24 public immutable feePips;

    /// @notice A setter was called. There are none: deploy a new controller and a new factory instead.
    error Immutable();
    /// @notice The recipient was the zero address.
    error ZeroRecipient();

    /// @param recipient Receives the fee in the raised currency. Must not be the zero address.
    /// @param pips The fee in millionths; at most `MAX_FEE_PIPS`.
    constructor(address recipient, uint24 pips) {
        if (recipient == address(0)) revert ZeroRecipient();
        if (pips > MAX_FEE_PIPS) revert InvalidFeePips(pips, MAX_FEE_PIPS);
        protocolFeeRecipient = recipient;
        feePips = pips;
    }

    /// @inheritdoc IProtocolFeeController
    /// @dev Rounds down. The multiplication cannot overflow for any amount an auction can raise (below 2^128).
    function getProtocolFeeAmount(address, uint256 amount) external view returns (uint256) {
        return amount * feePips / PIPS_DENOMINATOR;
    }

    /// @inheritdoc IProtocolFeeController
    function getProtocolFeeBracketsForCurrency(address) external pure returns (ProtocolFeeBracket[] memory fees) {
        return fees;
    }

    /// @inheritdoc IProtocolFeeController
    function setProtocolFeeRecipient(address) external pure {
        revert Immutable();
    }

    /// @inheritdoc IProtocolFeeController
    function setGlobalProtocolFeePips(uint24) external pure {
        revert Immutable();
    }

    /// @inheritdoc IProtocolFeeController
    function setProtocolFeeBracketsForCurrency(address, ProtocolFeeBracket[] calldata) external pure {
        revert Immutable();
    }
}
