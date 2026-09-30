// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {
    IContinuousClearingAuction as UpstreamAuction
} from "continuous-clearing-auction/src/interfaces/IContinuousClearingAuction.sol";
import {
    IContinuousClearingAuctionFactory
} from "continuous-clearing-auction/src/interfaces/IContinuousClearingAuctionFactory.sol";
import {IAuctionStorage} from "continuous-clearing-auction/src/interfaces/IAuctionStorage.sol";
import {IValidationHook as UpstreamHook} from "continuous-clearing-auction/src/interfaces/IValidationHook.sol";
import {
    ILBPInitializer as UpstreamInitializer,
    LBPInitializationParams as UpstreamParams
} from "liquidity-launcher/src/interfaces/ILBPInitializer.sol";
import {IDistributorFactory} from "liquidity-launcher/src/interfaces/IDistributorFactory.sol";
import {Summoner} from "majeur/src/Moloch.sol";
import {OrgBinding} from "../src/OrgBinding.sol";
import {
    IContinuousClearingAuction as MirrorAuction,
    ICcaFinalization,
    ICcaValidationHookView,
    ILBPInitializer as MirrorInitializer,
    IValidationHook as MirrorHook
} from "../src/CCA.sol";

/// @notice Proves the hand-mirrored `src/CCA.sol` matches the pinned upstream
/// sources (gitlink `contracts/lib/continuous-clearing-auction`). Every function
/// the launch contracts call on an auction, and the one struct they decode, is
/// compared to the UPSTREAM interface (both imported), and to a literal
/// `cast sig` value the desktop/web/CLI composers embed — so an upstream sync
/// that changes a signature fails here instead of at graduation. A selector
/// compared to itself (the old factory test) proves nothing; every assertion
/// below has two independent sides.
contract PinnedInterfacesTest is Test {
    // ---------------------------------------------------------------- auction

    /// Each mirrored auction function == the upstream interface's selector ==
    /// the literal (`cast sig`) the client composers pin.
    function test_mirrored_auction_selectors_equal_upstream_and_the_literals() public pure {
        assertEq(MirrorAuction.isGraduated.selector, UpstreamAuction.isGraduated.selector);
        assertEq(MirrorAuction.isGraduated.selector, bytes4(0x9e5f2602));

        assertEq(MirrorAuction.currencyRaised.selector, IAuctionStorage.currencyRaised.selector);
        assertEq(MirrorAuction.currencyRaised.selector, bytes4(0x998ba4fc));

        assertEq(MirrorAuction.lbpInitializationParams.selector, UpstreamInitializer.lbpInitializationParams.selector);
        assertEq(MirrorAuction.lbpInitializationParams.selector, bytes4(0xe1d97d1f));

        assertEq(MirrorAuction.currency.selector, UpstreamAuction.currency.selector);
        assertEq(MirrorAuction.currency.selector, bytes4(0xe5a6b10f));

        assertEq(MirrorAuction.token.selector, UpstreamAuction.token.selector);
        assertEq(MirrorAuction.token.selector, bytes4(0xfc0c546a));

        assertEq(MirrorAuction.fundsRecipient.selector, UpstreamAuction.fundsRecipient.selector);
        assertEq(MirrorAuction.fundsRecipient.selector, bytes4(0x3b6fd2cf));

        assertEq(MirrorAuction.tokensRecipient.selector, UpstreamAuction.tokensRecipient.selector);
        assertEq(MirrorAuction.tokensRecipient.selector, bytes4(0xfd637557));

        assertEq(MirrorAuction.sweepCurrency.selector, UpstreamAuction.sweepCurrency.selector);
        assertEq(MirrorAuction.sweepCurrency.selector, bytes4(0x7c121574));

        assertEq(MirrorAuction.sweepUnsoldTokens.selector, UpstreamAuction.sweepUnsoldTokens.selector);
        assertEq(MirrorAuction.sweepUnsoldTokens.selector, bytes4(0x5dd13ca7));
    }

    /// The finalization handoff the executor drives (`checkpoint`, `endBlock`)
    /// and the hook getter `AllowlistHook.setAuction` verifies.
    function test_finalization_and_hook_getter_selectors_equal_upstream() public pure {
        assertEq(ICcaFinalization.checkpoint.selector, UpstreamAuction.checkpoint.selector);
        assertEq(ICcaFinalization.checkpoint.selector, bytes4(0xc2c4c5c1));
        assertEq(ICcaFinalization.endBlock.selector, UpstreamAuction.endBlock.selector);
        assertEq(ICcaFinalization.endBlock.selector, bytes4(0x083c6323));
        assertEq(ICcaValidationHookView.validationHook.selector, UpstreamAuction.validationHook.selector);
        assertEq(ICcaValidationHookView.validationHook.selector, bytes4(0x8134f027));
    }

    /// The bid-gating hook: same `validate` selector and, through ABI encoding,
    /// the same argument layout.
    function test_validation_hook_matches_upstream() public pure {
        assertEq(MirrorHook.validate.selector, UpstreamHook.validate.selector);
        assertEq(MirrorHook.validate.selector, bytes4(0x22c44b5f));
        assertEq(
            abi.encodeCall(MirrorHook.validate, (1, 2, address(3), address(4), hex"05")),
            abi.encodeCall(UpstreamHook.validate, (1, 2, address(3), address(4), hex"05"))
        );
    }

    /// `LBPInitializationParams` field by field. Building both structs with
    /// NAMED fields fails to compile if a field is renamed or dropped upstream;
    /// the ABI comparisons catch a reorder or a type change.
    function test_lbp_params_struct_matches_upstream_field_for_field() public pure {
        UpstreamParams memory up =
            UpstreamParams({initialPriceX96: 11, tokensSold: 22, currencyRaised: 33});
        MirrorAuction.LBPInitializationParams memory mirror = MirrorAuction.LBPInitializationParams({
            initialPriceX96: 11,
            tokensSold: 22,
            currencyRaised: 33
        });
        assertEq(abi.encode(up), abi.encode(mirror), "same field order and types");
        // The mirror decodes upstream's encoding back to the same three words.
        MirrorAuction.LBPInitializationParams memory back =
            abi.decode(abi.encode(up), (MirrorAuction.LBPInitializationParams));
        assertEq(back.initialPriceX96, up.initialPriceX96);
        assertEq(back.tokensSold, up.tokensSold);
        assertEq(back.currencyRaised, up.currencyRaised);
        // The canonical type string the selector of anything taking it derives from.
        assertEq(
            bytes4(keccak256("onGraduation(address,(uint256,uint256,uint256))")),
            MirrorInitializer.onGraduation.selector
        );
        assertEq(MirrorInitializer.onGraduation.selector, bytes4(0x99896688));
    }

    // ---------------------------------------------------------------- factory

    /// The factory surface the app deploys through: `create` / `getAddress` are
    /// inherited from the liquidity-launcher `IDistributorFactory` and their
    /// selectors are the ones `desktop/.../auctionFlow.ts` pins; the fee
    /// controller getter is compared to its literal signature, NOT to itself.
    function test_factory_interface_matches_pin() public pure {
        assertEq(IDistributorFactory.create.selector, bytes4(keccak256("create(address,uint256,bytes,bytes32)")));
        assertEq(IDistributorFactory.create.selector, bytes4(0x4aaa5b37));
        assertEq(
            IDistributorFactory.getAddress.selector,
            bytes4(keccak256("getAddress(address,uint256,bytes,bytes32,address)"))
        );
        assertEq(IDistributorFactory.getAddress.selector, bytes4(0x1bfb751b));
        assertEq(
            IContinuousClearingAuctionFactory.protocolFeeController.selector,
            bytes4(keccak256("protocolFeeController()"))
        );
        assertEq(IContinuousClearingAuctionFactory.protocolFeeController.selector, bytes4(0xf02de3b2));
    }

    function test_bid_submitted_event_topic_is_pinned() public pure {
        assertEq(
            keccak256("BidSubmitted(uint256,address,uint256,uint128)"),
            hex"650baad5cd8ca09b8f580be220fa04ce2ba905a041f764b6a3fe2c848eb70540"
        );
        assertEq(UpstreamAuction.BidSubmitted.selector, keccak256("BidSubmitted(uint256,address,uint256,uint128)"));
    }

    // ----------------------------------------------------------- org binding

    /// `OrgBinding.summonAndBind` is the summon-and-bind entry point the
    /// deploy scripts/CLI drive; its selector derives from the `SummonParams`
    /// tuple, so the struct shape IS the ABI. DELIBERATE PIN MOVE (the P2
    /// governance tightening): the struct gained proposalThreshold/
    /// proposalTTL/timelockDelay/molochImpl and the pin moved from
    /// `0x455eb335` (the threshold-less shape) to `0x0a330b28`. Any client
    /// embedding the old selector is pinned to the insecure summon.
    function test_org_binding_summon_and_bind_selector_is_pinned() public pure {
        assertEq(
            OrgBinding.summonAndBind.selector,
            bytes4(
                keccak256(
                    "summonAndBind(bytes32,(string,string,string,uint16,bool,uint96,uint64,uint64,address,bytes32,address[],uint256[]))"
                )
            )
        );
        assertEq(OrgBinding.summonAndBind.selector, bytes4(0x0a330b28));
    }

    function test_majeur_summoner_links() public {
        // Proves the majeur pin compiles and links (creation code non-empty)
        // without constructing a DAO here — summoning is exercised at graduation.
        assertGt(type(Summoner).creationCode.length, 0);
    }
}
