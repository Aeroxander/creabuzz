import assert from "node:assert/strict";
import test from "node:test";

import {
  CHOICES_SHOWN,
  KIND_WORD,
  milestoneChoices,
} from "./backing-records.ts";

const id = (n) => n.toString(16).padStart(64, "0");
const FOUNDER = "f".repeat(64);
const OTHER = "e".repeat(64);
const NOW = 2_000;

const base = { founder: FOUNDER, now: NOW, tasks: null };

test("only the founder's own updates, reached goals and accepted work are offered, newest first", () => {
  const choices = milestoneChoices({
    ...base,
    updates: [
      { id: id(1), author: FOUNDER, createdAt: 100, title: "Week one" },
      {
        id: id(2),
        author: OTHER,
        createdAt: 900,
        title: "Someone else's post",
      },
      {
        id: id(3),
        author: FOUNDER,
        createdAt: 300,
        title: "Evidence",
        claim: { id: "x" },
      },
      {
        id: id(4),
        author: FOUNDER,
        createdAt: 310,
        title: "Words",
        workArea: { id: "x" },
      },
      {
        id: id(5),
        author: FOUNDER,
        createdAt: 320,
        title: "Check",
        checkNote: true,
      },
      {
        id: "short",
        author: FOUNDER,
        createdAt: 330,
        title: "Not an event id",
      },
    ],
    goals: [
      {
        eventId: id(6),
        author: FOUNDER,
        at: 500,
        state: "reached",
        text: "Ship sign-up",
      },
      {
        eventId: id(7),
        author: FOUNDER,
        at: 600,
        state: "open",
        text: "Still open",
      },
      {
        eventId: id(8),
        author: OTHER,
        at: 700,
        state: "reached",
        text: "Not the founder's",
      },
      {
        eventId: id(9),
        author: FOUNDER,
        at: 650,
        state: "missed",
        text: "Missed",
      },
    ],
    tasks: [
      {
        state: "confirmed",
        what: "Write the guide",
        accepted: { id: id(10), confirmedAt: 400 },
      },
      { state: "open", what: "Not done", accepted: null },
      { state: "confirmed", what: "No evidence", accepted: null },
    ],
  });
  assert.deepEqual(
    choices.map((c) => [c.id, c.kind]),
    [
      [id(6), "goal"],
      [id(10), "work"],
      [id(1), "update"],
    ],
  );
  assert.equal(KIND_WORD.goal, "Goal reached");
});

test("a record dated ahead is shown as signed now, and the list is bounded", () => {
  const choices = milestoneChoices({
    ...base,
    updates: [
      {
        id: id(1),
        author: FOUNDER,
        createdAt: 99_999,
        title: "From the future",
      },
    ],
    goals: [],
  });
  assert.equal(choices[0].at, NOW);
  const many = Array.from({ length: CHOICES_SHOWN + 10 }, (_, i) => ({
    id: id(i + 1),
    author: FOUNDER,
    createdAt: i + 1,
    title: `Update ${i}`,
  }));
  const shown = milestoneChoices({ ...base, updates: many, goals: [] });
  assert.equal(shown.length, CHOICES_SHOWN);
  assert.equal(shown[0].id, id(CHOICES_SHOWN + 10), "the newest are kept");
});

test("one event offered twice is offered once, and a long title is cut", () => {
  const long = "A".repeat(200);
  const choices = milestoneChoices({
    ...base,
    updates: [{ id: id(1), author: FOUNDER, createdAt: 100, title: long }],
    goals: [
      {
        eventId: id(1),
        author: FOUNDER,
        at: 100,
        state: "reached",
        text: "dup",
      },
    ],
  });
  assert.equal(choices.length, 1);
  assert.ok(choices[0].label.length <= 70);
});

test("with nothing read there is nothing to offer", () => {
  assert.deepEqual(
    milestoneChoices({ ...base, updates: [], goals: [], tasks: [] }),
    [],
  );
});
