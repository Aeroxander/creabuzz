import assert from "node:assert/strict";
import { test } from "node:test";

import {
  allowedTabs,
  founderSettings,
  ideaShowsTeamSurfaces,
  tabAlias,
} from "./launch-tabs.ts";

test("an idea in a build without raises has no helpers tab, and keeps the rest", () => {
  const without = allowedTabs("idea", false);
  assert.equal(without?.has("agents"), false);
  for (const tab of ["overview", "discussion", "updates", "manage"]) {
    assert.equal(without?.has(tab), true, tab);
  }
  // A raise build keeps the helpers tab on an idea, as before.
  assert.equal(allowedTabs("idea", true)?.has("agents"), true);
});

test("an idea never shows money, decisions or proposals", () => {
  for (const raises of [true, false]) {
    const tabs = allowedTabs("idea", raises);
    for (const tab of [
      "treasury",
      "decisions",
      "work",
      "proposals",
      "mybids",
    ]) {
      assert.equal(tabs?.has(tab), false, `${tab} raises=${raises}`);
    }
  }
});

test("a contributor project shows the same tabs in every build, and no proposals", () => {
  assert.deepEqual(
    allowedTabs("contributor", true),
    allowedTabs("contributor", false),
  );
  assert.equal(allowedTabs("contributor", false)?.has("proposals"), false);
  assert.equal(allowedTabs("raise", true), null);
});

test("a link to the old proposals tab opens the decisions, for every kind of page", () => {
  for (const kind of ["idea", "contributor", "raise"]) {
    assert.equal(tabAlias("proposals", kind), "decisions");
  }
  assert.equal(tabAlias("record", "contributor"), "contributions");
  assert.equal(tabAlias("agents", "contributor"), "overview");
  assert.equal(tabAlias("record", "raise"), "record");
});

test("an idea's founder gets the small settings, not the sale checklist, where no sale can open", () => {
  assert.equal(founderSettings("idea", false), "settings");
  assert.equal(founderSettings("idea", true), "sale");
  assert.equal(founderSettings("contributor", true), "settings");
  assert.equal(founderSettings("contributor", false), "settings");
  assert.equal(founderSettings("raise", true), "sale");
});

test("an idea's overview leaves out the community work board where raises are not offered", () => {
  assert.equal(ideaShowsTeamSurfaces(false), false);
  assert.equal(ideaShowsTeamSurfaces(true), true);
});

test("every kind of project page keeps a Boards tab, in every build", () => {
  for (const kind of ["idea", "contributor"]) {
    for (const raises of [true, false]) {
      assert.equal(
        allowedTabs(kind, raises)?.has("boards"),
        true,
        `${kind} raises=${raises}`,
      );
    }
  }
  // A raise shows every tab the page has, Boards among them.
  assert.equal(allowedTabs("raise", true), null);
});
