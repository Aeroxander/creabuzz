import assert from "node:assert/strict";
import test from "node:test";

import { EVIDENCE_QUERY_LIMIT, evidenceQueryFilter } from "./evidence-query.ts";
import { KIND_LAUNCH_UPDATE } from "../../../shared/constants/kinds.ts";

test("a launch's evidence is asked for by its own coordinate, with explicit kinds and a bounded size", () => {
  const filter = evidenceQueryFilter("37001:abc:nebula");
  // The server refuses a filter with no kinds, and an unbounded read is a lever for whoever reads.
  assert.deepEqual(filter.kinds, [KIND_LAUNCH_UPDATE]);
  assert.deepEqual(filter["#a"], ["37001:abc:nebula"]);
  assert.equal(filter.limit, EVIDENCE_QUERY_LIMIT);
  assert.ok(EVIDENCE_QUERY_LIMIT > 0 && EVIDENCE_QUERY_LIMIT <= 1000);
});

test("it does not depend on the directory query, so it is not cut by what else the server holds", () => {
  // The directory filter names every launchpad kind with its own limit; this one names only the updates of one launch.
  const filter = evidenceQueryFilter("37001:abc:nebula");
  assert.equal(filter.kinds.length, 1);
  assert.equal(filter.authors, undefined);
});
