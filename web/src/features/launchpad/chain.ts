import type { LaunchRecord } from "./models";

// CCA selectors proven against the pinned sources
// (contracts/test/PinnedInterfaces.t.sol).
export const SELECTOR_IS_GRADUATED = "0x9e5f2602";
export const SELECTOR_CURRENCY_RAISED = "0x998ba4fc";
export const TOPIC_BID_SUBMITTED =
  "0x650baad5cd8ca09b8f580be220fa04ce2ba905a041f764b6a3fe2c848eb70540";

export const DEFAULT_RPC_ENDPOINT = "http://127.0.0.1:8545";
const ENDPOINT_KEY = "buzz.launchpad.rpc";

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
   * builds only; `unavailable` — the chain could not be read, so no figures are
   * reported at all.
   */
  source: "preview" | "rpc" | "unavailable";
  /** Why the chain read failed, when `source` is `unavailable`. */
  reason?: string;
}

/**
 * Whether this build may show the deterministic preview fixture.
 *
 * Optional chaining keeps the module importable outside Vite (unit tests), and
 * a production build never fabricates funding figures a user could mistake for
 * real money.
 */
export function isDevBuild(): boolean {
  return Boolean(import.meta.env?.DEV);
}

export function getRpcEndpoint(): string {
  try {
    return window.localStorage.getItem(ENDPOINT_KEY) ?? DEFAULT_RPC_ENDPOINT;
  } catch {
    return DEFAULT_RPC_ENDPOINT;
  }
}

export function setRpcEndpoint(endpoint: string): void {
  try {
    window.localStorage.setItem(ENDPOINT_KEY, endpoint);
  } catch {
    // Storage unavailable — the default still applies.
  }
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
export async function previewProgress(
  record: LaunchRecord,
): Promise<AuctionProgress> {
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

async function rpc(
  endpoint: string,
  method: string,
  params: unknown[],
  timeoutMs = 6000,
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
    if (!res.ok) throw new Error(`rpc http ${res.status}`);
    const body = (await res.json()) as {
      result?: unknown;
      error?: { message?: string };
    };
    if (body.error) throw new Error(body.error.message ?? "rpc error");
    return body.result;
  } finally {
    clearTimeout(timer);
  }
}

/** Live reads. Throws on any failure so callers fall back to preview. */
export async function liveProgress(
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
    const logs = (await rpc(endpoint, "eth_getLogs", [
      {
        address: record.auction,
        topics: [TOPIC_BID_SUBMITTED],
        fromBlock: "0x0",
        toBlock: "latest",
      },
    ])) as unknown[];
    // An answer from the chain: zero bids is a fact here, not a guess.
    if (Array.isArray(logs)) bidCount = logs.length;
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
export function unavailableProgress(reason: string): AuctionProgress {
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
