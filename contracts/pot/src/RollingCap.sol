// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title RollingCap
/// @notice A limit on how much may be used in any stretch of `window` seconds, kept in a fixed ring of storage slots.
/// @dev The window is cut into `buckets` equal parts. An amount is remembered in the part it was used in and counted
/// until that part is `buckets` parts old, so it counts for at least `window` seconds and at most `window` plus one part.
/// That makes the limit safe at any moment: in no stretch of `window` seconds can more than the cap be used, which a
/// plain "reset every day" counter cannot promise (it lets twice the cap through around the reset). The price is that a
/// used amount can stay counted for up to one part (`window / buckets`) longer than `window`. Each ring has
/// `buckets + 1` slots, each holding the part number in the top 64 bits and the amount used in it in the low 192 bits.
library RollingCap {
    /// @notice The slots of one limit.
    struct Ring {
        mapping(uint256 => uint256) slot;
    }

    uint256 private constant MASK = type(uint192).max;

    /// @notice Using `amount` now would pass the cap.
    error CapExceeded(uint256 used, uint256 amount, uint256 cap);
    /// @notice The amount does not fit in 192 bits.
    error CapAmountTooLarge();

    /// @notice How much is counted against the limit right now.
    /// @param window Length of the stretch, in seconds. Must be a multiple of `buckets`.
    /// @param buckets How many equal parts the window is cut into.
    function used(Ring storage r, uint256 window, uint256 buckets) internal view returns (uint256 sum) {
        uint256 cur = block.timestamp / (window / buckets);
        for (uint256 i; i <= buckets; ++i) {
            uint256 e = r.slot[i];
            if ((e >> 192) + buckets >= cur) sum += e & MASK;
        }
    }

    /// @notice Count `amount` against the limit, or revert when that would pass `cap`.
    function consume(Ring storage r, uint256 window, uint256 buckets, uint256 cap, uint256 amount) internal {
        if (amount > MASK) revert CapAmountTooLarge();
        uint256 already = used(r, window, buckets);
        if (already + amount > cap) revert CapExceeded(already, amount, cap);
        uint256 cur = block.timestamp / (window / buckets);
        uint256 e = r.slot[cur % (buckets + 1)];
        uint256 inBucket = (e >> 192) == cur ? e & MASK : 0;
        r.slot[cur % (buckets + 1)] = (cur << 192) | (inBucket + amount);
    }
}
