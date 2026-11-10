import test from "node:test";
import assert from "node:assert/strict";

import {
  RAIL_LIMITS,
  railBlurb,
  railHelpCandidates,
  railPostIds,
  railPosts,
  railProjects,
} from "./rail.ts";

function launch(id, createdAt, over = {}) {
  return {
    receipts: over.receipts ?? [],
    record: {
      id,
      author: "a".repeat(64),
      name: `Project ${id}`,
      pitch: "",
      createdAt,
      stage: "live",
      auction: "0xabc",
      token: null,
      requiredRaised: "100",
      floorPrice: "1",
      ...over,
    },
  };
}

const ids = (list) => list.map((l) => l.record.id);

test("projects come newest first and stop at the limit", () => {
  const all = [1, 2, 3, 4, 5, 6].map((n) => launch(`p${n}`, n * 10));
  const shown = railProjects(all, true);
  assert.equal(shown.length, RAIL_LIMITS.projects);
  assert.deepEqual(ids(shown), ["p6", "p5", "p4", "p3"]);
});

test("the input list is left in its own order", () => {
  const all = [launch("old", 1), launch("new", 9)];
  railProjects(all, true);
  assert.deepEqual(ids(all), ["old", "new"]);
});

test("a sale still being set up and a failed project are not offered", () => {
  const all = [
    launch("draft", 50, { stage: "draft" }),
    launch("failed", 40, { stage: "failed" }),
    launch("review", 30, { stage: "review" }),
    launch("graduated", 20, { stage: "graduated" }),
  ];
  assert.deepEqual(ids(railProjects(all, true)), ["review", "graduated"]);
});

test("projects made in the same second keep one steady order", () => {
  const all = [launch("b", 5), launch("a", 5), launch("c", 5)];
  assert.deepEqual(ids(railProjects(all, true)), ["a", "b", "c"]);
});

test("a contributor-only build leaves out a raise but keeps an idea", () => {
  const raise = launch("raise", 30);
  const idea = launch("idea", 20, {
    auction: null,
    token: null,
    requiredRaised: null,
    floorPrice: null,
    stage: "draft",
  });
  // A project with no sale terms (the short form makes one) is listed in every build, as in Discover.
  assert.deepEqual(ids(railProjects([raise, idea], true)), ["raise", "idea"]);
  assert.deepEqual(ids(railProjects([raise, idea], false)), ["idea"]);
});

test("a project its founder marked not listed yet is not offered, nor is its request for help", () => {
  const bare = {
    auction: null,
    token: null,
    requiredRaised: null,
    floorPrice: null,
    stage: "draft",
  };
  const shown = launch("shown", 20, bare);
  const hidden = launch("hidden", 30, { ...bare, listing: "unlisted" });
  for (const raises of [true, false])
    assert.deepEqual(ids(railProjects([shown, hidden], raises)), ["shown"]);
});

test("a project whose sale failed or that graduated is read from its receipts", () => {
  const failed = launch("failed", 40, {
    stage: "live",
    receipts: [{ table: "failed" }],
  });
  const graduated = launch("graduated", 30, {
    receipts: [{ table: "summon" }],
  });
  assert.deepEqual(ids(railProjects([failed, graduated], true)), ["graduated"]);
});

test("nothing to list gives an empty list, not a failure", () => {
  assert.deepEqual(railProjects([], true), []);
});

test("a blurb is the first line of words, without links or mention keys", () => {
  assert.equal(
    railBlurb("https://example.com/a.png\n\nHello world\nsecond line"),
    "Hello world",
  );
  assert.equal(railBlurb("hi nostr:npub1abcdef there"), "hi there");
});

test("a long blurb is cut at a word and ends with an ellipsis", () => {
  const text = "word ".repeat(60);
  const blurb = railBlurb(text, 30);
  assert.ok(blurb.endsWith("…"));
  assert.ok(blurb.length <= 31);
  assert.ok(!blurb.slice(0, -1).endsWith(" "));
});

test("a post with only a link has no blurb", () => {
  assert.equal(railBlurb("https://example.com/x"), "");
});

const post = (id, pubkey) => ({ event: { id, pubkey } });

test("the rail reads only a handful of trending posts, not the whole list", () => {
  const thirty = Array.from({ length: 30 }, (_, n) => `id${n}`);
  const read = railPostIds(thirty);
  assert.equal(read.length, RAIL_LIMITS.postsRead);
  assert.ok(RAIL_LIMITS.postsRead < thirty.length);
  assert.deepEqual(read, thirty.slice(0, RAIL_LIMITS.postsRead));
  assert.deepEqual(railPostIds(undefined), []);
});

test("a muted person's trending post is left out and the next one takes its place", () => {
  const rows = ["m", "a", "b", "c", "d"].map((who, n) =>
    post(`p${n}`, who.repeat(64).slice(0, 64)),
  );
  const muted = new Set(["m".repeat(64)]);
  const shown = railPosts(rows, muted);
  assert.deepEqual(
    shown.map((row) => row.event.id),
    ["p1", "p2", "p3"],
  );
  assert.equal(railPosts(rows, new Set()).length, RAIL_LIMITS.posts);
});

test("a mute matches a key whatever its letter case", () => {
  const rows = [post("p0", "ABCDEF".padEnd(64, "0"))];
  assert.deepEqual(railPosts(rows, new Set(["abcdef".padEnd(64, "0")])), []);
});

test("requests for help the rail may show come from listed projects only, newest first, up to the limit", () => {
  const author = "a".repeat(64);
  const asking = (id, at, over = {}) => ({
    ...launch(id, at, { team: [], ...over }),
    updates: [
      {
        id: `${id}-update`,
        author,
        createdAt: at,
        title: "Week",
        help: { text: `Help ${id}`, size: "small", time: "" },
      },
    ],
  });
  const all = [
    asking("p1", 10),
    asking("p2", 20),
    asking("p3", 30),
    // A failed project is over: Discover does not list it, so its request is not offered.
    asking("gone", 50, { stage: "failed" }),
    { ...launch("silent", 60, { team: [] }), updates: [] },
  ];
  assert.deepEqual(
    railHelpCandidates(all, true).map((r) => r.ask.text),
    ["Help p3", "Help p2", "Help p1"],
  );
  assert.equal(railHelpCandidates(all, true, 2).length, 2);
  // More are checked than are shown, so a few closed ones do not empty the list.
  assert.ok(RAIL_LIMITS.helpCandidates > RAIL_LIMITS.helpRequests);
});
