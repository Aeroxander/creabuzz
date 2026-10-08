import { createConfig } from "ponder";

import { limitBreakAmmAbi } from "./abis/limitBreakAmm.ts";

/**
 * Where to read from. Everything is an environment variable so the same code serves a local test chain and, one day,
 * a real one; there are no defaults for the AMM's address, because indexing the wrong contract is worse than not
 * starting.
 *
 *   LBAMM_ADDRESS        the AMM to index (required)
 *   PONDER_RPC_URL       the chain's RPC (default: a local node)
 *   PONDER_CHAIN_ID      the chain's id (default: 31337)
 *   PONDER_START_BLOCK   the block the AMM was deployed in (default: 0)
 */
const amm = process.env.LBAMM_ADDRESS;
if (!amm || !/^0x[0-9a-fA-F]{40}$/.test(amm)) {
  throw new Error(
    "set LBAMM_ADDRESS to the AMM contract's address (0x + 40 hex characters)",
  );
}

export default createConfig({
  chains: {
    chain: {
      id: Number(process.env.PONDER_CHAIN_ID ?? 31337),
      rpc: process.env.PONDER_RPC_URL ?? "http://127.0.0.1:8545",
      pollingInterval: 500,
    },
  },
  contracts: {
    LimitBreakAMM: {
      chain: "chain",
      abi: limitBreakAmmAbi,
      address: amm as `0x${string}`,
      startBlock: Number(process.env.PONDER_START_BLOCK ?? 0),
    },
  },
});
