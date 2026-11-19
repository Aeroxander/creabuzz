// The test network's config: from the build's environment or a deployments file, checked. Run with:
// node --experimental-strip-types --test src/pot/network.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import {
  envFromDeployments,
  mustSayPlayMoney,
  parseDeployments,
  parsePotNetwork,
} from "./network.ts";

// The shape `script/DeployPot.s.sol` writes (the public anvil addresses).
const FILE = {
  admin: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  chainId: 31337,
  feeBps: 200,
  launcher: "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0",
  parts: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
  platform: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  quote: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
  unit: 604800,
};

test("a deployments file gives the chain, the Launcher and the dollar", () => {
  const deployments = parseDeployments(FILE);
  assert.equal(deployments.chainId, 31337);
  assert.equal(deployments.launcher, FILE.launcher.toLowerCase());
  assert.equal(deployments.quote, FILE.quote.toLowerCase());
  assert.equal(deployments.unit, 604800);
  assert.deepEqual(envFromDeployments(FILE), {
    VITE_CREATON_CHAIN_ID: "31337",
    VITE_CREATON_LAUNCHER: FILE.launcher.toLowerCase(),
    VITE_CREATON_DOLLAR: FILE.quote.toLowerCase(),
  });
});

test("a file that is not a deployments file gives nothing", () => {
  for (const bad of [
    null,
    [],
    "x",
    {},
    { ...FILE, launcher: "0x12" },
    { ...FILE, quote: undefined },
    { ...FILE, chainId: 0 },
    { ...FILE, chainId: "abc" },
  ])
    assert.equal(parseDeployments(bad), null);
  assert.deepEqual(envFromDeployments({ chainId: 1 }), {});
});

test("the network is read from the environment, lower-cased, and is play money", () => {
  const network = parsePotNetwork({
    VITE_CREATON_CHAIN_ID: "11155111",
    VITE_CREATON_LAUNCHER: FILE.launcher,
    VITE_CREATON_DOLLAR: FILE.quote,
    VITE_CREATON_RPC_URL: " https://rpc.example/x ",
  });
  assert.equal(network.chainId, 11155111);
  assert.equal(network.name, "Sepolia test network");
  assert.equal(network.launcher, FILE.launcher.toLowerCase());
  assert.equal(network.dollar, FILE.quote.toLowerCase());
  assert.equal(network.rpcUrl, "https://rpc.example/x");
  assert.equal(network.playMoney, true);
});

test("a build that names no chain or no Launcher has no network", () => {
  assert.equal(parsePotNetwork({}), null);
  assert.equal(parsePotNetwork({ VITE_CREATON_CHAIN_ID: "31337" }), null);
  assert.equal(
    parsePotNetwork({
      VITE_CREATON_CHAIN_ID: "31337",
      VITE_CREATON_LAUNCHER: "nope",
    }),
    null,
  );
  assert.equal(
    parsePotNetwork({
      VITE_CREATON_CHAIN_ID: "-1",
      VITE_CREATON_LAUNCHER: FILE.launcher,
    }),
    null,
  );
  const bare = parsePotNetwork({
    VITE_CREATON_CHAIN_ID: "31337",
    VITE_CREATON_LAUNCHER: FILE.launcher,
    VITE_CREATON_RPC_URL: "javascript:1",
  });
  assert.equal(bare.rpcUrl, null);
  assert.equal(bare.dollar, null);
});

test("money screens say play money unless the record says otherwise AND real money is switched on", () => {
  assert.equal(mustSayPlayMoney(true), true);
  assert.equal(mustSayPlayMoney(null), true);
  assert.equal(mustSayPlayMoney(undefined), true);
  assert.equal(mustSayPlayMoney(false), true); // step 1: the real-money switch is off
  assert.equal(mustSayPlayMoney(false, true), false);
  assert.equal(mustSayPlayMoney(true, true), true);
});
