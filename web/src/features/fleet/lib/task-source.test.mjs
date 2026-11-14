import assert from "node:assert/strict";
import test from "node:test";

import { mergeTaskRows } from "./task-planning.ts";
import {
  buildFinderContribution,
  canClaimFinderCredit,
  canEscalatePost,
  defaultFinderReward,
  escalationNote,
  escalationPoints,
  finderCreditKey,
  readSource,
  taskFromPost,
} from "./task-source.ts";

const POST = "d".repeat(64);
const DONE = "e".repeat(64);
const AUTHOR = "a".repeat(64);
const TEAM = "b".repeat(64);
const BOARD = "7f0c1a52-0000-4000-8000-000000000001";

const source = (over = {}) => ({
  post: POST,
  board: BOARD,
  author: AUTHOR,
  finderReward: 3,
  ...over,
});

test("readSource keeps a well-formed source and lower-cases its keys", () => {
  assert.deepEqual(
    readSource({
      post: POST.toUpperCase(),
      board: ` ${BOARD} `,
      author: AUTHOR.toUpperCase(),
      finderReward: 3,
    }),
    source(),
  );
});

test("readSource refuses anything that is not a post, a board and an author", () => {
  for (const bad of [
    null,
    undefined,
    "post",
    [],
    {},
    { post: "short", board: BOARD, author: AUTHOR },
    { post: POST, board: "", author: AUTHOR },
    { post: POST, board: BOARD, author: "nope" },
  ]) {
    assert.equal(readSource(bad), null, JSON.stringify(bad));
  }
});

test("readSource drops a finder reward that is not a positive number", () => {
  for (const reward of [0, -2, "5", Number.NaN, null]) {
    assert.equal(
      readSource({
        post: POST,
        board: BOARD,
        author: AUTHOR,
        finderReward: reward,
      }).finderReward,
      null,
    );
  }
});

test("the default finder credit is a tenth of the reward, at least a point", () => {
  assert.equal(defaultFinderReward(null), null);
  assert.equal(defaultFinderReward(0), null);
  assert.equal(defaultFinderReward(100), 10);
  assert.equal(defaultFinderReward(5), 1);
  assert.equal(defaultFinderReward(1), 1);
  assert.equal(defaultFinderReward(26), 3);
});

test("nobody turns their own post into a task", () => {
  assert.equal(canEscalatePost(AUTHOR, AUTHOR), false);
  assert.equal(canEscalatePost(AUTHOR, AUTHOR.toUpperCase()), false);
  assert.equal(canEscalatePost(AUTHOR, null), false);
  assert.equal(canEscalatePost(AUTHOR, TEAM), true);
});

test("only the post's author can claim, and only once the task is done", () => {
  const done = { source: source(), doneRowId: DONE };
  assert.equal(canClaimFinderCredit(done, AUTHOR), true);
  assert.equal(canClaimFinderCredit(done, AUTHOR.toUpperCase()), true);
  // Someone else, signed out, not finished, no source, no figure offered.
  assert.equal(canClaimFinderCredit(done, TEAM), false);
  assert.equal(canClaimFinderCredit(done, null), false);
  assert.equal(
    canClaimFinderCredit({ ...done, doneRowId: null }, AUTHOR),
    false,
  );
  assert.equal(canClaimFinderCredit({ ...done, source: null }, AUTHOR), false);
  assert.equal(
    canClaimFinderCredit(
      { ...done, source: source({ finderReward: null }) },
      AUTHOR,
    ),
    false,
  );
});

test("a task made from a post names the post, its board and its author", () => {
  const task = taskFromPost({
    post: {
      id: POST,
      author: AUTHOR,
      title: "  Add dark mode  ",
      body: " It hurts at night. ",
    },
    board: BOARD,
    reward: 50,
    finderReward: 5,
    milestone: "Beta",
  });
  assert.equal(task.title, "Add dark mode");
  assert.equal(task.description, "It hurts at night.");
  assert.equal(task.channelId, BOARD);
  assert.deepEqual(task.labels, ["from-board"]);
  assert.equal(task.reward, 50);
  assert.equal(task.milestone, "Beta");
  assert.deepEqual(task.source, source({ finderReward: 5 }));
});

test("a post with no title still gives the task a name", () => {
  const task = taskFromPost({
    post: { id: POST, author: AUTHOR, title: "   ", body: "" },
    board: BOARD,
    reward: null,
    finderReward: null,
    milestone: null,
  });
  assert.equal(task.title, "Suggestion from the board");
});

test("the note under the post says what became of it, and what it earns", () => {
  assert.equal(
    escalationNote({ finderReward: null }),
    "The team turned this into a task.",
  );
  assert.match(
    escalationNote({ finderReward: 1 }),
    /claim 1 point as its finder/,
  );
  assert.match(
    escalationNote({ finderReward: 4 }),
    /claim 4 points as its finder/,
  );
});

test("the finder's credit is its own record, keyed apart from the task's", () => {
  const record = buildFinderContribution({
    doneRowId: DONE,
    source: source(),
    title: "Add dark mode",
    milestone: "Beta",
  });
  assert.equal(record.kind, 37013);
  assert.deepEqual(record.tags[0], ["d", finderCreditKey(DONE)]);
  assert.notEqual(record.tags[0][1], DONE);
  // The record builders refuse an id over 64 bytes.
  assert.ok(finderCreditKey(DONE).length <= 64);
  assert.notEqual(finderCreditKey(DONE), finderCreditKey("f".repeat(64)));
  assert.deepEqual(
    record.tags.filter((t) => t[0] === "e").map((t) => t[1]),
    [POST, DONE],
  );
  const body = JSON.parse(record.content);
  assert.equal(body.amount, 3);
  assert.equal(body.milestone, "Beta");
  assert.equal(body.reviewStatus, "pending");
  assert.deepEqual(body.evidence, [POST, DONE]);
  assert.match(body.action, /^Suggested on the board: Add dark mode$/);
});

test("a finder's credit with no figure carries no amount", () => {
  const record = buildFinderContribution({
    doneRowId: DONE,
    source: source({ finderReward: null }),
    title: "x",
    milestone: null,
  });
  const body = JSON.parse(record.content);
  assert.equal("amount" in body, false);
  assert.equal("milestone" in body, false);
});

test("the source survives later rows that do not write it", () => {
  const created = {
    id: "1".repeat(64),
    pubkey: TEAM,
    created_at: 100,
    kind: 44011,
    tags: [["d", "task-1"]],
    content: JSON.stringify({
      title: "Add dark mode",
      status: "open",
      source: source(),
    }),
    sig: "",
  };
  const pickup = {
    ...created,
    id: "2".repeat(64),
    pubkey: "c".repeat(64),
    created_at: 200,
    content: JSON.stringify({ title: "Add dark mode", status: "in_progress" }),
  };
  const merged = mergeTaskRows([created, pickup]);
  const body = JSON.parse(merged.event.content);
  assert.equal(body.status, "in_progress");
  assert.deepEqual(readSource(body.source), source());
});

test("without raises (the pilot) an idea becomes a task with no points, whatever was typed", () => {
  assert.deepEqual(escalationPoints(false, "50", "9"), {
    reward: null,
    finderReward: null,
  });
  assert.equal(
    escalationNote(escalationPoints(false, "50", null)),
    "The team turned this into a task.",
  );
  // Where raises are offered the figures stand as before: the finder gets a tenth unless the team sets one.
  assert.deepEqual(escalationPoints(true, "50", null), {
    reward: 50,
    finderReward: 5,
  });
  assert.deepEqual(escalationPoints(true, "50", "9"), {
    reward: 50,
    finderReward: 9,
  });
  assert.deepEqual(escalationPoints(true, "", "x"), {
    reward: null,
    finderReward: null,
  });
});
