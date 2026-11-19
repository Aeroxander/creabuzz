// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";

/// @notice Every first-party file that ships is pinned to the one compiler the project builds with (0.8.37), like the rest of
/// the contracts: a deploy script that floats (`^0.8.30`) could be built by another compiler than the one that was tested.
/// RollingCap is the one exception: it is a copy of the file in contracts/next and keeps its own range.
contract PragmaTest is Test {
    function _pragma(string memory path) internal view returns (string memory line) {
        string memory src = vm.readFile(path);
        bytes memory b = bytes(src);
        uint256 at = type(uint256).max;
        bytes memory needle = bytes("pragma solidity ");
        for (uint256 i; i + needle.length < b.length; ++i) {
            bool hit = true;
            for (uint256 j; j < needle.length; ++j) {
                if (b[i + j] != needle[j]) {
                    hit = false;
                    break;
                }
            }
            if (hit) {
                at = i;
                break;
            }
        }
        require(at != type(uint256).max, "no pragma");
        uint256 end = at;
        while (b[end] != ";") ++end;
        bytes memory out = new bytes(end - at + 1);
        for (uint256 i; i < out.length; ++i) {
            out[i] = b[at + i];
        }
        return string(out);
    }

    function test_everyShippedFileIsPinnedToTheProjectCompiler() public view {
        string[12] memory files = [
            "src/Interfaces.sol",
            "src/Launcher.sol",
            "src/Pair.sol",
            "src/Parts.sol",
            "src/PlayDollar.sol",
            "src/PotMath.sol",
            "src/ShareToken.sol",
            "src/TaskBook.sol",
            "src/Treasury.sol",
            "src/Vester.sol",
            "script/DeployPot.s.sol",
            "src/RollingCap.sol"
        ];
        for (uint256 i; i < files.length; ++i) {
            string memory want = keccak256(bytes(files[i])) == keccak256(bytes("src/RollingCap.sol"))
                ? "pragma solidity ^0.8.30;"
                : "pragma solidity 0.8.37;";
            assertEq(_pragma(files[i]), want, files[i]);
        }
    }
}
