import assert from "node:assert/strict";
import test from "node:test";

import { appointSuggestions } from "./board-moderation.ts";

test("someone reported or muted on the board is not suggested as a moderator", () => {
  const people = ["alice", "carol", "dan", "erin"];
  assert.deepEqual(
    appointSuggestions(people, {
      reported: ["carol"],
      muted: new Set(["dan"]),
    }),
    ["alice", "erin"],
  );
  // Nobody to leave out: the board's people as they come, at most the limit.
  assert.deepEqual(appointSuggestions(people, { reported: [], muted: [] }, 3), [
    "alice",
    "carol",
    "dan",
  ]);
  // The limit counts what is left, so leaving people out does not shorten the list needlessly.
  assert.deepEqual(
    appointSuggestions(people, { reported: ["alice"], muted: [] }, 3),
    ["carol", "dan", "erin"],
  );
});
