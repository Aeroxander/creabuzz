import assert from "node:assert/strict";
import test from "node:test";

import {
  joinProjectPages,
  LAUNCH_QUERY_LIMIT,
  launchReportsFilter,
  launchUpdatesFilter,
  nextProjectPage,
  PROJECT_MAX_PAGES,
  PROJECT_PAGE_SIZE,
  projectListCut,
  projectPageFilter,
} from "./launch-query.ts";
import {
  KIND_LAUNCH_RECORD,
  KIND_LAUNCH_UPDATE,
} from "../../../shared/constants/kinds.ts";

/**
 * The shape of the reads behind the list of every project, as the server sees them, and the paging over project
 * records: does every filter name its kinds and a limit, are project records read alone, and does the paging end,
 * lose nothing signed in the same second, and say when it could not reach everything.
 */

const page = (count, at, prefix = "p") => ({
  events: Array.from({ length: count }, (_, i) => ({
    id: `${prefix}${at}-${i}`,
    created_at: typeof at === "function" ? at(i) : at,
  })),
});

test("project records are read on their own, a bounded page at a time", () => {
  const filter = projectPageFilter();
  assert.deepEqual(filter.kinds, [KIND_LAUNCH_RECORD]);
  assert.equal(filter.limit, PROJECT_PAGE_SIZE);
  assert.ok(filter.limit > 0 && filter.limit <= 500);
  assert.equal("until" in filter, false);
  assert.equal(projectPageFilter(1234).until, 1234);
  // Identity-scoped fields would drag the read through the p-gate for no reason: the list is a global read.
  assert.equal(filter["#p"], undefined);
});

test("what is recorded against projects is read apart from the projects, bounded and with its kinds named", () => {
  for (const filter of [launchUpdatesFilter(), launchReportsFilter()]) {
    assert.ok(Array.isArray(filter.kinds) && filter.kinds.length > 0);
    assert.equal(filter.kinds.includes(KIND_LAUNCH_RECORD), false);
    assert.equal(filter.limit, LAUNCH_QUERY_LIMIT);
    assert.ok(filter.limit <= 500);
  }
  // Updates share their kind with tasks and goals, so they never share a read with receipts.
  assert.deepEqual(launchUpdatesFilter().kinds, [KIND_LAUNCH_UPDATE]);
  assert.equal(launchReportsFilter().kinds.includes(KIND_LAUNCH_UPDATE), false);
});

test("a short page is the end: nothing more to ask for, and nothing cut", () => {
  const pages = [page(PROJECT_PAGE_SIZE - 1, 100)];
  assert.equal(nextProjectPage(pages), null);
  assert.equal(projectListCut(pages), false);
  assert.equal(nextProjectPage([]), null);
  assert.equal(projectListCut([]), false);
});

test("a full page asks on from its oldest second, inclusive, so same-second records are not lost", () => {
  const pages = [page(PROJECT_PAGE_SIZE, (i) => 1_000 - i)];
  assert.equal(nextProjectPage(pages), 1_000 - (PROJECT_PAGE_SIZE - 1));
  assert.equal(projectListCut(pages), false);
});

test("a full page that brings nothing new stops the paging and is said to be cut", () => {
  const same = page(PROJECT_PAGE_SIZE, 500);
  const pages = [same, same];
  assert.equal(nextProjectPage(pages), null);
  assert.equal(projectListCut(pages), true);
});

test("the page bound stops the paging and is said to be cut", () => {
  const pages = Array.from({ length: PROJECT_MAX_PAGES }, (_, n) =>
    page(PROJECT_PAGE_SIZE, (i) => 100_000 - n * 1_000 - i, `n${n}-`),
  );
  assert.notEqual(nextProjectPage(pages.slice(0, -1)), null);
  assert.equal(nextProjectPage(pages), null);
  assert.equal(projectListCut(pages), true);
});

test("pages join with each record once, in the order read", () => {
  const joined = joinProjectPages([
    { events: [{ id: "a" }, { id: "b" }] },
    { events: [{ id: "b" }, { id: "c" }] },
  ]);
  assert.deepEqual(
    joined.map((event) => event.id),
    ["a", "b", "c"],
  );
});
