// Desktop → web deep-link `?action=` param handling.
//
// Contract: `bid`/`exit`/`claim` open their flows on load; anything else is
// ignored (forward compat — desktop may grow actions the web cannot open).
import assert from "node:assert/strict";
import test from "node:test";

import { parseLaunchAction } from "./deep-link.ts";

test("the three handoff actions parse", () => {
  assert.equal(parseLaunchAction("bid"), "bid");
  assert.equal(parseLaunchAction("exit"), "exit");
  assert.equal(parseLaunchAction("claim"), "claim");
});

test("unknown action values are ignored, never opened", () => {
  assert.equal(parseLaunchAction("ragequit"), null);
  assert.equal(parseLaunchAction("EXIT"), null, "matching is case-sensitive");
  assert.equal(parseLaunchAction(""), null);
  assert.equal(parseLaunchAction("bid;drop"), null);
});

test("non-string and missing values resolve to no flow", () => {
  assert.equal(parseLaunchAction(undefined), null);
  assert.equal(parseLaunchAction(null), null);
  assert.equal(parseLaunchAction(["exit"]), null);
  assert.equal(parseLaunchAction(1), null);
});
