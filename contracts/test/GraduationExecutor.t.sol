// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {GraduationExecutor} from "../src/GraduationExecutor.sol";
import {IContinuousClearingAuction, ICcaFinalization} from "../src/CCA.sol";

contract PlainERC20 {
    mapping(address => uint256) public balanceOf;
    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }
    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// A graduated auction the executor can actually sweep: real balances,
/// recipient-guarded sweeps, and honest params.
/// `ICcaFinalization` mirrors the CCA's checkpoint behavior: `isGraduated()`
/// only reflects materialized checkpoints (the end-block raise does not exist
/// until `checkpoint()` runs), and `endBlock()` bounds when sweeps may happen.
contract FundedMockAuction is IContinuousClearingAuction, ICcaFinalization {
    bool public graduated;
    bool public checkpointed;
    uint64 internal endBlock_;
    LBPInitializationParams public params;
    PlainERC20 public currencyToken;
    PlainERC20 public saleToken;
    address public override fundsRecipient;
    address public override tokensRecipient;

    constructor() {
        currencyToken = new PlainERC20();
        saleToken = new PlainERC20();
        endBlock_ = uint64(block.number); // over by default
    }

    function setGraduated(bool g) external {
        graduated = g;
    }
    function setEndBlock(uint64 b) external {
        endBlock_ = b;
    }
    function checkpoint() external override {
        checkpointed = true;
    }
    function endBlock() external view override returns (uint64) {
        return endBlock_;
    }
    function setParams(uint256 price, uint256 sold, uint256 raised) external {
        params = LBPInitializationParams(price, sold, raised);
    }
    function setRecipients(address funds_, address tokens_) external {
        fundsRecipient = funds_;
        tokensRecipient = tokens_;
    }
    function fund(uint256 currency_, uint256 tokens_) external {
        currencyToken.mint(address(this), currency_);
        saleToken.mint(address(this), tokens_);
    }
    function isGraduated() external view override returns (bool) {
        return graduated && checkpointed;
    }
    function currencyRaised() external view override returns (uint256) {
        return params.currencyRaised;
    }
    function currency() external view override returns (address) {
        return address(currencyToken);
    }
    function token() external view override returns (address) {
        return address(saleToken);
    }
    function sweepCurrency() external override {
        require(msg.sender == fundsRecipient, "not funds recipient");
        currencyToken.transfer(fundsRecipient, currencyToken.balanceOf(address(this)));
    }
    function sweepUnsoldTokens() external override {
        require(msg.sender == tokensRecipient, "not tokens recipient");
        saleToken.transfer(tokensRecipient, saleToken.balanceOf(address(this)));
    }
    function lbpInitializationParams() external view override returns (LBPInitializationParams memory) {
        return params;
    }
}

contract GraduationExecutorTest is Test {
    address treasury = address(0xBEEF);
    address eoa = address(0xCAFE);
    GraduationExecutor executor;
    FundedMockAuction auction;

    function setUp() public {
        executor = new GraduationExecutor(treasury, 4000); // 40% reserve
        auction = new FundedMockAuction();
        auction.setGraduated(true);
        auction.setParams(1e18, 500e18, 9000e6); // price, sold, raised (USDC 6dp: 9000)
        auction.setRecipients(address(executor), address(executor));
        auction.fund(9000e6, 300e18); // raised in the mock + 300 unsold tokens
    }

    function test_execute_moves_everything_atomically() public {
        executor.executeGraduation(address(auction));
        // 40% reserve escrowed here, 60% (5400e6) forwarded to treasury.
        (,,, uint256 escrow0,,,,) = _grad(address(auction));
        assertEq(escrow0, 3600e6);
        assertEq(PlainERC20(auction.currency()).balanceOf(treasury), 5400e6);
        // All 300 unsold tokens go to the treasury (launch supply, not value).
        assertEq(PlainERC20(auction.token()).balanceOf(treasury), 300e18);
        // The auction is empty: sweeps cleared it.
        assertEq(PlainERC20(auction.currency()).balanceOf(address(auction)), 0);
        assertEq(PlainERC20(auction.token()).balanceOf(address(auction)), 0);
        // Recorded graduation matches the chain's params.
        (uint256 price, uint256 sold, uint256 raised, uint256 escrow,, uint256 unsold, , bool executed) =
            executor.graduations(address(auction));
        assertEq(price, 1e18);
        assertEq(sold, 500e18);
        assertEq(raised, 9000e6);
        assertEq(escrow, 3600e6);
        assertEq(unsold, 300e18);
        assertTrue(executed);
    }

    function test_charity_eoa_can_trigger_but_cannot_steal() public {
        vm.prank(eoa);
        executor.executeGraduation(address(auction));
        // The eoa moved the money, but it all landed per the split.
        assertEq(PlainERC20(auction.currency()).balanceOf(treasury), 5400e6);
        assertEq(PlainERC20(auction.currency()).balanceOf(eoa), 0);
    }

    function test_ungraduated_auction_reverts() public {
        auction.setGraduated(false);
        vm.expectRevert(
            abi.encodeWithSelector(GraduationExecutor.NotGraduated.selector, address(auction))
        );
        executor.executeGraduation(address(auction));
    }

    function test_second_execution_reverts() public {
        executor.executeGraduation(address(auction));
        vm.expectRevert(
            abi.encodeWithSelector(GraduationExecutor.AlreadyExecuted.selector, address(auction))
        );
        executor.executeGraduation(address(auction));
    }

    function test_executor_must_be_the_funds_recipient() public {
        auction.setRecipients(eoa, address(executor));
        vm.expectRevert(
            abi.encodeWithSelector(
                GraduationExecutor.NotFundsRecipient.selector, address(auction), address(executor), eoa
            )
        );
        executor.executeGraduation(address(auction));
    }

    function test_executor_must_be_the_tokens_recipient() public {
        auction.setRecipients(address(executor), eoa);
        vm.expectRevert(
            abi.encodeWithSelector(
                GraduationExecutor.NotTokensRecipient.selector, address(auction), address(executor), eoa
            )
        );
        executor.executeGraduation(address(auction));
    }

    function test_reserve_releases_only_to_the_recorded_pool_by_treasury() public {
        executor.executeGraduation(address(auction));
        address pool = address(0xF00D);
        vm.expectRevert(abi.encodeWithSelector(GraduationExecutor.OnlyTreasury.selector, eoa));
        vm.prank(eoa);
        executor.releaseReserve(address(auction), pool);

        vm.prank(treasury);
        executor.releaseReserve(address(auction), pool);
        assertEq(PlainERC20(auction.currency()).balanceOf(pool), 3600e6);
        (, , , uint256 escrowAfter,,, address poolAfter,) = _grad(address(auction));
        assertEq(escrowAfter, 0);
        assertEq(poolAfter, pool);
        // Released once only.
        vm.prank(treasury);
        vm.expectRevert(
            abi.encodeWithSelector(GraduationExecutor.AlreadyReleased.selector, address(auction))
        );
        executor.releaseReserve(address(auction), pool);
    }

    function test_stuck_reserve_is_treasury_recoverable() public {
        executor.executeGraduation(address(auction));
        vm.prank(treasury);
        executor.withdrawStuckReserve(address(auction), treasury);
        assertEq(PlainERC20(auction.currency()).balanceOf(treasury), 9000e6);
        (,,, uint256 escrowAfter2,,,,) = _grad(address(auction));
        assertEq(escrowAfter2, 0);
    }

    function test_out_of_band_params_push_is_refused() public {
        IContinuousClearingAuction.LBPInitializationParams memory params =
            IContinuousClearingAuction.LBPInitializationParams(1e18, 500e18, 9000e6);
        vm.expectRevert(
            abi.encodeWithSelector(GraduationExecutor.NotGraduated.selector, address(auction))
        );
        executor.onGraduation(address(auction), params);
    }

    /// Ordering seam (finding 2): the mock hides graduation until
    /// `checkpoint()` runs, exactly like the CCA's end-block raise. Removing
    /// the production `checkpoint()` call from `executeGraduation` makes this
    /// revert `NotGraduated` and fail.
    function test_execute_materializes_checkpoint_before_graduation_check() public {
        assertFalse(auction.isGraduated(), "graduation invisible until checkpointed");
        executor.executeGraduation(address(auction));
        assertTrue(auction.checkpointed(), "executeGraduation must materialize the checkpoint");
        (,,,,,, , bool executed) = _grad(address(auction));
        assertTrue(executed);
    }

    function test_recover_failed_launch_returns_supply_to_treasury_exactly() public {
        auction.setGraduated(false);
        PlainERC20 token = PlainERC20(auction.token());
        PlainERC20 currencyToken = PlainERC20(auction.currency());
        // Stray dust predating the recovery: only the swept supply moves.
        token.mint(address(executor), 7e18);

        vm.prank(treasury);
        executor.recoverFailedLaunch(address(auction));

        assertEq(token.balanceOf(treasury), 300e18, "sale supply recovered exactly");
        assertEq(token.balanceOf(address(executor)), 7e18, "pre-existing dust untouched");
        assertEq(token.balanceOf(address(auction)), 0, "sweep cleared the auction");
        // Recovery touches the sale supply only — no currency moves.
        assertEq(currencyToken.balanceOf(treasury), 0, "no currency on a failed launch");
        assertEq(currencyToken.balanceOf(address(auction)), 9000e6);
        assertTrue(executor.launchRecovered(address(auction)));
        (,,,,,, , bool executed) = _grad(address(auction));
        assertFalse(executed, "recovery must never record a graduation");
    }

    function test_recover_failed_launch_only_treasury() public {
        auction.setGraduated(false);
        vm.expectRevert(abi.encodeWithSelector(GraduationExecutor.OnlyTreasury.selector, eoa));
        vm.prank(eoa);
        executor.recoverFailedLaunch(address(auction));
    }

    /// The mock starts graduated but UNcheckpointed (`isGraduated()` reads
    /// false) — without recovery's own `checkpoint()` call before the
    /// graduation check, this would drain a graduated launch and fail.
    function test_recover_failed_launch_refuses_graduated_launch() public {
        assertFalse(auction.isGraduated(), "graduation invisible until checkpointed");
        vm.prank(treasury);
        vm.expectRevert(
            abi.encodeWithSelector(GraduationExecutor.AuctionGraduated.selector, address(auction))
        );
        executor.recoverFailedLaunch(address(auction));
        assertEq(PlainERC20(auction.token()).balanceOf(address(auction)), 300e18, "nothing moved");
    }

    /// Executed implies graduated on-chain, so the same guard shields the
    /// happy path after `executeGraduation` has run.
    function test_recover_after_execution_reverts_graduated() public {
        executor.executeGraduation(address(auction));
        vm.prank(treasury);
        vm.expectRevert(
            abi.encodeWithSelector(GraduationExecutor.AuctionGraduated.selector, address(auction))
        );
        executor.recoverFailedLaunch(address(auction));
    }

    function test_recover_failed_launch_while_auction_running_reverts() public {
        auction.setGraduated(false);
        auction.setEndBlock(uint64(block.number) + 10);
        vm.prank(treasury);
        vm.expectRevert(
            abi.encodeWithSelector(GraduationExecutor.AuctionStillRunning.selector, address(auction))
        );
        executor.recoverFailedLaunch(address(auction));
    }

    function test_recover_failed_launch_twice_reverts() public {
        auction.setGraduated(false);
        vm.prank(treasury);
        executor.recoverFailedLaunch(address(auction));
        vm.prank(treasury);
        vm.expectRevert(
            abi.encodeWithSelector(GraduationExecutor.AlreadyRecovered.selector, address(auction))
        );
        executor.recoverFailedLaunch(address(auction));
        assertEq(PlainERC20(auction.token()).balanceOf(treasury), 300e18, "moved exactly once");
    }

    function test_recover_failed_launch_requires_tokens_recipient() public {
        auction.setGraduated(false);
        auction.setRecipients(address(executor), eoa);
        vm.prank(treasury);
        vm.expectRevert(
            abi.encodeWithSelector(
                GraduationExecutor.NotTokensRecipient.selector, address(auction), address(executor), eoa
            )
        );
        executor.recoverFailedLaunch(address(auction));
    }

    function _grad(address a)
        internal
        view
        returns (
            uint256 initialPriceX96,
            uint256 tokensSold,
            uint256 currencyRaised,
            uint256 reserveEscrow,
            uint256 treasuryShare,
            uint256 unsoldTokens,
            address tokenMasterPool,
            bool executed
        )
    {
        return executor.graduations(a);
    }
}
