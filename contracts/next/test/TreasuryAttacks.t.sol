// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "oz5/token/ERC20/IERC20.sol";
import {Base} from "./helpers/Base.sol";
import {Treasury} from "../src/Treasury.sol";
import {ShareToken} from "../src/ShareToken.sol";
import {Vester} from "../src/Vester.sol";
import {IShares, IVester} from "../src/Interfaces.sol";
import {RollingCap} from "../src/RollingCap.sol";
import {HookAttacker} from "./mocks/HookAttacker.sol";

/// @notice The named attacks of milestone 2. Each one is written so that it fails if the guard it targets is removed
/// (the report lists the guard each test was checked against).
contract TreasuryAttacksTest is Base {
    // ---------------------------------------------------------------------------------- hand back before settle

    function test_attack_handBackBeforeSettle() public {
        _buy(alice, 100_000_000 * SHARE);
        _approveAll(alice);
        // 1. nothing at all has happened
        vm.prank(alice);
        vm.expectRevert(Treasury.NotSettled.selector);
        t.handBack(1_000_000 * SHARE);
        // 2. someone adds "Share revenue" so the floor is not empty, and the sale money has arrived but is not split
        usd.mint(carol, 1_000 * DOLLAR);
        vm.startPrank(carol);
        usd.approve(address(t), 1_000 * DOLLAR);
        t.shareRevenue(1_000 * DOLLAR);
        vm.stopPrank();
        _arrive(7500 * DOLLAR);
        _openPool();
        vm.prank(alice);
        vm.expectRevert(Treasury.NotSettled.selector);
        t.handBack(1_000_000 * SHARE);
        // 3. the moment the sale money is split, the exit opens
        t.settle(7500 * DOLLAR);
        uint256 paid = _handBack(alice, 1_000_000 * SHARE);
        assertGt(paid, 0);
    }

    // ------------------------------------------------------------------------------- hand back the spendable money

    function test_attack_handBackTheSpendableMoney() public {
        _world();
        uint256 a = _handBack(alice, 100_000_000 * SHARE);
        uint256 b = _handBack(bob, 400_000_000 * SHARE); // every holder leaves
        assertEq(t.countingSupply(), 0);
        assertEq(t.spendable(), S, "the spendable bucket is untouched by every exit");
        assertEq(a + b + t.feesOwed() + t.melting(), M, "everything paid came out of the 6,000 floor and nothing else");
        assertGe(usd.balanceOf(address(t)), S + t.feesOwed() + t.melting());
        // and a second wave of exits finds nothing to burn Shares for
        vm.prank(carol);
        vm.expectRevert();
        t.handBack(1);
    }

    // -------------------------------------------------------------------------------------- double initialise

    function test_attack_doubleInitialiseAClone() public {
        Treasury.Setup memory evil = Treasury.Setup({
            quote: IERC20(address(usd)),
            shares: IShares(address(shares)),
            vester: IVester(address(v)),
            founder: carol,
            platform: carol,
            opener: carol,
            salePath: carol,
            exitFeeBps: 0,
            platformFeeBps: 0,
            spendableParts: 1,
            floorParts: 1,
            agentUsd: 0,
            agentShares: 0,
            workPot: 0
        });
        address[] memory to = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        to[0] = carol;
        amounts[0] = SUPPLY;
        vm.startPrank(carol);
        vm.expectRevert(Treasury.BadSetup.selector);
        t.initialize(evil);
        vm.expectRevert(Vester.AlreadyInitialized.selector);
        v.initialize(IShares(address(shares)), carol, carol, carol, 1);
        vm.expectRevert(ShareToken.BadBirth.selector);
        shares.initialize("Mine", "MINE", to, amounts);
        vm.stopPrank();
        assertEq(t.founder(), founder);
        assertEq(shares.totalSupply(), SUPPLY);
    }

    // ----------------------------------------------------------------------------- agent splits its calls

    function test_attack_anAgentSplitsCallsToPassItsDailyDollarCap() public {
        _sale(7500 * DOLLAR);
        vm.prank(founder);
        t.authoriseAgent(agent); // 25 dollars a day
        vm.startPrank(agent);
        for (uint256 i; i < 100; ++i) {
            t.spend(carol, DOLLAR / 4); // 100 calls of 25 cents
        }
        vm.expectRevert();
        t.spend(carol, 1);
        // many different recipients do not help either
        for (uint256 i; i < 5; ++i) {
            vm.expectRevert();
            t.spend(address(uint160(0x1000 + i)), 1);
        }
        // it cannot raise its own cap, or switch itself back on after being revoked
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.setAgent(agent, type(uint128).max, type(uint128).max);
        vm.stopPrank();
        assertEq(usd.balanceOf(carol), 25 * DOLLAR);
        // revoked and re-authorised by the founder: what it used still counts
        vm.startPrank(founder);
        t.revokeAgent(agent);
        t.authoriseAgent(agent);
        vm.stopPrank();
        vm.prank(agent);
        vm.expectRevert();
        t.spend(carol, 1);
    }

    function test_attack_anAgentSplitsCallsToPassItsDailyShareCap() public {
        vm.prank(founder);
        t.authoriseAgent(agent); // 1,000,000 Shares a day
        vm.startPrank(agent);
        for (uint256 i; i < 10; ++i) {
            t.giveShares(address(uint160(0x2000 + i)), 100_000 * SHARE);
        }
        vm.expectRevert();
        t.giveShares(carol, 1);
        vm.stopPrank();
    }

    // --------------------------------------------------------------- monthly gift cap through many recipients

    function test_attack_aGiftOverTheMonthlyCapThroughSeveralRecipients() public {
        _world();
        vm.prank(founder);
        t.setAgent(agent, type(uint128).max, type(uint128).max); // the runner lifted the agent's own caps entirely
        // ten recipients, one million each, by two different givers: the project's 1% (10,000,000) is shared by all
        for (uint256 i; i < 5; ++i) {
            vm.prank(founder);
            t.giveShares(address(uint160(0x3000 + i)), 1_000_000 * SHARE);
            vm.prank(agent);
            t.giveShares(address(uint160(0x4000 + i)), 1_000_000 * SHARE);
        }
        assertEq(t.giftsUsed(), 10_000_000 * SHARE);
        vm.prank(founder);
        vm.expectRevert();
        t.giveShares(address(uint160(0x5000)), 1);
        vm.prank(agent);
        vm.expectRevert();
        t.giveShares(address(uint160(0x5001)), 1);
        // many tiny gifts do not get around it either
        vm.prank(founder);
        vm.expectRevert();
        t.giveShares(address(uint160(0x5002)), 1);
    }

    // ---------------------------------------------------------------------------------- founder dump at pool open

    function test_attack_aFounderDumpAtPoolOpen() public {
        // before the pool the founder gives the whole work pot to a puppet account he controls
        address puppet = makeAddr("puppet");
        vm.prank(founder);
        t.giveShares(puppet, 200_000_000 * SHARE);
        assertEq(shares.balanceOf(puppet), 0, "not in the puppet's hands");
        _world(); // the pool opens and the sale money is split
        // at the first second nothing can be claimed or handed back, by the founder or the puppet
        assertEq(v.claim(founder), 0);
        assertEq(v.claim(puppet), 0);
        assertEq(shares.balanceOf(founder) + shares.balanceOf(puppet), 0);
        assertEq(t.countingSupply(), 500_000_000 * SHARE, "400M in the Vester and 100M in the Treasury never count");
        vm.startPrank(founder);
        shares.approve(address(t), type(uint256).max);
        vm.expectRevert(ShareToken.InsufficientBalance.selector);
        t.handBack(1 * SHARE);
        vm.stopPrank();
        // the Vester has no way to send Shares anywhere but to the beneficiary, on schedule
        vm.prank(address(t)); // even the real granter, the Treasury, cannot add to the schedule once it has started
        vm.expectRevert(Vester.WrongPhase.selector);
        v.grant(founder, 1);
        // after one day 1/365 of 400M is free: that is all that can be handed back
        vm.warp(_now() + 1 days);
        v.claim(founder);
        v.claim(puppet);
        uint256 freed = shares.balanceOf(founder) + shares.balanceOf(puppet);
        assertApproxEqAbs(freed, 400_000_000 * SHARE / 365, 2); // two grants, each rounded down
        // the floor those Shares can reach is their slice of the floor after one day's release
        uint256 floorNow = t.melting() - t.pendingRelease();
        uint256 before = usd.balanceOf(founder) + usd.balanceOf(puppet);
        vm.prank(founder);
        t.checkIn();
        vm.startPrank(puppet);
        shares.approve(address(t), type(uint256).max);
        t.handBack(shares.balanceOf(puppet));
        vm.stopPrank();
        vm.startPrank(founder);
        t.handBack(shares.balanceOf(founder));
        vm.stopPrank();
        uint256 got = usd.balanceOf(founder) + usd.balanceOf(puppet) - before;
        assertLe(got, floorNow * freed / (500_000_000 * SHARE) * 95 / 100 + DOLLAR, "bounded by the released slice");
        assertLt(got, M / 300, "under a third of one percent of the floor on day one");
    }

    function test_attack_aFounderDumpAfterPoolOpenIsCappedAtOnePercentAMonth() public {
        _world();
        address puppet = makeAddr("puppet");
        vm.startPrank(founder);
        t.giveShares(puppet, 10_000_000 * SHARE); // the most a month allows
        vm.expectRevert();
        t.giveShares(puppet, 1);
        vm.stopPrank();
        assertEq(shares.balanceOf(puppet), 10_000_000 * SHARE);
        vm.startPrank(puppet);
        shares.approve(address(t), type(uint256).max);
        uint256 paid = t.handBack(10_000_000 * SHARE);
        vm.stopPrank();
        // 10M of 510M counting Shares of a 6,000 dollar floor, less the 5% fee
        assertEq(paid, 6000 * DOLLAR * 10_000_000 / 510_000_000 * 95 / 100);
        assertLt(paid, M * 2 / 100);
    }

    // --------------------------------------------------------------- inflating the floor then exiting around it

    function test_attack_aRawDonationOfDollarsDoesNotRaiseAnyonesExit() public {
        _world();
        usd.mint(address(t), 100_000 * DOLLAR); // a stranger (or the attacker) sends dollars straight in
        assertEq(t.countingSupply(), 500_000_000 * SHARE);
        uint256 paid = _handBack(alice, 100_000_000 * SHARE);
        assertEq(paid, 1140 * DOLLAR, "the exit pays exactly what it paid with no donation");
        assertEq(t.unaccounted(), 100_000 * DOLLAR, "the donation is still outside every bucket");
    }

    function test_attack_donateThenSettleThenExitLosesMoney() public {
        _world();
        uint256 donation = 10_000 * DOLLAR;
        usd.mint(alice, donation);
        // alice gives dollars to the Treasury, anyone splits them, alice exits
        vm.prank(alice);
        usd.transfer(address(t), donation);
        t.settle(donation);
        uint256 paid = _handBack(alice, 100_000_000 * SHARE);
        assertLt(paid, donation + 1140 * DOLLAR, "a donation never comes back as a larger exit");
        assertEq(paid, (M + donation * 4 / 5) / 5 * 95 / 100);
        assertLt(paid - 1140 * DOLLAR, donation, "her gain from the extra floor is under what she put in");
    }

    /// forge-config: default.fuzz.runs = 2000
    function testFuzz_attack_payingIntoTheFloorThenExitingNeverProfits(uint256 donation, uint256 holding) public {
        _world();
        donation = bound(donation, 1, 1_000_000_000_000 * DOLLAR);
        holding = bound(holding, 1, 500_000_000 * SHARE);
        // the attacker is every counting Share holder in turn: the best case for the attacker is owning them all
        address attacker = makeAddr("attacker");
        vm.prank(alice);
        shares.transfer(attacker, 100_000_000 * SHARE);
        vm.prank(bob);
        shares.transfer(attacker, 400_000_000 * SHARE);
        _approveAll(attacker);
        uint256 held = holding;
        usd.mint(attacker, donation);
        vm.startPrank(attacker);
        usd.approve(address(t), donation);
        uint256 payWithout = _quote(held);
        t.shareRevenue(donation);
        uint256 paid;
        try t.handBack(held) returns (uint256 p) {
            paid = p;
        } catch {
            return; // too small to pay anything: nothing was burned
        }
        vm.stopPrank();
        assertLe(paid, payWithout + donation * 95 / 100 + 1, "the donation comes back at most at 95 percent");
        assertLe(paid, payWithout + donation, "so the attacker never comes out ahead");
    }

    /// @dev What `handBack(amount)` would pay now, worked out here from the written rule.
    function _quote(uint256 amount) internal view returns (uint256) {
        uint256 slice = (t.melting() + t.permanentFloor()) * amount / t.countingSupply();
        return slice - (slice * 500 + 9999) / 10_000;
    }

    // ------------------------------------------------------------------------------------ Shares donations

    /// forge-config: default.fuzz.runs = 2000
    function testFuzz_attack_donatingSharesToTheProjectNeverPaysTheDonor(uint256 donated) public {
        _world();
        donated = bound(donated, 1, 100_000_000 * SHARE - 1);
        uint256 honest = _quote(100_000_000 * SHARE);
        vm.prank(alice);
        shares.transfer(address(t), donated); // a donation to the Treasury (counted as reserve, never as holders')
        uint256 rest = 100_000_000 * SHARE - donated;
        uint256 afterDonation = _quote(rest);
        assertLe(afterDonation, honest, "donating then exiting the rest pays no more than just exiting everything");
        // the same through the Vester
        vm.prank(bob);
        shares.transfer(address(v), donated);
        assertEq(t.countingSupply(), 500_000_000 * SHARE - 2 * donated);
    }

    function test_attack_vesterAndTreasurySharesNeverEnterTheExitDenominator() public {
        _world();
        // 200M in the Vester and 300M in the Treasury; counting 500M gives alice's 100M exactly 1,140 dollars
        assertEq(_handBack(alice, 100_000_000 * SHARE), 1140 * DOLLAR);
    }

    // ----------------------------------------------------------------------------------- zero counting supply

    function test_attack_anExitWithNothingCountingCannotDivideByZeroOrDrain() public {
        _world();
        // every holder leaves; the floor that stays is the 4% fees
        _handBack(alice, 100_000_000 * SHARE);
        _handBack(bob, 400_000_000 * SHARE);
        assertEq(t.countingSupply(), 0);
        uint256 balance = usd.balanceOf(address(t));
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(Treasury.TooMuch.selector, 1, 0));
        t.handBack(1); // the zero denominator is refused before it is used
        vm.prank(address(t)); // not even the Treasury itself holds anything that could be handed back
        vm.expectRevert();
        t.handBack(1);
        assertEq(usd.balanceOf(address(t)), balance);
        // a later holder (a public sale of the reserve) finds the left-over floor (the 4% fees) waiting for them
        vm.prank(salePath);
        t.releaseReserve(carol, 1 * SHARE);
        _approveAll(carol);
        uint256 paid = _handBack(carol, 1 * SHARE);
        assertGt(paid, 0);
    }

    // ------------------------------------------------------------------------ nobody can declare the pool open

    function test_attack_theFounderCannotDeclareThePoolOpenToStartVestingOrSplitMoney() public {
        _arrive(7500 * DOLLAR);
        vm.startPrank(founder);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.markPoolOpen();
        vm.stopPrank();
        vm.expectRevert(Treasury.NoPool.selector);
        t.settle(7500 * DOLLAR);
        assertEq(v.start(), 0);
        vm.prank(founder);
        vm.expectRevert(Vester.NotAllowed.selector);
        v.startNow();
    }

    // ---------------------------------------------------------------------- the founder can only reach spendable

    function test_attack_theFounderAndHisAgentsCanNeverMoveMoreThanSpendable() public {
        _world();
        vm.startPrank(founder);
        t.setAgent(agent, type(uint128).max, type(uint128).max);
        t.spend(founder, S); // everything spendable, to himself
        vm.expectRevert(abi.encodeWithSelector(Treasury.TooMuch.selector, 1, 0));
        t.spend(founder, 1);
        vm.stopPrank();
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(Treasury.TooMuch.selector, 1, 0));
        t.spend(agent, 1);
        assertEq(usd.balanceOf(address(t)), M, "the floor is all that is left, and it is all there");
        // the one other way dollars leave is the exit, which needs Shares in his hands and burns them
        vm.prank(founder);
        vm.expectRevert(ShareToken.InsufficientBalance.selector);
        t.handBack(1 * SHARE);
    }

    function test_attack_theReserveLeavesOnlyThroughTheSalePath() public {
        vm.startPrank(founder);
        t.setAgent(agent, type(uint128).max, type(uint128).max);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.releaseReserve(founder, 1);
        vm.stopPrank();
        vm.prank(agent);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.releaseReserve(agent, 1);
        // all of the work pot given away still leaves the reserve whole
        vm.prank(founder);
        t.giveShares(carol, 200_000_000 * SHARE);
        assertEq(t.reserve(), 100_000_000 * SHARE);
    }

    // ---------------------------------------------------------------------------------------- reentrancy

    /// The quote token calls back an account around a transfer (like an ERC-777 hook). The Treasury makes no assumption
    /// that the token is quiet: every function that touches the buckets is non-reentrant, so a call-back cannot make a
    /// deposit be counted twice.
    function test_attack_reenteringATopUpFromInsideAShareRevenueDeposit() public {
        _world();
        HookAttacker a = new HookAttacker();
        usd.setHooked(address(a), true);
        usd.mint(address(a), 2_000 * DOLLAR);
        a.act(address(usd), abi.encodeCall(usd.approve, (address(t), type(uint256).max)));
        // while the Treasury pulls 1,000 for the permanent floor, the call-back deposits another 500 as "top up"
        a.arm(address(t), abi.encodeCall(t.topUp, (500 * DOLLAR)), false);
        a.act(address(t), abi.encodeCall(t.shareRevenue, (1_000 * DOLLAR)));
        assertTrue(a.fired());
        assertFalse(a.firedOk(), "the nested call was refused");
        assertEq(t.permanentFloor(), 1_000 * DOLLAR, "credited what was pulled, not what the balance rose by");
        assertEq(t.spendable(), S);
        assertEq(_buckets(), usd.balanceOf(address(t)), "the buckets still equal the balance");
    }

    function test_attack_reenteringSettleOrSpendOrExitFromInsideAnExitPayout() public {
        _world();
        HookAttacker a = new HookAttacker();
        usd.setHooked(address(a), true);
        vm.prank(alice);
        shares.transfer(address(a), 100_000_000 * SHARE);
        a.act(address(shares), abi.encodeCall(shares.approve, (address(t), type(uint256).max)));
        bytes[3] memory nested = [
            abi.encodeCall(t.handBack, (1_000_000 * SHARE)),
            abi.encodeCall(t.sweepFees, ()),
            abi.encodeCall(t.release, ())
        ];
        uint256 expected;
        for (uint256 i; i < 3; ++i) {
            expected += _quote(10_000_000 * SHARE);
            a.arm(address(t), nested[i], true); // fires after the payout reached the attacker, inside the transfer
            a.act(address(t), abi.encodeCall(t.handBack, (10_000_000 * SHARE)));
            assertTrue(a.fired());
            assertFalse(a.firedOk(), "the nested call was refused");
        }
        assertEq(usd.balanceOf(address(a)), expected, "only honest slices, each worked out by the written rule");
        assertEq(_buckets(), usd.balanceOf(address(t)), "the buckets still equal the balance");
    }
}
