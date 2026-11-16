import assert from "node:assert/strict";
import test from "node:test";

import { parseMarks, parsePromises } from "./promises.ts";
import {
  LAST_WEEK_LABEL,
  previousWeekly,
  promiseTexts,
  updateView,
} from "./update-view.ts";
import { partsFromTags, updateEvent } from "./weekly-update.ts";

const FOUNDER = "f".repeat(64);
const MATE = "a".repeat(64);
const hex = (n) => n.toString(16).padStart(64, "0");

/** An update as the app reads it back, written by the real writer (`updateEvent`). */
function made(id, author, createdAt, draft, options) {
  const { content, tags } = updateEvent(
    {
      title: "Week",
      done: "",
      next: "",
      body: "",
      help: "",
      helpSize: "small",
      helpTime: "",
      ...draft,
    },
    options,
  );
  return {
    id,
    author,
    createdAt,
    body: content.body,
    parts: partsFromTags(tags) ?? undefined,
    promises: parsePromises(tags),
    marks: parseMarks(tags),
    weekly: true,
  };
}

const first = made(hex(1), FOUNDER, 100, {
  done: "Wrote the outline.",
  next: "Publish the first page\nAsk three people to read it",
});

test("last week's promises come from what the update signed: one kept and one missed", () => {
  const second = made(hex(2), FOUNDER, 200, {
    done: "Published.",
    next: "Fix the typos",
    marks: [
      {
        promiseId: `${hex(1)}:0`,
        text: "Publish the first page",
        state: "done",
        note: "",
      },
      {
        promiseId: `${hex(1)}:1`,
        text: "Ask three people to read it",
        state: "not-done",
        note: "ran out of time",
      },
    ],
  });
  const view = updateView(second, {
    founder: FOUNDER,
    previous: first,
    texts: promiseTexts([first, second]),
  });
  assert.equal(view.structured, true);
  assert.deepEqual(
    view.lastWeek.map((row) => [row.state, row.text, row.note]),
    [
      ["kept", "Publish the first page", ""],
      ["missed", "Ask three people to read it", "ran out of time"],
    ],
  );
  assert.equal(view.thisWeek, "Published.");
  assert.deepEqual(view.nextWeek, ["Fix the typos"]);
  assert.equal(view.nextAreSigned, true);
  // The answers' own section is not shown a second time inside "this week".
  assert.doesNotMatch(view.thisWeek, /What we said last time/);
});

test("a promise the update does not answer is Not answered, never Kept", () => {
  const second = made(hex(2), FOUNDER, 200, {
    done: "Published.",
    marks: [
      {
        promiseId: `${hex(1)}:0`,
        text: "Publish the first page",
        state: "done",
        note: "",
      },
    ],
  });
  const view = updateView(second, { founder: FOUNDER, previous: first });
  assert.deepEqual(
    view.lastWeek.map((row) => row.state),
    ["kept", "unanswered"],
  );
  assert.equal(LAST_WEEK_LABEL.unanswered, "Not answered");
  // No answer at all: every earlier promise is Not answered.
  const silent = made(hex(3), FOUNDER, 300, { done: "Quiet." });
  assert.deepEqual(
    updateView(silent, { founder: FOUNDER, previous: first }).lastWeek.map(
      (r) => r.state,
    ),
    ["unanswered", "unanswered"],
  );
});

test("a cut read says nothing about promises it cannot see: only the answers given are shown", () => {
  const second = made(hex(2), FOUNDER, 200, {
    done: "Published.",
    marks: [
      {
        promiseId: `${hex(1)}:0`,
        text: "Publish the first page",
        state: "done",
        note: "",
      },
    ],
  });
  // The update before it was not read (a cut read): its promises are unknown, so there is no "Not answered" row.
  const cut = updateView(second, { founder: FOUNDER, previous: null });
  assert.deepEqual(
    cut.lastWeek.map((row) => [row.state, row.text]),
    // The words come from the answer's own line in the body, since the earlier update is not here.
    [["kept", "Publish the first page"]],
  );
  // With no earlier words anywhere, the row says what it is without inventing the promise.
  const bare = {
    ...second,
    body: second.body.replace(/What we said last time\n.*\n\n/s, ""),
  };
  assert.doesNotMatch(bare.body, /said last time/);
  const nameless = updateView(bare, { founder: FOUNDER, previous: null });
  assert.equal(nameless.lastWeek[0].state, "kept");
  assert.match(nameless.lastWeek[0].text, /earlier update/);
});

test("a teammate's update answers nothing, so it has no last-week rows", () => {
  const plan = made(
    hex(4),
    MATE,
    250,
    { done: "Helped.", next: "More help" },
    { promises: false },
  );
  assert.equal(previousWeekly([first, plan], plan, FOUNDER), null);
  const view = updateView(plan, { founder: FOUNDER, previous: first });
  assert.deepEqual(view.lastWeek, []);
  assert.deepEqual(view.nextWeek, ["More help"]);
  assert.equal(view.nextAreSigned, false);
});

test("the update before is the founder's newest weekly update that is older", () => {
  const second = made(hex(2), FOUNDER, 200, { done: "x" });
  const third = made(hex(3), FOUNDER, 300, { done: "y" });
  const note = {
    ...made(hex(9), FOUNDER, 250, { done: "z" }),
    weekly: undefined,
  };
  assert.equal(
    previousWeekly([first, second, third, note], third, FOUNDER).id,
    second.id,
  );
  assert.equal(previousWeekly([first, second, third], first, FOUNDER), null);
});

test("an update with nothing signed to lay out is shown as written", () => {
  const old = {
    id: hex(7),
    author: FOUNDER,
    createdAt: 50,
    body: "Shipped the thing.\n\nNext: more.",
    weekly: true,
  };
  const view = updateView(old, { founder: FOUNDER, previous: first });
  assert.equal(view.structured, false);
  assert.equal(view.plain, "Shipped the thing.\n\nNext: more.");
  // Parts whose body was written by something else are not laid out beside it either.
  const odd = { ...first, body: "something else entirely" };
  assert.equal(updateView(odd, { founder: FOUNDER }).structured, false);
});

test("free words are kept in this week, with the answers' section taken off", () => {
  const free = made(hex(5), FOUNDER, 400, {
    body: "Big week.",
    done: "Shipped.",
    marks: [
      {
        promiseId: `${hex(1)}:0`,
        text: "Publish the first page",
        state: "changed",
        note: "moved to May",
      },
    ],
  });
  const view = updateView(free, {
    founder: FOUNDER,
    texts: promiseTexts([first]),
  });
  assert.equal(view.thisWeek, "Big week.\n\nShipped.");
  assert.deepEqual(
    view.lastWeek.map((r) => [r.state, r.note]),
    [["changed", "moved to May"]],
  );
});
