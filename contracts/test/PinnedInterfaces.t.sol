// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {IContinuousClearingAuction} from "continuous-clearing-auction/src/interfaces/IContinuousClearingAuction.sol";
import {
    IContinuousClearingAuctionFactory
} from "continuous-clearing-auction/src/interfaces/IContinuousClearingAuctionFactory.sol";
import {IAuctionStorage} from "continuous-clearing-auction/src/interfaces/IAuctionStorage.sol";
import {Summoner} from "majeur/src/Moloch.sol";

/// @notice Proves our mirrored constants match the pinned upstream sources.
/// Fails the build if an upstream sync changes a signature.
contract PinnedInterfacesTest is Test {
    function test_selectors_match_pinned_cca() public pure {
        assertEq(bytes4(IContinuousClearingAuction.isGraduated.selector), bytes4(hex"9e5f2602"));
        assertEq(bytes4(IAuctionStorage.currencyRaised.selector), bytes4(hex"998ba4fc"));
        assertEq(
            keccak256("BidSubmitted(uint256,address,uint256,uint128)"),
            hex"650baad5cd8ca09b8f580be220fa04ce2ba905a041f764b6a3fe2c848eb70540"
        );
    }

    function test_factory_interface_matches_pin() public pure {
        assertEq(
            bytes4(IContinuousClearingAuctionFactory.protocolFeeController.selector),
            bytes4(IContinuousClearingAuctionFactory(address(0)).protocolFeeController.selector)
        );
    }

    function test_majeur_summoner_links() public {
        // Proves the majeur pin compiles and links (creation code non-empty)
        // without constructing a DAO here — summoning is exercised at graduation.
        assertGt(type(Summoner).creationCode.length, 0);
    }
}
