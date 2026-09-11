// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IValidationHook} from "../CCA.sol";

/// @title AllowlistHook
/// @notice Curated-track bid gate: only allowlisted bidders may bid, each
/// capped per wallet. Owner (the launch treasury) manages the list.
contract AllowlistHook is IValidationHook {
    address public immutable owner;
    mapping(address bidder => bool) public allowed;
    mapping(address bidder => uint128) public spent;
    uint128 public perWalletCap;

    event BidderAllowed(address indexed bidder, bool allowed);
    event PerWalletCapUpdated(uint128 perWalletCap);

    error OnlyOwner(address caller);
    error NotAllowlisted(address bidder);
    error OverPerWalletCap(address bidder, uint128 spent, uint128 bid, uint128 cap);

    constructor(address owner_, uint128 perWalletCap_) {
        owner = owner_;
        perWalletCap = perWalletCap_;
    }

    function setBidder(address bidder, bool isAllowed) external {
        if (msg.sender != owner) revert OnlyOwner(msg.sender);
        allowed[bidder] = isAllowed;
        emit BidderAllowed(bidder, isAllowed);
    }

    function setPerWalletCap(uint128 cap) external {
        if (msg.sender != owner) revert OnlyOwner(msg.sender);
        perWalletCap = cap;
        emit PerWalletCapUpdated(cap);
    }

    /// @notice Reverts unless `owner` is allowlisted and within cap. The
    /// auction calls this before accepting a bid; accounting accrues on
    /// validate so repeated bids accumulate against the cap.
    function validate(uint256, uint128 amount, address owner_, address, bytes calldata) external override {
        if (!allowed[owner_]) revert NotAllowlisted(owner_);
        uint128 next = spent[owner_] + amount;
        if (next > perWalletCap) revert OverPerWalletCap(owner_, spent[owner_], amount, perWalletCap);
        spent[owner_] = next;
    }
}
