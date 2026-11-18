// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {stdStorage, StdStorage} from "forge-std/Test.sol";
import {SecondaryMarketFixture, FixedQuote} from "./SecondaryMarketMocks.t.sol";
import {SecondaryMarket} from "../src/SecondaryMarket.sol";

/// @notice A quote token that keeps one base unit of every transfer, so a pull moves less than it was asked
/// to. The market measures what actually arrived, so it must refuse the order.
contract SkimmingQuote is FixedQuote {
    function _update(address from, address to, uint256 amount) internal override {
        if (from != address(0) && to != address(0) && amount > 0) {
            super._update(from, address(0xdead), 1);
            amount -= 1;
        }
        super._update(from, to, amount);
    }
}

/// @title Secondary market single-fault guard pins
/// @dev Guards the other suites reach only on a path nothing else exercises: the quote intake measured
/// against the balance, and the round ledger refusing to pay out more than came in. Each case drives the
/// production entry points, and `scripts/contracts-mutation-check.mjs` removes each guard in turn.
contract SecondaryMarketGuardPins is SecondaryMarketFixture {
    using stdStorage for StdStorage;

    address internal constant SELLER = address(0x5E1101);
    address internal constant BUYER = address(0xB11);

    Launch internal l;

    function _start(FixedQuote q) internal returns (uint256 id) {
        address[] memory holders = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        holders[0] = SELLER;
        amounts[0] = 40e18;
        l = _launchWithQuote(holders, amounts, q, true);
        _approve(l, SELLER);
        _approve(l, BUYER);
        l.quote.mint(BUYER, 1_000_000e6);
        id = _openRoundWith(l);
    }

    /// @dev A quote that hands over less than it was asked to is refused at the bid, and nothing is recorded.
    function test_a_quote_that_delivers_less_than_asked_is_refused() public {
        uint256 id = _start(new SkimmingQuote());
        vm.prank(BUYER);
        vm.expectRevert(SecondaryMarket.BadAmount.selector);
        l.market.bid(id, 2, 0);
        assertEq(l.market.quoteIn(id), 0, "nothing was recorded");
        assertEq(l.quote.balanceOf(address(l.market)), 0, "and nothing was kept");
    }

    /// @dev The same flow with an exact quote goes through, so the refusal above is the measurement.
    function test_the_same_bid_with_an_exact_quote_goes_through() public {
        uint256 id = _start(new FixedQuote());
        vm.prank(BUYER);
        l.market.bid(id, 2, 0);
        assertEq(l.market.quoteIn(id), uint256(2) * MIN_PRICE);
    }

    /// @dev Shares that arrive short are refused the same way. The Shares are the DAO's own audited clone, so
    /// the test makes the market's balance read answer inconsistently (0 before the pull, a number that is not
    /// 0 plus the offer after it) and calls the production `sell`.
    function test_shares_that_do_not_arrive_in_full_are_refused() public {
        uint256 id = _start(new FixedQuote());
        bytes[] memory answers = new bytes[](2);
        answers[0] = abi.encode(uint256(0));
        answers[1] = abi.encode(uint256(1));
        vm.mockCalls(address(l.shares), abi.encodeWithSignature("balanceOf(address)", address(l.market)), answers);
        vm.prank(SELLER);
        vm.expectRevert(SecondaryMarket.BadAmount.selector);
        l.market.sell(id, 2, 0);
        vm.clearMockedCalls();
        assertEq(l.market.sharesIn(id), 0, "nothing was recorded");
    }

    /// @dev If the round's own ledger is ever short of what a claim owes, the claim refuses with its own
    /// typed error instead of a bare arithmetic panic. The ledger cannot be driven short through the
    /// public entry points (that is the point of the guard), so the test corrupts the one slot directly and
    /// then calls the production claim.
    function test_a_claim_larger_than_the_rounds_intake_refuses_with_its_own_error() public {
        uint256 id = _start(new FixedQuote());
        vm.prank(SELLER);
        l.market.sell(id, 2, 0);
        vm.prank(BUYER);
        l.market.bid(id, 2, 0);
        _toSettle(l, id);
        l.market.settle(id);
        uint256 owed = uint256(2) * MIN_PRICE;
        assertEq(l.market.quoteIn(id), owed, "the intake is exactly the sale");
        stdstore.target(address(l.market)).sig("quoteIn(uint256)").with_key(id).checked_write(owed - 1);
        vm.expectRevert(SecondaryMarket.LedgerShort.selector);
        l.market.claimQuote(id, SELLER);
        // Put the ledger back and the same claim pays.
        stdstore.target(address(l.market)).sig("quoteIn(uint256)").with_key(id).checked_write(owed);
        l.market.claimQuote(id, SELLER);
        assertEq(l.quote.balanceOf(SELLER), owed);
        assertEq(l.market.quoteIn(id), 0, "and the intake was drawn down by exactly what it paid");
    }
}
