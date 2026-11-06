/**
 * Whether a hosted build's settings fit together (`docs/sepolia-testnet.md`), read with the parsers the app itself uses,
 * so what this approves is what the page will do. `web/scripts/check-deploy-env.mjs` runs it before the image builds the
 * app (`Dockerfile`), and refuses a build that would offer mainnet before the audit, point a hosted page at a local
 * chain, start contributor projects the page could not read the history of or send steps for (no paid gas in the
 * contributor-only image), or carry a CHANGE_ME placeholder into the page. It also says, in a few lines, what the
 * build will offer, since every one of these settings ends up public in the page.
 */

import {
  type ChainEnv,
  contributorKit,
  courtAddress,
  createFaucet,
  createToken,
  daoLaunchKit,
  defaultChainPreset,
  payoutsFactory,
  remixBonds,
  historyFromBlock,
  LOCAL_ANVIL_PRESET,
  mainnetEnabled,
  networkLabel,
  openBounty,
  workBounty,
} from "../chain-config.ts";

/** The build-time settings a hosted build may read (`VITE_*`), as the environment gives them. */
export type DeployEnv = ChainEnv & Record<string, string | undefined>;

export interface DeployEnvReport {
  /** What would make the hosted page wrong or unsafe; the build stops when there is any. */
  problems: string[];
  /** What the operator should know before inviting anyone; the build goes on. */
  warnings: string[];
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

/** A ZeroDev project id: a UUID. Anything else (a placeholder, a URL, an API key) makes every passkey step fail. */
const ZERODEV_PROJECT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function checkDeployEnv(env: DeployEnv): DeployEnvReport {
  const problems: string[] = [];
  const warnings: string[] = [];
  const summary: string[] = [];

  // The deploy script prints CHANGE_ME_... where a value is the operator's to fill in. One left in would be built into the
  // page as it is (the build reads these, the server never sees them), so it stops here.
  for (const [name, raw] of Object.entries(env)) {
    if (name.startsWith("VITE_") && raw?.includes("CHANGE_ME")) {
      problems.push(
        `${name} still holds a CHANGE_ME placeholder: put the real value in .env, then build again.`,
      );
    }
  }

  if (mainnetEnabled(env)) {
    problems.push(
      "VITE_ENABLE_MAINNET is set: a hosted build offers test networks only until the contracts are audited.",
    );
  }
  if (value(env, "VITE_LOCAL_USDC")) {
    problems.push(
      "VITE_LOCAL_USDC is set: it is for a local chain, which a hosted test network does not have.",
    );
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
  const postBounty = openBounty(chainId, env);
  if (value(env, "VITE_OPEN_BOUNTIES") && !postBounty) {
    problems.push(
      `VITE_OPEN_BOUNTIES names no valid address for ${networkLabel(chainId)} (${chainId}).`,
    );
  }
  if (postBounty && !rpc) {
    problems.push(
      "VITE_OPEN_BOUNTIES is named but VITE_CHAIN_RPC_URL is not: a hosted page has no chain node without it.",
    );
  }
  const create = createToken(chainId, env);
  const faucet = createFaucet(chainId, env);
  if (value(env, "VITE_CREATE_TOKENS") && !create) {
    problems.push(
      `VITE_CREATE_TOKENS names no valid address for ${networkLabel(chainId)} (${chainId}).`,
    );
  }
  if (value(env, "VITE_CREATE_FAUCETS") && !faucet) {
    problems.push(
      `VITE_CREATE_FAUCETS names no valid address for ${networkLabel(chainId)} (${chainId}).`,
    );
  }
  if (faucet && !create) {
    problems.push(
      "VITE_CREATE_FAUCETS is named but VITE_CREATE_TOKENS is not: the faucet's token would not be shown.",
    );
  }
  const court = courtAddress(chainId, env);
  if (value(env, "VITE_COURTS") && !court) {
    problems.push(
      `VITE_COURTS names no valid address for ${networkLabel(chainId)} (${chainId}).`,
    );
  }
  if (court && !create) {
    problems.push(
      "VITE_COURTS is named but VITE_CREATE_TOKENS is not: jurors could not see what they stake.",
    );
  }
  const payouts = payoutsFactory(chainId, env);
  if (value(env, "VITE_PAYOUTS_FACTORIES") && !payouts) {
    problems.push(
      `VITE_PAYOUTS_FACTORIES names no valid address for ${networkLabel(chainId)} (${chainId}).`,
    );
  }
  const bonds = remixBonds(chainId, env);
  if (value(env, "VITE_REMIX_BONDS") && !bonds) {
    problems.push(
      `VITE_REMIX_BONDS names no valid address for ${networkLabel(chainId)} (${chainId}).`,
    );
  }
  if (bonds && !court) {
    problems.push(
      "VITE_REMIX_BONDS is named but VITE_COURTS is not: a bond's case would have nowhere to go.",
    );
  }
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
  summary.push(
    `Bounties on posts: ${postBounty ? `on (${postBounty})` : "off"}`,
  );
  summary.push(
    `CREATE: ${create ? `on (${create}${faucet ? `, faucet ${faucet}` : ", no faucet"})` : "off"}`,
  );
  summary.push(`Court: ${court ? `on (${court})` : "off"}`);
  summary.push(
    `Payouts to holders: ${payouts ? `on where a DAO votes for them (${payouts})` : "off"}`,
  );
  summary.push(`Remix bonds: ${bonds ? `on (${bonds})` : "off"}`);

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
  if (project && !ZERODEV_PROJECT_ID.test(project)) {
    problems.push(
      "VITE_ZERODEV_PROJECT_ID is not a ZeroDev project id (a UUID, from the project's page in the ZeroDev dashboard).",
    );
  }
  // The contributor-only image (the Dockerfile sets VITE_CONTRIBUTOR_ONLY=1) is run with passkey accounts alone: nobody
  // is asked to bring a wallet or test gas, so without paid gas no contributor step could be sent at all.
  // Only one of the two set is said above already; this is for neither.
  if (
    env.VITE_CONTRIBUTOR_ONLY?.trim() === "1" &&
    contributor &&
    !project &&
    !zerodevChain
  ) {
    problems.push(
      "Contributor projects are on, but VITE_ZERODEV_PROJECT_ID and VITE_ZERODEV_CHAIN_ID are not set: in the contributor-only image every step is sent from a passkey account whose fees ZeroDev pays.",
    );
  }
  // Without paid gas, a build of your own leaves people to send steps from a browser wallet with test gas. The
  // contributor-only image offers no other way to send them: with contributor projects on it is refused above, and
  // without them it sends nothing on chain.
  const contributorOnly = env.VITE_CONTRIBUTOR_ONLY?.trim() === "1";
  const paidGasOff = contributorOnly
    ? contributor
      ? "off"
      : "off (not needed: contributor projects are off)"
    : "off (people bring a wallet and test gas)";
  summary.push(
    `Passkey accounts with paid gas: ${project && zerodevChain ? "on" : paidGasOff}`,
  );

  const reports = value(env, "VITE_ERROR_REPORT_URL");
  let reportHost: string | null = null;
  if (reports) {
    const checked = hostedUrl(reports);
    if ("problem" in checked)
      problems.push(`VITE_ERROR_REPORT_URL ${checked.problem}.`);
    else reportHost = checked.host;
  }
  if (contributor && !reports) {
    warnings.push(
      "Contributor projects are on, but VITE_ERROR_REPORT_URL is not set: the page will send no error reports, so a step that fails for people (a refused fee, a busy chain node) reaches you only if they tell you. The pilot runbook relies on them (docs/error-reporting.md).",
    );
  }
  summary.push(`Error reports: ${reportHost ? `on (${reportHost})` : "off"}`);
  summary.push(`Release: ${value(env, "VITE_APP_RELEASE") ?? "unnamed"}`);

  return { problems, warnings, summary };
}
