/**
 * The chain calls behind the auction and the pool: a bid (the dollar token to Permit2, Permit2 to the auction, then the
 * bid), collecting a bid (settle it, then take its Shares), the finish steps anyone may press, handing Shares back at the
 * floor, and buying or selling in the pool through the Universal Router. Pure: pinned in `market-calls.test.ts` against
 * `cast calldata`. Bids are built with core's bid builder (`@creaton/core/launchpad/evmContractCalls.ts`).
 */
import {
  encodeFunctionData,
  encodeParameters,
  PERMIT2_ADDRESS,
  SIGNATURE_ERC20_APPROVE,
} from "@creaton/core/launchpad/evmAbi.ts";
import {
  bidPlanWithDefaultHint,
  buildBidCalls,
  encodeClaimTokens,
  encodePermit2Approve,
} from "@creaton/core/launchpad/evmContractCalls.ts";
import type { MoneyCall } from "../money/calls-v1";

const call = (to: string, data: string): MoneyCall => ({
  to: to.toLowerCase(),
  data,
  value: "0x0",
});

/** The most a bid may name as its top price: 4 times the auction's starting price (`MinBid.maxPriceMultiple`). */
export function topPriceQ96(floorQ96: bigint): bigint {
  return floorQ96 * 4n;
}

/**
 * A bid of `amount` raw dollars at the most the auction allows, so it is filled at whatever price the auction clears at.
 * The approval of the dollar token to Permit2 is left out when the wallet already allows enough.
 */
export function bidCalls(input: {
  auction: string;
  quote: string;
  owner: string;
  amount: bigint;
  floorQ96: bigint;
  permit2Allowance: bigint;
  deadline: bigint;
}): MoneyCall[] {
  const plan = bidPlanWithDefaultHint(
    {
      maxPriceQ96: topPriceQ96(input.floorQ96),
      amount: input.amount,
      owner: input.owner,
      hookData: "0x",
    },
    input.floorQ96,
  );
  return buildBidCalls({
    auction: input.auction,
    currency: input.quote,
    plan,
    needsUnderlyingAllowance: input.permit2Allowance < input.amount,
    permit2Deadline: input.deadline,
  }).map((c) => call(c.to, c.data));
}

/** Settle a bid after the auction ended (its dollars back where not used), then, when it bought Shares, take them. */
export function collectCalls(
  auction: string,
  bidId: bigint,
  steps: {
    /** The call that settles the bid (`exitCall`, by what the auction says), or null when it was settled already. */
    exit: MoneyCall | null;
    claim: boolean;
  },
): MoneyCall[] {
  return [
    ...(steps.exit ? [steps.exit] : []),
    ...(steps.claim ? [call(auction, encodeClaimTokens(bidId))] : []),
  ];
}

/** The auction's finish steps, in order; anyone may press each (the server's helper usually does). */
export type FinishStep = "openPool" | "settle" | "sweep";
export function finishCall(finisher: string, step: FinishStep): MoneyCall {
  return call(finisher, encodeFunctionData(`${step}()`, [], []));
}

/**
 * The finish steps still to send for an ended sale (`Finisher`): the pool step always comes first, a sale under its
 * minimum included (it also writes the auction's last checkpoint, and closing is refused until it ran). Until it ran
 * the auction cannot say whether the minimum was reached, so the server's record decides; once it ran, the auction
 * does. So a record that was wrong costs one more press, never a sale that cannot be closed.
 */
export function finishSteps(input: {
  /** The pool step has not run yet for this auction. */
  stepPending: boolean;
  /** The auction says its minimum was reached (only meaningful once the pool step ran). */
  graduated: boolean;
  /** The server's record says the bids reached the minimum. */
  reachedByRecord: boolean;
}): FinishStep[] {
  if (input.stepPending)
    return input.reachedByRecord
      ? ["openPool", "settle", "sweep"]
      : ["openPool", "sweep"];
  return input.graduated ? ["settle", "sweep"] : ["sweep"];
}

/** Hand `amount` Shares back at the floor: let the Treasury burn them, then ask for the slice. */
export function handBackCalls(
  shares: string,
  treasury: string,
  amount: bigint,
): MoneyCall[] {
  return [
    call(
      shares,
      encodeFunctionData(
        SIGNATURE_ERC20_APPROVE,
        ["address", "uint256"],
        [treasury, amount],
      ),
    ),
    call(
      treasury,
      encodeFunctionData("handBack(uint256)", ["uint256"], [amount]),
    ),
  ];
}

/** A pool's key, as the Finisher gives it (`Finisher.poolKey()`). */
export interface PoolKey {
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
}

/** The Universal Router's command for a v4 swap, and the v4 router's actions (v4-periphery `Actions`). */
const V4_SWAP = "0x10";
const SWAP_EXACT_IN_SINGLE = "06";
const SETTLE_ALL = "0c";
const TAKE_ALL = "0f";

/**
 * Buy or sell in the pool through the Universal Router: `amountIn` of the token going in (dollars to buy, Shares to
 * sell) for at least `minOut` of the other. Three calls: the token to Permit2 (when not allowed yet), Permit2 to the
 * router, then the router's swap. The same shape `contracts/next/test/UniversalRouter.t.sol` sends on a Sepolia fork.
 */
export function tradeCalls(input: {
  router: string;
  key: PoolKey;
  /** The token going in. */
  tokenIn: string;
  amountIn: bigint;
  minOut: bigint;
  permit2Allowance: bigint;
  deadline: bigint;
}): MoneyCall[] {
  const zeroForOne =
    input.tokenIn.toLowerCase() === input.key.currency0.toLowerCase();
  const tokenOut = zeroForOne ? input.key.currency1 : input.key.currency0;
  const poolKey = [
    input.key.currency0,
    input.key.currency1,
    BigInt(input.key.fee),
    BigInt(input.key.tickSpacing),
    input.key.hooks,
  ];
  const swap = encodeParameters(
    [
      {
        tuple: [
          {
            tuple: ["address", "address", "uint24", "int24", "address"],
          },
          "bool",
          "uint128",
          "uint128",
          "bytes",
        ],
      },
    ],
    [[poolKey, zeroForOne, input.amountIn, input.minOut, "0x"]],
  );
  const settle = encodeParameters(
    ["address", "uint256"],
    [input.tokenIn, input.amountIn],
  );
  const take = encodeParameters(
    ["address", "uint256"],
    [tokenOut, input.minOut],
  );
  const v4Input = encodeParameters(
    ["bytes", { array: "bytes" }],
    [`0x${SWAP_EXACT_IN_SINGLE}${SETTLE_ALL}${TAKE_ALL}`, [swap, settle, take]],
  );
  return [
    ...(input.permit2Allowance < input.amountIn
      ? [
          call(
            input.tokenIn,
            encodeFunctionData(
              SIGNATURE_ERC20_APPROVE,
              ["address", "uint256"],
              [PERMIT2_ADDRESS, input.amountIn],
            ),
          ),
        ]
      : []),
    call(
      PERMIT2_ADDRESS,
      encodePermit2Approve(
        input.tokenIn,
        input.router,
        input.amountIn,
        input.deadline,
      ),
    ),
    call(
      input.router,
      encodeFunctionData(
        "execute(bytes,bytes[],uint256)",
        ["bytes", { array: "bytes" }, "uint256"],
        [V4_SWAP, [v4Input], input.deadline],
      ),
    ),
  ];
}

/** Reads the market screens need. */
export const MARKET_READS = {
  allowance: (owner: string, spender: string) =>
    encodeFunctionData(
      "allowance(address,address)",
      ["address", "address"],
      [owner, spender],
    ),
  balanceOf: (owner: string) =>
    encodeFunctionData("balanceOf(address)", ["address"], [owner]),
  totalSupply: encodeFunctionData("totalSupply()", [], []),
  poolKey: encodeFunctionData("poolKey()", [], []),
  poolManager: encodeFunctionData("poolManager()", [], []),
  stage: encodeFunctionData("stage()", [], []),
  retryBlock: encodeFunctionData("retryBlock()", [], []),
  strategy: encodeFunctionData("strategy()", [], []),
  registeredPoolId: (id: string) =>
    encodeFunctionData("registeredPoolIds(bytes32)", ["bytes32"], [id]),
  bid: (id: bigint) => encodeFunctionData("bids(uint256)", ["uint256"], [id]),
  clearingPrice: encodeFunctionData("clearingPrice()", [], []),
  isGraduated: encodeFunctionData("isGraduated()", [], []),
  claimBlock: encodeFunctionData("claimBlock()", [], []),
  endBlock: encodeFunctionData("endBlock()", [], []),
  checkpoint: (block: bigint) =>
    encodeFunctionData("checkpoints(uint64)", ["uint64"], [block]),
  extsload: (slot: string) =>
    encodeFunctionData("extsload(bytes32)", ["bytes32"], [slot]),
} as const;
