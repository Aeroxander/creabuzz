// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Launcher} from "../../src/Launcher.sol";
import {ShareToken} from "../../src/ShareToken.sol";
import {Treasury} from "../../src/Treasury.sol";
import {Vester} from "../../src/Vester.sol";
import {IERC20} from "oz5/token/ERC20/IERC20.sol";
import {QuoteToken} from "../mocks/QuoteToken.sol";
import {MockGuard, NotAGuard} from "../mocks/MockGuard.sol"; // built here so `deployCodeTo` finds them

/// @notice A launched project with the people around it, for the milestone 2 tests. "The sale" is simulated the way
/// milestone 3 will do it: sale money is sent to the Treasury, Shares held by the Launcher are handed to buyers, and the
/// opener says the pool is proven.
abstract contract Base is Test {
    uint256 internal constant DOLLAR = 1e6;
    uint256 internal constant SHARE = 1e18;
    uint256 internal constant SUPPLY = 1_000_000_000e18;

    QuoteToken internal usd;
    Launcher internal launcher;
    ShareToken internal shares;
    Treasury internal t;
    Vester internal v;

    address internal admin = makeAddr("admin");
    address internal platform = makeAddr("platform");
    address internal opener = makeAddr("opener");
    address internal salePath = makeAddr("salePath");
    address internal founder = makeAddr("founder");
    address internal agent = makeAddr("agent");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    uint256 internal constant M = 6000 * DOLLAR; // melting floor after the worked sale below
    uint256 internal constant S = 1500 * DOLLAR; // spendable after the worked sale below
    bytes32 internal constant PROJECT = keccak256("project one");
    /// @dev The platform's strategy (a plain address here) and its pool guard: an address whose low 14 bits are exactly
    /// the `beforeInitialize` hook bit (1 << 13), holding a guard that names the strategy.
    address internal constant STRATEGY = address(0x57A7E6);
    address internal constant GUARD = address(uint160(0xA11CE << 20) | uint160(1 << 13));

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        usd = new QuoteToken();
        deployCodeTo("MockGuard.sol:MockGuard", abi.encode(STRATEGY), GUARD);
        launcher = _deployLauncher(admin, _settings());
        (address s, address tr, address ve) = _launch(founder, PROJECT);
        (shares, t, v) = (ShareToken(s), Treasury(tr), Vester(ve));
    }

    function _settings() internal view virtual returns (Launcher.Settings memory) {
        return Launcher.Settings({
            quote: IERC20(address(usd)),
            platform: platform,
            opener: opener,
            salePath: salePath,
            exitFeeBps: 500,
            platformFeeBps: 100,
            spendableParts: 15,
            floorParts: 60,
            agentUsd: uint128(25 * DOLLAR),
            agentShares: uint128(SUPPLY / 1000)
        });
    }

    /// @dev The Launcher holds the code of all three implementations, so a test contract that did `new Launcher` would
    /// itself be over the 49,152-byte limit for creation code. Loading it from the build output avoids that.
    function _deployLauncher(address admin_, Launcher.Settings memory s) internal returns (Launcher) {
        return _deployLauncherWith(admin_, s, STRATEGY, GUARD);
    }

    function _deployLauncherWith(address admin_, Launcher.Settings memory s, address strategy_, address guard_)
        internal
        returns (Launcher)
    {
        return Launcher(deployCode("Launcher.sol:Launcher", abi.encode(admin_, s, strategy_, guard_)));
    }

    /// @dev `block.timestamp` cannot be read after a `vm.warp` in the same test: the optimizer treats it as a constant
    /// and reuses the first value. This asks the VM each time.
    function _now() internal view returns (uint256) {
        return vm.getBlockTimestamp();
    }

    /// @dev Let `span` seconds pass with the founder checking in every 10 days, so the release never pauses.
    function _runFor(uint256 span) internal {
        uint256 end = _now() + span;
        while (_now() < end) {
            uint256 step = end - _now() < 10 days ? end - _now() : 10 days;
            vm.warp(_now() + step);
            vm.prank(founder);
            t.checkIn();
        }
    }

    function _launch(address who, bytes32 id) internal returns (address s, address tr, address ve) {
        bytes32 h = launcher.settingsHash(); // read first: a prank applies to the next call, which would be this read
        vm.prank(who);
        return launcher.launch(id, "Project One", "ONE", h);
    }

    /// @dev Sale money arrives at the Treasury (the strategy's one transfer) without being split.
    function _arrive(uint256 amount) internal {
        usd.mint(address(t), amount);
    }

    function _openPool() internal {
        vm.prank(opener);
        t.markPoolOpen();
    }

    /// @dev The finish's last step (sweep of unsold Shares) is done; exits may open once money is split.
    function _closeSale() internal {
        vm.prank(opener);
        t.markSaleClosed();
    }

    /// @dev Sale money arrives, the pool is proven, and the money is split. `amount` is what reaches the Treasury (75 of
    /// every 100 raised): 15 : 60 of it is spendable : melting.
    function _sale(uint256 amount) internal {
        _arrive(amount);
        _openPool();
        t.settle(amount);
        _closeSale();
    }

    /// @dev The worked example: sale money of 7,500 dollars reaches the Treasury (75 of each 100 of a 10,000 raise) and is
    /// split 1,500 spendable : 6,000 melting floor; alice then holds 100M Shares and bob 400M, so 500M Shares count.
    function _world() internal {
        _sale(7500 * DOLLAR);
        _buy(alice, 100_000_000 * SHARE);
        _buy(bob, 400_000_000 * SHARE);
        _approveAll(alice);
        _approveAll(bob);
    }

    /// @dev The sale delivers Shares: the Launcher's holding goes to a buyer.
    function _buy(address who, uint256 amount) internal {
        vm.prank(address(launcher));
        shares.transfer(who, amount);
    }

    function _approveAll(address who) internal {
        vm.prank(who);
        shares.approve(address(t), type(uint256).max);
    }

    function _handBack(address who, uint256 amount) internal returns (uint256 paid) {
        vm.prank(who);
        paid = t.handBack(amount);
    }

    function _buckets() internal view returns (uint256) {
        return t.spendable() + t.melting() + t.permanentFloor() + t.feesOwed();
    }
}
