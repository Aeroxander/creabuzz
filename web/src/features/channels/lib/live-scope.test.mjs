import assert from "node:assert/strict";
import test from "node:test";

import { liveFiltersFor } from "./live-scope.ts";

test("records kept in rooms or in none are followed once untied and once per room", () => {
  assert.deepEqual(liveFiltersFor({ kinds: [44011] }, ["a", "b"]), [
    { kinds: [44011] },
    { kinds: [44011], "#h": ["a"] },
    { kinds: [44011], "#h": ["b"] },
  ]);
  assert.deepEqual(liveFiltersFor({ kinds: [44011] }, []), [
    { kinds: [44011] },
  ]);
});
