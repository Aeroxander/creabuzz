// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {RoundsBase} from "./helpers/RoundsBase.sol";
import {BASE_SHARES_PER_RAW_DOLLAR, sharesPerRawDollar} from "./helpers/Prices.sol";
import {Rounds} from "../src/Rounds.sol";
import {Launcher} from "../src/Launcher.sol";
import {Treasury} from "../src/Treasury.sol";
import {Vester} from "../src/Vester.sol";
import {Pair} from "../src/Pair.sol";

/// @notice Founder-set prices (`docs/next-version/FOUNDER-PRICE.md`, plan decision 7) on the milestone 2 world: each round keeps
/// the price it opened at, close and settle use that round's price, both Pair signers sign the price, Creaton's worked example
/// at 6,000,000 for the whole project, and a launch with no stake (project zero). The range tests are in `Rounds.t.sol`; the
/// auction's chosen start is tested on the real stack in `FounderPriceAuction.t.sol`.
contract FounderPriceTest is RoundsBase {
    /// @dev 6,000,000 dollars for the whole project: 166,666,666,666,666 raw Share units a raw dollar unit.
    uint256 internal constant SIX_MILLION = 166_666_666_666_666;

    function test_prices_sixMillionIsTheExpectedRawRate() public pure {
        assertEq(sharesPerRawDollar(6_000_000), SIX_MILLION);
        assertEq(sharesPerRawDollar(333_333), 3_000_003_000_003_000, "333,333 rounds just above the 3e15 limit");
        assertEq(sharesPerRawDollar(50_000_000), 2e13);
    }

    /// @dev Round 1 at 6M closes, round 2 opens at 333,333 and closes, and only then is round 1's backer settled: they get
    /// round 1's price, not the latest round's and not a project-wide one.
    function test_settle_usesThePriceOfTheBackersOwnRound() public {
        _checkIn();
        uint256 id1 = _openRoundAt(SIX_MILLION);
        _ask(id1, alice, 1000 * DOLLAR);
        _close(id1);
        uint256 id2 = _openRoundAt(BASE_SHARES_PER_RAW_DOLLAR);
        _ask(id2, bob, 2000 * DOLLAR);
        _close(id2);
        assertEq(rd.roundOf(id1).sharesPerRawDollar, SIX_MILLION, "round 1 keeps its price");
        assertEq(rd.roundOf(id2).sharesPerRawDollar, BASE_SHARES_PER_RAW_DOLLAR);
        rd.settle(id1, alice);
        rd.settle(id2, bob);
        assertEq(rd.positionOf(id1, alice).bought, 1000 * DOLLAR * SIX_MILLION, "1,000 at 6M: 166,666.67 Shares");
        assertEq(rd.positionOf(id2, bob).bought, 2000 * DOLLAR * 3e15, "2,000 at 333,333: 6,000,000 Shares");
        (uint256 heldA,) = v.heldGrants(id1, alice);
        assertEq(heldA, 1000 * DOLLAR * SIX_MILLION, "held in the Vester at round 1's price");
        assertEq(rd.reserved(), 0, "nothing left set aside");
    }

    /// @dev `close` sets aside `accepted * the round's price` Shares, not the lowest price's.
    function test_close_setsAsideTheAcceptedMoneyAtTheRoundsPrice() public {
        _checkIn();
        uint256 id = _openRoundAt(SIX_MILLION);
        _ask(id, alice, 1000 * DOLLAR);
        _ask(id, bob, 500 * DOLLAR);
        uint256 before = rd.reserved();
        _close(id);
        assertEq(rd.reserved() - before, 1500 * DOLLAR * SIX_MILLION);
        assertEq(rd.unsold(), 150_000_000 * SHARE - 1500 * DOLLAR * SIX_MILLION);
    }

    /// @dev A later round may be priced lower than an earlier one that took money (a down round): allowed, at its own price.
    function test_aLaterRoundMayBeLower() public {
        _round(alice, 1000 * DOLLAR); // 333,333
        _checkIn();
        uint256 id = _openRoundAt(SIX_MILLION);
        _ask(id, bob, 1000 * DOLLAR);
        _close(id);
        _checkIn();
        uint256 id3 = _openRoundAt(BASE_SHARES_PER_RAW_DOLLAR); // down again
        assertEq(rd.roundOf(id3).sharesPerRawDollar, BASE_SHARES_PER_RAW_DOLLAR);
    }

    /// @dev Both signers of a Pair sign the price: a confirm whose price differs from the proposal does not run; the one that
    /// matches runs at the proposed price.
    function test_pair_aConfirmWithAnotherPriceDoesNotRun() public {
        Pair pair = _team();
        bytes memory proposed = abi.encodeCall(Launcher.openRound, (key, SIX_MILLION));
        bytes memory other = abi.encodeCall(Launcher.openRound, (key, BASE_SHARES_PER_RAW_DOLLAR));
        vm.prank(founder);
        pair.propose(address(launcher), proposed);
        uint256 n = pair.nonce() - 1;
        vm.prank(cosigner);
        vm.expectRevert(Pair.UnknownCall.selector);
        pair.confirm(address(launcher), other, n);
        assertFalse(rd.isOpen(), "no round opened at a price only one signer signed");
        vm.prank(cosigner);
        uint256 id = abi.decode(pair.confirm(address(launcher), proposed, n), (uint256));
        assertEq(rd.roundOf(id).sharesPerRawDollar, SIX_MILLION, "the round opened at the price both signed");
    }

    /// @dev Creaton, worked: 10,000 alone at 6M buys 1,666,666.67 Shares (0.17%); with a second person 40,000 more buys
    /// 6,666,666.67, 8,333,333.33 in all (0.83%); the other 141,666,666.67 backing Shares join the reserve when the market opens.
    function test_worked_creatonAtSixMillion() public {
        _checkIn();
        uint256 id1 = _openRoundAt(SIX_MILLION);
        _ask(id1, alice, 10_000 * DOLLAR);
        _close(id1);
        rd.settle(id1, alice);
        assertEq(
            rd.positionOf(id1, alice).bought, 1_666_666_666_666_660_000_000_000, "10,000 alone: 1,666,666.67 Shares"
        );
        vm.prank(founder);
        vm.expectRevert(abi.encodeWithSelector(Launcher.CapReached.selector, 10_000 * DOLLAR));
        launcher.openRound(key, SIX_MILLION);
        _team();
        _checkIn();
        uint256 id2 = _openRoundAt(SIX_MILLION);
        assertEq(rd.roundOf(id2).size, 40_000 * DOLLAR, "the dollar cap, not a Share cap");
        _ask(id2, bob, 40_000 * DOLLAR);
        _close(id2);
        rd.settle(id2, bob);
        uint256 sold = rd.positionOf(id1, alice).bought + rd.positionOf(id2, bob).bought;
        assertEq(sold, 8_333_333_333_333_300_000_000_000, "50,000 at 6M: 8,333,333.33 Shares");
        _market();
        uint256 r0 = shares.balanceOf(address(t));
        rd.returnUnsold();
        assertEq(shares.balanceOf(address(t)) - r0, 150_000_000 * SHARE - sold, "141,666,666.67 back to the reserve");
        assertEq(shares.balanceOf(rounds), 0);
        emit log_named_decimal_uint("Creaton at 6M: Shares for 10,000 alone", rd.positionOf(id1, alice).bought, 18);
        emit log_named_decimal_uint("Creaton at 6M: Shares for the 50,000 Team cap", sold, 18);
        emit log_named_decimal_uint("Creaton at 6M: backing Shares back to the reserve", 150_000_000 * SHARE - sold, 18);
    }

    /// @dev Project zero: the admin names no stake address; a project launched then takes no stake. Its pool opening grants
    /// nothing and the reserve keeps the 20M a default project would give. Projects launched after the setting returns take the
    /// stake again.
    function test_zeroStake_projectZeroTakesNoStake() public {
        Launcher.Settings memory s = _settings();
        s.stake = address(0);
        vm.prank(admin);
        launcher.setSettings(s);
        (, address tr,) = _launch(founder, keccak256("project zero"));
        Treasury t0 = Treasury(tr);
        assertEq(t0.stake(), address(0));
        assertEq(t0.stakeAmount(), 0);
        uint256 reserve0 = t0.reserve();
        Vester v0 = Vester(launcher.project(founder, keccak256("project zero")).vester);
        vm.recordLogs();
        vm.prank(launcher.project(founder, keccak256("project zero")).finisher);
        t0.markPoolOpen();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(logs[i].topics[0] != Treasury.StakeGranted.selector, "no stake granted");
        }
        assertEq(t0.reserve(), reserve0, "the reserve keeps the 20M");
        assertEq(reserve0, 100_000_000 * SHARE);
        (uint256 granted,) = v0.grants(address(0));
        assertEq(granted, 0);
        // a default project, for comparison: the 20M leave the reserve
        uint256 r = t.reserve();
        _market();
        assertEq(r - t.reserve(), 20_000_000 * SHARE, "a default project's stake");
        // the stake comes back for projects launched after the setting is restored
        vm.prank(admin);
        launcher.setSettings(_settings());
        (, address tr2,) = _launch(founder, keccak256("project one hundred"));
        assertEq(Treasury(tr2).stakeAmount(), 20_000_000 * SHARE);
    }
}
