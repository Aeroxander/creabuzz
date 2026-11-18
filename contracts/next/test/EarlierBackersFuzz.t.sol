// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {EarlierBase} from "./helpers/EarlierBase.sol";
import {EarlierBackers} from "../src/EarlierBackers.sol";
import {Launcher} from "../src/Launcher.sol";
import {Treasury} from "../src/Treasury.sol";
import {Wallet1271} from "./mocks/Wallets.sol";

/// @notice Fuzz: one leaf per entry, and pro-rata delivery on the one clock (never early, never above what was released).
/// The list is the S1 list of 21 made-up entries.
contract EarlierFuzzTest is EarlierBase {
    /// Entry `j`'s details never pass as entry `i`'s: one leaf per entry, so no entry can be agreed to twice under
    /// another index.
    function testFuzz_oneLeafPerEntry(uint256 i, uint256 j) public {
        i = bound(i, 0, 20);
        j = bound(j, 0, 20);
        vm.assume(i != j);
        assertTrue(eb.leaf(i) != eb.leaf(j));
        uint256 until = _now() + 1 days;
        bytes memory sig = _signWith(pks[j], eb.consentDigest(i, holders[j], amounts[j], holders[j], until));
        vm.expectRevert(EarlierBackers.NotOnList.selector);
        eb.consent(i, holders[j], amounts[j], salts[j], holders[j], TEXT, until, sig);
    }

    /// Each agreed entry receives exactly `amount x released / granted` once its 21 days are over; together never more
    /// than was released; the rest stays out of the Treasury's count.
    function testFuzz_proRataDelivery(uint256 mask, uint256 wait, uint256 consentDelay) public {
        mask = bound(mask, 1, (1 << 21) - 1);
        wait = bound(wait, 0, 500 days);
        consentDelay = bound(consentDelay, 0, 200 days);
        _market();
        vm.warp(_now() + consentDelay);
        uint256 n;
        for (uint256 i; i < 21; ++i) {
            if (mask & (1 << i) != 0) {
                _consent(i);
                ++n;
            }
        }
        uint256 t0 = _now();
        vm.warp(t0 + wait);
        (uint256 granted,, uint256 released) = _grant();
        uint256 sum;
        for (uint256 i; i < 21; ++i) {
            if (mask & (1 << i) == 0) continue;
            if (wait < 21 days) {
                vm.expectRevert(abi.encodeWithSelector(EarlierBackers.TooEarly.selector, t0 + 21 days));
                eb.deliver(i);
                continue;
            }
            eb.deliver(i);
            uint256 expect = amounts[i] * released / granted;
            assertEq(shares.balanceOf(holders[i]), expect, "pro rata");
            sum += expect;
        }
        assertEq(eb.delivered(), sum);
        assertLe(eb.delivered(), released);
        assertEq(eb.undelivered(), released - sum);
        assertEq(eb.consentedCount(), n);
    }

    /// After the close, delivered plus sent to the reserve never passes what the clock released, at any two times.
    function testFuzz_closeNeverAboveReleased(uint256 mask, uint256 t1, uint256 t2) public {
        mask = bound(mask, 0, (1 << 21) - 1);
        _market();
        for (uint256 i; i < 21; ++i) {
            if (mask & (1 << i) != 0) _consent(i);
        }
        t1 = bound(t1, 21 days, 200 days);
        vm.warp(_now() + t1);
        for (uint256 i; i < 21; ++i) {
            if (mask & (1 << i) != 0) eb.deliver(i);
        }
        vm.warp(longStop + bound(t2, 0, 10 days));
        eb.close();
        eb.toReserve();
        (,, uint256 released) = _grant();
        assertLe(eb.delivered() + eb.reserveTaken(), released);
        for (uint256 i; i < 21; ++i) {
            if (mask & (1 << i) != 0) eb.deliver(i);
        }
        assertEq(eb.delivered() + eb.reserveTaken(), released, "all of it reached someone (the clock is done)");
        assertLe(shares.balanceOf(address(eb)), 21, "at most a unit of dust per entry");
    }
}

/// @notice Fuzz the sum guard (EB24) on a padded list: its entries add up to 60M more than the total the contract was told.
/// In any order, the Shares agreed to never pass the total; the entry that would is refused.
contract EarlierPaddedFuzzTest is EarlierBase {
    function _listSum() internal pure override returns (uint256) {
        return S1_TOTAL + 60_000_000e18;
    }

    function testFuzz_sumGuard(uint256 seed) public {
        uint256[] memory order = _ids();
        for (uint256 i = order.length; i > 1; --i) {
            uint256 k = uint256(keccak256(abi.encode(seed, i))) % i;
            (order[i - 1], order[k]) = (order[k], order[i - 1]);
        }
        uint256 running;
        uint256 refused;
        uint256 until = _now() + 1 days;
        for (uint256 x; x < order.length; ++x) {
            uint256 i = order[x];
            bytes memory sig = _sign(i, holders[i], until);
            if (running + amounts[i] > S1_TOTAL) {
                vm.expectRevert(EarlierBackers.OverTotal.selector);
                eb.consent(i, holders[i], amounts[i], salts[i], holders[i], TEXT, until, sig);
                ++refused;
            } else {
                eb.consent(i, holders[i], amounts[i], salts[i], holders[i], TEXT, until, sig);
                running += amounts[i];
            }
            assertLe(eb.consentedTotal(), S1_TOTAL);
        }
        assertEq(eb.consentedTotal(), running);
        assertGt(refused, 0, "a padded list always has an entry that does not fit");
    }
}

/// @notice The attack findings of `EARLIER-BACKERS.md` section 8 that the contracts handle, one test each.
contract EarlierAttacksTest is EarlierBase {
    /// "An old leaked key consents first": the keeper voids inside the 21 days (nothing was delivered meanwhile) and, in the
    /// same call, proposes the backer's new wallet publicly (so the leaked key has no moment to agree again in between); the
    /// leaked key can neither agree again nor veto, and the backer agrees after 30 days. The keeper never names a receiver.
    function test_attack_leakedKeyConsentsFirst() public {
        _market();
        uint256 thief = 0x7417;
        Wallet1271 drop = new Wallet1271(vm.addr(thief));
        _consentTo(4, address(drop)); // the leaked key sends entry 4 to the thief's wallet
        vm.warp(_now() + 20 days);
        vm.expectRevert();
        eb.deliver(4); // still inside the window
        uint256 newKey = 0xB4C4;
        vm.prank(keeper);
        eb.voidConsent(4, vm.addr(newKey), keccak256("public evidence"));
        uint256 until = _now() + 1 days;
        bytes memory again = _sign(4, address(drop), until);
        vm.expectRevert(EarlierBackers.Barred.selector);
        eb.consent(4, holders[4], amounts[4], salts[4], address(drop), TEXT, until, again);
        vm.warp(_now() + 30 days);
        eb.applyHolder(4);
        vm.prank(vm.addr(newKey));
        eb.consent(4, holders[4], amounts[4], salts[4], vm.addr(newKey), TEXT, _now() + 1, "");
        vm.warp(_now() + 21 days);
        eb.deliver(4);
        assertEq(shares.balanceOf(address(drop)), 0, "the thief got nothing");
        assertGt(shares.balanceOf(vm.addr(newKey)), 0);
    }

    /// "A receiver with no code on the claim's network can be captured": a counterfactual wallet address is refused.
    function test_attack_receiverWithoutCodeRefused() public {
        address counterfactual = address(uint160(uint256(keccak256("made-up counterfactual account"))));
        uint256 until = _now() + 1 days;
        bytes memory sig = _sign(6, counterfactual, until);
        vm.expectRevert(EarlierBackers.BadReceiver.selector);
        eb.consent(6, holders[6], amounts[6], salts[6], counterfactual, TEXT, until, sig);
    }

    /// "Three different signed messages, one chain-less": the one message names the chain; a copy on another chain fails.
    function test_attack_chainlessReplayRefused() public {
        uint256 until = _now() + 1 days;
        bytes memory sig = _sign(0, holders[0], until);
        uint256 home = 31_337; // the local test chain (read once: `block.chainid` may be cached after `vm.chainId`)
        vm.chainId(home + 1);
        vm.expectRevert(EarlierBackers.BadSignature.selector);
        eb.consent(0, holders[0], amounts[0], salts[0], holders[0], TEXT, until, sig);
        vm.chainId(home);
        eb.consent(0, holders[0], amounts[0], salts[0], holders[0], TEXT, until, sig);
    }

    /// "Holdouts swept while their SAFT survives": nothing goes to the reserve before the long-stop, and the waiting
    /// Shares are not in the Treasury's count, so they thin nobody's exit.
    function test_attack_noEarlySweep_andWaitingThinsNobody() public {
        _market();
        _buy(alice, 350_000_000e18);
        vm.warp(_now() + 365 days);
        assertEq(t.countingSupply(), 350_000_000e18, "288.68M released to the claim, none of it counted");
        vm.expectRevert(EarlierBackers.ClosedState.selector);
        eb.toReserve();
    }

    /// "D as a general rule = free self-fill and trim escape": only the named project zero, once; a claim for any other
    /// key is refused, and an ordinary launch never takes the cut.
    function test_attack_notAGeneralRule() public {
        bytes32 mine = launcher.keyOf(alice, keccak256("my project"));
        EarlierBackers own = _deployClaimWith(address(launcher), mine, leaves, S1_TOTAL, 0);
        vm.prank(admin);
        vm.expectRevert(Launcher.BadCut.selector); // project zero launched; nothing is named
        launcher.nameEarlierBackers(address(own), 0);
        bytes32 h = launcher.launchHash(mine);
        vm.prank(alice);
        (,, address ve) = launcher.launch(keccak256("my project"), "Mine", "MINE", h);
        (uint256 c,) = v.grants(address(own));
        assertEq(c, 0);
        assertEq(ve == address(v), false);
    }

    /// "Owner decides who receives entries with no address": the keeper never names a receiver (a consent it voids leaves
    /// none), and a replacement of an open entry is public, waits 30 days and is vetoable.
    function test_attack_keeperNamesNoReceiver() public {
        _consent(9);
        vm.prank(keeper);
        eb.voidConsent(9, address(0), "x");
        assertEq(eb.entryOf(9).receiver, address(0));
        vm.prank(keeper);
        eb.proposeHolder(10, keeper, "keeper names itself");
        vm.prank(holders[10]);
        eb.cancelHolder(10, amounts[10], salts[10]); // the holder vetoes
        vm.warp(_now() + 30 days);
        vm.expectRevert(EarlierBackers.NoReplacement.selector);
        eb.applyHolder(10);
    }

    /// Review finding R4, recorded as the design (note section 11, "Review fixes"): the keeper CAN move a signed entry to a
    /// holder it names, by voiding the consent inside its window with a replacement. It is public (`Voided` and
    /// `HolderProposed`, with evidence), it waits 30 days from the void, nothing is delivered meanwhile, and the voided key
    /// can neither agree again nor veto. No rule can tell a thief holding the key from the backer holding it; the protection
    /// is the keeper's make-up (2-of-3, at most one signer the owner) and the public events.
    function test_attack_keeperMovesASignedEntryOnlyInPublicAfter30Days() public {
        _market();
        _consent(2);
        address named = makeAddr("made-up holder the keeper names");
        vm.warp(_now() + 20 days);
        vm.expectEmit(true, true, false, true, address(eb));
        emit EarlierBackers.Voided(2, holders[2], keccak256("public evidence"));
        vm.expectEmit(true, true, false, true, address(eb));
        emit EarlierBackers.HolderProposed(2, named, _now() + 30 days, keccak256("public evidence"));
        vm.prank(keeper);
        eb.voidConsent(2, named, keccak256("public evidence"));
        assertEq(shares.balanceOf(holders[2]), 0, "nothing was delivered inside the window");
        vm.expectRevert(EarlierBackers.EntryState.selector);
        eb.deliver(2);
        vm.prank(holders[2]);
        vm.expectRevert(EarlierBackers.NoReplacement.selector);
        eb.cancelHolder(2, amounts[2], salts[2]);
        vm.warp(_now() + 30 days - 1);
        vm.expectRevert(abi.encodeWithSelector(EarlierBackers.TooEarly.selector, _now() + 1));
        eb.applyHolder(2);
        vm.warp(_now() + 1);
        eb.applyHolder(2);
        assertEq(eb.entryOf(2).holder, named);
    }
}

/// @notice Gas of the claim contract on the S1 list.
contract EarlierGasTest is EarlierBase {
    function test_gas_consentAndDeliver() public {
        _market();
        uint256 until = _now() + 1 days;
        bytes memory sig = _sign(0, holders[0], until);
        uint256 g = gasleft();
        eb.consent(0, holders[0], amounts[0], salts[0], holders[0], TEXT, until, sig);
        uint256 consentGas = g - gasleft();
        Wallet1271 w = new Wallet1271(vm.addr(pks[1]));
        sig = _sign(1, address(w), until);
        g = gasleft();
        eb.consent(1, holders[1], amounts[1], salts[1], address(w), TEXT, until, sig);
        uint256 consentToWalletGas = g - gasleft();
        for (uint256 i = 2; i < 21; ++i) {
            _consent(i);
        }
        vm.warp(_now() + 30 days);
        g = gasleft();
        eb.deliver(0);
        uint256 deliverGas = g - gasleft();
        vm.warp(_now() + 30 days);
        g = gasleft();
        eb.deliverMany(_ids());
        uint256 manyGas = g - gasleft();
        g = gasleft();
        t.countingSupply();
        uint256 countGas = g - gasleft();
        emit log_named_uint("consent, EOA signature, own wallet", consentGas);
        emit log_named_uint("consent, EOA signature, contract wallet receiver", consentToWalletGas);
        emit log_named_uint("deliver one entry", deliverGas);
        emit log_named_uint("deliverMany, 21 entries", manyGas);
        emit log_named_uint("Treasury.countingSupply with the claim", countGas);
        assertLt(consentGas, 200_000);
        assertLt(deliverGas, 160_000);
        assertLt(manyGas, 1_500_000);
    }

    function test_gas_payTeam() public {
        vm.warp(_now() + 30 days); // a month of team pay has accrued
        vm.prank(founder);
        uint256 g = gasleft();
        t.payTeam(alice, 1_000_000e18);
        uint256 before = g - gasleft();
        _market();
        _buy(alice, 350_000_000e18);
        vm.prank(founder);
        g = gasleft();
        t.payTeam(bob, 1_000_000e18);
        uint256 afterMarket = g - gasleft();
        emit log_named_uint("payTeam before the market (held)", before);
        emit log_named_uint("payTeam after the market (free)", afterMarket);
        assertLt(before, 150_000);
        assertLt(afterMarket, 150_000);
    }
}

/// @notice The largest list (64 entries) at S1: consent all, deliver all in one call.
contract EarlierGas64Test is EarlierBase {
    function _listSize() internal pure override returns (uint256) {
        return 64;
    }

    function test_gas_deliverMany64() public {
        _market();
        _consentAll();
        vm.warp(_now() + 60 days);
        uint256 g = gasleft();
        eb.deliverMany(_ids());
        uint256 used = g - gasleft();
        emit log_named_uint("deliverMany, 64 entries", used);
        assertLt(used, 4_000_000);
        assertEq(eb.consentedTotal(), S1_TOTAL);
    }
}
