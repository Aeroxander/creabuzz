import assert from "node:assert/strict";
import test from "node:test";

import { KIND_LAUNCH_RECORD } from "../../../shared/constants/kinds.ts";
import { START_CATEGORIES } from "../../launchpad/lib/categories.ts";
import { categoryChips, chipQuery, chipSlug } from "./category-chips.ts";

const ids = (chips) => chips.map((chip) => chip.id);

test("the fixed set always shows, with 'AI agent or tool', even when no project carries a topic", () => {
  const chips = categoryChips([]);
  assert.deepEqual(
    chips.map((chip) => chip.label).sort(),
    [...START_CATEGORIES].sort(),
  );
  assert.ok(ids(chips).includes("ai agent or tool"));
  // "Other" is last, and Start's order is kept for the rest.
  assert.equal(ids(chips).at(-1), "other");
  assert.deepEqual(ids(chips).slice(0, 4), [
    "software",
    "ai agent or tool",
    "creative",
    "community",
  ]);
});

test("a topic found on projects that no chip lists is added once, sorted, before 'Other'", () => {
  const chips = categoryChips(["Games", "design", "games", "software", " "]);
  assert.deepEqual(ids(chips), [
    "software",
    "ai agent or tool",
    "creative",
    "community",
    "design",
    "games",
    "other",
  ]);
  assert.equal(chips.find((chip) => chip.id === "games").label, "Games");
});

test("the older 'AI agents' topic is listed under 'AI agent or tool', not as a second chip", () => {
  const chips = categoryChips(["ai agents", "ai agent or tool"]);
  assert.equal(chips.filter((chip) => /ai agent/.test(chip.id)).length, 1);
  const chip = chips.find((entry) => entry.id === "ai agent or tool");
  assert.deepEqual([...chip.topics], ["ai agent or tool", "ai agents"]);
});

test("a chip's query is bounded, names its kinds, and asks for every topic the chip lists", () => {
  const chip = categoryChips([]).find(
    (entry) => entry.id === "ai agent or tool",
  );
  assert.deepEqual(chipQuery(chip, 500), {
    kinds: [KIND_LAUNCH_RECORD],
    limit: 24,
    "#t": ["ai agent or tool", "ai agents"],
    until: 500,
  });
  assert.equal(chipQuery(chip, null).until, undefined);
});

test("a chip's test id is readable", () => {
  const chip = categoryChips([]).find(
    (entry) => entry.id === "ai agent or tool",
  );
  assert.equal(chipSlug(chip), "ai-agent-or-tool");
});
