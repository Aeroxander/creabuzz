import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTaskBacking,
  buildTaskContribution,
  canClaimTask,
  keepRecentRows,
  MAX_ROWS_PER_TASK,
  mergeTaskRows,
  nextUpOrder,
  readMilestone,
  readReward,
  taskCoordinate,
} from "./task-planning.ts";

const ALICE = "a".repeat(64);
const WORKER = "b".repeat(64);
const BOB = "c".repeat(64);

let seq = 0;
function row(pubkey, at, body, extraTags = []) {
  seq += 1;
  return {
    id: seq.toString(16).padStart(64, "0"),
    pubkey,
    created_at: at,
    kind: 44011,
    tags: [["d", "task-1"], ...extraTags],
    content: JSON.stringify(body),
    sig: "",
  };
}
const body = (merged) => JSON.parse(merged.event.content);

test("a writer that omits fields cannot erase them (the fleet worker case)", () => {
  const created = row(ALICE, 100, {
    title: "Write the pitch",
    description: "One page, plain words",
    status: "open",
    priority: "high",
    due: 1_800_000_000_000,
    labels: ["launch"],
    milestone: "Testnet live",
    reward: 40,
  });
  // The worker republishes only title + status when an agent picks it up.
  const pickedUp = row(WORKER, 200, {
    title: "Write the pitch",
    description: "",
    status: "in_progress",
  });
  const merged = body(mergeTaskRows([created, pickedUp]));
  assert.equal(merged.status, "in_progress");
  assert.equal(merged.priority, "high");
  assert.equal(merged.milestone, "Testnet live");
  assert.equal(merged.reward, 40);
  assert.deepEqual(merged.labels, ["launch"]);
  // A field the newer row DID write wins, even when it is empty.
  assert.equal(merged.description, "");
});

test("merging is order-independent: an old row arriving late cannot win", () => {
  const open = row(ALICE, 100, { title: "T", status: "open" });
  const done = row(BOB, 300, { title: "T", status: "done" });
  const a = mergeTaskRows([open, done]);
  const b = mergeTaskRows([done, open]);
  assert.equal(body(a).status, "done");
  assert.deepEqual(a, b);
  assert.equal(a.doneRowId, done.id);
  assert.equal(a.latestRowId, done.id);
  assert.equal(a.creator, ALICE);
});

test("clearing a field is an explicit null, and it sticks", () => {
  const set = row(ALICE, 100, { title: "T", status: "open", milestone: "M1" });
  const cleared = row(ALICE, 200, {
    title: "T",
    status: "open",
    milestone: null,
  });
  const later = row(WORKER, 300, { title: "T", status: "assigned" });
  assert.equal(body(mergeTaskRows([set, cleared, later])).milestone, null);
});

test("doneRowId is only set while the task is done", () => {
  const done = row(ALICE, 100, { title: "T", status: "done" });
  const reopened = row(ALICE, 200, { title: "T", status: "open" });
  assert.equal(mergeTaskRows([done, reopened]).doneRowId, null);
  assert.equal(mergeTaskRows([]), null);
});

test("row history is bounded and de-duplicated", () => {
  const rows = Array.from({ length: MAX_ROWS_PER_TASK + 20 }, (_, i) =>
    row(ALICE, i + 1, { title: "T", status: "open" }),
  );
  const kept = keepRecentRows([...rows, rows[0], rows[5]]);
  assert.equal(kept.length, MAX_ROWS_PER_TASK);
  assert.equal(kept.at(-1).created_at, MAX_ROWS_PER_TASK + 20);
});

test("rewards and milestones are validated on read", () => {
  assert.equal(readReward(40), 40);
  assert.equal(readReward(12.6), 13);
  assert.equal(readReward(0), null);
  assert.equal(readReward("40"), null);
  assert.equal(readMilestone("  Testnet live "), "Testnet live");
  assert.equal(readMilestone(""), null);
  assert.equal(readMilestone("x".repeat(200)).length, 120);
});

test("backing names the task coordinate so it survives edits", () => {
  const backing = buildTaskBacking({
    d: "task-1",
    creator: ALICE.toUpperCase(),
    latestRowId: "f".repeat(64),
  });
  assert.equal(backing.kind, 7);
  assert.equal(backing.content, "+");
  assert.deepEqual(backing.tags, [
    ["e", "f".repeat(64)],
    ["p", ALICE],
    ["k", "44011"],
    ["a", taskCoordinate(ALICE, "task-1")],
  ]);
  assert.equal(taskCoordinate(ALICE, "task-1"), `44011:${ALICE}:task-1`);
  // A channel task's backing is read per channel, so it carries the channel.
  const inChannel = buildTaskBacking({
    d: "task-1",
    creator: ALICE,
    latestRowId: "f".repeat(64),
    channelId: "chan-1",
  });
  assert.deepEqual(inChannel.tags.at(-1), ["h", "chan-1"]);
});

test("next up: only unstarted tasks, by support, then priority, then due date", () => {
  const t = (id, status, priority, due, updatedAt = 0) => ({
    id,
    creator: ALICE,
    status,
    priority,
    due,
    updatedAt,
  });
  const tasks = [
    t("low-backed", "open", "low", null),
    t("urgent", "open", "urgent", null),
    t("due-soon", "open", "normal", 1000),
    t("due-later", "assigned", "normal", 2000),
    t("no-due", "open", "normal", null, 5),
    t("started", "in_progress", "urgent", null),
    t("finished", "done", "urgent", null),
  ];
  const support = { "low-backed": 3 };
  const order = nextUpOrder(tasks, (task) => support[task.id] ?? 0).map(
    (x) => x.id,
  );
  assert.deepEqual(order, [
    "low-backed",
    "urgent",
    "due-soon",
    "due-later",
    "no-due",
  ]);
});

test("only the assignee — or the creator of an unassigned task — may claim it", () => {
  assert.equal(canClaimTask({ assignee: BOB, creator: ALICE }, BOB), true);
  assert.equal(canClaimTask({ assignee: BOB, creator: ALICE }, ALICE), false);
  assert.equal(canClaimTask({ assignee: null, creator: ALICE }, ALICE), true);
  assert.equal(canClaimTask({ assignee: null, creator: ALICE }, BOB), false);
  assert.equal(canClaimTask({ assignee: null, creator: ALICE }, null), false);
});

test("a claimed task becomes a pending record keyed like the fleet worker's", () => {
  const doneRowId = "d".repeat(64);
  const record = buildTaskContribution({
    doneRowId,
    title: "Write the pitch",
    description: "One page",
    reward: 40,
    milestone: "Testnet live",
  });
  assert.equal(record.kind, 37013);
  assert.deepEqual(record.tags, [
    ["d", doneRowId],
    ["e", doneRowId],
    ["k", "44011"],
  ]);
  const content = JSON.parse(record.content);
  assert.equal(content.reviewStatus, "pending");
  assert.equal(content.action, "Write the pitch — One page");
  assert.equal(content.amount, 40);
  assert.equal(content.milestone, "Testnet live");
  assert.deepEqual(content.humanVsAi, { human: 1, ai: 0 });
  // No reward: no amount (the reviewer prices it, or it counts 1 point).
  const unpriced = JSON.parse(
    buildTaskContribution({
      doneRowId,
      title: "T",
      description: "",
      reward: null,
      milestone: null,
    }).content,
  );
  assert.equal(Object.hasOwn(unpriced, "amount"), false);
});
