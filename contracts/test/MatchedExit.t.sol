// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {VotingFixture} from "./helpers/VotingFixture.sol";
import {MatchedExit} from "../src/MatchedExit.sol";
import {Shares} from "../src/majeur/MolochPatched.sol";
import {MandateCurrency} from "./TreasuryMandate.t.sol";
import {FeeCurrency} from "./WorkAreaBounty.t.sol";

/// @notice Says how many of a holder's Shares are locked, like the milestone lock does.
contract FixedLockGuard {
    mapping(address => uint256) public lockedOf;

    function set(address holder, uint256 amount) external {
        lockedOf[holder] = amount;
    }
}

/// @notice A smart account (a passkey account, say) that approves a digest it was told about, the ERC-1271 way.
contract SmartSeller {
    mapping(bytes32 => bool) public approved;

    function approveDigest(bytes32 digest) external {
        approved[digest] = true;
    }

    function isValidSignature(bytes32 digest, bytes calldata) external view returns (bytes4) {
        return approved[digest] ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }

    function call(address to, bytes calldata data) external {
        (bool ok,) = to.call(data);
        require(ok, "call failed");
    }
}

/// @notice Matched exits (N5) against a real summoned DAO with its Shares locked: a signed offer is filled whole, once,
/// in one transaction; the seller keeps the Shares until then; only the exchange the DAO named 30 days ahead passes the
/// lock, and only with the seller's allowance; locked team Shares can never be sold.
contract MatchedExitTest is VotingFixture {
    uint256 internal constant SELLER_KEY = 0x5E11E2;
    address internal constant BUYER = address(0xB0B0B);
    address internal seller;
    MandateCurrency internal usd;
    MatchedExit internal exit;
    FixedLockGuard internal guard;

    function setUp() public override {
        super.setUp();
        seller = vm.addr(SELLER_KEY);
        vm.prank(ALICE);
        shares.transfer(seller, 40e18);
        usd = new MandateCurrency();
        exit = new MatchedExit(IERC20(address(usd)));
        guard = new FixedLockGuard();
        vm.startPrank(address(dao));
        shares.lockTransfersWithNotice(address(0));
        shares.setLockGuard(address(guard));
        shares.announceExitExchange(address(exit));
        vm.stopPrank();
        vm.warp(block.timestamp + 30 days);
        shares.activateExitExchange();
        usd.mint(BUYER, 1_000e6);
        vm.prank(BUYER);
        usd.approve(address(exit), type(uint256).max);
        vm.prank(seller);
        shares.approve(address(exit), type(uint256).max);
    }

    function _offer(uint256 amount, uint256 price, uint256 nonce) internal view returns (MatchedExit.Offer memory) {
        return MatchedExit.Offer({
            shares: address(shares),
            seller: seller,
            amount: amount,
            price: price,
            expiry: uint64(block.timestamp + 7 days),
            nonce: nonce
        });
    }

    function _sign(MatchedExit.Offer memory offer, uint256 key) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, exit.digestOf(offer));
        return abi.encodePacked(r, s, v);
    }

    function _fill(MatchedExit.Offer memory offer, bytes memory signature) internal {
        vm.prank(BUYER);
        exit.fill(offer, signature);
    }

    // ---- filling -------------------------------------------------------------------------------------------------

    function test_a_signed_offer_is_paid_and_delivered_in_one_transaction_and_the_treasury_is_untouched() public {
        MatchedExit.Offer memory offer = _offer(10e18, 120e6, 1);
        bytes memory signature = _sign(offer, SELLER_KEY);
        uint256 treasury = usd.balanceOf(address(dao));
        assertTrue(exit.isOpen(offer, signature));

        _fill(offer, signature);

        assertEq(shares.balanceOf(BUYER), 10e18);
        assertEq(shares.balanceOf(seller), 30e18);
        assertEq(usd.balanceOf(seller), 120e6);
        assertEq(usd.balanceOf(BUYER), 880e6);
        assertEq(usd.balanceOf(address(dao)), treasury);
        assertTrue(exit.used(exit.digestOf(offer)));
        assertFalse(exit.isOpen(offer, signature));
    }

    function test_the_seller_keeps_the_shares_and_their_votes_until_the_fill() public {
        MatchedExit.Offer memory offer = _offer(10e18, 120e6, 1);
        bytes memory signature = _sign(offer, SELLER_KEY);
        vm.roll(block.number + 1);
        assertEq(shares.balanceOf(seller), 40e18);
        assertEq(shares.getVotes(seller), 40e18);
        _fill(offer, signature);
        vm.roll(block.number + 1);
        assertEq(shares.getVotes(seller), 30e18);
        assertEq(shares.getVotes(BUYER), 10e18);
    }

    function test_a_sale_trims_the_sellers_backing_and_the_buyer_gets_no_say_on_earlier_proposals() public {
        vm.roll(block.number + 1);
        vote(seller, 7, 40e18);
        MatchedExit.Offer memory offer = _offer(30e18, 30e6, 1);
        _fill(offer, _sign(offer, SELLER_KEY));
        (uint96 backing,,,) = ledger.proposalSupport(7);
        assertEq(backing, 10e18, "the seller's backing follows the Shares they still hold");
        assertEq(ledger.weightFor(bytes32(uint256(7)), BUYER, dao.snapshotBlock(7)), 0);
    }

    function test_an_offer_fills_once() public {
        MatchedExit.Offer memory offer = _offer(10e18, 120e6, 1);
        bytes memory signature = _sign(offer, SELLER_KEY);
        _fill(offer, signature);
        vm.prank(BUYER);
        vm.expectRevert(MatchedExit.OfferUsed.selector);
        exit.fill(offer, signature);
    }

    function test_an_offer_fills_until_one_second_before_its_expiry() public {
        MatchedExit.Offer memory early = _offer(1e18, 1e6, 1);
        MatchedExit.Offer memory late = _offer(1e18, 1e6, 2);
        bytes memory earlySig = _sign(early, SELLER_KEY);
        bytes memory lateSig = _sign(late, SELLER_KEY);
        vm.warp(early.expiry - 1);
        _fill(early, earlySig);
        vm.warp(late.expiry);
        assertFalse(exit.isOpen(late, lateSig));
        vm.prank(BUYER);
        vm.expectRevert(abi.encodeWithSelector(MatchedExit.OfferExpired.selector, late.expiry));
        exit.fill(late, lateSig);
    }

    function test_changed_terms_or_another_signer_are_refused() public {
        MatchedExit.Offer memory offer = _offer(10e18, 120e6, 1);
        bytes memory signature = _sign(offer, SELLER_KEY);
        MatchedExit.Offer memory cheaper = _offer(10e18, 1e6, 1);
        vm.prank(BUYER);
        vm.expectRevert(MatchedExit.BadSignature.selector);
        exit.fill(cheaper, signature);
        bytes memory stranger = _sign(offer, 0xBAD);
        vm.prank(BUYER);
        vm.expectRevert(MatchedExit.BadSignature.selector);
        exit.fill(offer, stranger);
    }

    function test_an_empty_offer_and_a_sellers_own_fill_are_refused() public {
        MatchedExit.Offer memory empty = _offer(0, 1e6, 1);
        bytes memory emptySig = _sign(empty, SELLER_KEY);
        vm.prank(BUYER);
        vm.expectRevert(MatchedExit.EmptyOffer.selector);
        exit.fill(empty, emptySig);
        MatchedExit.Offer memory free = _offer(1e18, 0, 1);
        bytes memory freeSig = _sign(free, SELLER_KEY);
        vm.prank(BUYER);
        vm.expectRevert(MatchedExit.EmptyOffer.selector);
        exit.fill(free, freeSig);
        MatchedExit.Offer memory offer = _offer(1e18, 1e6, 1);
        bytes memory signature = _sign(offer, SELLER_KEY);
        vm.prank(seller);
        vm.expectRevert(MatchedExit.OwnOffer.selector);
        exit.fill(offer, signature);
    }

    function test_without_the_sellers_allowance_nothing_moves_not_even_the_payment() public {
        vm.prank(seller);
        shares.approve(address(exit), 0);
        MatchedExit.Offer memory offer = _offer(10e18, 120e6, 1);
        bytes memory signature = _sign(offer, SELLER_KEY);
        vm.prank(BUYER);
        vm.expectRevert();
        exit.fill(offer, signature);
        assertEq(usd.balanceOf(BUYER), 1_000e6);
        assertEq(shares.balanceOf(seller), 40e18);
        assertFalse(exit.used(exit.digestOf(offer)));
    }

    function test_a_currency_that_keeps_a_fee_is_refused() public {
        FeeCurrency fee = new FeeCurrency();
        MatchedExit feeExit = new MatchedExit(IERC20(address(fee)));
        fee.mint(BUYER, 100e6);
        vm.prank(BUYER);
        fee.approve(address(feeExit), type(uint256).max);
        MatchedExit.Offer memory offer = _offer(1e18, 100e6, 1);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SELLER_KEY, feeExit.digestOf(offer));
        vm.prank(BUYER);
        vm.expectRevert(abi.encodeWithSelector(MatchedExit.ShortPayment.selector, 100e6, 99e6));
        feeExit.fill(offer, abi.encodePacked(r, s, v));
        vm.expectRevert(MatchedExit.InvalidSetup.selector);
        new MatchedExit(IERC20(address(0xBEEF)));
    }

    // ---- cancelling ------------------------------------------------------------------------------------------------

    function test_the_seller_cancels_one_offer_or_every_offer_below_a_number_with_no_operator() public {
        MatchedExit.Offer memory one = _offer(1e18, 1e6, 5);
        bytes memory oneSig = _sign(one, SELLER_KEY);
        vm.prank(BUYER);
        vm.expectRevert(MatchedExit.NotSeller.selector);
        exit.cancel(one);
        vm.prank(seller);
        exit.cancel(one);
        vm.prank(BUYER);
        vm.expectRevert(MatchedExit.OfferUsed.selector);
        exit.fill(one, oneSig);

        MatchedExit.Offer memory below = _offer(1e18, 1e6, 6);
        MatchedExit.Offer memory at = _offer(1e18, 1e6, 7);
        bytes memory belowSig = _sign(below, SELLER_KEY);
        bytes memory atSig = _sign(at, SELLER_KEY);
        vm.prank(seller);
        exit.cancelBelow(7);
        assertFalse(exit.isOpen(below, belowSig));
        vm.prank(BUYER);
        vm.expectRevert(MatchedExit.NonceCancelled.selector);
        exit.fill(below, belowSig);
        _fill(at, atSig);
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(MatchedExit.NonceNotHigher.selector, 7));
        exit.cancelBelow(7);
    }

    // ---- the lock ----------------------------------------------------------------------------------------------------

    function test_only_the_named_exchange_as_the_caller_passes_the_lock() public {
        vm.prank(seller);
        vm.expectRevert(bytes4(keccak256("Locked()")));
        shares.transfer(BUYER, 1e18);
        // Another contract with the seller's allowance is still refused: only the named exchange passes.
        MatchedExit other = new MatchedExit(IERC20(address(usd)));
        vm.prank(seller);
        shares.approve(address(other), type(uint256).max);
        MatchedExit.Offer memory offer = _offer(1e18, 1e6, 1);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SELLER_KEY, other.digestOf(offer));
        vm.prank(BUYER);
        usd.approve(address(other), type(uint256).max);
        vm.prank(BUYER);
        vm.expectRevert(bytes4(keccak256("Locked()")));
        other.fill(offer, abi.encodePacked(r, s, v));
    }

    function test_locked_team_shares_can_never_be_sold() public {
        guard.set(seller, 35e18);
        MatchedExit.Offer memory tooMuch = _offer(6e18, 6e6, 1);
        bytes memory tooMuchSig = _sign(tooMuch, SELLER_KEY);
        vm.prank(BUYER);
        vm.expectRevert(Shares.LockedShares.selector);
        exit.fill(tooMuch, tooMuchSig);
        MatchedExit.Offer memory free = _offer(5e18, 5e6, 2);
        _fill(free, _sign(free, SELLER_KEY));
        assertEq(shares.balanceOf(BUYER), 5e18);
    }

    function test_the_exchange_is_named_by_vote_and_switched_on_thirty_days_later_and_switched_off_at_once() public {
        vm.prank(address(dao));
        shares.clearExitExchange();
        assertEq(shares.exitExchange(), address(0));
        MatchedExit.Offer memory offer = _offer(1e18, 1e6, 1);
        bytes memory signature = _sign(offer, SELLER_KEY);
        vm.prank(BUYER);
        vm.expectRevert(bytes4(keccak256("Locked()")));
        exit.fill(offer, signature);

        vm.prank(BUYER);
        vm.expectRevert();
        shares.announceExitExchange(address(exit));
        vm.prank(address(dao));
        vm.expectRevert();
        shares.announceExitExchange(address(0));
        vm.prank(address(dao));
        shares.announceExitExchange(address(exit));
        assertEq(shares.pendingExitExchange(), address(exit));
        uint256 due = shares.exitExchangeAnnouncedAt() + 30 days;

        vm.warp(due - 1);
        vm.expectRevert(Shares.ExitExchangeNotDue.selector);
        shares.activateExitExchange();
        vm.warp(due);
        vm.prank(BUYER); // anyone switches it on once it is due
        shares.activateExitExchange();
        assertEq(shares.exitExchange(), address(exit));
        assertEq(shares.pendingExitExchange(), address(0));
        vm.expectRevert(Shares.ExitExchangeNotDue.selector);
        shares.activateExitExchange();
        MatchedExit.Offer memory later = _offer(1e18, 1e6, 2);
        _fill(later, _sign(later, SELLER_KEY));

        vm.prank(BUYER);
        vm.expectRevert();
        shares.clearExitExchange();
    }

    // ---- a smart account seller -----------------------------------------------------------------------------------

    function test_a_smart_account_seller_signs_the_erc1271_way() public {
        SmartSeller account = new SmartSeller();
        vm.prank(ALICE);
        vm.expectRevert(bytes4(keccak256("Locked()")));
        shares.transfer(address(account), 1e18);
        // Shares reach it the way they reach anyone under the lock: from the DAO (here, an award stands in for it).
        vm.prank(address(dao));
        shares.mintFromMoloch(address(account), 3e18);
        account.call(address(shares), abi.encodeCall(shares.approve, (address(exit), type(uint256).max)));
        MatchedExit.Offer memory offer = MatchedExit.Offer({
            shares: address(shares),
            seller: address(account),
            amount: 2e18,
            price: 20e6,
            expiry: uint64(block.timestamp + 1 days),
            nonce: 1
        });
        vm.prank(BUYER);
        vm.expectRevert(MatchedExit.BadSignature.selector);
        exit.fill(offer, "");
        account.approveDigest(exit.digestOf(offer));
        assertTrue(exit.isOpen(offer, ""));
        vm.prank(BUYER);
        exit.fill(offer, "");
        assertEq(shares.balanceOf(BUYER), 2e18);
        assertEq(usd.balanceOf(address(account)), 20e6);
    }

    // ---- the app ---------------------------------------------------------------------------------------------------

    /// The same offer, exchange and network as `matchedExit.test.mjs`: the digest the app counts offers by is the one the
    /// exchange checks.
    function test_the_digest_is_the_one_the_app_computes() public {
        address at = address(0xE1717);
        vm.etch(at, address(exit).code);
        vm.chainId(31337);
        MatchedExit.Offer memory offer = MatchedExit.Offer({
            shares: address(5), seller: address(6), amount: 10e18, price: 120e6, expiry: 1_790_000_000, nonce: 1
        });
        assertEq(MatchedExit(at).digestOf(offer), 0x92553589ffa8748d01f97ea67137cca6c5d77830dfad65ac9367097508f86ae4);
    }

    function test_a_wallet_with_delegated_code_still_signs_with_its_own_key() public {
        // The seller's address gets code (as EIP-7702 delegation gives it) that refuses every ERC-1271 check.
        vm.etch(seller, address(new SmartSeller()).code);
        MatchedExit.Offer memory offer = _offer(1e18, 1e6, 1);
        bytes memory signature = _sign(offer, SELLER_KEY);
        assertTrue(exit.isOpen(offer, signature));
        _fill(offer, signature);
        assertEq(shares.balanceOf(BUYER), 1e18);
        MatchedExit.Offer memory other = _offer(1e18, 1e6, 2);
        bytes memory stranger = _sign(other, 0xBAD);
        vm.prank(BUYER);
        vm.expectRevert(MatchedExit.BadSignature.selector);
        exit.fill(other, stranger);
    }

    // ---- conservation ---------------------------------------------------------------------------------------------

    function testFuzz_a_fill_moves_exactly_the_offer_and_nothing_else(uint256 amount, uint256 price) public {
        amount = bound(amount, 1, 40e18);
        price = bound(price, 1, 1_000e6);
        MatchedExit.Offer memory offer = _offer(amount, price, 1);
        bytes memory signature = _sign(offer, SELLER_KEY);
        uint256 supply = shares.totalSupply();
        uint256 money = usd.balanceOf(BUYER) + usd.balanceOf(seller) + usd.balanceOf(address(dao));
        _fill(offer, signature);
        assertEq(shares.totalSupply(), supply);
        assertEq(shares.balanceOf(BUYER) + shares.balanceOf(seller), 40e18);
        assertEq(usd.balanceOf(BUYER) + usd.balanceOf(seller) + usd.balanceOf(address(dao)), money);
        assertEq(usd.balanceOf(seller), price);
        assertEq(usd.balanceOf(address(exit)), 0);
        assertEq(shares.balanceOf(address(exit)), 0);
    }
}
