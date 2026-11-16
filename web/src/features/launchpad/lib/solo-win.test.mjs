import assert from "node:assert/strict";
import test from "node:test";

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import { sendOnce } from "./send-once.ts";
import {
  CHECK_RETRY_MS,
  pendingSoloWins,
  runSoloWin,
  SoloRefusedError,
  soloWinRefusal,
} from "./solo-win.ts";
import { onOpenSoloWin, openSoloWin } from "./solo-win-events.ts";
import {
  parseTaskRecord,
  projectTasks,
  taskEvent,
  taskStepEvent,
} from "./tasks.ts";

/**
 * The solo flow is driven through its real runner, with the real record builders (`taskEvent`, `taskStepEvent`) and
 * the real `sendOnce` that the task mutations use, over a stand-in relay. The three steps are wired exactly as the
 * hook wires them: make, hand in, check (which re-reads the hand-in first, as `stillAsRead` does).
 */

const FOUNDER = "f".repeat(64);
const PIA = "d".repeat(64);
const BOT = "a".repeat(64);
const COORD = `37001:${FOUNDER}:demo`;
const NOW = 1_794_312_000;

const kinds = (stored) => ({
  tasks: stored.filter((e) =>
    e.tags.some((t) => t[0] === "task-part" && t[1] === "task"),
  ).length,
  handIns: stored.filter((e) =>
    e.tags.some((t) => t[0] === "task-part" && t[1] === "evidence"),
  ).length,
  checks: stored.filter((e) =>
    e.tags.some((t) => t[0] === "task-part" && t[1] === "confirm"),
  ).length,
});

function memory() {
  const map = new Map();
  return {
    get: (k) => map.get(k) ?? null,
    set: (k, v) => void map.set(k, v),
    remove: (k) => void map.delete(k),
    map,
  };
}

/**
 * A relay stand-in and the three steps. `publishHook(record, count)` runs before a record is stored and may throw to
 * stand for a failed send; `lost` makes a send arrive but lose its answer.
 */
function world({
  publishHook = () => {},
  evidenceLag = 0,
  lost = () => false,
} = {}) {
  const stored = [];
  const sendStore = memory();
  let published = 0;
  let lag = evidenceLag;
  const send = (key, event) =>
    sendOnce({
      key: `${COORD}:${key}`,
      signer: FOUNDER,
      template: {
        kind: 47003,
        tags: [["a", COORD], ...event.tags],
        content: JSON.stringify(event.content),
      },
      store: sendStore,
      sign: async (template) => {
        const base = {
          ...template,
          pubkey: FOUNDER,
          created_at: NOW + stored.length,
        };
        const id = bytesToHex(
          sha256(
            new TextEncoder().encode(JSON.stringify([base, Math.random()])),
          ),
        );
        return { ...base, id, sig: "sig" };
      },
      publish: async (record) => {
        published += 1;
        publishHook(record, published);
        stored.push(record);
        if (lost(record, published)) throw new Error("answer lost");
        return { accepted: true };
      },
      exists: async (id) => stored.some((e) => e.id === id),
    }).then(({ adopted, event }) => ({ adopted, id: event.id }));

  const steps = {
    make: ({ helper, what, done }) =>
      send(
        "make:direct",
        taskEvent({ helper, what, done, size: "small", due: null }),
      ),
    handIn: (task, { note, links }) =>
      send(
        `evidence:${task.id}`,
        taskStepEvent({
          part: "evidence",
          taskId: task.id,
          tell: [],
          note,
          links,
          files: [],
        }),
      ),
    check: async (task, { evidenceId, seen }) => {
      // `stillAsRead`: the piece must be there, and nothing may have arrived that was not shown.
      if (lag > 0 || !stored.some((e) => e.id === evidenceId)) {
        lag -= 1;
        const gone = new Error("evidence gone");
        gone.name = "EvidenceGoneError";
        throw gone;
      }
      const there = stored.filter(
        (e) =>
          e.tags.some((t) => t[0] === "task-part" && t[1] === "evidence") &&
          e.tags.some((t) => t[0] === "task" && t[1] === task.id),
      );
      if (there.some((e) => !seen.includes(e.id)))
        throw new Error("evidence changed");
      return send(
        `confirm:${evidenceId}`,
        taskStepEvent({
          part: "confirm",
          taskId: task.id,
          tell: [],
          evidenceId,
        }),
      );
    },
  };
  return { stored, steps, store: memory() };
}

/** True the first time it is asked of a world, false after. */
function once(w) {
  if (w.lostOnce) return false;
  w.lostOnce = true;
  return true;
}

const who = (over = {}) => ({
  viewer: FOUNDER,
  founder: FOUNDER,
  team: new Set([FOUNDER]),
  viewerIsAgent: false,
  ...over,
});
const request = { start: "full", text: "Wrote the first page", link: null };
const run = (w, extra = {}) =>
  runSoloWin({
    who: who(),
    coordinate: COORD,
    request,
    steps: w.steps,
    store: w.store,
    sleep: async () => {},
    ...extra,
  });

test("the whole sequence: one task, one hand-in, one check, and the record reads as done, checked by the founder", async () => {
  const w = world();
  const result = await run(w, {
    request: { ...request, link: "https://example.org/page" },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(kinds(w.stored), { tasks: 1, handIns: 1, checks: 1 });
  const [task] = projectTasks({
    records: w.stored.flatMap((e) => parseTaskRecord(e) ?? []),
    coordinate: COORD,
    team: new Set([FOUNDER]),
    now: NOW + 100,
  });
  assert.equal(task.helper, FOUNDER);
  // The line is the request and "Done means"; small; no due date, no limits.
  assert.equal(task.what, "Wrote the first page");
  assert.equal(task.done, "Wrote the first page");
  assert.equal(task.size, "small");
  assert.equal(task.due, null);
  assert.equal(task.limits, "");
  assert.equal(task.state, "confirmed");
  assert.equal(task.selfChecked, true);
  assert.equal(task.evidence[0].note, "Wrote the first page");
  assert.deepEqual(task.evidence[0].links, ["https://example.org/page"]);
  assert.deepEqual(pendingSoloWins(w.store, COORD), []);
});

test("a failure after the task is made: the retry hands in and checks, and nothing is made twice", async () => {
  // The second record sent is the hand-in: it fails.
  const w = world({
    publishHook: (_record, count) => {
      if (count === 2 && !w.failedOnce) {
        w.failedOnce = true;
        throw new Error("network");
      }
    },
  });
  const first = await run(w);
  assert.equal(first.ok, false);
  assert.equal(first.stage, "hand-in");
  assert.equal(first.reached, "made");
  // The task stands; it is not done.
  assert.deepEqual(kinds(w.stored), { tasks: 1, handIns: 0, checks: 0 });
  // Where it got to is kept, under the project and the task.
  const kept = pendingSoloWins(w.store, COORD);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].stage, "hand-in");
  assert.equal(kept[0].task.id, first.pending.task.id);
  const retried = await run(w, { from: first.pending });
  assert.equal(retried.ok, true);
  assert.deepEqual(kinds(w.stored), { tasks: 1, handIns: 1, checks: 1 });
  assert.deepEqual(pendingSoloWins(w.store, COORD), []);
});

test("a failure after the work is handed in: the retry only checks it, and the hand-in is not sent again", async () => {
  const w = world({
    publishHook: (_record, count) => {
      if (count === 3 && !w.failedOnce) {
        w.failedOnce = true;
        throw new Error("network");
      }
    },
  });
  const first = await run(w);
  assert.equal(first.ok, false);
  assert.equal(first.stage, "check");
  assert.equal(first.reached, "handed-in");
  assert.deepEqual(kinds(w.stored), { tasks: 1, handIns: 1, checks: 0 });
  // The tab reloads: the kept step is found again, and the retry carries on from it.
  const [kept] = pendingSoloWins(w.store, COORD);
  assert.equal(kept.stage, "check");
  assert.equal(kept.evidenceId, first.pending.evidenceId);
  const retried = await run(w, { from: kept });
  assert.equal(retried.ok, true);
  assert.deepEqual(kinds(w.stored), { tasks: 1, handIns: 1, checks: 1 });
});

test("a send that arrived but lost its answer is adopted on the retry, not made again", async () => {
  // The hand-in arrives and its answer is lost.
  const w = world({
    lost: (_record, count) => count === 2 && once(w),
  });
  const first = await run(w);
  assert.equal(first.ok, false);
  assert.equal(first.stage, "hand-in");
  assert.deepEqual(kinds(w.stored), { tasks: 1, handIns: 1, checks: 0 });
  const retried = await run(w, { from: first.pending });
  assert.equal(retried.ok, true);
  assert.deepEqual(kinds(w.stored), { tasks: 1, handIns: 1, checks: 1 });
});

test("a task whose make failed is made once when the same words are sent again", async () => {
  const w = world({
    lost: (_record, count) => count === 1 && once(w),
  });
  const first = await run(w);
  assert.equal(first.ok, false);
  assert.equal(first.stage, "make");
  assert.equal(first.reached, "nothing");
  assert.equal(first.pending, null);
  // The task did arrive. The same words again find it instead of making a second.
  const again = await run(w);
  assert.equal(again.ok, true);
  assert.deepEqual(kinds(w.stored), { tasks: 1, handIns: 1, checks: 1 });
});

test("the check waits for the hand-in to show, a few tries, then reports a failure", async () => {
  const slept = [];
  const slow = world({ evidenceLag: 2 });
  const ok = await run(slow, { sleep: async (ms) => void slept.push(ms) });
  assert.equal(ok.ok, true);
  assert.deepEqual(slept, [CHECK_RETRY_MS[0], CHECK_RETRY_MS[1]]);
  assert.deepEqual(kinds(slow.stored), { tasks: 1, handIns: 1, checks: 1 });

  const never = world({ evidenceLag: 99 });
  const waits = [];
  const failed = await run(never, { sleep: async (ms) => void waits.push(ms) });
  assert.equal(failed.ok, false);
  assert.equal(failed.stage, "check");
  assert.equal(failed.error.name, "EvidenceGoneError");
  assert.deepEqual(waits, [...CHECK_RETRY_MS]);
  // Never a half-done task shown as done: no check was written.
  assert.deepEqual(kinds(never.stored), { tasks: 1, handIns: 1, checks: 0 });
});

test("finishing a task the founder already has: hand in and check, no new task", async () => {
  const w = world();
  const made = await w.steps.make({
    helper: FOUNDER,
    what: "Draw the map",
    done: "A map",
  });
  const task = { id: made.id, helper: FOUNDER, madeBy: FOUNDER };
  const result = await run(w, {
    request: {
      start: "finish",
      text: "Drew it",
      link: null,
      task,
      seenEvidence: [],
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(kinds(w.stored), { tasks: 1, handIns: 1, checks: 1 });
});

test("an agent account is refused and nothing is sent", async () => {
  const w = world();
  await assert.rejects(
    run(w, { who: who({ viewerIsAgent: true }) }),
    (error) => error instanceof SoloRefusedError && error.refusal === "agent",
  );
  assert.deepEqual(w.stored, []);
  assert.equal(soloWinRefusal(who({ viewerIsAgent: true })), "agent");
});

test("a founder with another person on the project is refused, and a team of agents is not another person", async () => {
  const w = world();
  const team = new Set([FOUNDER, PIA]);
  await assert.rejects(
    run(w, { who: who({ team }) }),
    (error) =>
      error instanceof SoloRefusedError && error.refusal === "not-alone",
  );
  assert.deepEqual(w.stored, []);
  // Pia is a person unless her profile says otherwise.
  assert.equal(soloWinRefusal(who({ team, agents: new Set([PIA]) })), null);
  assert.equal(
    soloWinRefusal(
      who({ team: new Set([FOUNDER, BOT]), agents: new Set([BOT]) }),
    ),
    null,
  );
  assert.equal(
    soloWinRefusal(who({ team: new Set([FOUNDER, BOT]) })),
    "not-alone",
  );
});

test("only the founder, signed in, finishing their own task", () => {
  assert.equal(soloWinRefusal(who({ viewer: null })), "signed-out");
  assert.equal(
    soloWinRefusal(who({ viewer: PIA, team: new Set([FOUNDER, PIA]) })),
    "not-founder",
  );
  const task = (helper) => ({ id: "1".repeat(64), helper, madeBy: FOUNDER });
  assert.equal(
    soloWinRefusal(who(), { start: "finish", task: task(BOT) }),
    "not-your-task",
  );
  assert.equal(soloWinRefusal(who(), { start: "finish" }), "not-your-task");
  assert.equal(
    soloWinRefusal(who(), { start: "finish", task: task(FOUNDER) }),
    null,
  );
  assert.equal(soloWinRefusal(who(), { start: "full" }), null);
});

test("the kept step is per project and per task, and storage that throws loses nothing but the memory", async () => {
  const w = world({
    publishHook: (_record, count) => {
      if (count === 2) throw new Error("network");
    },
  });
  const first = await run(w);
  assert.equal(pendingSoloWins(w.store, COORD).length, 1);
  assert.deepEqual(pendingSoloWins(w.store, `37001:${FOUNDER}:other`), []);
  // A store that throws on every call: the run still ends in its result, with the step it stopped at.
  const broken = {
    get: () => {
      throw new Error("blocked");
    },
    set: () => {
      throw new Error("blocked");
    },
    remove: () => {
      throw new Error("blocked");
    },
  };
  const w2 = world({
    publishHook: (_record, count) => {
      if (count === 2) throw new Error("network");
    },
  });
  const second = await run(w2, { store: broken });
  assert.equal(second.ok, false);
  assert.equal(second.stage, "hand-in");
  assert.equal(second.pending.stage, "hand-in");
  assert.deepEqual(pendingSoloWins(broken, COORD), []);
  assert.equal(first.pending.stage, "hand-in");
});

test("openSoloWin carries the words or the task to whoever listens, and stops when asked", () => {
  const target = new EventTarget();
  const heard = [];
  const stop = onOpenSoloWin((open) => heard.push(open), target);
  openSoloWin({ text: "Ship the beta" }, target);
  openSoloWin({ taskId: "1".repeat(64) }, target);
  openSoloWin({}, target);
  assert.deepEqual(heard, [
    { text: "Ship the beta" },
    { taskId: "1".repeat(64) },
    {},
  ]);
  stop();
  openSoloWin({ text: "again" }, target);
  assert.equal(heard.length, 3);
});
