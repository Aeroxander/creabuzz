import assert from "node:assert/strict";
import test from "node:test";

import { draftFacts, placeDraft } from "./update-draft-facts.ts";

const empty = { done: "", help: "", line: "" };
const drafted = {
  done: "Sign-up works.",
  help: "A tester.",
  line: "Sign-up works.",
};

test("the facts are the record and the marks chosen so far, and nothing else", () => {
  const facts = draftFacts({
    accepted: [{ what: "Sign-up works" }],
    promises: [
      { id: "p1", text: "Fix the email" },
      { id: "p2", text: "Write the guide" },
    ],
    marks: { p1: { state: "done", note: "Sent Tuesday" } },
    goals: [
      {
        level: "primary",
        text: "Ten users",
        how: "Ten sign in",
        state: "open",
      },
    ],
    help: ["Someone to test"],
  });
  assert.deepEqual(facts, {
    accepted: [{ what: "Sign-up works" }],
    promises: [
      { text: "Fix the email", mark: "done", note: "Sent Tuesday" },
      { text: "Write the guide", mark: null, note: "" },
    ],
    goals: [
      {
        level: "primary",
        text: "Ten users",
        how: "Ten sign in",
        state: "open",
      },
    ],
    help: [{ text: "Someone to test" }],
  });
});

test("a draft fills empty boxes", () => {
  const out = placeDraft({
    draft: drafted,
    atClick: empty,
    now: empty,
    last: null,
  });
  assert.deepEqual(out.next, drafted);
  assert.deepEqual(out.filled, ["done", "help", "line"]);
  assert.deepEqual(out.kept, []);
});

test("a box the founder wrote in is left as they wrote it", () => {
  const mine = { done: "My own words.", help: "", line: "" };
  const out = placeDraft({
    draft: drafted,
    atClick: mine,
    now: mine,
    last: null,
  });
  assert.equal(out.next.done, "My own words.");
  assert.equal(out.next.help, "A tester.");
  assert.deepEqual(out.kept, ["done"]);
});

test("a box changed while the AI was writing is left alone, even if it was empty at the click", () => {
  const typed = { ...empty, done: "I started typing." };
  const out = placeDraft({
    draft: drafted,
    atClick: empty,
    now: typed,
    last: null,
  });
  assert.equal(out.next.done, "I started typing.");
  assert.deepEqual(out.kept, ["done"]);
  assert.deepEqual(out.filled, ["help", "line"]);
});

test("a second draft replaces the first only where the founder has not touched it", () => {
  const second = {
    done: "Second.",
    help: "Second help.",
    line: "Second line.",
  };
  const edited = { ...drafted, help: "A tester, on an older phone." };
  const out = placeDraft({
    draft: second,
    atClick: edited,
    now: edited,
    last: drafted,
  });
  assert.equal(out.next.done, "Second.");
  assert.equal(out.next.line, "Second line.");
  assert.equal(out.next.help, "A tester, on an older phone.");
  assert.deepEqual(out.kept, ["help"]);
});

test("a part the draft has nothing for is not touched", () => {
  const some = { done: "Only this.", help: "", line: "" };
  const mine = { done: "", help: "Mine.", line: "" };
  const out = placeDraft({ draft: some, atClick: mine, now: mine, last: null });
  assert.deepEqual(out.next, { done: "Only this.", help: "Mine.", line: "" });
  assert.deepEqual(out.kept, []);
});

test("there is no 'next' anywhere in what a draft can fill", () => {
  const out = placeDraft({
    draft: drafted,
    atClick: empty,
    now: empty,
    last: null,
  });
  assert.deepEqual(Object.keys(out.next).sort(), ["done", "help", "line"]);
});
