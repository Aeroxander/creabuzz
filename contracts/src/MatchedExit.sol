// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// @title MatchedExit
/// @notice Matched exits (N5, docs/v3-review/NEXT-GEN-DAO.md): a holder who wants out signs an offer, and someone who
/// wants in fills it. The seller keeps the Shares until the fill: an offer is a signature (EIP-712, or ERC-1271 for a
/// smart account), not a deposit, and the fill moves the payment to the seller and the Shares to the buyer in one
/// transaction. The treasury is not touched, so a matched sale raises nothing for the project.
///
/// The Shares move through `transferFrom` with the seller's own allowance to this contract. A DAO whose Shares are locked
/// lets them move only if it named this contract by vote, 30 days ahead (`Shares.announceExitExchange`); every other
/// check of the Shares still applies, so a team member's locked Shares can never be sold here.
///
/// An offer is filled whole, once. The seller cancels one offer with `cancel`, or every offer below a number with
/// `cancelBelow`; offers also expire. No admin, no pause, no fee. The price is the seller's: it is not checked against
/// what leaving would pay, which the page shows beside it.
contract MatchedExit is EIP712 {
    using SafeERC20 for IERC20;

    bytes32 public constant OFFER_TYPEHASH = keccak256(
        "Offer(address shares,address seller,uint256 amount,uint256 price,uint64 expiry,uint256 nonce)"
    );

    /// @notice What every price is paid in.
    IERC20 public immutable currency;

    /// @notice An offer: `amount` of the token `shares` from `seller`, for `price` of the currency in all, until
    /// `expiry`.
    struct Offer {
        address shares;
        address seller;
        uint256 amount;
        uint256 price;
        uint64 expiry;
        uint256 nonce;
    }

    /// @notice Offers that were filled or cancelled, by their EIP-712 digest.
    mapping(bytes32 => bool) public used;
    /// @notice A seller's offers with a lower nonce are cancelled.
    mapping(address => uint256) public minNonce;
    bool private entered;

    error InvalidSetup();
    error EmptyOffer();
    error OfferExpired(uint64 expiry);
    error NonceCancelled();
    error OfferUsed();
    error BadSignature();
    error OwnOffer();
    error NotSeller();
    error ShortPayment(uint256 expected, uint256 received);
    error NonceNotHigher(uint256 current);
    error Reentrancy();

    event OfferFilled(
        bytes32 indexed digest,
        address indexed shares,
        address indexed seller,
        address buyer,
        uint256 amount,
        uint256 price
    );
    event OfferCancelled(bytes32 indexed digest, address indexed seller);
    event OffersCancelledBelow(address indexed seller, uint256 nonce);

    modifier nonReentrant() {
        if (entered) revert Reentrancy();
        entered = true;
        _;
        entered = false;
    }

    constructor(IERC20 currency_) EIP712("Creaton matched exit", "1") {
        if (address(currency_).code.length == 0) revert InvalidSetup();
        currency = currency_;
    }

    /// @notice The EIP-712 digest a seller signs for `offer`.
    function digestOf(Offer calldata offer) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    OFFER_TYPEHASH,
                    offer.shares,
                    offer.seller,
                    offer.amount,
                    offer.price,
                    offer.expiry,
                    offer.nonce
                )
            )
        );
    }

    /// @notice Whether `offer` with `signature` could be filled now, as far as this contract can tell: signed by its
    /// seller, not expired, not cancelled or filled. (The seller's balance and allowance are the token's to say.)
    function isOpen(Offer calldata offer, bytes calldata signature) external view returns (bool) {
        if (offer.amount == 0 || offer.price == 0 || block.timestamp >= offer.expiry) return false;
        if (offer.nonce < minNonce[offer.seller]) return false;
        bytes32 digest = digestOf(offer);
        return !used[digest] && _signedBy(offer.seller, digest, signature);
    }

    /// @notice Buy `offer`: the price goes from the caller to the seller and the Shares from the seller to the caller,
    /// in this one call. Strictly before `expiry`.
    function fill(Offer calldata offer, bytes calldata signature) external nonReentrant {
        if (offer.amount == 0 || offer.price == 0) revert EmptyOffer();
        if (block.timestamp >= offer.expiry) revert OfferExpired(offer.expiry);
        if (offer.nonce < minNonce[offer.seller]) revert NonceCancelled();
        if (msg.sender == offer.seller) revert OwnOffer();
        bytes32 digest = digestOf(offer);
        if (used[digest]) revert OfferUsed();
        if (!_signedBy(offer.seller, digest, signature)) revert BadSignature();
        used[digest] = true;
        uint256 before = currency.balanceOf(offer.seller);
        currency.safeTransferFrom(msg.sender, offer.seller, offer.price);
        uint256 received = currency.balanceOf(offer.seller) - before;
        // A currency that keeps a fee would pay the seller less than they asked.
        if (received != offer.price) revert ShortPayment(offer.price, received);
        IERC20(offer.shares).safeTransferFrom(offer.seller, msg.sender, offer.amount);
        emit OfferFilled(digest, offer.shares, offer.seller, msg.sender, offer.amount, offer.price);
    }

    /// @notice Cancel one of your offers.
    function cancel(Offer calldata offer) external {
        if (msg.sender != offer.seller) revert NotSeller();
        bytes32 digest = digestOf(offer);
        used[digest] = true;
        emit OfferCancelled(digest, msg.sender);
    }

    /// @dev Signed by the seller's own key, or, for an account with code, accepted by its ERC-1271 check. The key comes
    /// first so a wallet with delegated code (EIP-7702) still signs as itself; no key exists for a contract's address.
    function _signedBy(address seller, bytes32 digest, bytes memory signature) internal view returns (bool) {
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
        if (err == ECDSA.RecoverError.NoError && recovered == seller) return true;
        return seller.code.length != 0 && SignatureChecker.isValidERC1271SignatureNow(seller, digest, signature);
    }

    /// @notice Cancel every offer of yours numbered below `nonce`.
    function cancelBelow(uint256 nonce) external {
        uint256 current = minNonce[msg.sender];
        if (nonce <= current) revert NonceNotHigher(current);
        minNonce[msg.sender] = nonce;
        emit OffersCancelledBelow(msg.sender, nonce);
    }
}
