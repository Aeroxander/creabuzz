// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Stack} from "./helpers/Stack.sol";

interface IHasPoolManager {
    function poolManager() external view returns (address);
}

interface IPermit2Domain {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

interface IFactoryFeeController {
    function protocolFeeController() external view returns (address);
}

interface ILauncherPermit2 {
    function permit2() external view returns (address);
}

interface IPoolSwapTestManager {
    function manager() external view returns (address);
}

/// @notice Step 2 of milestone 1: which Uniswap pieces really exist on Sepolia, at the pinned block, by code size and
/// by one real call each. Runs only with SEPOLIA_RPC_URL set. The answers are written up in M1-FACTS.md section 8.
contract ForkFactsTest is Stack {
    address internal constant POSITION_DESCRIPTOR = 0x12570561f184C7Bf46C7EcA7D937db49861C7e61;
    address internal constant STATE_VIEW = 0xE1Dd9c3fA50EDB962E442f60DfBc432e24537E4C;
    address internal constant V4_QUOTER = 0x61B3f2011A92d183C7dbaDBdA940a7555Ccf9227;
    address internal constant CCA_FACTORY_V2_1 = 0x000000001F26a0044BaA66024e7b6599c61963F8;
    address internal constant CCA_FACTORY_V2_0 = 0x00cCa200BF124dBfA848937c553864f4B4CE0632;
    address internal constant LAUNCHER_V1 = 0x00000008412db3394C91A5CbD01635c6d140637C;
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    function setUp() public {
        _setUpStack(true);
    }

    function _size(address a) internal view returns (uint256) {
        return a.code.length;
    }

    function test_fork_poolManagerAndPositionManagerAreTheRealOnes() public view {
        assertEq(block.chainid, 11_155_111, "sepolia");
        assertEq(_size(SEPOLIA_POOL_MANAGER), 24_009, "PoolManager code size");
        assertEq(_size(SEPOLIA_POSITION_MANAGER), 23_877, "PositionManager code size");
        // The position manager really points at that pool manager.
        assertEq(address(positionManager.poolManager()), SEPOLIA_POOL_MANAGER, "PositionManager.poolManager()");
    }

    function test_fork_permit2IsAtItsFixedAddress() public view {
        assertEq(_size(PERMIT2), 9152, "Permit2 code size");
        assertTrue(IPermit2Domain(PERMIT2).DOMAIN_SEPARATOR() != bytes32(0), "Permit2 answers");
    }

    function test_fork_swapRoutersExist() public view {
        // The universal router (the real trade router) and v4's own test swap router.
        assertEq(_size(SEPOLIA_UNIVERSAL_ROUTER), 19_540, "UniversalRouter code size");
        assertEq(
            IHasPoolManager(SEPOLIA_UNIVERSAL_ROUTER).poolManager(), SEPOLIA_POOL_MANAGER, "router -> pool manager"
        );
        assertEq(_size(SEPOLIA_POOL_SWAP_TEST), 6950, "PoolSwapTest code size");
        assertEq(
            IPoolSwapTestManager(SEPOLIA_POOL_SWAP_TEST).manager(), SEPOLIA_POOL_MANAGER, "swap test -> pool manager"
        );
    }

    function test_fork_readOnlyHelpersExist() public view {
        assertEq(_size(STATE_VIEW), 3531, "StateView code size");
        assertEq(IHasPoolManager(STATE_VIEW).poolManager(), SEPOLIA_POOL_MANAGER, "StateView -> pool manager");
        assertEq(_size(V4_QUOTER), 5820, "V4Quoter code size");
        assertEq(_size(POSITION_DESCRIPTOR), 24_110, "PositionDescriptor code size");
    }

    function test_fork_uniswapAuctionFactoriesExistAndTakeNoFee() public view {
        assertEq(_size(CCA_FACTORY_V2_1), 24_214, "auction factory v2.1.0 code size");
        assertEq(_size(CCA_FACTORY_V2_0), 24_124, "auction factory v2.0.0 code size");
        // Uniswap's own deployments have no fee controller at all: using them would give the platform nothing.
        assertEq(IFactoryFeeController(CCA_FACTORY_V2_1).protocolFeeController(), address(0), "v2.1.0 controller");
        assertEq(IFactoryFeeController(CCA_FACTORY_V2_0).protocolFeeController(), address(0), "v2.0.0 controller");
    }

    function test_fork_launcherAndCreate2DeployerExist() public view {
        assertEq(_size(LAUNCHER_V1), 3456, "LiquidityLauncher code size");
        assertEq(ILauncherPermit2(LAUNCHER_V1).permit2(), PERMIT2, "launcher -> permit2");
        assertGt(_size(CREATE2_DEPLOYER), 0, "create2 deployer");
    }

    /// @notice There is no canonical deployment of the v3.0.0 strategy to find (none is listed in the vendored docs),
    /// so a call cannot prove it is absent; this records that the v2 strategy factory addresses the docs list are a
    /// different, deprecated contract that has no `initializers(address)` view of the v3 shape.
    function test_fork_v2StrategyFactoryIsNotTheV3Strategy() public view {
        address legacy = 0x89Dd5691e53Ea95d19ED2AbdEdCf4cBbE50da1ff;
        assertGt(_size(legacy), 0, "the deprecated v2 factory is on chain");
        (bool ok,) = legacy.staticcall(abi.encodeWithSignature("registeredPoolIds(bytes32)", bytes32(0)));
        assertFalse(ok, "legacy v2 factory has no v3 strategy surface");
    }
}
