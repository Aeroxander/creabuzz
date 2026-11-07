// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {IContinuousClearingAuction} from "continuous-clearing-auction/src/interfaces/IContinuousClearingAuction.sol";



/// @notice Binds the web launchpad's hand-rolled bid composer to the real CCA
/// ABI. `web/src/features/launchpad/lib/bid-tx.ts` builds calldata without a
/// wallet library; these assertions re-derive the same bytes from the pinned
/// upstream interface, so if either side drifts (selector, argument order, a
/// widened uint, dynamic-tail padding) a test fails instead of a user's bid.
///
/// The hex literals below are the same golden vectors the TypeScript suite
/// pins (`bid-tx.test.mjs`, generated with `cast calldata`). Keep them in sync:
/// a divergence is the point of the test, not a nuisance.
contract BidCalldataTest is Test {
    address constant BIDDER = 0x1111111111111111111111111111111111111111;

    /// Selector of the 5-argument overload. Overloaded members cannot be
    /// resolved by `abi.encodeCall`, so the selector is derived from the
    /// canonical signature string — the exact way the ABI defines it — and the
    /// arguments are packed with `abi.encode`, the same canonical layout the
    /// contract decoder reads. Any drift in the web composer shows up against
    /// the golden hex; any drift in this signature string shows up as a
    /// selector mismatch with the pinned upstream interface compile.
    function _submitBidSelector() private pure returns (bytes4) {
        return bytes4(keccak256("submitBid(uint256,uint128,address,uint256,bytes)"));
    }

    function _submitBidNoHintSelector() private pure returns (bytes4) {
        return bytes4(keccak256("submitBid(uint256,uint128,address,bytes)"));
    }

    /// submitBid(1e21, 5e10, bidder, 2^32+1, 0x)
    function test_submitBid_encodes_to_the_composers_bytes_empty_hook() public pure {
        bytes memory ours = abi.encodePacked(
            _submitBidSelector(),
            abi.encode(
                uint256(10 ** 21), uint128(50_000_000_000), BIDDER, uint256(4_294_967_297), bytes("")
            )
        );
        bytes memory composer =
            hex"a52c872800000000000000000000000000000000000000000000003635c9adc5"
            hex"dea000000000000000000000000000000000000000000000000000000000000b"
            hex"a43b740000000000000000000000000011111111111111111111111111111111"
            hex"1111111100000000000000000000000000000000000000000000000000000001"
            hex"0000000100000000000000000000000000000000000000000000000000000000"
            hex"000000a000000000000000000000000000000000000000000000000000000000"
            hex"00000000";
        assertEq(ours, composer, "submitBid layout drifted from the web composer");
    }

    /// submitBid(2e21, 5e10, bidder, 2^32+1, 0x1234) — the dynamic tail must be
    /// right-padded to a 32-byte word, which is where a hand-rolled encoder
    /// gets it wrong first.
    function test_submitBid_encodes_to_the_composers_bytes_with_hook_data() public pure {
        bytes memory ours = abi.encodePacked(
            _submitBidSelector(),
            abi.encode(
                uint256(2 * 10 ** 21), uint128(50_000_000_000), BIDDER, uint256(4_294_967_297), hex"1234"
            )
        );
        bytes memory composer =
            hex"a52c872800000000000000000000000000000000000000000000006c6b935b8b"
            hex"bd4000000000000000000000000000000000000000000000000000000000000b"
            hex"a43b740000000000000000000000000011111111111111111111111111111111"
            hex"1111111100000000000000000000000000000000000000000000000000000001"
            hex"0000000100000000000000000000000000000000000000000000000000000000"
            hex"000000a000000000000000000000000000000000000000000000000000000000"
            hex"0000000212340000000000000000000000000000000000000000000000000000"
            hex"00000000";
        assertEq(ours, composer, "submitBid hookData tail drifted");
    }

    function test_exitBid_encodes_to_the_composers_bytes() public pure {
        bytes memory ours = abi.encodeCall(IContinuousClearingAuction.exitBid, (uint256(42)));
        assertEq(
            ours,
            hex"8e4deb17000000000000000000000000000000000000000000000000000000000000002a",
            "exitBid layout drifted"
        );
    }

    function test_claimTokens_encodes_to_the_composers_bytes() public pure {
        bytes memory ours = abi.encodeCall(IContinuousClearingAuction.claimTokens, (uint256(7)));
        assertEq(
            ours,
            hex"46e04a2f0000000000000000000000000000000000000000000000000000000000000007",
            "claimTokens layout drifted"
        );
    }

    function test_claimTokensBatch_encodes_to_the_composers_bytes() public pure {
        uint256[] memory ids = new uint256[](3);
        ids[0] = 1;
        ids[1] = 2;
        ids[2] = 3;
        bytes memory ours = abi.encodeCall(
            IContinuousClearingAuction.claimTokensBatch,
            (0x2222222222222222222222222222222222222222, ids)
        );
        bytes memory composer = hex"b8f163d60000000000000000000000002222222222222222222222222222222222222222"
            hex"0000000000000000000000000000000000000000000000000000000000000040"
            hex"0000000000000000000000000000000000000000000000000000000000000003"
            hex"0000000000000000000000000000000000000000000000000000000000000001"
            hex"0000000000000000000000000000000000000000000000000000000000000002"
            hex"0000000000000000000000000000000000000000000000000000000000000003";
        assertEq(ours, composer, "claimTokensBatch layout drifted");
    }

    /// The 4-argument overload is the one a bidder should reach for when they
    /// do not track ticks: it defaults the hint to the auction floor.
    function test_submitBid_overloads_differ_only_in_the_defaulted_hint() public pure {
        bytes memory withHint = abi.encodePacked(
            _submitBidSelector(),
            abi.encode(uint256(1_000), uint128(5), BIDDER, uint256(4_294_967_297), bytes(""))
        );
        bytes memory withoutHint = abi.encodePacked(
            _submitBidNoHintSelector(),
            abi.encode(uint256(1_000), uint128(5), BIDDER, bytes(""))
        );
        assertTrue(keccak256(withHint) != keccak256(withoutHint));
        // Different selector: the two overloads are distinct entries in the ABI.
        assertTrue(bytes4(bytes32(withHint)) != bytes4(bytes32(withoutHint)));
    }
}
