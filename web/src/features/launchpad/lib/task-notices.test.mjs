import assert from "node:assert/strict";
import test from "node:test";

import { nextFirstSeen, noticeVerb, taskNotices } from "./task-notices.ts";
import { parseTaskRecord, taskEvent, taskStepEvent } from "./tasks.ts";

const FOUNDER = "f".repeat(64);
const MATE = "c".repeat(64);
const HELPER = "a".repeat(64);
const STRANGER = "b".repeat(64);
const COORD = `37001:${FOUNDER}:demo`;
const PROJECT = {
  id: "demo",
  author: FOUNDER,
  name: "Demo",
  team: [{ pubkey: MATE }],
};
const NOW = 1_794_312_000;

let n = 0;
function record(pubkey, built, at = NOW - 100) {
  n += 1;
  return parseTaskRecord({
    id: n.toString(16).padStart(64, "0"),
    pubkey,
    created_at: at,
    kind: 47003,
    tags: [["a", COORD], ...built.tags],
    content: JSON.stringify(built.content),
    sig: "sig",
  });
}
const task = (who = FOUNDER, over = {}) =>
  record(
    who,
    taskEvent({
      helper: HELPER,
      what: "Test sign-up.",
      done: "It works.",
      size: "small",
      ...over,
    }),
  );
const step = (who, t, part, over = {}, at) =>
  record(who, taskStepEvent({ part, taskId: t.id, tell: [], ...over }), at);
const notices = (viewer, naming, tasks = [], over = {}) =>
  taskNotices({
    naming,
    tasks,
    projects: [PROJECT],
    viewer,
    now: NOW,
    ...over,
  });

test("the helper is told about a task, a send-back, a confirmation, more time and a cancel", () => {
  const t = task(FOUNDER, { offerId: "2".repeat(64) });
  const direct = task();
  const got = notices(HELPER, [
    t,
    direct,
    step(MATE, t, "send-back", {
      evidenceId: "3".repeat(64),
      note: "No recording.",
    }),
    step(MATE, t, "confirm", { evidenceId: "3".repeat(64) }),
    step(FOUNDER, t, "grant", { askId: "4".repeat(64), due: "2026-12-01" }),
    step(FOUNDER, t, "cancel", { note: "Changed plans." }),
  ]);
  assert.deepEqual(got.map((x) => x.part).sort(), [
    "cancel",
    "confirm",
    "grant",
    "send-back",
    "task",
    "task",
  ]);
  assert.equal(
    noticeVerb(got.find((x) => x.id === t.id)),
    // A task that names an offer is still only a task to say yes or no to: the offer was not agreement.
    "gave you a task to say yes or no to:",
  );
  assert.equal(
    noticeVerb(got.find((x) => x.id === direct.id)),
    "gave you a task to say yes or no to:",
  );
  assert.equal(got.find((x) => x.part === "send-back").note, "No recording.");
  assert.equal(got[0].project.name, "Demo");
  assert.equal(got[0].what, "Test sign-up.");
});

test("the team is told when the helper says yes, hands in, asks for time or gives up", () => {
  const t = task();
  const steps = [
    step(HELPER, t, "accept"),
    step(HELPER, t, "evidence", { note: "Done." }),
    step(HELPER, t, "more-time", { note: "Ill." }),
    step(HELPER, t, "give-up"),
  ];
  // The task itself was made by someone else on the team, so it is read apart and handed in as `tasks`.
  const got = notices(MATE, steps, [t]);
  assert.deepEqual(got.map((x) => x.part).sort(), [
    "accept",
    "evidence",
    "give-up",
    "more-time",
  ]);
  // Without the task they are about, the steps cannot be checked and tell nobody anything.
  assert.equal(notices(MATE, steps).length, 0);
  // Someone who is not on the team is told nothing by them.
  assert.equal(notices(STRANGER, steps, [t]).length, 0);
});

test("a step signed by the wrong party is not a notice", () => {
  const t = task();
  const forged = [
    step(STRANGER, t, "confirm", { evidenceId: "3".repeat(64) }),
    step(STRANGER, t, "send-back", { evidenceId: "3".repeat(64), note: "x" }),
    step(STRANGER, t, "cancel", { note: "x" }),
  ];
  assert.equal(
    notices(HELPER, [t, ...forged]).filter((x) => x.part !== "task").length,
    0,
  );
  // A "task" from someone who is not on the project's team.
  assert.equal(notices(HELPER, [task(STRANGER)]).length, 0);
  // A helper's step forged by someone else.
  assert.equal(
    notices(MATE, [step(STRANGER, t, "evidence", { note: "x" })], [t]).length,
    0,
  );
  // A project that is not known: nothing is said about it.
  assert.equal(
    taskNotices({
      naming: [t],
      tasks: [],
      projects: [],
      viewer: HELPER,
      now: NOW,
    }).length,
    0,
  );
});

test("muted people are left out before the cut, and your own steps are not notices", () => {
  const t = task();
  const mine = step(HELPER, t, "accept");
  assert.equal(notices(HELPER, [t, mine]).length, 1);
  assert.equal(
    notices(HELPER, [t], [], { muted: new Set([FOUNDER]) }).length,
    0,
  );
  const ok = step(MATE, t, "confirm", { evidenceId: "3".repeat(64) });
  assert.equal(notices(HELPER, [t, ok, t, ok]).length, 2);
  assert.equal(notices(HELPER, [t, ok], [], { limit: 1 }).length, 1);
});

test("a notice is never dated later than when it was first seen, so a future date cannot turn it unread again", () => {
  const t = task();
  const future = step(
    MATE,
    t,
    "confirm",
    { evidenceId: "3".repeat(64) },
    NOW + 1_000,
  );
  const at = (now, firstSeen) =>
    notices(HELPER, [t, future], [], { now, firstSeen }).find(
      (x) => x.part === "confirm",
    ).at;
  // First sight: dated now, and that moment is what is kept.
  assert.equal(at(NOW), NOW);
  const kept = nextFirstSeen(new Map(), [future.id], NOW);
  assert.deepEqual([...kept], [[future.id, NOW]]);
  // The person reads it (seen up to NOW). Later, when the record's own date has come round, it is still dated NOW.
  assert.equal(at(NOW + 5_000, kept), NOW);
  // Without the kept time it would have moved to the record's date: after "seen", that is unread again.
  assert.equal(at(NOW + 5_000), NOW + 1_000);
  // A record dated in the past keeps its own date.
  const past = step(MATE, t, "cancel", { note: "x" }, NOW - 500);
  assert.equal(
    notices(HELPER, [t, past], [], {
      firstSeen: new Map([[past.id, NOW]]),
    }).find((x) => x.part === "cancel").at,
    NOW - 500,
  );
  // Nothing new to remember: nothing is written. The store stays bounded.
  assert.equal(nextFirstSeen(kept, [future.id], NOW + 9), null);
  const many = nextFirstSeen(
    new Map(),
    Array.from({ length: 500 }, (_, i) => `id${i}`),
    NOW,
  );
  assert.equal(many.size, 400);
});
