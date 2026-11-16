// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {HookSalt} from "../src/HookSalt.sol";
// not used as types: importing them keeps their build artifacts fresh for `vm.getCode`
import {LBPStrategy} from "liquidity-launcher/src/strategies/lbp/LBPStrategy.sol";
import {PoolGuard} from "../src/PoolGuard.sol";

/// @notice What it costs to find the addresses the platform needs: the strategy and the pool guard must each sit at an address whose
/// lowest 14 bits are exactly the `beforeInitialize` flag (0x2000), so about one salt in 16,384 fits. Counted here by asking
/// `HookSalt` for the first fitting salt over many different deployers; the off-chain search with `cast create2` is timed by hand
/// and reported in the milestone 3 report (see its "Mined addresses" section).
contract MinedCostTest is Test {
    /// @dev One search per external call: the loop allocates memory on each try, and a frame has a ceiling.
    function search(address deployer, bytes calldata code, bytes calldata args) external view returns (uint256 tries) {
        (, bytes32 salt) = HookSalt.find(deployer, 0x2000, code, args);
        return uint256(salt) + 1;
    }

    function test_minedCost_triesNeededForTheStrategyAndTheGuard() public {
        bytes memory strategyCode = vm.getCode("LBPStrategy.sol:LBPStrategy");
        bytes memory guardCode = vm.getCode("PoolGuard.sol:PoolGuard");
        // Sepolia's real pool manager and position manager, and stand-ins for the factory and the strategy
        bytes memory strategyArgs = abi.encode(
            address(0x429ba70129df741B2Ca2a85BC3A2a3328e5c09b4),
            address(0xE03A1074c86CFeDd5C142C4F04F1a1536e203543),
            address(0xFAC7)
        );
        bytes memory guardArgs = abi.encode(address(0xE03A1074c86CFeDd5C142C4F04F1a1536e203543), address(0x57A7));
        emit log_named_bytes32(
            "strategy init code hash (Sepolia managers, placeholder factory)",
            keccak256(abi.encodePacked(strategyCode, strategyArgs))
        );
        emit log_named_bytes32(
            "guard init code hash (Sepolia pool manager, placeholder strategy)",
            keccak256(abi.encodePacked(guardCode, guardArgs))
        );
        uint256 n = 16;
        uint256 sumS;
        uint256 maxS;
        uint256 sumG;
        uint256 maxG;
        for (uint256 i; i < n; ++i) {
            address deployer = address(uint160(uint256(keccak256(abi.encode("deployer", i)))));
            uint256 ts = this.search(deployer, strategyCode, strategyArgs);
            sumS += ts;
            if (ts > maxS) maxS = ts;
            uint256 tg = this.search(deployer, guardCode, guardArgs);
            sumG += tg;
            if (tg > maxG) maxG = tg;
        }
        emit log_named_uint("strategy: deployers tried", n);
        emit log_named_uint("strategy: mean salts tried", sumS / n);
        emit log_named_uint("strategy: most salts tried", maxS);
        emit log_named_uint("guard: mean salts tried", sumG / n);
        emit log_named_uint("guard: most salts tried", maxG);
        assertGt(sumS / n, 2000, "about one salt in 16,384 fits");
        assertLt(sumS / n, 60_000);
        assertLt(maxS, HookSalt.MAX_TRIES, "the search never ran out");
        assertLt(maxG, HookSalt.MAX_TRIES);
    }
}
