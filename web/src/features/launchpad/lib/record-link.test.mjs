import assert from "node:assert/strict";
import { test } from "node:test";

import { recordPath, recordUrl } from "./record-link.ts";

const AUTHOR = "ab".repeat(32);

test("the link names the launch, its author and the track record tab, and no DAO", () => {
  assert.equal(
    recordPath("nebula", AUTHOR),
    `/launchpad/nebula?author=${AUTHOR}&tab=record`,
  );
  assert.ok(!/0x[0-9a-f]{40}/i.test(recordPath("nebula", AUTHOR)));
});

test("a launch id with odd characters is escaped, and a missing author is left out", () => {
  assert.equal(recordPath("a b/c"), "/launchpad/a%20b%2Fc?tab=record");
});

test("the full address trims a trailing slash from the site", () => {
  assert.equal(
    recordUrl("nebula", undefined, "https://example.org/"),
    "https://example.org/launchpad/nebula?tab=record",
  );
});
