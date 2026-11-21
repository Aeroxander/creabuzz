// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Clones} from "oz5/proxy/Clones.sol";
import {IShares, ITreasuryClock} from "../src/Interfaces.sol";
import {ShareToken} from "../src/ShareToken.sol";
import {Vester} from "../src/Vester.sol";
import {Math} from "oz5/utils/math/Math.sol";
import {EarlierBase, Row} from "./helpers/EarlierBase.sol";
import {EarlierGrants} from "../src/EarlierGrants.sol";
import {MockClock} from "./helpers/MockClock.sol";

/// @notice The Vester's side of the earlier backers' grants: the reserve, the protected grant out of it, the two counters that
/// keep the runner from locking a listed account out of its claim (the review's blocker B1), calendar vesting from the
/// project's birth, and everything a protected grant survives. The ordinary path is checked to be unchanged.
contract EarlierVesterTest is EarlierBase {
    uint256 internal constant YEAR = 365 days;

    // ---------------------------------------------------------------- the two counters (B1)

    function test_runnerFillsEightOrdinarySlotsThenTheClaimStillWorks() public {
        for (uint256 i; i < 8; ++i) {
            _grant(row1, 1e18);
        }
        vm.prank(t.runner());
        vm.expectRevert(Vester.TooManyGrants.selector);
        t.grantTeam(row1, 1e18);
        // the listed account's two rows still claim: they are counted apart
        uint256 a = _claim(0);
        uint256 b = _claim(4);
        assertEq(v.grantOf(a).member, row1);
        assertEq(v.grantOf(b).member, row1);
        assertEq(v.idsOf(row1).length, 10);
    }

    function test_ninthProtectedGrantReverts() public {
        Row[] memory list = new Row[](9);
        for (uint256 i; i < 9; ++i) {
            list[i] = Row(i, row1, 10e18);
        }
        _setupWith(list, 0);
        for (uint256 i; i < 8; ++i) {
            _claim(i);
        }
        Row memory r = rows_[8];
        bytes32[] memory p = _proof(8);
        vm.prank(row1);
        vm.expectRevert(Vester.TooManyGrants.selector);
        earlier.claim(r.index, r.amount, p, TEXT);
        assertFalse(earlier.isClaimed(8), "the refused claim marked nothing");
        assertEq(earlier.claimedRows(), 8);
        assertEq(v.earlierReserve(), 10e18, "and took nothing from the reserve");
    }

    function test_ordinaryGrantsAreStillCappedAtEight() public {
        for (uint256 i; i < 8; ++i) {
            _grant(alice, 1e18);
        }
        vm.prank(t.runner());
        vm.expectRevert(Vester.TooManyGrants.selector);
        t.grantTeam(alice, 1e18);
        assertEq(v.MAX_GRANTS_PER_MEMBER(), 8);
        assertEq(v.MAX_PROTECTED_PER_MEMBER(), 8);
    }

    function test_theOrdinaryCountIgnoresProtectedGrants() public {
        Row[] memory list = new Row[](8);
        for (uint256 i; i < 8; ++i) {
            list[i] = Row(i, row1, 10e18);
        }
        _setupWith(list, 0);
        for (uint256 i; i < 8; ++i) {
            _claim(i);
        }
        // eight protected grants, and the runner can still give the same account eight ordinary ones
        for (uint256 i; i < 8; ++i) {
            _grant(row1, 1e18);
        }
        assertEq(v.idsOf(row1).length, 16, "at most 16 in all: the hand-over trim stays bounded");
        vm.prank(t.runner());
        vm.expectRevert(Vester.TooManyGrants.selector);
        t.grantTeam(row1, 1e18);
    }

    // ---------------------------------------------------------------- who may make a protected grant

    function test_onlyTheClaimContractReachesTheReserve() public {
        // a stranger, the Vester itself and the Team token cannot grant at all
        address[3] memory nobody = [stranger, address(v), address(team)];
        for (uint256 i; i < nobody.length; ++i) {
            vm.prank(nobody[i]);
            vm.expectRevert(Vester.NotAllowed.selector);
            v.grant(row1, 10e18, true);
        }
        // the runner's and an agent's grants go through the Treasury, which passes false: never protected, never from the reserve
        vm.prank(t.runner());
        t.grantTeam(row1, 10e18);
        assertFalse(v.grantOf(0).protected_, "the Treasury passes false: no protected grant by any call of it");
        // even if the Treasury asked for a protected grant, it would come out of the ordinary pool on a clock that starts now
        vm.prank(address(t));
        uint256 id = v.grant(row2, 10e18, true);
        assertEq(v.grantOf(id).start, block.timestamp, "from now, not from the birth");
        assertEq(v.earlierReserve(), poolTotal, "and the reserve is untouched");
    }

    function test_aProjectWithoutTheReserveHasNoOneWhoMayMakeOne() public {
        _use(_launch(founder, "plain", 1000, POOL));
        assertEq(v.earlier(), address(0));
        assertEq(v.earlierReserve(), 0);
        assertEq(v.earlierStart(), 0);
        vm.prank(address(0xE));
        vm.expectRevert(Vester.NotAllowed.selector);
        v.grant(row1, 10e18, true);
        vm.prank(address(earlier)); // project zero's claim contract has no say in another project
        vm.expectRevert(Vester.NotAllowed.selector);
        v.grant(row1, 10e18, true);
    }

    function test_theClaimContractIsHeldToTheReserveAndToWholeShares() public {
        vm.startPrank(address(earlier));
        vm.expectRevert(Vester.BadGrant.selector);
        v.grant(address(0), 10e18, true);
        vm.expectRevert(Vester.BadGrant.selector);
        v.grant(row1, 1e18 - 1, true);
        uint256 reserve = v.earlierReserve();
        vm.expectRevert(Vester.NotFunded.selector);
        v.grant(row1, reserve + 1, true);
        // whatever flag it passes, its grant is protected and starts at the birth
        uint256 id = v.grant(row1, reserve, false);
        assertTrue(v.grantOf(id).protected_);
        assertEq(v.grantOf(id).start, v.earlierStart());
        assertEq(v.earlierReserve(), 0);
        vm.expectRevert(Vester.NotFunded.selector);
        v.grant(row2, 1e18, true);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- the reserve

    function test_theReserveIsHeldFromBirthAndKeptOutOfOrdinaryGrants() public {
        assertEq(v.earlierReserve(), poolTotal);
        assertEq(team.balanceOf(address(v)), POOL + poolTotal);
        assertEq(team.totalSupply(), POOL + poolTotal);
        assertEq(v.committed(), 0, "the reserve is not committed");
        // the runner grants the whole ordinary pool; the next grant cannot touch the reserve
        _grant(alice, POOL);
        vm.prank(t.runner());
        vm.expectRevert(Vester.NotFunded.selector);
        t.grantTeam(bob, 1e18);
        assertEq(v.earlierReserve(), poolTotal, "untouched");
        // and the claims still work
        _claim(0);
        assertEq(v.committed(), POOL + rows_[0].amount);
        assertEq(v.earlierReserve(), poolTotal - rows_[0].amount);
    }

    function test_anAgentsLimitIsNotEnlargedByTheReserve() public {
        assertEq(uint256(t.agentTeam()), POOL / 1000);
    }

    function test_aGrantMovesItsAmountOutOfTheReserveIntoCommitted() public {
        uint256 total0 = v.committed() + v.earlierReserve();
        _claim(1);
        assertEq(v.committed() + v.earlierReserve(), total0, "the sum does not move");
        assertEq(v.committed(), rows_[1].amount);
    }

    // ---------------------------------------------------------------- calendar vesting from birth

    function test_vestingIsCalendarTimeFromTheProjectsBirthWithNoCliff() public {
        uint256 id = _claim(0);
        uint256 total = rows_[0].amount;
        assertEq(v.vestedOf(id), 0, "nothing at birth");
        _warp(1 days);
        assertEq(v.vestedOf(id), Math.mulDiv(total, 1 days, YEAR), "no cliff: a day vests a day");
        _warp(YEAR / 2 - 1 days);
        assertEq(v.vestedOf(id), Math.mulDiv(total, YEAR / 2, YEAR), "about half at day 182");
        _warp(YEAR / 2);
        assertEq(v.vestedOf(id), total, "all of it at day 365");
        _warp(1000 days);
        assertEq(v.vestedOf(id), total, "and no more");
    }

    function test_theClockIsTheSameWhenYouClaimLate() public {
        _warp(100 days);
        uint256 id = _claim(1);
        Vester.Grant memory g = v.grantOf(id);
        assertEq(g.start, v.earlierStart(), "from birth, not from the claim");
        assertEq(v.vestedOf(id), Math.mulDiv(rows_[1].amount, 100 days, YEAR), "100 days are already vested");
        uint256 late = _claim(2);
        _warp(300 days); // day 400
        assertEq(v.vestedOf(late), rows_[2].amount, "fully vested");
        assertEq(v.vestedOf(id), rows_[1].amount);
    }

    function test_aClaimantWhoCameAfterAYearHasItAllAtOnce() public {
        _warp(400 days);
        uint256 id = _claim(0);
        assertEq(v.vestedOf(id), rows_[0].amount);
        v.claim(id);
        assertEq(team.balanceOf(row1), rows_[0].amount);
    }

    function test_vestedSharesAreSentInPartsAndAnyoneMaySendThem() public {
        uint256 id = _claim(0);
        _warp(73 days); // a fifth of the year
        uint256 part = Math.mulDiv(rows_[0].amount, 73 days, YEAR);
        vm.prank(stranger);
        assertEq(v.claim(id), part, "anyone may call it");
        assertEq(team.balanceOf(row1), part, "the Shares go to the member");
        assertEq(v.claimable(id), 0);
        _warp(73 days);
        vm.prank(stranger);
        v.claim(id);
        assertEq(team.balanceOf(row1), Math.mulDiv(rows_[0].amount, 146 days, YEAR));
    }

    function test_vestingDoesNotStopWhenTheProjectGoesQuiet() public {
        // no check-in for the whole year: an ordinary grant would have stopped vesting, a protected one does not
        uint256 id = _claim(0);
        _warp(YEAR);
        assertEq(v.vestedOf(id), rows_[0].amount);
    }

    function test_theGrantEventSaysProtectedAndStartsAtBirth() public {
        _warp(5 days);
        Row memory r = rows_[2];
        bytes32[] memory p = _proof(2);
        vm.expectEmit(true, true, false, true, address(v));
        emit Vester.GrantMade(0, row3, r.amount, v.earlierStart(), 1);
        vm.prank(row3);
        earlier.claim(r.index, r.amount, p, TEXT);
    }

    // ---------------------------------------------------------------- what a protected grant survives

    function test_protectedGrantsSurviveForfeitsTheTrimAndTheWindDownBurns() public {
        uint256 id = _claim(0);
        uint256 ord = _grant(row1, 5e18);
        // the member's own exit and the pair's both-signers announce are refused for it
        vm.prank(row1);
        vm.expectRevert(Vester.ProtectedGrant.selector);
        v.announceForfeit(id);
        vm.prank(address(t));
        vm.expectRevert(Vester.ProtectedGrant.selector);
        v.announceByRunner(id);
        // the hand-over trim announces the ordinary grant and skips the protected one
        vm.prank(address(t));
        v.exitAll(row1);
        assertEq(uint8(v.grantOf(id).state), uint8(Vester.State.Live));
        assertEq(v.grantOf(id).total, rows_[0].amount);
        assertEq(uint8(v.grantOf(ord).state), uint8(Vester.State.Announced), "the ordinary grant is trimmed");
        // a wind-down: the burn of a protected grant is refused, the ungranted burn leaves the reserve
        vm.prank(founder);
        t.windDown();
        _warp(UNIT + 1);
        vm.expectRevert(Vester.ProtectedGrant.selector);
        v.burnAfterWindDown(id);
        uint256 committed = v.committed();
        uint256 reserve = v.earlierReserve();
        uint256 burned = v.burnUngrantedAfterWindDown();
        assertEq(burned, POOL - 5e18, "the ordinary ungranted pool burns");
        assertEq(team.balanceOf(address(v)), committed + reserve, "the reserve and what is promised stay");
        assertEq(v.earlierReserve(), reserve, "the reserve is never burned");
        vm.expectRevert(Vester.NothingToBurn.selector);
        v.burnUngrantedAfterWindDown();
        // and the protected grant still vests to the end
        _warp(YEAR);
        assertEq(v.vestedOf(id), rows_[0].amount);
    }

    function test_theUngrantedBurnNeverTouchesTheReserveEvenWithNothingElseToBurn() public {
        _grant(alice, POOL); // the ordinary pool is all granted
        vm.prank(founder);
        t.windDown();
        _warp(UNIT + 1);
        vm.expectRevert(Vester.NothingToBurn.selector);
        v.burnUngrantedAfterWindDown();
        assertEq(team.balanceOf(address(v)), POOL + poolTotal);
    }

    // ---------------------------------------------------------------- birth of the Vester itself

    function test_initializeWithEarlierOnceAndOnlyWithTheFundedAmount() public {
        MockClock clk = new MockClock();
        ShareToken tImpl = new ShareToken();
        Vester vImpl = new Vester();
        ShareToken tm = ShareToken(Clones.clone(address(tImpl)));
        Vester vs = Vester(Clones.clone(address(vImpl)));
        tm.initialize("Team", "TEAM", address(clk), address(vs), 150e18); // 100 ordinary and 50 earlier
        clk.setToken(tm);
        ITreasuryClock c = ITreasuryClock(address(clk));
        // the amount held must be exactly pool plus earlier pool
        vm.expectRevert(Vester.NotFunded.selector);
        vs.initializeWithEarlier(c, IShares(address(tm)), 100e18, address(earlier), 51e18);
        vm.expectRevert(Vester.NotFunded.selector);
        vs.initializeWithEarlier(c, IShares(address(tm)), 100e18, address(earlier), 49e18);
        // the earlier address and pool are not zero
        vm.expectRevert(Vester.BadGrant.selector);
        vs.initializeWithEarlier(c, IShares(address(tm)), 100e18, address(0), 50e18);
        vm.expectRevert(Vester.BadGrant.selector);
        vs.initializeWithEarlier(c, IShares(address(tm)), 150e18, address(earlier), 0);
        // the same checks as `initialize`
        vm.expectRevert(Vester.BadGrant.selector);
        vs.initializeWithEarlier(ITreasuryClock(stranger), IShares(address(tm)), 100e18, address(earlier), 50e18);
        vm.expectRevert(Vester.BadGrant.selector);
        vs.initializeWithEarlier(ITreasuryClock(address(0)), IShares(address(tm)), 100e18, address(earlier), 50e18);
        vm.warp(T0 + 7);
        vs.initializeWithEarlier(c, IShares(address(tm)), 100e18, address(earlier), 50e18);
        assertEq(vs.earlier(), address(earlier));
        assertEq(vs.earlierReserve(), 50e18);
        assertEq(vs.earlierStart(), T0 + 7, "the birth");
        // once, by either door
        vm.expectRevert(Vester.AlreadyInitialized.selector);
        vs.initializeWithEarlier(c, IShares(address(tm)), 100e18, address(earlier), 50e18);
        vm.expectRevert(Vester.AlreadyInitialized.selector);
        vs.initialize(c, IShares(address(tm)), 150e18);
        // the copy the clones point at is locked for both
        vm.expectRevert(Vester.AlreadyInitialized.selector);
        vImpl.initializeWithEarlier(c, IShares(address(tm)), 100e18, address(earlier), 50e18);
    }

    function test_theOrdinaryInitializeLeavesTheEarlierFieldsEmpty() public {
        MockClock clk = new MockClock();
        ShareToken tImpl = new ShareToken();
        Vester vImpl = new Vester();
        ShareToken tm = ShareToken(Clones.clone(address(tImpl)));
        Vester vs = Vester(Clones.clone(address(vImpl)));
        tm.initialize("Team", "TEAM", address(clk), address(vs), 100e18);
        vs.initialize(ITreasuryClock(address(clk)), IShares(address(tm)), 100e18);
        assertEq(vs.earlier(), address(0));
        assertEq(vs.earlierReserve(), 0);
        assertEq(vs.earlierStart(), 0);
    }

    // ---------------------------------------------------------------- fuzz: the ordinary path with a reserve

    /// @dev Whatever the runner grants, the reserve and the promised amounts never exceed what the Vester holds.
    function testFuzz_ordinaryGrantsNeverReachTheReserve(uint256 a, uint256 b, uint256 c) public {
        a = bound(a, 1e18, POOL);
        b = bound(b, 1e18, POOL);
        c = bound(c, 1e18, POOL);
        uint256[3] memory amounts = [a, b, c];
        for (uint256 i; i < 3; ++i) {
            vm.prank(t.runner());
            try t.grantTeam(alice, amounts[i]) {} catch {}
            assertGe(team.balanceOf(address(v)), v.committed() + v.earlierReserve(), "the reserve is out of reach");
            assertLe(v.committed(), POOL, "ordinary grants never pass the ordinary pool");
            assertEq(v.earlierReserve(), poolTotal);
        }
    }
}
