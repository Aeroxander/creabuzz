// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ContributorKitV2Base} from "./ContributorKitV2.t.sol";
import {ActivationVoting} from "../src/ActivationVoting.sol";
import {SecondaryMarket} from "../src/SecondaryMarket.sol";
import {Payouts, PayoutsFactory} from "../src/Payouts.sol";
import {Moloch, Shares} from "../src/majeur/MolochPatched.sol";
import {TreasuryMandate} from "../src/TreasuryMandate.sol";
import {MandateCurrency} from "./TreasuryMandate.t.sol";

/// @notice Payouts (N10) on a real ContributorKitV2 launch with a real secondary market: Shares the market holds
/// (round escrow, unclaimed buyer Shares, void-round Shares) must never count as units, or the payout slice
/// credited to the market address is stranded (the market forwards no money to anyone) and every other holder's
/// per-unit increment is diluted by units that cannot withdraw. Every call goes through the production kit, market,
/// Shares token, DAO notice and payout module; no test-only helper stands in for any of them.
contract PayoutsMarketTest is ContributorKitV2Base {
    uint256 internal constant REVENUE = 600e18;

    Moloch internal dao;
    Shares internal tokens;
    SecondaryMarket internal market;
    Payouts internal payouts;
    MandateCurrency internal usd;

    /// @dev Founder 200, DAVE 40 (a reviewed award), payouts named by the DAO, trading on, past the cliff so the
    /// founder can sell the 100 that are vested.
    function setUp() public override {
        super.setUp();
        TreasuryMandate budget;
        ActivationVoting variant;
        (dao, budget, variant, market) = _launchV2(_params("payouts"));
        variant;
        tokens = dao.shares();
        usd = new MandateCurrency();
        _award(dao, budget, keccak256("dave"), DAVE, 40e18);

        PayoutsFactory factory = mandateFactory.payoutsFactory();
        address predicted = factory.predict(address(dao), IERC20(address(usd)), 10_000);
        vm.startPrank(address(dao));
        factory.create(address(dao), IERC20(address(usd)), 10_000);
        dao.setPayouts(predicted);
        vm.stopPrank();
        payouts = Payouts(predicted);

        _enableListing(dao, market);
        vm.warp(uint256(CLIFF_END) + 90 days);
        quote.mint(BUYER, 100_000e18);
        vm.prank(BUYER);
        quote.approve(address(market), type(uint256).max);
        vm.prank(FOUNDER);
        tokens.approve(address(market), type(uint256).max);
    }

    function _revenue(uint256 amount) internal {
        usd.mint(address(payouts), amount);
        payouts.distribute();
    }

    /// @dev Open a round with the founder selling 100 lots (100 Shares into escrow) and BUYER bidding for all of
    /// them at the floor.
    function _escrowRound() internal returns (uint256 id) {
        vm.prank(address(dao));
        id = market.openRound();
        vm.prank(FOUNDER);
        market.sell(id, 100, 0);
        vm.prank(BUYER);
        market.bid(id, 100, 0);
    }

    function _owedSum() internal view returns (uint256) {
        return payouts.owed(FOUNDER) + payouts.owed(DAVE) + payouts.owed(BUYER) + payouts.owed(address(market));
    }

    /// @dev The market must be owed nothing and must not count, and the money credited must all be reachable by
    /// the people who can withdraw it.
    function _assertNothingStranded(uint256 credited) internal view {
        assertEq(payouts.owed(address(market)), 0, "the market is owed nothing");
        assertEq(payouts.unitsOf(address(market)), 0, "the market holds no units");
        assertApproxEqAbs(_owedSum(), credited, 4, "everything credited can be withdrawn by a person");
    }

    function test_shares_in_round_escrow_neither_count_nor_strand_payouts() public {
        uint256 total = payouts.counting();
        assertEq(total, 240e18, "founder 200 and Dave 40 count before any escrow");
        _escrowRound();
        assertEq(tokens.balanceOf(address(market)), 100e18, "the founder's lots sit in the market");
        assertEq(payouts.counting(), 140e18, "escrowed Shares are not units");

        _revenue(REVENUE);
        _assertNothingStranded(REVENUE);
        // Founder keeps earning on the 100 they still hold; Dave is not diluted by the escrow.
        assertApproxEqAbs(payouts.owed(FOUNDER), REVENUE * 100 / 140, 4);
        assertApproxEqAbs(payouts.owed(DAVE), REVENUE * 40 / 140, 4);
        vm.expectRevert(abi.encodeWithSelector(Payouts.NothingOwed.selector, address(market)));
        payouts.withdraw(address(market));
        assertEq(usd.balanceOf(address(market)), 0, "nothing is ever paid to the market");

        // Settle, claim: the buyer counts from the moment the Shares reach them.
        vm.warp(block.timestamp + 3 days + 2);
        market.settle(1);
        _revenue(REVENUE);
        // Between settle and claim the buyer's Shares are still held by the market and earn nothing.
        _assertNothingStranded(2 * REVENUE);
        vm.prank(BUYER);
        market.claimShares(1, BUYER);
        assertEq(payouts.unitsOf(BUYER), 100e18);
        assertEq(payouts.counting(), 240e18, "every Share is back with a person");
        uint256 buyerBefore = payouts.owed(BUYER);
        assertEq(buyerBefore, 0, "nothing from before they held them");
        _revenue(REVENUE);
        _assertNothingStranded(3 * REVENUE);
        assertApproxEqAbs(payouts.owed(BUYER), REVENUE * 100 / 240, 4);
        vm.prank(FOUNDER);
        market.claimQuote(1, FOUNDER);
        payouts.withdraw(FOUNDER);
        payouts.withdraw(DAVE);
        payouts.withdraw(BUYER);
        assertEq(usd.balanceOf(address(market)), 0);
    }

    function test_a_void_round_returns_escrow_to_counting_without_a_stranded_slice() public {
        _escrowRound();
        _revenue(REVENUE);
        // Nobody settles: the round goes void and the founder's own Shares are still in the market.
        vm.warp(block.timestamp + 3 days + 3 days + 2);
        assertTrue(market.voided(1));
        _revenue(REVENUE);
        _assertNothingStranded(2 * REVENUE);
        assertEq(payouts.counting(), 140e18, "void-round Shares wait in the market and do not count");
        vm.prank(FOUNDER);
        market.claimShares(1, FOUNDER);
        assertEq(payouts.counting(), 240e18);
        assertEq(payouts.unitsOf(FOUNDER), 200e18);
        _revenue(REVENUE);
        _assertNothingStranded(3 * REVENUE);
        // Founder: 100 of 140 first, 100 of 140 second, 200 of 240 third; Dave likewise.
        uint256 founderExpected = REVENUE * 100 / 140 * 2 + REVENUE * 200 / 240;
        assertApproxEqAbs(payouts.owed(FOUNDER), founderExpected, 8);
        payouts.withdraw(FOUNDER);
        payouts.withdraw(DAVE);
        assertEq(usd.balanceOf(address(market)), 0);
        // The buyer's whole bid escrow comes back too: nothing about the payout module touches it.
        vm.prank(BUYER);
        market.claimQuote(1, BUYER);
    }
}
