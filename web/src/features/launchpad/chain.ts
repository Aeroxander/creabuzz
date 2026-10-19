import {
  type CodeHashes,
  EXCHANGE_CONTRACTS,
  parseCodeHash,
} from "./lib/exchange-verify.ts";
import {
  isRangeLimitError,
  rangeLimitFrom,
  readInPages,
} from "./lib/log-pages.ts";
import { saleCurrencyFor, type SaleCurrency } from "./lib/sale-currency.ts";
import type { LaunchRecord } from "./models";
import {
  DEFAULT_SECONDS_PER_BLOCK,
  SAMPLE_BLOCKS,
  secondsPerBlockFrom,
  type BlockSample,
} from "./lib/time-blocks.ts";

// CCA selectors proven against the pinned sources
// (contracts/test/PinnedInterfaces.t.sol).
export const SELECTOR_IS_GRADUATED = "0x9e5f2602";
export const SELECTOR_CURRENCY_RAISED = "0x998ba4fc";
export const SELECTOR_CLEARING_PRICE = "0x32a0f2d7";
export const TOPIC_BID_SUBMITTED =
  "0x650baad5cd8ca09b8f580be220fa04ce2ba905a041f764b6a3fe2c848eb70540";

export const DEFAULT_RPC_ENDPOINT = "http://127.0.0.1:8545";
const ENDPOINT_KEY = "buzz.launchpad.rpc";

// ─── Chain presets ───────────────────────────────────────────────────────────
//
// The picker's single source of truth. The desktop control renders the very
// same list (`desktop/src/features/launchpad/lib/chainRpc.ts`, pinned equal by
// `chainRpc.test.mjs`), so a new chain is added ONCE here and once there.
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
 * The app's configured default chain in production —
 * `LAUNCH_DEFAULTS.chainId` in `models.ts`, which predates this picker.
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

/** A chain id in words: the name of the preset when the app knows the chain, else "network <id>". */
export function networkLabel(chainId: number): string {
  return (
    CHAIN_PRESETS.find((preset) => preset.chainId === chainId)?.label ??
    `network ${chainId}`
  );
}

/** Build-time env this module reads. Both keys are optional and public. */
export interface ChainEnv {
  /** Overrides the default preset's chain id in every build. */
  VITE_LAUNCHPAD_CHAIN_ID?: string;
  /** Overrides the default RPC endpoint in every build. */
  VITE_CHAIN_RPC_URL?: string;
  /** "1"/"true" offers mainnet presets (default off — contracts are unaudited). */
  VITE_ENABLE_MAINNET?: string;
  /** Address of the dev USDC on a local chain (a local deploy has no fixed one). */
  VITE_LOCAL_USDC?: string;
  /**
   * The launch kit per chain, as JSON: `{"31337":"0x…"}`. A chain with no entry cannot launch a DAO from the app
   * (the kit is deployed per chain, so there is no address to guess).
   */
  VITE_DAO_LAUNCH_KITS?: string;
  /**
   * The DAO maker (`OrgBinding`) per chain, as JSON: `{"31337":"0x…"}`. It makes a DAO with no sale at all, which is what
   * a contributor project is. A chain with no entry cannot start one from the app.
   */
  VITE_ORG_BINDINGS?: string;
  /**
   * The block each chain's history starts at, as JSON: `{"11155111":7654321}`. Name the block the launch kit was deployed
   * at: every contract the app reads events from was made after it. Only used when a node refuses a read of the whole
   * history for being too wide; a chain with no entry is then read from block 0, which a long chain cannot finish.
   */
  VITE_HISTORY_FROM_BLOCKS?: string;
  /**
   * The price service's base URL (`services/price-indexer`). Without one, prices come only from recorded bids and the
   * sale's floor, as they always did.
   */
  VITE_PRICE_INDEXER_URL?: string;
  /**
   * The exchange's contracts per chain, as JSON: `{"31337":{"amm":"0x…","hook":"0x…","registry":"0x…","poolType":"0x…"}}`.
   * A chain with no entry has no market to put Shares on or trade them in. On any chain but the local test chain an
   * entry must also carry `"codehashes"` (the keccak256 of each contract's runtime code, same four names): the app
   * reads the code at each address and offers a market only when it matches. An unpinned entry for a real chain is
   * refused, so a build can never point at an address nobody checked.
   */
  VITE_LBAMM_ADDRESSES?: string;
}

export interface ExchangeAddresses {
  amm: string;
  hook: string;
  registry: string;
  poolType: string;
}

function viteEnv(): ChainEnv | undefined {
  return (import.meta as { env?: ChainEnv }).env;
}

/** The dev USDC's address on a local chain, when the build knows one. */
export function localUsdcAddress(
  env: ChainEnv | undefined = viteEnv(),
): string | null {
  const value = env?.VITE_LOCAL_USDC?.trim();
  return value ? value : null;
}

/**
 * The launch kit on `chainId`, or null when the build does not name one (never guessed: a wrong address would send
 * a founder's launch to a stranger's contract). Strict: the map must be a JSON object of chain id to address.
 */
export function daoLaunchKit(
  chainId: string | number | null,
  env: ChainEnv | undefined = viteEnv(),
): string | null {
  return addressForChain(env?.VITE_DAO_LAUNCH_KITS, chainId);
}

/**
 * The DAO maker on `chainId` that a contributor project is started with, or null when the build does not name one.
 * Never guessed, for the same reason as the launch kit; the same strict JSON map of chain id to address.
 */
export function orgBinding(
  chainId: string | number | null,
  env: ChainEnv | undefined = viteEnv(),
): string | null {
  return addressForChain(env?.VITE_ORG_BINDINGS, chainId);
}

function addressForChain(
  value: string | undefined,
  chainId: string | number | null,
): string | null {
  const raw = value?.trim();
  if (!raw || chainId === null) return null;
  try {
    const map: unknown = JSON.parse(raw);
    if (map === null || typeof map !== "object" || Array.isArray(map)) {
      return null;
    }
    const address = (map as Record<string, unknown>)[String(chainId)];
    return typeof address === "string" && /^0x[0-9a-fA-F]{40}$/.test(address)
      ? address.toLowerCase()
      : null;
  } catch {
    return null;
  }
}

/** The block `chainId`'s history starts at, or 0 when the build names none (strict: a JSON object of chain id to block). */
export function historyFromBlock(
  chainId: string | number,
  env: ChainEnv | undefined = viteEnv(),
): bigint {
  const raw = env?.VITE_HISTORY_FROM_BLOCKS?.trim();
  if (!raw) return 0n;
  try {
    const map: unknown = JSON.parse(raw);
    if (map === null || typeof map !== "object" || Array.isArray(map)) {
      return 0n;
    }
    const block = (map as Record<string, unknown>)[String(chainId)];
    return typeof block === "number" && Number.isSafeInteger(block) && block > 0
      ? BigInt(block)
      : 0n;
  } catch {
    return 0n;
  }
}

/** The price service's base URL, or null when the build names none or it is not a plain http(s) URL. */
export function priceIndexerUrl(
  env: ChainEnv | undefined = viteEnv(),
): string | null {
  const raw = env?.VITE_PRICE_INDEXER_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.origin + url.pathname.replace(/\/+$/, "")
      : null;
  } catch {
    return null;
  }
}

/** The local test chain: its exchange is a throwaway clone, so it needs no pinned code. */
const LOCAL_CHAIN_ID = 31337;

/** The code hashes a build pins for the exchange on `chainId`, or null when it pins none or pins them badly. */
export function exchangeCodehashes(
  chainId: string | number | null,
  env: ChainEnv | undefined = viteEnv(),
): CodeHashes | null {
  const raw = env?.VITE_LBAMM_ADDRESSES?.trim();
  if (!raw || chainId === null) return null;
  try {
    const map: unknown = JSON.parse(raw);
    if (map === null || typeof map !== "object" || Array.isArray(map))
      return null;
    const entry = (map as Record<string, unknown>)[String(chainId)];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry))
      return null;
    const pins = (entry as Record<string, unknown>).codehashes;
    if (pins === null || typeof pins !== "object" || Array.isArray(pins))
      return null;
    const out: Record<string, string> = {};
    for (const key of EXCHANGE_CONTRACTS) {
      const hash = parseCodeHash((pins as Record<string, unknown>)[key]);
      if (hash === null) return null;
      out[key] = hash;
    }
    return out as CodeHashes;
  } catch {
    return null;
  }
}

/**
 * The exchange's contracts on `chainId`, or null when the build names none (never guessed). Strict about every address,
 * and about pins: any chain but the local test chain needs its code hashes, or the entry is refused.
 */
export function exchangeAddresses(
  chainId: string | number | null,
  env: ChainEnv | undefined = viteEnv(),
): ExchangeAddresses | null {
  const raw = env?.VITE_LBAMM_ADDRESSES?.trim();
  if (!raw || chainId === null) return null;
  try {
    const map: unknown = JSON.parse(raw);
    if (map === null || typeof map !== "object" || Array.isArray(map))
      return null;
    const entry = (map as Record<string, unknown>)[String(chainId)];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry))
      return null;
    const fields = entry as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const key of ["amm", "hook", "registry", "poolType"]) {
      const value = fields[key];
      if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value))
        return null;
      out[key] = value.toLowerCase();
    }
    if (
      Number(chainId) !== LOCAL_CHAIN_ID &&
      exchangeCodehashes(chainId, env) === null
    )
      return null;
    return out as unknown as ExchangeAddresses;
  } catch {
    return null;
  }
}

/** What a launch record's sale raises in, on its own chain. */
export function recordSaleCurrency(record: {
  currency: string | null;
  chainId: string | null;
}): SaleCurrency {
  return saleCurrencyFor(record.currency, record.chainId, localUsdcAddress());
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
 * The documented seconds-per-block for a chain, for the time → block fallback.
 *
 * `CHAIN_PRESETS` is the picker's single source of truth for chain facts, so
 * the fallback and the picker can never disagree; a chain without a preset (or
 * a preset that omits the interval, like on-demand local Anvil) gets the app's
 * default — one block every 2 seconds, the same number `BLOCKS_PER_DAY` is
 * computed from.
 */
export function documentedBlockTimeSeconds(chainId?: string | null): number {
  const preset = chainId ? chainPresetByChainId(chainId) : null;
  return preset?.blockTimeSeconds ?? DEFAULT_SECONDS_PER_BLOCK;
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
 * Whether this build may offer mainnet chains. Off unless `VITE_ENABLE_MAINNET`
 * is "1"/"true": the launchpad contracts are unaudited and no legal posture
 * exists yet (docs/dao-os.md rule R4), so a default build shows test networks
 * only.
 */
export function mainnetEnabled(env: ChainEnv | undefined = viteEnv()): boolean {
  const flag = env?.VITE_ENABLE_MAINNET?.trim().toLowerCase();
  return flag === "1" || flag === "true";
}

/** Whether a chain id names a mainnet preset (real money). */
export function isMainnetChain(
  chainId: number | string | null | undefined,
): boolean {
  if (chainId === null || chainId === undefined) return false;
  return chainPresetByChainId(chainId)?.mainnet === true;
}

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

/** Hosts that mean "this machine": a page served from one is local development. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function pageHostname(): string | null {
  try {
    return window.location.hostname;
  } catch {
    return null; // not in a browser (unit tests)
  }
}

/**
 * The endpoint chain reads go to.
 *
 * Saved choice first (one action = one durable persist), then the build-time
 * `VITE_CHAIN_RPC_URL`, then the local development default (a local Anvil,
 * which `just dev-chain` boots).
 *
 * That last default only makes sense on a page served from the same machine.
 * On a deployed site it would send every visitor's chain reads to the
 * visitor's own computer, so there it is no endpoint at all (an empty string,
 * which `rpc` refuses) until the build sets `VITE_CHAIN_RPC_URL`.
 */
export function getRpcEndpoint(
  env: ChainEnv | undefined = viteEnv(),
  pageHost: string | null = pageHostname(),
): string {
  try {
    const saved = window.localStorage.getItem(ENDPOINT_KEY);
    if (saved) return saved;
  } catch {
    // Storage unavailable — the configured default below still applies.
  }
  const fromEnv = env?.VITE_CHAIN_RPC_URL?.trim();
  if (fromEnv) return fromEnv;
  const local = pageHost === null || LOCAL_HOSTS.has(pageHost.toLowerCase());
  return local ? DEFAULT_RPC_ENDPOINT : "";
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

/**
 * How a read that fails for a passing reason is tried again: after each pause here, then it gives up. A public node
 * regularly drops a request or answers slowly; one dropped read must not turn a whole screen into an error. Reads only
 * (nothing here sends a transaction), so asking twice is harmless. Tests set it empty to fail fast.
 */
export const RPC_RETRY = { delaysMs: [300, 900] as number[] };

/** A failure worth asking again about: a timeout, a dropped connection, or a node that is busy. */
function isPassingFailure(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (error instanceof TypeError) return true;
  return error instanceof Error && /^rpc http (429|5\d\d)$/.test(error.message);
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
    if (!res.ok) throw new Error(`rpc http ${res.status}`);
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
      const pause = RPC_RETRY.delaysMs[attempt];
      if (pause === undefined) {
        // Say it in words: the raw abort text ("signal is aborted without reason") reaches people's screens.
        if (error instanceof DOMException && error.name === "AbortError") {
          throw new Error(
            "The chain node did not answer in time. Try again in a moment.",
          );
        }
        if (error instanceof TypeError) {
          throw new Error(
            "Could not reach the chain node. Check your connection and try again.",
          );
        }
        throw error;
      }
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
 * `eth_getLogs` (address + topic filtered). Asked once for the whole range; when the node says that is too wide (a real
 * node usually caps the block range of one request) it is read again in pages, from the block the build names as the
 * start of this chain's history (`VITE_HISTORY_FROM_BLOCKS`) instead of block 0. See `lib/log-pages.ts`.
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
  try {
    return await read(filter);
  } catch (error) {
    if (!isRangeLimitError(error)) throw error;
    const [chainId, head] = await Promise.all([
      ethChainId(endpoint),
      ethBlockNumber(endpoint),
    ]);
    const floor = historyFromBlock(chainId.toString(), env);
    const asked =
      filter.fromBlock === "latest" ? head : decodeQuantity(filter.fromBlock);
    const until =
      filter.toBlock === "latest" ? head : decodeQuantity(filter.toBlock);
    return readInPages({
      from: asked > floor ? asked : floor,
      to: until < head ? until : head,
      pageSize: rangeLimitFrom(error) ?? undefined,
      fetchPage: (from, to) =>
        read({
          ...filter,
          fromBlock: `0x${from.toString(16)}`,
          toBlock: `0x${to.toString(16)}`,
        }),
    });
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

/** The runtime code at `address` as `0x…` hex (`0x` when there is none). Throws on RPC failure. */
export async function ethGetCode(
  endpoint: string,
  address: string,
): Promise<string> {
  const code = await rpc(endpoint, "eth_getCode", [address, "latest"]);
  if (typeof code !== "string") throw new Error("bad eth_getCode return");
  return code;
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
