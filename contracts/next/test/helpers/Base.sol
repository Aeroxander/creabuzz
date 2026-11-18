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
import {MockStrategy} from "../mocks/MockStrategy.sol"; // likewise

/// @notice A launched project with the people around it, for the Treasury, Vester, Launcher and attack tests. "The sale" is
/// simulated: sale money is sent to the Treasury, Shares held by the project's Finisher are handed to buyers, and the
/// opener (the Finisher's address, pranked) says the pool is proven. The strategy, pool guard and fee path are small fakes
/// (`MockStrategy`, `MockGuard`) around the real `FixedFeeController` and `MinBid`; the real Uniswap route is tested in
/// `Life.t.sol`.
abstract contract Base is Test {
    uint256 internal constant DOLLAR = 1e6;
    uint256 internal constant SHARE = 1e18;
    uint256 internal constant SUPPLY = 1_000_000_000e18;

    QuoteToken internal usd;
    Launcher internal launcher;
    address internal finisher; // the project's Finisher: the Treasury's `opener`, and the holder of the sale Shares
    ShareToken internal shares;
    Treasury internal t;
    Vester internal v;

    address internal admin = makeAddr("admin");
    address internal platform = makeAddr("platform");
    address internal opener; // the project's Finisher, set once the project is launched
    address internal salePath; // the Launcher, set once it is deployed
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
    address internal constant FAKE_POOL_MANAGER = address(0xB001);
    address internal constant FAKE_POSITION_MANAGER = address(0xB002);
    address internal feeController;
    address internal minBid;
    address internal parts;
    address internal rounds; // the project's Rounds (holds the 150M backing Shares)
    address internal stakeHolder = makeAddr("stake");
    address internal councilMaker = makeAddr("council maker");

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        usd = new QuoteToken();
        deployCodeTo("MockGuard.sol:MockGuard", abi.encode(STRATEGY), GUARD);
        feeController = deployCode("FixedFeeController.sol:FixedFeeController", abi.encode(platform, uint24(30_000)));
        minBid = deployCode("MinBid.sol:MinBid", abi.encode(uint128(1e6), uint256(4), uint64(720)));
        address factory = address(new MockFactory(feeController));
        deployCodeTo(
            "MockStrategy.sol:MockStrategy", abi.encode(FAKE_POOL_MANAGER, FAKE_POSITION_MANAGER, factory), STRATEGY
        );
        parts = deployCode("Parts.sol:Parts");
        launcher = _deployLauncher(admin, _settings());
        salePath = address(launcher);
        (address s, address tr, address ve) = _launch(founder, PROJECT);
        (shares, t, v) = (ShareToken(s), Treasury(tr), Vester(ve));
        finisher = opener = launcher.project(founder, PROJECT).finisher;
        rounds = launcher.project(founder, PROJECT).rounds;
    }

    function _settings() internal view virtual returns (Launcher.Settings memory) {
        return Launcher.Settings({
            quote: IERC20(address(usd)),
            platform: platform,
            stake: stakeHolder,
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
        return Launcher(
            deployCode("Launcher.sol:Launcher", abi.encode(admin_, s, strategy_, guard_, minBid, parts, councilMaker))
        );
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
        bytes32 h = launcher.launchHash(launcher.keyOf(who, id)); // read first: a prank applies to the next call
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

    /// @dev The sale delivers Shares: the Finisher's holding (350M) goes to a buyer, then, once it is empty, the Rounds' backing
    /// Shares (150M) stand in for more sale Shares, so the milestone 2 world still has 500M Shares in people's hands.
    function _buy(address who, uint256 amount) internal {
        uint256 fromFinisher = shares.balanceOf(finisher);
        if (fromFinisher > amount) fromFinisher = amount;
        if (fromFinisher != 0) {
            vm.prank(finisher);
            shares.transfer(who, fromFinisher);
        }
        if (amount > fromFinisher) {
            vm.prank(rounds);
            shares.transfer(who, amount - fromFinisher);
        }
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

/// @notice A stand-in for the auction factory: only the fee controller the Launcher reads.
contract MockFactory {
    address public immutable protocolFeeController;

    constructor(address controller) {
        protocolFeeController = controller;
    }
}
