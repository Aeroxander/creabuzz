/**
 * "My bids" onchain reads and exit/claim legality for the web launchpad.
 *
 * Port of `desktop/src/features/launchpad/exitHooks.ts` (the reference
 * implementation) onto web seams: view reads go through `../chain.ts`'s
 * `eth_call`/`eth_getLogs`, calldata comes from `./bid-tx.ts`, and there is no
 * Tauri IPC — `evm_find_bid_ids`' log scan is done here over `eth_getLogs`.
 * Contract semantics and citations are inherited verbatim from the desktop
 * module doc:
 *
 * - `Bid` (BidLib.sol:6-14) is `startBlock`, `startCumulativeMps`,
 *   `exitedBlock`, `maxPrice`, `owner`, `amountQ96`, `tokensFilled`.
 *   `tokensFilled` starts at 0 (BidStorage.sol:35), is recorded at exit
 *   (`_processExit`, ContinuousClearingAuction.sol:409) and zeroed by a claim
 *   (`_internalClaimTokens`, :658) — `exited && tokensFilled == 0` reads as
 *   "settled, nothing left to claim".
 * - `exitBid` (ContinuousClearingAuction.sol:495) requires the auction over
 *   (`onlyAfterAuctionIsOver`, StepStorage.sol:50-52) and a non-exited bid.
 *   A non-graduated auction refunds in full (:499-501). On a graduated one the
 *   bid's maxPrice must be STRICTLY above the final clearing price (:503-504).
 * - `exitPartiallyFilledBid` (:514-601) takes two checkpoint hints:
 *   `lastFullyFilledCheckpointBlock` is the last checkpointed block whose
 *   clearing price is strictly < bid.maxPrice (:541-547 validates the next
 *   checkpoint is at >= maxPrice and the hint >= bid.startBlock), and
 *   `outbidBlock` is the first checkpointed block whose clearing price is
 *   strictly > bid.maxPrice (:568-572 validates its predecessor), or 0 when
 *   the bid is partially filled at the end of the auction (:573-582, requires
 *   the auction over and final clearing price == maxPrice exactly). Before the
 *   end block a partial exit is legal only once the bid is outbid on a
 *   graduated auction (:526-532, :559) — after the end block every non-exited
 *   bid can exit (full refund when the auction did not graduate).
 * - `claimTokens` / `claimTokensBatch` (:604-643) need the claim block
 *   (`onlyAfterClaimBlock`, StepStorage.sol:55-58), a graduated auction
 *   (:606, :623) and a PRIOR exit — `_internalClaimTokens` reverts
 *   `BidNotExited` when `exitedBlock == 0` (:649-651). Anyone may claim; the
 *   tokens always go to the bid owner (:611).
 *
 * Partial-exit hints come only from MATERIALIZED checkpoints (the
 * `checkpoints(uint64)` linked list, CheckpointStorage.sol:51-53; `next` is the
 * `MAX_BLOCK_NUMBER` sentinel at the tail, :10-11). When the decisive
 * checkpoint is not on chain yet — the final checkpoint at `endBlock` right
 * after the auction, or the outbid crossing after `forceIterateOverTicks`
 * advanced `clearingPrice()` without inserting a checkpoint (:432-460) — the
 * plan is `checkpointThenExit`: send `checkpoint()` first (callable by anyone,
 * materializes exactly that checkpoint, :240-244 and :335-337), then re-derive
 * fresh hints for the exit step.
 *
 * Bid discovery: an owner's bid ids are the `id` of the auction's
 * `BidSubmitted(uint256 indexed id, address indexed owner, ...)` logs
 * (interfaces/IContinuousClearingAuction.sol:103) — the same bounded scan
 * desktop's `evm_find_bid_ids` performs (wallet.rs:25-27).
 */
import {
  decodeU256,
  ethBlockNumber,
  ethCall,
  ethGetLogs,
  TOPIC_BID_SUBMITTED,
} from "../chain.ts";
import {
  encodeCheckpointCallData,
  encodeClaimTokens,
  encodeClaimTokensBatch,
  encodeExitBid,
  encodeExitPartiallyFilledBid,
  type UnsignedTx,
} from "./bid-tx.ts";

// ---------------------------------------------------------------------------
// View calldata — selectors cross-checked with `cast sig` (desktop
// exitHooks.test.mjs pins the same bytes).
// ---------------------------------------------------------------------------

/** `bids(uint256)` → `Bid` (IBidStorage.sol:19) — `cast sig` → `0x4423c5f1`. */
export const SELECTOR_BIDS = "0x4423c5f1";
/** `checkpoints(uint64)` → `Checkpoint` — `cast sig` → `0xb122db60`. */
export const SELECTOR_CHECKPOINTS = "0xb122db60";
/** `isGraduated()` → bool — `cast sig` → `0x9e5f2602` (chain.ts pin). */
export const SELECTOR_IS_GRADUATED = "0x9e5f2602";
/** `clearingPrice()` → uint256 — `cast sig` → `0x32a0f2d7` (chain.ts pin). */
export const SELECTOR_CLEARING_PRICE = "0x32a0f2d7";
/** `endBlock()` → uint64 — `cast sig` → `0x083c6323` (StepStorage.sol:749). */
export const SELECTOR_END_BLOCK = "0x083c6323";
/** `claimBlock()` → uint64 — `cast sig` → `0x37dfbc4b` (StepStorage.sol:754). */
export const SELECTOR_CLAIM_BLOCK = "0x37dfbc4b";

function pad32(n: bigint): string {
  return n.toString(16).padStart(64, "0");
}

/** Calldata for `auction.bids(bidId)` (read-only). */
export function buildBidViewCall(bidId: bigint): string {
  return `${SELECTOR_BIDS}${pad32(bidId)}`;
}

/** Calldata for `auction.checkpoints(blockNumber)` (read-only). */
export function buildCheckpointViewCall(blockNumber: bigint): string {
  return `${SELECTOR_CHECKPOINTS}${pad32(blockNumber)}`;
}

/** Calldata for the auction's block-parameterless view `selector`. */
export function buildNoArgViewCall(selector: string): string {
  return selector;
}

/** The `auction.checkpoint()` prep transaction (materializes a checkpoint). */
export function buildCheckpointTxCall(auction: string): UnsignedTx {
  return { to: auction, value: "0x0", data: encodeCheckpointCallData() };
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
 * (BidLib.sol:6-14): startBlock, startCumulativeMps, exitedBlock, maxPrice,
 * owner, amountQ96, tokensFilled. Throws on a wrong-size return.
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
 * Decode a `checkpoints(uint64)` return. Word order is the `Checkpoint` struct
 * field order (CheckpointLib.sol:7-14): clearingPrice,
 * currencyRaisedAtClearingPriceQ96X7, cumulativeMpsPerPrice, cumulativeMps,
 * prev, next. Throws on a wrong-size return.
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
 * True when `checkpoints(key)` holds an inserted checkpoint. An unmaterialized
 * key decodes to all zeros; every inserted checkpoint has `next != 0`
 * (`_insertCheckpoint` sets it to the next block or `MAX_BLOCK_NUMBER`,
 * CheckpointStorage.sol:30-43).
 */
export function isCheckpointMaterialized(cp: CheckpointView): boolean {
  return cp.next !== 0n;
}

// ---------------------------------------------------------------------------
// Pure derivation — bid state → available actions (port of desktop
// `deriveExitPlan` / `deriveClaimPlan` / `deriveBidActions`, exitHooks.ts:408-575)
// ---------------------------------------------------------------------------

/** Everything the derivation needs to know about the auction and chain. */
export interface AuctionContext {
  /** `isGraduated()` (ContinuousClearingAuction.sol:161-169). */
  graduated: boolean;
  /** `clearingPrice()` — the live price var. */
  liveClearingPrice: bigint;
  /** `endBlock()` (StepStorage.sol:749). */
  endBlock: bigint;
  /** `claimBlock()` (StepStorage.sol:754); >= endBlock at construction. */
  claimBlock: bigint;
  /** `eth_blockNumber` — proxy for `_getBlockNumberish()`. */
  currentBlock: bigint;
}

/**
 * The exit action the contract allows for one bid right now (exitHooks.ts:340).
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
 * maxPrice — the outbid checkpoint is materialized), `ended` (over, not
 * exited), `exited` (tokens waiting out the claim window), `claimable` (claim
 * unlocked), `settled` (nothing left to claim).
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
 * Derive the exit plan. Port of exitHooks.ts:408-510; branch citations live in
 * the module doc. Non-graduated over → `exitBid`; graduated over with
 * maxPrice > final → `exitBid`; materialized outbid → partial exit with the
 * two hints; graduated over with maxPrice == final → partial exit with
 * `outbidBlock = 0`; otherwise the decisive checkpoint is pending or nothing
 * is legal yet.
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

  // The first materialized checkpoint strictly above maxPrice, the first at
  // maxPrice, and the last strictly below — the contract's hint shape (:541-547).
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

  // Over with the final checkpoint materialized: tail is at endBlock (nothing
  // can checkpoint past it — bids revert at >= endBlock, :472, and
  // `checkpoint()` lands at endBlock once over, :422-424).
  const finalPrice = tail.clearingPrice;
  if (maxPrice > finalPrice) return { kind: "exitBid" };
  if (maxPrice === finalPrice) {
    // Partially filled at the end of the auction: outbidBlock = 0 (:573-582).
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
 * Derive the claim plan. Port of exitHooks.ts:512-542: claim requires a PRIOR
 * exit (`BidNotExited`, ContinuousClearingAuction.sol:651), a graduated
 * auction (:606) and the claim block (`onlyAfterClaimBlock`,
 * StepStorage.sol:55-58). A bid with `tokensFilled == 0` after exit has
 * nothing left to claim (:655-658).
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
// Plan → unsigned call(s) (port of exitHooks.ts:577-750)
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
): UnsignedTx {
  if (plan.kind === "exitBid") {
    return { to: auction, value: "0x0", data: encodeExitBid(bidId) };
  }
  if (plan.kind === "exitPartiallyFilledBid") {
    return {
      to: auction,
      value: "0x0",
      data: encodeExitPartiallyFilledBid(
        bidId,
        plan.lastFullyFilledCheckpointBlock,
        plan.outbidBlock,
      ),
    };
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
  build: () => UnsignedTx | Promise<UnsignedTx>;
}

/** Everything one exit/claim attempt needs; re-runnable for retries. */
export interface ExitExecution {
  /** Ordered steps to send. */
  calls: readonly ExitStepCall[];
  /** Full planned order (mirrors desktop `ExitExecution.order`). */
  order: readonly ExitStepId[];
}

/** Inputs for {@link buildExitExecution}. */
export interface ExitExecutionParams {
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
    order: ["exit"],
    calls: [
      { step: "exit", build: () => buildExitCallForPlan(auction, bidId, plan) },
    ],
  };
}

/** Inputs for {@link buildClaimExecution}. */
export interface ClaimExecutionParams {
  /** CCA auction address. */
  auction: string;
  /** The bids' owner (the batch variant re-checks ownership onchain). */
  owner: string;
  /** One id sends `claimTokens`; several send `claimTokensBatch`. */
  bidIds: readonly bigint[];
}

/**
 * Compose the single `claim` step: `claimTokens(bidId)` for one bid,
 * `claimTokensBatch(owner, bidIds)` for several (one transfer, one event per
 * bid — ContinuousClearingAuction.sol:617-643). Throws on an empty list.
 */
export function buildClaimExecution(
  params: ClaimExecutionParams,
): ExitExecution {
  const { auction, owner, bidIds } = params;
  if (bidIds.length === 0) throw new Error("claim needs at least one bid id");
  return {
    order: ["claim"],
    calls: [
      {
        step: "claim",
        build: () =>
          bidIds.length === 1
            ? {
                to: auction,
                value: "0x0",
                data: encodeClaimTokens(bidIds[0]),
              }
            : {
                to: auction,
                value: "0x0",
                data: encodeClaimTokensBatch(owner, [...bidIds]),
              },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Onchain reads (web JSON-RPC via ../chain.ts — the `evm_call` equivalent)
// ---------------------------------------------------------------------------

/** Read + decode `auction.bids(bidId)`. Throws on read/decode failure. */
export async function readBidView(
  endpoint: string,
  auction: string,
  bidId: bigint,
): Promise<BidView> {
  return decodeBidView(
    await ethCall(endpoint, auction, buildBidViewCall(bidId)),
  );
}

/** Read + decode `auction.checkpoints(block)`. Throws on read/decode failure. */
export async function readCheckpointView(
  endpoint: string,
  auction: string,
  block: bigint,
): Promise<CheckpointView> {
  return decodeCheckpointView(
    block,
    await ethCall(endpoint, auction, buildCheckpointViewCall(block)),
  );
}

async function readNoArgUint(
  endpoint: string,
  auction: string,
  selector: string,
): Promise<bigint> {
  return decodeU256(
    await ethCall(endpoint, auction, buildNoArgViewCall(selector)),
  );
}

/**
 * Walk the checkpoint linked list from `startBlock` via `next`
 * (CheckpointStorage.sol:30-43). Bounded by `limit` — an overrun is an error,
 * never a silent truncation (Review-Proven Rule 4).
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
  endpoint: string,
  auction: string,
): Promise<AuctionContext> {
  const [graduated, liveClearingPrice, endBlock, claimBlock, currentBlock] =
    await Promise.all([
      readNoArgUint(endpoint, auction, SELECTOR_IS_GRADUATED),
      readNoArgUint(endpoint, auction, SELECTOR_CLEARING_PRICE),
      readNoArgUint(endpoint, auction, SELECTOR_END_BLOCK),
      readNoArgUint(endpoint, auction, SELECTOR_CLAIM_BLOCK),
      ethBlockNumber(endpoint),
    ]);
  return {
    graduated: graduated !== 0n,
    liveClearingPrice,
    endBlock,
    claimBlock,
    currentBlock,
  };
}

/**
 * The owner's bid ids on one auction — the web equivalent of desktop's
 * `evm_find_bid_ids` (exitHooks.ts:102-107), done as the same bounded
 * `BidSubmitted` log scan the desktop command performs
 * (wallet.rs:25-27): `id` is topic[1] and `owner` topic[2]
 * (IContinuousClearingAuction.sol:103). Ascending, deduplicated.
 */
export async function findOwnedBidIds(
  endpoint: string,
  auction: string,
  owner: string,
): Promise<bigint[]> {
  const ownerTopic = `0x${owner.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
  const logs = await ethGetLogs(endpoint, {
    address: auction,
    topics: [TOPIC_BID_SUBMITTED, null, ownerTopic],
    fromBlock: "0x0",
    toBlock: "latest",
  });
  const ids = new Set<bigint>();
  for (const log of logs) {
    const topic = log.topics[1];
    if (typeof topic !== "string") continue;
    ids.add(BigInt(topic));
  }
  return [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
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
  endpoint: string;
  /** CCA auction address. */
  auction: string;
  /** The address whose bids to list. */
  owner: string;
  /** Checkpoint-walk bound per bid (default {@link DEFAULT_CHECKPOINT_WALK_LIMIT}). */
  walkLimit?: number;
}

/** Read one bid's derivation input (bid + its checkpoint walk). */
export async function fetchBidDerivation(
  endpoint: string,
  auction: string,
  bidId: bigint,
  walkLimit: number = DEFAULT_CHECKPOINT_WALK_LIMIT,
): Promise<{ bid: BidView; checkpoints: CheckpointView[] }> {
  const bid = await readBidView(endpoint, auction, bidId);
  const checkpoints = await fetchCheckpointWalk(
    (block) => readCheckpointView(endpoint, auction, block),
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
  endpoint: string,
  auction: string,
  bidId: bigint,
): Promise<ExitPlan> {
  const [ctx, { bid, checkpoints }] = await Promise.all([
    fetchAuctionContext(endpoint, auction),
    fetchBidDerivation(endpoint, auction, bidId),
  ]);
  return deriveExitPlan({ bidId, bid, checkpoints, auction: ctx });
}

/**
 * Read every owned bid on the auction: `findOwnedBidIds` for the id list, then
 * each bid's struct and checkpoint walk in parallel, then derive actions.
 */
export async function fetchMyBidsSnapshot(
  params: FetchMyBidsParams,
): Promise<MyBidsSnapshot> {
  const { endpoint, auction, owner, walkLimit } = params;
  const [ctx, bidIds] = await Promise.all([
    fetchAuctionContext(endpoint, auction),
    findOwnedBidIds(endpoint, auction, owner),
  ]);
  const bids = await Promise.all(
    bidIds.map(async (bidId): Promise<MyBidEntry> => {
      const { bid, checkpoints } = await fetchBidDerivation(
        endpoint,
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
