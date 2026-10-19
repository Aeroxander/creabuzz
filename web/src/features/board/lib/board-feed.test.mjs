import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildFeed, hotScore, previewText, sortFeed } from "./board-feed.ts";

const ME = "m".repeat(64);
const ANN = "a".repeat(64);
const BOB = "b".repeat(64);
const NOW = 1_800_000_000;
const HOUR = 3600;

let n = 0;
const id = () => `f${String(++n).padStart(3, "0")}`.padEnd(64, "0");
const post = (board, at, title = "T", extra = {}) => ({
  id: extra.id ?? id(),
  pubkey: extra.author ?? ANN,
  kind: 45001,
  created_at: at,
  tags: [["h", board], ...(extra.tags ?? [])],
  content: `# ${title}\n\nbody`,
});
const vote = (voter, board, target, up = true, at = NOW) => ({
  id: id(),
  pubkey: voter,
  kind: 45002,
  created_at: at,
  tags: [
    ["h", board],
    ["e", target],
  ],
  content: up ? "+" : "-",
});
const comment = (board, root, at = NOW) => ({
  id: id(),
  pubkey: BOB,
  kind: 45003,
  created_at: at,
  tags: [
    ["h", board],
    ["e", root, "", "reply"],
  ],
  content: "yes",
});

const voters = (count) =>
  Array.from({ length: count }, (_, i) => i.toString(16).padStart(64, "c"));

describe("buildFeed", () => {
  it("keeps each post's board and drops posts on boards the reader cannot open", () => {
    const a = post("design", NOW - HOUR);
    const b = post("secret", NOW - HOUR);
    const feed = buildFeed([a, b], ME, new Set(["design"]));
    assert.deepEqual(
      feed.map((p) => [p.id, p.boardId]),
      [[a.id, "design"]],
    );
  });

  it("counts votes and replies across boards", () => {
    const a = post("design", NOW - HOUR);
    const b = post("music", NOW - HOUR);
    const feed = buildFeed(
      [
        a,
        b,
        vote(ME, "design", a.id),
        vote(BOB, "music", b.id, false),
        comment("music", b.id),
      ],
      ME,
      new Set(["design", "music"]),
    );
    const byId = new Map(feed.map((p) => [p.id, p]));
    assert.equal(byId.get(a.id).score, 1);
    assert.equal(byId.get(a.id).myVote, 1);
    assert.equal(byId.get(b.id).score, -1);
    assert.equal(byId.get(b.id).commentCount, 1);
  });
});

describe("sortFeed", () => {
  const boards = new Set(["x"]);

  it("Hot lets a well-voted post outrank a slightly newer quiet one", () => {
    const old = post("x", NOW - 3 * HOUR, "liked");
    const fresh = post("x", NOW - HOUR, "quiet");
    const events = [old, fresh, ...voters(20).map((v) => vote(v, "x", old.id))];
    const order = sortFeed(buildFeed(events, ME, boards), "hot", NOW).map(
      (p) => p.title,
    );
    assert.deepEqual(order, ["liked", "quiet"]);
  });

  it("Hot lets a new post overtake an old one with a few more votes", () => {
    const old = post("x", NOW - 48 * HOUR, "yesterday");
    const fresh = post("x", NOW - HOUR, "today");
    const events = [old, fresh, ...voters(5).map((v) => vote(v, "x", old.id))];
    const order = sortFeed(buildFeed(events, ME, boards), "hot", NOW).map(
      (p) => p.title,
    );
    assert.deepEqual(order, ["today", "yesterday"]);
  });

  it("Hot never ranks a decision post by votes", () => {
    const decision = post("x", NOW - HOUR, "decision", {
      tags: [
        ["t", "proposal"],
        ["t", `proposal:31337:0x${"ab".repeat(20)}:0x${"0f".repeat(32)}`],
      ],
    });
    const plain = post("x", NOW - HOUR, "plain", {
      id: decision.id.replace("f", "g"),
    });
    const feed = buildFeed(
      [decision, plain, ...voters(30).map((v) => vote(v, "x", decision.id))],
      ME,
      boards,
    );
    const hot = new Map(feed.map((p) => [p.title, hotScore(p, NOW)]));
    assert.equal(hot.get("decision"), hot.get("plain"));
    assert.deepEqual(
      sortFeed(feed, "top", NOW).map((p) => p.title),
      ["plain", "decision"],
    );
  });

  it("New is newest first and Top is highest score first", () => {
    const a = post("x", NOW - 3 * HOUR, "a");
    const b = post("x", NOW - 2 * HOUR, "b");
    const c = post("x", NOW - HOUR, "c");
    const events = [
      a,
      b,
      c,
      vote(BOB, "x", a.id),
      vote(ME, "x", a.id),
      vote(BOB, "x", b.id),
    ];
    const feed = buildFeed(events, ME, boards);
    assert.deepEqual(
      sortFeed(feed, "new", NOW).map((p) => p.title),
      ["c", "b", "a"],
    );
    assert.deepEqual(
      sortFeed(feed, "top", NOW).map((p) => p.title),
      ["a", "b", "c"],
    );
  });

  it("A downvoted post sinks below a quiet one of the same age", () => {
    const bad = post("x", NOW - HOUR, "bad");
    const meh = post("x", NOW - HOUR, "meh");
    const events = [
      bad,
      meh,
      ...voters(4).map((v) => vote(v, "x", bad.id, false)),
    ];
    assert.deepEqual(
      sortFeed(buildFeed(events, ME, boards), "hot", NOW).map((p) => p.title),
      ["meh", "bad"],
    );
  });
});

describe("previewText", () => {
  it("strips Markdown and cuts at a word", () => {
    assert.equal(
      previewText("**Bold** and [a link](https://x.y) and `code`"),
      "Bold and a link and code",
    );
    const long = previewText("word ".repeat(100), 30);
    assert.ok(long.endsWith("…"));
    assert.ok(long.length <= 31);
  });
});
