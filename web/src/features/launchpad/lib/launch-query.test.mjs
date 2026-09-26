import assert from "node:assert/strict";
import test from "node:test";

import { launchQueryFilter, LAUNCH_QUERY_LIMIT } from "./launch-query.ts";
import {
  KIND_LAUNCH_RECORD,
  LAUNCHPAD_EVENT_KINDS,
} from "../../../shared/constants/kinds.ts";

/**
 * The launchpad directory query's shape, as the relay sees it.
 *
 * Two separate questions, both answered here: does the filter name its kinds
 * (the relay's p-gate refuses kindless filters), and is the wait bounded?
 */

test("the launch query is explicit-kinded — no kindless filter reaches the p-gate", () => {
  const filter = launchQueryFilter();
  assert.ok(
    Array.isArray(filter.kinds) && filter.kinds.length > 0,
    "kinds must be explicit",
  );
  assert.deepEqual(filter.kinds, [...LAUNCHPAD_EVENT_KINDS]);
  assert.ok(filter.kinds.includes(KIND_LAUNCH_RECORD));
  for (const kind of filter.kinds) {
    assert.equal(typeof kind, "number", "every kind must be a number");
  }
  // Identity-scoped fields would drag the read through the p-gate for no
  // reason: the directory is a global read.
  assert.equal(filter["#p"], undefined);
});

test("the launch query is bounded", () => {
  const filter = launchQueryFilter();
  assert.equal(filter.limit, LAUNCH_QUERY_LIMIT);
  assert.ok(filter.limit > 0 && filter.limit <= 500, "limit must stay bounded");
});
