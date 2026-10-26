import assert from "node:assert/strict";
import test from "node:test";

import { checkDeployEnv } from "./deploy-env.ts";

const KIT = `0x${"ab".repeat(20)}`;
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

test("sales between members are off by default, on with an address and a node, refused otherwise", () => {
  assert.ok(
    checkDeployEnv(SEPOLIA).summary.includes("Sales between members: off"),
  );
  const EXITS = `0x${"e1".repeat(20)}`;
  const on = checkDeployEnv({
    ...SEPOLIA,
    VITE_MATCHED_EXITS: JSON.stringify({ 11155111: EXITS }),
  });
  assert.deepEqual(on.problems, []);
  assert.ok(
    on.summary.includes(
      `Sales between members: on where a DAO votes for it (${EXITS})`,
    ),
  );
  const noNode = checkDeployEnv({
    VITE_MATCHED_EXITS: JSON.stringify({ 11155111: EXITS }),
  });
  assert.ok(
    noNode.problems.some((p) =>
      p.startsWith("VITE_MATCHED_EXITS is named but"),
    ),
  );
  const elsewhere = checkDeployEnv({
    ...SEPOLIA,
    VITE_MATCHED_EXITS: JSON.stringify({ 31337: EXITS }),
  });
  assert.ok(
    elsewhere.problems.some((p) =>
      p.startsWith("VITE_MATCHED_EXITS names no valid address"),
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
    [{ VITE_LBAMM_ADDRESSES: "{}" }, "VITE_LBAMM_ADDRESSES"],
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
      VITE_ZERODEV_PROJECT_ID: "p",
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
