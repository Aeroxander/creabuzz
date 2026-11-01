import assert from "node:assert/strict";
import test from "node:test";

import { checkDeployEnv } from "./deploy-env.ts";

const KIT = `0x${"ab".repeat(20)}`;
const ZERODEV_PROJECT = "b5486fa4-e3d9-450b-8428-646e757c10f6";
const SEPOLIA = {
  VITE_LAUNCHPAD_CHAIN_ID: "11155111",
  VITE_CHAIN_RPC_URL: "https://sepolia.example/v2/read-only",
  VITE_CONTRIBUTOR_KITS: JSON.stringify({ 11155111: KIT }),
  VITE_HISTORY_FROM_BLOCKS: JSON.stringify({ 11155111: 7654321 }),
};

test("no settings: the social app on Sepolia, with nothing on chain", () => {
  const { problems, summary } = checkDeployEnv({});
  assert.deepEqual(problems, []);
  assert.ok(
    summary.includes("Network: Sepolia (11155111)"),
    summary.join("\n"),
  );
  assert.ok(summary.includes("Contributor projects: off"));
  assert.ok(summary.some((line) => line.startsWith("Chain node: none")));
});

test("a contributor-only Sepolia build passes and says what it offers", () => {
  const { problems, summary } = checkDeployEnv(SEPOLIA);
  assert.deepEqual(problems, []);
  assert.ok(
    summary.includes(
      `Contributor projects: on (kit ${KIT}, history from block 7654321)`,
    ),
    summary.join("\n"),
  );
  assert.ok(summary.includes("Test raises: off"));
  assert.ok(summary.includes("Chain node: sepolia.example"));
});

test("bounties on work areas are off by default, on with an address, refused with a bad one", () => {
  assert.ok(
    checkDeployEnv(SEPOLIA).summary.includes("Bounties on work areas: off"),
  );
  const BOUNTY = `0x${"cd".repeat(20)}`;
  const on = checkDeployEnv({
    ...SEPOLIA,
    VITE_WORK_BOUNTIES: JSON.stringify({ 11155111: BOUNTY }),
  });
  assert.deepEqual(on.problems, []);
  assert.ok(on.summary.includes(`Bounties on work areas: on (${BOUNTY})`));
  const elsewhere = checkDeployEnv({
    ...SEPOLIA,
    VITE_WORK_BOUNTIES: JSON.stringify({ 31337: BOUNTY }),
  });
  assert.ok(
    elsewhere.problems.some((p) =>
      p.startsWith("VITE_WORK_BOUNTIES names no valid address"),
    ),
  );
});

test("bounties on posts are off by default, on with an address and a node, refused otherwise", () => {
  assert.ok(checkDeployEnv(SEPOLIA).summary.includes("Bounties on posts: off"));
  const POSTS = `0x${"ef".repeat(20)}`;
  const on = checkDeployEnv({
    ...SEPOLIA,
    VITE_OPEN_BOUNTIES: JSON.stringify({ 11155111: POSTS }),
  });
  assert.deepEqual(on.problems, []);
  assert.ok(on.summary.includes(`Bounties on posts: on (${POSTS})`));
  const noNode = checkDeployEnv({
    VITE_OPEN_BOUNTIES: JSON.stringify({ 11155111: POSTS }),
  });
  assert.ok(
    noNode.problems.some((p) =>
      p.startsWith("VITE_OPEN_BOUNTIES is named but"),
    ),
  );
  const elsewhere = checkDeployEnv({
    ...SEPOLIA,
    VITE_OPEN_BOUNTIES: JSON.stringify({ 31337: POSTS }),
  });
  assert.ok(
    elsewhere.problems.some((p) =>
      p.startsWith("VITE_OPEN_BOUNTIES names no valid address"),
    ),
  );
});

test("CREATE is off by default, on with its token and faucet, refused when the faucet has no token", () => {
  assert.ok(checkDeployEnv(SEPOLIA).summary.includes("CREATE: off"));
  const TOKEN = `0x${"c7".repeat(20)}`;
  const FAUCET = `0x${"fa".repeat(20)}`;
  const on = checkDeployEnv({
    ...SEPOLIA,
    VITE_CREATE_TOKENS: JSON.stringify({ 11155111: TOKEN }),
    VITE_CREATE_FAUCETS: JSON.stringify({ 11155111: FAUCET }),
  });
  assert.deepEqual(on.problems, []);
  assert.ok(on.summary.includes(`CREATE: on (${TOKEN}, faucet ${FAUCET})`));
  const faucetOnly = checkDeployEnv({
    ...SEPOLIA,
    VITE_CREATE_FAUCETS: JSON.stringify({ 11155111: FAUCET }),
  });
  assert.ok(
    faucetOnly.problems.some((p) =>
      p.startsWith("VITE_CREATE_FAUCETS is named but VITE_CREATE_TOKENS"),
    ),
  );
});

test("the court is off by default, on with its address, refused without CREATE", () => {
  assert.ok(checkDeployEnv(SEPOLIA).summary.includes("Court: off"));
  const COURT = `0x${"c0".repeat(20)}`;
  const TOKEN = `0x${"c7".repeat(20)}`;
  const on = checkDeployEnv({
    ...SEPOLIA,
    VITE_COURTS: JSON.stringify({ 11155111: COURT }),
    VITE_CREATE_TOKENS: JSON.stringify({ 11155111: TOKEN }),
  });
  assert.deepEqual(on.problems, []);
  assert.ok(on.summary.includes(`Court: on (${COURT})`));
  const alone = checkDeployEnv({
    ...SEPOLIA,
    VITE_COURTS: JSON.stringify({ 11155111: COURT }),
  });
  assert.ok(
    alone.problems.some((p) =>
      p.startsWith("VITE_COURTS is named but VITE_CREATE_TOKENS"),
    ),
  );
});

test("remix bonds need the court", () => {
  const BONDS = `0x${"b0".repeat(20)}`;
  assert.ok(checkDeployEnv(SEPOLIA).summary.includes("Remix bonds: off"));
  const alone = checkDeployEnv({
    ...SEPOLIA,
    VITE_REMIX_BONDS: JSON.stringify({ 11155111: BONDS }),
  });
  assert.ok(
    alone.problems.some((p) =>
      p.startsWith("VITE_REMIX_BONDS is named but VITE_COURTS"),
    ),
  );
});

test("a kit without a chain node or a history start is refused", () => {
  const noNode = checkDeployEnv({ ...SEPOLIA, VITE_CHAIN_RPC_URL: "" });
  assert.ok(
    noNode.problems.some((p) => p.includes("VITE_CHAIN_RPC_URL is not")),
  );
  const noHistory = checkDeployEnv({
    ...SEPOLIA,
    VITE_HISTORY_FROM_BLOCKS: "",
  });
  assert.ok(
    noHistory.problems.some((p) => p.includes("VITE_HISTORY_FROM_BLOCKS")),
  );
  // A kit for another chain is no kit for this one.
  const elsewhere = checkDeployEnv({
    ...SEPOLIA,
    VITE_CONTRIBUTOR_KITS: JSON.stringify({ 31337: KIT }),
  });
  assert.ok(
    elsewhere.problems.some((p) => p.includes("names no valid address")),
  );
});

test("mainnet, a local chain, a local node and local-only settings are refused", () => {
  const cases = [
    [{ VITE_ENABLE_MAINNET: "true" }, "VITE_ENABLE_MAINNET"],
    [{ VITE_LAUNCHPAD_CHAIN_ID: "31337" }, "31337"],
    [{ VITE_LAUNCHPAD_CHAIN_ID: "1" }, "VITE_LAUNCHPAD_CHAIN_ID=1"],
    [{ VITE_CHAIN_RPC_URL: "http://127.0.0.1:8545" }, "VITE_CHAIN_RPC_URL"],
    [{ VITE_CHAIN_RPC_URL: "https://localhost:8545" }, "this machine"],
    [{ VITE_LOCAL_USDC: KIT }, "VITE_LOCAL_USDC"],
    [
      { VITE_ERROR_REPORT_URL: "http://errors.example" },
      "VITE_ERROR_REPORT_URL",
    ],
  ];
  for (const [env, expected] of cases) {
    const { problems } = checkDeployEnv(env);
    assert.ok(
      problems.some((p) => p.includes(expected)),
      `${JSON.stringify(env)}: ${problems.join(" | ")}`,
    );
  }
});

test("sponsored gas needs its project and the app's own network", () => {
  assert.deepEqual(
    checkDeployEnv({
      ...SEPOLIA,
      VITE_ZERODEV_PROJECT_ID: ZERODEV_PROJECT,
      VITE_ZERODEV_CHAIN_ID: "11155111",
    }).problems,
    [],
  );
  assert.ok(
    checkDeployEnv({ VITE_ZERODEV_PROJECT_ID: "p" }).problems.some((p) =>
      p.includes("without VITE_ZERODEV_CHAIN_ID"),
    ),
  );
  assert.ok(
    checkDeployEnv({
      VITE_ZERODEV_PROJECT_ID: "p",
      VITE_ZERODEV_CHAIN_ID: "84532",
    }).problems.some((p) => p.includes("but the app's network is 11155111")),
  );
});

/** What the hosted image builds with: the Dockerfile sets VITE_CONTRIBUTOR_ONLY=1 itself. */
const PILOT = {
  ...SEPOLIA,
  VITE_CONTRIBUTOR_ONLY: "1",
  VITE_ZERODEV_PROJECT_ID: ZERODEV_PROJECT,
  VITE_ZERODEV_CHAIN_ID: "11155111",
};

test("the contributor-only image passes with its paid gas set, and is refused without it", () => {
  assert.deepEqual(checkDeployEnv(PILOT).problems, []);
  assert.ok(
    checkDeployEnv(PILOT).summary.includes(
      "Passkey accounts with paid gas: on",
    ),
  );
  // One of the two missing is said once, by the setting that is missing; neither set says what the image needs.
  for (const missing of ["VITE_ZERODEV_PROJECT_ID", "VITE_ZERODEV_CHAIN_ID"]) {
    const { problems } = checkDeployEnv({ ...PILOT, [missing]: "" });
    const zerodev = problems.filter((p) => p.includes("VITE_ZERODEV_"));
    assert.equal(zerodev.length, 1, `${missing}: ${problems.join(" | ")}`);
    assert.match(zerodev[0], new RegExp(`without ${missing}`));
  }
  const neither = checkDeployEnv({
    ...PILOT,
    VITE_ZERODEV_PROJECT_ID: "",
    VITE_ZERODEV_CHAIN_ID: "",
  }).problems;
  assert.deepEqual(neither, [
    "Contributor projects are on, but VITE_ZERODEV_PROJECT_ID and VITE_ZERODEV_CHAIN_ID are not set: in the contributor-only image every step is sent from a passkey account whose fees ZeroDev pays.",
  ]);
  // A build of your own (not contributor-only) may still leave paid gas off: people bring a wallet.
  assert.deepEqual(
    checkDeployEnv({
      ...PILOT,
      VITE_CONTRIBUTOR_ONLY: "",
      VITE_ZERODEV_PROJECT_ID: "",
      VITE_ZERODEV_CHAIN_ID: "",
    }).problems,
    [],
  );
});

test("a CHANGE_ME placeholder left in any build setting stops the build, naming the setting", () => {
  const left = checkDeployEnv({
    ...PILOT,
    VITE_ZERODEV_PROJECT_ID: "CHANGE_ME_your_ZeroDev_project_id",
    VITE_BUNDLER_URL: "CHANGE_ME_its_bundler_URL",
    VITE_CHAIN_RPC_URL:
      "CHANGE_ME_a_read_only_Sepolia_node_for_the_page_that_allows_wide_log_ranges",
  });
  for (const name of [
    "VITE_ZERODEV_PROJECT_ID",
    "VITE_BUNDLER_URL",
    "VITE_CHAIN_RPC_URL",
  ]) {
    assert.ok(
      left.problems.includes(
        `${name} still holds a CHANGE_ME placeholder: put the real value in .env, then build again.`,
      ),
      `${name}: ${left.problems.join(" | ")}`,
    );
  }
  // Server settings are not the page's: the build does not judge them.
  assert.deepEqual(
    checkDeployEnv({ ...PILOT, BUZZ_EVM_RPC_URL: "CHANGE_ME_x" }).problems,
    [],
  );
});

test("a ZeroDev project id must look like one", () => {
  for (const bad of ["p", "https://rpc.zerodev.app/api/v3/x", "not-a-uuid"]) {
    assert.ok(
      checkDeployEnv({ ...PILOT, VITE_ZERODEV_PROJECT_ID: bad }).problems.some(
        (p) =>
          p.startsWith("VITE_ZERODEV_PROJECT_ID is not a ZeroDev project id"),
      ),
      bad,
    );
  }
});

test("contributor projects without error reports build, with a warning; with them, or without the kit, no warning", () => {
  const without = checkDeployEnv(PILOT);
  assert.deepEqual(without.problems, []);
  assert.equal(without.warnings.length, 1, without.warnings.join(" | "));
  assert.match(without.warnings[0], /VITE_ERROR_REPORT_URL is not set/);
  assert.deepEqual(
    checkDeployEnv({
      ...PILOT,
      VITE_ERROR_REPORT_URL: "https://errors.example/report",
    }).warnings,
    [],
  );
  assert.deepEqual(checkDeployEnv({ VITE_CONTRIBUTOR_ONLY: "1" }).warnings, []);
});

test("the paid-gas line says what the build really asks of people", () => {
  const line = (env) =>
    checkDeployEnv(env).summary.find((l) => l.startsWith("Passkey accounts"));
  // The contributor-only image never asks anyone for a wallet or test gas.
  assert.equal(
    line({ VITE_CONTRIBUTOR_ONLY: "1" }),
    "Passkey accounts with paid gas: off (not needed: contributor projects are off)",
  );
  assert.equal(
    line({
      ...PILOT,
      VITE_ZERODEV_PROJECT_ID: "",
      VITE_ZERODEV_CHAIN_ID: "",
    }),
    "Passkey accounts with paid gas: off",
  );
  // A build of your own may leave it to people's own wallets.
  assert.equal(
    line(SEPOLIA),
    "Passkey accounts with paid gas: off (people bring a wallet and test gas)",
  );
});
