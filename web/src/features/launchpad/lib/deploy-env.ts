/**
 * Whether a hosted build's settings fit together (`docs/sepolia-testnet.md`), read with the parsers the app itself uses,
 * so what this approves is what the page will do. `web/scripts/check-deploy-env.mjs` runs it before the image builds the
 * app (`Dockerfile`), and refuses a build that would offer mainnet before the audit, point a hosted page at a local
 * chain, or start contributor projects the page could not read the history of. It also says, in a few lines, what the
 * build will offer, since every one of these settings ends up public in the page.
 */

import {
  type ChainEnv,
  contributorKit,
  daoLaunchKit,
  defaultChainPreset,
  historyFromBlock,
  LOCAL_ANVIL_PRESET,
  mainnetEnabled,
  networkLabel,
  workBounty,
} from "../chain-config.ts";

/** The build-time settings a hosted build may read (`VITE_*`), as the environment gives them. */
export type DeployEnv = ChainEnv & Record<string, string | undefined>;

export interface DeployEnvReport {
  /** What would make the hosted page wrong or unsafe; the build stops when there is any. */
  problems: string[];
  /** What the build will offer, one line each. */
  summary: string[];
}

function value(env: DeployEnv, name: string): string | null {
  const raw = env[name]?.trim();
  return raw ? raw : null;
}

/** An https URL that is not this machine, or null with the reason. */
function hostedUrl(raw: string): { host: string } | { problem: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { problem: "is not a URL" };
  }
  if (url.protocol !== "https:") return { problem: "must be an https address" };
  if (/^(localhost|127\.|\[::1\]|0\.0\.0\.0)/.test(url.hostname)) {
    return {
      problem: "points at this machine, which a visitor's browser cannot reach",
    };
  }
  return { host: url.host };
}

export function checkDeployEnv(env: DeployEnv): DeployEnvReport {
  const problems: string[] = [];
  const summary: string[] = [];

  if (mainnetEnabled(env)) {
    problems.push(
      "VITE_ENABLE_MAINNET is set: a hosted build offers test networks only until the contracts are audited.",
    );
  }
  for (const name of [
    "VITE_LOCAL_USDC",
    "VITE_LBAMM_ADDRESSES",
    "VITE_PRICE_INDEXER_URL",
  ]) {
    if (value(env, name)) {
      problems.push(
        `${name} is set: it is for a local chain or the exchange, which a hosted test network does not have.`,
      );
    }
  }

  const preset = defaultChainPreset(env, false);
  const chainId = preset.chainId;
  const asked = value(env, "VITE_LAUNCHPAD_CHAIN_ID");
  if (asked && Number(asked) !== chainId) {
    problems.push(
      `VITE_LAUNCHPAD_CHAIN_ID=${asked} is not a network this app offers.`,
    );
  }
  if (chainId === LOCAL_ANVIL_PRESET.chainId) {
    problems.push(
      `The build's network is a local chain (${chainId}), which a hosted page cannot reach.`,
    );
  }
  summary.push(`Network: ${networkLabel(chainId)} (${chainId})`);

  const rpc = value(env, "VITE_CHAIN_RPC_URL");
  let rpcHost: string | null = null;
  if (rpc) {
    const checked = hostedUrl(rpc);
    if ("problem" in checked)
      problems.push(`VITE_CHAIN_RPC_URL ${checked.problem}.`);
    else rpcHost = checked.host;
  }
  summary.push(
    `Chain node: ${rpcHost ?? "none (the page reads nothing from a chain)"}`,
  );

  const contributor = contributorKit(chainId, env);
  const raise = daoLaunchKit(chainId, env);
  if (value(env, "VITE_CONTRIBUTOR_KITS") && !contributor) {
    problems.push(
      `VITE_CONTRIBUTOR_KITS names no valid address for ${networkLabel(chainId)} (${chainId}).`,
    );
  }
  const bounty = workBounty(chainId, env);
  if (value(env, "VITE_WORK_BOUNTIES") && !bounty) {
    problems.push(
      `VITE_WORK_BOUNTIES names no valid address for ${networkLabel(chainId)} (${chainId}).`,
    );
  }
  if (value(env, "VITE_DAO_LAUNCH_KITS") && !raise) {
    problems.push(
      `VITE_DAO_LAUNCH_KITS names no valid address for ${networkLabel(chainId)} (${chainId}).`,
    );
  }
  const from = historyFromBlock(chainId, env);
  if (contributor || raise) {
    if (!rpc) {
      problems.push(
        "A kit is named but VITE_CHAIN_RPC_URL is not: a hosted page has no chain node without it.",
      );
    }
    if (from === 0n) {
      problems.push(
        `A kit is named but VITE_HISTORY_FROM_BLOCKS has no block for ${chainId}: a real node refuses history read from block 0.`,
      );
    }
  }
  summary.push(
    `Contributor projects: ${contributor ? `on (kit ${contributor}, history from block ${from})` : "off"}`,
  );
  summary.push(`Test raises: ${raise ? `on (kit ${raise})` : "off"}`);
  summary.push(`Bounties on work areas: ${bounty ? `on (${bounty})` : "off"}`);

  const project = value(env, "VITE_ZERODEV_PROJECT_ID");
  const zerodevChain = value(env, "VITE_ZERODEV_CHAIN_ID");
  if (project && !zerodevChain) {
    problems.push(
      "VITE_ZERODEV_PROJECT_ID is set without VITE_ZERODEV_CHAIN_ID.",
    );
  }
  if (zerodevChain && !project) {
    problems.push(
      "VITE_ZERODEV_CHAIN_ID is set without VITE_ZERODEV_PROJECT_ID.",
    );
  }
  if (zerodevChain && Number(zerodevChain) !== chainId) {
    problems.push(
      `VITE_ZERODEV_CHAIN_ID is ${zerodevChain}, but the app's network is ${chainId}.`,
    );
  }
  summary.push(
    `Passkey accounts with paid gas: ${project && zerodevChain ? "on" : "off (people bring a wallet and test gas)"}`,
  );

  const reports = value(env, "VITE_ERROR_REPORT_URL");
  let reportHost: string | null = null;
  if (reports) {
    const checked = hostedUrl(reports);
    if ("problem" in checked)
      problems.push(`VITE_ERROR_REPORT_URL ${checked.problem}.`);
    else reportHost = checked.host;
  }
  summary.push(`Error reports: ${reportHost ? `on (${reportHost})` : "off"}`);
  summary.push(`Release: ${value(env, "VITE_APP_RELEASE") ?? "unnamed"}`);

  return { problems, summary };
}
