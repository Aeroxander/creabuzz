import assert from "node:assert/strict";
import test from "node:test";

import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

import { buildLaunches } from "../models.ts";
import {
  acceptedTasks,
  confirmRule,
  dueLine,
  isTaskRecordTags,
  openTasks,
  parseTaskRecord,
  projectTasks,
  readLinks,
  REWARDS_LINE,
  TASK_LABEL,
  taskEvent,
  taskProblem,
  taskStepEvent,
  validDate,
  validLink,
} from "./tasks.ts";

const FOUNDER = "f".repeat(64);
const MATE = "c".repeat(64);
const HELPER = "a".repeat(64);
const STRANGER = "b".repeat(64);
const COORD = `37001:${FOUNDER}:demo`;
const TEAM = new Set([FOUNDER, MATE]);
const DAY = 86_400;
// 2026-11-10T12:00:00Z
const NOW = 1_794_312_000;

let n = 0;
/** A signed record as the server returns it, from what a builder made. */
function signed(pubkey, built, at = NOW - DAY, extra = [], coordinate = COORD) {
  n += 1;
  return {
    id: n.toString(16).padStart(64, "0"),
    pubkey,
    created_at: at,
    kind: 47003,
    tags: [["a", coordinate], ...built.tags, ...extra],
    content: JSON.stringify(built.content),
    sig: "sig",
  };
}
const TASK = {
  helper: HELPER,
  what: "Test sign-up on an older phone.",
  done: "A screen recording of sign-up working on Android 9.",
  size: "small",
};
const make = (who = FOUNDER, over = {}, at) =>
  signed(who, taskEvent({ ...TASK, ...over }), at);
const step = (who, task, part, over = {}, at, extra) =>
  signed(
    who,
    taskStepEvent({ part, taskId: task.id, tell: [], ...over }),
    at,
    extra,
  );
const hand = (task, over = {}, at) =>
  step(
    HELPER,
    task,
    "evidence",
    { links: ["https://example.org/a"], ...over },
    at,
  );
const view = (events, over = {}) =>
  projectTasks({
    records: events.flatMap((e) => parseTaskRecord(e) ?? []),
    coordinate: COORD,
    team: TEAM,
    now: NOW,
    ...over,
  });
const one = (events, over) => {
  const tasks = view(events, over);
  assert.equal(tasks.length, 1);
  return tasks[0];
};

test("a task record carries its fields as tags and reads back; it names no amount", () => {
  const event = make(FOUNDER, {
    due: "2026-12-01",
    updateId: "1".repeat(64),
    offerId: "2".repeat(64),
  });
  assert.deepEqual(
    event.tags.filter((t) => t[0] === "l"),
    [["l", TASK_LABEL]],
  );
  assert.deepEqual(
    event.tags.filter((t) => t[0] === "p"),
    [["p", HELPER]],
  );
  const record = parseTaskRecord(event);
  assert.equal(record.part, "task");
  assert.equal(record.helper, HELPER);
  assert.equal(record.what, TASK.what);
  assert.equal(record.done, TASK.done);
  assert.equal(record.size, "small");
  assert.equal(record.due, "2026-12-01");
  assert.equal(record.updateId, "1".repeat(64));
  assert.equal(record.offerId, "2".repeat(64));
  assert.equal(record.taskId, event.id);
  assert.equal(isTaskRecordTags(event.tags), true);
  assert.doesNotMatch(JSON.stringify(event), /share|amount|reward|\$/i);
  assert.match(REWARDS_LINE, /decided separately/);
});

test("a task without a finish line, a helper or a size is not a task", () => {
  const good = make();
  const without = (name) => ({
    ...good,
    tags: good.tags.filter((t) => t[0] !== name),
  });
  assert.equal(parseTaskRecord(without("task-done")), null);
  assert.equal(parseTaskRecord(without("task-helper")), null);
  assert.equal(parseTaskRecord(without("task-size")), null);
  assert.equal(parseTaskRecord(without("task-what")), null);
  assert.equal(parseTaskRecord(without("a")), null);
  // Two steps in one record is neither.
  assert.equal(
    parseTaskRecord({
      ...good,
      tags: [...good.tags, ["task-part", "confirm"]],
    }),
    null,
  );
});

test("steps that need a reason or a target are refused without one", () => {
  const task = make();
  assert.equal(
    parseTaskRecord(
      step(MATE, task, "send-back", { evidenceId: "3".repeat(64) }),
    ),
    null,
  );
  assert.equal(
    parseTaskRecord(step(MATE, task, "send-back", { note: "No recording." })),
    null,
  );
  assert.equal(parseTaskRecord(step(MATE, task, "confirm")), null);
  assert.equal(parseTaskRecord(step(MATE, task, "cancel")), null);
  assert.equal(parseTaskRecord(step(HELPER, task, "more-time")), null);
  assert.equal(parseTaskRecord(step(HELPER, task, "evidence")), null);
  assert.equal(
    parseTaskRecord(step(MATE, task, "grant", { askId: "3".repeat(64) })),
    null,
  );
  assert.ok(parseTaskRecord(step(HELPER, task, "evidence", { note: "Done." })));
});

test("evidence keeps web links and file fingerprints, and drops anything else", () => {
  const task = make();
  const event = step(HELPER, task, "evidence", {
    note: "Recorded it.",
    links: [
      "https://example.org/a",
      "javascript:alert(1)",
      "https://example.org/a",
      "not a link",
    ],
    files: [
      {
        hash: "9".repeat(64),
        name: "sign-up.mp4",
        url: "https://files.example/9",
      },
      { hash: "short", name: "bad", url: "" },
    ],
  });
  const record = parseTaskRecord(event);
  assert.deepEqual(record.links, ["https://example.org/a"]);
  assert.deepEqual(record.files, [
    {
      hash: "9".repeat(64),
      name: "sign-up.mp4",
      url: "https://files.example/9",
    },
  ]);
  assert.equal(record.note, "Recorded it.");
  // A forged tag with a script link is not shown as a link either.
  const forged = {
    ...event,
    tags: [...event.tags, ["task-link", "javascript:alert(2)"]],
  };
  assert.deepEqual(parseTaskRecord(forged).links, ["https://example.org/a"]);
});

test("a task from an offer is in progress; one given directly waits for the helper's yes", () => {
  const offerId = "2".repeat(64);
  const fromOffer = make(FOUNDER, { offerId });
  assert.equal(
    one([fromOffer], { offers: new Map([[offerId, HELPER]]) }).state,
    "in-progress",
  );
  assert.equal(
    one([fromOffer], { offers: new Map([[offerId, HELPER]]) }).agreed,
    "offer",
  );
  // The offer was taken back, or was someone else's: the helper has not agreed.
  assert.equal(one([fromOffer], { offers: new Map() }).state, "offered");
  assert.equal(
    one([fromOffer], { offers: new Map([[offerId, STRANGER]]) }).state,
    "offered",
  );

  const direct = make();
  assert.equal(one([direct]).state, "offered");
  assert.equal(one([direct]).agreed, null);
  // Only the helper's own yes counts.
  assert.equal(
    one([direct, step(STRANGER, direct, "accept")]).state,
    "offered",
  );
  assert.equal(one([direct, step(FOUNDER, direct, "accept")]).state, "offered");
  assert.equal(
    one([direct, step(HELPER, direct, "accept")]).state,
    "in-progress",
  );
});

test("only the project's team can make its tasks", () => {
  assert.equal(view([make(STRANGER)]).length, 0);
  assert.equal(view([make(HELPER)]).length, 0);
  assert.equal(view([make(MATE)]).length, 1);
  // A task record that names another project is not this project's.
  const elsewhere = signed(
    FOUNDER,
    taskEvent(TASK),
    NOW,
    [],
    `37001:${FOUNDER}:other`,
  );
  assert.equal(view([elsewhere]).length, 0);
});

test("the full loop: handed in, sent back, handed in again, confirmed", () => {
  const task = make();
  const yes = step(HELPER, task, "accept");
  const first = hand(task, { note: "First try." }, NOW - 5 * DAY);
  assert.equal(one([task, yes, first]).state, "submitted");
  assert.equal(one([task, yes, first]).waiting.id, first.id);

  const back = step(MATE, task, "send-back", {
    evidenceId: first.id,
    note: "No recording.",
  });
  const sentBack = one([task, yes, first, back]);
  assert.equal(sentBack.state, "sent-back");
  assert.equal(sentBack.waiting, null);
  assert.equal(sentBack.evidence[0].sentBack[0].note, "No recording.");

  const second = hand(task, { note: "With the recording." }, NOW - 2 * DAY);
  const again = one([task, yes, first, back, second]);
  assert.equal(again.state, "submitted");
  assert.equal(again.waiting.id, second.id);

  const ok = step(MATE, task, "confirm", { evidenceId: second.id }, NOW - DAY);
  const done = one([task, yes, first, back, second, ok]);
  assert.equal(done.state, "confirmed");
  assert.equal(done.accepted.id, second.id);
  assert.equal(done.accepted.by, MATE);
  assert.equal(done.accepted.confirmedAt, NOW - DAY);
  assert.deepEqual(done.accepted.links, ["https://example.org/a"]);
  assert.equal(done.late, false);
});

test("the state does not depend on the order records arrive in, or on the dates they carry", () => {
  const task = make();
  const first = hand(task, {}, NOW + 99 * DAY); // dated far in the future
  const back = step(
    MATE,
    task,
    "send-back",
    { evidenceId: first.id, note: "No." },
    1,
  );
  const second = hand(task, { note: "Again." }, 2); // dated long before everything
  const ok = step(MATE, task, "confirm", { evidenceId: second.id }, 3);
  const all = [task, first, back, second, ok];
  const forward = one(all);
  const backward = one([...all].reverse());
  assert.equal(forward.state, "confirmed");
  assert.equal(backward.state, "confirmed");
  assert.equal(forward.accepted.id, second.id);
  assert.equal(backward.accepted.id, second.id);
  // The first piece was sent back whatever date it claims: a future date does not make it "the newest, unanswered".
  assert.equal(one([task, first, back]).state, "sent-back");
});

test("the person who did the work can never confirm it", () => {
  const task = make();
  const work = hand(task);
  const self = step(HELPER, task, "confirm", { evidenceId: work.id });
  const mine = one([task, work, self]);
  assert.equal(mine.state, "submitted");
  assert.equal(mine.accepted, null);
  assert.equal(mine.ignoredConfirmation, true);
  // Nor can someone who is not on the team.
  assert.equal(
    one([task, work, step(STRANGER, task, "confirm", { evidenceId: work.id })])
      .state,
    "submitted",
  );
});

test("when the founder is the helper, another team member must confirm", () => {
  const task = make(FOUNDER, { helper: FOUNDER });
  const work = signed(
    FOUNDER,
    taskStepEvent({
      part: "evidence",
      taskId: task.id,
      tell: [],
      note: "Did it.",
    }),
  );
  const self = step(FOUNDER, task, "confirm", { evidenceId: work.id });
  // Their own task needs no yes from them.
  assert.equal(one([task]).agreed, "self");
  assert.equal(one([task, work, self]).state, "submitted");
  assert.equal(
    one([
      task,
      work,
      self,
      step(MATE, task, "confirm", { evidenceId: work.id }),
    ]).state,
    "confirmed",
  );

  const view = one([task, work]);
  assert.deepEqual(confirmRule(view, TEAM, FOUNDER), {
    may: false,
    why: "helper",
    someoneCan: true,
  });
  assert.deepEqual(confirmRule(view, TEAM, MATE), { may: true });
  // A team of one: nobody can confirm, and the rule says so.
  const solo = new Set([FOUNDER]);
  assert.deepEqual(confirmRule(view, solo, FOUNDER), {
    may: false,
    why: "helper",
    someoneCan: false,
  });
  assert.equal(one([task, work, self], { team: solo }).state, "submitted");
  assert.deepEqual(confirmRule(view, TEAM, STRANGER), {
    may: false,
    why: "not-team",
    someoneCan: true,
  });
  assert.deepEqual(confirmRule(view, TEAM, null), {
    may: false,
    why: "signed-out",
    someoneCan: true,
  });
});

test("a team member's own send-back, grant or cancel on their own task does not count", () => {
  const task = make(FOUNDER, { helper: MATE });
  const work = signed(
    MATE,
    taskStepEvent({
      part: "evidence",
      taskId: task.id,
      tell: [],
      note: "Did it.",
    }),
  );
  const ask = signed(
    MATE,
    taskStepEvent({
      part: "more-time",
      taskId: task.id,
      tell: [],
      note: "Ill.",
    }),
  );
  const selfGrant = step(MATE, task, "grant", {
    askId: ask.id,
    due: "2027-01-01",
  });
  const got = one([
    task,
    work,
    ask,
    selfGrant,
    step(MATE, task, "confirm", { evidenceId: work.id }),
  ]);
  assert.equal(got.state, "submitted");
  assert.equal(got.due, null);
  assert.equal(got.moreTime[0].granted, null);
});

test("an agent's confirmation does not count, and neither does one from whoever runs the helper", () => {
  const ownerKey = "7".repeat(64);
  const owner = bytesToHex(schnorr.getPublicKey(hexToBytes(ownerKey)));
  const proof = (agent) => {
    const conditions = "kind=47003";
    const digest = sha256(
      new TextEncoder().encode(`nostr:agent-auth:${agent}:${conditions}`),
    );
    return [
      "auth",
      owner,
      conditions,
      bytesToHex(schnorr.sign(digest, hexToBytes(ownerKey))),
    ];
  };
  const team = new Set([FOUNDER, MATE, owner]);
  const task = make();
  // The helper is an agent, and its records prove who runs it.
  const work = signed(
    HELPER,
    taskStepEvent({
      part: "evidence",
      taskId: task.id,
      tell: [],
      note: "Done.",
    }),
    NOW,
    [["agent", HELPER], proof(HELPER)],
  );
  const byOwner = step(owner, task, "confirm", { evidenceId: work.id });
  const held = one([task, work, byOwner], { team });
  assert.deepEqual(held.helperAgent, { owner });
  assert.equal(held.state, "submitted");
  assert.equal(held.ignoredConfirmation, true);
  assert.deepEqual(confirmRule(held, team, owner), {
    may: false,
    why: "runs-helper",
    someoneCan: true,
  });
  // Someone else on the team can.
  assert.equal(
    one(
      [
        task,
        work,
        byOwner,
        step(MATE, task, "confirm", { evidenceId: work.id }),
      ],
      { team },
    ).state,
    "confirmed",
  );

  // A confirmation that says an agent signed it is not a person's yes.
  const plain = hand(task);
  const byAgent = step(MATE, task, "confirm", { evidenceId: plain.id }, NOW, [
    ["agent", MATE],
  ]);
  assert.equal(one([task, plain, byAgent]).state, "submitted");
});

test("a confirmation that names work which is not there accepts nothing", () => {
  const task = make();
  const work = hand(task);
  const ghost = step(MATE, task, "confirm", { evidenceId: "e".repeat(64) });
  const got = one([task, work, ghost]);
  assert.equal(got.state, "submitted");
  assert.equal(got.confirmedWithoutEvidence, true);
  // Deleted evidence: the confirmation is left naming nothing.
  const ok = step(MATE, task, "confirm", { evidenceId: work.id });
  const after = one([task, step(HELPER, task, "accept"), ok]);
  assert.equal(after.state, "in-progress");
  assert.equal(after.accepted, null);
  assert.equal(after.confirmedWithoutEvidence, true);
  // Work handed in on another task cannot be confirmed onto this one.
  const other = make();
  const theirs = hand(other);
  assert.equal(
    one([task, step(MATE, task, "confirm", { evidenceId: theirs.id })]).state,
    "offered",
  );
});

test("answers that disagree are both kept, and the work is not counted as accepted", () => {
  const task = make();
  const work = hand(task);
  const ok = step(FOUNDER, task, "confirm", { evidenceId: work.id });
  const back = step(MATE, task, "send-back", {
    evidenceId: work.id,
    note: "Not what was asked.",
  });
  for (const events of [
    [task, work, ok, back],
    [task, back, ok, work],
  ]) {
    const got = one(events);
    assert.equal(got.state, "sent-back");
    assert.equal(got.disagreement, true);
    assert.equal(got.accepted, null);
    assert.equal(got.evidence[0].confirmed.length, 1);
    assert.equal(got.evidence[0].sentBack.length, 1);
  }
});

test("duplicates change nothing", () => {
  const task = make();
  const work = hand(task);
  const ok = step(MATE, task, "confirm", { evidenceId: work.id });
  const again = step(MATE, task, "confirm", { evidenceId: work.id });
  const got = one([task, task, work, work, ok, ok, again]);
  assert.equal(got.state, "confirmed");
  assert.equal(got.evidence.length, 1);
  assert.equal(got.evidence[0].confirmed.length, 2);
});

test("a confirmation outlasts a later cancel or give-up; without one, either closes the task", () => {
  const task = make();
  const work = hand(task);
  const ok = step(MATE, task, "confirm", { evidenceId: work.id });
  const cancel = step(FOUNDER, task, "cancel", { note: "Changed plans." });
  const quit = step(HELPER, task, "give-up", { note: "No time." });
  assert.equal(one([task, work, ok, cancel, quit]).state, "confirmed");
  assert.equal(one([task, work, cancel]).state, "cancelled");
  assert.equal(one([task, work, cancel]).cancelled.note, "Changed plans.");
  assert.equal(one([task, work, quit]).state, "given-up");
  // Only the helper gives up; only the team cancels.
  assert.equal(
    one([task, work, step(STRANGER, task, "give-up")]).state,
    "submitted",
  );
  assert.equal(
    one([task, work, step(STRANGER, task, "cancel", { note: "x" })]).state,
    "submitted",
  );
  assert.equal(
    one([task, work, step(HELPER, task, "cancel", { note: "x" })]).state,
    "submitted",
  );
});

test("late is said for an open task past its date, and more time moves the date only when the team gives it", () => {
  const task = make(FOUNDER, { due: "2026-11-01" });
  const yes = step(HELPER, task, "accept");
  const late = one([task, yes]);
  assert.equal(late.late, true);
  assert.equal(
    dueLine(late, (d) => d),
    "Late: was due 2026-11-01",
  );
  // Not yet agreed: nobody is late.
  assert.equal(one([task]).late, false);
  // Handed in: the wait is the team's.
  assert.equal(one([task, yes, hand(task)]).late, false);

  const ask = step(HELPER, task, "more-time", {
    note: "Phone broke.",
    due: "2026-12-01",
  });
  const asked = one([task, yes, ask]);
  assert.equal(asked.late, true);
  assert.equal(asked.moreTime[0].wanted, "2026-12-01");
  assert.equal(asked.moreTime[0].granted, null);
  // The helper cannot give themselves time, and a stranger cannot either.
  for (const who of [HELPER, STRANGER])
    assert.equal(
      one([
        task,
        yes,
        ask,
        step(who, task, "grant", { askId: ask.id, due: "2026-12-01" }),
      ]).late,
      true,
    );
  const given = one([
    task,
    yes,
    ask,
    step(MATE, task, "grant", { askId: ask.id, due: "2026-11-20" }),
  ]);
  assert.equal(given.late, false);
  assert.equal(given.due, "2026-11-20");
  assert.equal(given.moreTime[0].granted.by, MATE);
  assert.equal(
    dueLine(given, (d) => d),
    "Due 2026-11-20",
  );
  // A grant that answers no ask of this task moves nothing.
  assert.equal(
    one([
      task,
      yes,
      step(MATE, task, "grant", { askId: "9".repeat(64), due: "2027-01-01" }),
    ]).due,
    "2026-11-01",
  );
  assert.equal(
    dueLine(one([make()]), (d) => d),
    null,
  );
});

test("open tasks list late ones first and never order by a signer's date; accepted ones clamp future dates", () => {
  const soon = make(FOUNDER, { due: "2026-11-20" }, NOW + 50 * DAY);
  const late = make(FOUNDER, { due: "2026-11-01" }, 1);
  const none = make(FOUNDER, {}, NOW + 99 * DAY);
  const events = [none, soon, late].flatMap((t) => [
    t,
    step(HELPER, t, "accept"),
  ]);
  assert.deepEqual(
    openTasks(view(events)).map((t) => t.id),
    [late.id, soon.id, none.id],
  );

  const a = make();
  const b = make();
  const wa = hand(a);
  const wb = hand(b);
  const done = view([
    a,
    b,
    wa,
    wb,
    step(MATE, a, "confirm", { evidenceId: wa.id }, NOW - DAY),
    // Dated a year ahead to sit on top: it counts as now, and the tie falls to the id.
    step(MATE, b, "confirm", { evidenceId: wb.id }, NOW + 365 * DAY),
  ]);
  assert.deepEqual(
    acceptedTasks(done, NOW).map((t) => t.id),
    [b.id, a.id],
  );
  const future = view([
    a,
    b,
    wa,
    wb,
    step(MATE, a, "confirm", { evidenceId: wa.id }, NOW),
    step(MATE, b, "confirm", { evidenceId: wb.id }, NOW + 365 * DAY),
  ]);
  assert.deepEqual(
    acceptedTasks(future, NOW).map((t) => t.id),
    [a.id, b.id],
  );
});

test("task records are never listed as a project's updates", () => {
  const record = {
    id: "0".repeat(63) + "1",
    pubkey: FOUNDER,
    created_at: NOW - 30 * DAY,
    kind: 37001,
    tags: [
      ["d", "demo"],
      ["name", "Demo"],
    ],
    content: "{}",
    sig: "sig",
  };
  const task = make();
  const launches = buildLaunches([
    record,
    task,
    hand(task),
    step(MATE, task, "cancel", { note: "x" }),
  ]);
  assert.equal(launches.length, 1);
  assert.equal(launches[0].updates.length, 0);
});

test("dates, links and a draft's problems", () => {
  assert.equal(validDate("2026-12-01"), "2026-12-01");
  assert.equal(validDate("2026-02-30"), null);
  assert.equal(validDate("tomorrow"), null);
  assert.equal(validLink(" https://example.org/x "), "https://example.org/x");
  assert.equal(validLink("ftp://example.org"), null);
  assert.deepEqual(
    readLinks("https://a.example\nnope https://a.example https://b.example"),
    {
      links: ["https://a.example", "https://b.example"],
      bad: ["nope"],
    },
  );
  const ok = { what: "Do it", done: "It works", due: "", today: "2026-11-10" };
  assert.equal(taskProblem(ok), null);
  assert.equal(taskProblem({ ...ok, done: "  " }).field, "done");
  assert.equal(taskProblem({ ...ok, what: "" }).field, "what");
  assert.equal(taskProblem({ ...ok, due: "2026-11-09" }).field, "due");
  assert.equal(taskProblem({ ...ok, due: "2026-11-10" }), null);
});
