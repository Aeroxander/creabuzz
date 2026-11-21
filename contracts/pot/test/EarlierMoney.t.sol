// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {console2} from "forge-std/console2.sol";
import {Math} from "oz5/utils/math/Math.sol";
import {Treasury} from "../src/Treasury.sol";
import {EarlierBase, Row} from "./helpers/EarlierBase.sol";
import {Proj} from "./helpers/StackBase.sol";
import {Launcher} from "../src/Launcher.sol";
import {Parts} from "../src/Parts.sol";
import {QuoteToken} from "./mocks/QuoteToken.sol";

/// @notice The money side of the earlier grants, bound to the real contracts: Team Shares claim only the surplus above what
/// backers put in, so a claim never reaches a backer's money; a claim after a wind-down still works; and the part of the pool
/// nobody claims keeps its slice of any surplus for ever, also after a wind-down. This last is the figure the owner must see
/// before any real network (docs/next-version/STEP4-PLAN.md, 3.3): the test pins it and prints it.
contract EarlierMoneyTest is EarlierBase {
    uint256 internal constant YEAR = 365 days;

    function _backersAndRevenue(uint256 joinUsd, uint256 revenueUsd) internal returns (uint256 n) {
        n = _join(alice, joinUsd);
        if (revenueUsd != 0) _revenue(carol, revenueUsd);
    }

    // ---------------------------------------------------------------- an earlier holder's take-out

    function test_earlierSharesNeverReachBackersPaidIn() public {
        _backersAndRevenue(100e6, 0);
        uint256 id = _claim(0);
        _warp(YEAR);
        v.claim(id);
        assertEq(team.balanceOf(row1), 1000e18, "all of it vested and in the holder's hands");
        t.settle();
        assertLe(t.pot(), t.paidIn(), "the pot is at or under what backers put in");
        vm.prank(row1);
        vm.expectRevert(Treasury.NothingToPay.selector);
        t.leaveTeam(1000e18, 0, row1);
        assertEq(team.balanceOf(row1), 1000e18, "nothing burnt on a refusal");
        assertEq(usd.balanceOf(row1), 0, "and nothing paid");

        // above paid-in: exactly the Team formula's share of the part above it
        _revenue(carol, 100e6);
        _warp(UNIT); // outside money arrives over a time unit
        t.settle();
        uint256 pot = t.pot();
        uint256 paidIn = t.paidIn();
        assertGt(pot, paidIn);
        uint256 b = shares.totalSupply();
        uint256 g = team.totalSupply();
        uint256 expected = Math.mulDiv(1000e18, pot - paidIn, b + g);
        assertGt(expected, 0);
        vm.prank(row1);
        uint256 got = t.leaveTeam(1000e18, 0, row1);
        assertEq(got, expected, "the Team formula: n x surplus / (backers + Team)");
        assertEq(t.paidIn(), paidIn, "paid-in is untouched");
        assertEq(usd.balanceOf(row1), expected);
    }

    function test_aClaimNeverMovesWhatBackersGetOut() public {
        uint256 n = _backersAndRevenue(500e6, 100e6);
        t.settle();
        (uint256 before_,,) = t.quoteTakeOut(alice, n);
        uint256 supply = team.totalSupply();
        assertGt(before_, 0);
        uint256 a = _claim(0);
        uint256 b = _claim(1);
        _claim(2);
        (uint256 after_,,) = t.quoteTakeOut(alice, n);
        assertEq(after_, before_, "claims do not change a take-out");
        assertEq(team.totalSupply(), supply, "no Team Share is made by a claim");
        // paying the vested part out to the holders moves Shares between hands, not the supply
        _warp(YEAR);
        v.claim(a);
        v.claim(b);
        assertEq(team.totalSupply(), supply);
        assertEq(t.leaveValue() > 0, true);
    }

    function test_theEarlierPoolIsInTheTeamSupplyFromBirthSoAJoinersPriceCountsIt() public view {
        assertEq(team.totalSupply(), POOL + poolTotal);
        assertEq(t.agentTeam(), POOL / 1000);
    }

    // ---------------------------------------------------------------- after a wind-down

    function test_claimAfterWindDown() public {
        _backersAndRevenue(100e6, 50e6);
        vm.prank(founder);
        t.windDown();
        _warp(UNIT + 1);
        v.burnUngrantedAfterWindDown();
        uint256 reserve = v.earlierReserve();
        assertEq(reserve, poolTotal, "the reserve was not burned");
        uint256 id = _claim(0);
        assertEq(v.grantOf(id).total, 1000e18, "a claim after a wind-down still works");
        _warp(YEAR);
        v.claim(id);
        assertEq(team.balanceOf(row1), 1000e18);
        // and the grant is not burned: it was never open to the after-wind-down burn
        assertEq(team.totalSupply(), poolTotal, "only the reserve (claimed or not) is left of the Team supply");
        // the holder can still take out its share of the surplus
        t.settle();
        uint256 pot = t.pot();
        uint256 paidIn = t.paidIn();
        assertGt(pot, paidIn);
        uint256 expected = Math.mulDiv(1000e18, pot - paidIn, shares.totalSupply() + team.totalSupply());
        vm.prank(row1);
        assertEq(t.leaveTeam(1000e18, 0, row1), expected);
    }

    /// @dev The figures of the plan's 3.3, pinned. Backers hold about 63 million Shares here (650,000 dollars in); the founder's own Team pool is 10
    /// million and the earlier pool 100 million, none of it claimed. Backers' own money always comes first; what changes is the
    /// slice of a SURPLUS they share with every Team Share, `b / (b + g)`:
    ///  - founder's pool only                    : b / (b + 10M)  about 86.4% (the plan's worked case, 60M Shares, gives 85.7%)
    ///  - with the 100M earlier pool unclaimed   : b / (b + 110M) about 36.7% (the plan's: 35.3%)
    ///  - after a wind-down the ordinary pool burns, the earlier reserve does not: b / (b + 100M) about 38.9%, where without an
    ///    earlier pool backers would have all of it (100%).
    function test_theBackersSliceOfASurplusWithAnUnclaimedPool() public {
        (uint256 b1, uint256 founderOnly) = _backersSurplusBps(0, false);
        (uint256 b2, uint256 withPool) = _backersSurplusBps(100_000_000e18, false);
        (, uint256 afterWindDown) = _backersSurplusBps(100_000_000e18, true);
        (, uint256 plainAfterWindDown) = _backersSurplusBps(0, true);
        console2.log("backers' Shares (million):                 ", b1 / 1e24);
        console2.log("founder's pool only, bps of a surplus:     ", founderOnly);
        console2.log("with 100M unclaimed, bps of a surplus:     ", withPool);
        console2.log("after a wind-down, 100M unclaimed, bps:    ", afterWindDown);
        console2.log("after a wind-down, no earlier pool, bps:   ", plainAfterWindDown);
        assertEq(b1, b2, "the same backers in every case");
        assertEq(founderOnly, PINNED_FOUNDER_ONLY);
        assertEq(withPool, PINNED_WITH_POOL);
        assertEq(afterWindDown, PINNED_AFTER_WIND_DOWN);
        assertEq(
            plainAfterWindDown, 10_000, "no earlier pool: backers have all of it once the ordinary pool has burned"
        );
        assertLt(withPool, founderOnly);
        assertGt(afterWindDown, withPool, "the ordinary pool burned, the earlier reserve did not");
        assertLt(afterWindDown, plainAfterWindDown);
    }

    uint256 internal constant PINNED_FOUNDER_ONLY = 8643;
    uint256 internal constant PINNED_WITH_POOL = 3667;
    uint256 internal constant PINNED_AFTER_WIND_DOWN = 3891;

    /// @dev Backers' share of a surplus, in basis points of the surplus, for a stack with an earlier pool of `pool_` (zero:
    /// none): all backers take out everything after about 65,000 dollars came in and a surplus arrived. Returns the backers'
    /// Shares and the share.
    function _backersSurplusBps(uint256 pool_, bool windDown_) internal returns (uint256 b, uint256 bps) {
        if (pool_ == 0) {
            _use(_plainStack());
        } else {
            Row[] memory list = new Row[](2);
            list[0] = Row(0, row1, 10e18);
            list[1] = Row(1, row2, 20e18);
            _setupWith(list, pool_);
        }
        b = _join(alice, 650_000e6);
        _revenue(carol, 100_000e6);
        _warp(UNIT); // outside money arrives over a time unit
        if (windDown_) {
            vm.prank(founder);
            t.windDown();
            _warp(UNIT + 1);
            v.burnUngrantedAfterWindDown();
        }
        t.settle();
        uint256 pot = t.pot();
        uint256 paidIn = t.paidIn();
        uint256 s = pot - paidIn;
        assertGt(s, 0);
        uint256 g = team.totalSupply();
        vm.prank(alice);
        uint256 cash = t.leave(b, 0, alice);
        assertEq(cash, paidIn + Math.mulDiv(s, b, b + g), "the take-out formula");
        bps = (cash - paidIn) * 10_000 / s;
    }

    /// @dev A whole stack with no claim contract bound, and one project launched on it.
    function _plainStack() internal returns (Proj memory) {
        vm.warp(T0);
        clock = T0;
        usd = new QuoteToken();
        parts = new Parts();
        launcher = new Launcher(admin, _platform(UNIT), parts);
        return _launch(founder, "plain", 1000, POOL);
    }

    /// @dev Whether the rows are claimed or not changes nothing for the backers: the pool counts in the Team supply from birth.
    function test_theBackersSplitIsTheSameWhetherTheRowsAreClaimedOrNot() public {
        Row[] memory list = new Row[](1);
        list[0] = Row(0, row1, 100_000_000e18);
        _setupWith(list, 0);
        uint256 n = _join(alice, 1000e6);
        _revenue(carol, 500e6);
        t.settle();
        (uint256 unclaimed,,) = t.quoteTakeOut(alice, n);
        _claim(0);
        _warp(YEAR);
        v.claim(0);
        t.settle();
        (uint256 claimed,,) = t.quoteTakeOut(alice, n);
        // the settle in between moved the allowance a year on a quiet project: compare against a project that did the same
        // without any claim
        _setupWith(list, 0);
        _join(alice, 1000e6);
        _revenue(carol, 500e6);
        t.settle();
        _warp(YEAR);
        t.settle();
        (uint256 noClaim,,) = t.quoteTakeOut(alice, n);
        assertEq(claimed, noClaim, "a claim changes nothing for backers");
        assertGt(unclaimed, 0);
    }
}
