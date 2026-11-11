// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {ContinuousClearingAuction} from "continuous-clearing-auction/src/ContinuousClearingAuction.sol";
import {AuctionParameters} from "continuous-clearing-auction/src/interfaces/IContinuousClearingAuction.sol";
// Compiled here so its artifact exists for the suites that deploy it by name (ContributorKitV3.t.sol).
import {ContinuousClearingAuctionFactory} from "continuous-clearing-auction/src/ContinuousClearingAuctionFactory.sol";
import {MockProtocolFeeController} from "btt/mocks/MockProtocolFeeController.sol";
import {IPermit2, MockERC20, MockPermit2} from "./LaunchLifecycle.t.sol";

/// @dev The pool, driven through its compiled artifact: this file compiles with the auction's own compiler
/// (0.8.26) and the pool with the project's, so it cannot be imported (as `LaunchLifecycle.t.sol` does for
/// the executor). The shapes below are the pool's own.
interface IBackingPool {
    struct Params {
        uint256 virtualQuote;
        uint256 virtualUnits;
        uint16 projectBps;
        uint16 feeBps;
        uint16 trancheBps;
        uint32 objectionWindow;
        uint32 resolveWindow;
        uint32 claimInterval;
        uint32 abandonAfter;
        uint32 voteSeasoning;
        uint32 voteAfter;
        uint32 earlyWindow;
        uint256 earlyCap;
    }

    struct RoundView {
        uint8 state;
        address auction;
        address claimToken;
        uint256 supply;
        uint64 endBlock;
        uint256 minimumRaise;
        uint256 raised;
        uint256 clearingPriceX96;
        uint256 received;
        uint256 unitsSold;
        uint256 openingPrice;
        uint64 liveAt;
        uint256 unredeemedUnits;
        uint256 holderClaimTokens;
    }

    error NotFactory();
    error TooSoon(uint256 notBefore);
    error RoundNotLive();
    error RoundNotWaiting();
    error RoundNotOver(uint256 endBlock);
    error BadAuction();
    error InsufficientUnits();
    error ZeroAmount();
    error NoSay();
    error InvalidParams();

    function bindRound(address auction, uint256 minimumRaise) external;
    function seedFromAuction() external returns (bool);
    function redeem(uint256 amount) external returns (uint256);
    function buy(uint256 quoteIn, uint256 minUnitsOut, uint256 deadline) external returns (uint256);
    function sell(uint256 unitsIn, uint256 minQuoteOut, uint256 deadline) external returns (uint256);
    function leave(uint256 minQuoteOut, uint256 deadline) external returns (uint256);
    function postMilestone(bytes32 ref) external returns (uint256);
    function resolveMilestone() external returns (bool, uint256);
    function declareAbandoned() external;
    function voteAbandon() external;
    function abandonVotes() external view returns (uint256);
    function votedAbandon(address) external view returns (bool);
    function lastBuyAt(address) external view returns (uint64);
    function voteSeasoning() external view returns (uint32);
    function roundInfo(address holder) external view returns (RoundView memory);
    function roundState() external view returns (uint8);
    function claimToken() external view returns (address);
    function roundSupply() external view returns (uint256);
    function auction() external view returns (address);
    function minimumRaise() external view returns (uint256);
    function clearingPriceX96() external view returns (uint256);
    function openingPrice() external view returns (uint256);
    function unredeemedUnits() external view returns (uint256);
    function unredeemedWeight() external view returns (uint256);
    function liveAt() external view returns (uint64);
    function virtualQuote() external view returns (uint256);
    function virtualUnits() external view returns (uint256);
    function price() external view returns (uint256);
    function reserve() external view returns (uint256);
    function escrow() external view returns (uint256);
    function released() external view returns (uint256);
    function refunded() external view returns (uint256);
    function feesTaken() external view returns (uint256);
    function treasuryOwed() external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function totalWeight() external view returns (uint256);
    function balanceOf(address) external view returns (uint256);
    function weightOf(address) external view returns (uint256);
    function escrowOf(address) external view returns (uint256);
    function canLeave(address) external view returns (bool);
    function abandoned() external view returns (bool);
    function nextClaimAt() external view returns (uint64);
    function abandonableAt() external view returns (uint64);
    function lastReleaseAt() external view returns (uint64);
    function pending() external view returns (uint256);
    function quoteBuy(uint256) external view returns (uint256, uint256, uint256, uint256);
}

interface IClaim {
    function balanceOf(address) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function burn(address, uint256) external;
}

/// @dev A pool waiting for its round, bound to a REAL `ContinuousClearingAuction` (as the factory binds one:
/// this contract stands where the factory's deployer stands), with the real Permit2 pull for bids.
abstract contract BackingRoundFixture is Test {
    uint256 internal constant Q96 = 1 << 96;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant FOUNDER = address(0xF0);
    uint128 internal constant SUPPLY = 100_000_000e18;
    uint64 internal constant BLOCKS = 100;
    uint64 internal constant START = 1_000;
    uint64 internal constant END = START + BLOCKS;
    uint128 internal constant MINIMUM = 2_500e18;

    MockERC20 internal currency;
    address internal treasury;
    IBackingPool internal pool;
    IClaim internal claim;
    ContinuousClearingAuction internal auction;
    /// @dev The round's floor (the price an "open now" curve starts at) and its price step, as the factory derives them.
    uint256 internal floorX96;
    uint256 internal tickX96;

    function terms() internal pure returns (IBackingPool.Params memory p) {
        p.virtualQuote = 25_000e18;
        p.virtualUnits = 1_000_000_000e18;
        p.projectBps = 1000;
        p.feeBps = 100;
        p.trancheBps = 2500;
        p.objectionWindow = 7 days;
        p.resolveWindow = 7 days;
        p.claimInterval = 28 days;
        p.abandonAfter = 180 days;
        p.voteSeasoning = 30 days;
        p.voteAfter = 90 days;
        p.earlyWindow = 1 days;
        p.earlyCap = 1_000e18;
    }

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        vm.roll(START);
        currency = new MockERC20();
        treasury = address(new MockERC20());
        vm.etch(PERMIT2, address(new MockPermit2()).code);
        _open(MINIMUM, address(0));
    }

    /// @dev What `BackingPoolFactory.openWithRound` does, with a short round: the pool, the auction built from
    /// the pool's own numbers, the bind.
    function _open(uint128 minimum, address feeController) internal {
        IBackingPool.Params memory p = terms();
        pool = IBackingPool(
            vm.deployCode(
                "BackingPool.sol:BackingPool", abi.encode(treasury, FOUNDER, address(currency), p, uint256(SUPPLY))
            )
        );
        claim = IClaim(pool.claimToken());
        tickX96 = (p.virtualQuote << 96) / p.virtualUnits / 100;
        floorX96 = tickX96 * 100;
        auction = new ContinuousClearingAuction(address(claim), SUPPLY, _config(minimum), feeController);
        pool.bindRound(address(auction), minimum);
    }

    function _config(uint128 minimum) internal view returns (AuctionParameters memory) {
        return AuctionParameters({
            currency: address(currency),
            tokensRecipient: address(pool),
            fundsRecipient: address(pool),
            startBlock: START,
            endBlock: END,
            claimBlock: END,
            tickSpacing: tickX96,
            validationHook: address(0),
            floorPrice: floorX96,
            requiredCurrencyRaised: minimum,
            auctionStepsData: abi.encodePacked(uint24(10_000_000 / BLOCKS), uint40(BLOCKS))
        });
    }

    /// @dev A bid with a limit a hundred times the floor: far above any price these tests reach, so every bid
    /// is filled in full and exits through `exitBid`.
    function _bid(address bidder, uint128 amount) internal returns (uint256 bidId) {
        currency.mint(bidder, amount);
        vm.startPrank(bidder);
        currency.approve(PERMIT2, amount);
        IPermit2(PERMIT2).approve(address(currency), address(auction), uint160(amount), type(uint48).max);
        bidId = auction.submitBid(floorX96 * 100, amount, bidder, floorX96, "");
        vm.stopPrank();
    }

    /// @dev Collect a bid's claim tokens from the auction (anyone may make these two calls for the owner).
    function _collect(uint256 bidId) internal {
        auction.exitBid(bidId);
        auction.claimTokens(bidId);
    }

    function _redeemAll(address who) internal returns (uint256 units) {
        units = claim.balanceOf(who);
        if (units == 0) return 0;
        vm.prank(who);
        pool.redeem(units);
    }

    function _assertBooks(uint256 donated) internal view {
        assertEq(
            currency.balanceOf(address(pool)),
            pool.reserve() + pool.escrow() + pool.treasuryOwed() + donated,
            "books != balance"
        );
        assertGe(
            (pool.virtualQuote() + pool.reserve()) * (pool.virtualUnits() - pool.totalSupply()),
            pool.virtualQuote() * pool.virtualUnits(),
            "the curve's product is under its floor"
        );
    }
}

/// @notice The opening round against the real auction: waiting, going live, failing, redeeming, and what
/// cannot be done to it.
contract BackingRoundTest is BackingRoundFixture {
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);
    address internal constant CAROL = address(0xCA201);
    address internal constant MALLORY = address(0xBAD);

    event RoundSeeded(
        uint256 received,
        uint256 fee,
        uint256 toEscrow,
        uint256 toReserve,
        uint256 unitsSold,
        uint256 clearingPriceX96,
        uint256 openingPrice,
        uint256 virtualQuote
    );
    event RoundFailed(address indexed auction, uint256 raised, uint256 minimumRaise);
    event Redeemed(address indexed backer, uint256 units, uint256 weight);

    /// @dev Three bidders at three moments of the round, 12,000 in all: the price climbs, so they pay
    /// different prices for their tokens.
    function _threeBids() internal returns (uint256 a, uint256 b, uint256 c) {
        a = _bid(ALICE, 2_000e18);
        vm.roll(START + 30);
        b = _bid(BOB, 4_000e18);
        vm.roll(START + 70);
        c = _bid(CAROL, 6_000e18);
        vm.roll(END);
    }

    // ---- waiting --------------------------------------------------------------------------------------------------

    function test_a_pool_opened_with_a_round_waits_and_the_auction_holds_the_claim_tokens() public view {
        assertEq(pool.roundState(), 1);
        assertEq(pool.auction(), address(auction));
        assertEq(pool.roundSupply(), SUPPLY);
        assertEq(pool.minimumRaise(), MINIMUM);
        assertEq(claim.totalSupply(), SUPPLY);
        assertEq(claim.balanceOf(address(auction)), SUPPLY);
        assertEq(claim.balanceOf(address(pool)), 0);
        assertEq(auction.fundsRecipient(), address(pool));
        assertEq(auction.tokensRecipient(), address(pool));
        IBackingPool.RoundView memory r = pool.roundInfo(ALICE);
        assertEq(r.state, 1);
        assertEq(r.auction, address(auction));
        assertEq(r.claimToken, address(claim));
        assertEq(r.supply, SUPPLY);
        assertEq(r.endBlock, END);
        assertEq(r.minimumRaise, MINIMUM);
        assertEq(r.raised, 0);
        assertEq(r.clearingPriceX96, floorX96);
        assertEq(r.unitsSold, 0);
        assertEq(r.holderClaimTokens, 0);
        assertEq(pool.totalSupply(), 0);
        // The floor is the price an "open now" curve starts at, to within the auction's price step.
        assertApproxEqRel(floorX96, (uint256(25_000e18) << 96) / 1_000_000_000e18, 1e12);
    }

    function test_nothing_can_be_bought_posted_or_redeemed_while_the_round_runs() public {
        currency.mint(ALICE, 1_000e18);
        vm.startPrank(ALICE);
        currency.approve(address(pool), type(uint256).max);
        vm.expectRevert(IBackingPool.RoundNotLive.selector);
        pool.buy(100e18, 0, type(uint256).max);
        vm.expectRevert(IBackingPool.RoundNotLive.selector);
        pool.redeem(1);
        vm.stopPrank();
        vm.warp(block.timestamp + 60 days);
        vm.prank(FOUNDER);
        vm.expectRevert(IBackingPool.RoundNotLive.selector);
        pool.postMilestone(keccak256("m"));
        assertFalse(pool.abandoned());
        vm.expectRevert();
        pool.declareAbandoned();
    }

    function test_the_round_cannot_be_settled_before_it_ends() public {
        _bid(ALICE, 5_000e18);
        vm.roll(END - 1);
        vm.expectRevert(abi.encodeWithSelector(IBackingPool.RoundNotOver.selector, uint256(END)));
        pool.seedFromAuction();
    }

    function test_only_the_creator_binds_and_only_once_and_only_an_auction_for_this_pool() public {
        vm.prank(MALLORY);
        vm.expectRevert(IBackingPool.NotFactory.selector);
        pool.bindRound(address(auction), MINIMUM);
        vm.expectRevert(IBackingPool.RoundNotWaiting.selector);
        pool.bindRound(address(auction), MINIMUM);

        // A second pool, and auctions that are not for it.
        IBackingPool other = IBackingPool(
            vm.deployCode(
                "BackingPool.sol:BackingPool",
                abi.encode(treasury, FOUNDER, address(currency), terms(), uint256(SUPPLY))
            )
        );
        vm.expectRevert(IBackingPool.BadAuction.selector);
        other.bindRound(address(auction), MINIMUM);
        vm.expectRevert(IBackingPool.BadAuction.selector);
        other.bindRound(address(0x1234), MINIMUM);
        // The right token, but someone else collects the money.
        AuctionParameters memory config = _config(MINIMUM);
        config.tokensRecipient = address(other);
        ContinuousClearingAuction wrong =
            new ContinuousClearingAuction(other.claimToken(), SUPPLY, config, address(0));
        vm.expectRevert(IBackingPool.BadAuction.selector);
        other.bindRound(address(wrong), MINIMUM);
        // Another currency.
        config.fundsRecipient = address(other);
        config.currency = address(new MockERC20());
        wrong = new ContinuousClearingAuction(other.claimToken(), SUPPLY, config, address(0));
        vm.expectRevert(IBackingPool.BadAuction.selector);
        other.bindRound(address(wrong), MINIMUM);
    }

    function test_a_pool_without_a_round_has_no_round_surface() public {
        IBackingPool plain = IBackingPool(
            vm.deployCode(
                "BackingPool.sol:BackingPool", abi.encode(treasury, FOUNDER, address(currency), terms(), uint256(0))
            )
        );
        assertEq(plain.roundState(), 0);
        assertEq(plain.claimToken(), address(0));
        assertEq(plain.roundInfo(ALICE).state, 0);
        assertEq(plain.virtualQuote(), 25_000e18);
        vm.expectRevert(IBackingPool.RoundNotWaiting.selector);
        plain.bindRound(address(auction), MINIMUM);
        vm.expectRevert(IBackingPool.RoundNotWaiting.selector);
        plain.seedFromAuction();
        vm.expectRevert(IBackingPool.RoundNotLive.selector);
        plain.redeem(1);
    }

    function test_the_round_supply_is_at_most_half_the_curve() public {
        assertEq(_tryCreate(500_000_000e18 + 1), address(0));
        assertEq(_tryCreate(1e18 - 1), address(0));
        assertTrue(_tryCreate(500_000_000e18) != address(0));
    }

    function _tryCreate(uint256 supply) internal returns (address made) {
        bytes memory code = abi.encodePacked(
            vm.getCode("BackingPool.sol:BackingPool"), abi.encode(treasury, FOUNDER, address(currency), terms(), supply)
        );
        assembly {
            made := create(0, add(code, 0x20), mload(code))
        }
    }

    // ---- going live -----------------------------------------------------------------------------------------------

    function test_a_round_that_reached_its_minimum_seeds_the_pool_exactly() public {
        _threeBids();
        vm.roll(END);
        // Anyone settles.
        vm.prank(MALLORY);
        assertTrue(pool.seedFromAuction());

        assertEq(pool.roundState(), 2);
        // Every bid was spent in full (to within the auction's own rounding), and all of it arrived here.
        uint256 received = currency.balanceOf(address(pool));
        assertApproxEqAbs(received, 12_000e18, 1e9);
        assertLe(currency.balanceOf(address(auction)), 1e9);
        // Split as a buy of 12,000 is: 1% fee, 10% of the rest to the escrow, the rest to the reserve.
        uint256 fee = (received + 99) / 100;
        uint256 toEscrow = (received - fee + 9) / 10;
        assertEq(pool.feesTaken(), fee);
        assertEq(pool.treasuryOwed(), fee);
        assertEq(pool.escrow(), toEscrow);
        assertEq(pool.reserve(), received - fee - toEscrow);
        assertApproxEqAbs(pool.reserve(), 10_692e18, 1e9);
        _assertBooks(0);

        // The whole supply sold (demand was well over the floor), and it is all waiting to be redeemed.
        uint256 sold = pool.totalSupply();
        assertApproxEqRel(sold, SUPPLY, 1e9);
        assertEq(pool.unredeemedUnits(), sold);
        assertEq(pool.totalWeight(), pool.unredeemedWeight());
        assertEq(claim.balanceOf(address(pool)), SUPPLY - sold, "what was not sold came back and stays here");

        // The curve is the one a single buy of the reserve would have left.
        assertEq(pool.virtualQuote(), pool.reserve() * (pool.virtualUnits() - sold) / sold);
        IBackingPool.RoundView memory r = pool.roundInfo(address(0));
        assertEq(r.received, received);
        assertEq(r.unitsSold, sold);
        assertEq(r.liveAt, block.timestamp);
        assertEq(r.clearingPriceX96, pool.clearingPriceX96());
        assertEq(r.openingPrice, pool.price());
        // It opens at the average the round paid into the reserve, scaled by the units left on the curve:
        // 10,692 / 100,000,000 a unit, times 10/9.
        assertApproxEqRel(pool.openingPrice(), uint256(10_692e18) * 1e36 / sold * 10 / 9, 1e9);
        // The clearing price ended above the average paid (the price climbed), and the curve's buy price
        // opens below it: what the document says plainly.
        uint256 clearing = pool.clearingPriceX96() * 1e36 / Q96;
        assertGt(clearing, received * 1e36 / sold, "last price above the average price");
        assertLt(pool.openingPrice() * 10_000 * 10_000 / (9_900 * 9_000), clearing);
    }

    function test_settling_twice_is_refused() public {
        _threeBids();
        pool.seedFromAuction();
        vm.expectRevert(IBackingPool.RoundNotWaiting.selector);
        pool.seedFromAuction();
    }

    function test_bidders_collect_claim_tokens_and_redeem_them_for_units_one_for_one() public {
        (uint256 a, uint256 b, uint256 c) = _threeBids();
        pool.seedFromAuction();
        _collect(a);
        _collect(b);
        _collect(c);
        uint256 aliceTokens = claim.balanceOf(ALICE);
        uint256 bobTokens = claim.balanceOf(BOB);
        uint256 carolTokens = claim.balanceOf(CAROL);
        // Alice bid first, at the lowest prices: more tokens per quote than Carol.
        assertGt(aliceTokens * 3, carolTokens);
        assertLe(aliceTokens + bobTokens + carolTokens, pool.totalSupply());
        assertEq(pool.roundInfo(ALICE).holderClaimTokens, aliceTokens);

        uint256 bucket = pool.unredeemedWeight();
        uint256 unredeemed = pool.unredeemedUnits();
        vm.expectEmit(true, false, false, true, address(pool));
        emit Redeemed(ALICE, aliceTokens, bucket * aliceTokens / unredeemed);
        vm.prank(ALICE);
        uint256 weight = pool.redeem(aliceTokens);

        assertEq(pool.balanceOf(ALICE), aliceTokens);
        assertEq(pool.weightOf(ALICE), weight);
        assertEq(claim.balanceOf(ALICE), 0, "burned");
        assertEq(claim.totalSupply(), SUPPLY - aliceTokens);
        assertEq(pool.unredeemedUnits(), unredeemed - aliceTokens);
        assertEq(pool.unredeemedWeight(), bucket - weight);
        // Her part of the round's project money is her part of the tokens.
        assertApproxEqRel(pool.escrowOf(ALICE), pool.escrow() * aliceTokens / pool.totalSupply(), 1e12);
        // Supply and weight did not change: redeeming moves units, it does not make them.
        assertEq(pool.totalWeight(), bucket);

        // And they are ordinary units: she can sell them.
        vm.prank(ALICE);
        uint256 out = pool.sell(aliceTokens, 0, type(uint256).max);
        assertGt(out, 0);
        _assertBooks(0);
    }

    function test_claim_tokens_cannot_be_redeemed_twice_or_without_holding_them() public {
        (uint256 a,,) = _threeBids();
        pool.seedFromAuction();
        _collect(a);
        uint256 tokens = claim.balanceOf(ALICE);
        vm.startPrank(ALICE);
        vm.expectRevert(IBackingPool.ZeroAmount.selector);
        pool.redeem(0);
        pool.redeem(tokens);
        vm.expectRevert();
        pool.redeem(1);
        vm.stopPrank();
        // Mallory holds none.
        vm.prank(MALLORY);
        vm.expectRevert();
        pool.redeem(1e18);
        // More than the round sold.
        vm.prank(MALLORY);
        vm.expectRevert(IBackingPool.InsufficientUnits.selector);
        pool.redeem(uint256(SUPPLY) + 1);
        // Nobody but the pool burns.
        vm.prank(MALLORY);
        vm.expectRevert();
        claim.burn(ALICE, 1);
    }

    function test_claim_tokens_can_change_hands_before_they_are_redeemed() public {
        (uint256 a,,) = _threeBids();
        pool.seedFromAuction();
        _collect(a);
        uint256 tokens = claim.balanceOf(ALICE);
        vm.prank(ALICE);
        claim.transfer(MALLORY, tokens);
        vm.prank(MALLORY);
        pool.redeem(tokens);
        assertEq(pool.balanceOf(MALLORY), tokens);
    }

    function test_after_the_round_the_curve_trades_like_any_other() public {
        (uint256 a, uint256 b, uint256 c) = _threeBids();
        pool.seedFromAuction();
        _collect(a);
        _collect(b);
        _collect(c);
        uint256 opening = pool.price();
        currency.mint(MALLORY, 50_000e18);
        vm.startPrank(MALLORY);
        currency.approve(address(pool), type(uint256).max);
        // The early cap is measured from when the pool was created, so it applies if the round was short.
        uint256 units = pool.buy(1_000e18, 0, type(uint256).max);
        assertGt(pool.price(), opening);
        pool.sell(units, 0, type(uint256).max);
        vm.stopPrank();
        assertGe(pool.price(), opening);
        // Everyone from the round redeems and sells: the reserve pays them all.
        _redeemAll(ALICE);
        _redeemAll(CAROL);
        _redeemAll(BOB);
        address[3] memory who = [CAROL, ALICE, BOB];
        for (uint256 i; i < 3; ++i) {
            uint256 held = pool.balanceOf(who[i]);
            vm.prank(who[i]);
            pool.sell(held, 0, type(uint256).max);
        }
        _assertBooks(0);
    }

    function test_a_round_that_does_not_sell_out_gets_its_unsold_tokens_back() public {
        // A lower minimum, and bids worth 1,500 at the floor: the price never leaves the floor and 60% sells.
        _open(1_000e18, address(0));
        uint256 a = _bid(ALICE, 1_500e18);
        vm.roll(END);
        assertTrue(pool.seedFromAuction());
        uint256 sold = pool.totalSupply();
        assertApproxEqRel(sold, 60_000_000e18, 1e12);
        assertEq(claim.balanceOf(address(pool)), SUPPLY - sold, "the unsold claim tokens are back and stay here");
        assertEq(pool.clearingPriceX96(), floorX96);
        _collect(a);
        assertApproxEqRel(claim.balanceOf(ALICE), sold, 1e9);
        assertLe(claim.balanceOf(ALICE), sold);
        _assertBooks(0);
    }

    // ---- failing --------------------------------------------------------------------------------------------------

    function test_a_round_under_its_minimum_closes_the_pool_and_refunds_through_the_auction() public {
        uint256 a = _bid(ALICE, 1_000e18);
        vm.roll(START + 50);
        uint256 b = _bid(BOB, 1_000e18);
        vm.roll(END);
        vm.expectEmit(true, false, false, false, address(pool));
        emit RoundFailed(address(auction), 0, MINIMUM);
        assertFalse(pool.seedFromAuction());
        assertEq(pool.roundState(), 3);
        assertEq(pool.roundInfo(ALICE).state, 3);
        assertEq(currency.balanceOf(address(pool)), 0);

        // Every bidder takes everything back from the auction itself.
        auction.exitBid(a);
        auction.exitBid(b);
        assertEq(currency.balanceOf(ALICE), 1_000e18);
        assertEq(currency.balanceOf(BOB), 1_000e18);
        assertEq(currency.balanceOf(address(auction)), 0);

        // The pool is closed for good.
        vm.expectRevert(IBackingPool.RoundNotWaiting.selector);
        pool.seedFromAuction();
        vm.prank(ALICE);
        vm.expectRevert(IBackingPool.RoundNotLive.selector);
        pool.buy(1e18, 0, type(uint256).max);
        vm.prank(ALICE);
        vm.expectRevert(IBackingPool.RoundNotLive.selector);
        pool.redeem(1);
        vm.prank(FOUNDER);
        vm.expectRevert(IBackingPool.RoundNotLive.selector);
        pool.postMilestone(keccak256("m"));
        assertFalse(pool.abandoned());
    }

    function test_a_round_nobody_bid_in_fails() public {
        vm.roll(END + 5);
        assertFalse(pool.seedFromAuction());
        assertEq(pool.roundState(), 3);
    }

    // ---- what cannot be done to it --------------------------------------------------------------------------------

    /// @dev Settling is the same whoever does it and whatever anyone did first: checkpointing the auction,
    /// collecting claim tokens early, or racing the call.
    function test_settling_gives_the_same_result_whatever_was_done_first() public {
        (uint256 a,,) = _threeBids();
        uint256 state = vm.snapshotState();
        pool.seedFromAuction();
        uint256 reserve = pool.reserve();
        uint256 escrow = pool.escrow();
        uint256 supply = pool.totalSupply();
        uint256 paper = pool.virtualQuote();
        vm.revertToState(state);

        vm.roll(END + 3);
        vm.startPrank(MALLORY);
        auction.checkpoint();
        auction.exitBid(a);
        auction.claimTokens(a);
        pool.seedFromAuction();
        vm.stopPrank();
        assertEq(pool.reserve(), reserve);
        assertEq(pool.escrow(), escrow);
        assertEq(pool.totalSupply(), supply);
        assertEq(pool.virtualQuote(), paper);
    }

    /// @dev Only the pool can collect the raise, so nobody can take it or settle the auction around the pool.
    function test_nobody_else_can_collect_the_raise_or_the_unsold_tokens() public {
        _threeBids();
        vm.startPrank(MALLORY);
        vm.expectRevert();
        auction.sweepCurrency();
        vm.expectRevert();
        auction.sweepUnsoldTokens();
        vm.stopPrank();
        vm.prank(FOUNDER);
        vm.expectRevert();
        auction.sweepCurrency();
    }

    /// @dev Money or claim tokens sent to the pool or the auction by anyone, before settling, are not the
    /// round's: they change no number, and the books stay exact with the stray money on top.
    function test_stray_transfers_before_settling_change_nothing() public {
        (uint256 a,,) = _threeBids();
        uint256 state = vm.snapshotState();
        pool.seedFromAuction();
        uint256 reserve = pool.reserve();
        uint256 supply = pool.totalSupply();
        vm.revertToState(state);

        currency.mint(address(pool), 777e18);
        currency.mint(address(auction), 333e18);
        // A bidder collects early and throws their claim tokens at the pool.
        _collect(a);
        uint256 thrown = claim.balanceOf(ALICE);
        vm.prank(ALICE);
        claim.transfer(address(pool), thrown);

        pool.seedFromAuction();
        assertEq(pool.reserve(), reserve);
        assertEq(pool.totalSupply(), supply, "the units those tokens stood for still exist, unredeemable");
        assertEq(pool.unredeemedUnits(), supply);
        _assertBooks(777e18);
        assertApproxEqAbs(currency.balanceOf(address(auction)), 333e18, 1e9, "the auction keeps what was sent to it");
    }

    /// @dev A protocol fee taken by the auction is not the pool's to count: only what arrives is split.
    function test_only_what_arrives_from_the_auction_is_split() public {
        MockProtocolFeeController controller = new MockProtocolFeeController();
        controller.setProtocolFeeAmount(600e18);
        controller.setProtocolFeeRecipient(address(0xFEE));
        _open(MINIMUM, address(controller));
        _threeBids();
        pool.seedFromAuction();
        assertEq(currency.balanceOf(address(0xFEE)), 600e18);
        uint256 received = pool.roundInfo(address(0)).received;
        assertApproxEqAbs(received, 11_400e18, 1e9);
        assertEq(currency.balanceOf(address(pool)), received);
        assertEq(pool.feesTaken(), (received + 99) / 100);
        assertApproxEqAbs(pool.escrow(), 1_128.6e18, 1e9);
        assertApproxEqAbs(pool.reserve(), 10_157.4e18, 1e9);
        _assertBooks(0);
    }

    // ---- milestones after a round ---------------------------------------------------------------------------------

    function test_the_first_milestone_waits_an_interval_from_going_live() public {
        _threeBids();
        vm.warp(block.timestamp + 20 days);
        pool.seedFromAuction();
        assertEq(pool.nextClaimAt(), block.timestamp + 28 days);
        assertEq(pool.abandonableAt(), block.timestamp + 180 days);
        vm.warp(block.timestamp + 28 days - 1);
        vm.prank(FOUNDER);
        vm.expectRevert();
        pool.postMilestone(keccak256("m"));
        vm.warp(block.timestamp + 1);
        vm.prank(FOUNDER);
        pool.postMilestone(keccak256("m"));
    }

    /// @dev At a milestone a round buyer redeems and leaves with their whole part, and the tranche comes from
    /// everyone else, redeemed or not: weight nobody has redeemed counts as staying.
    function test_a_round_buyer_redeems_and_leaves_at_the_first_milestone() public {
        (uint256 a, uint256 b, uint256 c) = _threeBids();
        pool.seedFromAuction();
        _collect(a);
        _collect(b);
        _collect(c);
        _redeemAll(BOB);
        uint256 escrow = pool.escrow();
        uint256 supply = pool.totalSupply();
        uint256 aliceTokens = claim.balanceOf(ALICE);
        uint256 alicePart = escrow * aliceTokens / supply;

        vm.warp(pool.nextClaimAt());
        vm.prank(FOUNDER);
        pool.postMilestone(keccak256("m"));
        assertEq(pool.pending(), escrow / 4);
        // She has not redeemed: she cannot leave yet.
        vm.prank(ALICE);
        vm.expectRevert(IBackingPool.NoSay.selector);
        pool.leave(0, type(uint256).max);
        _redeemAll(ALICE);
        assertTrue(pool.canLeave(ALICE));
        assertApproxEqRel(pool.escrowOf(ALICE), alicePart, 1e12);
        uint256 before = currency.balanceOf(ALICE);
        vm.prank(ALICE);
        pool.leave(0, type(uint256).max);
        assertApproxEqRel(pool.refunded(), alicePart, 1e12);
        assertGt(currency.balanceOf(ALICE) - before, alicePart);

        vm.warp(block.timestamp + 7 days);
        (bool wasReleased, uint256 amount) = pool.resolveMilestone();
        assertTrue(wasReleased);
        // A quarter of what Bob (redeemed) and Carol (not redeemed) hold between them.
        assertApproxEqRel(amount, (escrow - alicePart) / 4, 1e12);
        // Carol redeems afterwards and finds her part a quarter smaller, like Bob's.
        uint256 carolTokens = claim.balanceOf(CAROL);
        _redeemAll(CAROL);
        assertApproxEqRel(pool.escrowOf(CAROL), escrow * carolTokens / supply * 3 / 4, 1e12);
        _assertBooks(0);
    }

    function test_after_abandonment_round_buyers_redeem_and_are_refunded() public {
        (uint256 a, uint256 b, uint256 c) = _threeBids();
        pool.seedFromAuction();
        _collect(a);
        _collect(b);
        _collect(c);
        uint256 escrow = pool.escrow();
        uint256 supply = pool.totalSupply();
        vm.warp(pool.abandonableAt());
        assertTrue(pool.abandoned());
        uint256 tokens = claim.balanceOf(CAROL);
        _redeemAll(CAROL);
        uint256 before = currency.balanceOf(CAROL);
        vm.prank(CAROL);
        pool.sell(tokens, 0, type(uint256).max);
        assertApproxEqRel(pool.refunded(), escrow * tokens / supply, 1e12);
        assertGt(currency.balanceOf(CAROL) - before, pool.refunded());
        _assertBooks(0);
    }

    // ---- any distribution of bids ---------------------------------------------------------------------------------

    /// @dev Whatever three bidders bid and whenever: if the round reaches its minimum the pool's books are exact
    /// to the unit at the moment it goes live, the curve's product is at or above its floor, and every bidder
    /// can collect, redeem and sell, in any order; if it does not, every bidder gets everything back.
    function testFuzz_any_round_ends_exact_and_nobody_is_stuck(
        uint128 a,
        uint128 b,
        uint128 c,
        uint8 blockB,
        uint8 blockC,
        uint8 order
    ) public {
        // Up to 60,000 in all, in the first 60% of the round: the price stays under the bids' limit (a hundred
        // times the floor), so every bid is filled in full.
        a = uint128(bound(a, 1e18, 20_000e18));
        b = uint128(bound(b, 1e18, 20_000e18));
        c = uint128(bound(c, 1e18, 20_000e18));
        uint256[3] memory ids;
        address[3] memory who = [ALICE, BOB, CAROL];
        ids[0] = _bid(ALICE, a);
        vm.roll(START + bound(blockB, 0, 30));
        ids[1] = _bid(BOB, b);
        vm.roll(START + 30 + bound(blockC, 0, 30));
        ids[2] = _bid(CAROL, c);
        vm.roll(END);

        bool live = pool.seedFromAuction();
        if (!live) {
            assertLt(uint256(a) + b + c, MINIMUM + 3);
            for (uint256 i; i < 3; ++i) {
                auction.exitBid(ids[i]);
            }
            assertEq(currency.balanceOf(ALICE), a);
            assertEq(currency.balanceOf(BOB), b);
            assertEq(currency.balanceOf(CAROL), c);
            assertEq(currency.balanceOf(address(pool)), 0);
            return;
        }
        _assertBooks(0);
        uint256 received = pool.reserve() + pool.escrow() + pool.feesTaken();
        assertEq(received, pool.roundInfo(address(0)).received);
        assertLe(received, uint256(a) + b + c);
        assertLe(pool.totalSupply(), SUPPLY);
        // The opening price is never above what the round paid on average, scaled for the units left.
        assertLe(
            pool.openingPrice(),
            received * 1e36 / pool.totalSupply() * pool.virtualUnits() / (pool.virtualUnits() - pool.totalSupply())
        );

        uint256 sold = pool.totalSupply();
        uint256 claimed;
        uint256 refunds;
        for (uint256 i; i < 3; ++i) {
            uint256 k = (i + order) % 3;
            _collect(ids[k]);
            refunds += currency.balanceOf(who[k]);
            uint256 tokens = _redeemAll(who[k]);
            claimed += tokens;
            if (tokens != 0) {
                vm.prank(who[k]);
                pool.sell(tokens, 0, type(uint256).max);
            }
        }
        // Bidders never hold more claim tokens than the units set aside for them, and no bid money went missing.
        assertLe(claimed, sold);
        assertEq(pool.unredeemedUnits(), pool.totalSupply());
        assertEq(currency.balanceOf(address(auction)) + received + refunds, uint256(a) + b + c);
        _assertBooks(0);
    }
}

/// @dev A contract that takes claim tokens and, in one transaction, exchanges them and votes.
contract RoundVoteSniper {
    function snipe(IBackingPool pool, IClaim claim) external {
        pool.redeem(claim.balanceOf(address(this)));
        pool.voteAbandon();
    }
}

/// @notice Exchanging claim tokens and the vote to declare the project abandoned.
contract BackingRoundVotesTest is BackingRoundFixture {
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);
    address internal constant FRESH = address(0xFEE5);

    /// @dev Alice bids twice and Bob once, 7,000 in all; the round is settled.
    function _round() internal returns (uint256 a1, uint256 a2, uint256 b) {
        a1 = _bid(ALICE, 2_000e18);
        vm.roll(START + 30);
        a2 = _bid(ALICE, 2_000e18);
        vm.roll(START + 60);
        b = _bid(BOB, 3_000e18);
        vm.roll(END);
        pool.seedFromAuction();
    }

    /// @dev Redeeming more after voting withdraws the vote, as a buy does, and the count of votes stays the sum
    /// of the voters' weights: nobody's vote is lost or inflated, and the redeemer can still sell everything.
    function test_redeeming_more_after_voting_withdraws_the_vote_and_leaves_the_others_whole() public {
        (uint256 a1, uint256 a2, uint256 b) = _round();
        _collect(a1);
        _collect(b);
        _redeemAll(ALICE);
        _redeemAll(BOB);
        vm.warp(block.timestamp + 30 days);
        vm.prank(ALICE);
        pool.voteAbandon();
        vm.prank(BOB);
        pool.voteAbandon();
        uint256 bobWeight = pool.weightOf(BOB);
        assertEq(pool.abandonVotes(), pool.weightOf(ALICE) + bobWeight);

        _collect(a2);
        uint256 weightBefore = pool.weightOf(ALICE);
        uint256 tokens = claim.balanceOf(ALICE);
        vm.prank(ALICE);
        uint256 added = pool.redeem(tokens);
        assertGt(added, 0);
        assertEq(pool.weightOf(ALICE), weightBefore + added);
        assertFalse(pool.votedAbandon(ALICE), "the vote was cast with the old weight");
        assertEq(pool.abandonVotes(), bobWeight);

        // She sells everything: no underflow, and Bob's vote is whole.
        uint256 held = pool.balanceOf(ALICE);
        vm.prank(ALICE);
        pool.sell(held, 0, type(uint256).max);
        assertEq(pool.abandonVotes(), bobWeight);
        assertTrue(pool.votedAbandon(BOB));
        assertEq(pool.weightOf(ALICE), 0);
        _assertBooks(0);
    }

    /// @dev The case that used to lock a lone voter's units: vote, redeem the rest, sell it all.
    function test_a_voter_who_redeems_the_rest_can_sell_everything_and_the_votes_return_to_zero() public {
        (uint256 a1, uint256 a2,) = _round();
        _collect(a1);
        vm.startPrank(ALICE);
        pool.redeem(claim.balanceOf(ALICE));
        vm.warp(block.timestamp + 30 days);
        pool.voteAbandon();
        vm.stopPrank();
        _collect(a2);
        vm.startPrank(ALICE);
        pool.redeem(claim.balanceOf(ALICE));
        assertEq(pool.abandonVotes(), 0);
        pool.sell(pool.balanceOf(ALICE), 0, type(uint256).max);
        vm.stopPrank();
        assertEq(pool.abandonVotes(), 0);
        _assertBooks(0);
    }
}

/// @dev After a round that went live: three round buyers holding claim tokens and two newcomers, through
/// redeeming, trading, milestones, leaving and waiting, in random order.
contract BackingRoundHandler is Test {
    IBackingPool public immutable pool;
    IClaim public immutable claim;
    MockERC20 public immutable currency;
    address[5] public actors;
    uint256 public redeems;
    uint256 public leaves;
    uint256 public votes;

    constructor(IBackingPool pool_, IClaim claim_, MockERC20 currency_, address[3] memory bidders) {
        pool = pool_;
        claim = claim_;
        currency = currency_;
        for (uint256 i; i < 3; ++i) {
            actors[i] = bidders[i];
        }
        actors[3] = address(0xAC703);
        actors[4] = address(0xAC704);
        for (uint256 i; i < 5; ++i) {
            currency.mint(actors[i], 1e30);
            vm.prank(actors[i]);
            currency.approve(address(pool), type(uint256).max);
        }
    }

    function redeem(uint256 who, uint256 part) external {
        address actor = actors[who % 5];
        uint256 held = claim.balanceOf(actor);
        if (held == 0) return;
        uint256 amount = bound(part, 1, held);
        uint256 units = pool.balanceOf(actor);
        vm.prank(actor);
        pool.redeem(amount);
        assertEq(pool.balanceOf(actor), units + amount);
        ++redeems;
    }

    function buy(uint256 who, uint256 amount) external {
        if (pool.abandoned()) return;
        address actor = actors[who % 5];
        amount = bound(amount, 1e12, 100_000e18);
        (uint256 units,,,) = pool.quoteBuy(amount);
        if (units == 0) return;
        vm.prank(actor);
        try pool.buy(amount, 0, block.timestamp) {} catch {}
    }

    function sell(uint256 who, uint256 part) external {
        address actor = actors[who % 5];
        uint256 held = pool.balanceOf(actor);
        if (held == 0) return;
        vm.prank(actor);
        pool.sell(bound(part, 1, held), 0, block.timestamp);
    }

    function postAndLeave(uint256 who) external {
        if (pool.abandoned()) return;
        if (pool.pending() == 0 && block.timestamp >= pool.nextClaimAt()) {
            vm.prank(address(0xF0));
            try pool.postMilestone(keccak256(abi.encode(block.timestamp))) {} catch {}
        }
        address actor = actors[who % 5];
        if (!pool.canLeave(actor)) return;
        vm.prank(actor);
        pool.leave(0, block.timestamp);
        ++leaves;
    }

    function resolve() external {
        try pool.resolveMilestone() {} catch {}
    }

    /// @dev A vote to declare the project abandoned, from whoever may cast one: redeeming, buying and selling
    /// after it are what the invariants watch.
    function voteAbandon(uint256 who) external {
        address actor = actors[who % 5];
        if (
            pool.abandoned() || pool.weightOf(actor) == 0 || pool.votedAbandon(actor)
                || block.timestamp < uint256(pool.lastBuyAt(actor)) + pool.voteSeasoning()
        ) return;
        vm.prank(actor);
        pool.voteAbandon();
        ++votes;
    }

    function wait(uint256 time) external {
        vm.warp(block.timestamp + bound(time, 1 hours, 12 days));
    }
}

/// @notice What must hold for a pool that went live through a round, after any sequence of actions.
contract BackingRoundInvariantTest is BackingRoundFixture {
    BackingRoundHandler internal handler;

    function setUp() public override {
        super.setUp();
        address[3] memory bidders = [address(0xA11CE), address(0xB0B), address(0xCA201)];
        uint256 a = _bid(bidders[0], 3_000e18);
        vm.roll(START + 40);
        uint256 b = _bid(bidders[1], 5_000e18);
        vm.roll(START + 80);
        uint256 c = _bid(bidders[2], 9_000e18);
        vm.roll(END);
        pool.seedFromAuction();
        _collect(a);
        _collect(b);
        _collect(c);
        handler = new BackingRoundHandler(pool, claim, currency, bidders);
        targetContract(address(handler));
    }

    function invariant_round_the_pool_holds_what_its_books_say() public view {
        _assertBooks(0);
    }

    /// @dev Units and weight are all accounted for: held by wallets, or still waiting to be redeemed.
    function invariant_round_units_and_weight_add_up_with_the_unredeemed() public view {
        uint256 units = pool.unredeemedUnits();
        uint256 weight = pool.unredeemedWeight();
        uint256 tokens;
        for (uint256 i; i < 5; ++i) {
            address actor = handler.actors(i);
            units += pool.balanceOf(actor);
            weight += pool.weightOf(actor);
            tokens += claim.balanceOf(actor);
        }
        assertEq(units, pool.totalSupply());
        assertEq(weight, pool.totalWeight());
        // Every claim token outside the pool has a unit waiting for it.
        assertLe(tokens, pool.unredeemedUnits());
        assertLe(claim.totalSupply() - claim.balanceOf(address(pool)), pool.unredeemedUnits() + 3);
    }

    /// @dev The votes to declare the project abandoned are exactly the weights of the wallets that vote, whatever
    /// they did since: redeeming more, buying, selling, leaving.
    function invariant_round_the_abandon_votes_are_the_weights_of_the_voters() public view {
        uint256 voting;
        for (uint256 i; i < 5; ++i) {
            address actor = handler.actors(i);
            if (pool.votedAbandon(actor)) voting += pool.weightOf(actor);
        }
        assertEq(pool.abandonVotes(), voting);
        assertLe(pool.abandonVotes(), pool.totalWeight() - pool.unredeemedWeight());
    }

    /// @dev Not a property of the pool: the run above really casts votes (printed by `forge test -vv`).
    function invariant_round_the_handler_reaches_the_vote_path() public {
        emit log_named_uint("redeems", handler.redeems());
        emit log_named_uint("votes", handler.votes());
    }

    /// @dev Everyone redeems what they hold and gets out, in either order, from any state.
    function invariant_round_everyone_can_redeem_and_get_out() public {
        uint256 state = vm.snapshotState();
        for (uint256 pass; pass < 2; ++pass) {
            for (uint256 i; i < 5; ++i) {
                address actor = handler.actors(pass == 0 ? i : 4 - i);
                uint256 tokens = claim.balanceOf(actor);
                if (tokens != 0) {
                    vm.prank(actor);
                    pool.redeem(tokens);
                }
                uint256 held = pool.balanceOf(actor);
                if (held == 0) continue;
                bool leaves = pool.canLeave(actor);
                vm.prank(actor);
                if (leaves) pool.leave(0, block.timestamp);
                else pool.sell(held, 0, block.timestamp);
            }
            assertGe(
                currency.balanceOf(address(pool)), pool.reserve() + pool.escrow() + pool.treasuryOwed()
            );
            vm.revertToState(state);
        }
    }
}
