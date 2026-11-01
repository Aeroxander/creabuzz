import assert from "node:assert/strict";
import test from "node:test";

import { idWord } from "@creaton/core/launchpad/work.ts";

import { mergeTaskRows } from "./task-planning.ts";
import {
  newTaskRow,
  parseTask,
  patchTask,
  taskRowTags,
  taskUpdateRow,
} from "./task-row.ts";

/**
 * A task row written by the same functions the hooks publish with (`publishNewTask`, the Work board's status and edit
 * rows), signed as an event, merged as the board merges rows, and read back by the parser every view uses.
 */

const FOUNDER = "a".repeat(64);
const project = `37001:${FOUNDER}:docs-project`;
const partOf = {
  project,
  mandate: `0x${"b".repeat(40)}`,
  area: idWord("first-hour-notes"),
};

let seq = 0;
const asEvent = ({ tags, body }, at, pubkey = FOUNDER) => {
  seq += 1;
  return {
    id: seq.toString(16).padStart(64, "0"),
    pubkey,
    created_at: at,
    kind: 44011,
    tags: taskRowTags(tags, body),
    content: JSON.stringify(body),
    sig: "",
  };
};

const readBack = (rows) => parseTask(mergeTaskRows(rows).event);

test("a new task's Part of link is written and read back", () => {
  const first = asEvent(
    newTaskRow({ title: "Write the notes", partOf }, "task-1"),
    100,
  );
  assert.ok(first.tags.some((t) => t[0] === "a" && t[1] === project));
  const task = readBack([first]);
  assert.deepEqual(task.partOf, partOf);
  assert.equal(task.title, "Write the notes");
  assert.equal(task.status, "open");
});

test("a status change and an unrelated edit keep the link; unlinking clears it", () => {
  const first = asEvent(
    newTaskRow({ title: "Write the notes", partOf }, "task-1"),
    100,
  );
  const created = readBack([first]);
  const started = asEvent(taskUpdateRow(created, "in_progress", null), 200);
  const afterStart = readBack([first, started]);
  assert.equal(afterStart.status, "in_progress");
  assert.deepEqual(afterStart.partOf, partOf);

  const edited = asEvent(
    taskUpdateRow(
      patchTask(afterStart, { title: "Write the first notes" }),
      "in_progress",
      null,
    ),
    300,
  );
  const afterEdit = readBack([first, started, edited]);
  assert.equal(afterEdit.title, "Write the first notes");
  assert.deepEqual(afterEdit.partOf, partOf);

  const unlinked = asEvent(
    taskUpdateRow(patchTask(afterEdit, { partOf: null }), "in_progress", null),
    400,
  );
  assert.equal(readBack([first, started, edited, unlinked]).partOf, null);
});

test("linking an existing task by an edit is written and read back", () => {
  const first = asEvent(newTaskRow({ title: "Tidy the docs" }, "task-2"), 100);
  const created = readBack([first]);
  assert.equal(created.partOf, null);
  const linked = asEvent(
    taskUpdateRow(patchTask(created, { partOf }), created.status, null),
    200,
  );
  assert.deepEqual(readBack([first, linked]).partOf, partOf);
});

test("an old task without a link reads as not linked", () => {
  const old = asEvent(
    {
      tags: [["d", "task-3"]],
      body: { title: "Old task", status: "open", reward: 5 },
    },
    100,
  );
  const task = readBack([old]);
  assert.equal(task.partOf, null);
  assert.equal(task.reward, 5);
  // A new task made without a link writes no link at all.
  assert.equal(
    "partOf" in newTaskRow({ title: "No link" }, "task-4").body,
    false,
  );
});
