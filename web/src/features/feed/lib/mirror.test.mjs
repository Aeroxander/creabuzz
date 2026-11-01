import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_PUBLIC_RELAYS,
  forgetOldMirrorSetting,
  isMirrorable,
  KIND_NIP22_COMMENT,
  mirrorOffered,
  outboxRelays,
  parseRelayList,
  shouldMirror,
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

test("only a post or reply written with the box ticked is copied — never a vote or repost", () => {
  assert.equal(isMirrorable(ev(1)), true);
  assert.equal(isMirrorable(ev(KIND_NIP22_COMMENT)), true);
  // A vote or a repost is one tap with no box to tick: it stays on the community's server.
  assert.equal(isMirrorable(ev(7)), false);
  assert.equal(isMirrorable(ev(6)), false);
  // Founder updates and lists stay on the community relay.
  assert.equal(isMirrorable(ev(47003)), false);
  assert.equal(isMirrorable(ev(3)), false);
});

test("sharing is asked for one publish at a time, never remembered", () => {
  // The old sticky setting, left behind in a browser that ticked the box once. shouldMirror never reads storage; the
  // stub is here for forgetOldMirrorSetting. That publishFeedEvent does not read it either is guarded by the browser
  // spec "a post is copied to public relays only when its author ticks the box for that post" (feed.spec.ts).
  const store = new Map([["buzz.feed.mirror", "1"]]);
  const previous = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k),
  };
  try {
    assert.equal(shouldMirror(ev(1), undefined), false);
    assert.equal(shouldMirror(ev(1), false), false);
    assert.equal(shouldMirror(ev(1), true), true);
    // Ticked for a post, the next vote is still not copied.
    assert.equal(shouldMirror(ev(7, [["e", "aa"]]), true), false);
    forgetOldMirrorSetting();
    assert.equal(store.has("buzz.feed.mirror"), false);
  } finally {
    globalThis.localStorage = previous;
  }
});

test("the box is offered only on an open server, and never in the contributor-only build", () => {
  assert.equal(mirrorOffered({ raisesOffered: true, access: "open" }), true);
  assert.equal(
    mirrorOffered({ raisesOffered: true, access: "invite_only" }),
    false,
  );
  // A server that has not said who may join may be invite-only.
  assert.equal(mirrorOffered({ raisesOffered: true, access: null }), false);
  assert.equal(
    mirrorOffered({ raisesOffered: true, access: undefined }),
    false,
  );
  assert.equal(mirrorOffered({ raisesOffered: false, access: "open" }), false);
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
  assert.deepEqual(parseRelayList({ kind: 5, tags: [["r", "wss://x"]] }), []);
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
