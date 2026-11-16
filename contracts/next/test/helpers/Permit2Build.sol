// SPDX-License-Identifier: MIT
pragma solidity >=0.8.17;

// Not a script. This file exists only so Foundry compiles Uniswap's Permit2 (pinned to exactly solc 0.8.17 upstream) in
// its own version group; tests then read its code from the build output with `vm.getDeployedCode("Permit2.sol:Permit2")`.
import {Permit2} from "permit2/src/Permit2.sol";
