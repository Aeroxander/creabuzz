import assert from "node:assert/strict";
import test from "node:test";

import { remixesOffered } from "./remixes-offered.ts";

test("the hosted contributor-only build shows no remix fields or card", () => {
  assert.equal(remixesOffered({ VITE_CONTRIBUTOR_ONLY: "1" }), false);
  assert.equal(remixesOffered({}), true);
  assert.equal(remixesOffered({ VITE_CONTRIBUTOR_ONLY: "0" }), true);
});
