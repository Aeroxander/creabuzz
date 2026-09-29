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
  // Strict: only the canonical ABI bool (32 bytes, 0x…00 / 0x…01). Garbage
  // must never silently read as `true` — a bad `isGraduated` read would
  // misreport a live auction as graduated. Matches web's `decodeBoolStrict`.
  const padded = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (padded.length !== 64) throw new Error("expected 32-byte return");
  const v = hexToBigInt(`0x${padded}`);
  if (v > 1n) throw new Error("expected canonical bool");
  return v === 1n;
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

// ─── Chain presets ───────────────────────────────────────────────────────────
//
// The picker's single source of truth for this app. The web client renders the
// very same list (`web/src/features/launchpad/chain.ts`); `chainRpc.test.mjs`
// imports both and pins them equal, so the two lists cannot drift apart. Add a
// chain there AND here, in the same change.
//
// Paperclip machine-values rule: `label` is plain language for humans;
// `chainId` and `rpcUrl` are machine values and belong in small mono type in
// any UI that shows them.

/** One selectable chain for launchpad reads and writes. */
export interface ChainPreset {
  /** Stable machine id — safe for storage keys, tests, and analytics. */
  id: string;
  /** Plain-language name shown in pickers (e.g. "Local Anvil"). */
  label: string;
  /** EVM chain id as a number — render it in mono type, never as prose. */
  chainId: number;
  /** JSON-RPC HTTP endpoint for this chain. */
  rpcUrl: string;
  /** Block-explorer base URL, when the chain has one. */
  explorer?: string;
  /**
   * Expected seconds between blocks on a public network. Omitted for local
   * Anvil: it mines on demand, so there is no interval to promise.
   */
  blockTimeSeconds?: number;
  /** Native gas symbol (all current presets are ETH). */
  nativeSymbol: string;
  /** Real-money network; hidden unless `VITE_ENABLE_MAINNET` is set. */
  mainnet?: boolean;
}

/** Local dev chain booted by `just dev-chain` (`scripts/dev-chain.sh`). */
export const LOCAL_ANVIL_PRESET: ChainPreset = {
  id: "anvil",
  label: "Local Anvil",
  chainId: 31337,
  rpcUrl: "http://127.0.0.1:8545",
  nativeSymbol: "ETH",
};

/**
 * The configured default chain outside dev builds — `launchRecord.ts`'s
 * `chainId` default, which predates this picker.
 */
export const CONFIGURED_DEFAULT_CHAIN_ID = 11155111;

/** Every selectable chain, local first. */
export const CHAIN_PRESETS: readonly ChainPreset[] = [
  LOCAL_ANVIL_PRESET,
  {
    id: "sepolia",
    label: "Sepolia",
    chainId: 11155111,
    rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
    explorer: "https://sepolia.etherscan.io",
    blockTimeSeconds: 12,
    nativeSymbol: "ETH",
  },
  {
    id: "base",
    label: "Base",
    chainId: 8453,
    rpcUrl: "https://mainnet.base.org",
    explorer: "https://basescan.org",
    blockTimeSeconds: 2,
    nativeSymbol: "ETH",
    mainnet: true,
  },
  {
    id: "base-sepolia",
    label: "Base Sepolia",
    chainId: 84532,
    rpcUrl: "https://sepolia.base.org",
    explorer: "https://sepolia.basescan.org",
    blockTimeSeconds: 2,
    nativeSymbol: "ETH",
  },
];

/** Build-time env this module reads. Both keys are optional and public. */
export interface ChainEnv {
  /** Overrides the default preset's chain id in every build. */
  VITE_LAUNCHPAD_CHAIN_ID?: string;
  /** Overrides the default RPC endpoint in every build. */
  VITE_CHAIN_RPC_URL?: string;
  /** "1"/"true" offers mainnet presets (default off — contracts are unaudited). */
  VITE_ENABLE_MAINNET?: string;
}

function viteEnv(): ChainEnv | undefined {
  return (import.meta as { env?: ChainEnv }).env;
}

/**
 * Whether this build may offer mainnet chains. Off unless `VITE_ENABLE_MAINNET`
 * is "1"/"true": the launchpad contracts are unaudited and no legal posture
 * exists yet (docs/dao-os.md rule R4), so a default build shows test networks
 * only. Mirrors `web/src/features/launchpad/chain.ts`.
 */
export function mainnetEnabled(env: ChainEnv | undefined = viteEnv()): boolean {
  const flag = env?.VITE_ENABLE_MAINNET?.trim().toLowerCase();
  return flag === "1" || flag === "true";
}

/** The presets a picker may show: mainnets only when [`mainnetEnabled`]. */
export function selectableChainPresets(
  env: ChainEnv | undefined = viteEnv(),
): readonly ChainPreset[] {
  return mainnetEnabled(env)
    ? CHAIN_PRESETS
    : CHAIN_PRESETS.filter((preset) => preset.mainnet !== true);
}

/** Whether a chain id names a mainnet preset (real money). */
export function isMainnetChain(
  chainId: number | string | null | undefined,
): boolean {
  if (chainId === null || chainId === undefined) return false;
  return chainPresetByChainId(chainId)?.mainnet === true;
}

/** Whether this build is a dev build (`vite dev`; false when packaged). */
export function isDevBuild(): boolean {
  return Boolean(import.meta.env?.DEV);
}

/** The preset with this chain id, or null when the id is not preset-backed. */
export function chainPresetByChainId(
  chainId: number | string,
): ChainPreset | null {
  const id = typeof chainId === "number" ? chainId : Number(chainId.trim());
  if (!Number.isInteger(id)) return null;
  return CHAIN_PRESETS.find((preset) => preset.chainId === id) ?? null;
}

/** The preset a saved endpoint belongs to (trailing-slash tolerant), or null. */
export function chainPresetForEndpoint(endpoint: string): ChainPreset | null {
  const normalize = (url: string) => url.trim().replace(/\/+$/, "");
  const target = normalize(endpoint);
  return (
    CHAIN_PRESETS.find((preset) => normalize(preset.rpcUrl) === target) ?? null
  );
}

/**
 * The preset a picker should start on when nothing is saved yet.
 *
 * Order: `VITE_LAUNCHPAD_CHAIN_ID` (build-time config, wins in every build) →
 * Local Anvil in a dev build → the configured production default (Sepolia).
 * An unrecognized configured id falls through to the same rule rather than
 * leaving the picker with no chain at all.
 *
 * `dev` is the injection seam: production callers omit it and get this build's
 * real mode; the table test drives both modes through THIS function rather
 * than a test-only copy of the rule.
 */
export function defaultChainPreset(
  env: ChainEnv | undefined = viteEnv(),
  dev: boolean = isDevBuild(),
): ChainPreset {
  const configured = env?.VITE_LAUNCHPAD_CHAIN_ID?.trim();
  if (configured) {
    const preset = chainPresetByChainId(configured);
    // A mainnet default needs the explicit switch; otherwise fall through.
    if (preset && (preset.mainnet !== true || mainnetEnabled(env))) {
      return preset;
    }
  }
  if (dev) return LOCAL_ANVIL_PRESET;
  return (
    chainPresetByChainId(CONFIGURED_DEFAULT_CHAIN_ID) ?? LOCAL_ANVIL_PRESET
  );
}

/**
 * The endpoint chain reads go to for this relay.
 *
 * Saved choice first (per-relay, one action = one durable persist), then the
 * build-time `VITE_CHAIN_RPC_URL`, then the configured default (local Anvil —
 * `just dev-chain` boots what it points at).
 */
export function getRpcEndpoint(
  relayUrl: string | null | undefined,
  env: ChainEnv | undefined = viteEnv(),
): string {
  try {
    const saved = localStorage.getItem(endpointKey(relayUrl));
    if (saved) return saved;
  } catch {
    // Storage unavailable — the configured default below still applies.
  }
  const fromEnv = env?.VITE_CHAIN_RPC_URL?.trim();
  return fromEnv ? fromEnv : DEFAULT_RPC_ENDPOINT;
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
