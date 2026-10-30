import assert from "node:assert/strict";
import test from "node:test";

import { installErrorReporting } from "../../shared/lib/error-report.ts";
import {
  CHAIN_PRESETS,
  CONFIGURED_DEFAULT_CHAIN_ID,
  DEFAULT_RPC_ENDPOINT,
  LOCAL_ANVIL_PRESET,
  RPC_RETRY,
  SELECTOR_CLEARING_PRICE,
  auctionProgress,
  chainPresetByChainId,
  chainPresetForEndpoint,
  clearingPrice,
  decodeQuantity,
  decodeU256,
  defaultChainPreset,
  exchangeAddresses,
  exchangeCodehashes,
  BLOCK_LOOKUP_CONCURRENCY,
  ethBlockNumber,
  ethBlockTimestamps,
  networkLabel,
  ethCall,
  ethGetLogs,
  forgetEndpointChainIds,
  getRpcEndpoint,
  historyFromBlock,
  isDevBuild,
  priceIndexerUrl,
  reportReadFailure,
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

test("getRpcEndpoint: a deployed site never defaults to the visitor's own machine", () => {
  // Served from this machine (development): the local chain is the default.
  for (const host of ["localhost", "127.0.0.1", "[::1]", "LOCALHOST"]) {
    assert.equal(getRpcEndpoint({}, host), DEFAULT_RPC_ENDPOINT, host);
  }
  // Served from anywhere else with no endpoint configured: no endpoint.
  assert.equal(getRpcEndpoint({}, "app.example.com"), "");
  assert.equal(
    getRpcEndpoint({ VITE_CHAIN_RPC_URL: " " }, "app.example.com"),
    "",
  );
  // A configured endpoint is used wherever the page is served from.
  assert.equal(
    getRpcEndpoint(
      { VITE_CHAIN_RPC_URL: "https://rpc.example.org" },
      "app.example.com",
    ),
    "https://rpc.example.org",
  );
});

test("the price service is only ever a plain http(s) address the build names", () => {
  assert.equal(priceIndexerUrl({}), null);
  assert.equal(priceIndexerUrl({ VITE_PRICE_INDEXER_URL: "  " }), null);
  assert.equal(
    priceIndexerUrl({ VITE_PRICE_INDEXER_URL: "http://127.0.0.1:42069/" }),
    "http://127.0.0.1:42069",
  );
  assert.equal(
    priceIndexerUrl({ VITE_PRICE_INDEXER_URL: "https://prices.example/api/" }),
    "https://prices.example/api",
  );
  assert.equal(priceIndexerUrl({ VITE_PRICE_INDEXER_URL: "ftp://x" }), null);
  assert.equal(
    priceIndexerUrl({ VITE_PRICE_INDEXER_URL: "javascript:1" }),
    null,
  );
  assert.equal(priceIndexerUrl({ VITE_PRICE_INDEXER_URL: "nonsense" }), null);
});

test("the exchange's contracts are only ever the ones the build names, every address checked", () => {
  const good = {
    amm: "0x00000000000000000000000000000000000000A1",
    hook: "0x00000000000000000000000000000000000000b2",
    registry: "0x00000000000000000000000000000000000000c3",
    poolType: "0x00000000000000000000000000000000000000d4",
  };
  const env = (value) => ({ VITE_LBAMM_ADDRESSES: JSON.stringify(value) });
  assert.deepEqual(exchangeAddresses(31337, env({ 31337: good })), {
    amm: good.amm.toLowerCase(),
    hook: good.hook,
    registry: good.registry,
    poolType: good.poolType,
  });
  assert.equal(exchangeAddresses(1, env({ 31337: good })), null);
  assert.equal(exchangeAddresses(31337, {}), null);
  assert.equal(exchangeAddresses(null, env({ 31337: good })), null);
  assert.equal(
    exchangeAddresses(31337, env({ 31337: { ...good, hook: "nope" } })),
    null,
  );
  assert.equal(
    exchangeAddresses(31337, env({ 31337: { amm: good.amm } })),
    null,
  );
  assert.equal(
    exchangeAddresses(31337, { VITE_LBAMM_ADDRESSES: "{not json" }),
    null,
  );
  assert.equal(exchangeAddresses(31337, env([good])), null);
});

test("an exchange on any chain but the local one needs pinned code, or it is refused", () => {
  const addresses = {
    amm: "0x00000000000000000000000000000000000000a1",
    hook: "0x00000000000000000000000000000000000000a2",
    registry: "0x00000000000000000000000000000000000000a3",
    poolType: "0x00000000000000000000000000000000000000a4",
  };
  const pins = Object.fromEntries(
    Object.keys(addresses).map((k, i) => [k, `0x${String(i + 1).repeat(64)}`]),
  );
  const env = (entry) => ({
    VITE_LBAMM_ADDRESSES: JSON.stringify({ 11155111: entry, 31337: entry }),
  });

  // Unpinned: fine on the local test chain, refused anywhere real.
  assert.notEqual(exchangeAddresses(31337, env(addresses)), null);
  assert.equal(exchangeAddresses(11155111, env(addresses)), null);
  assert.equal(exchangeCodehashes(11155111, env(addresses)), null);

  // Pinned: accepted, and the pins read back lower-cased.
  const pinned = { ...addresses, codehashes: pins };
  assert.notEqual(exchangeAddresses(11155111, env(pinned)), null);
  assert.deepEqual(exchangeCodehashes(11155111, env(pinned)), pins);
  assert.deepEqual(
    exchangeCodehashes(
      11155111,
      env({
        ...addresses,
        codehashes: Object.fromEntries(
          Object.entries(pins).map(([k, v]) => [
            k,
            v.toUpperCase().replace("0X", "0x"),
          ]),
        ),
      }),
    ),
    pins,
  );

  // A pin that is missing, short, or not hex makes the whole entry unusable.
  assert.equal(
    exchangeAddresses(
      11155111,
      env({ ...addresses, codehashes: { ...pins, hook: "0x1234" } }),
    ),
    null,
  );
  const { poolType: _dropped, ...partial } = pins;
  assert.equal(
    exchangeAddresses(11155111, env({ ...addresses, codehashes: partial })),
    null,
  );
  assert.equal(
    exchangeAddresses(11155111, env({ ...addresses, codehashes: [pins] })),
    null,
  );
});

/** A JSON-RPC node that refuses `eth_getLogs` over more than `limit` blocks, as real ones do, and has one log per 1000 blocks. */
function limitedNode({ head, chainId, limit }) {
  forgetEndpointChainIds();
  const original = globalThis.fetch;
  const asked = [];
  const methods = [];
  globalThis.fetch = async (_url, init) => {
    const { method, params } = JSON.parse(init.body);
    methods.push(method);
    const reply = (result) => ({
      ok: true,
      status: 200,
      json: async () => ({ jsonrpc: "2.0", id: 1, result }),
    });
    if (method === "eth_chainId") return reply(`0x${chainId.toString(16)}`);
    if (method === "eth_blockNumber") return reply(`0x${head.toString(16)}`);
    assert.equal(method, "eth_getLogs");
    const from = BigInt(params[0].fromBlock);
    const to = BigInt(
      params[0].toBlock === "latest" ? head : params[0].toBlock,
    );
    asked.push([from, to]);
    if (to - from + 1n > limit) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          jsonrpc: "2.0",
          id: 1,
          error: { message: `exceed maximum block range: ${limit}` },
        }),
      };
    }
    const logs = [];
    for (
      let block = from - (from % 1000n) + (from % 1000n === 0n ? 0n : 1000n);
      block <= to;
      block += 1000n
    ) {
      logs.push({
        address: params[0].address,
        topics: params[0].topics,
        data: "0x",
        blockNumber: `0x${block.toString(16)}`,
        transactionHash: `0x${block.toString(16).padStart(64, "0")}`,
        logIndex: "0x0",
      });
    }
    return reply(logs);
  };
  return {
    asked,
    methods,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

const FILTER = {
  address: "0x1111111111111111111111111111111111111111",
  topics: [`0x${"ab".repeat(32)}`],
  fromBlock: "0x0",
  toBlock: "latest",
};

test("the block a chain's history starts at is only what the build names, as a whole number", () => {
  assert.equal(historyFromBlock(11155111, {}), 0n);
  assert.equal(
    historyFromBlock(11155111, { VITE_HISTORY_FROM_BLOCKS: "" }),
    0n,
  );
  assert.equal(
    historyFromBlock(11155111, {
      VITE_HISTORY_FROM_BLOCKS: '{"11155111":7654321}',
    }),
    7654321n,
  );
  assert.equal(
    historyFromBlock(1, { VITE_HISTORY_FROM_BLOCKS: '{"11155111":7654321}' }),
    0n,
    "another chain's entry is not this chain's",
  );
  for (const bad of [
    '{"11155111":"7654321"}',
    '{"11155111":-5}',
    '{"11155111":1.5}',
    "[1]",
    "nonsense",
  ]) {
    assert.equal(
      historyFromBlock(11155111, { VITE_HISTORY_FROM_BLOCKS: bad }),
      0n,
      bad,
    );
  }
});

test("a node that answers the whole history is asked once", async () => {
  const node = limitedNode({
    head: 500_000n,
    chainId: 31337,
    limit: 10_000_000n,
  });
  try {
    const logs = await ethGetLogs("http://node.test", FILTER, {});
    assert.equal(node.asked.length, 1);
    assert.equal(logs.length, 501);
  } finally {
    node.restore();
  }
});

test("a node that caps the range is read in pages from the block the build names, and nothing is missed", async () => {
  const node = limitedNode({
    head: 11_960_000n,
    chainId: 11155111,
    limit: 50_000n,
  });
  try {
    const logs = await ethGetLogs("http://node.test", FILTER, {
      VITE_HISTORY_FROM_BLOCKS: '{"11155111":11900000}',
    });
    const blocks = logs.map((log) => BigInt(log.blockNumber));
    const want = [];
    for (let block = 11_900_000n; block <= 11_960_000n; block += 1000n)
      want.push(block);
    assert.deepEqual(blocks, want);
    assert.ok(
      node.asked.every(([from]) => from >= 11_900_000n),
      "no request asks for history before the block the build names",
    );
  } finally {
    node.restore();
  }
});

test("a capped node with no start named is refused with what to set, not read for minutes", async () => {
  const node = limitedNode({
    head: 11_960_000n,
    chainId: 11155111,
    limit: 50_000n,
  });
  try {
    await assert.rejects(
      ethGetLogs("http://node.test", FILTER, {}),
      (error) =>
        /organiser/.test(error.message) &&
        !/VITE_/.test(error.message) &&
        /VITE_HISTORY_FROM_BLOCKS/.test(error.detail),
    );
    assert.ok(node.asked.length < 200, `${node.asked.length} requests`);
  } finally {
    node.restore();
  }
});

test("a node that fails for another reason is not paged around", async () => {
  const original = globalThis.fetch;
  const delays = RPC_RETRY.delaysMs;
  RPC_RETRY.delaysMs = [];
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { ok: false, status: 503, json: async () => ({}) };
  };
  try {
    await assert.rejects(
      ethGetLogs("http://node.test", FILTER, {}),
      (error) =>
        error.message ===
          "The chain node is busy. Try again in a minute; if it keeps happening, tell the site's organiser." &&
        error.detail === "rpc http 503",
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
    RPC_RETRY.delaysMs = delays;
  }
});

test("a busy node is asked again, and one dropped read does not fail the screen", async () => {
  const original = globalThis.fetch;
  const delays = RPC_RETRY.delaysMs;
  RPC_RETRY.delaysMs = [1, 1];
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) return { ok: false, status: 503, json: async () => ({}) };
    if (calls === 2) throw new TypeError("Failed to fetch");
    return { ok: true, json: async () => ({ result: "0x2a" }) };
  };
  try {
    assert.equal(await ethBlockNumber("http://node.test"), 42n);
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = original;
    RPC_RETRY.delaysMs = delays;
  }
});

test("a read that never answers fails in plain words, after the retries", async () => {
  const original = globalThis.fetch;
  const delays = RPC_RETRY.delaysMs;
  RPC_RETRY.delaysMs = [1];
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new DOMException("signal is aborted without reason", "AbortError");
  };
  try {
    await assert.rejects(
      ethBlockNumber("http://node.test"),
      /did not answer in time/,
    );
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = original;
    RPC_RETRY.delaysMs = delays;
  }
});

test("a reverted call is a real answer: it is not asked again", async () => {
  const original = globalThis.fetch;
  const delays = RPC_RETRY.delaysMs;
  RPC_RETRY.delaysMs = [1, 1];
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return {
      ok: true,
      json: async () => ({ error: { message: "execution reverted" } }),
    };
  };
  try {
    await assert.rejects(
      ethCall("http://node.test", `0x${"11".repeat(20)}`, "0x"),
      /execution reverted/,
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
    RPC_RETRY.delaysMs = delays;
  }
});

test("block times are looked up a few at a time, and a block that cannot be had is left out, never invented", async () => {
  const original = globalThis.fetch;
  const delays = RPC_RETRY.delaysMs;
  RPC_RETRY.delaysMs = [];
  let inFlight = 0;
  let peak = 0;
  globalThis.fetch = async (_url, init) => {
    const { params } = JSON.parse(init.body);
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 2));
    inFlight -= 1;
    const number = Number(BigInt(params[0]));
    // Block 7 cannot be had.
    if (number === 7) return { ok: false, status: 429, json: async () => ({}) };
    return {
      ok: true,
      json: async () => ({
        result: {
          number: `0x${number.toString(16)}`,
          timestamp: `0x${(1_700_000_000 + number).toString(16)}`,
        },
      }),
    };
  };
  try {
    const blocks = Array.from({ length: 40 }, (_, i) => i + 1);
    const samples = await ethBlockTimestamps("http://node.test", blocks);
    assert.ok(
      peak <= BLOCK_LOOKUP_CONCURRENCY,
      `${peak} lookups at once, not more than ${BLOCK_LOOKUP_CONCURRENCY}`,
    );
    assert.equal(samples.length, 39);
    assert.ok(!samples.some((s) => s.block === 7));
    assert.equal(
      samples.find((s) => s.block === 3).timestampSeconds,
      1_700_000_003,
    );
  } finally {
    globalThis.fetch = original;
    RPC_RETRY.delaysMs = delays;
  }
});

test("a chain id is said in words when the app knows the chain, and as a plain number otherwise", () => {
  assert.equal(networkLabel(11155111), "Sepolia");
  assert.equal(networkLabel(31337), "Local Anvil");
  assert.equal(networkLabel(424242), "network 424242");
});

test("a read starts at the block the build names straight away, without waiting for the node to refuse block 0", async () => {
  // No cap at all: before, the first request still asked for 0..head and only a range-worded refusal moved it.
  const node = limitedNode({
    head: 11_960_000n,
    chainId: 11155111,
    limit: 100_000_000n,
  });
  const env = { VITE_HISTORY_FROM_BLOCKS: '{"11155111":11900000}' };
  try {
    const logs = await ethGetLogs("http://node.test", FILTER, env);
    assert.equal(node.asked.length, 1);
    assert.equal(node.asked[0][0], 11_900_000n);
    assert.equal(BigInt(logs[0].blockNumber), 11_900_000n);
    // The chain id is asked once for the endpoint, not once per read.
    await ethGetLogs("http://node.test", FILTER, env);
    assert.equal(node.methods.filter((m) => m === "eth_chainId").length, 1);
    // A filter that already starts later keeps its own start.
    await ethGetLogs(
      "http://node.test",
      { ...FILTER, fromBlock: `0x${(11_950_000).toString(16)}` },
      env,
    );
    assert.equal(node.asked.at(-1)[0], 11_950_000n);
  } finally {
    node.restore();
  }
});

/** A node that answers every request with a JSON-RPC error carrying `words`. */
function refusingNode(words) {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ jsonrpc: "2.0", id: 1, error: { message: words } }),
    };
  };
  return {
    calls: () => calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

test("a rate-limited node is asked again after a pause, then said plainly: never paged around, never its raw words", async () => {
  forgetEndpointChainIds();
  const delays = RPC_RETRY.delaysMs;
  RPC_RETRY.delaysMs = [1, 1];
  const node = refusingNode(
    "daily request count exceeded, request rate limited",
  );
  try {
    await assert.rejects(
      ethGetLogs("http://node.test", FILTER, {}),
      (error) =>
        error.name === "ChainReadError" &&
        error.reason === "busy" &&
        /The chain node is busy\. Try again in a minute/.test(error.message) &&
        !/request count|rate limited/.test(error.message) &&
        /request rate limited/.test(error.detail),
    );
    // The first ask and its two pauses: three requests, not the eleven of a halving page loop.
    assert.equal(node.calls(), 3);
  } finally {
    node.restore();
    RPC_RETRY.delaysMs = delays;
  }
});

test("a reverted call is never taken for a busy node, even when its words say 'rate limit'", async () => {
  const delays = RPC_RETRY.delaysMs;
  RPC_RETRY.delaysMs = [1, 1];
  const node = refusingNode("execution reverted: rate limit reached");
  try {
    await assert.rejects(
      ethCall("http://node.test", `0x${"11".repeat(20)}`, "0x"),
      /execution reverted/,
    );
    assert.equal(node.calls(), 1);
  } finally {
    node.restore();
    RPC_RETRY.delaysMs = delays;
  }
});

test("a chain node failing is told to the error collector once per cause a visit, in its own words, not the person's", async () => {
  forgetEndpointChainIds();
  const sent = [];
  const stop = installErrorReporting({
    endpoint: "https://errors.example/creaton",
    target: { addEventListener() {}, removeEventListener() {} },
    fetchImpl: (_url, init) => {
      sent.push(JSON.parse(init.body));
      return Promise.resolve();
    },
    page: () => "/launchpad/abc",
    now: () => 1_760_000_000_000,
  });
  const delays = RPC_RETRY.delaysMs;
  RPC_RETRY.delaysMs = [];
  const node = refusingNode("rate limit exceeded");
  try {
    for (let i = 0; i < 3; i += 1) {
      await assert.rejects(ethBlockNumber("http://node.test"));
    }
    assert.equal(sent.length, 1, "three failures, one note");
    assert.equal(sent[0].kind, "handled");
    assert.equal(sent[0].message, "chain-busy: rate limit exceeded");
  } finally {
    node.restore();
    RPC_RETRY.delaysMs = delays;
  }
  const limited = limitedNode({
    head: 11_960_000n,
    chainId: 11155111,
    limit: 50_000n,
  });
  try {
    await assert.rejects(ethGetLogs("http://node.test", FILTER, {}));
    assert.equal(sent.length, 2);
    assert.match(
      sent[1].message,
      /^chain-history-too-wide: reading blocks 0 to/,
    );
  } finally {
    limited.restore();
    stop();
  }
});

test("a page that shows a failed read reports it once: a busy node already told at the rpc is not told again", async () => {
  forgetEndpointChainIds();
  const sent = [];
  const stop = installErrorReporting({
    endpoint: "https://errors.example/creaton",
    target: { addEventListener() {}, removeEventListener() {} },
    fetchImpl: (_url, init) => {
      sent.push(JSON.parse(init.body));
      return Promise.resolve();
    },
    page: () => "/launchpad/abc",
    now: () => 1_760_000_000_000,
  });
  const delays = RPC_RETRY.delaysMs;
  RPC_RETRY.delaysMs = [];
  const node = refusingNode("rate limit exceeded");
  try {
    const busy = await ethBlockNumber("http://node.test").catch((e) => e);
    assert.equal(sent.length, 1);
    reportReadFailure("work-read", busy);
    assert.equal(sent.length, 1, "the busy node was already told once");
    // Anything the rpc did not tell is told under the page's own name.
    reportReadFailure("work-read", new Error("decoded nonsense"));
    assert.equal(sent.length, 2);
    assert.equal(sent[1].message, "work-read: decoded nonsense");
  } finally {
    node.restore();
    RPC_RETRY.delaysMs = delays;
    stop();
  }
});
