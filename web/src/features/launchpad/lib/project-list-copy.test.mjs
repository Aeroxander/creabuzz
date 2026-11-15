import assert from "node:assert/strict";
import { test } from "node:test";

import {
  listingToggleLabel,
  listLink,
  openCardLabel,
} from "./project-list-copy.ts";

test("a build with no sales sends every project's back link to Projects, as the top bar calls it", () => {
  assert.deepEqual(listLink({ contributor: false, raises: false }), {
    to: "/discover",
    label: "Projects",
  });
  assert.deepEqual(listLink({ contributor: true, raises: true }), {
    to: "/discover",
    label: "Projects",
  });
});

test("only a sale in a build that offers sales goes back to the Launchpad", () => {
  assert.deepEqual(listLink({ contributor: false, raises: true }), {
    to: "/launchpad",
    label: "Launchpad",
  });
});

test("a card opens a project, and says View launch only for a sale", () => {
  assert.equal(
    openCardLabel({ contributor: false, raises: false }),
    "Open project",
  );
  assert.equal(
    openCardLabel({ contributor: true, raises: true }),
    "Open project",
  );
  assert.equal(
    openCardLabel({ contributor: false, raises: true }),
    "View launch",
  );
});

test("the listing button names the action, not the state the line above it already says", () => {
  assert.equal(listingToggleLabel(false), "Take it off the lists");
  assert.equal(listingToggleLabel(true), "List this project");
});
