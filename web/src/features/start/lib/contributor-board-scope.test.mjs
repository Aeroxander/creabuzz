import assert from "node:assert/strict";
import test from "node:test";

import {
  assertJobCommunity,
  jobBoardScope,
  parseJob,
} from "./contributor-flow.ts";

const AUTHOR = "aa".repeat(32);
const base = {
  version: 3,
  author: AUTHOR,
  launchId: "demo",
  salt: "0x01",
  chainId: 31337,
  kit: "0xkit",
  expectedSummoner: null,
  founder: "0xf00",
  currency: "0xc0",
  draft: { projects: [] },
  dao: null,
  shares: null,
  createTx: null,
  recorded: false,
};

test("a job's board scope is its own community, founder and project", () => {
  const job = { ...base, relay: "wss://one.example" };
  assert.deepEqual(jobBoardScope(job, "wss://two.example"), {
    relay: "wss://one.example",
    founder: AUTHOR,
    launchId: "demo",
  });
});

test("a job kept before its community was recorded takes the one open now", () => {
  assert.equal(
    jobBoardScope(base, "wss://two.example").relay,
    "wss://two.example",
  );
});

test("the record step stops after a switch to another community", () => {
  const scope = jobBoardScope(
    { ...base, relay: "wss://one.example" },
    "wss://one.example",
  );
  assert.doesNotThrow(() => assertJobCommunity(scope, "wss://one.example"));
  assert.throws(
    () => assertJobCommunity(scope, "wss://two.example"),
    /started in another community/,
  );
});

test("a stored job keeps its community, and a malformed one is refused", () => {
  const relay = "wss://one.example";
  assert.equal(parseJob(JSON.stringify({ ...base, relay }))?.relay, relay);
  assert.equal(parseJob(JSON.stringify({ ...base, relay: 7 })), null);
  assert.equal(parseJob(JSON.stringify(base))?.relay, undefined);
});
