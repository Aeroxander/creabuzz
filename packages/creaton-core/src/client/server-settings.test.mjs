import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyServerSettings,
  parseServerSettings,
  relaySignerFromInfo,
  serverSmartAccountLinks,
  smartAccountLinksFromInfo,
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

test("whether phone accounts' wallet links can be checked is a plain boolean, or nothing", () => {
  assert.equal(smartAccountLinksFromInfo({ smartAccountLinks: false }), false);
  assert.equal(smartAccountLinksFromInfo({ smartAccountLinks: true }), true);
  assert.equal(smartAccountLinksFromInfo({ smartAccountLinks: "false" }), null);
  assert.equal(smartAccountLinksFromInfo({}), null);
  assert.equal(smartAccountLinksFromInfo(null), null);
  applyServerSettings({ investing: true, smartAccountLinks: false });
  assert.equal(serverSmartAccountLinks(), false);
  applyServerSettings({ investing: true });
  assert.equal(serverSmartAccountLinks(), null);
});
