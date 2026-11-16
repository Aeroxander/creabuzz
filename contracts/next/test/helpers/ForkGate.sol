// SPDX-License-Identifier: MIT
pragma solidity >=0.8.26;

import {Test} from "forge-std/Test.sol";
import {ForkPick} from "./ForkPick.sol";

/// @notice What every Sepolia fork suite needs before it forks: the addresses of the real Uniswap deployments, the pinned
/// block, and the decision (via `ForkPick`) of which block to fork or whether to skip, made by asking the node what it can
/// serve. Shared by the milestone 1 stack (`Stack`) and the milestone 3 platform (`Platform`).
abstract contract ForkGate is Test {
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    // Real Sepolia deployments (verified by test/ForkFacts.t.sol). See docs/next-version/M1-FACTS.md for sources.
    address internal constant SEPOLIA_POOL_MANAGER = 0xE03A1074c86CFeDd5C142C4F04F1a1536e203543;
    address internal constant SEPOLIA_POSITION_MANAGER = 0x429ba70129df741B2Ca2a85BC3A2a3328e5c09b4;
    address internal constant SEPOLIA_UNIVERSAL_ROUTER = 0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b;
    address internal constant SEPOLIA_POOL_SWAP_TEST = 0x9B6b46e2c869aa39918Db7f52f5557FE577B6eEe;

    /// @notice The block the fork suites are written against (the numbers quoted in the reports were read there).
    /// Whether it can be forked is decided at run time by `ForkPick`: the public node keeps state for only a few dozen
    /// blocks, so unless the node is an archive node (or `SEPOLIA_FORK_TRUST_CACHE=true` says Foundry's local cache
    /// holds the pin) the suites fork at a recent block instead, or skip with a message when a block was named.
    /// `SEPOLIA_FORK_BLOCK` names a block.
    uint256 internal constant SEPOLIA_PIN = 12_146_937;

    /// @dev How many unrelated accounts a node must answer for a block before the suites trust it with that block.
    uint256 private constant PROBE_ACCOUNTS = 16;
    /// @dev A block more than this far behind the head is "old": the public node answers such blocks unreliably, so an
    /// old block must pass `PROBE_ACCOUNTS_OLD` reads (an archive node passes them all; a flaky node almost never does).
    uint256 private constant OLD_BLOCK_AGE = 256;
    uint256 private constant PROBE_ACCOUNTS_OLD = 64;

    /// @dev Asks the node what it can serve (no fork is created yet) and hands the answers to `ForkPick`.
    function _planFork(string memory rpc) internal returns (ForkPick.Plan memory) {
        uint256 requested = vm.envOr("SEPOLIA_FORK_BLOCK", uint256(0));
        uint256 chosen = requested != 0 ? requested : SEPOLIA_PIN;
        // The probe costs about twenty requests, so the first suite of a run does it and the rest reuse its answer
        // (the environment is shared by the suites of one `forge test` process). Same answer, same fallback block.
        string memory memo = string.concat("BUZZ_FORK_PROBE_", vm.toString(chosen));
        (bool reachable, uint256 head, bool served) = _probeNode(rpc, chosen, memo);
        return
            ForkPick.decide(
                reachable, head, requested, SEPOLIA_PIN, served, vm.envOr("SEPOLIA_FORK_TRUST_CACHE", false)
            );
    }

    function _probeNode(string memory rpc, uint256 chosen, string memory memo)
        private
        returns (bool reachable, uint256 head, bool served)
    {
        string memory known = vm.envOr(memo, string(""));
        if (bytes(known).length != 0) {
            string[] memory parts = vm.split(known, ",");
            return (_isOne(parts[0]), vm.parseUint(parts[1]), _isOne(parts[2]));
        }
        try vm.rpc(rpc, "eth_blockNumber", "[]") returns (bytes memory n) {
            reachable = true;
            head = _quantity(n);
        } catch {}
        // Forking reads many accounts' balances, nonces and code. The public node answers a block a few thousand blocks
        // old from back ends that disagree (measured: one read of that block passed, the next failed with "Archive
        // requests require a personal token", and a different account failed on a different run), so a block counts as
        // served only when many unrelated accounts all answer. A fresh block, or an archive node, passes every one.
        served = reachable;
        string memory block_ = _hexQuantity(chosen);
        uint256 reads = chosen + OLD_BLOCK_AGE < head ? PROBE_ACCOUNTS_OLD : PROBE_ACCOUNTS;
        for (uint256 i; i < reads && served; ++i) {
            served = _rpcOk(
                rpc,
                "eth_getBalance",
                i == 0 ? SEPOLIA_POOL_MANAGER : address(uint160(uint256(keccak256(abi.encode("probe", i))))),
                block_
            );
        }
        if (served) served = _rpcOk(rpc, "eth_getTransactionCount", SEPOLIA_POOL_MANAGER, block_);
        if (served) served = _rpcOk(rpc, "eth_getCode", SEPOLIA_POOL_MANAGER, block_);
        vm.setEnv(memo, string.concat(reachable ? "1" : "0", ",", vm.toString(head), ",", served ? "1" : "0"));
    }

    function _isOne(string memory v) private pure returns (bool) {
        return keccak256(bytes(v)) == keccak256("1");
    }

    function _rpcOk(string memory rpc, string memory method, address who, string memory blockHex)
        private
        returns (bool)
    {
        try vm.rpc(rpc, method, string.concat('["', vm.toString(who), '","', blockHex, '"]')) returns (bytes memory) {
            return true;
        } catch {
            return false;
        }
    }

    function _quantity(bytes memory big) private pure returns (uint256 n) {
        for (uint256 i; i < big.length; ++i) {
            n = (n << 8) | uint8(big[i]);
        }
    }

    function _hexQuantity(uint256 n) private pure returns (string memory) {
        bytes16 digits = "0123456789abcdef";
        bytes memory out;
        do {
            out = bytes.concat(digits[n & 15], out);
            n >>= 4;
        } while (n != 0);
        return string.concat("0x", string(out));
    }
}
