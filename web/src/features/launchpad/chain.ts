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
  bidCount: number;
  source: "preview" | "rpc";
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

function decodeU256(hex: string): bigint {
  const body = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (body.length !== 64 || !/^[0-9a-fA-F]+$/.test(body)) {
    throw new Error("expected 32-byte return");
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
  const block = decodeU256(blockRaw);
  const claimBlock =
    record.claimBlock !== null ? BigInt(record.claimBlock) : null;
  let bidCount = 0;
  try {
    const logs = (await rpc(endpoint, "eth_getLogs", [
      {
        address: record.auction,
        topics: [TOPIC_BID_SUBMITTED],
        fromBlock: "0x0",
        toBlock: "latest",
      },
    ])) as unknown[];
    bidCount = Array.isArray(logs) ? logs.length : 0;
  } catch {
    bidCount = 0;
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

/** Live first when an auction is linked, preview otherwise. */
export async function auctionProgress(
  record: LaunchRecord,
): Promise<AuctionProgress> {
  if (record.auction) {
    try {
      return await liveProgress(record, getRpcEndpoint());
    } catch {
      // Unreachable RPC or undeployed contract — fall through to preview.
    }
  }
  return previewProgress(record);
}

export function progressPercent(raised: bigint, goal: bigint | null): number {
  if (goal === null || goal === 0n) return 0;
  return Number((raised * 10000n) / goal) / 100;
}
