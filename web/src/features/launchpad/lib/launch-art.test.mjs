import assert from "node:assert/strict";
import test from "node:test";

import { launchArt } from "./launch-art.ts";

test("the same launch always gets the same cover", () => {
  assert.equal(launchArt("nebula").background, launchArt("nebula").background);
});

test("different launches get different covers", () => {
  const seen = new Set(
    ["nebula", "aurora", "orbit", "ember", "tidal", "quartz"].map(
      (id) => launchArt(id).background,
    ),
  );
  assert.ok(seen.size >= 5, `expected variety, got ${seen.size}`);
});

test("an empty id still yields a usable cover", () => {
  assert.match(launchArt("").background, /gradient/);
});
