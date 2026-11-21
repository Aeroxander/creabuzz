/**
 * The test network the app talks to: its chain, its Launcher and its dollar. Read from one place, never typed into a
 * component: either the environment the build was made with (`VITE_CREATON_*`) or a deployments file the deploy script
 * wrote (`contracts/pot/deployments/pot-<chain>.json`, pointed at with `CREATON_DEPLOYMENTS_FILE` when the app is built).
 *
 * Pure: it takes a plain record and returns checked values, or null for what is missing or wrong. A project's own
 * contracts (Treasury, Shares, Vester) are never here: they come from the project's numbers.
 */

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** The chains the play dollar can live on (`PlayDollar`'s constructor refuses any other), by chain id. */
const TEST_NETWORKS: Readonly<Record<number, string>> = {
  31337: "Local test network",
  11155111: "Sepolia test network",
};

/** What the app knows about the network it is built for. */
export interface PotNetwork {
  chainId: number;
  /** A plain name for the network, for a sentence ("the Sepolia test network"). */
  name: string;
  launcher: string;
  /** The dollar's address when the build names it, else null (the project's numbers carry it). */
  dollar: string | null;
  /** The node's address for reads, when the build names one. */
  rpcUrl: string | null;
  /** True on a test network, where the dollar is play money. The only value step 1 has. */
  playMoney: boolean;
}

const address = (value: unknown): string | null =>
  typeof value === "string" && ADDRESS.test(value) ? value.toLowerCase() : null;

const chainIdOf = (value: unknown): number | null => {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

/**
 * The network from a build's environment (`VITE_CREATON_CHAIN_ID`, `VITE_CREATON_LAUNCHER`, and optionally
 * `VITE_CREATON_DOLLAR` and `VITE_CREATON_RPC_URL`). Null when the chain or the Launcher is missing or malformed: a
 * build that does not name them offers no money step.
 */
export function parsePotNetwork(
  env: Readonly<Record<string, unknown>>,
): PotNetwork | null {
  const chainId = chainIdOf(env.VITE_CREATON_CHAIN_ID);
  const launcher = address(env.VITE_CREATON_LAUNCHER);
  if (chainId === null || launcher === null) return null;
  const rpc = env.VITE_CREATON_RPC_URL;
  return {
    chainId,
    name: TEST_NETWORKS[chainId] ?? "Test network",
    launcher,
    dollar: address(env.VITE_CREATON_DOLLAR),
    rpcUrl:
      typeof rpc === "string" && /^https?:\/\//.test(rpc.trim())
        ? rpc.trim()
        : null,
    // Step 1 is play money everywhere; a real-money build is a later, separate switch.
    playMoney: true,
  };
}

/**
 * What a wallet needs to add this network when it does not know it (`wallet_addEthereumChain`, EIP-3085): the chain's id, its
 * plain name, the node address the build names and the currency the network's fees are paid in. Every network the play
 * dollar can live on pays its fees in test ether. Null when the build names no node address: a wallet cannot be told where
 * the network is, so the person adds it by hand.
 */
export function addNetworkRequest(network: PotNetwork): {
  chainId: string;
  chainName: string;
  rpcUrls: string[];
  nativeCurrency: { name: string; symbol: string; decimals: number };
} | null {
  if (network.rpcUrl === null) return null;
  return {
    chainId: `0x${network.chainId.toString(16)}`,
    chainName: network.name,
    rpcUrls: [network.rpcUrl],
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  };
}

/** What the deploy script writes (`contracts/pot/script/DeployPot.s.sol`), checked. */
export interface Deployments {
  chainId: number;
  launcher: string;
  /** The dollar token. */
  quote: string;
  platform: string | null;
  unit: number | null;
  feeBps: number | null;
}

/** A deployments file's content, or null when it is not one (missing fields, bad addresses, a chain that is not an id). */
export function parseDeployments(json: unknown): Deployments | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const record = json as Record<string, unknown>;
  const chainId = chainIdOf(record.chainId);
  const launcher = address(record.launcher);
  const quote = address(record.quote);
  if (chainId === null || launcher === null || quote === null) return null;
  const whole = (v: unknown): number | null =>
    typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
  return {
    chainId,
    launcher,
    quote,
    platform: address(record.platform),
    unit: whole(record.unit),
    feeBps: whole(record.feeBps),
  };
}

/**
 * The build environment a deployments file gives, to be used where the build's own environment names nothing: the
 * variables `parsePotNetwork` reads. A file that is not a deployments file gives nothing.
 */
export function envFromDeployments(json: unknown): Record<string, string> {
  const deployments = parseDeployments(json);
  if (!deployments) return {};
  return {
    VITE_CREATON_CHAIN_ID: String(deployments.chainId),
    VITE_CREATON_LAUNCHER: deployments.launcher,
    VITE_CREATON_DOLLAR: deployments.quote,
  };
}

/**
 * Whether a money screen must say the money is play money. True unless the record says it is not (`false`) AND the app's
 * real-money switch is on (not part of step 1, so `realMoneyOn` is false everywhere today): a record that does not know
 * the answer, or a parser that cannot read it, means play money.
 */
export function mustSayPlayMoney(
  recordPlayMoney: boolean | null | undefined,
  realMoneyOn = false,
): boolean {
  return !(recordPlayMoney === false && realMoneyOn);
}
