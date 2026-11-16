// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "oz5/token/ERC20/IERC20.sol";
import {Base} from "./helpers/Base.sol";
import {Launcher} from "../src/Launcher.sol";
import {Treasury} from "../src/Treasury.sol";
import {ShareToken} from "../src/ShareToken.sol";
import {Vester} from "../src/Vester.sol";
import {IShares} from "../src/Interfaces.sol";
import {MockGuard, NotAGuard} from "./mocks/MockGuard.sol";

/// @notice The Launcher: one transaction makes a project, nobody but the Treasury's rules can move its money, settings
/// reach only new projects, and a sale with no pool guard is refused.
contract LauncherTest is Base {
    function test_launch_mintsEveryShareToItsPlace() public view {
        assertEq(shares.totalSupply(), SUPPLY);
        assertEq(
            shares.balanceOf(address(launcher)),
            500_000_000 * SHARE,
            "400M sale + 100M pool match, held for milestone 3"
        );
        assertEq(shares.balanceOf(address(v)), 200_000_000 * SHARE, "the founder's 20%");
        assertEq(shares.balanceOf(address(t)), 300_000_000 * SHARE, "200M work pot + 100M reserve");
        assertEq(shares.balanceOf(founder), 0, "the founder holds nothing yet");
        (uint256 total,) = v.grants(founder);
        assertEq(total, 200_000_000 * SHARE);
        assertEq(t.workPot(), 200_000_000 * SHARE);
        assertEq(t.reserve(), 100_000_000 * SHARE);
        assertEq(shares.name(), "Project One");
        assertEq(shares.symbol(), "ONE");
    }

    function test_launch_theFounderNeverHoldsTheMoneyAndTheLauncherNeverDoes() public {
        _sale(7500 * DOLLAR);
        assertEq(usd.balanceOf(founder), 0);
        assertEq(usd.balanceOf(address(launcher)), 0);
        assertEq(usd.balanceOf(address(t)), 7500 * DOLLAR);
    }

    function test_launch_recordsTheProjectUnderFounderAndId() public view {
        Launcher.Project memory p = launcher.project(founder, PROJECT);
        assertEq(p.founder, founder);
        assertEq(p.shares, address(shares));
        assertEq(p.treasury, address(t));
        assertEq(p.vester, address(v));
        assertEq(p.launchedAt, 1_800_000_000);
        assertEq(launcher.project(alice, PROJECT).shares, address(0), "someone else's id is not ours");
    }

    function test_launch_oneEventCarriesEveryAddressAndTheAllocation() public {
        vm.recordLogs();
        (address s, address tr, address ve) = _launch(alice, keccak256("indexed"));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        Vm.Log memory e = logs[logs.length - 1];
        assertEq(e.emitter, address(launcher));
        assertEq(e.topics[0], Launcher.ProjectLaunched.selector);
        assertEq(e.topics[1], keccak256("indexed"));
        assertEq(address(uint160(uint256(e.topics[2]))), alice);
        (
            address eShares,
            address eTreasury,
            address eVester,
            address eQuote,
            address ePlatform,
            Launcher.Allocation memory a,
            Launcher.Settings memory st
        ) = abi.decode(e.data, (address, address, address, address, address, Launcher.Allocation, Launcher.Settings));
        assertEq(eShares, s);
        assertEq(eTreasury, tr);
        assertEq(eVester, ve);
        assertEq(eQuote, address(usd));
        assertEq(ePlatform, platform);
        assertEq(a.sale, 400_000_000 * SHARE);
        assertEq(a.poolReserve, 100_000_000 * SHARE);
        assertEq(a.founder, 200_000_000 * SHARE);
        assertEq(a.workPot, 200_000_000 * SHARE);
        assertEq(a.reserve, 100_000_000 * SHARE);
        assertEq(a.sale + a.poolReserve + a.founder + a.workPot + a.reserve, SUPPLY);
        assertEq(st.opener, opener);
        assertEq(st.salePath, salePath);
        assertEq(st.exitFeeBps, 500);
    }

    function test_launch_theSameFounderCannotReuseAnId_butAnotherFounderCan() public {
        vm.prank(founder);
        vm.expectRevert(Launcher.ProjectExists.selector);
        launcher.launch(PROJECT, "Again", "AGN");
        (address s2,,) = _launch(alice, PROJECT);
        assertTrue(s2 != address(shares), "ids are kept per founder, so nobody can squat on another founder's id");
        (address s3,,) = _launch(founder, keccak256("other id"));
        assertTrue(s3 != address(shares));
    }

    function test_launch_namesAreChecked() public {
        vm.startPrank(alice);
        vm.expectRevert(Launcher.BadName.selector);
        launcher.launch(keccak256("a"), "", "X");
        vm.expectRevert(Launcher.BadName.selector);
        launcher.launch(keccak256("a"), "X", "");
        vm.expectRevert(Launcher.BadName.selector);
        launcher.launch(keccak256("a"), new string(65), "X");
        vm.expectRevert(Launcher.BadName.selector);
        launcher.launch(keccak256("a"), "X", new string(65));
        launcher.launch(keccak256("a"), new string(64), new string(64)); // 64 bytes is allowed
        vm.stopPrank();
    }

    function test_launch_theImplementationsAreLocked() public {
        Vester vImpl = Vester(launcher.vesterImpl());
        ShareToken sImpl = ShareToken(launcher.shareImpl());
        vm.expectRevert(Vester.AlreadyInitialized.selector);
        vImpl.initialize(IShares(address(shares)), alice, alice, alice, 1);
        vm.expectRevert(ShareToken.BadBirth.selector);
        sImpl.initialize("x", "x", new address[](0), new uint256[](0));
    }

    function test_launch_aPersonAloneCanMakeSharesAndGiveThemWithNoVoteReviewerOrWait() public {
        // one account, no other person, no time passing: launch, then give Shares in the next call
        address solo = makeAddr("solo");
        (, address tr, address ve) = _launch(solo, keccak256("solo"));
        vm.prank(solo);
        Treasury(tr).giveShares(bob, 5000 * SHARE);
        (uint256 total,) = Vester(ve).grants(bob);
        assertEq(total, 5000 * SHARE);
        assertEq(Treasury(tr).workPot(), 200_000_000 * SHARE - 5000 * SHARE);
    }

    function test_settings_onlyTheAdminChangesThem_andOnlyNewProjectsSeeThem() public {
        Launcher.Settings memory s = _settings();
        s.platform = makeAddr("newPlatform");
        s.exitFeeBps = 300;
        s.platformFeeBps = 50;
        s.spendableParts = 20;
        s.floorParts = 55;
        vm.expectRevert(Launcher.NotAdmin.selector);
        launcher.setSettings(s);
        vm.prank(admin);
        launcher.setSettings(s);
        (, address tr2,) = _launch(alice, keccak256("new"));
        Treasury t2 = Treasury(tr2);
        assertEq(t2.platform(), s.platform);
        assertEq(t2.exitFeeBps(), 300);
        assertEq(t2.platformFeeBps(), 50);
        assertEq(t2.spendableParts(), 20);
        assertEq(t2.floorParts(), 55);
        // the project launched before the change is untouched
        assertEq(t.platform(), platform);
        assertEq(t.exitFeeBps(), 500);
        assertEq(t.platformFeeBps(), 100);
        assertEq(t.spendableParts(), 15);
        assertEq(t.floorParts(), 60);
    }

    function test_settings_badValuesAreRefused() public {
        vm.startPrank(admin);
        for (uint256 i; i < 9; ++i) {
            Launcher.Settings memory s = _settings();
            if (i == 0) s.quote = IERC20(address(0));
            if (i == 1) s.platform = address(0);
            if (i == 2) s.opener = address(0);
            if (i == 3) s.salePath = address(0);
            if (i == 4) s.exitFeeBps = 1001;
            if (i == 5) s.platformFeeBps = 501;
            if (i == 6) s.spendableParts = 0;
            if (i == 7) s.floorParts = 0;
            if (i == 8) {
                s.exitFeeBps = 1000;
                s.platformFeeBps = 1000;
                launcher.setSettings(s); // the top of the range is allowed
                continue;
            }
            vm.expectRevert(Launcher.BadSettings.selector);
            launcher.setSettings(s);
        }
        vm.stopPrank();
    }

    function test_constructor_refusesBadSettings() public {
        Launcher.Settings memory s = _settings();
        s.platform = address(0);
        vm.expectRevert(Launcher.BadSettings.selector);
        new Launcher(admin, s);
    }

    function test_admin_canHandOnOrRenounce_andRenouncingFreezesSettings() public {
        vm.prank(alice);
        vm.expectRevert(Launcher.NotAdmin.selector);
        launcher.transferAdmin(alice);
        vm.prank(admin);
        launcher.transferAdmin(alice);
        vm.prank(admin);
        vm.expectRevert(Launcher.NotAdmin.selector);
        launcher.setSettings(_settings());
        vm.prank(alice);
        launcher.transferAdmin(address(0));
        assertEq(launcher.admin(), address(0));
        vm.prank(alice);
        vm.expectRevert(Launcher.NotAdmin.selector);
        launcher.setSettings(_settings());
    }

    // ------------------------------------------------------------------------------------------- open sale

    function test_openSale_refusesAnUnknownProject() public {
        MockGuard g = new MockGuard(address(0xBEEF));
        vm.prank(alice);
        vm.expectRevert(Launcher.UnknownProject.selector);
        launcher.openSale(PROJECT, address(0xBEEF), address(g));
    }

    function test_openSale_refusesASaleWithNoPoolGuard() public {
        address account = makeAddr("an account, not a contract");
        address notAGuard = address(new NotAGuard());
        address otherGuard = address(new MockGuard(address(0xCAFE)));
        address zeroGuard = address(new MockGuard(address(0)));
        vm.startPrank(founder);
        vm.expectRevert(Launcher.NoPoolGuard.selector);
        launcher.openSale(PROJECT, address(0xBEEF), address(0)); // no hook at all
        vm.expectRevert(Launcher.NoPoolGuard.selector);
        launcher.openSale(PROJECT, address(0xBEEF), account);
        vm.expectRevert(Launcher.NoPoolGuard.selector);
        launcher.openSale(PROJECT, address(0xBEEF), notAGuard); // a contract that is not a guard
        vm.expectRevert(Launcher.NoPoolGuard.selector);
        launcher.openSale(PROJECT, address(0xBEEF), otherGuard); // names someone else as the pool's creator
        vm.expectRevert(Launcher.NoPoolGuard.selector);
        launcher.openSale(PROJECT, address(0), zeroGuard); // no strategy
        vm.stopPrank();
    }

    function test_openSale_withAProperGuardStopsOnlyBecauseTheSaleIsNotBuiltYet() public {
        MockGuard g = new MockGuard(address(0xBEEF));
        vm.prank(founder);
        vm.expectRevert(Launcher.SaleNotBuilt.selector);
        launcher.openSale(PROJECT, address(0xBEEF), address(g));
    }
}
