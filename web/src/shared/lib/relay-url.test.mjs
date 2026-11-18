import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeRelayWsUrl,
  relayWsUrl,
  setStoredRelayWsUrl,
} from "./relay-url.ts";

/**
 * A page served over https cannot open a plain ws:// socket to another host:
 * the browser blocks it as mixed content and the app shows "server did not
 * answer" forever. So the address picked for a bare host, and one saved
 * earlier, must follow the page.
 */

function stubPage(protocol, stored = null) {
  const store = new Map(stored === null ? [] : [["buzz.relayUrl", stored]]);
  globalThis.window = {
    location: { protocol, host: "app.example.com" },
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
    },
  };
  return store;
}

test("a bare host on an https page becomes wss://", () => {
  stubPage("https:");
  assert.equal(
    normalizeRelayWsUrl("relay.example.com"),
    "wss://relay.example.com",
  );
});

test("a bare host on an http page stays ws://", () => {
  stubPage("http:");
  assert.equal(
    normalizeRelayWsUrl("relay.example.com:3000"),
    "ws://relay.example.com:3000",
  );
});

test("a local server stays ws:// even on an https page", () => {
  stubPage("https:");
  assert.equal(normalizeRelayWsUrl("localhost:3000"), "ws://localhost:3000");
  assert.equal(normalizeRelayWsUrl("127.0.0.1:3000"), "ws://127.0.0.1:3000");
  assert.equal(normalizeRelayWsUrl("ws://[::1]:3000"), "ws://[::1]:3000");
});

test("an explicit wss:// is kept as typed", () => {
  stubPage("http:");
  assert.equal(
    normalizeRelayWsUrl(" wss://relay.example.com "),
    "wss://relay.example.com",
  );
});

test("a saved ws:// address on an https page is corrected and saved again", () => {
  const store = stubPage("https:", "ws://relay.example.com");
  assert.equal(relayWsUrl(), "wss://relay.example.com");
  assert.equal(store.get("buzz.relayUrl"), "wss://relay.example.com");
});

test("a saved ws:// address on an http page is kept", () => {
  const store = stubPage("http:", "ws://relay.example.com:3000");
  assert.equal(relayWsUrl(), "ws://relay.example.com:3000");
  assert.equal(store.get("buzz.relayUrl"), "ws://relay.example.com:3000");
});

test("a saved local ws:// address on an https page is kept", () => {
  stubPage("https:", "ws://localhost:3000");
  assert.equal(relayWsUrl(), "ws://localhost:3000");
});

test("setStoredRelayWsUrl still stores what it is given", () => {
  const store = stubPage("https:");
  setStoredRelayWsUrl("wss://relay.example.com");
  assert.equal(store.get("buzz.relayUrl"), "wss://relay.example.com");
});
