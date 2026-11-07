import assert from "node:assert/strict";
import test from "node:test";

import { plainNetworkName, testRecordsNotice } from "./test-network.ts";

test("a test network says its Shares are test records that will not move on their own", () => {
  assert.equal(
    testRecordsNotice(11155111),
    "Sepolia is a test network. Shares earned here are test records: they will not move to a real network automatically.",
  );
  // A launch record keeps its chain as text.
  assert.equal(testRecordsNotice("11155111"), testRecordsNotice(11155111));
  assert.match(testRecordsNotice(84532) ?? "", /^Base Sepolia is a test/);
  // A chain on this computer is never named by its tool.
  assert.match(testRecordsNotice(31337) ?? "", /^This is a test network\./);
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

test("a network is named in plain words: never by the local tool's name, never by a number", () => {
  assert.equal(plainNetworkName(31337), "the test network");
  assert.equal(plainNetworkName("11155111"), "Sepolia");
  assert.equal(plainNetworkName(8453), "Base");
  assert.equal(plainNetworkName(999), "another network");
  assert.equal(plainNetworkName(null), "another network");
});
