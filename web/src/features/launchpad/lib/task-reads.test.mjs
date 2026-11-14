import assert from "node:assert/strict";
import test from "node:test";

import { eventMatchesFilter } from "../../../shared/lib/filter-match.ts";
import { parseLaunchRecord } from "../models.ts";
import { teamOf } from "./help-request.ts";
import {
  readPersonTasks,
  readProjectTasks,
  TRACK_PROJECTS,
} from "./task-reads.ts";
import {
  parseTaskRecord,
  projectTasks,
  taskEvent,
  taskStepEvent,
} from "./tasks.ts";
import { helperRecord } from "./track-record.ts";

const FOUNDER = "f".repeat(64);
const MATE = "c".repeat(64);
const HELPER = "a".repeat(64);
const STRANGER = "b".repeat(64);
const COORD = `37001:${FOUNDER}:demo`;
const NOW = 1_794_312_000;

let n = 0;
const id = () => {
  n += 1;
  return n.toString(16).padStart(64, "0");
};
const ev = (pubkey, built, at = NOW - 100, coordinate = COORD) => ({
  id: id(),
  pubkey,
  created_at: at,
  kind: 47003,
  tags: [["a", coordinate], ...built.tags],
  content: JSON.stringify(built.content),
  sig: "sig",
});
const project = (founder, slug, team = []) => ({
  id: id(),
  pubkey: founder,
  created_at: NOW - 9_000,
  kind: 37001,
  tags: [
    ["d", slug],
    ["name", slug],
    ...team.map((m) => ["team", m, "Member"]),
  ],
  content: "{}",
  sig: "sig",
});
const task = (who = FOUNDER, helper = HELPER, coordinate = COORD) =>
  ev(
    who,
    taskEvent({
      helper,
      what: "Test sign-up.",
      done: "It works.",
      size: "small",
    }),
    NOW - 500,
    coordinate,
  );
const step = (who, t, part, over = {}, at, coordinate = COORD) =>
  ev(
    who,
    taskStepEvent({ part, taskId: t.id, tell: [HELPER, FOUNDER], ...over }),
    at,
    coordinate,
  );

/** A server as the real one answers: newest first, cut at the filter's limit. It counts what it was asked. */
function server(events) {
  const asked = [];
  const fetch = async (filter) => {
    asked.push(filter);
    return events
      .filter((event) => eventMatchesFilter(filter, event))
      .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1))
      .slice(0, filter.limit ?? events.length);
  };
  return { fetch, asked };
}
/** Junk a stranger signs: full of the right tags, all in one second so a read by tag can never walk past it. */
const junk = (count, tags) =>
  Array.from({ length: count }, () => ({
    id: id(),
    pubkey: STRANGER,
    created_at: NOW,
    kind: 47003,
    tags: [
      ["a", COORD],
      ["l", "creaton-task"],
      ["task-part", "confirm"],
      ["task-evidence", "e".repeat(64)],
      ...tags,
    ],
    content: "{}",
    sig: "sig",
  }));
const projectRead = (s) =>
  readProjectTasks(s.fetch, { coordinate: COORD, team: [FOUNDER, MATE] });
const teamReader = (event) => {
  const record = parseLaunchRecord(event);
  return record
    ? {
        coordinate: `37001:${record.author}:${record.id}`,
        team: [...teamOf(record)],
      }
    : null;
};

test("a project's tasks are read from its team and its helpers: a stranger's flood cannot cut the read", async () => {
  const t = task();
  const work = step(HELPER, t, "evidence", { note: "Done." });
  const ok = step(MATE, t, "confirm", { evidenceId: work.id });
  const flood = junk(1200, [
    ["e", t.id],
    ["task", t.id],
    ["p", HELPER],
  ]);
  const s = server([t, work, ok, ...flood]);
  const got = await projectRead(s);
  // Everything that counts was read to its end, flood or no flood.
  assert.equal(got.complete, true);
  const records = got.events.flatMap((e) => parseTaskRecord(e) ?? []);
  const [view] = projectTasks({
    records,
    coordinate: COORD,
    team: new Set([FOUNDER, MATE]),
    now: NOW,
  });
  assert.equal(view.state, "confirmed");
  // The page of other people's answers was full, and that is said apart.
  assert.equal(got.othersCut, true);
  // The reads that count name their authors.
  assert.deepEqual(s.asked[0].authors, [FOUNDER, MATE]);
  assert.deepEqual(s.asked[1].authors, [HELPER]);
});

test("a server that ignores the authors it was asked for adds nothing: the reader counts only what the team signed", async () => {
  const t = task();
  const forged = task(STRANGER);
  // A server that ignores `authors`.
  const fetch = async (filter) =>
    [t, forged].filter((e) =>
      eventMatchesFilter({ ...filter, authors: undefined }, e),
    );
  const got = await readProjectTasks(fetch, {
    coordinate: COORD,
    team: [FOUNDER],
  });
  const records = got.events.flatMap((e) => parseTaskRecord(e) ?? []);
  assert.equal(
    projectTasks({
      records,
      coordinate: COORD,
      team: new Set([FOUNDER]),
      now: NOW,
    }).length,
    1,
  );
});

test("a team's own flood, or a team too large to read, makes the read incomplete and that is said", async () => {
  const t = task();
  const own = Array.from({ length: 600 }, () => ({
    ...step(MATE, t, "cancel", { note: "x" }, NOW),
    created_at: NOW,
  }));
  assert.equal((await projectRead(server([t, ...own]))).complete, false);
  const big = Array.from({ length: 25 }, (_, i) =>
    i.toString(16).padStart(64, "0"),
  );
  assert.equal(
    (
      await readProjectTasks(server([t]).fetch, {
        coordinate: COORD,
        team: big,
      })
    ).complete,
    false,
  );
  assert.equal((await projectRead(server([t]))).complete, true);
});

test("a person's record starts from what they signed, and finds the team's steps through the task", async () => {
  const t = task();
  const yes = step(HELPER, t, "accept");
  const work = step(HELPER, t, "evidence", { note: "Done." });
  // The confirmation carries no `p` tag naming the helper: it is still found, through the task it names.
  const ok = { ...step(MATE, t, "confirm", { evidenceId: work.id }) };
  ok.tags = ok.tags.filter((tag) => tag[0] !== "p");
  // A task that only names the person, on which they signed nothing: it is never read.
  const smear = task(STRANGER, HELPER, `37001:${STRANGER}:smear`);
  const flood = junk(1200, [
    ["p", HELPER],
    ["e", t.id],
    ["task", t.id],
  ]);
  const s = server([
    project(FOUNDER, "demo", [MATE]),
    project(STRANGER, "smear"),
    t,
    yes,
    work,
    ok,
    smear,
    ...flood,
  ]);
  const got = await readPersonTasks(s.fetch, HELPER, teamReader);
  assert.equal(got.complete, true);
  assert.equal(got.tooManyProjects, false);
  assert.equal(
    got.events.some((e) => e.id === smear.id),
    false,
  );
  assert.equal(got.projects.length, 1);
  const record = helperRecord({
    person: HELPER,
    records: got.events.flatMap((e) => parseTaskRecord(e) ?? []),
    teams: new Map([[COORD, new Set([FOUNDER, MATE])]]),
    now: NOW,
  });
  assert.equal(record.accepted.length, 1);
  assert.equal(record.accepted[0].confirmedBy, MATE);
  // No read that counts was by `p`.
  assert.equal(
    s.asked.some((f) => f["#p"]),
    false,
  );
});

test("more projects than are read is said, and the person's own flood makes the read incomplete", async () => {
  const events = [];
  for (let i = 0; i <= TRACK_PROJECTS; i += 1) {
    const slug = `p${i}`;
    const coordinate = `37001:${FOUNDER}:${slug}`;
    const t = task(FOUNDER, HELPER, coordinate);
    events.push(
      project(FOUNDER, slug),
      t,
      step(HELPER, t, "accept", {}, NOW - 50, coordinate),
    );
  }
  const many = await readPersonTasks(server(events).fetch, HELPER, teamReader);
  assert.equal(many.tooManyProjects, true);
  assert.equal(many.projects.length, TRACK_PROJECTS);

  const t = task();
  const own = Array.from({ length: 600 }, () => ({
    ...step(HELPER, t, "accept"),
    created_at: NOW,
  }));
  const cut = await readPersonTasks(
    server([project(FOUNDER, "demo"), t, ...own]).fetch,
    HELPER,
    teamReader,
  );
  assert.equal(cut.complete, false);
});
