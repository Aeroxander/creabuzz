// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ShareToken} from "./ShareToken.sol";
import {Treasury} from "./Treasury.sol";
import {Vester} from "./Vester.sol";
import {Rounds} from "./Rounds.sol";
import {Pair} from "./Pair.sol";

/// @title Parts
/// @notice Makes, in its constructor, the five implementations every project's clones copy: ShareToken, Treasury, Vester,
/// Rounds and Pair. The Launcher reads their addresses once, in its own constructor. They live here, not in the Launcher,
/// only because the Launcher's creation code cannot hold all of them under the 49,152-byte limit. Each implementation locks
/// itself in its constructor, takes no setting, and has no owner, so the code that runs for a project is exactly this
/// contract's (its deployed code can be compared with the build).
contract Parts {
    /// @notice The ShareToken the clones copy.
    address public immutable shareImpl;
    /// @notice The Treasury the clones copy.
    address public immutable treasuryImpl;
    /// @notice The Vester the clones copy.
    address public immutable vesterImpl;
    /// @notice The Rounds the clones copy.
    address public immutable roundsImpl;
    /// @notice The Pair the clones copy.
    address public immutable pairImpl;

    constructor() {
        (shareImpl, treasuryImpl, vesterImpl) =
            (address(new ShareToken()), address(new Treasury()), address(new Vester()));
        (roundsImpl, pairImpl) = (address(new Rounds()), address(new Pair()));
    }
}
