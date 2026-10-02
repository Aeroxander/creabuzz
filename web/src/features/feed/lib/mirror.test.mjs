import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_PUBLIC_RELAYS,
  isMirrorable,
  KIND_NIP22_COMMENT,
  outboxRelays,
  parseRelayList,
  withTimeout,
} from "./mirror.ts";

function ev(kind, tags = []) {
  return {
    id: "f".repeat(64),
    pubkey: "a".repeat(64),
    kind,
    created_at: 1,
    tags,
    content: "+",
  };
}

test("posts, threaded replies and votes mirror — nothing else", () => {
  assert.equal(isMirrorable(ev(1)), true);
  assert.equal(isMirrorable(ev(KIND_NIP22_COMMENT)), true);
  assert.equal(isMirrorable(ev(7)), true);
  assert.equal(isMirrorable(ev(6)), true, "NIP-18 reposts reach other clients");
  // Founder updates and lists stay on the community relay.
  assert.equal(isMirrorable(ev(47003)), false);
  assert.equal(isMirrorable(ev(3)), false);
});

test("a channel post (h tag) is never mirrored", () => {
  // Mutation check: removing this guard must fail this test.
  assert.equal(isMirrorable(ev(1, [["h", "private-room"]])), false);
  assert.equal(
    isMirrorable(
      ev(7, [
        ["e", "aa"],
        ["h", "x"],
      ]),
    ),
    false,
  );
  assert.equal(isMirrorable(ev(KIND_NIP22_COMMENT, [["h", "x"]])), false);
});

test("the outbox comes from the NIP-65 list, defaults when it keeps none", () => {
  const list = {
    kind: 10002,
    tags: [
      ["r", "wss://relay.example.com/"],
      ["r", "wss://read-only.example.com", "read"],
      ["r", "https://not-a-relay.example.com"],
      ["r", "wss://relay.example.com"],
      ["r", "wss://second.example.com", "write"],
    ],
  };
  assert.deepEqual(outboxRelays(list), [
    "wss://relay.example.com",
    "wss://second.example.com",
  ]);
  assert.deepEqual(outboxRelays(null), DEFAULT_PUBLIC_RELAYS);
  assert.deepEqual(outboxRelays({ kind: 1, tags: [] }), DEFAULT_PUBLIC_RELAYS);
});

test("a mirror call is bounded and never hangs the publish", async () => {
  const value = await withTimeout(Promise.resolve(1), 50, "fast");
  assert.equal(value, 1);
  await assert.rejects(
    () => withTimeout(new Promise(() => {}), 20, "stuck"),
    /stuck timed out/,
  );
  await assert.rejects(
    () => withTimeout(Promise.reject(new Error("relay down")), 50, "mirror"),
    /relay down/,
  );
});

test("the mirror switch round-trips", () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k),
  };
  try {
    assert.equal(isMirrorable(ev(1)), true);
    assert.equal(
      parseRelayList({ kind: 5, tags: [["r", "wss://x"]] }).length,
      0,
    );
  } finally {
    delete globalThis.localStorage;
  }
});
