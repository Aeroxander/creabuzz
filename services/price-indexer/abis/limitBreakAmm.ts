/**
 * The events of the Limit Break AMM this indexer reads, as the deployed contract emits them. Only events are listed:
 * the indexer calls nothing. The AMM is evaluation-only software (see docs/v3-review/LBAMM.md), so this describes a
 * contract the caller deployed locally.
 */
export const limitBreakAmmAbi = [
  {
    type: "event",
    name: "PoolCreated",
    inputs: [
      { name: "poolType", type: "address", indexed: true },
      { name: "token0", type: "address", indexed: true },
      { name: "token1", type: "address", indexed: true },
      { name: "poolId", type: "bytes32", indexed: false },
      { name: "poolHook", type: "address", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Swap",
    inputs: [
      { name: "poolId", type: "bytes32", indexed: true },
      { name: "recipient", type: "address", indexed: true },
      { name: "zeroForOne", type: "bool", indexed: false },
      { name: "amountIn", type: "uint256", indexed: false },
      { name: "amountOut", type: "uint256", indexed: false },
      { name: "lpFeeAmount", type: "uint256", indexed: false },
    ],
  },
] as const;
