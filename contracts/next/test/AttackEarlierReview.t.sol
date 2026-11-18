// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {EarlierBase} from "./helpers/EarlierBase.sol";
import {EarlierBackers} from "../src/EarlierBackers.sol";
import {Launcher} from "../src/Launcher.sol";
import {Treasury} from "../src/Treasury.sol";
import {Vester} from "../src/Vester.sol";

/// @notice The review of the earlier backers build (18 November 2026, commit 5805cc656). Every test here failed on that
/// commit and passes with its fix (`EARLIER-BACKERS.md` section 11, "Review fixes"). Finding R4 (the keeper can move a
/// signed entry) is the design, recorded and tested in `test_attack_keeperMovesASignedEntryOnlyInPublicAfter30Days`. Every
/// holder, amount and salt is made up (see `EarlierBase`).
contract AttackEarlierGiftTest is EarlierBase {
    /// R1. A gift to the claim contract's address before the market added to its Vester grant, so `funding()` was no longer
    /// `total` and EB25 refused every later consent for good (the unsigned entries would go to the reserve at the
    /// long-stop). The runner is the DAO LLC's manager (the owner); an agent with the default limit could do the same with
    /// 1 raw unit. Fixed: a gift or team payment to the claim is refused.
    function test_review_R1_runnerGiftToTheClaimBlocksEveryConsent() public {
        _consent(0); // one backer signed already
        vm.prank(founder);
        vm.expectRevert(Treasury.BadInput.selector);
        t.giveShares(address(eb), 1);
        _consent(1);
        assertEq(eb.consentedCount(), 2);
    }

    function test_review_R1_agentGiftToTheClaimBlocksEveryConsent() public {
        address bot = makeAddr("made-up agent");
        vm.prank(founder);
        t.authoriseAgent(bot);
        vm.prank(bot);
        try t.giveShares(address(eb), 1) {} catch {}
        _consent(0);
        assertEq(eb.consentedCount(), 1);
    }

    function test_review_R1_teamPayToTheClaimBlocksEveryConsent() public {
        vm.warp(_now() + 30 days); // team pay has accrued, so only the receiver check can stop it
        vm.prank(founder);
        try t.payTeam(address(eb), 1) {} catch {}
        _consent(0);
        assertEq(eb.consentedCount(), 1);
    }

    /// R1 after the market: the gift would land in the claim as stray Shares counted in hands until the long-stop.
    function test_review_R1_afterTheMarket_theClaimIsNoReceiver() public {
        vm.warp(_now() + 30 days);
        _market();
        _buy(alice, 350_000_000e18);
        vm.prank(founder);
        vm.expectRevert(Treasury.BadInput.selector);
        t.giveShares(address(eb), 1e18);
        vm.prank(founder);
        vm.expectRevert(Treasury.BadInput.selector);
        t.payTeam(address(eb), 1e18);
        assertEq(shares.balanceOf(address(eb)), 0);
    }

    /// R3 / F3. "About monthly ... if the owner stays": nothing paced the team budget before the market, and the founder
    /// trim (days served / 365, what every other founder who leaves early faces) cannot reach it. On launch day the runner
    /// paid the whole budget to the founder, then left with the trim: nothing was cut. Fixed: the budget accrues over 730
    /// days from the launch and `payTeam` never pays more than has accrued.
    function test_review_R3_wholeTeamBudgetOnDayOne_escapesTheTrim() public {
        uint256 all = t.teamBudget();
        vm.prank(founder);
        try t.payTeam(founder, all) {} catch {}
        vm.prank(founder);
        t.handOver(alice, true); // the founder leaves on day one
        vm.prank(alice);
        t.takeSeat();
        (uint256 held,) = v.grants(founder);
        assertLt(held, all / 12, "a leaver keeps at most about one month of team pay");
    }
}

/// @notice The keeper and the holder's veto.
contract AttackEarlierKeeperTest is EarlierBase {
    /// R5. A thief who has the leaked key and the entry's salt never agrees (EB29 only bars a key whose CONSENT was voided)
    /// and vetoed every replacement: the keeper had no way to bar it, and the real backer (new key) never got the entry.
    /// Fixed: the holder's bare veto works once per entry; after it only a consent stops a replacement, and the keeper can
    /// void that with the replacement in the same call.
    function test_review_R5_thiefVetoBlocksTheReplacementForGood() public {
        address next = makeAddr("made-up backer's new key");
        for (uint256 round; round < 5; ++round) {
            vm.prank(keeper);
            eb.proposeHolder(7, next, keccak256("lost key, leaked"));
            vm.prank(holders[7]); // the thief, with the leaked key and salt
            try eb.cancelHolder(7, amounts[7], salts[7]) {} catch {}
            vm.warp(_now() + 30 days);
            try eb.applyHolder(7) {} catch {}
            if (eb.entryOf(7).holder == next) break;
        }
        assertEq(eb.entryOf(7).holder, next, "the keeper can get a lost key's entry to the backer despite a thief");
    }

    /// R5: the second bare veto is refused; the thief's last move, a consent, is voided with the replacement in one call.
    function test_review_R5_oneVetoThenOnlyAConsent() public {
        address next = makeAddr("made-up backer's new key");
        vm.prank(keeper);
        eb.proposeHolder(7, next, "lost key");
        vm.prank(holders[7]);
        eb.cancelHolder(7, amounts[7], salts[7]);
        assertTrue(eb.entryOf(7).vetoed);
        vm.prank(keeper);
        eb.proposeHolder(7, next, "lost key, again");
        vm.prank(holders[7]);
        vm.expectRevert(EarlierBackers.NoReplacement.selector);
        eb.cancelHolder(7, amounts[7], salts[7]);
        _consent(7); // the thief agrees instead (Shares to the leaked key): this cancels the replacement (EB12)
        assertEq(eb.entryOf(7).pending, address(0));
        vm.prank(keeper);
        eb.voidConsent(7, next, keccak256("public evidence: leaked key"));
        uint256 until = _now() + 1 days;
        bytes memory again = _sign(7, holders[7], until);
        vm.expectRevert(EarlierBackers.Barred.selector);
        eb.consent(7, holders[7], amounts[7], salts[7], holders[7], TEXT, until, again);
        vm.warp(_now() + 30 days);
        eb.applyHolder(7);
        assertEq(eb.entryOf(7).holder, next);
    }

    /// F2. With void and proposal as two calls, a leaked key watching the chain re-signed in the gap (nothing pending yet,
    /// so EB29 did not apply) and the proposal then reverted. Fixed: `voidConsent` takes the replacement, so there is no gap.
    function test_review_F2_voidWithTheReplacementLeavesNoGap() public {
        _consent(0);
        address next = makeAddr("made-up backer's new key");
        vm.prank(keeper);
        eb.voidConsent(0, next, keccak256("leaked key"));
        assertEq(eb.entryOf(0).pending, next);
        uint256 until = _now() + 1 days;
        bytes memory again = _sign(0, holders[0], until);
        vm.expectRevert(EarlierBackers.Barred.selector); // the leaked key, in the very next transaction
        eb.consent(0, holders[0], amounts[0], salts[0], holders[0], TEXT, until, again);
        vm.warp(_now() + 30 days);
        eb.applyHolder(0);
        assertEq(eb.entryOf(0).holder, next);
    }
}

/// @notice The Launcher's launch hash and project zero's name.
contract AttackEarlierNamingTest is EarlierBase {
    function _launchesZero() internal pure override returns (bool) {
        return false;
    }

    /// R2. Being named project zero takes the founder's 200M Vester grant away (it becomes the Treasury's team budget), but
    /// with no earlier raise named `launchHash(key)` was still `settingsHash()`. The admin could name any founder's key in
    /// the block before their launch, and the launch went through on a hash that never said so (the guarantee L13 tests).
    /// Fixed: the named project zero's hash always covers the name.
    function test_review_R2_namingProjectZeroIsNotInTheLaunchHash() public {
        bytes32 id = keccak256("made-up outside project");
        bytes32 k = launcher.keyOf(alice, id);
        bytes32 seen = launcher.launchHash(k); // what alice signs off on: an ordinary project
        vm.prank(admin);
        launcher.nameProjectZero(k); // in the block before her launch
        vm.prank(alice);
        vm.expectRevert(Launcher.SettingsMoved.selector);
        launcher.launch(id, "Outside", "OUT", seen);
    }

    /// R2, the other way: the admin takes the name back after Creaton's founder read the hash; the launch reverts rather
    /// than make an ordinary project the founder did not sign off on.
    function test_review_R2_takingTheNameBackMovesTheHash() public {
        bytes32 k0 = launcher.keyOf(founder, ZERO_ID);
        vm.prank(admin);
        launcher.nameProjectZero(k0);
        bytes32 seen = launcher.launchHash(k0);
        vm.prank(admin);
        launcher.nameProjectZero(bytes32(0));
        vm.prank(founder);
        vm.expectRevert(Launcher.SettingsMoved.selector);
        launcher.launch(ZERO_ID, "Creaton", "CREATE", seen);
        vm.prank(admin);
        launcher.nameProjectZero(k0);
        vm.prank(founder);
        (,, address ve) = launcher.launch(ZERO_ID, "Creaton", "CREATE", seen);
        (uint256 g,) = Vester(ve).grants(founder);
        assertEq(g, 0, "project zero, as the founder read it");
    }
}
