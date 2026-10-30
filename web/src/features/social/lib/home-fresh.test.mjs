/**
 * Home's new posts and last visit (`home-fresh.ts`), and the quote card's answer for a quoted post (`timeline.ts`).
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  freshAt,
  freshLabel,
  freshOffered,
  freshSince,
  freshToShow,
  lastVisitAtLoad,
  lastVisitDivider,
  lastVisitKey,
  newestAt,
  nextFreshStart,
  notMuted,
  orderWithTop,
  readLastVisit,
  withFreshOnTop,
  writeLastVisit,
} from "./home-fresh.ts";
import { quotedPostState } from "./timeline.ts";

const ME = "e".repeat(64);
const ANN = "a".repeat(64);
const BOB = "b".repeat(64);
const MUTED = "c".repeat(64);
const BOARD = "board-1";

const row = (id, at, extra = {}) => ({
  event: {
    id: id.padEnd(64, "0"),
    pubkey: ANN,
    kind: 1,
    created_at: at,
    tags: [],
    content: id,
    sig: "s",
  },
  replyToId: null,
  rootId: null,
  ...extra,
});
const boardPost = (id, at, extra = {}) => ({
  id: id.padEnd(64, "0"),
  pubkey: BOB,
  kind: 45001,
  created_at: at,
  tags: [["h", BOARD]],
  content: `# ${id}`,
  ...extra,
});
const noteItem = (r) => ({
  kind: "note",
  key: `n:${r.event.id}:${r.repostedBy?.pubkey ?? ""}`,
  row: r,
  at: r.repostedBy?.at ?? r.event.created_at,
});
const boardItem = (id, at) => ({
  kind: "board",
  key: `b:${id.padEnd(64, "0")}`,
  post: { id: id.padEnd(64, "0"), author: BOB, createdAt: at },
  at,
});
const context = (shown = []) => ({
  shown,
  boards: new Set([BOARD]),
  muted: new Set([MUTED]),
  me: ME,
});

describe("new posts on Home", () => {
  it("checks from the newest shown of each kind, or from when Home was opened", () => {
    const shown = [noteItem(row("n1", 500)), boardItem("p1", 300)];
    assert.deepEqual(freshSince(shown, 900), { notes: 500, boards: 300 });
    assert.deepEqual(freshSince([], 900), { notes: 900, boards: 900 });
  });

  it("offers only what the reader would see and does not yet see, newest first", () => {
    const shownRow = row("old", 500);
    const fresh = freshToShow(
      {
        rows: [
          row("new1", 600),
          row("new2", 700),
          // Already shown (the same second as the newest shown, found again by the inclusive check).
          shownRow,
          // A reply is not a Home post.
          row("reply", 650, {
            replyToId: "x".repeat(64),
            rootId: "x".repeat(64),
          }),
          // The reader's own post shows as soon as it is accepted.
          row("mine", 660, {
            event: { ...row("mine", 660).event, pubkey: ME },
          }),
          // Muted: by them, or reposted by them.
          row("muted", 670, {
            event: { ...row("muted", 670).event, pubkey: MUTED },
          }),
          row("byMuted", 100, { repostedBy: { pubkey: MUTED, at: 680 } }),
          // A repost of a post already shown is not new.
          { ...shownRow, repostedBy: { pubkey: BOB, at: 690 } },
        ],
        boardPosts: [
          boardPost("b1", 650),
          boardPost("other-board", 660, { tags: [["h", "hidden-board"]] }),
          boardPost("b-muted", 670, { pubkey: MUTED }),
          boardPost("b-shown", 300),
          boardPost("comment", 680, { kind: 45003 }),
        ],
        capped: false,
      },
      context([noteItem(shownRow), boardItem("b-shown", 300)]),
    );
    assert.deepEqual(
      fresh.rows.map((r) => r.event.content),
      ["new2", "new1"],
    );
    assert.deepEqual(
      fresh.boardPosts.map((p) => p.content),
      ["# b1"],
    );
    assert.equal(fresh.count, 3);
    assert.equal(freshLabel(fresh), "3 new posts");
    assert.equal(freshLabel({ count: 1, capped: false }), "1 new post");
    assert.equal(freshLabel({ count: 40, capped: true }), "Many new posts");
  });

  it("still offers Show when a full read returned only posts the reader is never offered", () => {
    const replies = Array.from({ length: 40 }, (_, i) =>
      row(`reply${i}`, 600 + i, {
        replyToId: "x".repeat(64),
        rootId: "x".repeat(64),
      }),
    );
    const fresh = freshToShow(
      { rows: replies, boardPosts: [], capped: true },
      context(),
    );
    assert.equal(fresh.count, 0);
    // Posts may be waiting below the ones read: Show (reading Home again from the top) is the only way to them.
    assert.equal(freshOffered(fresh), true);
    assert.equal(freshLabel(fresh), "Many new posts");
    assert.equal(freshOffered({ count: 0, capped: false }), false);
    assert.equal(freshOffered({ count: 2, capped: false }), true);
  });

  it("starts the next check past what was read and never offered, so replies do not fill every later read", () => {
    // Everything since 500 was read: only replies, the newest at 640.
    assert.equal(nextFreshStart(500, { newest: 640, capped: false }, []), 640);
    // A post on offer is found again by the next check: it starts at the oldest offered.
    assert.equal(
      nextFreshStart(500, { newest: 640, capped: false }, [620, 610]),
      610,
    );
    // A full read may have left posts unread below it: the start stays.
    assert.equal(nextFreshStart(500, { newest: 640, capped: true }, []), 500);
    // Nothing read, or only older: never back.
    assert.equal(nextFreshStart(500, { newest: null, capped: false }, []), 500);
    assert.equal(nextFreshStart(500, { newest: 400, capped: false }, []), 500);
    // A repost is read by when it was reposted.
    assert.equal(
      freshAt(row("r", 100, { repostedBy: { pubkey: BOB, at: 650 } })),
      650,
    );
  });

  it("leaves muted people's posts and reposts out of what the reader was shown", () => {
    const keep = notMuted(new Set([MUTED]));
    assert.equal(keep(noteItem(row("a", 1))), true);
    assert.equal(
      keep(
        noteItem(
          row("m", 1, { event: { ...row("m", 1).event, pubkey: MUTED } }),
        ),
      ),
      false,
    );
    assert.equal(
      keep(noteItem(row("r", 1, { repostedBy: { pubkey: MUTED, at: 2 } }))),
      false,
    );
    assert.equal(
      keep({ ...boardItem("p", 1), post: { author: MUTED } }),
      false,
    );
  });

  it("puts shown new posts on top and keeps the rest of the order as it was", () => {
    const top = withFreshOnTop([], ["n:c", "b:d"]);
    assert.deepEqual(top, ["n:c", "b:d"]);
    const again = withFreshOnTop(top, ["n:e", "n:c"]);
    assert.deepEqual(again, ["n:e", "n:c", "b:d"]);
    // The held order (ranked) is untouched below them, even when it was taken again with them in it.
    assert.deepEqual(orderWithTop(again, ["n:a", "n:c", "n:b"]), [
      "n:e",
      "n:c",
      "b:d",
      "n:a",
      "n:b",
    ]);
  });
});

describe("last visit", () => {
  let store;
  const original = globalThis.localStorage;
  beforeEach(() => {
    store = new Map();
    globalThis.localStorage = {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
    };
  });
  afterEach(() => {
    globalThis.localStorage = original;
  });

  it("is kept per server and per account, only moves forward, and never past now", () => {
    assert.equal(readLastVisit("one.example", ME), null);
    writeLastVisit("one.example", ME, 500, 1000);
    writeLastVisit("one.example", ME, 400, 1000);
    assert.equal(readLastVisit("one.example", ME), 500);
    assert.equal(readLastVisit("two.example", ME), null);
    assert.equal(readLastVisit("one.example", ANN), null);
    // A post dated in the future stops at now.
    writeLastVisit("one.example", ME, 5000, 1000);
    assert.equal(readLastVisit("one.example", ME), 1000);
    assert.equal(store.get(lastVisitKey("one.example", ME)), "1000");
  });

  it("is read once per page load: what this visit stores does not move the line", () => {
    writeLastVisit("load.example", ME, 500, 1000);
    assert.equal(lastVisitAtLoad("load.example", ME), 500);
    writeLastVisit("load.example", ME, 900, 1000);
    assert.equal(lastVisitAtLoad("load.example", ME), 500);
    assert.equal(readLastVisit("load.example", ME), 900);
  });

  it("survives storage that refuses", () => {
    globalThis.localStorage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    assert.equal(readLastVisit("one.example", ME), null);
    assert.doesNotThrow(() => writeLastVisit("one.example", ME, 500, 1000));
  });

  it("draws the line above the first post the reader was shown before", () => {
    const items = [
      { key: "new2", at: 900 },
      { key: "new1", at: 800 },
      { key: "seen", at: 700 },
      { key: "older", at: 600 },
    ];
    assert.equal(lastVisitDivider(items, 700), "seen");
    assert.equal(lastVisitDivider(items, 750), "seen");
    // First visit, nothing new, or everything new: no line.
    assert.equal(lastVisitDivider(items, null), null);
    assert.equal(lastVisitDivider(items, 950), null);
    assert.equal(lastVisitDivider(items, 100), null);
    assert.equal(newestAt(items), 900);
    assert.equal(newestAt([]), null);
  });
});

describe("a quoted post", () => {
  it("says it was removed when the server answered without it", () => {
    assert.equal(
      quotedPostState({ found: false, isPending: false, isError: false }),
      "removed",
    );
    assert.equal(
      quotedPostState({ found: true, isPending: false, isError: false }),
      "shown",
    );
    assert.equal(
      quotedPostState({ found: false, isPending: true, isError: false }),
      "loading",
    );
    assert.equal(
      quotedPostState({ found: false, isPending: false, isError: true }),
      "unavailable",
    );
  });
});
