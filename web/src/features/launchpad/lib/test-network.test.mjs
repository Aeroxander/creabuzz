import assert from "node:assert/strict";
import test from "node:test";

import { testRecordsNotice } from "./test-network.ts";

test("a test network says its Shares are test records that will not move on their own", () => {
  assert.equal(
    testRecordsNotice(11155111),
    "Sepolia is a test network. Shares earned here are test records: they will not move to a real network automatically.",
  );
  // A launch record keeps its chain as text.
  assert.equal(testRecordsNotice("11155111"), testRecordsNotice(11155111));
  assert.match(testRecordsNotice(84532) ?? "", /^Base Sepolia is a test/);
  assert.match(testRecordsNotice(31337) ?? "", /^Local Anvil is a test/);
});

test("a real network, or one the app does not know, gets no test notice", () => {
  assert.equal(testRecordsNotice(1), null);
  assert.equal(testRecordsNotice(8453), null);
  // Unknown: it could be a real network, so nothing is claimed about it.
  assert.equal(testRecordsNotice(999), null);
  assert.equal(testRecordsNotice(""), null);
  assert.equal(testRecordsNotice(null), null);
  assert.equal(testRecordsNotice(undefined), null);
});
