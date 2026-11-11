import assert from "node:assert/strict";
import { test } from "node:test";

import { portfolioInNav, portfolioLabel } from "./portfolio-label.ts";

test("the place is You in every build, and a build with raises shows it to everyone", () => {
  assert.equal(portfolioLabel(), "You");
  assert.equal(portfolioInNav(true, false), true);
  assert.equal(portfolioInNav(true, true), true);
});

test("a contributor-only build shows it only to people with an account", () => {
  assert.equal(portfolioInNav(false, false), false);
  assert.equal(portfolioInNav(false, true), true);
});
