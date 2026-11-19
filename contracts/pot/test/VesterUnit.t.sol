// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Clones} from "oz5/proxy/Clones.sol";
import {IShares, ITreasuryClock} from "../src/Interfaces.sol";
import {ShareToken} from "../src/ShareToken.sol";
import {Vester} from "../src/Vester.sol";
import {MockClock} from "./helpers/MockClock.sol";

/// @notice The Vester on its own, driven by a hand-set clock: the grant bounds, the cliff and linear schedule on active
/// time, claims, the forfeit state machine, protected grants and the wind-down burns.
contract VesterUnitTest is Test {
    uint256 internal constant N = 7 days;
    uint256 internal constant POOL = 1_000_000e18;
    uint256 internal constant T0 = 1_700_000_000;

    MockClock internal clk;
    ShareToken internal team;
    Vester internal v;
    Vester internal vImpl;
    ShareToken internal tImpl;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal stranger = makeAddr("stranger");

    function setUp() public {
        vm.warp(T0);
        clk = new MockClock();
        tImpl = new ShareToken();
        vImpl = new Vester();
        (team, v) = _make(POOL);
    }

    function _make(uint256 pool) internal returns (ShareToken tm, Vester vs) {
        tm = ShareToken(Clones.clone(address(tImpl)));
        vs = Vester(Clones.clone(address(vImpl)));
        tm.initialize("Team", "TEAM", address(clk), address(vs), pool);
        clk.setToken(tm);
        vs.initialize(ITreasuryClock(address(clk)), IShares(address(tm)), pool);
    }

    function _grant(address who, uint256 amount) internal returns (uint256) {
        return clk.callGrant(v, who, amount, false);
    }

    // ---- birth

    function test_initializeOnceAndTheImplementationIsLocked() public {
        vm.expectRevert(Vester.AlreadyInitialized.selector);
        v.initialize(ITreasuryClock(address(clk)), IShares(address(team)), POOL);
        vm.expectRevert(Vester.AlreadyInitialized.selector);
        vImpl.initialize(ITreasuryClock(address(clk)), IShares(address(team)), POOL);
    }

    function test_initializeNeedsTheWholePoolHereAndTheRightController() public {
        ShareToken tm = ShareToken(Clones.clone(address(tImpl)));
        Vester vs = Vester(Clones.clone(address(vImpl)));
        tm.initialize("Team", "TEAM", address(clk), address(vs), 100e18);
        vm.expectRevert(Vester.NotFunded.selector);
        vs.initialize(ITreasuryClock(address(clk)), IShares(address(tm)), 101e18);
        vm.expectRevert(Vester.BadGrant.selector);
        vs.initialize(ITreasuryClock(address(stranger)), IShares(address(tm)), 100e18);
        vm.expectRevert(Vester.BadGrant.selector);
        vs.initialize(ITreasuryClock(address(0)), IShares(address(tm)), 100e18);
        vs.initialize(ITreasuryClock(address(clk)), IShares(address(tm)), 100e18);
    }

    // ---- grants

    function test_onlyTheTreasuryGrants() public {
        vm.prank(stranger);
        vm.expectRevert(Vester.NotAllowed.selector);
        v.grant(alice, 1e18, false);
        vm.prank(alice);
        vm.expectRevert(Vester.NotAllowed.selector);
        v.announceByRunner(0);
        vm.prank(alice);
        vm.expectRevert(Vester.NotAllowed.selector);
        v.exitAll(alice);
    }

    function test_grantRefusesZeroAmountAndZeroMember() public {
        vm.expectRevert(Vester.BadGrant.selector);
        clk.callGrant(v, alice, 0, false);
        vm.expectRevert(Vester.BadGrant.selector);
        clk.callGrant(v, address(0), 1e18, false);
    }

    function test_grantsNeverPassThePool() public {
        _grant(alice, POOL / 2);
        _grant(bob, POOL / 2);
        assertEq(v.committed(), POOL);
        vm.expectRevert(Vester.NotFunded.selector);
        _grant(stranger, 1e18);
    }

    function test_aClaimedShareIsNotGrantedTwice() public {
        uint256 id = _grant(alice, POOL);
        clk.setActive(104 * N);
        v.claim(id);
        assertEq(team.balanceOf(alice), POOL);
        assertEq(v.committed(), 0);
        vm.expectRevert(Vester.NotFunded.selector);
        _grant(bob, 1e18);
    }

    function test_aGrantIsAtLeastOneWholeTeamShare() public {
        vm.expectRevert(Vester.BadGrant.selector);
        _grant(alice, 1e18 - 1);
        _grant(alice, 1e18);
    }

    function test_aMemberHasAtMostEightGrants() public {
        for (uint256 i; i < 8; ++i) {
            _grant(alice, 1e18);
        }
        vm.expectRevert(Vester.TooManyGrants.selector);
        _grant(alice, 1e18);
        _grant(bob, 1e18); // another member is not affected
        assertEq(v.idsOf(alice).length, 8);
        assertEq(v.grantCount(), 9);
    }

    // ---- the schedule: cliff of 13N inside 104N, active time only

    function test_nothingVestsBeforeTheCliffAndTheCliffPaysTheAccrued() public {
        uint256 id = _grant(alice, 1040e18);
        clk.setActive(13 * N - 1);
        assertEq(v.vestedOf(id), 0, "the second before the cliff");
        assertEq(v.accruedOf(id), 1040e18 * (13 * N - 1) / (104 * N), "accrued has no cliff");
        clk.setActive(13 * N);
        assertEq(v.vestedOf(id), 130e18, "13/104 at the cliff");
        clk.setActive(52 * N);
        assertEq(v.vestedOf(id), 520e18);
        clk.setActive(104 * N - 1);
        assertLt(v.vestedOf(id), 1040e18);
        clk.setActive(104 * N);
        assertEq(v.vestedOf(id), 1040e18);
        clk.setActive(500 * N);
        assertEq(v.vestedOf(id), 1040e18, "never more than the grant");
    }

    function test_timePassingWithoutActiveTimeVestsNothing() public {
        uint256 id = _grant(alice, 1040e18);
        clk.setActive(20 * N);
        uint256 before = v.vestedOf(id);
        vm.warp(block.timestamp + 400 * N);
        assertEq(v.vestedOf(id), before, "a quiet project does not vest");
    }

    function test_everyGrantHasAClockOfItsOwn() public {
        clk.setActive(0);
        uint256 a = _grant(alice, 1040e18);
        clk.setActive(10 * N);
        uint256 b = _grant(alice, 1040e18);
        assertEq(v.grantOf(b).start, 10 * N);
        clk.setActive(23 * N); // 13N after the second grant, 23N after the first
        assertEq(v.vestedOf(b), 130e18);
        assertEq(v.vestedOf(a), 1040e18 * 23 / 104);
        clk.setActive(22 * N);
    }

    function testFuzz_vestedIsMonotoneAndBounded(uint256 a1, uint256 a2) public {
        a1 = bound(a1, 0, 300 * N);
        a2 = bound(a2, a1, 300 * N);
        uint256 id = _grant(alice, 777e18 + 13);
        clk.setActive(a1);
        uint256 x = v.vestedOf(id);
        clk.setActive(a2);
        uint256 y = v.vestedOf(id);
        assertLe(x, y);
        assertLe(y, 777e18 + 13);
        assertLe(y, v.accruedOf(id));
    }

    // ---- claim

    function test_claimPaysTheMemberWhoeverCalls() public {
        uint256 id = _grant(alice, 1040e18);
        vm.expectRevert(Vester.NothingToClaim.selector);
        v.claim(id);
        clk.setActive(13 * N);
        vm.prank(stranger);
        assertEq(v.claim(id), 130e18);
        assertEq(team.balanceOf(alice), 130e18);
        assertEq(team.balanceOf(stranger), 0);
        vm.expectRevert(Vester.NothingToClaim.selector);
        v.claim(id);
        clk.setActive(26 * N);
        assertEq(v.claim(id), 260e18 - 130e18);
        assertEq(v.grantOf(id).claimed, 260e18);
    }

    function test_unknownGrantReverts() public {
        vm.expectRevert(Vester.UnknownGrant.selector);
        v.claim(0);
        vm.expectRevert(Vester.UnknownGrant.selector);
        v.vestedOf(5);
        vm.expectRevert(Vester.UnknownGrant.selector);
        v.execute(1);
    }

    // ---- forfeit by the member's own exit

    function test_anOwnExitKeepsTheAccruedPartAndAnnouncesTheRest() public {
        uint256 id = _grant(alice, 1040e18);
        clk.setActive(5 * N); // before the cliff: vested 0, accrued 50
        vm.prank(stranger);
        vm.expectRevert(Vester.NotAllowed.selector);
        v.announceForfeit(id);
        vm.prank(alice);
        v.announceForfeit(id);
        Vester.Grant memory g = v.grantOf(id);
        assertEq(g.total, 50e18, "keeps what accrued, no cliff");
        assertEq(g.burn, 990e18);
        assertEq(uint8(g.state), uint8(Vester.State.Announced));
        assertEq(g.burnAt, block.timestamp + N);
        assertEq(clk.Z(), 990e18, "the Treasury was told");
        assertEq(v.claimable(id), 50e18, "what stays is the member's at once");
        v.claim(id);
        assertEq(team.balanceOf(alice), 50e18);
        clk.setActive(300 * N);
        assertEq(v.vestedOf(id), 50e18, "frozen at the announce");
    }

    function test_theBurnWaitsOneUnitAndAnyoneRunsIt() public {
        uint256 id = _grant(alice, 1040e18);
        clk.setActive(5 * N);
        vm.prank(alice);
        v.announceForfeit(id);
        uint256 at = block.timestamp + N;
        vm.warp(at - 1);
        vm.expectRevert(abi.encodeWithSelector(Vester.NotYet.selector, at));
        v.execute(id);
        vm.warp(at);
        uint256 supply = team.totalSupply();
        vm.prank(stranger);
        v.execute(id);
        assertEq(team.totalSupply(), supply - 990e18, "G falls");
        assertEq(clk.Z(), 0);
        assertEq(v.committed(), 50e18);
        vm.expectRevert(Vester.WrongState.selector);
        v.execute(id);
        vm.prank(alice);
        vm.expectRevert(Vester.WrongState.selector);
        v.announceForfeit(id);
    }

    function test_aGrantAnnouncedTwiceOrNothingToBurnRefused() public {
        uint256 id = _grant(alice, 1040e18);
        clk.setActive(104 * N);
        vm.prank(alice);
        vm.expectRevert(Vester.NothingToBurn.selector);
        v.announceForfeit(id);
    }

    function test_theRunnerPathKeepsOnlyWhatHasVested() public {
        uint256 id = _grant(alice, 1040e18);
        clk.setActive(13 * N - 1);
        clk.callAnnounceByRunner(v, id);
        assertEq(v.grantOf(id).total, 0, "before the cliff nothing has vested: all of it is announced");
        uint256 id2 = _grant(alice, 1040e18);
        clk.setActive(13 * N - 1 + 13 * N);
        clk.callAnnounceByRunner(v, id2);
        assertEq(v.grantOf(id2).total, 130e18, "after the cliff the vested part stays");
        assertEq(v.grantOf(id2).burn, 910e18);
    }

    // ---- the hand-over trim

    function test_exitAllAnnouncesEveryLiveGrantOfTheMember() public {
        uint256 a = _grant(alice, 1040e18);
        uint256 b = _grant(alice, 520e18);
        uint256 other = _grant(bob, 104e18);
        clk.setActive(52 * N);
        clk.callExitAll(v, alice);
        assertEq(uint8(v.grantOf(a).state), uint8(Vester.State.Announced));
        assertEq(uint8(v.grantOf(b).state), uint8(Vester.State.Announced));
        assertEq(v.grantOf(a).total, 520e18, "keeps what accrued");
        assertEq(v.grantOf(b).total, 260e18);
        assertEq(uint8(v.grantOf(other).state), uint8(Vester.State.Live), "another member is not touched");
        assertEq(clk.Z(), 520e18 + 260e18);
    }

    function test_exitAllSkipsAnnouncedFullyAccruedAndProtectedGrants() public {
        uint256 full = _grant(alice, 100e18);
        clk.setActive(104 * N);
        uint256 b = _grant(alice, 520e18);
        uint256 p = clk.callGrant(v, alice, 104e18, true);
        vm.prank(alice);
        v.announceForfeit(b); // announced already: accrued 0 at once, so all of it is announced
        uint256 zBefore = clk.Z();
        clk.callExitAll(v, alice); // nothing is left to announce, and nothing reverts
        assertEq(clk.Z(), zBefore);
        assertEq(uint8(v.grantOf(full).state), uint8(Vester.State.Live), "nothing to burn: skipped");
        assertEq(uint8(v.grantOf(p).state), uint8(Vester.State.Live), "protected is never trimmed");
        clk.callExitAll(v, bob); // a member with no grants
    }

    // ---- protected grants

    function test_aProtectedGrantVestsOnCalendarTimeWithNoCliffAndNeverForfeits() public {
        uint256 id = clk.callGrant(v, alice, 365e18, true);
        assertEq(v.grantOf(id).protected_, true);
        vm.warp(block.timestamp + 100 days);
        assertEq(v.vestedOf(id), 100e18, "no cliff, calendar days, no active time needed");
        assertEq(clk.activeNow(), 0);
        v.claim(id);
        assertEq(team.balanceOf(alice), 100e18);
        vm.warp(block.timestamp + 400 days);
        assertEq(v.vestedOf(id), 365e18);
        // never forfeited: not by the member, not by both signers, not by the trim, not after a wind-down
        vm.prank(alice);
        vm.expectRevert(Vester.ProtectedGrant.selector);
        v.announceForfeit(id);
        vm.expectRevert(Vester.ProtectedGrant.selector);
        clk.callAnnounceByRunner(v, id);
        clk.windDown(2, uint64(block.timestamp));
        vm.warp(block.timestamp + N);
        vm.expectRevert(Vester.ProtectedGrant.selector);
        v.burnAfterWindDown(id);
        assertEq(v.claim(id), 265e18);
    }

    // ---- after a wind-down

    function test_afterAWindDownByChoiceTheAccruedPartStaysAndTheRestBurnsAfterTheNotice() public {
        uint256 id = _grant(alice, 1040e18);
        clk.setActive(5 * N); // accrued 50, vested 0
        vm.expectRevert(Vester.NotWoundDown.selector);
        v.burnAfterWindDown(id);
        clk.windDown(1, uint64(block.timestamp));
        uint256 at = block.timestamp + N;
        vm.warp(at - 1);
        vm.expectRevert(abi.encodeWithSelector(Vester.NotYet.selector, at));
        v.burnAfterWindDown(id);
        vm.warp(at);
        uint256 supply = team.totalSupply();
        vm.prank(stranger);
        v.burnAfterWindDown(id);
        assertEq(v.grantOf(id).total, 50e18, "by choice keeps what accrued");
        assertEq(team.totalSupply(), supply - 990e18);
        assertEq(v.claim(id), 50e18);
        vm.expectRevert(Vester.WrongState.selector);
        v.burnAfterWindDown(id);
    }

    function test_afterAQuietWindDownOnlyTheVestedPartStays() public {
        uint256 early = _grant(alice, 1040e18);
        clk.setActive(5 * N);
        uint256 late = _grant(bob, 1040e18);
        clk.setActive(5 * N + 20 * N); // early: 25N (past the cliff), late: 20N
        clk.windDown(2, uint64(block.timestamp));
        vm.warp(block.timestamp + N);
        v.burnAfterWindDown(early);
        v.burnAfterWindDown(late);
        assertEq(v.grantOf(early).total, 250e18, "25 of 104 had vested");
        assertEq(v.grantOf(late).total, 200e18, "20 of 104 had vested");
    }

    function test_aQuietWindDownBeforeTheCliffKeepsNothingUnvested() public {
        uint256 id = _grant(alice, 1040e18);
        clk.setActive(5 * N);
        clk.windDown(2, uint64(block.timestamp));
        vm.warp(block.timestamp + N);
        v.burnAfterWindDown(id);
        assertEq(v.grantOf(id).total, 0, "before the cliff nothing had vested");
        vm.expectRevert(Vester.NothingToClaim.selector);
        v.claim(id);
    }

    function test_anAnnouncedGrantIsBurnedByExecuteNotByTheWindDownBurn() public {
        uint256 id = _grant(alice, 1040e18);
        clk.setActive(5 * N);
        vm.prank(alice);
        v.announceForfeit(id);
        clk.windDown(1, uint64(block.timestamp));
        vm.warp(block.timestamp + N);
        vm.expectRevert(Vester.WrongState.selector);
        v.burnAfterWindDown(id);
        v.execute(id);
        assertEq(clk.Z(), 0, "Z was kept right");
    }

    function test_theUngrantedPoolBurnsAfterAWindDownAndTheNotice() public {
        _grant(alice, 400_000e18);
        vm.expectRevert(Vester.NotWoundDown.selector);
        v.burnUngrantedAfterWindDown();
        clk.windDown(1, uint64(block.timestamp));
        vm.expectRevert();
        v.burnUngrantedAfterWindDown();
        vm.warp(block.timestamp + N);
        uint256 burned = v.burnUngrantedAfterWindDown();
        assertEq(burned, 600_000e18);
        assertEq(team.balanceOf(address(v)), 400_000e18, "what was granted stays");
        vm.expectRevert(Vester.NothingToBurn.selector);
        v.burnUngrantedAfterWindDown();
    }
}
