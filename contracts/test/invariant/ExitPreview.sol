// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice The leave-with-your-share screen's arithmetic, line for line from
/// `web/src/features/launchpad/lib/ragequit-position.ts` (`burnableShares`, `exitDenominator`,
/// `deriveClaimablePosition`). The invariant and fuzz tests hold the chain's `ragequit` to it, and
/// `RagequitPreviewFfi.t.sol` holds this port to the TypeScript itself, so a change to either side fails a test.
library ExitPreview {
    /// @dev `burnableShares(balance, locked)`: what the holder can give up, the balance less the lock.
    function burnable(uint256 balance, uint256 locked) internal pure returns (uint256) {
        return locked >= balance ? 0 : balance - locked;
    }

    /// @dev `exitDenominator`: everything outstanding except what the DAO holds itself and what the lock still holds
    /// back (D72).
    function denominator(uint256 sharesTotal, uint256 lootTotal, uint256 daoHeld, uint256 lockedTotal)
        internal
        pure
        returns (uint256)
    {
        uint256 outstanding = sharesTotal + lootTotal;
        uint256 left = daoHeld >= outstanding ? 0 : outstanding - daoHeld;
        return lockedTotal >= left ? 0 : left - lockedTotal;
    }

    /// @dev One row of `deriveClaimablePosition`: floor(pool * amt / total), zero for a zero denominator or burn.
    function due(uint256 pool, uint256 amt, uint256 total) internal pure returns (uint256) {
        return total == 0 || amt == 0 ? 0 : Math.mulDiv(pool, amt, total);
    }
}
