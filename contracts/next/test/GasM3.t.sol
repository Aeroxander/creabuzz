// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Platform} from "./helpers/Platform.sol";
import {BatchAccount} from "./mocks/BatchAccount.sol";
import {Launcher} from "../src/Launcher.sol";
import {Pair} from "../src/Pair.sol";
import {PoolKey, SaleParams} from "../src/Pinned.sol";
import {IPositionManagerTest} from "./helpers/UniswapTest.sol";
import {BASE_START_Q96, BASE_SHARES_PER_RAW_DOLLAR} from "./helpers/Prices.sol";

/// @notice Gas of the steps of milestone 3, with the production settings for our code (0.8.37, 200 runs) and the vendored
/// Uniswap code at its own (0.8.26, 11,111 runs), on the local twin. Contracts are made cold first (`vm.cool`) so a call pays for its
/// first read of each slot, as a transaction does. Execution gas only: the 21,000 base cost and the call data are not included.
/// Numbers print with `-vv`; the assertions give each one room so a slip shows. Not measured on any network.
contract GasM3Test is Platform {
    function setUp() public {
        _setUpPlatform(false);
    }

    function _cool(Proj memory p, Sale memory s) internal {
        address[13] memory all = [
            address(p.finisher),
            address(p.treasury),
            address(p.vester),
            address(p.shares),
            address(usd),
            strategy,
            address(s.auction),
            poolManager,
            positionManager,
            address(holder),
            guard,
            minBid,
            address(launcher)
        ];
        for (uint256 i; i < all.length; ++i) {
            vm.cool(all[i]);
        }
    }

    function _measure(string memory label, uint256 g, uint256 limit) internal {
        emit log_named_uint(label, g);
        assertLt(g, limit, label);
    }

    function test_gas_openTheSale() public {
        Proj memory p = _launch(founder, keccak256("gas open"));
        Pair pair = _team(p);
        bytes memory data = abi.encodeCall(Launcher.openAuction, (p.key, BASE_START_Q96));
        vm.prank(founder);
        pair.propose(address(launcher), data);
        vm.cool(address(launcher));
        vm.cool(address(p.finisher));
        vm.cool(address(p.treasury));
        vm.cool(address(pair));
        vm.cool(strategy);
        vm.cool(address(usd));
        vm.prank(cosigner);
        uint256 g = gasleft();
        pair.confirm(address(launcher), data, 0);
        g -= gasleft();
        _measure("Pair.confirm(Launcher.openAuction): Finisher, strategy and a new auction", g, 5_000_000);
    }

    /// @dev The batch a passkey account sends as one action: make the project and open its sale.
    function test_gas_aBatchedPasskeyCall_launchAndOpenTheSale() public {
        BatchAccount account = new BatchAccount();
        address[] memory targets = new address[](2);
        bytes[] memory calls = new bytes[](2);
        targets[0] = address(launcher);
        calls[0] = abi.encodeCall(Launcher.launch, (keccak256("gas batch"), "Batch", "BTC", launcher.settingsHash()));
        targets[1] = address(launcher);
        calls[1] = abi.encodeCall(
            Launcher.openRound, (launcher.keyOf(address(account), keccak256("gas batch")), BASE_SHARES_PER_RAW_DOLLAR)
        );
        uint256 g = gasleft();
        account.execute(targets, calls);
        g -= gasleft();
        _measure("batch: launch the project and open its first backing round, in one call", g, 6_500_000);
        emit log_string("batch: add the approval of dollars to Permit2 and the bid's Permit2 allowance for a bidder: about 0.1 million more (milestone 1)");
    }

    function test_gas_theFinishAndTheFees() public {
        Proj memory p = _launch(founder, keccak256("gas finish"));
        Sale memory s = _open(p);
        _fiveBids(s);
        _toEnd(s);
        vm.roll(s.endBlock + 1);
        _cool(p, s);
        vm.prank(stranger);
        uint256 g = gasleft();
        p.finisher.openPool();
        g -= gasleft();
        _measure("step 1 openPool (sweep the raise, pay the 3, make the pool, mint the position)", g, 1_100_000);
        _cool(p, s);
        vm.prank(stranger);
        g = gasleft();
        p.finisher.settle();
        g -= gasleft();
        _measure("step 2 settle (read the pool, send the money, mark the pool open, split 15 : 60)", g, 450_000);
        _cool(p, s);
        vm.prank(stranger);
        g = gasleft();
        p.finisher.sweep();
        g -= gasleft();
        _measure("step 3 sweep (unsold Shares to the Treasury, close the sale)", g, 300_000);

        usd.mint(trader, 100 * DOLLAR);
        PoolKey memory key = _key(p);
        (, uint256 got) = _swap(key, address(p.shares), trader, true, 100 * DOLLAR);
        _swap(key, address(p.shares), trader, false, got / 2);
        uint256 id = IPositionManagerTest(positionManager).nextTokenId() - 1;
        _cool(p, s);
        g = gasleft();
        holder.collect(id);
        g -= gasleft();
        _measure("LiquidityHolder.collect (fees: split half and half, burn the Shares)", g, 400_000);
    }

    function test_gas_abandon() public {
        Proj memory p = _launch(founder, keccak256("gas abandon"));
        Sale memory s = _open(p);
        _fiveBids(s);
        _toEnd(s);
        vm.roll(s.endBlock + 1);
        _failThePoolStep(true);
        uint256 snap = vm.snapshotState();
        p.finisher.openPool();
        _failThePoolStep(false);
        vm.roll(uint256(s.endBlock) + SaleParams.ABANDON_DELAY_BLOCKS);
        _cool(p, s);
        uint256 g = gasleft();
        p.finisher.abandon();
        g -= gasleft();
        _measure("abandon, the failed pool step already run", g, 600_000);
        vm.revertToState(snap);
        vm.roll(uint256(s.endBlock) + SaleParams.ABANDON_DELAY_BLOCKS);
        _cool(p, s);
        g = gasleft();
        p.finisher.abandon();
        g -= gasleft();
        _measure("abandon, running the (failing) pool step itself first", g, 1_000_000);
    }
}
