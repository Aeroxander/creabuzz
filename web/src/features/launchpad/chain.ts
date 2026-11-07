/**
 * Reading the launchpad's contracts from the chain: sale progress, bids and block times, over JSON-RPC with retries.
 * The chain settings (networks, build settings, which endpoint to use) are in `chain-config.ts`, re-exported here.
 */

import {
  HistoryTooWideError,
  isRangeLimitError,
  isRateLimitError,
  rangeLimitFrom,
  readInPages,
} from "./lib/log-pages.ts";
import { reportHandledFailure } from "../../shared/lib/error-report.ts";
import { retryAfterOf, retryPause } from "../../shared/lib/timed-fetch.ts";
import {
  type ChainEnv,
  documentedBlockTimeSeconds,
  getRpcEndpoint,
  historyFromBlock,
  isDevBuild,
  viteEnv,
} from "./chain-config.ts";
import type { LaunchRecord } from "./models";
import {
  SAMPLE_BLOCKS,
  secondsPerBlockFrom,
  type BlockSample,
} from "./lib/time-blocks.ts";

// CCA selectors proven against the pinned sources
// (contracts/test/PinnedInterfaces.t.sol).
const SELECTOR_IS_GRADUATED = "0x9e5f2602";
const SELECTOR_CURRENCY_RAISED = "0x998ba4fc";
export const SELECTOR_CLEARING_PRICE = "0x32a0f2d7";
export const TOPIC_BID_SUBMITTED =
  "0x650baad5cd8ca09b8f580be220fa04ce2ba905a041f764b6a3fe2c848eb70540";

export * from "./chain-config.ts";

export interface AuctionProgress {
  raised: bigint;
  goal: bigint | null;
  graduated: boolean;
  ended: boolean;
  /**
   * Bid events seen on chain, or `null` when the log query itself failed.
   * `0` means the chain answered and no bid was submitted: reporting a failed
   * read as zero invents a figure the chain never gave.
   */
  bidCount: number | null;
  /**
   * `rpc` — read from the chain; `preview` — deterministic fixture, development
   * builds only; `simulated` — the sandbox launch's synthetic raise;
   * `unavailable` — the chain could not be read, so no figures are reported at
   * all.
   */
  source: "preview" | "rpc" | "simulated" | "unavailable";
  /** Why the chain read failed, when `source` is `unavailable`. */
  reason?: string;
}

function hashSeed(input: string): bigint {
  let hash = 14695981039346656037n;
  const mask = (1n << 64n) - 1n;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * 1099511628211n) & mask;
  }
  return hash;
}

/** Deterministic fixture. Always surfaced as preview, never as live data. */
async function previewProgress(record: LaunchRecord): Promise<AuctionProgress> {
  const seed = hashSeed(
    `${record.author}:${record.id}:${record.auction ?? "undeployed"}`,
  );
  const goal = record.requiredRaised
    ? BigInt(record.requiredRaised)
    : 100000000000n;
  const raised = (goal * (12n + (seed % 78n))) / 100n;
  return {
    raised,
    goal,
    graduated: record.stage === "graduated",
    ended: record.stage === "graduated" || record.stage === "failed",
    bidCount: Number(seed % 240n),
    source: "preview",
  };
}

/** Decode a 32-byte ABI word (`eth_call` return data). */
export function decodeU256(hex: string): bigint {
  const body = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (body.length !== 64 || !/^[0-9a-fA-F]+$/.test(body)) {
    throw new Error("expected 32-byte return");
  }
  return BigInt(`0x${body}`);
}

/**
 * Decode a JSON-RPC quantity.
 *
 * Quantities (`eth_blockNumber`, log fields) are minimal hex — `0x1` is one
 * byte — unlike `eth_call` return data, which is always a 32-byte word. Reading
 * a block number with the word decoder rejected every real node's answer.
 */
export function decodeQuantity(hex: string): bigint {
  const body = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (body.length === 0 || !/^[0-9a-fA-F]+$/.test(body)) {
    throw new Error("expected hex quantity");
  }
  return BigInt(`0x${body}`);
}

/**
 * How a read that fails for a passing reason is tried again: after each pause here, then it gives up. A public node
 * regularly drops a request or answers slowly; one dropped read must not turn a whole screen into an error. Reads only
 * (nothing here sends a transaction), so asking twice is harmless. Tests set it empty to fail fast.
 */
export const RPC_RETRY = { delaysMs: [300, 900] as number[] };

/**
 * A chain read that failed for a reason nobody on the page can fix by pressing anything but "try again later": the node
 * did not answer, could not be reached, or is busy. The message is for the person (what happened, what to do); `detail`
 * is the node's own words, for the error report.
 */
class ChainReadError extends Error {
  readonly reason: "busy" | "timeout" | "unreachable";
  readonly detail: string;

  constructor(
    reason: ChainReadError["reason"],
    message: string,
    detail: string,
  ) {
    super(message);
    this.name = "ChainReadError";
    this.reason = reason;
    this.detail = detail;
  }
}

/**
 * Tell the error collector about a failed read, once: a node that was busy, did not answer or could not be reached, and a
 * history too wide to read, were already told where the chain was asked (`rpc`, `ethGetLogs`), so a page that shows the
 * same failure does not tell it again under another name. Anything else (a contract that answered nonsense, a bug) is
 * told under `cause`.
 */
export function reportReadFailure(cause: string, error: unknown): void {
  if (error instanceof ChainReadError || error instanceof HistoryTooWideError) {
    return;
  }
  reportHandledFailure(cause, error);
}

/** A node's JSON-RPC answer that says it is asked too often. A revert is the contract's answer, never the node's load. */
function isBusyAnswer(error: unknown): boolean {
  return (
    error instanceof Error &&
    !/revert/i.test(error.message) &&
    (/^rpc http (429|5\d\d)$/.test(error.message) || isRateLimitError(error))
  );
}

/** A failure worth asking again about: a timeout, a dropped connection, or a node that is busy. */
function isPassingFailure(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (error instanceof TypeError) return true;
  return isBusyAnswer(error);
}

/** The words a passing failure ends in once the retries are spent, told to the error collector once a visit. */
function finalPassingFailure(error: unknown): ChainReadError {
  const detail = error instanceof Error ? error.message : String(error);
  const failure =
    error instanceof DOMException && error.name === "AbortError"
      ? new ChainReadError(
          "timeout",
          "The chain node did not answer in time. Try again in a moment.",
          detail,
        )
      : error instanceof TypeError
        ? new ChainReadError(
            "unreachable",
            "Could not reach the chain node. Check your connection and try again.",
            detail,
          )
        : new ChainReadError(
            "busy",
            "The chain node is busy. Try again in a minute; if it keeps happening, tell the site's organiser.",
            detail,
          );
  reportHandledFailure(`chain-${failure.reason}`, failure);
  return failure;
}

/** A node's HTTP refusal, with how long it asked to be left alone (its `Retry-After`), when it said. */
class RpcHttpError extends Error {
  readonly retryAfterMs: number | null;

  constructor(status: number, retryAfterMs: number | null) {
    super(`rpc http ${status}`);
    this.name = "RpcHttpError";
    this.retryAfterMs = retryAfterMs;
  }
}

async function rpcOnce(
  endpoint: string,
  method: string,
  params: unknown[],
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    if (!res.ok) throw new RpcHttpError(res.status, retryAfterOf(res));
    const body = (await res.json()) as {
      result?: unknown;
      error?: { message?: string; data?: unknown };
    };
    if (body.error) {
      // A reverted call reports its custom error as revert `data`; some nodes
      // leave it out of `message`, so carry it along for callers that classify.
      const data =
        typeof body.error.data === "string" ? ` ${body.error.data}` : "";
      throw new Error(`${body.error.message ?? "rpc error"}${data}`);
    }
    return body.result;
  } finally {
    clearTimeout(timer);
  }
}

async function rpc(
  endpoint: string,
  method: string,
  params: unknown[],
  timeoutMs = 6000,
): Promise<unknown> {
  if (!endpoint) {
    throw new Error("This site is not connected to a chain yet.");
  }
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await rpcOnce(endpoint, method, params, timeoutMs);
    } catch (error) {
      if (!isPassingFailure(error)) throw error;
      const planned = RPC_RETRY.delaysMs[attempt];
      // Never ask a busy node again sooner than its Retry-After said; a node that asks for a long wait ends the
      // retries now instead of holding the screen.
      const pause =
        planned === undefined
          ? null
          : retryPause(
              planned,
              error instanceof RpcHttpError ? error.retryAfterMs : null,
            );
      // Say it in words: the raw abort text ("signal is aborted without reason"), "rpc http 429" and a node's own
      // rate-limit text reach people's screens otherwise.
      if (pause === null) throw finalPassingFailure(error);
      await new Promise((resolve) => setTimeout(resolve, pause));
    }
  }
}

/** One `eth_call` view read. Returns the raw hex return data. */
export async function ethCall(
  endpoint: string,
  to: string,
  data: string,
): Promise<string> {
  const result = await rpc(endpoint, "eth_call", [{ to, data }, "latest"]);
  if (typeof result !== "string") throw new Error("bad eth_call return");
  return result;
}

/**
 * What the node says a call from `from` would use, asked live. A node that refuses the call (it would revert) rejects with
 * its own words; a node that does not answer within `timeoutMs` rejects too, so the caller never waits without end.
 */
export async function ethEstimateGas(
  endpoint: string,
  call: { from: string; to: string; data: string },
  timeoutMs = 20_000,
): Promise<bigint> {
  const result = await rpc(endpoint, "eth_estimateGas", [call], timeoutMs);
  if (typeof result !== "string") throw new Error("bad eth_estimateGas return");
  return decodeQuantity(result);
}

/**
 * An address's nonce, counting transactions not yet mined: for a contract, how many contracts it has made, which is
 * where its next one goes.
 */
export async function ethPendingNonce(
  endpoint: string,
  address: string,
): Promise<bigint> {
  return decodeQuantity(
    String(
      await rpc(endpoint, "eth_getTransactionCount", [address, "pending"]),
    ),
  );
}

/** Chain identity used to match the wallet to the credit preview RPC. */
export async function ethChainId(endpoint: string): Promise<bigint> {
  return decodeQuantity(String(await rpc(endpoint, "eth_chainId", [])));
}

/** Receipt polling uses the same bounded RPC requests as other chain reads. */
export async function ethTransactionReceipt(
  endpoint: string,
  hash: string,
): Promise<{
  status?: string;
  logs?: unknown[];
  blockNumber?: string;
} | null> {
  return (await rpc(endpoint, "eth_getTransactionReceipt", [hash])) as {
    status?: string;
    logs?: unknown[];
    blockNumber?: string;
  } | null;
}

/** The calldata of a mined transaction, or null when the node does not know it. */
export async function ethTransactionInput(
  endpoint: string,
  hash: string,
): Promise<string | null> {
  const tx = await rpc(endpoint, "eth_getTransactionByHash", [hash]);
  if (tx === null || typeof tx !== "object") return null;
  const input = (tx as { input?: unknown }).input;
  return typeof input === "string" ? input : null;
}

/** `eth_blockNumber` — the chain head, as the derivation's current block. */
export async function ethBlockNumber(endpoint: string): Promise<bigint> {
  return decodeQuantity((await rpc(endpoint, "eth_blockNumber", [])) as string);
}

/** `eth_getBalance` — an ETH pool read (e.g. a DAO's ETH balance). */
export async function ethGetBalance(
  endpoint: string,
  address: string,
): Promise<bigint> {
  return decodeQuantity(
    (await rpc(endpoint, "eth_getBalance", [address, "latest"])) as string,
  );
}

/** How many block lookups are in flight at once: a public node refuses a burst of a couple of hundred. */
export const BLOCK_LOOKUP_CONCURRENCY = 8;

/**
 * Timestamps for explicit block numbers — the sample the block-time
 * conversion runs on. Bounded by the caller (`SAMPLE_BLOCKS`) and best-effort:
 * a block that cannot be fetched is dropped, never invented.
 */
export async function ethBlockTimestamps(
  endpoint: string,
  blocks: readonly number[],
): Promise<BlockSample[]> {
  const lookup = async (block: number): Promise<BlockSample> => {
    const tag = `0x${Math.trunc(block).toString(16)}`;
    const result = await rpc(endpoint, "eth_getBlockByNumber", [tag, false]);
    if (result === null || typeof result !== "object") {
      throw new Error("bad eth_getBlockByNumber return");
    }
    const body = result as { number?: unknown; timestamp?: unknown };
    if (typeof body.number !== "string" || typeof body.timestamp !== "string") {
      throw new Error("block without number/timestamp");
    }
    return {
      block: Number(decodeQuantity(body.number)),
      timestampSeconds: Number(decodeQuantity(body.timestamp)),
    };
  };
  // A few at a time, not all at once: a node that answers a burst with "too many requests" would otherwise drop most of
  // the sample. A block that still cannot be fetched is left out, never invented.
  const samples: BlockSample[] = [];
  for (let i = 0; i < blocks.length; i += BLOCK_LOOKUP_CONCURRENCY) {
    const batch = await Promise.allSettled(
      blocks.slice(i, i + BLOCK_LOOKUP_CONCURRENCY).map(lookup),
    );
    for (const result of batch) {
      if (result.status === "fulfilled") samples.push(result.value);
    }
  }
  return samples;
}

/** What the create wizard converts calendar dates with. */
export interface ChainBlockTime {
  /** Seconds per block: sampled median, or the documented chain default. */
  secondsPerBlock: number;
  source: "measured" | "default";
  /** Chain head, `null` when the chain could not be read at all. */
  head: number | null;
  /** Blocks whose timestamps actually answered (0 when nothing was read). */
  sampleSize: number;
}

/**
 * Measure this chain's block time for the time → block conversion.
 *
 * Reads the head, then at most `SAMPLE_BLOCKS` consecutive block timestamps
 * (bounded: rule 4) and takes the median gap. Any failure — unreachable RPC,
 * a node that answers `eth_blockNumber` but not block bodies, a sample with
 * no usable gap — falls back to the documented per-chain default and says so
 * through `source`; `head` stays `null` rather than being guessed, because a
 * fabricated head would silently misplace the auction's start.
 */
export async function measureChainBlockTime(
  endpoint: string,
  chainId?: string,
  sampleBlocks: number = SAMPLE_BLOCKS,
): Promise<ChainBlockTime> {
  const fallback: ChainBlockTime = {
    secondsPerBlock: documentedBlockTimeSeconds(chainId),
    source: "default",
    head: null,
    sampleSize: 0,
  };
  let head: number;
  try {
    head = Number(await ethBlockNumber(endpoint));
    if (!Number.isSafeInteger(head) || head < 0) return fallback;
  } catch {
    return fallback;
  }
  const wanted: number[] = [];
  const count = Math.min(Math.max(2, Math.trunc(sampleBlocks)), SAMPLE_BLOCKS);
  for (let i = 0; i < count && i <= head; i++) wanted.push(head - i);
  try {
    const samples = await ethBlockTimestamps(endpoint, wanted);
    const secondsPerBlock = secondsPerBlockFrom(samples);
    if (secondsPerBlock === null) return { ...fallback, head };
    return {
      secondsPerBlock,
      source: "measured",
      head,
      sampleSize: samples.length,
    };
  } catch {
    return { ...fallback, head };
  }
}

/** One log entry as `eth_getLogs` returns it (hex quantity fields). */
export interface RpcLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
}

/**
 * The chain id behind each endpoint, asked once: it is needed before every history read that has a start block to apply,
 * and it does not change while the page is open. Only answers are kept (a failed ask is asked again next time), and there
 * are only ever a handful of endpoints, so the map stays small.
 */
const endpointChainIds = new Map<string, Promise<bigint>>();
const MAX_ENDPOINTS_REMEMBERED = 8;

function chainIdOf(endpoint: string): Promise<bigint> {
  const known = endpointChainIds.get(endpoint);
  if (known) return known;
  if (endpointChainIds.size >= MAX_ENDPOINTS_REMEMBERED) {
    endpointChainIds.clear();
  }
  const asked = ethChainId(endpoint).catch((error: unknown) => {
    if (endpointChainIds.get(endpoint) === asked) {
      endpointChainIds.delete(endpoint);
    }
    throw error;
  });
  endpointChainIds.set(endpoint, asked);
  return asked;
}

/** Forget the remembered chain ids (tests). */
export function forgetEndpointChainIds(): void {
  endpointChainIds.clear();
}

/**
 * `eth_getLogs` (address + topic filtered). Starts at the block the build names as the start of this chain's history
 * (`VITE_HISTORY_FROM_BLOCKS`) whenever the filter asks for earlier, so a read never covers blocks no contract here could
 * have written in. When the node says even that is too wide (a real node usually caps the block range of one request) it
 * is read again in pages. See `lib/log-pages.ts`. A busy or failing node is not paged around: its error is the caller's,
 * in plain words (`rpc`), and a history too long to read is told to the error collector.
 */
export async function ethGetLogs(
  endpoint: string,
  filter: {
    address: string;
    topics: (string | null)[];
    fromBlock: string;
    toBlock: string;
  },
  env: ChainEnv | undefined = viteEnv(),
): Promise<RpcLog[]> {
  const read = async (query: typeof filter): Promise<RpcLog[]> => {
    const result = await rpc(endpoint, "eth_getLogs", [query]);
    if (!Array.isArray(result)) throw new Error("bad eth_getLogs return");
    return result as RpcLog[];
  };
  // Only a build that names a history start costs the chain id question (asked once per endpoint).
  const floor = env?.VITE_HISTORY_FROM_BLOCKS?.trim()
    ? historyFromBlock((await chainIdOf(endpoint)).toString(), env)
    : 0n;
  const first =
    floor > 0n &&
    filter.fromBlock !== "latest" &&
    decodeQuantity(filter.fromBlock) < floor
      ? { ...filter, fromBlock: `0x${floor.toString(16)}` }
      : filter;
  try {
    return await read(first);
  } catch (error) {
    if (!isRangeLimitError(error)) throw error;
    const head = await ethBlockNumber(endpoint);
    const asked =
      first.fromBlock === "latest" ? head : decodeQuantity(first.fromBlock);
    const until =
      first.toBlock === "latest" ? head : decodeQuantity(first.toBlock);
    try {
      return await readInPages({
        from: asked > floor ? asked : floor,
        to: until < head ? until : head,
        pageSize: rangeLimitFrom(error) ?? undefined,
        fetchPage: (from, to) =>
          read({
            ...first,
            fromBlock: `0x${from.toString(16)}`,
            toBlock: `0x${to.toString(16)}`,
          }),
      });
    } catch (paged) {
      if (paged instanceof HistoryTooWideError) {
        reportHandledFailure("chain-history-too-wide", paged);
      }
      throw paged;
    }
  }
}

/** Live reads. Throws on any failure so callers fall back to preview. */
async function liveProgress(
  record: LaunchRecord,
  endpoint: string,
): Promise<AuctionProgress> {
  if (!record.auction) throw new Error("no auction contract linked");
  const call = (data: string) =>
    rpc(endpoint, "eth_call", [{ to: record.auction, data }, "latest"]);
  const [graduatedRaw, raisedRaw, blockRaw] = await Promise.all([
    call(SELECTOR_IS_GRADUATED),
    call(SELECTOR_CURRENCY_RAISED),
    rpc(endpoint, "eth_blockNumber", []),
  ]);
  if (
    typeof graduatedRaw !== "string" ||
    typeof raisedRaw !== "string" ||
    typeof blockRaw !== "string"
  ) {
    throw new Error("bad rpc result");
  }
  const graduated = decodeU256(graduatedRaw) !== 0n;
  const raised = decodeU256(raisedRaw);
  const block = decodeQuantity(blockRaw);
  const claimBlock =
    record.claimBlock !== null ? BigInt(record.claimBlock) : null;
  let bidCount: number | null = null;
  try {
    const logs = await ethGetLogs(endpoint, {
      address: record.auction,
      topics: [TOPIC_BID_SUBMITTED],
      fromBlock: "0x0",
      toBlock: "latest",
    });
    // An answer from the chain: zero bids is a fact here, not a guess.
    bidCount = logs.length;
  } catch {
    // Leave it unknown; the rest of the read succeeded, so the caller still
    // gets live figures for everything the chain did answer.
    bidCount = null;
  }
  return {
    raised,
    goal: record.requiredRaised ? BigInt(record.requiredRaised) : null,
    graduated,
    ended: graduated || (claimBlock !== null && block >= claimBlock),
    bidCount,
    source: "rpc",
  };
}

/**
 * The auction's current clearing price (Q96), read through `clearingPrice()`.
 *
 * Read on demand for the bid composer: a bid must be above the clearing price
 * (`BidMustBeAboveClearingPrice`) and on the tick grid. Returns null when the
 * read fails (no linked auction, bad RPC) so the caller can still let the
 * contract enforce the rule rather than inventing a price to validate against.
 */
export async function clearingPrice(
  endpoint: string,
  auctionAddress: string,
): Promise<bigint | null> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(auctionAddress)) return null;
  try {
    const result = (await rpc(endpoint, "eth_call", [
      { to: auctionAddress, data: SELECTOR_CLEARING_PRICE },
      "latest",
    ])) as unknown;
    return typeof result === "string" ? decodeU256(result) : null;
  } catch {
    return null;
  }
}

/**
 * ERC-20 balance of an address, read through `balanceOf`.
 *
 * The treasury panel needs one number the chain can actually answer today:
 * `requiredCurrencyRaised` and the issuance schedule have no on-chain getter, but
 * a token balance does. Returns null when the read fails, so the panel can say
 * "not readable" instead of showing zero.
 */
export async function erc20BalanceOf(
  endpoint: string,
  token: string,
  holder: string,
): Promise<bigint | null> {
  if (
    !/^0x[0-9a-fA-F]{40}$/.test(token) ||
    !/^0x[0-9a-fA-F]{40}$/.test(holder)
  ) {
    return null;
  }
  const data = `0x70a08231${holder.slice(2).toLowerCase().padStart(64, "0")}`;
  try {
    const result = (await rpc(endpoint, "eth_call", [
      { to: token, data },
      "latest",
    ])) as unknown;
    return typeof result === "string" ? decodeU256(result) : null;
  } catch {
    return null;
  }
}

/** True when address holds contract code. Throws on RPC failure. */
export async function isContractDeployed(
  endpoint: string,
  address: string,
): Promise<boolean> {
  const code = (await rpc(endpoint, "eth_getCode", [
    address,
    "latest",
  ])) as unknown;
  return typeof code === "string" && code !== "0x" && code.length > 2;
}

/** No figures: the chain could not be read, and guessing money is not an option. */
function unavailableProgress(reason: string): AuctionProgress {
  return {
    raised: 0n,
    goal: null,
    graduated: false,
    ended: false,
    bidCount: null,
    source: "unavailable",
    reason,
  };
}

/**
 * Live chain values when an auction contract is linked.
 *
 * A failed read yields `unavailable` — never the fixture — in a production
 * build. The fixture stays available to development builds and to tests that
 * opt in with `allowPreview`.
 */
export async function auctionProgress(
  record: LaunchRecord,
  { allowPreview = isDevBuild() }: { allowPreview?: boolean } = {},
): Promise<AuctionProgress> {
  if (record.auction) {
    try {
      return await liveProgress(record, getRpcEndpoint());
    } catch (error) {
      if (allowPreview) return previewProgress(record);
      return unavailableProgress(
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  if (allowPreview) return previewProgress(record);
  return unavailableProgress("no auction contract linked");
}

export function progressPercent(raised: bigint, goal: bigint | null): number {
  if (goal === null || goal === 0n) return 0;
  return Number((raised * 10000n) / goal) / 100;
}
