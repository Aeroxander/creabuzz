import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { authorScore } from "./author-score.ts";

const ME = "a".repeat(64);
let n = 0;
const vote = (pubkey, target, content, at = 10, kind = 7) => ({
  id: String(++n).padStart(64, "0"),
  pubkey,
  kind,
  created_at: at,
  tags: [["e", target]],
  content,
});

describe("authorScore", () => {
  it("adds up votes on short posts and board posts, newest vote per person, none of the author's own", () => {
    const posts = new Set(["note", "board"]);
    const score = authorScore(ME, posts, [
      vote("b".repeat(64), "note", "+"),
      vote("c".repeat(64), "note", "+", 10),
      vote("c".repeat(64), "note", "-", 20),
      vote("d".repeat(64), "board", "+", 10, 45002),
      vote(ME, "note", "+"),
      vote("e".repeat(64), "someone-elses", "+"),
    ]);
    assert.equal(score, 1);
  });
});
