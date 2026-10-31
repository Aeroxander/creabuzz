import assert from "node:assert/strict";
import { test } from "node:test";

import { portfolioInNav, portfolioLabel } from "./portfolio-label.ts";

test("a build with raises keeps Portfolio, for everyone", () => {
  assert.equal(portfolioLabel(true), "Portfolio");
  assert.equal(portfolioInNav(true, false), true);
  assert.equal(portfolioInNav(true, true), true);
});

test("a contributor-only build calls it Your work and shows it only to people with an account", () => {
  assert.equal(portfolioLabel(false), "Your work");
  assert.equal(portfolioInNav(false, false), false);
  assert.equal(portfolioInNav(false, true), true);
});
