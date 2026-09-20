// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import {OrgAllowance} from "../src/OrgAllowance.sol";
import {OrgBinding} from "../src/OrgBinding.sol";
import {Moloch} from "majeur/src/Moloch.sol";

/// @notice Phase 8 end-to-end anvil orchestration: deploy the OrgAllowance
/// ledger, summon a majeur DAO with the org root's holders as initial
/// shareholders, transfer the allowance ledger's ownership to the DAO, and
/// print the binding values the CLI republishes as `content.onchain` on the
/// kind:37010 root (docs/nips/NIP-ORG.md, "Opt-in onchain binding").
///
/// Ownership handover is the documented DEV simplification: the deployer is
/// still the OrgAllowance owner at this point and calls `setOwner(dao)`
/// directly. The production path is a DAO governance proposal (see
/// OrgBinding.sol NatSpec for the atomic `initCall` tightening).
///
/// Per-holder shares are 1:1 (1e18 wei of shares per holder) — the initial
/// mint happens ONLY at bind time. Later seat changes are governance
/// proposals, never auto-mutations of share supply.
///
/// NDOC — local anvil flow:
///
/// ```bash
/// # 0. chain up (or reuse a running anvil on 127.0.0.1:8545)
/// anvil --port 8545 --chain-id 31337 &
///
/// # 1. summon + bind + hand over (anvil account 0 = community owner)
/// forge script script/DeployOrgDao.s.sol --rpc-url anvil --broadcast \
///   --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
///
/// # 2. verify shares landed
/// cast call 0x<SHARES> "balanceOf(address)(uint256)" 0xf39F... --rpc-url anvil
///
/// # 3. publish the Nostr side of the binding
/// buzz org bind --root <node-d> --chain anvil-31337 --dao 0x<DAO>
/// ```
contract DeployOrgDao is Script {
    /// @notice Broadcast deployment log.
    event OrgDaoBound(
        bytes32 indexed rootId, address indexed binding, address indexed dao, address shares, address allowance
    );

    function run() external returns (address bindingAddr, address dao, address shares, address allowanceAddr) {
        bytes32 rootId = bytes32(vm.envOr("ORG_ROOT_ID", uint256(1)));
        address secondHolder = vm.envOr("ORG_SECOND_HOLDER", 0x70997970C51812dc3A010C7d01b50e0d17dc79C8);

        uint256 pk = vm.envUint("PRIVATE_KEY");
        address ownerAddr = vm.addr(pk);

        vm.startBroadcast(pk);

        // 1. The value-layer ledger (Phase 7 pattern; owner = deployer).
        OrgAllowance allowance = new OrgAllowance();
        allowanceAddr = address(allowance);

        // 2. The binding record keeper (deploys its own majeur Summoner).
        OrgBinding binding = new OrgBinding();

        // 3. Summon + bind: root holders -> shares, 1:1.
        address[] memory holders = new address[](2);
        holders[0] = ownerAddr;
        holders[1] = secondHolder;
        uint256[] memory initShares = new uint256[](2);
        initShares[0] = 1e18;
        initShares[1] = 1e18;

        OrgBinding.SummonParams memory p = OrgBinding.SummonParams({
            name: vm.envOr("ORG_NAME", string("Buzz Org")),
            symbol: vm.envOr("ORG_SYMBOL", string("BUZZ")),
            uri: "",
            quorumBps: 500, // summonFast default
            ragequittable: true,
            salt: keccak256(abi.encodePacked(rootId)),
            holders: holders,
            shares: initShares
        });
        dao = binding.summonAndBind(rootId, p);
        shares = address(Moloch(payable(dao)).shares());

        // 4. Hand the allowance ledger to the DAO (dev simplification of a
        //    governance proposal — the DAO now controls setSpender/
        //    setAllowance; per-agent keys inside the ledger are unchanged).
        allowance.setOwner(dao);

        vm.stopBroadcast();

        emit OrgDaoBound(rootId, address(binding), dao, shares, allowanceAddr);
        console2.log("rootId:", vm.toString(rootId));
        console2.log("OrgBinding:", address(binding));
        console2.log("Summoner:", address(binding.summoner()));
        console2.log("DAO:", dao);
        console2.log("Shares:", shares);
        console2.log("OrgAllowance:", allowanceAddr);
        console2.log("OrgAllowance.owner (now the DAO):", allowance.owner());
        console2.log("chain: anvil-31337");
    }
}
