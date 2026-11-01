import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The community Tasks board in the pilot (a build without raises, `raisesOffered()` false): plain to-dos that may point
 * at a contributor project's work area, with no points. The mocked browser suite runs one ordinary build and cannot
 * switch that setting per test, so, as in `pilotGatesContract.test.mjs`, the components' source is the seam for the
 * gates that live in them. The rules themselves are tested on their own (`task-source.test.mjs`,
 * `task-part-of.test.mjs`, `raises-offered.test.mjs`).
 */

const source = (name) =>
  readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8").replace(
    /\s+/g,
    " ",
  );

test("a task's plan offers no reward, points note or claim without raises", () => {
  const panel = source("./TaskPlanningPanel.tsx");
  assert.match(panel, /const raises = raisesOffered\(\);/);
  assert.match(
    panel,
    /\{raises \? \( <label [^>]*>\s*<span [^>]*>Reward \(points\)/,
  );
  assert.match(panel, /\{raises \? \( <p [^>]*> Points show on your profile/);
  assert.match(panel, /const claimable = raises && item\.status === "done"/);
  // The reward is never rewritten from the pilot's form.
  assert.match(
    panel,
    /const nextReward = raises \? parseReward\(reward\) : item\.reward;/,
  );
});

test("Next up says nothing about points without raises", () => {
  const list = source("./NextUpList.tsx");
  assert.match(list, /\{raises && item\.reward !== null \? \(/);
});

test("ideas made into tasks offer no points, credit or claim without raises", () => {
  const ideas = source("./BoardIdeas.tsx");
  assert.match(ideas, /escalationPoints\(raises, reward, finder\)/);
  assert.match(ideas, /\{raises \? \( <> <label [^>]*> Reward \(points\)/);
  assert.match(
    ideas,
    /const credit = raises \? \(item\.source\?\.finderReward \?\? null\) : null;/,
  );
});

test("the planning hook refuses a points claim without raises", () => {
  const hook = source("../use-task-planning.ts");
  assert.match(hook, /if \(!raisesOffered\(\)\) \{ throw new Error\(/);
});

test("a task can be made part of a work area, and the pilot drops the payment links for it", () => {
  const board = source("./WorkBoard.tsx");
  assert.match(board, /<PartOfPicker /);
  // The new task's link is the choice only while it is still offered, and it resets with the title.
  assert.match(
    board,
    /const createPartOf = offeredPartOfKey\(partOfOptions\.choices, partOf\);/,
  );
  assert.match(board, /partOf: partOfFromKey\(createPartOf\)/);
  assert.match(board, /setTitle\(""\); setPartOf\(""\);/);
  assert.match(board, /<TaskPartOfPanel /);
  assert.match(
    board,
    /\{raises && selected\.type === "task" \? \( <TaskDeliveryPanel/,
  );
  const panel = source("./TaskPartOfPanel.tsx");
  assert.match(panel, /Finishing this task here awards nothing\./);
  assert.match(panel, /tab: "work"/);
});

test("the Work board carries a task's Part of link from its rows onto the item it shows", () => {
  // Rows are written and read by `lib/task-row.ts` (tested in `task-row.test.mjs`); the item mapping is the hook's.
  const hook = source("../use-work-board.ts");
  assert.match(hook, /const task = parseTask\(newest\);/);
  assert.match(
    hook,
    /partOf: task\.partOf \?\? null, creator: merged\.creator,/,
  );
  assert.match(hook, /const row = taskUpdateRow\(task, status, approver\);/);
  assert.match(hook, /publishTaskRow\( patchTask\(task, patch\),/);
});
