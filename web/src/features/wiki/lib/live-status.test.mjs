// What the editor says about live co-editing: unavailable versus available
// only to verified members.
// Run with: node --experimental-strip-types --test src/features/wiki/lib/live-status.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { PeerBook } from "./live-peers.ts";
import { describeLive } from "./live-status.ts";

const REASONS = [
  "no-identity",
  "no-member-list",
  "member-list-error",
  "not-member",
  "room-failed",
  "cannot-sign",
  "too-large",
];

test("verified: says live editing is for verified members only", () => {
  const alone = describeLive({ state: "verified" }, { peers: 0 });
  assert.equal(alone.chip, "Live: verified members only");
  assert.equal(alone.editors, "Editing alone");
  assert.match(alone.detail, /verified community members only/);
  assert.match(alone.detail, /saved/);

  const together = describeLive({ state: "verified" }, { peers: 2 });
  assert.equal(together.editors, "3 editing");
  assert.match(together.detail, /2 other verified members are connected/);
  assert.match(
    describeLive({ state: "verified" }, { peers: 1 }).detail,
    /1 other verified member is connected/,
  );
});

test("unavailable: says so, gives the reason, and the save fallback", () => {
  for (const reason of REASONS) {
    const text = describeLive({ state: "unavailable", reason }, { peers: 0 });
    assert.equal(text.chip, "Live co-editing unavailable", reason);
    assert.match(text.detail, /Live co-editing is unavailable/, reason);
    assert.match(text.detail, /saved/, reason);
    assert.doesNotMatch(text.chip, /verified/, reason);
  }
  const reasonsText = new Set(
    REASONS.map(
      (reason) =>
        describeLive({ state: "unavailable", reason }, { peers: 0 }).detail,
    ),
  );
  assert.equal(
    reasonsText.size,
    REASONS.length,
    "every reason reads differently",
  );
});

test("no member list and no identity are named explicitly", () => {
  assert.match(
    describeLive(
      { state: "unavailable", reason: "no-member-list" },
      { peers: 0 },
    ).detail,
    /publishes no member list/,
  );
  assert.match(
    describeLive({ state: "unavailable", reason: "no-identity" }, { peers: 0 })
      .detail,
    /signed-in identity/,
  );
});

test("connecting is neither claimed as verified nor as unavailable", () => {
  const text = describeLive({ state: "connecting" }, { peers: 0 });
  assert.equal(text.chip, "Live: connecting");
  assert.doesNotMatch(text.chip, /verified|unavailable/);
});

test("strangers and dropped updates are surfaced, not hidden", () => {
  const text = describeLive(
    { state: "verified" },
    { peers: 1, strangers: 2, rejected: 1 },
  );
  assert.match(
    text.detail,
    /2 unverified peers are in the room and receive nothing/,
  );
  assert.match(text.detail, /1 received update was ignored/);
  assert.doesNotMatch(
    describeLive({ state: "verified" }, { peers: 0 }).detail,
    /unverified|ignored/,
  );
});

test("PeerBook counts only verified peers and forgets them on leave", () => {
  const book = new PeerBook();
  assert.equal(book.markVerified("p1", "k1"), true);
  assert.equal(book.markVerified("p1", "k1"), false);
  assert.equal(book.markVerified("p2", "k2"), true);
  assert.equal(book.verifiedCount, 2);
  assert.deepEqual(book.verifiedPeerIds().sort(), ["p1", "p2"]);
  assert.equal(book.isVerified("p3"), false);
  book.leave("p1");
  assert.equal(book.isVerified("p1"), false);
  assert.equal(book.verifiedCount, 1);
  assert.equal(
    book.markVerified("p1", "k1"),
    true,
    "a rejoin is verified anew",
  );
});
