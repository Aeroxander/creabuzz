import assert from "node:assert/strict";
import { test } from "node:test";

import {
  readRemovedLaunchIds,
  REMOVALS_MAX_PAGES,
  REMOVALS_PAGE,
} from "./launch-removals.ts";

const ME = "a".repeat(64);
let n = 0;
const deletion = (createdAt, tags) => ({
  id: (n++).toString(16).padStart(64, "0"),
  pubkey: ME,
  created_at: createdAt,
  kind: 5,
  tags,
  content: "",
  sig: "sig",
});

/** A relay that answers newest first, `limit` at a time, with `until` inclusive, as the real one does. */
function relay(events) {
  const asked = [];
  const sorted = [...events].sort((a, b) => b.created_at - a.created_at);
  return {
    asked,
    query: async (filter) => {
      asked.push(filter);
      return sorted
        .filter(
          (e) => filter.until === undefined || e.created_at <= filter.until,
        )
        .slice(0, filter.limit);
    },
  };
}

test("an old project removal is found even when newer deletions of other things fill a whole page", async () => {
  const removal = deletion(100, [["a", `37001:${ME}:docs-commons`]]);
  // Messages and posts deleted since: more than one page of them.
  const others = Array.from({ length: REMOVALS_PAGE + 20 }, (_, i) =>
    deletion(1_000 + i, [["e", "f".repeat(64)]]),
  );
  const fake = relay([removal, ...others]);
  assert.deepEqual(await readRemovedLaunchIds(ME, fake.query), [
    "docs-commons",
  ]);
  assert.equal(
    fake.asked.length,
    2,
    "it read on, older, until a page came back short",
  );
  assert.equal(fake.asked[1].until, 1_020);
});

test("one short page is the whole history: a single read", async () => {
  const fake = relay([deletion(5, [["a", `37001:${ME}:one`]])]);
  assert.deepEqual(await readRemovedLaunchIds(ME, fake.query), ["one"]);
  assert.equal(fake.asked.length, 1);
});

test("a history past the bound fails rather than answering with part of it", async () => {
  const many = Array.from(
    { length: REMOVALS_PAGE * REMOVALS_MAX_PAGES + 1 },
    (_, i) => deletion(i + 1, [["e", "f".repeat(64)]]),
  );
  await assert.rejects(
    readRemovedLaunchIds(ME, relay(many).query),
    /Too many of your deletions/,
  );
});
