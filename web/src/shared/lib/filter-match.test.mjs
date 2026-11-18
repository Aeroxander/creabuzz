import assert from "node:assert/strict";
import test from "node:test";

import { eventMatchesFilter } from "./filter-match.ts";

const event = {
  id: "1".repeat(64),
  pubkey: "2".repeat(64),
  kind: 1,
  created_at: 100,
  tags: [
    ["e", "a".repeat(64), "", "root"],
    ["t", "art"],
  ],
  content: "",
  sig: "s",
};

test("an empty filter holds every event", () => {
  assert.equal(eventMatchesFilter({}, event), true);
});

test("each field narrows, and all of them together must hold", () => {
  const holds = (filter) => eventMatchesFilter(filter, event);
  assert.equal(holds({ ids: [event.id] }), true);
  assert.equal(holds({ ids: ["3".repeat(64)] }), false);
  assert.equal(holds({ authors: [event.pubkey] }), true);
  assert.equal(holds({ authors: ["3".repeat(64)] }), false);
  assert.equal(holds({ kinds: [1, 6] }), true);
  assert.equal(holds({ kinds: [6] }), false);
  assert.equal(holds({ since: 100, until: 100 }), true);
  assert.equal(holds({ since: 101 }), false);
  assert.equal(holds({ until: 99 }), false);
  assert.equal(holds({ "#e": ["a".repeat(64)] }), true);
  assert.equal(holds({ "#e": ["b".repeat(64)] }), false);
  assert.equal(holds({ "#p": ["a".repeat(64)] }), false);
  assert.equal(holds({ kinds: [1], "#t": ["art"] }), true);
  assert.equal(holds({ kinds: [1], "#t": ["music"] }), false);
});
