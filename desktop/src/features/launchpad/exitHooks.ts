/**
 * The "My bids" surface for the launchpad: onchain bid-state reads via
 * `evm_call`, exit/claim legality derivation straight from the vendored CCA
 * semantics, and the sequential exit/claim transaction orchestrator.
 *
 * Contract semantics this module encodes (citations into the vendored upstream
 * source at `contracts/lib/continuous-clearing-auction/src`):
 *
 * - `Bid` (libraries/BidLib.sol:6-14) is `startBlock`, `startCumulativeMps`,
 *   `exitedBlock`, `maxPrice`, `owner`, `amountQ96`, `tokensFilled`.
 *   `tokensFilled` starts at 0 (BidStorage.sol:35), is recorded at exit
 *   (`_processExit`, ContinuousClearingAuction.sol:409) and zeroed by a claim
 *   (`_internalClaimTokens`, :658) — so `exited && tokensFilled == 0` reads as
 *   "settled, nothing left to claim".
 * - `exitBid` (ContinuousClearingAuction.sol:495) requires the auction over
 *   (`onlyAfterAuctionIsOver`, StepStorage.sol:50-52) and a non-exited bid.
 *   A non-graduated auction refunds in full (:499-501). On a graduated one the
 *   bid's maxPrice must be STRICTLY above the final clearing price (:503-504) —
 *   `exitBid` is the fully filled path and still records `tokensFilled` for a
 *   later claim (:506-510).
 * - `exitPartiallyFilledBid` (:514-601) takes two checkpoint hints
 *   (interfaces/IContinuousClearingAuction.sol:184-185):
 *   `lastFullyFilledCheckpointBlock` is the last checkpointed block whose
 *   clearing price is strictly < bid.maxPrice (validated: the next checkpoint is
 *   at >= maxPrice and the hint is >= bid.startBlock, :541-547), and `outbidBlock`
 *   is the first checkpointed block whose clearing price is strictly > bid.maxPrice
 *   (validated against its predecessor being <= maxPrice, :568-572), or 0 when the
 *   bid is partially filled at the end of the auction (:573-582 requires the
 *   auction over and the final clearing price == maxPrice exactly). Before the
 *   end block a partial exit is legal only once the bid is outbid on a graduated
 *   auction (:526-532, :559) — so the plan's "no exit before graduation"
 *   shorthand holds for the live window, but after the end block every
 *   non-exited bid can exit (refund in full when the auction did not graduate).
 * - `claimTokens` / `claimTokensBatch` (:604-643) need the claim block
 *   (`onlyAfterClaimBlock`, StepStorage.sol:55-58), a graduated auction
 *   (:606, :623) and a PRIOR exit — `_internalClaimTokens` reverts `BidNotExited`
 *   when `exitedBlock == 0` (:649-651). Anyone may claim; the tokens always go to
 *   the bid owner (:611).
 *
 * Partial-exit hints are only emitted from MATERIALIZED checkpoints (the
 * `checkpoints(uint64)` linked list, CheckpointStorage.sol:51-53; `next` is the
 * `MAX_BLOCK_NUMBER` sentinel at the tail, :10-11). When the decisive checkpoint
 * is not on chain yet — the final checkpoint at `endBlock` right after the
 * auction, or the outbid crossing after `forceIterateOverTicks` advanced
 * `clearingPrice()` WITHOUT inserting a checkpoint (ContinuousClearingAuction.sol:
 * :432-460) — the plan is `checkpointThenExit`: send `checkpoint()` first
 * (callable by anyone, materializes exactly that checkpoint via `_checkpointAtBlock`,
 * :240-244 and :335-337), then re-derive fresh hints for the exit step.
 *
 * `currentBlock` is `eth_blockNumber`, the read-only proxy for the contract's
 * `_getBlockNumberish()` (blocknumberish/src/BlockNumberish.sol — `block.number`
 * outside Arbitrum/Unichain). The `evm_*` IPC surface has no block-number command,
 * so this one read goes over plain JSON-RPC like the app's existing `chainRpc.ts`
 * adapter does (`ethRpc`, chainRpc.ts:42-66 and its `eth_blockNumber` call at
 * :101). All CONTRACT state is read through `evm_call` view calldata built with
 * the `evmCalls.ts` encoder.
 *
 * Flow contract (mirrors `bidHooks.ts`): every failure names its step
 * (Review-Proven Rule 1), a mined revert resolves as `status: "reverted"` receipt
 * data and is a failed step, and retry re-sends only the remaining steps — the
 * completed `checkpoint()` step is never re-sent after a failed exit
 * (Review-Proven Rule 5 prefix-consistency).
 *
 * Testable under `node --test` (`exitHooks.test.mjs`): the derivation, the
 * reducer, the orchestrator, and the view calldata builders/decoders are pure or
 * dependency-injected; only `useMyBids` / `useExitFlow` and the thin IPC wrappers
 * touch the app runtime.
 */

import * as React from "react";

import {
  evmChainStatus,
  evmEthCall,
  evmSendTransaction,
  evmWalletStatus,
  type EvmSendArgs,
  type TxReceipt,
} from "@/features/launchpad/bidHooks";
import { decodeUint256, hexToBigInt } from "@/features/launchpad/lib/chainRpc";
import {
  buildClaimTokensBatchCall,
  buildClaimTokensCall,
  buildExitBidCall,
  buildExitPartiallyFilledBidCall,
  encodeFunctionData,
  type EvmCall,
  selectorOf,
} from "@/features/launchpad/lib/evmCalls";
import { invokeTauri } from "@/shared/api/tauri";

export { evmChainStatus, evmWalletStatus };

// ---------------------------------------------------------------------------
// IPC contract additions (desktop/src-tauri `evm_*` commands)
// ---------------------------------------------------------------------------

/**
 * `evm_find_bid_ids({ rpcUrl, auction, owner })` — the wallet's bid ids on one
 * auction, as decimal strings in ascending order.
 */
export function evmFindBidIds(
  rpcUrl: string,
  auction: string,
  owner: string,
): Promise<bigint[]> {
  return invokeTauri<{ bidIds: string[] }>("evm_find_bid_ids", {
    rpcUrl,
    auction,
    owner,
  }).then((result) => result.bidIds.map((id) => BigInt(id)));
}

const RPC_TIMEOUT_MS = 6000;

/** `eth_blockNumber` over plain JSON-RPC (see the module doc on why). */
export async function ethBlockNumber(rpcUrl: string): Promise<bigint> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_blockNumber",
        params: [],
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`rpc http ${res.status}`);
    const body = (await res.json()) as {
      result?: unknown;
      error?: { message?: string };
    };
    if (body.error) throw new Error(body.error.message ?? "rpc error");
    if (typeof body.result !== "string") throw new Error("bad block number");
    return hexToBigInt(body.result);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// View calldata — selectors cross-checked with `cast sig` (foundry 1.4.3),
// argument blocks with `cast calldata`. Struct layouts are the pinned
// interfaces: `Bid` (libraries/BidLib.sol:6-14) and `Checkpoint`
// (libraries/CheckpointLib.sol:7-14).
// ---------------------------------------------------------------------------

/** `bids(uint256)` → `Bid` (IBidStorage.sol:19) — `cast sig` → `0x4423c5f1`. */
export const SIGNATURE_BIDS = "bids(uint256)";
/** `checkpoints(uint64)` → `Checkpoint` (ICheckpointStorage.sol:25) — `cast sig` → `0xb122db60`. */
export const SIGNATURE_CHECKPOINTS = "checkpoints(uint64)";
/** `isGraduated()` → bool — `cast sig` → `0x9e5f2602` (chainRpc.ts pin). */
export const SIGNATURE_IS_GRADUATED = "isGraduated()";
/** `clearingPrice()` → uint256 — `cast sig` → `0x32a0f2d7`. */
export const SIGNATURE_CLEARING_PRICE = "clearingPrice()";
/** `endBlock()` → uint64 — `cast sig` → `0x083c6323` (StepStorage.sol:749). */
export const SIGNATURE_END_BLOCK = "endBlock()";
/** `claimBlock()` → uint64 — `cast sig` → `0x37dfbc4b` (StepStorage.sol:754). */
export const SIGNATURE_CLAIM_BLOCK = "claimBlock()";
/** `lastCheckpointedBlock()` → uint64 — `cast sig` → `0x11ea09d0` (CheckpointStorage.sol:46). */
export const SIGNATURE_LAST_CHECKPOINTED_BLOCK = "lastCheckpointedBlock()";
/**
 * `checkpoint()` → `Checkpoint` — `cast sig` → `0xc2c4c5c1`. State-changing (materializes
 * a checkpoint) but callable by anyone; the prep step of `checkpointThenExit` (:420-427).
 */
export const SIGNATURE_CHECKPOINT = "checkpoint()";

/** Calldata for `auction.bids(bidId)` (read-only). */
export function buildBidViewCall(auction: string, bidId: bigint): EvmCall {
  return {
    to: auction,
    data: encodeFunctionData(SIGNATURE_BIDS, ["uint256"], [bidId]),
    value: "0x0",
  };
}

/** Calldata for `auction.checkpoints(blockNumber)` (read-only). */
export function buildCheckpointViewCall(
  auction: string,
  blockNumber: bigint,
): EvmCall {
  return {
    to: auction,
    data: encodeFunctionData(SIGNATURE_CHECKPOINTS, ["uint64"], [blockNumber]),
    value: "0x0",
  };
}

/** Calldata for the auction's block-parameterless view `signature`. */
export function buildNoArgViewCall(
  auction: string,
  signature: string,
): EvmCall {
  return { to: auction, data: selectorOf(signature), value: "0x0" };
}

/** The `auction.checkpoint()` prep transaction (materializes a checkpoint). */
export function buildCheckpointTxCall(auction: string): EvmCall {
  return buildNoArgViewCall(auction, SIGNATURE_CHECKPOINT);
}

// ---------------------------------------------------------------------------
// Return decoders — static struct returns are flat ABI words (no offsets).
// ---------------------------------------------------------------------------

/** One decoded `Bid` (libraries/BidLib.sol:6-14), field for field. */
export interface BidView {
  startBlock: bigint;
  startCumulativeMps: bigint;
  exitedBlock: bigint;
  maxPrice: bigint;
  owner: string;
  amountQ96: bigint;
  tokensFilled: bigint;
}

/** One decoded `Checkpoint` (libraries/CheckpointLib.sol:7-14) plus its key. */
export interface CheckpointView {
  /** The `checkpoints(uint64)` key this checkpoint was read at. */
  block: bigint;
  clearingPrice: bigint;
  currencyRaisedAtClearingPriceQ96X7: bigint;
  cumulativeMpsPerPrice: bigint;
  cumulativeMps: bigint;
  prev: bigint;
  next: bigint;
}

/** `CheckpointStorage.sol:11` — the `next` sentinel at the tail of the list. */
export const MAX_CHECKPOINT_BLOCK = (1n << 64n) - 1n;

/** Default bound on one checkpoint-list walk (Review-Proven Rule 4). */
export const DEFAULT_CHECKPOINT_WALK_LIMIT = 512;

function decodeWords(returnData: string, expected: number): bigint[] {
  const body = returnData.startsWith("0x") ? returnData.slice(2) : returnData;
  if (body.length !== expected * 64 || !/^[0-9a-fA-F]*$/.test(body)) {
    throw new Error(
      `expected ${expected} ABI words, got ${body.length / 2} bytes`,
    );
  }
  const words: bigint[] = [];
  for (let i = 0; i < expected; i++) {
    words.push(BigInt(`0x${body.slice(i * 64, (i + 1) * 64)}`));
  }
  return words;
}

function addressFromWord(word: bigint): string {
  return `0x${word.toString(16).padStart(40, "0")}`;
}

/**
 * Decode a `bids(uint256)` return. Word order is the `Bid` struct field order
 * (BidLib.sol:6-14): startBlock, startCumulativeMps, exitedBlock, maxPrice, owner,
 * amountQ96, tokensFilled. Throws on a wrong-size return.
 */
export function decodeBidView(returnData: string): BidView {
  const [
    startBlock,
    startCumulativeMps,
    exitedBlock,
    maxPrice,
    owner,
    amountQ96,
    tokensFilled,
  ] = decodeWords(returnData, 7);
  return {
    startBlock,
    startCumulativeMps,
    exitedBlock,
    maxPrice,
    owner: addressFromWord(owner),
    amountQ96,
    tokensFilled,
  };
}

/**
 * Decode a `checkpoints(uint64)` return. Word order is the `Checkpoint` struct field
 * order (CheckpointLib.sol:7-14): clearingPrice, currencyRaisedAtClearingPriceQ96X7,
 * cumulativeMpsPerPrice, cumulativeMps, prev, next. Throws on a wrong-size return.
 */
export function decodeCheckpointView(
  block: bigint,
  returnData: string,
): CheckpointView {
  const [
    clearingPrice,
    currencyRaisedAtClearingPriceQ96X7,
    cumulativeMpsPerPrice,
    cumulativeMps,
    prev,
    next,
  ] = decodeWords(returnData, 6);
  return {
    block,
    clearingPrice,
    currencyRaisedAtClearingPriceQ96X7,
    cumulativeMpsPerPrice,
    cumulativeMps,
    prev,
    next,
  };
}

/**
 * True when `checkpoints(key)` holds an inserted checkpoint. An unmaterialized key
 * decodes to all zeros; every inserted checkpoint has `next != 0` (`_insertCheckpoint`
 * sets it to the next block or `MAX_BLOCK_NUMBER`, CheckpointStorage.sol:30-43).
 */
export function isCheckpointMaterialized(cp: CheckpointView): boolean {
  return cp.next !== 0n;
}

// ---------------------------------------------------------------------------
// Pure derivation — bid state → available actions
// (the production seam `exitHooks.test.mjs` binds)
// ---------------------------------------------------------------------------

/** Everything the derivation needs to know about the auction and chain. */
export interface AuctionContext {
  /** `isGraduated()` (ContinuousClearingAuction.sol:161-169). */
  graduated: boolean;
  /** `clearingPrice()` — the live price var (interfaces/:163-168). */
  liveClearingPrice: bigint;
  /** `endBlock()` (StepStorage.sol:749). */
  endBlock: bigint;
  /** `claimBlock()` (StepStorage.sol:754); >= endBlock at construction. */
  claimBlock: bigint;
  /** `eth_blockNumber` — proxy for `_getBlockNumberish()`. */
  currentBlock: bigint;
}

/**
 * The exit action the contract allows for one bid right now.
 *
 * - `exitBid`: full `auction.exitBid(bidId)` — the fully filled / refund path.
 * - `exitPartiallyFilledBid`: `auction.exitPartiallyFilledBid(bidId, …)` with
 *   the two checkpoint hints derived from the materialized checkpoint list.
 * - `checkpointThenExit`: the decisive checkpoint is not on chain yet — send
 *   `checkpoint()` first, then re-derive and exit (two labeled steps).
 * - `unavailable`: nothing is legal yet; `reason` says why.
 */
export type ExitPlan =
  | { kind: "exitBid" }
  | {
      kind: "exitPartiallyFilledBid";
      lastFullyFilledCheckpointBlock: bigint;
      outbidBlock: bigint;
    }
  | { kind: "checkpointThenExit" }
  | { kind: "unavailable"; reason: string };

/** The claim action the contract allows for one bid right now. */
export type ClaimPlan =
  | { kind: "claim" }
  | { kind: "unavailable"; reason: string };

/**
 * Status per contract semantics: `active` (in play), `outbid` (clearing passed
 * maxPrice — the outbid checkpoint is materialized), `ended` (over, not exited),
 * `exited` (tokens waiting out the claim window), `claimable` (claim unlocked),
 * `settled` (nothing left to claim).
 */
export type BidStatus =
  | "active"
  | "outbid"
  | "ended"
  | "exited"
  | "claimable"
  | "settled";

/** Per-bid derivation input: the bid, its checkpoint walk, auction context. */
export interface BidDerivationInput {
  bidId: bigint;
  bid: BidView;
  /**
   * Materialized checkpoints from `bid.startBlock` along the `next` linked
   * list, ascending. Must start at the bid's own start checkpoint.
   */
  checkpoints: readonly CheckpointView[];
  auction: AuctionContext;
}

/** Derived per-bid status and gated actions. */
export interface BidActions {
  status: BidStatus;
  exit: ExitPlan;
  claim: ClaimPlan;
}

const WALK_CONSISTENT =
  "Checkpoint data is inconsistent with this bid — refresh, and report this if it persists.";

/**
 * Derive the exit plan. Branch citations match the module doc: non-graduated over →
 * `exitBid` (ContinuousClearingAuction.sol:499-501); graduated over with maxPrice >
 * final → `exitBid` (:504); materialized outbid → partial exit with the two hints
 * (:541-547, :559-572); graduated over with maxPrice == final → partial exit with
 * `outbidBlock = 0` (:573-582); otherwise the decisive checkpoint is pending or
 * nothing is legal yet.
 */
export function deriveExitPlan(input: BidDerivationInput): ExitPlan {
  const { bid, checkpoints, auction } = input;
  const maxPrice = bid.maxPrice;
  if (bid.exitedBlock !== 0n) {
    return { kind: "unavailable", reason: "This bid is already exited." };
  }
  const walkConsistent =
    checkpoints.length > 0 &&
    checkpoints[0].block === bid.startBlock &&
    checkpoints[0].clearingPrice < maxPrice;
  if (!walkConsistent) {
    return { kind: "unavailable", reason: WALK_CONSISTENT };
  }
  const over = auction.currentBlock >= auction.endBlock;
  if (!auction.graduated) {
    if (over) return { kind: "exitBid" };
    return {
      kind: "unavailable",
      reason:
        "Exit opens when the auction ends — early exit needs a graduated auction.",
    };
  }

  // The first materialized checkpoint at/above and strictly above maxPrice,
  // plus the last one strictly below (its `next` is the first at/above — the
  // contract's hint shape, ContinuousClearingAuction.sol:541-547).
  let atOrAbove: CheckpointView | null = null;
  let above: CheckpointView | null = null;
  let lastBelow: CheckpointView | null = null;
  for (const cp of checkpoints) {
    if (cp.clearingPrice > maxPrice) {
      above = cp;
      break;
    }
    if (cp.clearingPrice === maxPrice && atOrAbove === null) {
      atOrAbove = cp;
    } else if (cp.clearingPrice < maxPrice) {
      lastBelow = cp;
      if (atOrAbove !== null) {
        // Monotonic non-decreasing clearing price (:586) — a below-price
        // checkpoint after an at/above one cannot happen.
        return { kind: "unavailable", reason: WALK_CONSISTENT };
      }
    }
  }
  if (above !== null) {
    // Outbid: the early-exit path (:559-572). Hints are exact — both are
    // already-materialized checkpoint blocks and checkpoints are immutable.
    if (lastBelow === null || lastBelow.block < bid.startBlock) {
      return { kind: "unavailable", reason: WALK_CONSISTENT };
    }
    return {
      kind: "exitPartiallyFilledBid",
      lastFullyFilledCheckpointBlock: lastBelow.block,
      outbidBlock: above.block,
    };
  }

  const tail = checkpoints[checkpoints.length - 1];
  if (over && tail.block < auction.endBlock) {
    // Over, but the final checkpoint at endBlock is not materialized — its
    // clearing price decides which exit path applies. Materialize it first.
    return { kind: "checkpointThenExit" };
  }
  if (!over) {
    if (auction.liveClearingPrice > maxPrice) {
      // `forceIterateOverTicks` moved the price past maxPrice without writing
      // the outbid checkpoint (:432-460) — write it, then re-derive.
      return { kind: "checkpointThenExit" };
    }
    return {
      kind: "unavailable",
      reason:
        "Exit opens at the auction end, or earlier if this bid is outbid on a graduated auction.",
    };
  }

  // Over with the final checkpoint materialized: tail is the checkpoint at
  // endBlock (nothing can checkpoint past it — bids revert at >= endBlock,
  // :472, and `checkpoint()` lands at endBlock once over, :422-424).
  const finalPrice = tail.clearingPrice;
  if (maxPrice > finalPrice) return { kind: "exitBid" };
  if (maxPrice === finalPrice) {
    // Partially filled at the end of the auction: outbidBlock = 0 (:573-582).
    if (atOrAbove === null) atOrAbove = tail;
    if (lastBelow === null || lastBelow.block < bid.startBlock) {
      return { kind: "unavailable", reason: WALK_CONSISTENT };
    }
    return {
      kind: "exitPartiallyFilledBid",
      lastFullyFilledCheckpointBlock: lastBelow.block,
      outbidBlock: 0n,
    };
  }
  // maxPrice < finalPrice with no materialized checkpoint above maxPrice
  // contradicts the monotonic price walk — name it, never guess.
  return { kind: "unavailable", reason: WALK_CONSISTENT };
}

/**
 * Derive the claim plan. Claim requires a PRIOR exit (`BidNotExited`, ContinuousClearingAuction.sol:651),
 * a graduated auction (:606) and the claim block (`onlyAfterClaimBlock`, StepStorage.sol:55-58).
 * A bid with `tokensFilled == 0` after exit has nothing left to claim (:655-658).
 */
export function deriveClaimPlan(
  bid: BidView,
  auction: AuctionContext,
): ClaimPlan {
  if (bid.exitedBlock === 0n) {
    return {
      kind: "unavailable",
      reason: "Claim unlocks after this bid is exited.",
    };
  }
  if (bid.tokensFilled === 0n) {
    return {
      kind: "unavailable",
      reason: "Nothing left to claim — this bid is settled.",
    };
  }
  if (!auction.graduated) {
    return {
      kind: "unavailable",
      reason: "Tokens can only be claimed on a graduated auction.",
    };
  }
  if (auction.currentBlock < auction.claimBlock) {
    return {
      kind: "unavailable",
      reason: `Claim unlocks at block ${auction.claimBlock}.`,
    };
  }
  return { kind: "claim" };
}

/** Derive the display status from the same inputs as the gated actions. */
export function deriveBidStatus(input: BidDerivationInput): BidStatus {
  const { bid, checkpoints, auction } = input;
  if (bid.exitedBlock !== 0n) {
    if (bid.tokensFilled === 0n) return "settled";
    return deriveClaimPlan(bid, auction).kind === "claim"
      ? "claimable"
      : "exited";
  }
  if (auction.currentBlock >= auction.endBlock) return "ended";
  const outbid = checkpoints.some(
    (cp) => isCheckpointMaterialized(cp) && cp.clearingPrice > bid.maxPrice,
  );
  return outbid ? "outbid" : "active";
}

/** The single production seam: bid state in, gated actions + status out. */
export function deriveBidActions(input: BidDerivationInput): BidActions {
  return {
    status: deriveBidStatus(input),
    exit: deriveExitPlan(input),
    claim: deriveClaimPlan(input.bid, input.auction),
  };
}

// ---------------------------------------------------------------------------
// Plan → unsigned call(s)
// ---------------------------------------------------------------------------

/**
 * Map a single-call exit plan to its unsigned call. Throws for
 * `checkpointThenExit` (two steps) and `unavailable` — composition failures
 * surface before anything is sent.
 */
export function buildExitCallForPlan(
  auction: string,
  bidId: bigint,
  plan: ExitPlan,
): EvmCall {
  if (plan.kind === "exitBid") return buildExitBidCall(auction, bidId);
  if (plan.kind === "exitPartiallyFilledBid") {
    return buildExitPartiallyFilledBidCall(
      auction,
      bidId,
      plan.lastFullyFilledCheckpointBlock,
      plan.outbidBlock,
    );
  }
  throw new Error(
    plan.kind === "unavailable"
      ? plan.reason
      : "checkpointThenExit is a two-step plan — use buildExitExecution",
  );
}

/** One labeled step of an exit/claim attempt. */
export type ExitStepId = "checkpoint" | "exit" | "claim";

/** Human names for the steps; failure messages name the failed step. */
export const EXIT_STEP_LABELS: Record<ExitStepId, string> = {
  checkpoint: "Write checkpoint",
  exit: "Exit bid",
  claim: "Claim tokens",
};

/** A labeled step whose call is built at send time (fresh hints post-prep). */
export interface ExitStepCall {
  step: ExitStepId;
  build: () => EvmCall | Promise<EvmCall>;
}

/** Everything one exit/claim attempt needs; re-runnable for retries. */
export interface ExitExecution {
  rpcUrl: string;
  chainId: number;
  /** Ordered steps to send. */
  calls: readonly ExitStepCall[];
  /** Full planned order (mirrors `BidExecution.order`). */
  order: readonly ExitStepId[];
}

/** Inputs for {@link buildExitExecution}. */
export interface ExitExecutionParams {
  rpcUrl: string;
  chainId: number;
  /** CCA auction address. */
  auction: string;
  bidId: bigint;
  /** The gated plan from {@link deriveExitPlan}. */
  plan: ExitPlan;
  /**
   * Fresh re-derivation for the post-checkpoint exit step. Required for
   * `checkpointThenExit` — after `checkpoint()` materializes the decisive
   * checkpoint, the hints must come from new reads, never from the stale
   * pre-prep snapshot (Review-Proven Rule 2).
   */
  resolvePlan?: () => Promise<ExitPlan>;
}

/**
 * Compose the ordered, labeled execution for one bid's exit:
 * - `exitBid` / `exitPartiallyFilledBid` → one `exit` step.
 * - `checkpointThenExit` → `checkpoint` then `exit`; the exit call is built
 *   from a fresh derivation after the checkpoint lands. If the fresh plan is
 *   still not sendable the step fails by name — never a silent success.
 */
export function buildExitExecution(params: ExitExecutionParams): ExitExecution {
  const { auction, bidId, plan } = params;
  if (plan.kind === "checkpointThenExit") {
    const resolvePlan = params.resolvePlan;
    if (!resolvePlan) {
      throw new Error("checkpointThenExit needs a resolvePlan re-derivation");
    }
    return {
      rpcUrl: params.rpcUrl,
      chainId: params.chainId,
      order: ["checkpoint", "exit"],
      calls: [
        { step: "checkpoint", build: () => buildCheckpointTxCall(auction) },
        {
          step: "exit",
          build: async () => {
            const fresh = await resolvePlan();
            if (fresh.kind === "checkpointThenExit") {
              throw new Error(
                "the decisive checkpoint is still missing onchain — refresh and try again",
              );
            }
            return buildExitCallForPlan(auction, bidId, fresh);
          },
        },
      ],
    };
  }
  return {
    rpcUrl: params.rpcUrl,
    chainId: params.chainId,
    order: ["exit"],
    calls: [
      { step: "exit", build: () => buildExitCallForPlan(auction, bidId, plan) },
    ],
  };
}

/** Inputs for {@link buildClaimExecution}. */
export interface ClaimExecutionParams {
  rpcUrl: string;
  chainId: number;
  /** CCA auction address. */
  auction: string;
  /** The bids' owner (the batch variant re-checks ownership onchain). */
  owner: string;
  /** One id sends `claimTokens`; several send `claimTokensBatch`. */
  bidIds: readonly bigint[];
}

/**
 * Compose the single `claim` step: `claimTokens(bidId)` for one bid,
 * `claimTokensBatch(owner, bidIds)` for several (one transfer, one event per bid —
 * ContinuousClearingAuction.sol:617-643). Throws on an empty list.
 */
export function buildClaimExecution(
  params: ClaimExecutionParams,
): ExitExecution {
  const { auction, owner, bidIds } = params;
  if (bidIds.length === 0) throw new Error("claim needs at least one bid id");
  return {
    rpcUrl: params.rpcUrl,
    chainId: params.chainId,
    order: ["claim"],
    calls: [
      {
        step: "claim",
        build: () =>
          bidIds.length === 1
            ? buildClaimTokensCall(auction, bidIds[0])
            : buildClaimTokensBatchCall(auction, owner, bidIds),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Onchain reads (IPC `evm_call` view calldata)
// ---------------------------------------------------------------------------

/** Read + decode `auction.bids(bidId)`. Throws on read/decode failure. */
export async function readBidView(
  rpcUrl: string,
  auction: string,
  bidId: bigint,
): Promise<BidView> {
  const call = buildBidViewCall(auction, bidId);
  return decodeBidView(await evmEthCall(rpcUrl, call.to, call.data));
}

/** Read + decode `auction.checkpoints(block)`. Throws on read/decode failure. */
export async function readCheckpointView(
  rpcUrl: string,
  auction: string,
  block: bigint,
): Promise<CheckpointView> {
  const call = buildCheckpointViewCall(auction, block);
  return decodeCheckpointView(
    block,
    await evmEthCall(rpcUrl, call.to, call.data),
  );
}

async function readNoArgUint(
  rpcUrl: string,
  auction: string,
  signature: string,
): Promise<bigint> {
  const call = buildNoArgViewCall(auction, signature);
  return decodeUint256(await evmEthCall(rpcUrl, call.to, call.data));
}

/**
 * Walk the checkpoint linked list from `startBlock` via `next` (CheckpointStorage.sol:30-43).
 * Bounded by `limit` — an overrun is an error, never a silent truncation (Rule 4).
 */
export async function fetchCheckpointWalk(
  read: (block: bigint) => Promise<CheckpointView>,
  startBlock: bigint,
  limit: number = DEFAULT_CHECKPOINT_WALK_LIMIT,
): Promise<CheckpointView[]> {
  const walk: CheckpointView[] = [];
  let cursor = startBlock;
  for (let steps = 0; ; steps++) {
    if (steps >= limit) {
      throw new Error(`checkpoint walk exceeded ${limit} steps`);
    }
    const cp = await read(cursor);
    if (!isCheckpointMaterialized(cp)) {
      throw new Error(`no checkpoint at block ${cursor}`);
    }
    walk.push(cp);
    if (cp.next === MAX_CHECKPOINT_BLOCK) return walk;
    if (cp.next <= cursor) throw new Error("checkpoint chain is not ascending");
    cursor = cp.next;
  }
}

/** Read the full auction context {@link AuctionContext}. */
export async function fetchAuctionContext(
  rpcUrl: string,
  auction: string,
): Promise<AuctionContext> {
  const [graduated, liveClearingPrice, endBlock, claimBlock, currentBlock] =
    await Promise.all([
      readNoArgUint(rpcUrl, auction, SIGNATURE_IS_GRADUATED),
      readNoArgUint(rpcUrl, auction, SIGNATURE_CLEARING_PRICE),
      readNoArgUint(rpcUrl, auction, SIGNATURE_END_BLOCK),
      readNoArgUint(rpcUrl, auction, SIGNATURE_CLAIM_BLOCK),
      ethBlockNumber(rpcUrl),
    ]);
  return {
    graduated: graduated !== 0n,
    liveClearingPrice,
    endBlock,
    claimBlock,
    currentBlock,
  };
}

/** One wallet bid: raw reads plus the gated actions. */
export interface MyBidEntry {
  bidId: bigint;
  bid: BidView;
  checkpoints: CheckpointView[];
  actions: BidActions;
}

/** A fresh read of everything the My-bids panel shows. */
export interface MyBidsSnapshot {
  auction: AuctionContext;
  bids: MyBidEntry[];
}

/** Inputs for {@link fetchMyBidsSnapshot}. */
export interface FetchMyBidsParams {
  rpcUrl: string;
  /** CCA auction address. */
  auction: string;
  /** The wallet address whose bids to list. */
  owner: string;
  /** Checkpoint-walk bound per bid (default {@link DEFAULT_CHECKPOINT_WALK_LIMIT}). */
  walkLimit?: number;
}

/** Read one bid's derivation input (bid + its checkpoint walk + context). */
export async function fetchBidDerivation(
  rpcUrl: string,
  auction: string,
  bidId: bigint,
  walkLimit: number = DEFAULT_CHECKPOINT_WALK_LIMIT,
): Promise<{ bid: BidView; checkpoints: CheckpointView[] }> {
  const bid = await readBidView(rpcUrl, auction, bidId);
  const checkpoints = await fetchCheckpointWalk(
    (block) => readCheckpointView(rpcUrl, auction, block),
    bid.startBlock,
    walkLimit,
  );
  return { bid, checkpoints };
}

/**
 * Fresh exit-plan re-derivation for the post-checkpoint step (and for the
 * panel's own recovery paths). Throws on any read failure.
 */
export async function resolveExitPlanAt(
  rpcUrl: string,
  auction: string,
  bidId: bigint,
): Promise<ExitPlan> {
  const [ctx, { bid, checkpoints }] = await Promise.all([
    fetchAuctionContext(rpcUrl, auction),
    fetchBidDerivation(rpcUrl, auction, bidId),
  ]);
  return deriveExitPlan({ bidId, bid, checkpoints, auction: ctx });
}

/**
 * Read every wallet bid on the auction: `evm_find_bid_ids` for the id list,
 * then each bid's struct and checkpoint walk in parallel, then derive actions.
 */
export async function fetchMyBidsSnapshot(
  params: FetchMyBidsParams,
): Promise<MyBidsSnapshot> {
  const { rpcUrl, auction, owner, walkLimit } = params;
  const [ctx, bidIds] = await Promise.all([
    fetchAuctionContext(rpcUrl, auction),
    evmFindBidIds(rpcUrl, auction, owner),
  ]);
  const bids = await Promise.all(
    bidIds.map(async (bidId): Promise<MyBidEntry> => {
      const { bid, checkpoints } = await fetchBidDerivation(
        rpcUrl,
        auction,
        bidId,
        walkLimit,
      );
      return {
        bidId,
        bid,
        checkpoints,
        actions: deriveBidActions({ bidId, bid, checkpoints, auction: ctx }),
      };
    }),
  );
  return { auction: ctx, bids };
}

// ---------------------------------------------------------------------------
// Step orchestrator — pure reducer + dependency-injected runner
// (mirror of `bidHooks.ts`'s bidFlowReducer/runBidFlow; no mirror-publish
// step: exit/claim are money actions with no feed mirror)
// ---------------------------------------------------------------------------

/** Per-step status. `skipped` = not part of this plan. */
export type ExitStepStatus =
  | "pending"
  | "active"
  | "done"
  | "failed"
  | "skipped";

/**
 * - `idle`: no attempt started.
 * - `running`: a step is in flight.
 * - `failed`: a step failed; retry sends only the remaining steps.
 * - `done`: every step confirmed.
 */
export type ExitFlowPhase = "idle" | "running" | "failed" | "done";

/** The full observable state of one exit/claim attempt. */
export interface ExitFlowState {
  phase: ExitFlowPhase;
  /** Planned step order. */
  order: ExitStepId[];
  steps: Record<ExitStepId, ExitStepStatus>;
  receipts: Partial<Record<ExitStepId, TxReceipt>>;
  failedStep: ExitStepId | null;
  /** Names the failed step and the reason (Review-Proven Rule 1). */
  errorMessage: string | null;
}

/** State transition events, emitted by {@link runExitFlow}. */
export type ExitFlowAction =
  | { type: "reset"; order: readonly ExitStepId[] }
  | { type: "step-start"; step: ExitStepId }
  | { type: "step-done"; step: ExitStepId; receipt?: TxReceipt }
  | { type: "step-failed"; step: ExitStepId; message: string };

const ALL_STEP_IDS: readonly ExitStepId[] = ["checkpoint", "exit", "claim"];

function freshSteps(
  order: readonly ExitStepId[],
): Record<ExitStepId, ExitStepStatus> {
  const steps = {} as Record<ExitStepId, ExitStepStatus>;
  for (const id of ALL_STEP_IDS) {
    steps[id] = order.includes(id) ? "pending" : "skipped";
  }
  return steps;
}

/** The state before any attempt: nothing planned, nothing sent. */
export function initialExitFlowState(): ExitFlowState {
  return {
    phase: "idle",
    order: [],
    steps: freshSteps([]),
    receipts: {},
    failedStep: null,
    errorMessage: null,
  };
}

/** Pure step-orchestrator reducer (the seam `exitHooks.test.mjs` binds). */
export function exitFlowReducer(
  state: ExitFlowState,
  action: ExitFlowAction,
): ExitFlowState {
  switch (action.type) {
    case "reset": {
      const order = [...action.order];
      return {
        ...initialExitFlowState(),
        order,
        steps: freshSteps(order),
      };
    }
    case "step-start": {
      return {
        ...state,
        phase: "running",
        steps: { ...state.steps, [action.step]: "active" },
        failedStep: null,
        errorMessage: null,
      };
    }
    case "step-done": {
      const steps = { ...state.steps, [action.step]: "done" as const };
      const receipts = action.receipt
        ? { ...state.receipts, [action.step]: action.receipt }
        : state.receipts;
      const allDone = state.order.every((id) => steps[id] === "done");
      return {
        ...state,
        phase: allDone ? "done" : "running",
        steps,
        receipts,
        failedStep: null,
        errorMessage: null,
      };
    }
    case "step-failed": {
      return {
        ...state,
        phase: "failed",
        steps: { ...state.steps, [action.step]: "failed" as const },
        failedStep: action.step,
        errorMessage: `${EXIT_STEP_LABELS[action.step]} failed — ${action.message}`,
      };
    }
  }
}

/** Steps not yet confirmed done — exactly what a retry will (re-)send. */
export function remainingExitSteps(state: ExitFlowState): ExitStepId[] {
  return state.order.filter((id) => state.steps[id] !== "done");
}

/** Steps already confirmed done — never re-sent on retry. */
export function completedExitSteps(state: ExitFlowState): Set<ExitStepId> {
  return new Set(state.order.filter((id) => state.steps[id] === "done"));
}

/** Where a retry picks up. */
export interface ExitResume {
  completed: ReadonlySet<ExitStepId>;
}

/** Derive the {@link ExitResume} for {@link runExitFlow} from the state. */
export function resumeExitFromState(state: ExitFlowState): ExitResume {
  return { completed: completedExitSteps(state) };
}

/** Injected I/O for {@link runExitFlow}; tests script fakes here. */
export interface ExitFlowDeps {
  sendTransaction: (args: EvmSendArgs) => Promise<TxReceipt>;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "the request failed";
}

/**
 * Run (or resume) one exit/claim attempt: build + send each remaining step in
 * order, awaiting each mined receipt. Dispatches every transition through
 * `dispatch`; stops at the first failure and names it. `resume.completed`
 * steps are never re-sent.
 */
export async function runExitFlow(
  execution: ExitExecution,
  deps: ExitFlowDeps,
  dispatch: (action: ExitFlowAction) => void,
  resume: ExitResume = { completed: new Set() },
): Promise<void> {
  for (const entry of execution.calls) {
    if (resume.completed.has(entry.step)) continue;
    dispatch({ type: "step-start", step: entry.step });
    let call: EvmCall;
    try {
      call = await entry.build();
    } catch (err) {
      dispatch({
        type: "step-failed",
        step: entry.step,
        message: errorMessage(err),
      });
      return;
    }
    let receipt: TxReceipt;
    try {
      receipt = await deps.sendTransaction({
        rpcUrl: execution.rpcUrl,
        chainId: execution.chainId,
        to: call.to,
        data: call.data,
        value: call.value,
      });
    } catch (err) {
      // Rule 1: the failure names its step; nothing downstream is attempted.
      dispatch({
        type: "step-failed",
        step: entry.step,
        message: errorMessage(err),
      });
      return;
    }
    if (receipt.status !== "success") {
      // A mined revert is a failed step — data, not an exception, and never a
      // silent success.
      dispatch({
        type: "step-failed",
        step: entry.step,
        message: `the transaction reverted onchain (tx ${receipt.txHash})`,
      });
      return;
    }
    dispatch({ type: "step-done", step: entry.step, receipt });
  }
}

// ---------------------------------------------------------------------------
// React glue
// ---------------------------------------------------------------------------

const TAURI_EXIT_FLOW_DEPS: ExitFlowDeps = {
  sendTransaction: evmSendTransaction,
};

/** The panel-facing exit/claim flow: reducer state plus start/retry/reset. */
export interface UseExitFlowResult {
  state: ExitFlowState;
  /** Begin a fresh attempt (arms the plan and runs it). */
  start: (execution: ExitExecution) => Promise<void>;
  /** Resume the armed plan: only unfinished steps run. */
  retry: () => Promise<void>;
  /** Disarm. */
  reset: () => void;
}

/** Bind the step orchestrator to the Tauri IPC layer (mirrors `useBidFlow`). */
export function useExitFlow(): UseExitFlowResult {
  const [state, dispatch] = React.useReducer(
    exitFlowReducer,
    undefined,
    initialExitFlowState,
  );
  const stateRef = React.useRef(state);
  stateRef.current = state;
  const executionRef = React.useRef<ExitExecution | null>(null);

  const start = React.useCallback((execution: ExitExecution) => {
    executionRef.current = execution;
    dispatch({ type: "reset", order: execution.order });
    return runExitFlow(execution, TAURI_EXIT_FLOW_DEPS, dispatch);
  }, []);

  const retry = React.useCallback(() => {
    const execution = executionRef.current;
    if (!execution) return Promise.resolve();
    return runExitFlow(
      execution,
      TAURI_EXIT_FLOW_DEPS,
      dispatch,
      resumeExitFromState(stateRef.current),
    );
  }, []);

  const reset = React.useCallback(() => {
    executionRef.current = null;
    dispatch({ type: "reset", order: [] });
  }, []);

  return { state, start, retry, reset };
}

/** Load state for the My-bids panel. */
export type MyBidsLoad =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; snapshot: MyBidsSnapshot };

/**
 * Load (and reload) the wallet's bids. Every async continuation is fenced by
 * a generation counter so a stale read can never write after a newer one
 * (Review-Proven Rule 2); key changes and unmount invalidate in-flight reads,
 * and `reload` re-fetches through the same fenced path.
 */
export function useMyBids(
  rpcUrl: string,
  auction: string | null,
  owner: string | null,
): { load: MyBidsLoad; reload: () => void } {
  const [load, setLoad] = React.useState<MyBidsLoad>({ status: "loading" });
  const generationRef = React.useRef(0);

  const reload = React.useCallback(() => {
    if (!auction || !owner) return;
    generationRef.current += 1;
    const generation = generationRef.current;
    setLoad({ status: "loading" });
    fetchMyBidsSnapshot({ rpcUrl, auction, owner })
      .then((snapshot) => {
        if (generationRef.current !== generation) return;
        setLoad({ status: "ready", snapshot });
      })
      .catch((err: unknown) => {
        if (generationRef.current !== generation) return;
        setLoad({ status: "error", message: errorMessage(err) });
      });
  }, [rpcUrl, auction, owner]);

  React.useEffect(() => {
    reload();
    return () => {
      generationRef.current += 1;
    };
  }, [reload]);

  return { load, reload };
}
