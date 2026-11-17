// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {RoundsBase} from "./helpers/RoundsBase.sol";
import {Pair} from "../src/Pair.sol";
import {Launcher} from "../src/Launcher.sol";
import {BASE_SHARES_PER_RAW_DOLLAR} from "./helpers/Prices.sol";

/// @notice Gas of the backing-round and Team steps (cold storage for the first touch, as on a real network). The auction's steps
/// are in `GasM3.t.sol` and `AuctionV2.t.sol`.
contract GasM4Test is RoundsBase {
    function _measure(string memory label, uint256 g, uint256 limit) internal {
        emit log_named_uint(label, g);
        assertLt(g, limit, label);
    }

    function _cold() internal {
        vm.cool(address(launcher));
        vm.cool(address(t));
        vm.cool(address(v));
        vm.cool(rounds);
        vm.cool(address(shares));
        vm.cool(address(usd));
    }

    function test_gas_launch() public {
        bytes32 h = launcher.settingsHash();
        _cold();
        vm.prank(alice);
        uint256 g = gasleft();
        launcher.launch(keccak256("gas"), "Gas", "GAS", h);
        g -= gasleft();
        _measure("Launcher.launch: five clones, the allocation, the setup", g, 1_600_000);
    }

    function test_gas_aRound_openAskLowerCloseSettleRefundRelease() public {
        _checkIn();
        _cold();
        vm.prank(founder);
        uint256 g = gasleft();
        uint256 id = launcher.openRound(key, BASE_SHARES_PER_RAW_DOLLAR);
        _measure("Launcher.openRound (first round)", g - gasleft(), 200_000);
        usd.mint(alice, 1000 * DOLLAR);
        vm.prank(alice);
        usd.approve(rounds, type(uint256).max);
        _cold();
        vm.prank(alice);
        g = gasleft();
        rd.ask(id, 1000 * DOLLAR);
        _measure("Rounds.ask (first ask of a backer)", g - gasleft(), 150_000);
        _cold();
        vm.prank(alice);
        g = gasleft();
        rd.lower(id, 600 * DOLLAR);
        _measure("Rounds.lower", g - gasleft(), 100_000);
        vm.warp(_now() + 1 days);
        _cold();
        g = gasleft();
        rd.close(id);
        _measure("Rounds.close (the same for any number of asks)", g - gasleft(), 150_000);
        _cold();
        g = gasleft();
        rd.settle(id, alice);
        _measure("Rounds.settle one backer (split, Shares held in the Vester)", g - gasleft(), 300_000);
        _live(7 days);
        _cold();
        g = gasleft();
        rd.release(id);
        _measure("Rounds.release (a week)", g - gasleft(), 100_000);
        _cold();
        vm.prank(alice);
        g = gasleft();
        rd.refund(id);
        _measure("Rounds.refund (cancels the held Shares)", g - gasleft(), 150_000);
    }

    /// @dev The scale-back is worked out per backer when they are settled, so closing costs the same for 10, 100 or 1,000 asks
    /// and nothing has to be paged; settling every backer is one call per backer, or batches with `settleMany`.
    function test_gas_scaleBackAt10_100_1000Asks() public {
        uint256[3] memory ns = [uint256(10), 100, 1000];
        uint256 snap = vm.snapshotState();
        for (uint256 z; z < 3; ++z) {
            vm.revertToState(snap);
            _checkIn();
            uint256 id = _openRound();
            address[] memory who = new address[](ns[z]);
            for (uint256 i; i < ns[z]; ++i) {
                who[i] = address(uint160(0x10000 + i));
                _ask(id, who[i], 100 * DOLLAR); // 100 a head: 1,000 to 100,000 asked into 10,000
            }
            vm.warp(_now() + 1 days);
            _cold();
            uint256 g = gasleft();
            rd.close(id);
            uint256 closeGas = g - gasleft();
            uint256 batch = ns[z] < 100 ? ns[z] : 100;
            address[] memory first = new address[](batch);
            for (uint256 i; i < batch; ++i) {
                first[i] = who[i];
            }
            g = gasleft();
            rd.settleMany(id, first);
            uint256 settleGas = g - gasleft();
            emit log_string(string.concat(
                    vm.toString(ns[z]),
                    " asks: close ",
                    vm.toString(closeGas),
                    " gas; settleMany of ",
                    vm.toString(batch),
                    " backers ",
                    vm.toString(settleGas),
                    " gas (",
                    vm.toString(settleGas / batch),
                    " each)"
                ));
            assertLt(closeGas, 150_000, "close does not grow with the asks");
            assertLt(settleGas / batch, 200_000);
        }
    }

    function test_gas_handOverToAPair_andPairSteps() public {
        _sale(7500 * DOLLAR);
        address predicted = launcher.pairAddress(key, founder, cosigner);
        _cold();
        vm.prank(founder);
        uint256 g = gasleft();
        t.handOver(predicted, false);
        _measure("Treasury.handOver (the founder offers the seat)", g - gasleft(), 80_000);
        _cold();
        vm.prank(cosigner);
        g = gasleft();
        Pair pair = Pair(launcher.makePair(key, founder));
        _measure("Launcher.makePair (the second signer accepts: clone, set up, take the seat)", g - gasleft(), 250_000);
        vm.cool(address(pair));
        _cold();
        vm.prank(founder);
        g = gasleft();
        pair.spend(carol, 400 * DOLLAR);
        _measure("Pair.spend alone (inside the 500 a week)", g - gasleft(), 150_000);
        vm.cool(address(pair));
        _cold();
        vm.prank(cosigner);
        g = gasleft();
        pair.checkIn();
        _measure("Pair.checkIn", g - gasleft(), 100_000);
        bytes memory data = abi.encodeCall(Launcher.openRound, (key, BASE_SHARES_PER_RAW_DOLLAR));
        _cold();
        vm.prank(founder);
        g = gasleft();
        pair.propose(address(launcher), data);
        uint256 proposeGas = g - gasleft();
        emit log_named_uint("Pair.propose (a raise or anything above the limit)", proposeGas);
        assertLt(proposeGas, 100_000);
    }
}
