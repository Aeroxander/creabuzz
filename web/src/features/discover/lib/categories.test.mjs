import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCategoryQuery,
  CATEGORY_PAGE_SIZE,
  collectCategories,
  LAUNCH_ROUTING_TAG,
  nextPageCursor,
} from "./categories.ts";
import { KIND_LAUNCH_RECORD } from "../../../shared/constants/kinds.ts";

function ev(kind, tags, created_at = 10) {
  return { kind, created_at, tags };
}

test("the picker lists the distinct topics of launches", () => {
  const events = [
    ev(KIND_LAUNCH_RECORD, [
      ["t", "Design"],
      ["t", "design"],
      ["t", LAUNCH_ROUTING_TAG],
    ]),
    ev(KIND_LAUNCH_RECORD, [["t", "science"]]),
    ev(1, [["t", "ignored-note-topic"]]),
  ];
  assert.deepEqual(collectCategories(events), ["design", "science"]);
});

test("a category query is bounded, explicit and pageable", () => {
  const query = buildCategoryQuery({ category: "design", until: 500 });
  assert.deepEqual(query, {
    kinds: [KIND_LAUNCH_RECORD],
    limit: CATEGORY_PAGE_SIZE,
    "#t": ["design"],
    until: 500,
  });
  // No wildcard pulls: kinds are always named, the page size always set.
  const all = buildCategoryQuery({ category: null });
  assert.deepEqual(all, {
    kinds: [KIND_LAUNCH_RECORD],
    limit: CATEGORY_PAGE_SIZE,
  });
  assert.equal(all["#t"], undefined);
});

test("the next page continues just before the oldest event seen", () => {
  assert.equal(nextPageCursor([ev(1, [], 10), ev(1, [], 7), ev(1, [], 12)]), 6);
  assert.equal(nextPageCursor([]), null);
});
