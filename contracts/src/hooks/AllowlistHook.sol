// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IValidationHook, ICcaValidationHookView} from "../CCA.sol";

/// @title AllowlistHook
/// @notice Curated-track bid gate: only allowlisted bidders may bid, each
/// capped per wallet. Owner (the launch treasury) manages the list.
///
/// `validate` is STATEFUL — it accrues each bid against the bidder's per-wallet
/// cap — so it must only ever be driven by the auction the hook gates. The hook
/// is deployed before its auction (the auction bakes the hook address in as its
/// `validationHook`), so the owner binds the auction once, right after it is
/// created, with `setAuction`. Until then, and for every other caller, `validate`
/// reverts: without the bind any stranger could call `validate(...)` with a
/// victim's address and burn that bidder's whole cap.
contract AllowlistHook is IValidationHook {
    address public immutable owner;
    /// @notice The one auction allowed to call `validate` (zero until bound).
    address public auction;
    mapping(address bidder => bool) public allowed;
    mapping(address bidder => uint128) public spent;
    uint128 public perWalletCap;

    event BidderAllowed(address indexed bidder, bool allowed);
    event PerWalletCapUpdated(uint128 perWalletCap);
    event AuctionSet(address indexed auction);

    error OnlyOwner(address caller);
    error NotAllowlisted(address bidder);
    error OverPerWalletCap(address bidder, uint128 spent, uint128 bid, uint128 cap);
    /// @notice `validate` was called by something other than the bound auction.
    error NotAuction(address caller);
    /// @notice `setAuction` already ran; the binding is one-shot.
    error AuctionAlreadySet(address auction);
    /// @notice The address is not a contract, or does not name this hook as its
    /// `validationHook`.
    error BadAuction(address auction);

    constructor(address owner_, uint128 perWalletCap_) {
        owner = owner_;
        perWalletCap = perWalletCap_;
    }

    /// @notice One-shot: bind the auction this hook gates. Owner only. The
    /// auction must already exist and must name THIS hook as its
    /// `validationHook`, so a typo cannot burn the one-shot.
    function setAuction(address auction_) external {
        if (msg.sender != owner) revert OnlyOwner(msg.sender);
        if (auction != address(0)) revert AuctionAlreadySet(auction);
        if (auction_.code.length == 0) revert BadAuction(auction_);
        if (ICcaValidationHookView(auction_).validationHook() != address(this)) {
            revert BadAuction(auction_);
        }
        auction = auction_;
        emit AuctionSet(auction_);
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
    /// validate so repeated bids accumulate against the cap. Callable ONLY by
    /// the bound auction (see the contract note).
    function validate(uint256, uint128 amount, address owner_, address, bytes calldata) external override {
        if (msg.sender != auction || msg.sender == address(0)) revert NotAuction(msg.sender);
        if (!allowed[owner_]) revert NotAllowlisted(owner_);
        uint128 next = spent[owner_] + amount;
        if (next > perWalletCap) revert OverPerWalletCap(owner_, spent[owner_], amount, perWalletCap);
        spent[owner_] = next;
    }
}
