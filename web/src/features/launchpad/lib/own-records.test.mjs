import assert from "node:assert/strict";
import test from "node:test";

import {
  newestOwnRecord,
  OWN_RECORDS_PAGE,
  readOwnLaunchIds,
  recordByIdFilter,
} from "./own-records.ts";

const ME = "a".repeat(64);
const OTHER = "b".repeat(64);
let n = 0;
const nextId = () => {
  n += 1;
  return n.toString(16).padStart(64, "0");
};
const record = (d, at, pubkey = ME, kind = 37001) => ({
  id: nextId(),
  pubkey,
  kind,
  created_at: at,
  tags: [["d", d]],
});

/** A server holding `events`: newest first, narrowed by author and kind, cut at the limit, as the real one answers. */
function server(events) {
  const asked = [];
  const query = async (filter) => {
    asked.push(filter);
    return events
      .filter(
        (e) =>
          filter.kinds.includes(e.kind) &&
          (!filter.authors || filter.authors.includes(e.pubkey)) &&
          (filter.until === undefined || e.created_at <= filter.until),
      )
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, filter.limit);
  };
  return { query, asked };
}

test("a founder's own project ids are read by author, however many other records the server holds", async () => {
  const { query, asked } = server([
    record("nebula", 10),
    record("comet", 20),
    record("theirs", 30, OTHER),
  ]);
  assert.deepEqual((await readOwnLaunchIds(ME, query)).sort(), [
    "comet",
    "nebula",
  ]);
  assert.deepEqual(asked[0], {
    kinds: [37001],
    authors: [ME],
    limit: OWN_RECORDS_PAGE,
  });
});

test("an older project behind a full page is still found: the read goes on until a short page", async () => {
  const events = [record("oldest", 1)];
  for (let i = 0; i < OWN_RECORDS_PAGE; i += 1)
    events.push(record(`p${i}`, 1000 + i));
  const { query, asked } = server(events);
  const ids = await readOwnLaunchIds(ME, query);
  assert.equal(ids.includes("oldest"), true);
  assert.equal(ids.length, OWN_RECORDS_PAGE + 1);
  assert.equal(asked.length, 2);
  assert.equal(asked[1].until, 1000);
});

test("a read that cannot reach the end fails instead of answering with part of the list", async () => {
  // A full page all in one second cannot be walked past.
  const stuck = [];
  for (let i = 0; i <= OWN_RECORDS_PAGE; i += 1) stuck.push(record(`p${i}`, 5));
  await assert.rejects(
    readOwnLaunchIds(ME, server(stuck).query),
    /Too many of your projects/,
  );
  // A server that fails is not "no projects".
  await assert.rejects(
    readOwnLaunchIds(ME, async () => {
      throw new Error("offline");
    }),
    /offline/,
  );
});

test("what a server sends back is checked: only the author's own records give ids", async () => {
  const ids = await readOwnLaunchIds(ME, async () => [
    record("mine", 1),
    record("theirs", 2, OTHER),
    record("not-a-project", 3, ME, 47003),
  ]);
  assert.deepEqual(ids, ["mine"]);
});

test("one project is looked up by id, and by author when the link names one", () => {
  assert.deepEqual(recordByIdFilter("nebula", ME), {
    kinds: [37001],
    authors: [ME],
    "#d": ["nebula"],
    limit: 50,
  });
  assert.equal("authors" in recordByIdFilter("nebula", undefined), false);
});

test("the record to build on is the author's own newest with that id, never someone else's", () => {
  const old = record("nebula", 10);
  const newer = record("nebula", 20);
  const events = [old, newer, record("nebula", 30, OTHER), record("comet", 40)];
  assert.equal(newestOwnRecord(events, ME, "nebula"), newer);
  assert.equal(newestOwnRecord(events, ME, "missing"), null);
  assert.equal(newestOwnRecord([], ME, "nebula"), null);
});
