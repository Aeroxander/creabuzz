import assert from "node:assert/strict";
import test from "node:test";

import {
  PartialRemovalError,
  removalFailedLine,
  removeEach,
  withReason,
} from "./removals.ts";

test("each record is its own removal, sent in order", async () => {
  const sent = [];
  await removeEach(["a", "b", "a", "c"], async (id) => sent.push(id));
  // One record, one removal: never several ids in one, and never the same record twice.
  assert.deepEqual(sent, ["a", "b", "c"]);
});

test("a removal that stops part way says how many went and how many did not, and sends nothing after the failure", async () => {
  const sent = [];
  const failing = removeEach(["a", "b", "c"], async (id) => {
    if (id === "b") throw new Error("Server publish timed out");
    sent.push(id);
  });
  await assert.rejects(failing, (error) => {
    assert.ok(error instanceof PartialRemovalError);
    assert.equal(error.removed, 1);
    assert.equal(error.total, 3);
    assert.equal(
      removalFailedLine(error, "Your offer was not withdrawn."),
      "1 of 3 records were removed and 2 were not. Try again to remove the rest.",
    );
    return true;
  });
  assert.deepEqual(sent, ["a"]);
});

test("when nothing was removed the plain line is said, with the server's reason when it has one", async () => {
  const none = await removeEach(["a"], async () => {
    throw new Error(
      "invalid: deletion events must reference exactly one target via e or a tag (got e=2, a=0)",
    );
  }).catch((error) => error);
  assert.match(
    removalFailedLine(none, "Your offer was not withdrawn."),
    /^Your offer was not withdrawn\. The server removes one record at a time/,
  );
  assert.equal(
    removalFailedLine(new Error("offline"), "Not reopened."),
    "Not reopened.",
  );
  const two = await removeEach(["a", "b"], async (id) => {
    if (id === "b") throw new Error("x");
  }).catch((error) => error);
  assert.equal(
    removalFailedLine(two, "n"),
    "1 of 2 records were removed and 1 was not. Try again to remove the rest.",
  );
});

test("a refused send is said with the server's reason and a next step", () => {
  assert.equal(
    withReason(
      "The task was not made.",
      new Error("restricted: only this project's team can post this"),
    ),
    "The task was not made. Only this project's team can post this. If you should be on the team, ask the founder to add you to the project, then try again.",
  );
  assert.equal(
    withReason("The task was not made.", new Error("timed out")),
    "The task was not made.",
  );
});
