import type {
  AuctionProgress,
  LaunchChainAdapter,
} from "@/features/launchpad/lib/chain";
import type { LaunchRecord } from "@/features/launchpad/launchpadModels";

// Selectors from Uniswap/continuous-clearing-auction (factory v2.1.0).
// Regenerate with: `cast keccak '<signature>'` (first 4 bytes).
// - isGraduated() -> 0x9e5f2602
// - currencyRaised() -> 0x998ba4fc
// - BidSubmitted(uint256,address,uint256,uint128) topic ->
//   0x650baad5cd8ca09b8f580be220fa04ce2ba905a041f764b6a3fe2c848eb70540
// Proven against the pinned sources in contracts/test/PinnedInterfaces.t.sol.
export const SELECTOR_IS_GRADUATED = "0x9e5f2602";
export const SELECTOR_CURRENCY_RAISED = "0x998ba4fc";
export const TOPIC_BID_SUBMITTED =
  "0x650baad5cd8ca09b8f580be220fa04ce2ba905a041f764b6a3fe2c848eb70540";

const RPC_TIMEOUT_MS = 6000;

export function hexToBigInt(hex: string): bigint {
  if (!/^0x[0-9a-fA-F]*$/.test(hex)) throw new Error("not hex");
  const body = hex.slice(2);
  if (body.length === 0) throw new Error("empty hex");
  if (body.length > 64) throw new Error("overflow: expected 32 bytes");
  return BigInt(`0x${body}`);
}

/** Decode an eth_call uint256/bool return (32 bytes, big-endian). */
export function decodeUint256(hex: string): bigint {
  const padded = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (padded.length !== 64) throw new Error("expected 32-byte return");
  return hexToBigInt(`0x${padded}`);
}

export function decodeBool(hex: string): boolean {
  return decodeUint256(hex) !== 0n;
}

type RpcCall = { to: string; data: string };

async function ethRpc(
  endpoint: string,
  method: string,
  params: unknown[],
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
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

async function ethCall(
  endpoint: string,
  call: RpcCall,
  block: string = "latest",
): Promise<string> {
  const result = await ethRpc(endpoint, "eth_call", [call, block]);
  if (typeof result !== "string") throw new Error("bad eth_call result");
  return result;
}

/**
 * Live adapter: reads auction state directly from chain. Throws on any
 * failure so callers can fall back to the preview fixture (which must stay
 * badged as preview). No wallet, no signing — read-only `eth_call`.
 */
export class RpcChainAdapter implements LaunchChainAdapter {
  readonly source = "rpc" as const;
  private readonly endpoint: string;
  constructor(endpoint: string) {
    this.endpoint = endpoint;
  }

  async getAuctionProgress(record: LaunchRecord): Promise<AuctionProgress> {
    if (!record.auction) throw new Error("no auction contract linked");
    const [graduatedRaw, raisedRaw, blockRaw] = await Promise.all([
      ethCall(this.endpoint, {
        to: record.auction,
        data: SELECTOR_IS_GRADUATED,
      }),
      ethCall(this.endpoint, {
        to: record.auction,
        data: SELECTOR_CURRENCY_RAISED,
      }),
      ethRpc(this.endpoint, "eth_blockNumber", []),
    ]);
    const graduated = decodeBool(graduatedRaw);
    const raised = decodeUint256(raisedRaw);
    if (typeof blockRaw !== "string") throw new Error("bad block number");
    const block = hexToBigInt(blockRaw);
    const claimBlock =
      record.claimBlock !== null ? BigInt(record.claimBlock) : null;
    const ended = graduated || (claimBlock !== null && block >= claimBlock);

    let bidCount = 0;
    try {
      const logs = (await ethRpc(this.endpoint, "eth_getLogs", [
        {
          address: record.auction,
          topics: [TOPIC_BID_SUBMITTED],
          fromBlock: "0x0",
          toBlock: "latest",
        },
      ])) as Array<{ topics?: string[] }>;
      bidCount = Array.isArray(logs) ? logs.length : 0;
    } catch {
      // Bid counts are enrichment; a node without log support still yields
      // the core progress numbers.
      bidCount = 0;
    }

    const goal = record.requiredRaised ? BigInt(record.requiredRaised) : null;
    return {
      raised,
      goal,
      clearingPrice: record.floorPrice,
      graduated,
      ended,
      bidCount,
      source: "rpc",
    };
  }
}

const ENDPOINT_PREFIX = "buzz.launchpad.rpc.";

function endpointKey(relayUrl: string | null | undefined): string {
  return `${ENDPOINT_PREFIX}${relayUrl ?? "local"}`;
}

export const DEFAULT_RPC_ENDPOINT = "http://127.0.0.1:8545";

export function getRpcEndpoint(relayUrl: string | null | undefined): string {
  try {
    return localStorage.getItem(endpointKey(relayUrl)) ?? DEFAULT_RPC_ENDPOINT;
  } catch {
    return DEFAULT_RPC_ENDPOINT;
  }
}

export function setRpcEndpoint(
  relayUrl: string | null | undefined,
  endpoint: string,
): void {
  try {
    localStorage.setItem(endpointKey(relayUrl), endpoint);
  } catch {
    // Storage unavailable — the default still applies.
  }
}

/** True when address holds contract code. Read-only, throws on RPC failure. */
export async function isContractDeployed(
  endpoint: string,
  address: string,
): Promise<boolean> {
  const codeAt = (await ethRpc(endpoint, "eth_getCode", [
    address,
    "latest",
  ])) as unknown;
  return typeof codeAt === "string" && codeAt !== "0x" && codeAt.length > 2;
}
