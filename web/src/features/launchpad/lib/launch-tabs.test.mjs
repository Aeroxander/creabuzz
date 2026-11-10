import assert from "node:assert/strict";
import { test } from "node:test";

import {
  allowedTabs,
  founderSettings,
  ideaShowsTeamSurfaces,
  tabAlias,
  tabShown,
  updatesUse,
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

test("a visitor gets the updates, boards and helpers tabs only once the project uses them", () => {
  const visitor = (uses) => (tab) => tabShown(tab, { isFounder: false, uses });
  const unused = visitor({ updates: "no", boards: "no", agents: "no" });
  for (const tab of ["updates", "boards", "agents"])
    assert.equal(unused(tab), false, tab);
  const used = visitor({ updates: "yes", boards: "yes", agents: "yes" });
  for (const tab of ["updates", "boards", "agents"])
    assert.equal(used(tab), true, tab);
  // Everything else is not hidden by use: the overview, the talk, and what a project with Shares runs on.
  for (const tab of ["overview", "discussion", "work", "decisions", "treasury"])
    assert.equal(unused(tab), true, tab);
});

test("a read that failed, or has not answered, never takes a tab away", () => {
  for (const tab of ["updates", "boards", "agents"]) {
    assert.equal(
      tabShown(tab, { isFounder: false, uses: { [tab]: "unknown" } }),
      true,
      tab,
    );
    assert.equal(tabShown(tab, { isFounder: false, uses: {} }), true, tab);
  }
});

test("the founder always has every tab: an empty one is where they set it up", () => {
  const uses = { updates: "no", boards: "no", agents: "no" };
  for (const tab of ["updates", "boards", "agents", "manage"])
    assert.equal(tabShown(tab, { isFounder: true, uses }), true, tab);
});

test("the Updates tab follows the project's own read: hidden while reading, kept when the read failed or was cut", () => {
  // Not read yet: not shown for the moment (it appears when the answer comes).
  assert.equal(
    updatesUse({ count: null, failed: false, complete: false }),
    "no",
  );
  // The read failed: not known, so the tab stays.
  assert.equal(
    updatesUse({ count: null, failed: true, complete: false }),
    "unknown",
  );
  assert.equal(updatesUse({ count: 2, failed: false, complete: false }), "yes");
  assert.equal(updatesUse({ count: 0, failed: false, complete: true }), "no");
  // None found in a read that was cut short is not "none".
  assert.equal(
    updatesUse({ count: 0, failed: false, complete: false }),
    "unknown",
  );
});
