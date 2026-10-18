import assert from "node:assert/strict";
import { test } from "node:test";
import { readDelivery, outputUrl, taskDeliveryTags } from "./task-delivery.ts";
import { mergeTaskRows } from "./task-planning.ts";

const project = `37001:${"a".repeat(64)}:project`;
const delivery = {
  project,
  output: "https://example.com/demo",
  claim: { id: "0x" + "b".repeat(64), mandate: "0x" + "c".repeat(40) },
};
const row = (id, at, body) => ({
  id,
  pubkey: "a".repeat(64),
  created_at: at,
  kind: 44011,
  tags: [["d", "task"]],
  content: JSON.stringify(body),
  sig: "",
});

test("task references are indexed by project while retaining the privacy channel", () => {
  const tags = [
    ["d", "task"],
    ["h", "private-channel"],
  ];
  assert.deepEqual(taskDeliveryTags(tags, delivery), [...tags, ["a", project]]);
  assert.deepEqual(taskDeliveryTags(tags, null), tags);
  assert.deepEqual(taskDeliveryTags([...tags, ["a", project]], delivery), [
    ...tags,
    ["a", project],
  ]);
  assert.equal(tags.length, 2);
});

test("delivery references validate project, claim and safe output protocols", () => {
  assert.deepEqual(readDelivery(delivery), delivery);
  assert.equal(readDelivery({ ...delivery, project: "arbitrary" }), null);
  assert.equal(outputUrl("javascript:alert(1)"), null);
  assert.equal(outputUrl("https://user:secret@example.com"), null);
  assert.equal(
    readDelivery({
      ...delivery,
      claim: { id: "short", mandate: delivery.claim.mandate },
    }).claim,
    null,
  );
});

test("an agent status row cannot erase delivery references; clearing is explicit", () => {
  const planned = row("1", 1, { title: "Build", status: "open", delivery });
  const working = row("2", 2, { title: "Build", status: "in_progress" });
  assert.deepEqual(
    JSON.parse(mergeTaskRows([working, planned]).event.content).delivery,
    delivery,
  );
  const clear = row("3", 3, { status: "in_progress", delivery: null });
  assert.equal(
    JSON.parse(mergeTaskRows([planned, working, clear]).event.content).delivery,
    null,
  );
});

test("linking output after completion keeps the completion identity used for contribution credit", () => {
  const open = row("1", 1, { status: "open" });
  const done = row("2", 2, { status: "done" });
  const linked = row("3", 3, { status: "done", delivery });
  assert.equal(mergeTaskRows([open, done, linked]).doneRowId, done.id);
  const reopen = row("4", 4, { status: "open" });
  const doneAgain = row("5", 5, { status: "done" });
  assert.equal(
    mergeTaskRows([open, done, linked, reopen, doneAgain]).doneRowId,
    doneAgain.id,
  );
});
