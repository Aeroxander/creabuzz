import assert from "node:assert/strict";
import { test } from "node:test";

import { ideaToInput } from "./idea.ts";
import { LAUNCH_CATEGORIES } from "../models.ts";
import { START_CATEGORIES, startCategory } from "./categories.ts";

test("the fixed set is the five the Start row offers, in order", () => {
  assert.deepEqual(
    [...START_CATEGORIES],
    ["Software", "AI agent or tool", "Creative", "Community", "Other"],
  );
});

test("a value is one of the set or none; anything else is dropped", () => {
  assert.equal(startCategory("Creative"), "Creative");
  assert.equal(startCategory("  ai agent or tool "), "AI agent or tool");
  assert.equal(startCategory("Crypto"), "");
  assert.equal(startCategory(""), "");
  assert.equal(startCategory(null), "");
  assert.equal(startCategory(7), "");
});

test("each is a name the rest of the app already reads back with its capital letters", () => {
  // A topic tag is stored in lower case; `LAUNCH_CATEGORIES` is what puts the capitals back on a card and in Discover.
  for (const name of START_CATEGORIES)
    assert.ok(LAUNCH_CATEGORIES.includes(name), name);
});

test("a project with no category is still a valid record with no topic", () => {
  const chat = { team: null, supporters: null, backers: null, board: null };
  const without = ideaToInput({
    id: "old",
    name: "Old one",
    pitch: "Made before categories existed.",
    chat,
  });
  assert.equal("category" in without, false);
  const blank = ideaToInput({
    id: "old",
    name: "Old one",
    pitch: "Made before categories existed.",
    category: "",
    chat,
  });
  assert.equal("category" in blank, false);
  const chosen = ideaToInput({
    id: "new",
    name: "New one",
    pitch: "Made with a category chosen.",
    category: startCategory("AI agent or tool"),
    chat,
  });
  assert.equal(chosen.category, "AI agent or tool");
});
