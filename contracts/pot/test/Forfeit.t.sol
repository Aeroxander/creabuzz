// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {StackBase, Proj} from "./helpers/StackBase.sol";
import {Treasury} from "../src/Treasury.sol";
import {Vester} from "../src/Vester.sol";
import {Pair} from "../src/Pair.sol";
import {ShareToken} from "../src/ShareToken.sol";

/// @notice Forfeits through the real stack: only the member's own exit, or both signers of a Pair after a public notice of
/// one time unit. The unvested part joins the burn queue Z at once, every join is priced as if it had burned, and it burns
/// only at the end of the notice. Only a holder's own leave, or the Vester's own announced Shares, ever burn.
contract ForfeitTest is StackBase {
    uint256 internal constant AMOUNT = 1_040_000e18;

    // ---- own exit

    function test_aMemberLeavingKeepsWhatHasAccruedAndTheRestJoinsTheBurnQueue() public {
        uint256 id = _grant(alice, AMOUNT);
        _active(5 * UNIT); // before the cliff: accrued 50,000, vested 0
        uint256 g = team.totalSupply();
        vm.prank(alice);
        v.announceForfeit(id);
        assertEq(v.grantOf(id).total, 50_000e18);
        assertEq(t.Z(), 990_000e18, "announced to burn at once");
        assertEq(team.totalSupply(), g, "G still counts them: nothing has burned");
        assertEq(v.claim(id), 50_000e18, "what stays is claimable at once");
    }

    function test_aStrangerCannotForfeitAMember() public {
        uint256 id = _grant(alice, AMOUNT);
        vm.prank(stranger);
        vm.expectRevert(Vester.NotAllowed.selector);
        v.announceForfeit(id);
        vm.prank(stranger);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.announceForfeit(id);
        vm.prank(stranger);
        vm.expectRevert(Vester.NotAllowed.selector);
        v.announceByRunner(id);
    }

    // ---- both signers

    function test_aSingleRunnerAloneCannotForfeit() public {
        uint256 id = _grant(alice, AMOUNT);
        vm.prank(founder);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.announceForfeit(id);
        assertEq(t.Z(), 0);
    }

    function test_bothSignersForfeitAndTheMemberKeepsWhatHasVested() public {
        Pair pair = _makePair(bob);
        // the Pair grants only through both signers
        _both(pair, founder, bob, abi.encodeCall(Treasury.grantTeam, (alice, AMOUNT)));
        _active(13 * UNIT + 1);
        uint256 vested = v.vestedOf(0);
        assertGt(vested, 0);
        _both(pair, bob, founder, abi.encodeCall(Treasury.announceForfeit, (0)));
        assertEq(v.grantOf(0).total, vested, "keeps what has vested, the cliff counted");
        assertEq(t.Z(), AMOUNT - vested);
    }

    function test_aRunnerAloneThroughTheSeatCannotForfeitEvenWithAPairAround() public {
        Pair pair = _makePair(bob);
        _both(pair, founder, bob, abi.encodeCall(Treasury.grantTeam, (alice, AMOUNT)));
        // the Pair itself, outside a confirmed proposal, is not both signers
        vm.prank(address(pair));
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.announceForfeit(0);
        // a single signer cannot make the Pair do it: confirming their own proposal is refused
        bytes memory data = abi.encodeCall(Treasury.announceForfeit, (0));
        uint256 n = pair.nonce();
        vm.prank(founder);
        pair.propose(address(t), data);
        vm.prank(founder);
        vm.expectRevert(Pair.NotAllowed.selector);
        pair.confirm(address(t), data, n);
        assertEq(t.Z(), 0);
    }

    // ---- the burn queue is priced into every join

    function _twin(bytes32 id) internal returns (Proj memory p) {
        p = _launch(founder, id, 0, POOL);
        vm.prank(founder);
        p.t.grantTeam(alice, AMOUNT);
        _joinIn(p.t, bob, 10_000e6);
    }

    function test_aForfeitsJoinPriceCountsItAsBurned() public {
        Proj memory announced = _twin("a");
        Proj memory burned = _twin("b");
        Proj memory none = _twin("c");
        // surplus above paid-in so that Team Shares weigh on the price
        _use(announced);
        _revenue(carol, 5000e6);
        _use(burned);
        _revenue(carol, 5000e6);
        _use(none);
        _revenue(carol, 5000e6);
        vm.warp(block.timestamp + UNIT);
        for (uint256 i; i < 3; ++i) {
            Proj memory p = i == 0 ? announced : (i == 1 ? burned : none);
            _use(p);
            _checkIn();
        }
        vm.prank(alice);
        announced.v.announceForfeit(0);
        vm.prank(alice);
        burned.v.announceForfeit(0);
        // not burned yet: priced as if it had been
        (uint256 priceAnnounced,,,) = announced.t.quoteBack(1000e6);
        vm.warp(block.timestamp + UNIT);
        burned.v.execute(0);
        for (uint256 i; i < 3; ++i) {
            _use(i == 0 ? announced : (i == 1 ? burned : none));
            _checkIn();
        }
        assertEq(burned.t.Z(), 0);
        assertEq(announced.t.Z(), announced.v.grantOf(0).burn);
        assertGt(announced.t.Z(), 0);
        (uint256 priceBurned,,,) = burned.t.quoteBack(1000e6);
        (uint256 priceNone,,,) = none.t.quoteBack(1000e6);
        assertEq(priceAnnounced, priceBurned, "announced is priced exactly as burned");
        assertTrue(priceAnnounced != priceNone, "and not as if it were still there");
        assertLt(priceAnnounced, priceNone, "fewer Team Shares weigh on the price: a Share costs more, so fewer come");
    }

    function test_aLeaveStillCountsTheAnnouncedSharesUntilTheyBurn() public {
        Proj memory p = _twin("d");
        _use(p);
        _revenue(carol, 5000e6);
        vm.warp(block.timestamp + UNIT);
        _checkIn();
        uint256 before = t.leaveValue();
        vm.prank(alice);
        v.announceForfeit(0);
        assertEq(t.leaveValue(), before, "a leave pays on all of G until the burn");
        vm.warp(block.timestamp + UNIT);
        v.execute(0);
        assertGt(t.leaveValue(), before, "after the burn every holder's slice of the surplus is larger");
    }

    // ---- the notice

    function test_theBurnComesOnlyAtTheEndOfTheNotice() public {
        uint256 id = _grant(alice, AMOUNT);
        _active(5 * UNIT);
        vm.prank(alice);
        v.announceForfeit(id);
        uint256 at = block.timestamp + UNIT;
        vm.warp(at - 1);
        vm.expectRevert(abi.encodeWithSelector(Vester.NotYet.selector, at));
        v.execute(id);
        assertEq(t.Z(), 990_000e18);
        vm.warp(at);
        uint256 g = team.totalSupply();
        vm.prank(stranger);
        v.execute(id);
        assertEq(team.totalSupply(), g - 990_000e18, "G falls");
        assertEq(t.Z(), 0);
    }

    // ---- who may burn

    function test_onlyTheTreasuryMintsOrBurnsAndNobodyBurnsAnothersShares() public {
        _join(alice, 10_000e6);
        _grant(bob, 1000e18);
        address[4] memory callers = [founder, address(v), stranger, alice];
        for (uint256 i; i < callers.length; ++i) {
            vm.startPrank(callers[i]);
            vm.expectRevert(ShareToken.NotController.selector);
            shares.burnFor(alice, 1);
            vm.expectRevert(ShareToken.NotController.selector);
            team.burnFor(address(v), 1);
            vm.expectRevert(ShareToken.NotController.selector);
            shares.mint(callers[i], 1);
            vm.expectRevert(ShareToken.NotController.selector);
            team.mint(callers[i], 1);
            vm.stopPrank();
        }
        // the Treasury's burn hooks answer to the Vester alone
        address[3] memory others = [founder, stranger, alice];
        for (uint256 i; i < others.length; ++i) {
            vm.startPrank(others[i]);
            vm.expectRevert(Treasury.NotAllowed.selector);
            t.forfeitAnnounced(1);
            vm.expectRevert(Treasury.NotAllowed.selector);
            t.forfeitBurn(1);
            vm.expectRevert(Treasury.NotAllowed.selector);
            t.burnAfterWindDown(1);
            vm.stopPrank();
        }
        (bool ok1,) = address(shares).call(abi.encodeWithSignature("burn(uint256)", 1));
        (bool ok2,) = address(team).call(abi.encodeWithSignature("burnFrom(address,uint256)", alice, 1));
        assertFalse(ok1);
        assertFalse(ok2);
    }

    function test_theVestersBurnReachesOnlyItsOwnAnnouncedShares() public {
        uint256 id = _grant(alice, AMOUNT);
        _active(5 * UNIT);
        vm.prank(alice);
        v.announceForfeit(id);
        v.claim(id); // alice holds 50,000 in hands
        vm.warp(block.timestamp + UNIT);
        v.execute(id);
        assertEq(team.balanceOf(alice), 50_000e18, "the member's own Shares are never burned");
        assertEq(team.balanceOf(address(v)), POOL - 50_000e18 - 990_000e18);
    }

    // ---- the hand-over trim

    function test_aHandOverThatTrimsTheFounderRunsTheOwnExitOnEveryGrant() public {
        for (uint256 i; i < 8; ++i) {
            _grant(founder, 100_000e18);
        }
        _grant(alice, 100_000e18);
        _active(26 * UNIT);
        vm.prank(founder);
        t.handOver(bob, true);
        assertEq(t.Z(), 0, "nothing moves until the seat is taken");
        vm.prank(bob);
        t.takeSeat();
        uint256 keptEach = 100_000e18 * 26 / 104;
        assertEq(t.Z(), 8 * (100_000e18 - keptEach), "the founder keeps what accrued, the rest is announced");
        for (uint256 i; i < 8; ++i) {
            assertEq(v.grantOf(i).total, keptEach);
        }
        assertEq(uint8(v.grantOf(8).state), uint8(Vester.State.Live), "another member's grant is not trimmed");
    }

    function test_aHandOverWithoutTheTrimLeavesTheFoundersGrants() public {
        _grant(founder, 100_000e18);
        _active(26 * UNIT);
        vm.prank(founder);
        t.handOver(bob, false);
        vm.prank(bob);
        t.takeSeat();
        assertEq(t.Z(), 0);
        assertEq(v.grantOf(0).total, 100_000e18);
    }

    function test_aPairSecondSignerTakingTheSeatCanTrimTheFounder() public {
        _grant(founder, 100_000e18);
        _active(26 * UNIT);
        address predicted = launcher.pairAddress(key, founder, bob);
        vm.prank(founder);
        t.handOver(predicted, true);
        vm.prank(bob);
        launcher.makePair(key, founder);
        assertEq(t.Z(), 75_000e18);
    }

    function test_onlyTheFounderCanOfferATrim() public {
        vm.prank(founder);
        t.handOver(bob, false);
        vm.prank(bob);
        t.takeSeat();
        vm.prank(bob);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.handOver(carol, true);
    }

    function test_theTrimCannotBeRepeatedOrTouchAnnouncedGrants() public {
        uint256 id = _grant(founder, 100_000e18);
        _active(26 * UNIT);
        vm.prank(founder);
        v.announceForfeit(id);
        uint256 z = t.Z();
        vm.prank(founder);
        t.handOver(bob, true);
        vm.prank(bob);
        t.takeSeat();
        assertEq(t.Z(), z, "an announced grant is skipped");
    }
}
