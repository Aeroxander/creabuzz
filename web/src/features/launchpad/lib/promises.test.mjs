import assert from "node:assert/strict";
import test from "node:test";

import {
  duePromises,
  marksSection,
  markTags,
  parseMarks,
  parsePromises,
  promiseLines,
  promiseRecord,
  promiseTags,
  promiseTotals,
  promiseTotalsLine,
  recordFacts,
} from "./promises.ts";
import { updateEvent, updateLayout, partsFromTags } from "./weekly-update.ts";

const FOUNDER = "f".repeat(64);
const OTHER = "e".repeat(64);
const idOf = (n) => n.toString(16).padStart(64, "0");

/** An update as read back from what the dialog publishes. */
function update(n, at, draft, author = FOUNDER) {
  const { tags } = updateEvent({
    title: `Week ${n}`,
    done: "",
    next: "",
    body: "",
    help: "",
    helpSize: "small",
    helpTime: "",
    ...draft,
  });
  return {
    id: idOf(n),
    author,
    createdAt: at,
    promises: parsePromises(tags),
    marks: parseMarks(tags),
  };
}
const mark = (n, index, state, note = "", text = "x") => ({
  promiseId: `${idOf(n)}:${index}`,
  text,
  state,
  note,
});

test("each line of What's next is one promise, without the list marks people type", () => {
  assert.deepEqual(
    promiseLines(
      "- Invite ten people\n\n* Fix the email\n2. Write the guide\n  \nPlain line",
    ),
    ["Invite ten people", "Fix the email", "Write the guide", "Plain line"],
  );
  assert.deepEqual(promiseTags("A\nB"), [
    ["promise", "0", "A"],
    ["promise", "1", "B"],
  ]);
  assert.equal(promiseLines(Array(30).fill("x").join("\n")).length, 10);
  assert.equal(promiseLines("y".repeat(500))[0].length, 200);
});

test("an update carries its promises and its answers as tags, and the answers as words", () => {
  const { content, tags } = updateEvent({
    title: "Week 2",
    done: "Shipped sign-up.",
    next: "Invite ten people\nFix the email",
    body: "",
    help: "",
    helpSize: "small",
    helpTime: "",
    marks: [
      mark(1, 0, "done", "", "Ship sign-up"),
      mark(1, 1, "not-done", "ran out of time", "Write the guide"),
    ],
  });
  assert.deepEqual(
    tags.filter((t) => t[0] === "promise"),
    [
      ["promise", "0", "Invite ten people"],
      ["promise", "1", "Fix the email"],
    ],
  );
  assert.deepEqual(
    tags.filter((t) => t[0] === "promise-mark"),
    [
      ["promise-mark", `${idOf(1)}:0`, "done", ""],
      ["promise-mark", `${idOf(1)}:1`, "not-done", "ran out of time"],
    ],
  );
  assert.match(
    content.body,
    /^What we said last time\nDone: Ship sign-up\nNot done: Write the guide \(ran out of time\)\n\nWhat happened this week\n/,
  );
  // The prompts still lay out: the answers are the words before them.
  const layout = updateLayout(content.body, partsFromTags(tags));
  assert.equal(layout.showParts, true);
  assert.match(layout.free, /^What we said last time/);
});

test("answers that name no promise, or give no known answer, are not written or read", () => {
  assert.deepEqual(
    markTags([
      { promiseId: "nope", text: "x", state: "done", note: "" },
      { promiseId: `${idOf(1)}:0`, text: "x", state: "erased", note: "" },
    ]),
    [],
  );
  assert.deepEqual(
    parseMarks([
      ["promise-mark", `${idOf(1)}:0`, "erased", ""],
      ["promise-mark", "short:0", "done", ""],
      ["promise-mark", `${idOf(1)}:1`, "changed"],
    ]),
    [{ promiseId: `${idOf(1)}:1`, state: "changed", note: "" }],
  );
  assert.equal(marksSection([]), "");
});

test("the record: kept, missed and changed with dates, newest first, and totals", () => {
  const updates = [
    update(1, 100, { next: "Ship sign-up\nWrite the guide\nFind a designer" }),
    update(2, 200, {
      next: "Invite ten people",
      marks: [
        mark(1, 0, "done"),
        mark(1, 1, "not-done", "ran out of time"),
        mark(1, 2, "changed", "doing it ourselves"),
      ],
    }),
  ];
  const record = promiseRecord(updates, FOUNDER);
  assert.deepEqual(
    record.map((e) => [e.text, e.state, e.promisedAt, e.answeredAt, e.note]),
    [
      ["Ship sign-up", "kept", 100, 200, ""],
      ["Write the guide", "missed", 100, 200, "ran out of time"],
      ["Find a designer", "changed", 100, 200, "doing it ourselves"],
      ["Invite ten people", "waiting", 200, null, ""],
    ],
  );
  const totals = promiseTotals(record);
  assert.deepEqual(totals, { kept: 1, missed: 1, changed: 1, unanswered: 0 });
  assert.equal(promiseTotalsLine(totals), "1 kept, 1 missed, 1 changed");
  assert.deepEqual(
    duePromises(record).map((e) => e.text),
    ["Invite ten people"],
  );
});

test("a promise the next update did not answer shows as not answered, and is asked about again", () => {
  const record = promiseRecord(
    [
      update(1, 100, { next: "Ship sign-up" }),
      update(2, 200, { done: "A quiet week." }),
    ],
    FOUNDER,
  );
  assert.equal(record[0].state, "unanswered");
  assert.equal(
    promiseTotalsLine(promiseTotals(record)),
    "0 kept, 0 missed, 0 changed, 1 not answered",
  );
  assert.equal(duePromises(record).length, 1);
  assert.equal(promiseTotalsLine(promiseTotals([])), null);
});

test("the first answer stands: a later update cannot turn a miss into done", () => {
  const record = promiseRecord(
    [
      update(1, 100, { next: "Ship sign-up" }),
      update(2, 200, { marks: [mark(1, 0, "not-done", "late")] }),
      update(3, 300, { marks: [mark(1, 0, "done")] }),
    ],
    FOUNDER,
  );
  assert.deepEqual(
    [record[0].state, record[0].answeredAt, record[0].note],
    ["missed", 200, "late"],
  );
});

test("only the founder's updates promise and answer", () => {
  const record = promiseRecord(
    [
      update(1, 100, { next: "Ship sign-up" }),
      update(2, 200, { marks: [mark(1, 0, "done")] }, OTHER),
      update(3, 150, { next: "A stranger's promise" }, OTHER),
    ],
    FOUNDER,
  );
  assert.deepEqual(
    record.map((e) => [e.text, e.state]),
    [["Ship sign-up", "waiting"]],
  );
});

test("an update cannot answer its own promises, or one made after it", () => {
  const own = update(1, 100, { next: "Ship sign-up" });
  own.marks = [{ promiseId: `${idOf(1)}:0`, state: "done", note: "" }];
  assert.equal(promiseRecord([own], FOUNDER)[0].state, "waiting");
  const early = update(2, 50, { marks: [mark(1, 0, "done")] });
  assert.equal(
    promiseRecord([update(1, 100, { next: "Ship sign-up" }), early], FOUNDER)[0]
      .state,
    "waiting",
  );
});

test("deleting the update that answered puts the promise back to not answered; deleting the promise's update removes it", () => {
  const first = update(1, 100, { next: "Ship sign-up" });
  const second = update(2, 200, { marks: [mark(1, 0, "not-done")] });
  const third = update(3, 300, { done: "More." });
  assert.equal(promiseRecord([first, third], FOUNDER)[0].state, "unanswered");
  assert.deepEqual(promiseRecord([second, third], FOUNDER), []);
});

test("a cut read states no totals and never says no goal was set", () => {
  assert.deepEqual(recordFacts({ complete: true }), {
    totals: true,
    noGoal: true,
  });
  assert.deepEqual(recordFacts({ complete: false }), {
    totals: false,
    noGoal: false,
  });
});
