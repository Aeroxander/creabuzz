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
import {MockFactory} from "./helpers/Base.sol";

/// @notice The Launcher: one transaction makes a project, nobody but the Treasury's rules can move its money, settings
/// reach only new projects, and no Launcher can be made with an unguarded sale. The real sale path is in `Life.t.sol`.
contract LauncherTest is Base {
    function test_launch_mintsEveryShareToItsPlace() public view {
        assertEq(shares.totalSupply(), SUPPLY);
        assertEq(shares.balanceOf(finisher), 500_000_000 * SHARE, "400M sale + 100M pool match, held by the Finisher");
        assertEq(shares.balanceOf(address(launcher)), 0, "the Launcher itself holds none");
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
        assertEq(usd.balanceOf(finisher), 0);
        assertEq(usd.balanceOf(address(t)), 7500 * DOLLAR);
    }

    function test_launch_recordsTheProjectUnderFounderAndId() public view {
        Launcher.Project memory p = launcher.project(founder, PROJECT);
        assertEq(p.founder, founder);
        assertEq(p.shares, address(shares));
        assertEq(p.treasury, address(t));
        assertEq(p.vester, address(v));
        assertEq(p.finisher, finisher);
        assertEq(launcher.treasuryOfShares(address(shares)), address(t));
        assertEq(launcher.treasuryOfShares(address(usd)), address(0), "only a project's Shares are known");
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
            address eFinisher,
            address eQuote,
            address ePlatform,
            Launcher.Allocation memory a,
            Launcher.Settings memory st
        ) = abi.decode(
            e.data, (address, address, address, address, address, address, Launcher.Allocation, Launcher.Settings)
        );
        assertEq(eShares, s);
        assertEq(eTreasury, tr);
        assertEq(eVester, ve);
        assertEq(eFinisher, launcher.project(alice, keccak256("indexed")).finisher);
        assertEq(eQuote, address(usd));
        assertEq(ePlatform, platform);
        assertEq(a.sale, 400_000_000 * SHARE);
        assertEq(a.poolReserve, 100_000_000 * SHARE);
        assertEq(a.founder, 200_000_000 * SHARE);
        assertEq(a.workPot, 200_000_000 * SHARE);
        assertEq(a.reserve, 100_000_000 * SHARE);
        assertEq(a.sale + a.poolReserve + a.founder + a.workPot + a.reserve, SUPPLY);
        assertEq(st.exitFeeBps, 500);
    }

    function test_launch_theSameFounderCannotReuseAnId_butAnotherFounderCan() public {
        bytes32 h = launcher.settingsHash();
        vm.prank(founder);
        vm.expectRevert(Launcher.ProjectExists.selector);
        launcher.launch(PROJECT, "Again", "AGN", h);
        (address s2,,) = _launch(alice, PROJECT);
        assertTrue(s2 != address(shares), "ids are kept per founder, so nobody can squat on another founder's id");
        (address s3,,) = _launch(founder, keccak256("other id"));
        assertTrue(s3 != address(shares));
    }

    function test_launch_namesAreChecked() public {
        bytes32 h = launcher.settingsHash();
        vm.startPrank(alice);
        vm.expectRevert(Launcher.BadName.selector);
        launcher.launch(keccak256("a"), "", "X", h);
        vm.expectRevert(Launcher.BadName.selector);
        launcher.launch(keccak256("a"), "X", "", h);
        vm.expectRevert(Launcher.BadName.selector);
        launcher.launch(keccak256("a"), new string(65), "X", h);
        vm.expectRevert(Launcher.BadName.selector);
        launcher.launch(keccak256("a"), "X", new string(65), h);
        launcher.launch(keccak256("a"), new string(64), new string(64), h); // 64 bytes is allowed
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
            if (i == 2) (s.exitFeeBps, s.platformFeeBps) = (0, 0); // allowed: no exit fee
            if (i == 3) s.agentUsd = 0; // allowed: agents that cannot spend
            if (i == 4) s.exitFeeBps = 1001;
            if (i == 5) s.platformFeeBps = 501;
            if (i == 6) s.spendableParts = 0;
            if (i == 7) s.floorParts = 0;
            if (i == 2 || i == 3) {
                launcher.setSettings(s);
                continue;
            }
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
        deployCode("Launcher.sol:Launcher", abi.encode(admin, s, STRATEGY, GUARD, minBid));
        // the platform's own strategy, guard and bid rules must be named
        vm.expectRevert(Launcher.BadStack.selector);
        deployCode("Launcher.sol:Launcher", abi.encode(admin, _settings(), address(0), GUARD, minBid));
        vm.expectRevert(Launcher.NoPoolGuard.selector);
        deployCode("Launcher.sol:Launcher", abi.encode(admin, _settings(), STRATEGY, address(0), minBid));
        vm.expectRevert(Launcher.BadStack.selector);
        deployCode("Launcher.sol:Launcher", abi.encode(admin, _settings(), STRATEGY, GUARD, address(0)));
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

    // ------------------------------------------------------------------------------------------- the platform's stack

    function test_openSale_refusesAnUnknownProject() public {
        vm.prank(alice);
        vm.expectRevert(Launcher.UnknownProject.selector);
        launcher.openSale(PROJECT, Launcher.Size.Standard);
    }

    /// @dev The strategy and the guard are the platform's, fixed when the Launcher is made, and the Launcher cannot exist
    /// without a guard: each way the platform's guard can be wrong (no contract there, an address without exactly the
    /// `beforeInitialize` bit, a contract that is not a guard, a guard naming someone else) stops the Launcher being built, so
    /// no sale can ever open unguarded.
    function test_constructor_refusesASaleWithNoPoolGuard() public {
        address noContract = address(uint160(0xB0B << 20) | uint160(1 << 13));
        address wrongBits = address(uint160(0xC0C << 20) | uint160(1 << 12)); // right code, but not `beforeInitialize`
        address extraBit = address(uint160(0xD0D << 20) | uint160(1 << 13) | 1); // `beforeInitialize` and one more
        address notAGuard = address(uint160(0xE0E << 20) | uint160(1 << 13));
        address otherGuard = address(uint160(0xF0F << 20) | uint160(1 << 13));
        deployCodeTo("MockGuard.sol:MockGuard", abi.encode(STRATEGY), wrongBits);
        deployCodeTo("MockGuard.sol:MockGuard", abi.encode(STRATEGY), extraBit);
        deployCodeTo("MockGuard.sol:NotAGuard", "", notAGuard);
        deployCodeTo("MockGuard.sol:MockGuard", abi.encode(address(0xCAFE)), otherGuard); // names someone else
        address[5] memory bad = [noContract, wrongBits, extraBit, notAGuard, otherGuard];
        for (uint256 i; i < bad.length; ++i) {
            vm.expectRevert(Launcher.NoPoolGuard.selector);
            deployCode("Launcher.sol:Launcher", abi.encode(admin, _settings(), STRATEGY, bad[i], minBid));
        }
    }

    function test_constructor_theFeeMustBeExactlyThreePercentAndHaveNoOwner() public {
        // a controller that takes 2% , one that takes 4%, one with an owner (the vendored one's shape), none at all
        address two = deployCode("FixedFeeController.sol:FixedFeeController", abi.encode(platform, uint24(20_000)));
        address four = deployCode("FixedFeeController.sol:FixedFeeController", abi.encode(platform, uint24(40_000)));
        address owned = address(new OwnedFeeController(feeController));
        address none = makeAddr("no controller");
        address noRecipient = address(new ZeroRecipientController(feeController));
        address[5] memory bad = [two, four, owned, none, noRecipient];
        for (uint256 i; i < bad.length; ++i) {
            address f = address(new MockFactory(bad[i]));
            address strat = address(uint160(0x57A7E7 + i));
            deployCodeTo(
                "MockStrategy.sol:MockStrategy", abi.encode(FAKE_POOL_MANAGER, FAKE_POSITION_MANAGER, f), strat
            );
            address g = address(uint160(0xAA00 << 20 | (i + 1) << 24) | uint160(1 << 13));
            deployCodeTo("MockGuard.sol:MockGuard", abi.encode(strat), g);
            vm.expectRevert(Launcher.BadStack.selector);
            deployCode("Launcher.sol:Launcher", abi.encode(admin, _settings(), strat, g, minBid));
        }
        // a strategy with no code at all
        vm.expectRevert(Launcher.BadStack.selector);
        deployCode("Launcher.sol:Launcher", abi.encode(admin, _settings(), makeAddr("not a strategy"), GUARD, minBid));
        // the right controller is accepted (the setUp Launcher), and its recipient is the platform's fee address
        assertEq(launcher.raiseFeeRecipient(), platform);
    }

    function test_constructor_theBidRulesMustBeOneDollarFourTimesAndAClosingWindow() public {
        address noMin = deployCode("MinBid.sol:MinBid", abi.encode(uint128(0), uint256(4), uint64(720)));
        address smallMin = deployCode("MinBid.sol:MinBid", abi.encode(uint128(1e5), uint256(4), uint64(720)));
        address noCap = deployCode("MinBid.sol:MinBid", abi.encode(uint128(1e6), uint256(0), uint64(720)));
        address bigCap = deployCode("MinBid.sol:MinBid", abi.encode(uint128(1e6), uint256(40), uint64(720)));
        address noWindow = deployCode("MinBid.sol:MinBid", abi.encode(uint128(1e6), uint256(4), uint64(0)));
        address shortWindow = deployCode("MinBid.sol:MinBid", abi.encode(uint128(1e6), uint256(4), uint64(719)));
        address longWindow = deployCode("MinBid.sol:MinBid", abi.encode(uint128(1e6), uint256(4), uint64(721)));
        address[7] memory bad = [noMin, smallMin, noCap, bigCap, noWindow, shortWindow, longWindow];
        for (uint256 i; i < bad.length; ++i) {
            vm.expectRevert(Launcher.BadStack.selector);
            deployCode("Launcher.sol:Launcher", abi.encode(admin, _settings(), STRATEGY, GUARD, bad[i]));
        }
        assertEq(launcher.BID_CLOSING_BLOCKS(), 720);
    }

    function test_thePlatformStackIsFixedAndNoSettingReachesIt() public view {
        assertEq(launcher.strategy(), STRATEGY);
        assertEq(launcher.poolGuard(), GUARD);
        assertEq(launcher.minBid(), minBid);
        assertEq(t.opener(), finisher, "the Treasury's opener is the project's Finisher");
        assertEq(t.salePath(), address(launcher), "the Treasury's sale path is the Launcher");
    }

    function test_sizes_theMenuIsFixed() public view {
        (uint256 g, uint256 m) = launcher.sizeOf(Launcher.Size.Small);
        assertEq(g, 4000 * DOLLAR);
        assertEq(m, 2000 * DOLLAR);
        (g, m) = launcher.sizeOf(Launcher.Size.Standard);
        assertEq(g, 10_000 * DOLLAR);
        assertEq(m, 2500 * DOLLAR);
        (g, m) = launcher.sizeOf(Launcher.Size.Large);
        assertEq(g, 50_000 * DOLLAR);
        assertEq(m, 12_500 * DOLLAR);
        (uint256 floorQ96, uint256 tickQ96) = launcher.salePrices(Launcher.Size.Standard);
        assertEq(floorQ96, tickQ96 * 100, "the floor is exactly tick 100");
        // 10,000 dollars (raw 1e10) over 400,000,000 Shares (raw 4e26) is 2.5e-17 raw dollars a raw Share, times 2^96
        assertApproxEqRel(floorQ96, (uint256(10_000e6) << 96) / uint256(400_000_000e18), 0.01e18);
    }

    // ------------------------------------------------------------------------------- settings a founder commits to

    function test_launch_refusesSettingsTheFounderDidNotSee() public {
        bytes32 seen = launcher.settingsHash();
        Launcher.Settings memory s = _settings();
        s.platform = makeAddr("a new platform address"); // the admin changes where the exit fee goes after the founder looked
        vm.prank(admin);
        launcher.setSettings(s);
        assertTrue(launcher.settingsHash() != seen);
        vm.prank(alice);
        vm.expectRevert(Launcher.SettingsMoved.selector);
        launcher.launch(keccak256("late"), "Late", "LT", seen); // the founder's transaction lands after the change
        bytes32 now_ = launcher.settingsHash();
        vm.prank(alice);
        launcher.launch(keccak256("late"), "Late", "LT", now_); // the founder who saw the new settings is fine
    }

    function test_settings_theDollarTokenAndPlatformAddressAreBounded() public {
        vm.startPrank(admin);
        Launcher.Settings memory s = _settings();
        s.quote = IERC20(makeAddr("an account, not a token"));
        vm.expectRevert(Launcher.BadSettings.selector);
        launcher.setSettings(s);
        s.quote = IERC20(address(new NotAGuard())); // a contract with no decimals()
        vm.expectRevert(Launcher.BadSettings.selector);
        launcher.setSettings(s);
        s.quote = IERC20(address(new EighteenDecimals())); // the wrong scale for every raw amount here
        vm.expectRevert(Launcher.BadSettings.selector);
        launcher.setSettings(s);
        s = _settings();
        s.platform = address(launcher); // fees sent here could never be collected
        vm.expectRevert(Launcher.BadSettings.selector);
        launcher.setSettings(s);
        s.platform = address(usd); // fees sent to the token itself are lost
        vm.expectRevert(Launcher.BadSettings.selector);
        launcher.setSettings(s);
        vm.stopPrank();
    }

    function test_settings_bothPartsOfTheSplitHaveACeiling() public {
        vm.startPrank(admin);
        Launcher.Settings memory s = _settings();
        s.spendableParts = 10_001;
        vm.expectRevert(Launcher.BadSettings.selector);
        launcher.setSettings(s);
        s = _settings();
        s.floorParts = 10_001;
        vm.expectRevert(Launcher.BadSettings.selector);
        launcher.setSettings(s);
        s.spendableParts = 10_000;
        s.floorParts = 10_000; // the ceiling itself is allowed
        launcher.setSettings(s);
        vm.stopPrank();
    }
}

/// @dev A token with the wrong scale.
contract EighteenDecimals {
    uint8 public constant decimals = 18;
}

/// @dev A fee controller shaped like the vendored one: right fee, but it has an owner who could change it.
contract OwnedFeeController {
    address private immutable _real;

    constructor(address real) {
        _real = real;
    }

    function owner() external pure returns (address) {
        return address(0xBEEF);
    }

    function getProtocolFeeAmount(address c, uint256 a) external view returns (uint256) {
        (bool ok, bytes memory r) =
            _real.staticcall(abi.encodeWithSignature("getProtocolFeeAmount(address,uint256)", c, a));
        require(ok);
        return abi.decode(r, (uint256));
    }

    function protocolFeeRecipient() external view returns (address) {
        (bool ok, bytes memory r) = _real.staticcall(abi.encodeWithSignature("protocolFeeRecipient()"));
        require(ok);
        return abi.decode(r, (address));
    }
}

/// @dev A fee controller with the right fee and no owner, but nobody to pay.
contract ZeroRecipientController {
    address private immutable _real;

    constructor(address real) {
        _real = real;
    }

    function getProtocolFeeAmount(address c, uint256 a) external view returns (uint256) {
        (bool ok, bytes memory r) =
            _real.staticcall(abi.encodeWithSignature("getProtocolFeeAmount(address,uint256)", c, a));
        require(ok);
        return abi.decode(r, (uint256));
    }

    function protocolFeeRecipient() external pure returns (address) {
        return address(0);
    }
}
