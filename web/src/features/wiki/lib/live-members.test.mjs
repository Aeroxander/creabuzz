// Member directory for live co-editing: parsing kind:13534, caching, the
// refresh-on-miss rule and its rate bound, and fail-closed behaviour.
// Run with: node --experimental-strip-types --test src/features/wiki/lib/live-members.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import {
  KIND_NIP43_MEMBERSHIP_LIST,
  MEMBER_LIST_RETRY_DELAYS_MS,
  createMemberDirectory,
  loadMemberListWithRetry,
  membersFromEvent,
  newestMemberSet,
} from "./live-members.ts";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);

function clock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms) => {
      now += ms;
    },
  };
}

function source(...responses) {
  let calls = 0;
  const fetchMembers = async () => {
    const next = responses[Math.min(calls, responses.length - 1)];
    calls += 1;
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetchMembers, calls: () => calls };
}

test("members come from member and p tags, lowercased and validated", () => {
  const set = membersFromEvent({
    tags: [
      ["member", A.toUpperCase(), "owner"],
      ["p", B],
      ["member", "not-a-key"],
      ["e", C],
      ["member"],
    ],
  });
  assert.deepEqual([...set].sort(), [A, B]);
});

test("the newest kind:13534 event wins; none means no list", () => {
  const event = (created_at, ...keys) => ({
    kind: KIND_NIP43_MEMBERSHIP_LIST,
    created_at,
    tags: keys.map((key) => ["member", key]),
  });
  assert.deepEqual([...newestMemberSet([event(1, A), event(5, B)])], [B]);
  assert.equal(newestMemberSet([]), null);
  assert.equal(
    newestMemberSet([{ kind: 1, created_at: 9, tags: [["member", A]] }]),
    null,
  );
});

test("a listed member is recognised; the list is fetched once", async () => {
  const clk = clock();
  const src = source(new Set([A]));
  const directory = createMemberDirectory({ ...src, nowMs: clk.now });
  assert.equal(await directory.check(A), "member");
  assert.equal(await directory.check(A.toUpperCase()), "member");
  assert.equal(src.calls(), 1);
});

test("a miss refreshes once, so a member added since the last load is found", async () => {
  const clk = clock();
  const src = source(new Set([A]), new Set([A, B]));
  const directory = createMemberDirectory({ ...src, nowMs: clk.now });
  assert.equal(await directory.check(A), "member");
  clk.advance(11_000);
  assert.equal(await directory.check(B), "member");
  assert.equal(src.calls(), 2);
});

test("unknown signers cannot make this hit the relay per message", async () => {
  const clk = clock();
  const src = source(new Set([A]));
  const directory = createMemberDirectory({ ...src, nowMs: clk.now });
  await directory.check(A);
  const strangers = Array.from({ length: 50 }, (_, i) =>
    i.toString(16).padStart(64, "0"),
  );
  for (const stranger of strangers) {
    assert.equal(await directory.check(stranger), "not-member");
  }
  assert.equal(src.calls(), 1, "misses inside the minimum gap do not refetch");
  clk.advance(11_000);
  assert.equal(await directory.check(strangers[0]), "not-member");
  assert.equal(src.calls(), 2, "one refresh once the gap has passed");
});

test("concurrent checks share one fetch", async () => {
  const clk = clock();
  const src = source(new Set([A, B]));
  const directory = createMemberDirectory({ ...src, nowMs: clk.now });
  const verdicts = await Promise.all([
    directory.check(A),
    directory.check(B),
    directory.check(A),
  ]);
  assert.deepEqual(verdicts, ["member", "member", "member"]);
  assert.equal(src.calls(), 1);
});

test("the list is reloaded after its TTL", async () => {
  const clk = clock();
  const src = source(new Set([A]), new Set([B]));
  const directory = createMemberDirectory({
    ...src,
    nowMs: clk.now,
    ttlMs: 60_000,
  });
  assert.equal(await directory.check(A), "member");
  clk.advance(61_000);
  assert.equal(await directory.check(A), "not-member", "A was removed");
  assert.equal(await directory.check(B), "member");
});

test("no published list means unknown, never member (fail closed)", async () => {
  const src = source(null);
  const directory = createMemberDirectory({ ...src, nowMs: clock().now });
  assert.equal(await directory.check(A), "unknown");
  assert.equal(await directory.load(), "no-list");
});

test("a failed load reports an error and treats everyone as unknown", async () => {
  const src = source(new Error("offline"));
  const directory = createMemberDirectory({ ...src, nowMs: clock().now });
  assert.equal(await directory.load(), "error");
  assert.equal(await directory.check(A), "unknown");
});

test("a stale list is used briefly on failure, then discarded", async () => {
  const clk = clock();
  const src = source(new Set([A]), new Error("offline"));
  const directory = createMemberDirectory({
    ...src,
    nowMs: clk.now,
    ttlMs: 60_000,
    maxStaleMs: 600_000,
  });
  assert.equal(await directory.check(A), "member");
  clk.advance(120_000);
  assert.equal(await directory.check(A), "member", "stale but recent enough");
  clk.advance(700_000);
  assert.equal(await directory.check(A), "unknown", "too stale to trust");
});

test("loading retries a failure on a bounded schedule", async () => {
  const waits = [];
  const sleep = async (ms) => {
    waits.push(ms);
  };
  const flaky = source(new Error("x"), new Error("y"), new Set([A]));
  const directory = createMemberDirectory({
    ...flaky,
    nowMs: clock().now,
    missRefreshMinMs: 0,
  });
  assert.equal(await loadMemberListWithRetry(directory, { sleep }), "loaded");
  assert.deepEqual(waits, [...MEMBER_LIST_RETRY_DELAYS_MS]);

  waits.length = 0;
  const dead = createMemberDirectory({
    ...source(new Error("down")),
    nowMs: clock().now,
  });
  assert.equal(await loadMemberListWithRetry(dead, { sleep }), "error");
  assert.equal(waits.length, MEMBER_LIST_RETRY_DELAYS_MS.length);
});

test("an absent list is an answer, not a failure: it is not retried", async () => {
  const waits = [];
  const directory = createMemberDirectory({
    ...source(null),
    nowMs: clock().now,
  });
  const state = await loadMemberListWithRetry(directory, {
    sleep: async (ms) => waits.push(ms),
  });
  assert.equal(state, "no-list");
  assert.deepEqual(waits, []);
});

test("retrying stops when the caller goes away", async () => {
  let cancelled = false;
  const directory = createMemberDirectory({
    ...source(new Error("down")),
    nowMs: clock().now,
  });
  const state = await loadMemberListWithRetry(directory, {
    sleep: async () => {
      cancelled = true;
    },
    isCancelled: () => cancelled,
  });
  assert.equal(state, "error");
});
