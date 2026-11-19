// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "oz5/token/ERC20/IERC20.sol";
import {Clones} from "oz5/proxy/Clones.sol";
import {Treasury} from "../../src/Treasury.sol";
import {IShares, ITaskBook} from "../../src/Interfaces.sol";
import {TaskBook} from "../../src/TaskBook.sol";
import {TaskBookHarness} from "./TaskBookHarness.sol";
import {ShareToken} from "../../src/ShareToken.sol";
import {QuoteToken} from "../mocks/QuoteToken.sol";
import {TreasuryHarness} from "./TreasuryHarness.sol";
import {MockSalePath, MockPair, MockVester} from "./Mocks.sol";

/// @notice Launches a project by cloning the contracts directly (the Launcher comes in pass B) and gives the tests the
/// small actions every file needs.
abstract contract PotBase is Test {
    uint256 internal constant U = 1e6; // one dollar
    uint256 internal constant S = 1e18; // one Share
    uint32 internal constant UNIT = 7 days;
    uint256 internal constant DAY = 1 days;
    uint256 internal constant POOL = 10_000_000e18;
    uint256 internal constant T0 = 1_700_000_000;

    QuoteToken internal usd;
    TreasuryHarness internal t;
    ShareToken internal shares;
    ShareToken internal team;
    MockVester internal vester;
    MockSalePath internal sale;
    ShareToken internal tokenImpl;
    TreasuryHarness internal treasuryImpl;
    TaskBookHarness internal bookImpl;

    address internal founder = makeAddr("founder");
    address internal platform = makeAddr("platform");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal stranger = makeAddr("stranger");

    function setUp() public virtual {
        vm.warp(T0);
        usd = new QuoteToken();
        sale = new MockSalePath();
        tokenImpl = new ShareToken();
        treasuryImpl = new TreasuryHarness();
        bookImpl = new TaskBookHarness();
        (t, shares, team, vester) = _launch(IERC20(address(usd)), POOL, 1000, 200, UNIT);
    }

    function _launch(IERC20 quote, uint256 pool, uint32 rate, uint16 feeBps, uint32 unit_)
        internal
        returns (TreasuryHarness tr, ShareToken sh, ShareToken tm, MockVester v)
    {
        tr = TreasuryHarness(Clones.clone(address(treasuryImpl)));
        sh = ShareToken(Clones.clone(address(tokenImpl)));
        tm = ShareToken(Clones.clone(address(tokenImpl)));
        v = new MockVester();
        TaskBookHarness tb = TaskBookHarness(Clones.clone(address(bookImpl)));
        tb.initialize(address(tr), unit_);
        sh.initialize("Shares", "SHR", address(tr), address(0), 0);
        tm.initialize("Team Shares", "TEAM", address(tr), address(v), pool);
        tr.initialize(
            Treasury.Setup({
                quote: quote,
                shares: IShares(address(sh)),
                team: IShares(address(tm)),
                vester: address(v),
                founder: founder,
                platform: platform,
                salePath: address(sale),
                unit: unit_,
                ratePpm: rate,
                feeBps: feeBps,
                agentUsd: 25e6,
                agentTeam: uint128(pool / 1000),
                tasks: ITaskBook(address(tb))
            })
        );
    }

    /// @dev The project's task book.
    function _book() internal view returns (TaskBookHarness) {
        return TaskBookHarness(address(t.tasks()));
    }

    /// @dev Replace the project with a fresh one with another Team pool and allowance rate.
    function _relaunch(uint256 pool, uint32 rate) internal {
        (t, shares, team, vester) = _launch(IERC20(address(usd)), pool, rate, 200, UNIT);
    }

    /// @dev Pay `amount` into the project from `who` (minting the dollars first) and return the Shares.
    function _join(address who, uint256 amount) internal returns (uint256 n) {
        usd.mint(who, amount);
        vm.startPrank(who);
        usd.approve(address(t), amount);
        n = t.join(amount, 0, who);
        vm.stopPrank();
    }

    function _leave(address who, uint256 n) internal returns (uint256 cash) {
        vm.prank(who);
        cash = t.leave(n, 0, who);
    }

    /// @dev The runner checks in (a person, or a Pair standing in for the runner).
    function _checkIn() internal {
        vm.prank(t.runner());
        t.checkIn(bytes32(0));
    }

    function _revenue(address who, uint256 amount) internal {
        usd.mint(who, amount);
        vm.startPrank(who);
        usd.approve(address(t), amount);
        t.addRevenue(amount);
        vm.stopPrank();
    }

    /// @dev Set the buckets directly and fund the contract to match.
    function _force(uint256 pot, uint256 paidIn, uint256 box, uint256 arriving, uint64 arrivalEnd) internal {
        t.force(pot, paidIn, box, arriving, arrivalEnd);
        uint256 need = pot + box + arriving + t.feesOwed();
        uint256 bal = usd.balanceOf(address(t));
        if (need > bal) usd.mint(address(t), need - bal);
    }

    /// @dev Everything the contract holds is accounted for, and nothing is owed that is not held.
    function _assertConserved() internal view {
        uint256 accounted = t.pot() + t.box() + t.arriving() + t.feesOwed() + t.locked() + t.notesOwed();
        assertGe(usd.balanceOf(address(t)), accounted, "owes more than it holds");
    }
}
