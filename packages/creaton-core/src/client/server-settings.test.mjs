import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyServerSettings,
  parseServerSettings,
  relaySignerFromInfo,
  serverRelaySigner,
  serverTrading,
} from "./server-settings.ts";

const KEY = "a".repeat(64);

test("the server's own key is read from `self`, only as 64 lower-case hex", () => {
  assert.equal(relaySignerFromInfo({ self: KEY }), KEY);
  assert.equal(relaySignerFromInfo({ self: KEY.toUpperCase() }), null);
  assert.equal(relaySignerFromInfo({ self: "abc" }), null);
  assert.equal(relaySignerFromInfo({ self: 7 }), null);
  assert.equal(relaySignerFromInfo({}), null);
  assert.equal(relaySignerFromInfo(null), null);
  assert.equal(relaySignerFromInfo([KEY]), null);
});

test("applying a document keeps its key; a document without one forgets it", () => {
  applyServerSettings({ investing: true, self: KEY });
  assert.equal(serverRelaySigner(), KEY);
  applyServerSettings({ investing: true });
  assert.equal(serverRelaySigner(), null);
  applyServerSettings(null);
  assert.equal(serverRelaySigner(), null);
});

test("trading counts only as a plain boolean and is said nothing about by default", () => {
  assert.deepEqual(parseServerSettings({ investing: true }), {
    investing: true,
    trading: null,
  });
  assert.equal(parseServerSettings({ trading: "true" }).trading, null);
  assert.equal(parseServerSettings({ trading: 1 }).trading, null);
  applyServerSettings({ investing: true, trading: true });
  assert.equal(serverTrading(), true);
  applyServerSettings({ investing: true });
  assert.equal(serverTrading(), null);
  applyServerSettings(null);
  assert.equal(serverTrading(), null);
});
