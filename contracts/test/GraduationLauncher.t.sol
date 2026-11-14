// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {GraduationExecutor} from "../src/GraduationExecutor.sol";
import {FundedMockAuction, PlainERC20} from "./GraduationExecutor.t.sol";

/// @dev The mock auction plus the one call `fundAuction` makes.
contract ReceivingAuction is FundedMockAuction {
    uint256 public receivedCalls;

    function onTokensReceived() external {
        receivedCalls++;
    }
}

/// @notice The launcher/treasury split: the wallet that runs a launch is not a payee, and may point the
/// payee at a DAO that did not exist yet when the executor had to be deployed.
contract GraduationLauncherTest is Test {
    address internal constant FOUNDER = address(0xF0);
    address internal constant DAO = address(0xDA0);
    address internal constant STRANGER = address(0x57);
    uint64 internal constant LOCK = 30 days;
    GraduationExecutor internal executor;
    ReceivingAuction internal auction;

    function setUp() public {
        vm.prank(FOUNDER);
        executor = new GraduationExecutor(FOUNDER, 0, LOCK);
        auction = new ReceivingAuction();
        auction.setGraduated(true);
        auction.setParams(1e18, 500e18, 9000e6);
        auction.setRecipients(address(executor), address(executor));
    }

    function test_the_deployer_is_the_launcher() public view {
        assertEq(executor.launcher(), FOUNDER);
        assertEq(executor.treasury(), FOUNDER);
    }

    function test_only_the_launcher_retargets_and_only_once_before_binding() public {
        vm.prank(STRANGER);
        vm.expectRevert(abi.encodeWithSelector(GraduationExecutor.OnlyLauncher.selector, STRANGER));
        executor.retargetTreasury(DAO);
        vm.startPrank(FOUNDER);
        vm.expectRevert(GraduationExecutor.CannotRetarget.selector);
        executor.retargetTreasury(address(0));
        executor.retargetTreasury(DAO);
        assertEq(executor.treasury(), DAO);
        assertTrue(executor.treasuryRetargeted());
        vm.expectRevert(GraduationExecutor.CannotRetarget.selector);
        executor.retargetTreasury(address(0xABC));
        vm.stopPrank();
    }

    function test_retargeting_after_binding_is_refused() public {
        vm.prank(FOUNDER);
        executor.bindAuction(address(auction));
        vm.prank(FOUNDER);
        vm.expectRevert(GraduationExecutor.CannotRetarget.selector);
        executor.retargetTreasury(DAO);
    }

    function test_the_launcher_binds_and_funds_while_the_dao_is_the_payee() public {
        vm.prank(FOUNDER);
        executor.retargetTreasury(DAO);
        auction.setSaleToken(new PlainERC20());
        PlainERC20(auction.token()).mint(address(executor), 400e18);

        vm.prank(STRANGER);
        vm.expectRevert(abi.encodeWithSelector(GraduationExecutor.OnlyTreasury.selector, STRANGER));
        executor.bindAuction(address(auction));
        vm.prank(FOUNDER); // the launcher, not the payee
        executor.bindAuction(address(auction));

        vm.prank(STRANGER);
        vm.expectRevert(abi.encodeWithSelector(GraduationExecutor.OnlyTreasury.selector, STRANGER));
        executor.fundAuction(address(auction), 400e18);
        vm.prank(FOUNDER);
        vm.expectRevert(abi.encodeWithSelector(GraduationExecutor.InsufficientSaleTokens.selector, 400e18, 401e18));
        executor.fundAuction(address(auction), 401e18);
        vm.prank(FOUNDER);
        executor.fundAuction(address(auction), 400e18);
        assertEq(PlainERC20(auction.token()).balanceOf(address(auction)), 400e18, "the tranche moved to the auction");
        assertEq(PlainERC20(auction.token()).balanceOf(address(executor)), 0);
        assertEq(auction.receivedCalls(), 1, "and the auction was told it arrived");
    }

    function test_after_retargeting_the_founder_can_no_longer_move_the_reserve_or_recover_supply() public {
        vm.prank(FOUNDER);
        executor.retargetTreasury(DAO);
        vm.prank(FOUNDER);
        executor.bindAuction(address(auction));
        vm.prank(FOUNDER);
        vm.expectRevert(abi.encodeWithSelector(GraduationExecutor.OnlyTreasury.selector, FOUNDER));
        executor.releaseReserve(address(auction), address(0xCAFE));
        vm.prank(FOUNDER);
        vm.expectRevert(abi.encodeWithSelector(GraduationExecutor.OnlyTreasury.selector, FOUNDER));
        executor.recoverFailedLaunch(address(auction));
        vm.prank(FOUNDER);
        vm.expectRevert(abi.encodeWithSelector(GraduationExecutor.OnlyTreasury.selector, FOUNDER));
        executor.withdrawStuckReserve(address(auction));
    }

    function test_the_raise_and_the_unsold_supply_land_in_the_dao_not_with_the_founder() public {
        vm.prank(FOUNDER);
        executor.retargetTreasury(DAO);
        vm.prank(FOUNDER);
        executor.bindAuction(address(auction));
        auction.fund(9000e6, 300e18);
        executor.executeGraduation(address(auction));
        assertEq(PlainERC20(auction.currency()).balanceOf(DAO), 9000e6, "all of it, with no reserve");
        assertEq(PlainERC20(auction.token()).balanceOf(DAO), 300e18);
        assertEq(PlainERC20(auction.currency()).balanceOf(FOUNDER), 0);
        assertEq(PlainERC20(auction.token()).balanceOf(FOUNDER), 0);
    }
}
