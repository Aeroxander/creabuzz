import assert from "node:assert/strict";
import test from "node:test";

import {
  auctionProgress,
  decodeQuantity,
  decodeU256,
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
