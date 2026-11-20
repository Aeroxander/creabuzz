import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyServerSettings,
  parseServerSettings,
  relaySignerFromInfo,
  serverSmartAccountLinks,
  serverWebPushKey,
  webPushKeyFromInfo,
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

/** A 65-byte uncompressed point in base64url with no padding, as the server's information document carries it. */
const pushKey = (first = 4, length = 65) =>
  Buffer.from([
    first,
    ...Array.from({ length: length - 1 }, (_, i) => i + 1),
  ]).toString("base64url");

test("the web push key is read only as an uncompressed 65-byte point in base64url, else push says nothing", () => {
  const good = pushKey();
  assert.equal(good.length, 87);
  assert.equal(webPushKeyFromInfo({ webPush: { publicKey: good } }), good);
  // Not a point (the first byte), not 65 bytes, padded, standard alphabet, not text, not an object.
  assert.equal(
    webPushKeyFromInfo({ webPush: { publicKey: pushKey(2) } }),
    null,
  );
  assert.equal(
    webPushKeyFromInfo({ webPush: { publicKey: pushKey(4, 33) } }),
    null,
  );
  assert.equal(
    webPushKeyFromInfo({ webPush: { publicKey: `${good}=` } }),
    null,
  );
  assert.equal(
    webPushKeyFromInfo({
      webPush: { publicKey: `${good.replace(/[-_]/g, "+")}+` },
    }),
    null,
  );
  assert.equal(webPushKeyFromInfo({ webPush: { publicKey: 7 } }), null);
  assert.equal(webPushKeyFromInfo({ webPush: good }), null);
  assert.equal(webPushKeyFromInfo({ webPush: [good] }), null);
  assert.equal(webPushKeyFromInfo({}), null);
  assert.equal(webPushKeyFromInfo(null), null);
});

test("applying a document keeps its web push key; a document without one forgets it", () => {
  const good = pushKey();
  applyServerSettings({ investing: true, webPush: { publicKey: good } });
  assert.equal(serverWebPushKey(), good);
  // Push is not part of the settings the web client compares.
  assert.deepEqual(
    parseServerSettings({ investing: true, webPush: { publicKey: good } }),
    {
      investing: true,
      trading: null,
    },
  );
  applyServerSettings({ investing: true });
  assert.equal(serverWebPushKey(), null);
  applyServerSettings(null);
  assert.equal(serverWebPushKey(), null);
});
