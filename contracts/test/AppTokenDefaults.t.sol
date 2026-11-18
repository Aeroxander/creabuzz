// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {PoolDeploymentParameters} from "tm-tokenmaster/DataTypes.sol";
import {
    StandardPoolInitializationParameters,
    StandardPoolBuyParameters,
    StandardPoolSellParameters,
    StandardPoolSpendParameters
} from "tm-tokenmaster/pools/standard-token-pool/DataTypes.sol";
import {StandardPool} from "tm-tokenmaster/pools/standard-token-pool/StandardPool.sol";
import {DeployAppToken, AboveCeiling} from "../script/DeployAppToken.s.sol";

/// @notice The launch flow's token defaults (docs/dao-os.md R4), proven against
/// the REAL TokenMaster `StandardPool`, not against our own struct. The pool's
/// `max*` guardrails are immutable, so they — not the initial fee — decide what
/// the token's owner can ever do. They used to be 10_000/9999 bps (a 100% sell
/// fee was one owner call away): a rug-capable configuration.
contract AppTokenDefaultsTest is Test {
    DeployAppToken internal script;
    address internal owner = makeAddr("dao");
    address internal treasury = makeAddr("treasury");
    address internal router = makeAddr("router");

    function setUp() public {
        script = new DeployAppToken();
        vm.deal(address(this), 10 ether);
    }

    function _deployPool(address poolOwner, uint16 spread, uint16 buyFee, uint16 sellFee)
        internal
        returns (StandardPool pool)
    {
        StandardPoolInitializationParameters memory init =
            script.initializationParameters(treasury, 1_000_000e18, spread, buyFee, sellFee);
        PoolDeploymentParameters memory params = PoolDeploymentParameters({
            name: "Nebula",
            symbol: "NEB",
            tokenDecimals: 18,
            initialOwner: poolOwner,
            pairedToken: address(0),
            initialPairedTokenToDeposit: 0.1 ether,
            encodedInitializationArgs: abi.encode(init),
            defaultTransferValidator: address(0),
            useRouterForPairedTransfers: false,
            partnerFeeRecipient: address(0),
            partnerFeeBPS: 0
        });
        pool = new StandardPool(params, 0.1 ether, 250, router);
    }

    /// The immutable guardrails the deployed pool ends up with.
    function test_deployed_pool_guardrails_are_conservative() public {
        StandardPool pool = _deployPool(owner, 100, 200, 200);
        (
            uint16 minBuySpread,
            uint16 maxBuySpread,
            uint16 maxBuyFee,
            uint16 maxBuyDemandFee,
            uint16 minSellSpread,
            uint16 maxSellSpread,
            uint16 maxSellFee,
            uint16 maxSpendCreatorShare
        ) = pool.getParameterGuardrails();
        assertEq(minBuySpread, 0);
        assertEq(minSellSpread, 0);
        assertLe(maxBuySpread, 1_000, "buy spread ceiling <= 10%");
        assertLe(maxSellSpread, 1_000, "sell spread ceiling <= 10%");
        assertLe(maxBuyFee, 1_000, "buy fee ceiling <= 10%");
        assertLe(maxSellFee, 1_000, "sell fee ceiling <= 10%");
        assertLe(maxBuyDemandFee, 1_000, "demand fee ceiling <= 10%");
        assertEq(maxSpendCreatorShare, 5_000, "the creator's spend share cannot be raised above its initial 50%");
        // ... and exactly what the TS composers pin.
        assertEq(maxBuySpread, script.MAX_SPREAD_BPS());
        assertEq(maxSellFee, script.MAX_FEE_BPS());
        assertEq(pool.owner(), owner, "the explicit owner, not a hardcoded treasury, holds the levers");
    }

    /// The exploit the old ceilings allowed: the owner sets a 100% sell fee. With
    /// the new immutable ceilings the pool itself refuses. Restoring 10_000 in
    /// the script's `MAX_FEE_BPS` makes this test fail.
    function test_owner_cannot_raise_fees_or_spreads_above_the_ceiling() public {
        StandardPool pool = _deployPool(owner, 100, 200, 200);
        vm.startPrank(owner);
        // Within the ceiling: allowed (the owner keeps a real lever).
        pool.setSellParameters(StandardPoolSellParameters({sellSpreadBPS: 1_000, sellFeeBPS: 1_000}));

        vm.expectRevert();
        pool.setSellParameters(StandardPoolSellParameters({sellSpreadBPS: 100, sellFeeBPS: 1_001}));
        vm.expectRevert();
        pool.setSellParameters(StandardPoolSellParameters({sellSpreadBPS: 1_001, sellFeeBPS: 0}));
        vm.expectRevert();
        pool.setSellParameters(StandardPoolSellParameters({sellSpreadBPS: 0, sellFeeBPS: 10_000}));

        StandardPoolBuyParameters memory buy = pool.getBuyParameters();
        buy.buyFeeBPS = 1_001;
        vm.expectRevert();
        pool.setBuyParameters(buy);
        buy.buyFeeBPS = 1_000;
        buy.buySpreadBPS = 1_001;
        vm.expectRevert();
        pool.setBuyParameters(buy);
        buy.buySpreadBPS = 1_000;
        buy.buyDemandFeeBPS = 1_001;
        vm.expectRevert();
        pool.setBuyParameters(buy);

        // The creator's spend share can be lowered, never raised past 50%.
        pool.setSpendParameters(StandardPoolSpendParameters({creatorShareBPS: 1_000}));
        vm.expectRevert();
        pool.setSpendParameters(StandardPoolSpendParameters({creatorShareBPS: 5_001}));
        vm.stopPrank();
    }

    /// Ownership is an explicit parameter: a token owned by the DAO refuses the
    /// treasury key, and the default owner (== treasury) is the pre-existing shape.
    function test_owner_is_explicit_and_only_the_owner_moves_the_levers() public {
        StandardPool daoOwned = _deployPool(owner, 100, 200, 200);
        vm.prank(treasury);
        vm.expectRevert();
        daoOwned.setSellParameters(StandardPoolSellParameters({sellSpreadBPS: 0, sellFeeBPS: 0}));
        vm.prank(owner);
        daoOwned.setSellParameters(StandardPoolSellParameters({sellSpreadBPS: 0, sellFeeBPS: 0}));

        StandardPool treasuryOwned = _deployPool(treasury, 100, 200, 200);
        assertEq(treasuryOwned.owner(), treasury);
    }

    /// The script itself refuses an env fee/spread above the ceiling instead of
    /// letting the pool constructor fail obscurely (or worse, deploying it).
    function test_script_refuses_fees_and_spreads_above_the_ceiling() public {
        vm.expectRevert(abi.encodeWithSelector(AboveCeiling.selector, "sellFee", 1_001, 1_000));
        script.initializationParameters(treasury, 1e18, 100, 200, 1_001);
        vm.expectRevert(abi.encodeWithSelector(AboveCeiling.selector, "buyFee", 10_000, 1_000));
        script.initializationParameters(treasury, 1e18, 100, 10_000, 200);
        vm.expectRevert(abi.encodeWithSelector(AboveCeiling.selector, "spread", 9_999, 1_000));
        script.initializationParameters(treasury, 1e18, 9_999, 200, 200);
        // The documented defaults pass.
        StandardPoolInitializationParameters memory ok =
            script.initializationParameters(treasury, 1e18, 100, 200, 200);
        assertEq(ok.maxSellFeeBPS, 1_000);
        assertEq(ok.initialSpendParameters.creatorShareBPS, 5_000);
        assertLe(ok.initialSpendParameters.creatorShareBPS, ok.maxSpendCreatorShareBPS);
    }
}
