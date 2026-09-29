// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {
    ContinuousClearingAuction
} from "continuous-clearing-auction/src/ContinuousClearingAuction.sol";
import {
    AuctionParameters,
    IContinuousClearingAuction
} from "continuous-clearing-auction/src/interfaces/IContinuousClearingAuction.sol";
import {IAuctionStorage} from "continuous-clearing-auction/src/interfaces/IAuctionStorage.sol";
import {IStepStorage} from "continuous-clearing-auction/src/interfaces/IStepStorage.sol";
import {Checkpoint} from "continuous-clearing-auction/src/libraries/CheckpointLib.sol";
import {MockProtocolFeeController} from "btt/mocks/MockProtocolFeeController.sol";
import {
    ContinuousClearingAuctionFactory
} from "continuous-clearing-auction/src/ContinuousClearingAuctionFactory.sol";
import {GraduationExecutor} from "../src/GraduationExecutor.sol";
import {AllowlistHook} from "../src/hooks/AllowlistHook.sol";

/// @dev The vendored Permit2 harness is compiled as its own unit (Permit2 pins
///      `pragma solidity 0.8.17`); this test only talks to it through `vm.deployCode`.
interface IPermit2Harness {
    function permit2() external view returns (address);
}

/// @dev Minimal view of the vendored `IAllowanceTransfer` surface this test
///      drives (permit2/src/interfaces/IAllowanceTransfer.sol:123).
interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

/// @dev Minimal, behavior-faithful stand-in for the vendored Uniswap Permit2,
/// used only when the real artifact cannot be resolved (foundry 1.4.3's sparse
/// compilation under test filters keeps only imported sources). Mirrors the
/// exact surface the auction exercises: `approve` (permit2/src/AllowanceTransfer.sol:26-29)
/// and `transferFrom(from, to, amount, token)` (permit2/src/interfaces/IAllowanceTransfer.sol:146,
/// permit2/src/AllowanceTransfer.sol:76-93): packed (amount, expiration)
/// allowance checked and decremented per pull unless unlimited, expired
/// allowances revert, and the final pull is `token.transferFrom(from, to, amount)`.
contract MockPermit2 {
    struct PackedAllowance {
        uint160 amount;
        uint48 expiration;
    }

    mapping(address owner => mapping(address token => mapping(address spender => PackedAllowance)))
        public allowance;

    error AllowanceExpired(uint48 expiration);
    error InsufficientAllowance(uint160 maxAmount);
    error TokenTransferFailed();

    function approve(address token, address spender, uint160 amount, uint48 expiration) external {
        allowance[msg.sender][token][spender] =
            PackedAllowance({amount: amount, expiration: expiration});
    }

    function transferFrom(address from, address to, uint160 amount, address token) external {
        PackedAllowance storage allowed = allowance[from][token][msg.sender];
        if (block.timestamp > allowed.expiration) revert AllowanceExpired(allowed.expiration);
        if (allowed.amount != type(uint160).max) {
            if (amount > allowed.amount) revert InsufficientAllowance(allowed.amount);
            allowed.amount -= amount;
        }
        // Real Permit2 pulls via solmate SafeTransferLib (AllowanceTransfer.sol:93),
        // which reverts on a false return — match that.
        if (!MockERC20(token).transferFrom(from, to, amount)) revert TokenTransferFailed();
    }
}

contract MockERC20 {
    error InsufficientBalance(address from, uint256 balance, uint256 amount);
    error InsufficientAllowance(address from, address spender, uint256 allowance, uint256 amount);

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < amount) revert InsufficientAllowance(from, msg.sender, allowed, amount);
            allowance[from][msg.sender] = allowed - amount;
        }
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) internal {
        uint256 balance = balanceOf[from];
        if (balance < amount) revert InsufficientBalance(from, balance, amount);
        balanceOf[from] = balance - amount;
        balanceOf[to] += amount;
    }
}

/// @notice The plan's Phase A acceptance test (docs/next-gen-launchpad-plan.md
/// §6 A1/A2): fork lifecycle — bid → graduate → claimTokens, balances — run
/// against the REAL vendored `ContinuousClearingAuction` on a local chain with
/// the real vendored Permit2 etched at its canonical address. Unlike
/// `GraduationExecutorTest` (mock auction) and `LaunchpadTest` (mocked handoff),
/// every currency wei and sale token here moves through the production bid,
/// checkpoint, exit, sweep, and claim code paths.
///
/// Scenario (all tests share it unless noted):
/// - Sale token: 1000e18 supply deposited up front (`onTokensReceived`).
/// - Schedule: one step, 50% of supply per block over 2 blocks
///   (`abi.encodePacked(uint24(5_000_000), uint40(2))`, StepLib.sol:23-26),
///   so the whole supply clears at the final checkpoint.
/// - Floor price = tick spacing = 2^96 (price 1.0; ticks at integer prices).
/// - Blocks: bids at 100 = [startBlock, endBlock=102), finalize at 103,
///   claim from 105 (claimBlock).
///
/// Happy-path money math (hand-derived, all divisions exact; Q96 = 2^96):
/// - alice bids 1800e18 @ 2Q96 and carol 600e18 @ 2Q96 (final clearing tick),
///   bob bids 800e18 @ 4Q96 (strictly above).
/// - Demand above the floor = 3200e18, so the tick loop consumes tick 2Q96
///   (canClear: 3200e18 >= 1000e18 * 2) and the final clearing price is
///   exactly 2Q96 (ContinuousClearingAuction.sol:176-238).
/// - At the clearing tick only 1200e18 of the 2400e18 tick demand can fill
///   (complement = 2000e18 - 800e18, DemandLib.sol:24-64), so alice/carol are
///   pro-rata haircut 50% and bob is fully filled at the same uniform price.
/// - Exact fills: bob 800e18 -> 400e18 tokens, alice 1800e18 -> 900e18 spent /
///   450e18 tokens / 900e18 refund, carol 600e18 -> 300e18 spent / 150e18
///   tokens / 300e18 refund. Total: 2000e18 raised, 1000e18 sold (sellout).
/// - Graduation with a 200e18 protocol fee: 200e18 to the fee recipient,
///   1800e18 net raise -> 720e18 reserve escrow (4000 bps) + 1080e18 treasury,
///   0 unsold tokens.
contract LaunchLifecycleTest is Test {
    uint256 internal constant Q96 = 1 << 96;
    uint128 internal constant TOTAL_SUPPLY = 1000e18;
    /// @dev `transferFrom(address,address,uint160,address)` — see setUp's ABI pin.
    bytes4 internal constant PERMIT2_TRANSFER_FROM_SELECTOR = 0x36c78516;
    /// @dev Price 1.0. Above ConstantsLib.MIN_FLOOR_PRICE (2^32+1) and a tick boundary.
    uint256 internal constant FLOOR_PRICE_Q96 = Q96;
    uint256 internal constant TICK_SPACING_Q96 = Q96;
    uint24 internal constant STEP_MPS = 5_000_000;
    uint40 internal constant STEP_BLOCKS = 2;
    uint64 internal constant START_BLOCK = 100;
    uint64 internal constant END_BLOCK = 102;
    uint64 internal constant CLAIM_BLOCK = 105;
    uint16 internal constant RESERVE_BPS = 4000;
    uint64 internal constant RESERVE_LOCK = 30 days;
    /// @dev solady `SafeTransferLib.PERMIT2` (SafeTransferLib.sol:64) — the
    ///      canonical Permit2 the auction pulls bids through (ContinuousClearingAuction.sol:479).
    address internal constant PERMIT2_CANONICAL = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    MockERC20 internal currency;
    MockERC20 internal saleToken;
    GraduationExecutor internal executor;
    address internal treasury;
    address internal pool;
    address internal feeRecipient;
    address internal alice;
    address internal bob;
    address internal carol;
    address internal dan;
    address internal erin;
    ContinuousClearingAuction internal auction;

    function setUp() public {
        treasury = makeAddr("treasury");
        pool = makeAddr("pool");
        feeRecipient = makeAddr("feeRecipient");
        alice = makeAddr("alice");
        bob = makeAddr("bob");
        carol = makeAddr("carol");
        dan = makeAddr("dan");
        erin = makeAddr("erin");

        currency = new MockERC20();
        saleToken = new MockERC20();
        executor = new GraduationExecutor(treasury, RESERVE_BPS, RESERVE_LOCK);

        // ABI pin: the auction's bid pull is `SafeTransferLib.permit2TransferFrom`
        // which composes `transferFrom(address,address,uint160,address)`
        // (SafeTransferLib.sol:463-476, selector 0x36c78516) — the exact
        // `IAllowanceTransfer.transferFrom` overload the vendored Permit2
        // declares (IAllowanceTransfer.sol:146). Any drift fails here first.
        assertEq(
            MockPermit2.transferFrom.selector, PERMIT2_TRANSFER_FROM_SELECTOR, "permit2 ABI drift"
        );

        // Real vendored Permit2 runtime code at the canonical address when its
        // artifact is compiled (unfiltered `forge test` runs see the real
        // implementation); otherwise the behavior-faithful mock above. Etching
        // keeps constructor-resolved immutables in the code while storage starts
        // empty.
        address permit2 = _deployPermit2();
        vm.etch(PERMIT2_CANONICAL, permit2.code);
        assertGt(PERMIT2_CANONICAL.code.length, 0, "permit2 must be etched");
    }

    /// @dev Prefers the compiled vendored Permit2 artifact (Permit2 pins
    /// `pragma solidity 0.8.17`, so it cannot be imported into this `^0.8.24`
    /// unit; `Permit2Harness.sol` exists to force its compilation) and falls
    /// back to `MockPermit2` when the artifact is unavailable — test filters
    /// trigger foundry 1.4.3's sparse compilation, which keeps only sources
    /// imported from the matched test.
    function _deployPermit2() internal returns (address deployed) {
        string[2] memory permit2Keys = ["Permit2.sol:Permit2", "permit2/src/Permit2.sol:Permit2"];
        for (uint256 i = 0; i < permit2Keys.length && deployed == address(0); i++) {
            deployed = _tryDeploy(permit2Keys[i]);
        }
        if (deployed == address(0)) {
            // Fall back to the harness, whose constructor deploys Permit2.
            address harness = _tryDeploy("Permit2Harness.sol:Permit2Harness");
            if (harness == address(0)) harness = _tryDeploy("test/Permit2Harness.sol:Permit2Harness");
            if (harness != address(0)) deployed = IPermit2Harness(harness).permit2();
        }
        if (deployed == address(0)) deployed = address(new MockPermit2());
    }

    function _tryDeploy(string memory artifactKey) internal returns (address deployed) {
        (bool ok, bytes memory ret) =
            address(vm).call(abi.encodeWithSignature("deployCode(string)", artifactKey));
        if (ok && ret.length == 32) deployed = abi.decode(ret, (address));
    }

    /// @dev Direct deploy recipe mirrors the vendored CCA's own local tests
    /// (continuous-clearing-auction/test/utils/AuctionBaseTest.sol:362-365):
    /// `new ContinuousClearingAuction(token, totalSupply, params, feeController)`
    /// then mint the supply to it and call `onTokensReceived()`.
    function _deployAuction(uint128 requiredCurrencyRaised, uint256 protocolFeeAmount)
        internal
        returns (address feeController)
    {
        if (protocolFeeAmount > 0) {
            MockProtocolFeeController controller = new MockProtocolFeeController();
            controller.setProtocolFeeAmount(protocolFeeAmount);
            controller.setProtocolFeeRecipient(feeRecipient);
            feeController = address(controller);
        }
        AuctionParameters memory params = AuctionParameters({
            currency: address(currency),
            tokensRecipient: address(executor),
            fundsRecipient: address(executor),
            startBlock: START_BLOCK,
            endBlock: END_BLOCK,
            claimBlock: CLAIM_BLOCK,
            tickSpacing: TICK_SPACING_Q96,
            validationHook: address(0),
            floorPrice: FLOOR_PRICE_Q96,
            requiredCurrencyRaised: requiredCurrencyRaised,
            auctionStepsData: abi.encodePacked(STEP_MPS, STEP_BLOCKS)
        });
        auction = new ContinuousClearingAuction(address(saleToken), TOTAL_SUPPLY, params, feeController);
        saleToken.mint(address(auction), TOTAL_SUPPLY);
        auction.onTokensReceived();
        // The executor serves exactly the one auction its treasury binds it to.
        vm.prank(treasury);
        executor.bindAuction(address(auction));
        vm.roll(START_BLOCK);
    }

    /// @dev `graduations` is a public mapping getter, so it returns the Graduation
    /// struct as a tuple (GraduationExecutor.sol:46-55); reassemble it for exact
    /// field-by-field assertions.
    function _graduationOf(address auctionAddr)
        internal
        view
        returns (GraduationExecutor.Graduation memory g)
    {
        (
            g.initialPriceX96,
            g.tokensSold,
            g.currencyRaised,
            g.reserveEscrow,
            g.treasuryShare,
            g.unsoldTokens,
            g.tokenMasterPool,
            g.executed
        ) = executor.graduations(auctionAddr);
    }

    /// @dev Mirrors the frontend's bid composition (desktop/src/features/launchpad/lib/evmCalls.ts):
    /// approve(PERMIT2) + PERMIT2.approve(auction) + submitBid. The auction then
    /// pulls the currency via `SafeTransferLib.permit2TransferFrom`
    /// (ContinuousClearingAuction.sol:479) -> Permit2 `transferFrom(from, to,
    /// amount, token)` (permit2/src/interfaces/IAllowanceTransfer.sol:146),
    /// which decrements the Permit2 allowance and does
    /// `token.safeTransferFrom(from, to, amount)` (permit2/src/AllowanceTransfer.sol:76-93).
    function _bid(address bidder, uint128 amount, uint256 maxPriceQ96, uint256 prevTickPriceQ96)
        internal
        returns (uint256 bidId)
    {
        currency.mint(bidder, amount);
        vm.startPrank(bidder);
        currency.approve(PERMIT2_CANONICAL, amount);
        IPermit2(PERMIT2_CANONICAL).approve(
            address(currency), address(auction), uint160(amount), type(uint48).max
        );
        bidId = auction.submitBid(maxPriceQ96, amount, bidder, prevTickPriceQ96, "");
        vm.stopPrank();
    }

    /// @notice Phase A happy path: bid -> graduate -> exit -> claimTokens with
    /// exact wei assertions at every hop (scenario table in the contract doc).
    function test_graduation_lifecycle_bid_graduate_claim_exact_balances() public {
        address feeController = _deployAuction(1000e18, 200e18);

        // --- Bids at block 100 (the only block of [startBlock, endBlock=102) window worth bidding in is 100-101;
        // all three land at block 100 so they share the block-100 checkpoint and its startCumulativeMps = 0).
        uint256 aliceBid = _bid(alice, 1800e18, 2 * Q96, FLOOR_PRICE_Q96);
        uint256 carolBid = _bid(carol, 600e18, 2 * Q96, FLOOR_PRICE_Q96);
        uint256 bobBid = _bid(bob, 800e18, 4 * Q96, 2 * Q96);
        assertEq(aliceBid, 0, "bid ids are sequential from 0 (BidStorage.sol:47-49)");
        assertEq(carolBid, 1);
        assertEq(bobBid, 2);
        // The Permit2 pull moved every bid wei into the auction escrow.
        assertEq(currency.balanceOf(address(auction)), 3200e18, "bid escrow");
        assertEq(currency.balanceOf(alice), 0);
        assertEq(currency.balanceOf(carol), 0);
        assertEq(currency.balanceOf(bob), 0);

        // `isGraduated` reads the LATEST CHECKPOINT and may be out of date
        // (IContinuousClearingAuction.sol:170-174). The block-100 checkpoint sold
        // 0 mps, so nothing is raised until the end block is checkpointed.
        assertFalse(auction.isGraduated(), "raise only materializes at final checkpoint");
        vm.expectRevert(abi.encodeWithSelector(GraduationExecutor.NotGraduated.selector, address(auction)));
        executor.executeGraduation(address(auction));

        // --- Finalize at block 103 (past endBlock): the final checkpoint sells
        // the whole schedule at the uniform clearing price 2Q96.
        vm.roll(END_BLOCK + 1);
        Checkpoint memory fin = auction.checkpoint();
        assertEq(fin.clearingPrice, 2 * Q96, "final uniform clearing price");
        assertEq(auction.currencyRaised(), 2000e18, "raise = clearing value of full supply");
        assertEq(auction.totalCleared(), TOTAL_SUPPLY, "sellout");
        assertEq(auction.remainingSupply(), 0);
        assertTrue(auction.isGraduated());

        // Recovery must not touch a graduated launch — before execution ...
        vm.prank(treasury);
        vm.expectRevert(
            abi.encodeWithSelector(GraduationExecutor.AuctionGraduated.selector, address(auction))
        );
        executor.recoverFailedLaunch(address(auction));

        // --- Graduation: fee first, then reserve/treasury split of the NET raise
        // (GraduationExecutor.sol:121-146, ContinuousClearingAuction.sol:134-148).
        executor.executeGraduation(address(auction));
        GraduationExecutor.Graduation memory g = _graduationOf(address(auction));
        assertEq(g.initialPriceX96, 2 * Q96, "lbpInitializationParams initialPriceX96");
        assertEq(g.tokensSold, TOTAL_SUPPLY, "lbpInitializationParams tokensSold");
        assertEq(g.currencyRaised, 1800e18, "net raise after 200e18 protocol fee");
        assertEq(g.reserveEscrow, 720e18, "4000bps of the net raise");
        assertEq(g.treasuryShare, 1080e18, "net raise minus reserve share");
        assertEq(g.unsoldTokens, 0, "sellout: nothing to sweep");
        assertEq(g.tokenMasterPool, address(0));
        assertTrue(g.executed);

        // Every wei of the pre-graduation raise has exactly one home.
        assertEq(currency.balanceOf(feeRecipient), 200e18, "protocol fee");
        assertEq(currency.balanceOf(address(executor)), 720e18, "reserve escrow");
        assertEq(currency.balanceOf(treasury), 1080e18, "treasury share");
        assertEq(currency.balanceOf(address(auction)), 1200e18, "unspent bid escrow = pending refunds");
        assertEq(currency.balanceOf(address(feeController)), 0);
        // Unsold sweep path ran with exactly 0 tokens (sellout).
        assertEq(saleToken.balanceOf(treasury), 0, "unsold tokens swept");
        assertEq(saleToken.balanceOf(address(executor)), 0, "unsold pass-through");
        assertEq(saleToken.balanceOf(address(auction)), TOTAL_SUPPLY, "supply held for claims");

        // Double graduation reverts in the integrated path (GraduationExecutor.sol:107;
        // also covered as a unit in GraduationExecutor.t.sol:128-134).
        vm.expectRevert(
            abi.encodeWithSelector(GraduationExecutor.AlreadyExecuted.selector, address(auction))
        );
        executor.executeGraduation(address(auction));

        // ... nor after execution: recovery cannot drain a graduated launch
        // (GraduationExecutor.sol:159-190).
        vm.prank(treasury);
        vm.expectRevert(
            abi.encodeWithSelector(GraduationExecutor.AuctionGraduated.selector, address(auction))
        );
        executor.recoverFailedLaunch(address(auction));

        // Release the escrowed reserve share to the LBP pool.
        vm.prank(treasury);
        executor.releaseReserve(address(auction), pool);
        assertEq(currency.balanceOf(pool), 720e18, "reserve share released");
        assertEq(currency.balanceOf(address(executor)), 0);

        // --- Exits at block 104 record fills and refund the unspent remainder.
        vm.roll(END_BLOCK + 2);
        vm.prank(bob);
        auction.exitBid(bobBid);
        assertEq(currency.balanceOf(bob), 0, "bob fully filled: no refund");
        vm.prank(alice);
        auction.exitPartiallyFilledBid(aliceBid, START_BLOCK, 0);
        assertEq(currency.balanceOf(alice), 900e18, "alice 50% haircut refund");
        vm.prank(carol);
        auction.exitPartiallyFilledBid(carolBid, START_BLOCK, 0);
        assertEq(currency.balanceOf(carol), 300e18, "carol 50% haircut refund");
        assertEq(currency.balanceOf(address(auction)), 0, "escrow fully unwound");

        // --- Claims at claimBlock pay the pro-rata fills at the clearing price.
        vm.roll(CLAIM_BLOCK);
        vm.prank(alice);
        auction.claimTokens(aliceBid);
        vm.prank(bob);
        auction.claimTokens(bobBid);
        vm.prank(carol);
        auction.claimTokens(carolBid);
        assertEq(saleToken.balanceOf(alice), 450e18, "900e18 spent at price 2");
        assertEq(saleToken.balanceOf(bob), 400e18, "800e18 spent at price 2");
        assertEq(saleToken.balanceOf(carol), 150e18, "300e18 spent at price 2");
        assertEq(saleToken.balanceOf(address(auction)), 0, "supply fully claimed");
    }

    /// @notice "Refund is the feature" (plan §5 idea 1): below the graduation
    /// threshold `executeGraduation` reverts and `exitBid` returns EVERY wei.
    function test_missed_threshold_exits_refund_all_currency() public {
        _deployAuction(1000e18, 0);
        uint256 danBid = _bid(dan, 300e18, 2 * Q96, FLOOR_PRICE_Q96);
        uint256 erinBid = _bid(erin, 200e18, 4 * Q96, 2 * Q96);
        assertEq(currency.balanceOf(address(auction)), 500e18, "bid escrow");

        // Recovery is refused while the auction is live (GraduationExecutor.sol:172-174).
        vm.prank(treasury);
        vm.expectRevert(
            abi.encodeWithSelector(GraduationExecutor.AuctionStillRunning.selector, address(auction))
        );
        executor.recoverFailedLaunch(address(auction));

        vm.roll(END_BLOCK + 1);
        auction.checkpoint();
        assertEq(auction.currencyRaised(), 500e18, "weak demand clears at floor");
        assertFalse(auction.isGraduated(), "500e18 < 1000e18 threshold");

        // Threshold not met: graduation is refused (GraduationExecutor.sol:109).
        vm.expectRevert(abi.encodeWithSelector(GraduationExecutor.NotGraduated.selector, address(auction)));
        executor.executeGraduation(address(auction));

        // Non-graduated exits fully refund (ContinuousClearingAuction.sol:499-502).
        vm.prank(dan);
        auction.exitBid(danBid);
        vm.prank(erin);
        auction.exitBid(erinBid);
        assertEq(currency.balanceOf(dan), 300e18, "full refund");
        assertEq(currency.balanceOf(erin), 200e18, "full refund");
        assertEq(currency.balanceOf(address(auction)), 0, "every wei returned");
        assertEq(saleToken.balanceOf(dan), 0, "no fills when not graduated");
        assertEq(saleToken.balanceOf(erin), 0);

        // No entity is formed: claims refuse (ContinuousClearingAuction.sol:606)
        // and no graduation record exists.
        vm.roll(CLAIM_BLOCK);
        vm.prank(dan);
        vm.expectRevert(IAuctionStorage.NotGraduated.selector);
        auction.claimTokens(danBid);
        assertFalse(_graduationOf(address(auction)).executed, "no entity formed");
        assertEq(currency.balanceOf(address(executor)), 0, "no funds to any entity");
        assertEq(currency.balanceOf(treasury), 0);

        // The failed launch's sale supply returns to treasury: `recoverFailedLaunch`
        // is treasury-only and legal only on an over + non-graduated auction; it
        // pulls via the executor's `tokensRecipient` role (the auction's sweep is
        // recipient-only, ContinuousClearingAuction.sol:687-698) and forwards the
        // recovered tokens out of the auction (GraduationExecutor.sol:159-190).
        vm.prank(treasury);
        executor.recoverFailedLaunch(address(auction));
        assertEq(saleToken.balanceOf(address(auction)), 0, "supply unstuck");
        assertEq(saleToken.balanceOf(treasury), TOTAL_SUPPLY, "sale supply recovered exactly");
        assertEq(saleToken.balanceOf(address(executor)), 0, "pass-through only");
        assertTrue(executor.launchRecovered(address(auction)));
    }

    /// @notice Unsold supply (weak demand) is swept executor -> treasury and the
    /// split runs on the raised amount only.
    function test_unsold_tokens_swept_to_treasury_on_graduation() public {
        _deployAuction(300e18, 0);
        uint256 danBid = _bid(dan, 300e18, 2 * Q96, FLOOR_PRICE_Q96);
        uint256 erinBid = _bid(erin, 200e18, 4 * Q96, 2 * Q96);

        vm.roll(END_BLOCK + 1);
        Checkpoint memory fin = auction.checkpoint();
        // Weak demand: the clearing price clamps at the floor rather than falling
        // to demand/supply (ContinuousClearingAuction.sol:229-237).
        assertEq(fin.clearingPrice, FLOOR_PRICE_Q96, "floor clamp");
        assertEq(auction.currencyRaised(), 500e18);
        assertEq(auction.totalCleared(), 500e18, "500e18 bought at price 1.0");
        assertEq(auction.remainingSupply(), 500e18, "unsold");
        assertTrue(auction.isGraduated(), "500e18 >= 300e18 threshold");

        executor.executeGraduation(address(auction));
        GraduationExecutor.Graduation memory g = _graduationOf(address(auction));
        assertEq(g.initialPriceX96, FLOOR_PRICE_Q96);
        assertEq(g.tokensSold, 500e18);
        assertEq(g.currencyRaised, 500e18, "no fee controller: net raise = raw raise");
        assertEq(g.reserveEscrow, 200e18, "4000bps of 500e18");
        assertEq(g.treasuryShare, 300e18);
        assertEq(g.unsoldTokens, 500e18, "sweepUnsoldTokens amount");
        assertTrue(g.executed);
        assertEq(currency.balanceOf(address(executor)), 200e18, "reserve escrow");
        assertEq(currency.balanceOf(treasury), 300e18, "treasury share of raise");
        assertEq(saleToken.balanceOf(treasury), 500e18, "unsold supply swept to treasury");
        assertEq(saleToken.balanceOf(address(executor)), 0, "pass-through only");
        assertEq(currency.balanceOf(feeRecipient), 0, "no fee without a controller");

        vm.roll(END_BLOCK + 2);
        vm.prank(dan);
        auction.exitBid(danBid);
        vm.prank(erin);
        auction.exitBid(erinBid);
        assertEq(currency.balanceOf(dan), 0, "fully filled at floor: no refund");
        assertEq(currency.balanceOf(erin), 0);

        vm.roll(CLAIM_BLOCK);
        vm.prank(dan);
        auction.claimTokens(danBid);
        vm.prank(erin);
        auction.claimTokens(erinBid);
        assertEq(saleToken.balanceOf(dan), 300e18, "300e18 spent at price 1.0");
        assertEq(saleToken.balanceOf(erin), 200e18, "200e18 spent at price 1.0");
        assertEq(saleToken.balanceOf(address(auction)), 0, "sold supply fully claimed");
    }

    /// @notice Finding 2: a keeper calling `executeGraduation` right after
    /// endBlock must not need an explicit `checkpoint()` first — the executor
    /// materializes the final checkpoint itself before reading `isGraduated()`.
    /// Before the fix this reverted `NotGraduated`: the raise only exists at the
    /// end-block checkpoint and `isGraduated` read the stale block-100 one
    /// (0 mps sold -> 0 raised).
    function test_execute_graduation_right_after_end_block_needs_no_explicit_checkpoint() public {
        _deployAuction(300e18, 0);
        _bid(dan, 300e18, 2 * Q96, FLOOR_PRICE_Q96);
        _bid(erin, 200e18, 4 * Q96, 2 * Q96);

        vm.roll(END_BLOCK + 1);
        assertFalse(auction.isGraduated(), "end-block raise not materialized yet");

        // No `auction.checkpoint()` here — this is the keeper path. With the
        // checkpoint-first fix removed this call reverts NotGraduated.
        executor.executeGraduation(address(auction));

        GraduationExecutor.Graduation memory g = _graduationOf(address(auction));
        assertEq(g.initialPriceX96, FLOOR_PRICE_Q96);
        assertEq(g.tokensSold, 500e18);
        assertEq(g.currencyRaised, 500e18, "no fee controller: net raise = raw raise");
        assertEq(g.reserveEscrow, 200e18, "4000bps of 500e18");
        assertEq(g.treasuryShare, 300e18);
        assertEq(g.unsoldTokens, 500e18, "sweepUnsoldTokens amount");
        assertTrue(g.executed);
        assertEq(currency.balanceOf(treasury), 300e18, "treasury share of raise");
        assertEq(saleToken.balanceOf(treasury), 500e18, "unsold supply swept to treasury");
    }

    /// @notice Ordering guards on the integrated path, each bound to the exact
    /// production revert (a guard whose removal fails nothing protects nothing).
    function test_lifecycle_ordering_guards() public {
        _deployAuction(300e18, 0);
        uint256 danBid = _bid(dan, 300e18, 2 * Q96, FLOOR_PRICE_Q96);

        // No exit before the auction is over: `exitBid` is `onlyAfterAuctionIsOver`
        // (ContinuousClearingAuction.sol:495, StepStorage.sol:50-53). The partial
        // path's actual pre-end rule for a non-graduated auction is a distinct
        // revert (ContinuousClearingAuction.sol:526-531).
        vm.roll(END_BLOCK - 1);
        vm.prank(dan);
        vm.expectRevert(IStepStorage.AuctionIsNotOver.selector);
        auction.exitBid(danBid);
        vm.prank(dan);
        vm.expectRevert(IContinuousClearingAuction.CannotPartiallyExitBidBeforeGraduation.selector);
        auction.exitPartiallyFilledBid(danBid, START_BLOCK, 0);

        // Claim before claimBlock reverts (StepStorage.sol:56-59).
        vm.roll(END_BLOCK + 1);
        vm.prank(dan);
        vm.expectRevert(IStepStorage.NotClaimable.selector);
        auction.claimTokens(danBid);

        auction.checkpoint();

        // Claim before exit reverts: exit is what records the fill
        // (ContinuousClearingAuction.sol:409, 649-651).
        vm.roll(CLAIM_BLOCK);
        vm.prank(dan);
        vm.expectRevert(IContinuousClearingAuction.BidNotExited.selector);
        auction.claimTokens(danBid);

        // Graduation happens exactly once (GraduationExecutor.sol:107).
        executor.executeGraduation(address(auction));
        vm.expectRevert(
            abi.encodeWithSelector(GraduationExecutor.AlreadyExecuted.selector, address(auction))
        );
        executor.executeGraduation(address(auction));

        // Exit records the fill exactly once (ContinuousClearingAuction.sol:496-497).
        vm.prank(dan);
        auction.exitBid(danBid);
        vm.prank(dan);
        vm.expectRevert(IContinuousClearingAuction.BidAlreadyExited.selector);
        auction.exitBid(danBid);

        // Now the claim passes and pays the exact fill.
        vm.prank(dan);
        auction.claimTokens(danBid);
        assertEq(saleToken.balanceOf(dan), 300e18);
    }

    // -----------------------------------------------------------------------
    // The app's launch sequence against the REAL factory + CCA
    // -----------------------------------------------------------------------

    /// @dev `configData` exactly as `desktop/.../auctionFlow.ts` encodes it:
    /// `abi.encode(AuctionParameters{...})` with the executor as BOTH recipients.
    function _appConfigData(uint128 requiredCurrencyRaised, address hook)
        internal
        view
        returns (bytes memory)
    {
        return abi.encode(
            AuctionParameters({
                currency: address(currency),
                tokensRecipient: address(executor),
                fundsRecipient: address(executor),
                startBlock: START_BLOCK,
                endBlock: END_BLOCK,
                claimBlock: CLAIM_BLOCK,
                tickSpacing: TICK_SPACING_Q96,
                validationHook: hook,
                floorPrice: FLOOR_PRICE_Q96,
                requiredCurrencyRaised: requiredCurrencyRaised,
                auctionStepsData: abi.encodePacked(STEP_MPS, STEP_BLOCKS)
            })
        );
    }

    /// @notice The founder flow as the desktop composes it, step for step, on the
    /// real `ContinuousClearingAuctionFactory` and CCA:
    ///   1. deploy the allowlist hook (curated track),  2. deploy the executor
    ///   (setUp),  3. `factory.create`,  4. transfer the sale supply to the
    ///   auction,  5. `auction.onTokensReceived()`,  6. `hook.setAuction`,
    ///   7. `executor.bindAuction`,  then two buyers bid, the chain passes the
    ///   end block, anyone runs `executeGraduation`, both buyers exit + claim.
    /// Steps 4-5 are the ones no app path performed before: without them every
    /// bid and checkpoint reverts `TokensNotReceived` (next test).
    function test_app_launch_sequence_end_to_end_on_the_real_factory_and_cca() public {
        // The deploying wallet IS the treasury (the app's treasury gate).
        saleToken.mint(treasury, TOTAL_SUPPLY);
        ContinuousClearingAuctionFactory factory = new ContinuousClearingAuctionFactory(address(0));
        AllowlistHook hook = new AllowlistHook(treasury, 1000e18);
        bytes memory configData = _appConfigData(300e18, address(hook));
        bytes32 salt = bytes32(uint256(1));

        vm.startPrank(treasury);
        address predicted =
            address(factory.getAddress(address(saleToken), TOTAL_SUPPLY, configData, salt, treasury));
        address created = address(factory.create(address(saleToken), TOTAL_SUPPLY, configData, salt));
        assertEq(created, predicted, "the CREATE2 precompute the app shows matches the deploy");
        auction = ContinuousClearingAuction(created);

        // 4-5: fund the auction, then tell it the supply arrived.
        saleToken.transfer(created, TOTAL_SUPPLY);
        auction.onTokensReceived();
        // 6-7: bind the hook and the executor to this auction, once.
        hook.setAuction(created);
        executor.bindAuction(created);
        hook.setBidder(dan, true);
        hook.setBidder(erin, true);
        vm.stopPrank();
        assertEq(saleToken.balanceOf(treasury), 0, "the whole sale supply moved to the auction");
        assertEq(saleToken.balanceOf(created), TOTAL_SUPPLY);

        // Two buyers bid through the gated auction.
        vm.roll(START_BLOCK);
        uint256 danBid = _bid(dan, 300e18, 2 * Q96, FLOOR_PRICE_Q96);
        uint256 erinBid = _bid(erin, 200e18, 4 * Q96, 2 * Q96);
        assertEq(hook.spent(dan), 300e18, "the real auction drove the hook's accounting");
        assertEq(hook.spent(erin), 200e18);

        // Past the end block a keeper (no explicit checkpoint) graduates the launch.
        vm.roll(END_BLOCK + 1);
        executor.executeGraduation(created);
        GraduationExecutor.Graduation memory g = _graduationOf(created);
        assertTrue(g.executed);
        assertEq(g.currencyRaised, 500e18);
        assertEq(g.reserveEscrow, 200e18, "4000bps to the reserve escrow");
        assertEq(g.treasuryShare, 300e18);
        assertEq(currency.balanceOf(treasury), 300e18);
        assertEq(currency.balanceOf(address(executor)), 200e18);
        assertEq(saleToken.balanceOf(treasury), 500e18, "unsold supply swept to the treasury");

        // The reserve is locked, then withdrawable; here the pool lands first.
        vm.prank(treasury);
        vm.expectRevert(
            abi.encodeWithSelector(
                GraduationExecutor.ReserveLocked.selector,
                created,
                uint64(block.timestamp) + RESERVE_LOCK
            )
        );
        executor.withdrawStuckReserve(created);
        vm.prank(treasury);
        executor.releaseReserve(created, pool);
        assertEq(currency.balanceOf(pool), 200e18);

        // Exits and claims settle the buyers.
        vm.roll(END_BLOCK + 2);
        vm.prank(dan);
        auction.exitBid(danBid);
        vm.prank(erin);
        auction.exitBid(erinBid);
        vm.roll(CLAIM_BLOCK);
        vm.prank(dan);
        auction.claimTokens(danBid);
        vm.prank(erin);
        auction.claimTokens(erinBid);
        assertEq(saleToken.balanceOf(dan), 300e18);
        assertEq(saleToken.balanceOf(erin), 200e18);
        assertEq(saleToken.balanceOf(created), 0, "every sold token claimed");
    }

    /// @notice The regression this sequence exists to prevent: an auction that was
    /// created but never funded reverts `TokensNotReceived` on the first bid AND
    /// on every checkpoint (the CCA's `onlyActiveAuction`), and `onTokensReceived`
    /// itself refuses until the supply has actually arrived.
    function test_unfunded_auction_reverts_TokensNotReceived_until_funded() public {
        saleToken.mint(treasury, TOTAL_SUPPLY);
        ContinuousClearingAuctionFactory factory = new ContinuousClearingAuctionFactory(address(0));
        bytes memory configData = _appConfigData(300e18, address(0));
        vm.prank(treasury);
        auction = ContinuousClearingAuction(
            address(factory.create(address(saleToken), TOTAL_SUPPLY, configData, bytes32(uint256(2))))
        );
        vm.roll(START_BLOCK);

        currency.mint(dan, 300e18);
        vm.startPrank(dan);
        currency.approve(PERMIT2_CANONICAL, 300e18);
        IPermit2(PERMIT2_CANONICAL).approve(
            address(currency), address(auction), uint160(300e18), type(uint48).max
        );
        vm.expectRevert(IContinuousClearingAuction.TokensNotReceived.selector);
        auction.submitBid(2 * Q96, 300e18, dan, FLOOR_PRICE_Q96, "");
        vm.stopPrank();
        vm.expectRevert(IContinuousClearingAuction.TokensNotReceived.selector);
        auction.checkpoint();

        // Calling `onTokensReceived` before the transfer is refused too.
        vm.expectRevert(IContinuousClearingAuction.InvalidTokenAmountReceived.selector);
        auction.onTokensReceived();

        vm.startPrank(treasury);
        saleToken.transfer(address(auction), TOTAL_SUPPLY);
        auction.onTokensReceived();
        vm.stopPrank();
        vm.prank(dan);
        auction.submitBid(2 * Q96, 300e18, dan, FLOOR_PRICE_Q96, "");
    }

    /// @notice The curated-track gate on the real auction: only the auction drives
    /// the hook, allowlisted bidders bid up to their cap, everyone else is refused
    /// by the auction with the hook's own reason.
    function test_allowlist_hook_gates_the_real_auction_and_strangers_cannot_drive_it() public {
        AllowlistHook hook = new AllowlistHook(treasury, 400e18);
        AuctionParameters memory params = AuctionParameters({
            currency: address(currency),
            tokensRecipient: address(executor),
            fundsRecipient: address(executor),
            startBlock: START_BLOCK,
            endBlock: END_BLOCK,
            claimBlock: CLAIM_BLOCK,
            tickSpacing: TICK_SPACING_Q96,
            validationHook: address(hook),
            floorPrice: FLOOR_PRICE_Q96,
            requiredCurrencyRaised: 300e18,
            auctionStepsData: abi.encodePacked(STEP_MPS, STEP_BLOCKS)
        });
        auction = new ContinuousClearingAuction(address(saleToken), TOTAL_SUPPLY, params, address(0));
        saleToken.mint(address(auction), TOTAL_SUPPLY);
        auction.onTokensReceived();
        vm.startPrank(treasury);
        hook.setAuction(address(auction));
        hook.setBidder(dan, true);
        vm.stopPrank();
        vm.roll(START_BLOCK);

        // A stranger cannot burn dan's cap by calling the hook directly.
        vm.prank(erin);
        vm.expectRevert(abi.encodeWithSelector(AllowlistHook.NotAuction.selector, erin));
        hook.validate(2 * Q96, 400e18, dan, dan, "");
        assertEq(hook.spent(dan), 0);

        // The real auction path still works: dan bids inside the cap ...
        _bid(dan, 250e18, 2 * Q96, FLOOR_PRICE_Q96);
        assertEq(hook.spent(dan), 250e18);

        // ... a non-allowlisted bidder is refused with the hook's reason ...
        currency.mint(erin, 100e18);
        vm.startPrank(erin);
        currency.approve(PERMIT2_CANONICAL, 100e18);
        IPermit2(PERMIT2_CANONICAL).approve(
            address(currency), address(auction), uint160(100e18), type(uint48).max
        );
        vm.expectRevert(
            abi.encodeWithSelector(
                bytes4(keccak256("ValidationHookCallFailed(bytes)")),
                abi.encodeWithSelector(AllowlistHook.NotAllowlisted.selector, erin)
            )
        );
        auction.submitBid(2 * Q96, 100e18, erin, FLOOR_PRICE_Q96, "");
        vm.stopPrank();

        // ... and dan cannot exceed his cap (250 + 200 > 400).
        currency.mint(dan, 200e18);
        vm.startPrank(dan);
        currency.approve(PERMIT2_CANONICAL, 200e18);
        IPermit2(PERMIT2_CANONICAL).approve(
            address(currency), address(auction), uint160(200e18), type(uint48).max
        );
        vm.expectRevert(
            abi.encodeWithSelector(
                bytes4(keccak256("ValidationHookCallFailed(bytes)")),
                abi.encodeWithSelector(
                    AllowlistHook.OverPerWalletCap.selector, dan, uint128(250e18), uint128(200e18), uint128(400e18)
                )
            )
        );
        auction.submitBid(2 * Q96, 200e18, dan, FLOOR_PRICE_Q96, "");
        vm.stopPrank();
        assertEq(hook.spent(dan), 250e18, "a refused bid does not consume cap");
    }
}
