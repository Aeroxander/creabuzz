import assert from "node:assert/strict";
import test from "node:test";

import {
  CHAIN_PRESETS,
  CONFIGURED_DEFAULT_CHAIN_ID,
  DEFAULT_RPC_ENDPOINT,
  LOCAL_ANVIL_PRESET,
  SELECTOR_CLEARING_PRICE,
  auctionProgress,
  chainPresetByChainId,
  chainPresetForEndpoint,
  clearingPrice,
  decodeQuantity,
  decodeU256,
  defaultChainPreset,
  getRpcEndpoint,
  isDevBuild,
} from "./chain.ts";

const RECORD = {
  id: "nebula",
  author: "a".repeat(64),
  auction: "0x1111111111111111111111111111111111111111",
  requiredRaised: null,
  stage: "live",
  claimBlock: null,
};

const NO_AUCTION = { ...RECORD, auction: null };

function word(value) {
  return value.toString(16).padStart(64, "0");
}

/** Stub JSON-RPC: `responses` maps a method to its result, or throws. */
function stubFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const { method, params } = JSON.parse(init.body);
    const result = handler(method, params);
    return {
      ok: true,
      status: 200,
      json: async () => ({ jsonrpc: "2.0", id: 1, result }),
    };
  };
  return () => {
    globalThis.fetch = original;
  };
}

test("a production build never reports fabricated figures", async () => {
  const restore = stubFetch(() => {
    throw new Error("connection refused");
  });
  try {
    const failedRead = await auctionProgress(RECORD, { allowPreview: false });
    assert.equal(failedRead.source, "unavailable");
    assert.match(String(failedRead.reason), /connection refused/);
    // The fixture would have reported a plausible raise percentage here.
    assert.equal(failedRead.goal, null);

    const noContract = await auctionProgress(NO_AUCTION, {
      allowPreview: false,
    });
    assert.equal(noContract.source, "unavailable");
    assert.equal(noContract.reason, "no auction contract linked");
  } finally {
    restore();
  }
});

test("a development build may show the preview fixture", async () => {
  const restore = stubFetch(() => {
    throw new Error("connection refused");
  });
  try {
    const progress = await auctionProgress(NO_AUCTION, {
      allowPreview: true,
    });
    assert.equal(progress.source, "preview");
  } finally {
    restore();
  }
});

test("a reachable chain yields rpc values", async () => {
  const restore = stubFetch((method, params) => {
    if (method === "eth_blockNumber") return "0x10";
    if (method === "eth_getLogs") return [];
    const data = params[0].data;
    if (data === "0x9e5f2602") return `0x${word(1n)}`;
    if (data === "0x998ba4fc") return `0x${word(5000000000000000000n)}`;
    throw new Error(`unexpected call ${data}`);
  });
  try {
    const progress = await auctionProgress(RECORD, { allowPreview: false });
    assert.equal(progress.source, "rpc");
    assert.equal(progress.graduated, true);
    assert.equal(progress.raised, 5000000000000000000n);
  } finally {
    restore();
  }
});

test("the fixture is not reachable in a production build", () => {
  // `import.meta.env` is Vite's; outside it the helper must not throw and must
  // not claim a dev build.
  assert.equal(isDevBuild(), false);
});

test("quantities decode as minimal hex, words require 32 bytes", () => {
  // A block number like `0x12a05f3` is one byte short of a word; decoding it
  // with the ABI word decoder rejected every real node's answer.
  assert.equal(decodeQuantity("0x10"), 16n);
  assert.equal(decodeQuantity("0x12a05f3"), 19531251n);
  assert.equal(decodeQuantity("0x0"), 0n);
  assert.throws(() => decodeQuantity("0x"), /hex quantity/);
  assert.throws(() => decodeQuantity("nope"), /hex quantity/);

  assert.equal(decodeU256(`0x${word(7n)}`), 7n);
  assert.throws(() => decodeU256("0x10"), /32-byte/);
});

test("a failed log query leaves the bid count unknown, not zero", async () => {
  // The rest of the read succeeded, so the live figures are reported — but the
  // bid count is a figure nobody measured. Reporting 0 there would sit next to
  // real numbers and look like one of them.
  const restore = stubFetch((method) => {
    if (method === "eth_getLogs") throw new Error("query timed out");
    if (method === "eth_blockNumber") return "0x10";
    return `0x${word(1n)}`;
  });
  try {
    const progress = await auctionProgress(RECORD, { allowPreview: false });
    assert.equal(progress.source, "rpc");
    assert.equal(progress.bidCount, null);
  } finally {
    restore();
  }
});

test("a log query that answers reports the bids it saw", async () => {
  const restore = stubFetch((method) => {
    if (method === "eth_getLogs") return [{}, {}, {}];
    if (method === "eth_blockNumber") return "0x10";
    return `0x${word(1n)}`;
  });
  try {
    const progress = await auctionProgress(RECORD, { allowPreview: false });
    assert.equal(progress.bidCount, 3);
  } finally {
    restore();
  }
});

test("a chain that answered none of the read reports no figures at all", async () => {
  const restore = stubFetch(() => {
    throw new Error("connection refused");
  });
  try {
    const progress = await auctionProgress(RECORD, { allowPreview: false });
    assert.equal(progress.bidCount, null);
  } finally {
    restore();
  }
});

// — clearingPrice (bid composer) —

test("clearingPrice reads the pinned selector and returns Q96", async () => {
  const restore = stubFetch((method, params) => {
    assert.equal(method, "eth_call");
    assert.equal(params[0].to, "0x1111111111111111111111111111111111111111");
    assert.equal(params[0].data, SELECTOR_CLEARING_PRICE);
    return `0x${word(12345n)}`;
  });
  try {
    assert.equal(await clearingPrice("http://rpc", RECORD.auction), 12345n);
  } finally {
    restore();
  }
});

test("clearingPrice returns null on a failed or malformed read", async () => {
  const restore = stubFetch(() => {
    throw new Error("connection refused");
  });
  try {
    assert.equal(await clearingPrice("http://rpc", RECORD.auction), null);
    assert.equal(await clearingPrice("http://rpc", "not-an-address"), null);
  } finally {
    restore();
  }
});

// — chain presets (the picker contract) —
//
// Pinned byte-for-byte: the desktop control renders this same list
// (`desktop/src/features/launchpad/lib/chainRpc.ts`, pinned equal there too),
// so a preset change is a two-file change that must land together.

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
  // Local first: a dev machine must never have to scroll past testnets.
  assert.equal(CHAIN_PRESETS[0].id, LOCAL_ANVIL_PRESET.id);
  // Machine values stay machine values: numeric chain ids, unique ids.
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
    // [env, dev, expected preset id]
    [{}, true, "anvil"],
    [{}, false, "sepolia"],
    // Build-time config wins in every build shape.
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
    // An unrecognized configured id falls through to the rule above
    // rather than leaving the picker with no chain.
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

test("chainPresetByChainId resolves presets and rejects unknown ids", () => {
  assert.equal(chainPresetByChainId(31337)?.id, "anvil");
  assert.equal(chainPresetByChainId("11155111")?.id, "sepolia");
  assert.equal(chainPresetByChainId(" 8453 ")?.id, "base");
  assert.equal(chainPresetByChainId(424242), null);
  assert.equal(chainPresetByChainId("abc"), null);
});

test("chainPresetForEndpoint matches saved endpoints to presets", () => {
  assert.equal(chainPresetForEndpoint("http://127.0.0.1:8545")?.id, "anvil");
  // A trailing slash (a hand-typed custom endpoint) still counts.
  assert.equal(chainPresetForEndpoint("http://127.0.0.1:8545/")?.id, "anvil");
  assert.equal(
    chainPresetForEndpoint("  http://127.0.0.1:8545  ")?.id,
    "anvil",
  );
  assert.equal(chainPresetForEndpoint("http://127.0.0.1:9999"), null);
});

test("getRpcEndpoint: saved choice, then VITE_CHAIN_RPC_URL, then default", () => {
  // No window in the node runner: the storage read fails closed and the
  // configured defaults below are what callers get.
  assert.equal(getRpcEndpoint({}), DEFAULT_RPC_ENDPOINT);
  assert.equal(DEFAULT_RPC_ENDPOINT, "http://127.0.0.1:8545");
  assert.equal(
    getRpcEndpoint({ VITE_CHAIN_RPC_URL: "http://127.0.0.1:9545" }),
    "http://127.0.0.1:9545",
  );
  // Blank/whitespace env is not a configured endpoint.
  assert.equal(
    getRpcEndpoint({ VITE_CHAIN_RPC_URL: "   " }),
    DEFAULT_RPC_ENDPOINT,
  );
  assert.equal(getRpcEndpoint(), DEFAULT_RPC_ENDPOINT);
});
