import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { priorityMap, proposalPriority } from "./post-status.ts";

const live = { label: "Collecting support", tone: "open", live: true };
const over = { label: "Done", tone: "done", live: false };

describe("proposalPriority", () => {
  it("puts a decision that can still change before everything else", () => {
    const statuses = new Map([
      ["a", live],
      ["b", over],
    ]);
    assert.equal(proposalPriority("a", statuses), 0);
    assert.equal(proposalPriority("b", statuses), 1);
  });

  it("treats a post whose decision could not be read or checked as settled", () => {
    assert.equal(proposalPriority("unknown", new Map()), 1);
  });

  it("maps every post", () => {
    const map = priorityMap(["a", "b", "c"], new Map([["a", live]]));
    assert.deepEqual(
      [...map],
      [
        ["a", 0],
        ["b", 1],
        ["c", 1],
      ],
    );
  });
});
