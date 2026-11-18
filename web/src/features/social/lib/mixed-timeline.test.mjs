import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  boardEngagement,
  mixChronological,
  mixRanked,
} from "./mixed-timeline.ts";

const note = (id, at, extra = {}) => ({
  event: {
    id: id.padEnd(64, "0"),
    pubkey: "a".repeat(64),
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
const post = (id, at, score = 0, commentCount = 0, proposal = null) => ({
  id: id.padEnd(64, "0"),
  author: "b".repeat(64),
  createdAt: at,
  title: id,
  body: "",
  topics: [],
  proposal,
  score,
  myVote: 0,
  myVoteIds: [],
  commentCount,
  lastActivity: at,
  boardId: "board",
});
const keys = (list) =>
  list.map((item) =>
    item.kind === "note" ? item.row.event.content : item.post.title,
  );

describe("mixChronological", () => {
  it("puts notes and board posts in one newest-first list", () => {
    const out = mixChronological(
      [note("n1", 300), note("n2", 100)],
      [post("b1", 200)],
      true,
    );
    assert.deepEqual(keys(out), ["n1", "b1", "n2"]);
  });

  it("uses a repost's time for a reposted note", () => {
    const reposted = note("old", 50, {
      repostedBy: { pubkey: "c".repeat(64), at: 400 },
    });
    assert.deepEqual(
      keys(mixChronological([reposted], [post("b1", 200)], true)),
      ["old", "b1"],
    );
  });

  it("holds back board posts older than the oldest note read while more notes remain", () => {
    const rows = [note("n1", 300), note("n2", 200)];
    const posts = [post("new", 250), post("old", 100)];
    assert.deepEqual(keys(mixChronological(rows, posts, false)), [
      "n1",
      "new",
      "n2",
    ]);
    assert.deepEqual(keys(mixChronological(rows, posts, true)), [
      "n1",
      "new",
      "n2",
      "old",
    ]);
  });

  it("shows board posts alone when there are no notes", () => {
    assert.deepEqual(keys(mixChronological([], [post("b1", 1)], false)), [
      "b1",
    ]);
  });
});

describe("mixRanked", () => {
  it("orders both kinds by the shared score", () => {
    const out = mixRanked(
      [note("n1", 300)],
      [post("b1", 200, 10)],
      true,
      (item) => (item.kind === "note" ? 1 : boardEngagement(item.post)),
    );
    assert.deepEqual(keys(out), ["b1", "n1"]);
  });
});

describe("boardEngagement", () => {
  it("is votes plus half the replies, and never votes for a decision post", () => {
    assert.equal(boardEngagement(post("p", 1, 4, 2)), 5);
    assert.equal(boardEngagement(post("p", 1, 40, 2, { chainId: 1 })), 1);
  });
});
