// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import {OrgAllowance} from "../src/OrgAllowance.sol";

/// @notice Deploy OrgAllowance (the dev enforcement ledger for NIP-ORG budgets).
///
/// Owner = msg.sender. With `--sender <addr>` (or a `--private-key`) that key
/// becomes the community owner; the same (or another) key is then granted as
/// the per-subject spender (the harness backend EVM key in dev).
///
/// ENFORCED PAYOUTS (docs/dao-os.md R3): set `ORG_ALLOWANCE_TREASURY` to the
/// custody address and the script wires it as `treasury`. That address must
/// then `approve(<ORG>, amount)` each token agents may spend; agents pay out
/// with `spendTo(subject, token, epoch, amount, to)`, which debits the ledger and
/// moves the tokens in one call. Without a treasury only the advisory `spend`
/// (accounting, no transfer) is usable.
///
/// NDOC — local anvil smoke flow:
///
/// ```bash
/// # 1. start a local chain (from contracts/)
/// anvil &
///
/// # 2. deploy (anvil account 0 = owner)
/// forge script script/DeployOrgAllowance.s.sol \
///   --rpc-url anvil --broadcast \
///   --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
///
/// # 3. grant the harness backend key (anvil account 1) as spender for the
/// #    agent's 32-byte Nostr pubkey (verbatim bytes32, no keccak)
/// cast send 0x<ORG> "setSpender(bytes32,address)" \
///   0xd1a7d9d1a2f0e13a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a \
///   0x70997970C51812dc3A010C7d01b50e0d17dc79C8 \
///   --rpc-url anvil \
///   --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
///
/// # 4. grant a 100e6 allowance for epoch 1 (e.g. day epoch = unix_ts/86400)
/// cast send 0x<ORG> "setAllowance(bytes32,address,uint64,uint256)" \
///   0xd1a7d9d1a2f0e13a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a \
///   0x<USDC_TOKEN> 1 100000000 \
///   --rpc-url anvil \
///   --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
///
/// # 5. spend as the backend key, then read the ledger. `spend` is ADVISORY
/// #    (accounting only); with a treasury wired use the enforced payout:
/// #    cast send 0x<ORG> "spendTo(bytes32,address,uint64,uint256,address)" ... <TO>
/// #    (epoch must be <= unix_ts / 86400, e.g. `cast call 0x<ORG> "currentEpoch(bytes32)(uint64)" <subject>`)
/// cast send 0x<ORG> "spend(bytes32,address,uint64,uint256)" \
///   0xd1a7d9d1a2f0e13a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a \
///   0x<USDC_TOKEN> 1 25000000 \
///   --rpc-url anvil \
///   --private-key 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
/// cast call 0x<ORG> "remainingOf(bytes32,address,uint64)(uint256)" \
///   0xd1a7d9d1a2f0e13a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a \
///   0x<USDC_TOKEN> 1 --rpc-url anvil
/// ```
contract DeployOrgAllowance is Script {
    /// @notice Broadcast deployment log.
    event OrgAllowanceDeployed(address indexed org, address indexed owner);

    function run() external returns (address org) {
        vm.startBroadcast();
        org = address(new OrgAllowance());
        address treasury = vm.envOr("ORG_ALLOWANCE_TREASURY", address(0));
        if (treasury != address(0)) OrgAllowance(org).setTreasury(treasury);
        vm.stopBroadcast();
        emit OrgAllowanceDeployed(org, OrgAllowance(org).owner());
        console2.log("OrgAllowance deployed at:", org);
        console2.log("owner:", OrgAllowance(org).owner());
        console2.log("treasury (spendTo custody):", OrgAllowance(org).treasury());
    }
}
