import assert from "node:assert/strict";
import test from "node:test";

import {
  HistoryTooWideError,
  MAX_PAGES,
  isRangeLimitError,
  isRateLimitError,
  rangeLimitFrom,
  readInPages,
} from "./log-pages.ts";

/** A node that refuses any request wider than `limit` blocks, as real ones do, and holds one log per `every` blocks. */
function node(limit, every = 7n) {
  const asked = [];
  const fetchPage = async (from, to) => {
    asked.push([from, to]);
    if (to - from + 1n > limit) {
      throw new Error(`exceed maximum block range: ${limit}`);
    }
    const found = [];
    for (let block = from; block <= to; block += 1n) {
      if (block % every === 0n) found.push(block);
    }
    return found;
  };
  return { fetchPage, asked };
}

const everything = (from, to, every = 7n) => {
  const all = [];
  for (let block = from; block <= to; block += 1n) {
    if (block % every === 0n) all.push(block);
  }
  return all;
};

test("a node's complaint about the range is told from one about anything else", () => {
  assert.equal(
    isRangeLimitError(new Error("exceed maximum block range: 50000")),
    true,
  );
  assert.equal(
    isRangeLimitError(new Error("query returned more than 10000 results")),
    true,
  );
  assert.equal(
    isRangeLimitError(
      new Error("eth_getLogs is limited to a 10,000 block range"),
    ),
    true,
  );
  assert.equal(
    isRangeLimitError(new Error("Log response size exceeded")),
    true,
  );
  assert.equal(isRangeLimitError(new Error("rpc http 500")), false);
  assert.equal(
    isRangeLimitError(new Error("The user aborted a request.")),
    false,
  );
  assert.equal(isRangeLimitError(new Error("Too Many Requests")), false);
});

test("the limit a node names is read out of its words", () => {
  assert.equal(
    rangeLimitFrom(new Error("exceed maximum block range: 50000")),
    50000n,
  );
  assert.equal(
    rangeLimitFrom(new Error("eth_getLogs is limited to a 10,000 block range")),
    10000n,
  );
  assert.equal(
    rangeLimitFrom(new Error("query returned more than 10000 results")),
    null,
  );
  assert.equal(
    rangeLimitFrom(new Error("block range 3")),
    null,
    "a limit too small to be real is not trusted",
  );
});

test("pages cover the range once, in order, with nothing missed or repeated", async () => {
  const { fetchPage, asked } = node(5000n);
  const got = await readInPages({
    fetchPage,
    from: 1000n,
    to: 31_234n,
    pageSize: 5000n,
  });
  assert.deepEqual(got, everything(1000n, 31_234n));
  assert.equal(asked[0][0], 1000n);
  assert.equal(asked.at(-1)[1], 31_234n);
  for (let i = 1; i < asked.length; i += 1) {
    assert.equal(
      asked[i][0],
      asked[i - 1][1] + 1n,
      "each page starts where the last ended",
    );
  }
});

test("a page the node still refuses is halved until it fits", async () => {
  const { fetchPage } = node(1200n);
  const got = await readInPages({
    fetchPage,
    from: 0n,
    to: 20_000n,
    pageSize: 10_000n,
  });
  assert.deepEqual(got, everything(0n, 20_000n));
});

test("a node that names its limit is paged at that size straight away", async () => {
  const { fetchPage, asked } = node(2000n);
  const refusal = new Error("exceed maximum block range: 2000");
  await readInPages({
    fetchPage,
    from: 0n,
    to: 9_999n,
    pageSize: rangeLimitFrom(refusal),
  });
  assert.equal(asked.length, 5, "five pages of 2000, no wasted refusals");
});

test("an error that is not about the range stops the read and is the caller's to see", async () => {
  const fetchPage = async () => {
    throw new Error("rpc http 503");
  };
  await assert.rejects(
    readInPages({ fetchPage, from: 0n, to: 100_000n }),
    /rpc http 503/,
  );
});

test("a node that refuses every size ends in its own error, not a loop", async () => {
  let calls = 0;
  const fetchPage = async () => {
    calls += 1;
    throw new Error("exceed maximum block range: 5");
  };
  await assert.rejects(
    readInPages({ fetchPage, from: 0n, to: 100_000n }),
    /exceed maximum/,
  );
  assert.ok(calls < 40, `gave up after ${calls} requests`);
});

test("a history too wide to read is refused with what to set, after a bounded number of requests", async () => {
  let calls = 0;
  const fetchPage = async () => {
    calls += 1;
    return [];
  };
  await assert.rejects(
    readInPages({ fetchPage, from: 0n, to: 11_900_000n, pageSize: 50_000n }),
    (error) =>
      error instanceof HistoryTooWideError &&
      // The person is told what to do in plain words; the setting is for whoever runs the site (the error report).
      !/VITE_|eth_getLogs|\d{4,}/.test(error.message) &&
      /organiser/.test(error.message) &&
      /VITE_HISTORY_FROM_BLOCKS/.test(error.detail) &&
      /0 to 11900000/.test(error.detail),
  );
  assert.equal(calls, MAX_PAGES);
});

test("a node that is asked too often is busy, not narrow: its refusal is never read as a range limit", () => {
  for (const words of [
    "rate limit exceeded",
    "daily request count exceeded, request rate limited",
    "429 Too Many Requests",
    "Your app has exceeded its compute units per second capacity",
    "project ID request rate exceeded",
  ]) {
    assert.equal(isRateLimitError(new Error(words)), true, words);
    assert.equal(isRangeLimitError(new Error(words)), false, words);
  }
  // Range refusals that say "exceed" are still range refusals.
  assert.equal(
    isRangeLimitError(new Error("exceed maximum block range: 50000")),
    true,
  );
  assert.equal(
    isRangeLimitError(new Error("block range exceeds the limit of 2000")),
    true,
  );
  assert.equal(
    isRateLimitError(new Error("exceed maximum block range: 50000")),
    false,
  );
});

test("a range refusal with words like capacity, quota or credits is a range refusal, not a busy node", () => {
  for (const words of [
    "Log response size exceeded the node's capacity: query a smaller block range",
    "query returned more than 10000 results, which is over this plan's quota",
    "block range too large for the credits of this request",
  ]) {
    assert.equal(isRateLimitError(new Error(words)), false, words);
    assert.equal(isRangeLimitError(new Error(words)), true, words);
  }
});

test("a busy node stops the paged read at once instead of being asked in smaller pieces", async () => {
  let calls = 0;
  const fetchPage = async () => {
    calls += 1;
    throw new Error("daily request count exceeded, request rate limited");
  };
  await assert.rejects(
    readInPages({ fetchPage, from: 0n, to: 100_000n, pageSize: 10_000n }),
    /request rate limited/,
  );
  assert.equal(calls, 1, "one request, not one per halving");
});

test("a limit named in thousands is read as blocks, and a cap on logs is not a block range", () => {
  const alchemy = new Error(
    "Log response size exceeded. You can make eth_getLogs requests with up to a 2K block range and no limit on the response size, or you can request any block range with a cap of 10K logs in the response.",
  );
  assert.equal(isRangeLimitError(alchemy), true);
  assert.equal(rangeLimitFrom(alchemy), 2000n);
  assert.equal(
    rangeLimitFrom(new Error("any block range with a cap of 10K logs")),
    null,
  );
});

test("starting where the chain's history starts keeps a long chain within the budget", async () => {
  const { fetchPage, asked } = node(50_000n, 1000n);
  const got = await readInPages({
    fetchPage,
    from: 11_900_000n,
    to: 11_960_000n,
    pageSize: 50_000n,
  });
  assert.deepEqual(got, everything(11_900_000n, 11_960_000n, 1000n));
  assert.equal(asked.length, 2);
});

test("an empty or backwards range reads nothing", async () => {
  const { fetchPage, asked } = node(100n);
  assert.deepEqual(await readInPages({ fetchPage, from: 10n, to: 9n }), []);
  assert.equal(asked.length, 0);
});
