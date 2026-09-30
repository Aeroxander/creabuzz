import assert from "node:assert/strict";
import test from "node:test";

import {
  CHAIN_PRESETS,
  chainPresetForEndpoint,
  CONFIGURED_DEFAULT_CHAIN_ID,
  DEFAULT_RPC_ENDPOINT,
  decodeBool,
  decodeUint256,
  defaultChainPreset,
  getRpcEndpoint,
  hexToBigInt,
  LOCAL_ANVIL_PRESET,
  RpcChainAdapter,
  SELECTOR_CURRENCY_RAISED,
  SELECTOR_IS_GRADUATED,
  TOPIC_BID_SUBMITTED,
} from "./chainRpc.ts";
// The web client is the canonical copy of the same picker list; see the
// "web and desktop" test below.
import {
  CHAIN_PRESETS as WEB_CHAIN_PRESETS,
  defaultChainPreset as webDefaultChainPreset,
} from "../../../../../web/src/features/launchpad/chain.ts";

test("selectors are 4-byte function selectors", () => {
  for (const selector of [SELECTOR_IS_GRADUATED, SELECTOR_CURRENCY_RAISED]) {
    assert.match(selector, /^0x[0-9a-f]{8}$/);
  }
  assert.equal(SELECTOR_IS_GRADUATED, "0x9e5f2602");
  assert.equal(SELECTOR_CURRENCY_RAISED, "0x998ba4fc");
  assert.equal(
    TOPIC_BID_SUBMITTED,
    "0x650baad5cd8ca09b8f580be220fa04ce2ba905a041f764b6a3fe2c848eb70540",
  );
});

test("hexToBigInt decodes bounds", () => {
  assert.equal(hexToBigInt("0x0"), 0n);
  assert.equal(hexToBigInt("0xff"), 255n);
  assert.throws(() => hexToBigInt("zz"), /not hex/);
  assert.throws(() => hexToBigInt("0x"), /empty/);
  assert.throws(() => hexToBigInt(`0x${"ff".repeat(33)}`), /overflow/);
});

test("decodeUint256 requires 32 bytes", () => {
  assert.equal(decodeUint256(`0x${"0".repeat(62)}ff`), 255n);
  assert.throws(() => decodeUint256("0x1234"), /32-byte/);
});

test("decodeBool accepts only the canonical ABI bool", () => {
  assert.equal(decodeBool(`0x${"0".repeat(64)}`), false);
  assert.equal(decodeBool(`0x${"0".repeat(63)}1`), true);
  // Garbage must not read as graduated.
  assert.throws(() => decodeBool(`0x${"0".repeat(63)}2`), /canonical bool/);
  assert.throws(() => decodeBool("0x1234"), /32-byte/);
});

function stubFetch(routes) {
  const calls = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const handler = routes[body.method];
    const result =
      typeof handler === "function" ? handler(body.params) : handler;
    if (result instanceof Error) throw result;
    return { ok: true, json: async () => ({ result }) };
  };
  return calls;
}

function record(overrides = {}) {
  return {
    id: "nebula",
    author: "a".repeat(64),
    auction: "0x1234567890123456789012345678901234567890",
    floorPrice: "100",
    requiredRaised: "1000",
    claimBlock: null,
    ...overrides,
  };
}

test("RpcChainAdapter reads graduation and raised", async () => {
  const orig = globalThis.fetch;
  try {
    stubFetch({
      eth_call: ([call]) =>
        call.data === SELECTOR_IS_GRADUATED
          ? `0x${"0".repeat(63)}1`
          : `0x${"0".repeat(61)}1f4`,
      eth_blockNumber: "0x64",
      eth_getLogs: [],
    });
    const adapter = new RpcChainAdapter("http://localhost:8545");
    const progress = await adapter.getAuctionProgress(record());
    assert.equal(progress.source, "rpc");
    assert.equal(progress.graduated, true);
    assert.equal(progress.ended, true);
    assert.equal(progress.raised, 500n);
    assert.equal(progress.goal, 1000n);
  } finally {
    globalThis.fetch = orig;
  }
});

test("RpcChainAdapter throws without an auction contract", async () => {
  const adapter = new RpcChainAdapter("http://localhost:8545");
  await assert.rejects(
    () => adapter.getAuctionProgress(record({ auction: null })),
    /no auction/,
  );
});

test("RpcChainAdapter throws when the RPC is unreachable", async () => {
  const orig = globalThis.fetch;
  try {
    globalThis.fetch = async () => {
      throw new Error("down");
    };
    const adapter = new RpcChainAdapter("http://localhost:8545");
    await assert.rejects(() => adapter.getAuctionProgress(record()), /down/);
  } finally {
    globalThis.fetch = orig;
  }
});

test("RpcChainAdapter still returns core numbers when logs fail", async () => {
  const orig = globalThis.fetch;
  try {
    stubFetch({
      eth_call: () => `0x${"0".repeat(64)}`,
      eth_blockNumber: "0x1",
      eth_getLogs: new Error("no logs"),
    });
    const adapter = new RpcChainAdapter("http://localhost:8545");
    const progress = await adapter.getAuctionProgress(record());
    assert.equal(progress.bidCount, 0);
    assert.equal(progress.graduated, false);
  } finally {
    globalThis.fetch = orig;
  }
});

test("default endpoint targets local Anvil", () => {
  assert.equal(DEFAULT_RPC_ENDPOINT, "http://127.0.0.1:8545");
});

// — chain presets (the picker contract) —
//
// Pinned byte-for-byte and re-pinned against the web copy below: the two
// clients render one list, so a preset change is a two-file change that must
// land together.

const PRESET_TABLE = [
  {
    id: "anvil",
    label: "Local Anvil",
    chainId: 31337,
    rpcUrl: "http://127.0.0.1:8545",
    nativeSymbol: "ETH",
  },
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

test("the preset list is the pinned picker contract", () => {
  assert.deepEqual([...CHAIN_PRESETS], PRESET_TABLE);
  assert.equal(CHAIN_PRESETS[0].id, LOCAL_ANVIL_PRESET.id);
  assert.equal(
    new Set(CHAIN_PRESETS.map((p) => p.id)).size,
    PRESET_TABLE.length,
  );
  for (const preset of CHAIN_PRESETS) {
    assert.equal(typeof preset.chainId, "number");
    assert.ok(
      preset.label.length > 0,
      `${preset.id} needs a plain-language label`,
    );
  }
  assert.equal(CONFIGURED_DEFAULT_CHAIN_ID, 11155111);
});

test("defaultChainPreset: dev -> Local Anvil, prod -> configured default", () => {
  const cases = [
    [{}, true, "anvil"],
    [{}, false, "sepolia"],
    // A mainnet default needs the explicit switch (R4); without it the build
    // falls back to its safe default.
    [{ VITE_LAUNCHPAD_CHAIN_ID: "8453" }, true, "anvil"],
    [{ VITE_LAUNCHPAD_CHAIN_ID: "8453" }, false, "sepolia"],
    [
      { VITE_LAUNCHPAD_CHAIN_ID: "8453", VITE_ENABLE_MAINNET: "1" },
      true,
      "base",
    ],
    [{ VITE_LAUNCHPAD_CHAIN_ID: "84532" }, false, "base-sepolia"],
    [{ VITE_LAUNCHPAD_CHAIN_ID: "31337" }, false, "anvil"],
    [{ VITE_LAUNCHPAD_CHAIN_ID: "99999999" }, true, "anvil"],
    [{ VITE_LAUNCHPAD_CHAIN_ID: "99999999" }, false, "sepolia"],
    [{ VITE_LAUNCHPAD_CHAIN_ID: "not-a-number" }, true, "anvil"],
    [{ VITE_LAUNCHPAD_CHAIN_ID: "" }, false, "sepolia"],
  ];
  for (const [env, dev, expected] of cases) {
    assert.equal(
      defaultChainPreset(env, dev).id,
      expected,
      `defaultChainPreset(${JSON.stringify(env)}, ${dev})`,
    );
  }
});

test("web and desktop render the same preset list and default rule", () => {
  // Falsifiable single source of truth: edit one side and this goes red.
  assert.deepEqual(
    [...CHAIN_PRESETS],
    [...WEB_CHAIN_PRESETS],
    "web/src/features/launchpad/chain.ts and desktop chainRpc.ts presets drifted",
  );
  for (const dev of [true, false]) {
    assert.equal(
      defaultChainPreset({}, dev).id,
      webDefaultChainPreset({}, dev).id,
      `default preset drifted for dev=${dev}`,
    );
  }
});

test("chainPresetForEndpoint matches saved endpoints to presets", () => {
  assert.equal(chainPresetForEndpoint("http://127.0.0.1:8545")?.id, "anvil");
  assert.equal(chainPresetForEndpoint("http://127.0.0.1:8545/")?.id, "anvil");
  assert.equal(
    chainPresetForEndpoint("  http://127.0.0.1:8545  ")?.id,
    "anvil",
  );
  assert.equal(chainPresetForEndpoint("http://127.0.0.1:9999"), null);
});

test("getRpcEndpoint: saved choice, then VITE_CHAIN_RPC_URL, then default", () => {
  // No localStorage in the node runner: the storage read fails closed and the
  // configured defaults below are what callers get.
  assert.equal(getRpcEndpoint(null, {}), DEFAULT_RPC_ENDPOINT);
  assert.equal(
    getRpcEndpoint(null, { VITE_CHAIN_RPC_URL: "http://127.0.0.1:9545" }),
    "http://127.0.0.1:9545",
  );
  assert.equal(
    getRpcEndpoint(null, { VITE_CHAIN_RPC_URL: "   " }),
    DEFAULT_RPC_ENDPOINT,
  );
  assert.equal(getRpcEndpoint(null), DEFAULT_RPC_ENDPOINT);
});
