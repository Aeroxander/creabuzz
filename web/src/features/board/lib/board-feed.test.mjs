import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildFeed, previewText } from "./board-feed.ts";

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

describe("withinPeriod", () => {
  it("keeps only posts inside the window, and everything for All time", async () => {
    const { withinPeriod } = await import("./board-feed.ts");
    const posts = [
      { id: "h", createdAt: NOW - HOUR },
      { id: "d3", createdAt: NOW - 3 * 24 * HOUR },
      { id: "d20", createdAt: NOW - 20 * 24 * HOUR },
      { id: "d90", createdAt: NOW - 90 * 24 * HOUR },
    ];
    const ids = (period) => withinPeriod(posts, period, NOW).map((p) => p.id);
    assert.deepEqual(ids("day"), ["h"]);
    assert.deepEqual(ids("week"), ["h", "d3"]);
    assert.deepEqual(ids("month"), ["h", "d3", "d20"]);
    assert.deepEqual(ids("all"), ["h", "d3", "d20", "d90"]);
  });
});

describe("postMedia", () => {
  it("finds the first picture and the first link, by site", async () => {
    const { postMedia } = await import("./board-feed.ts");
    assert.deepEqual(
      postMedia(
        "Look ![still](https://cdn.example/a.png) and read [the paper](https://www.arxiv.org/abs/1) or https://b.example/x",
      ),
      {
        image: "https://cdn.example/a.png",
        link: { url: "https://www.arxiv.org/abs/1", host: "arxiv.org" },
      },
    );
  });

  it("takes a bare image address as the picture, not the link", async () => {
    const { postMedia } = await import("./board-feed.ts");
    assert.deepEqual(
      postMedia("https://cdn.example/b.jpg?w=2 then https://site.example"),
      {
        image: "https://cdn.example/b.jpg?w=2",
        link: { url: "https://site.example/", host: "site.example" },
      },
    );
  });

  it("never offers a script or data address", async () => {
    const { postMedia } = await import("./board-feed.ts");
    assert.deepEqual(
      postMedia("![x](javascript:alert(1)) [y](data:text/html,hi) plain words"),
      { image: null, link: null },
    );
  });
});
