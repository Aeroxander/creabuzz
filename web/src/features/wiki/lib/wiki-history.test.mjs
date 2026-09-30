import assert from "node:assert/strict";
import test from "node:test";

import { buildHistory, excerpt, restorePayload } from "./wiki-history.ts";

const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);

function rev(id, pubkey, createdAt, content, tags = [["d", "home"]]) {
  return { id, pubkey, created_at: createdAt, kind: 44001, tags, content };
}

test("buildHistory lists a page's revisions newest first", () => {
  const history = buildHistory(
    [
      rev("e1", ALICE, 100, "first draft"),
      rev("e2", BOB, 300, "third pass"),
      rev("e3", ALICE, 200, "second pass"),
    ],
    "home",
  );
  assert.deepEqual(
    history.map((r) => [r.id, r.authorPubkey, r.createdAt]),
    [
      ["e2", BOB, 300],
      ["e3", ALICE, 200],
      ["e1", ALICE, 100],
    ],
  );
});

test("buildHistory only takes this page's revisions", () => {
  const history = buildHistory(
    [
      rev("e1", ALICE, 100, "home body"),
      rev("e2", ALICE, 150, "other body", [["d", "other"]]),
      {
        id: "e3",
        pubkey: ALICE,
        created_at: 160,
        kind: 1,
        tags: [],
        content: "",
      },
    ],
    "home",
  );
  assert.deepEqual(
    history.map((r) => r.id),
    ["e1"],
  );
});

test("buildHistory excludes correction suggestions", () => {
  const history = buildHistory(
    [
      rev("e1", ALICE, 100, "real revision"),
      rev("e2", BOB, 200, "a suggested fix", [
        ["d", "correction-for-home"],
        ["t", "correction-for:home"],
      ]),
    ],
    "home",
  );
  assert.deepEqual(
    history.map((r) => r.id),
    ["e1"],
  );
});

test("ties break deterministically to the greater event id", () => {
  const history = buildHistory(
    [rev("aaa", ALICE, 100, "x"), rev("zzz", ALICE, 100, "y")],
    "home",
  );
  assert.deepEqual(
    history.map((r) => r.id),
    ["zzz", "aaa"],
  );
});

test("a revision carries its author, time and excerpt", () => {
  const [r] = buildHistory(
    [rev("e1", BOB, 1234, "Line one\n\nLine two")],
    "home",
  );
  assert.equal(r.authorPubkey, BOB);
  assert.equal(r.createdAt, 1234);
  assert.equal(r.excerpt, "Line one Line two");
});

test("excerpt collapses whitespace, bounds length and ellipsises", () => {
  assert.equal(excerpt("a\n\n  b\tc"), "a b c");
  assert.equal(excerpt("short"), "short");
  const long = "x".repeat(200);
  const out = excerpt(long, 50);
  assert.equal(out.length, 51); // 50 chars + the ellipsis
  assert.ok(out.endsWith("…"));
});

// ── restore: publish as a NEW revision, never rewrite history ──────────────

test("restore republishes old content as a NEW revision under the same slug", () => {
  const [old] = buildHistory([rev("e1", ALICE, 100, "original")], "home");
  const payload = restorePayload(old, { now: 999, slug: "home" });

  // New timestamp — NOT the historical event's. Restoring mints a fresh
  // revision; it does not rewrite the old one.
  assert.equal(payload.created_at, 999);
  assert.notEqual(payload.created_at, old.createdAt);

  // Same `d` slug (the page's address) and the old content, verbatim.
  assert.deepEqual(payload.tags, [["d", "home"]]);
  assert.equal(payload.content, "original");
  assert.equal(payload.kind, 44001);
});

test("restore is falsifiable: rewriting history would reuse the old timestamp", () => {
  // The guard: `created_at` must be the caller's `now`, never the revision's
  // own `createdAt`. If `restorePayload` were mutated to "rewrite the existing
  // revision" (created_at = revision.createdAt), this assertion fails.
  const [old] = buildHistory([rev("e1", ALICE, 100, "v1")], "home");
  const later = restorePayload(old, { now: 500, slug: "home" });
  assert.equal(later.created_at, 500);
  assert.notEqual(later.created_at, old.createdAt);
});

test("restore preserves the page's team scope so permissions do not drift", () => {
  const [old] = buildHistory(
    [
      rev("e1", ALICE, 100, "scoped body", [
        ["d", "home"],
        ["t", "team:design"],
      ]),
    ],
    "home",
  );
  assert.equal(old.scope, "design");
  const payload = restorePayload(old, { now: 200, slug: "home" });
  assert.deepEqual(payload.tags, [
    ["d", "home"],
    ["t", "team:design"],
  ]);
});
