/**
 * The launchpad's chain settings: which networks the app knows, what the build says (`VITE_*`: the default chain, the
 * RPC endpoint, the kit and dev USDC addresses, where history starts, the mainnet switch), and which endpoint chain
 * reads go to. Reading the chain itself is in
 * `chain.ts`, which re-exports all of this, so callers import from either.
 */

import {
  saleCurrencyFor,
  type SaleCurrency,
} from "@creaton/core/launchpad/sale-currency.ts";
import { DEFAULT_SECONDS_PER_BLOCK } from "./lib/time-blocks.ts";

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
  /** "1" in the hosted image: a contributor-only build, which offers no way to start a sale (`lib/raises-offered.ts`). */
  VITE_CONTRIBUTOR_ONLY?: string;
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
   * The contributor kit per chain, as JSON: `{"31337":"0x…"}`. It makes a contributor project in one transaction: a DAO
   * with no sale, its first work budget and project, its Shares locked against transfers. A chain with no entry cannot
   * start one from the app.
   */
  VITE_CONTRIBUTOR_KITS?: string;
  /**
   * The bounty contract on work areas per chain, as JSON: `{"31337":"0x…"}` (N1). It holds money people put behind a
   * work area and pays it to the approved work, or back to them. A chain with no entry shows no bounties.
   */
  VITE_WORK_BOUNTIES?: string;
  /**
   * The bounty contract on posts per chain, as JSON: `{"31337":"0x…"}` (N2). It holds money people put behind a post and
   * pays it to the claim that keeps a majority of it, or back to them. A chain with no entry shows no bounties on posts.
   */
  VITE_OPEN_BOUNTIES?: string;
  /** Weekly rounds between holders and new buyers per chain (D131), as JSON `{ "<chainId>": "0x…" }`. */
  VITE_WEEKLY_ROUNDS?: string;
  /** The SecondaryMarketFactory this build knows on a chain: `marketOf(dao)` names a DAO's market. */
  VITE_SECONDARY_MARKET_FACTORY?: string;
  /**
   * Which score-root publishers each community has accepted, as JSON keyed by
   * relay host: `{"localhost:3000":{"publishers":["<hex>"],"programs":["…"]}}`.
   * A community with no entry accepts none; its score roots are shown labelled
   * as the publisher's own claim (`lib/score-root-policy.ts`).
   */
  VITE_SCORE_ROOT_PUBLISHERS?: string;
  /**
   * $CREATE per chain, as JSON: `{"31337":"0x…"}` (N6). The platform's work token: staked to judge cases and posted as a
   * bond. A chain with no entry offers neither.
   */
  VITE_CREATE_TOKENS?: string;
  /** The test $CREATE faucet per chain, as JSON (N6). Test networks only; a chain with no entry hands out none. */
  VITE_CREATE_FAUCETS?: string;
  /** The $CREATE court per chain, as JSON (N7). Where claimants appeal and jurors judge; a chain with no entry has none. */
  VITE_COURTS?: string;
  /** The payout module factory per chain, as JSON (N10): test networks only; DAOs vote to start payouts with it. */
  VITE_PAYOUTS_FACTORIES?: string;
  /** The remix bond contract per chain, as JSON (N12): test networks only; needs the court and CREATE. */
  VITE_REMIX_BONDS?: string;
  /**
   * The block each chain's history starts at, as JSON: `{"11155111":7654321}`. Name the block the launch kit was deployed
   * at: every contract the app reads events from was made after it. Only used when a node refuses a read of the whole
   * history for being too wide; a chain with no entry is then read from block 0, which a long chain cannot finish.
   */
  VITE_HISTORY_FROM_BLOCKS?: string;
}

/** This build's settings (absent outside Vite, as in unit tests). */
export function viteEnv(): ChainEnv | undefined {
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
 * The contributor kit on `chainId`, or null when the build does not name one. Never guessed, for the same reason as the
 * launch kit; the same strict JSON map of chain id to address.
 */
export function contributorKit(
  chainId: string | number | null,
  env: ChainEnv | undefined = viteEnv(),
): string | null {
  return addressForChain(env?.VITE_CONTRIBUTOR_KITS, chainId);
}

/**
 * The bounty contract on work areas on `chainId`, or null when the build does not name one. Never guessed: people send
 * money to it.
 */
export function workBounty(
  chainId: string | number | null,
  env: ChainEnv | undefined = viteEnv(),
): string | null {
  return addressForChain(env?.VITE_WORK_BOUNTIES, chainId);
}

/** The bounty contract on posts on `chainId`, or null when the build does not name one. Never guessed. */
export function openBounty(
  chainId: string | number | null,
  env: ChainEnv | undefined = viteEnv(),
): string | null {
  return addressForChain(env?.VITE_OPEN_BOUNTIES, chainId);
}

/** $CREATE on `chainId`, or null when the build does not name it. Never guessed: people stake and post bonds in it. */
export function createToken(
  chainId: string | number | null,
  env: ChainEnv | undefined = viteEnv(),
): string | null {
  return addressForChain(env?.VITE_CREATE_TOKENS, chainId);
}

/** The remix bond contract on `chainId`, or null when the build does not name one (N12, test networks only). */
export function remixBonds(
  chainId: string | number | null,
  env: ChainEnv | undefined = viteEnv(),
): string | null {
  return addressForChain(env?.VITE_REMIX_BONDS, chainId);
}

/** The payout module factory on `chainId`, or null when the build does not name one (N10, test networks only). */
export function payoutsFactory(
  chainId: string | number | null,
  env: ChainEnv | undefined = viteEnv(),
): string | null {
  return addressForChain(env?.VITE_PAYOUTS_FACTORIES, chainId);
}

/** The $CREATE court on `chainId`, or null when the build does not name one. */
export function courtAddress(
  chainId: string | number | null,
  env: ChainEnv | undefined = viteEnv(),
): string | null {
  return addressForChain(env?.VITE_COURTS, chainId);
}

/** The test $CREATE faucet on `chainId`, or null; never on a main network (the build check refuses one there). */
export function createFaucet(
  chainId: string | number | null,
  env: ChainEnv | undefined = viteEnv(),
): string | null {
  return addressForChain(env?.VITE_CREATE_FAUCETS, chainId);
}

/** The weekly rounds contract on `chainId`, or null when the build does not name one. DAOs vote it in. */
export function weeklyRounds(
  chainId: string | number | null,
  env: ChainEnv | undefined = viteEnv(),
): string | null {
  return addressForChain(env?.VITE_WEEKLY_ROUNDS, chainId);
}

/**
 * The secondary-market factory this build knows on `chainId`, or null when it names none.
 *
 * One factory serves every DAO a kit made: `marketOf(dao)` answers that DAO's market, or the zero
 * address when it has none. Trading is off by default — a market exists from launch, but it sells
 * nothing until the DAO publishes a listing and the founder's schedule has released units.
 */
export function secondaryMarketFactory(
  chainId: string | number | null,
  env: ChainEnv | undefined = viteEnv(),
): string | null {
  return addressForChain(env?.VITE_SECONDARY_MARKET_FACTORY, chainId);
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
