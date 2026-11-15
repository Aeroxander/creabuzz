import assert from "node:assert/strict";
import { test } from "node:test";

import { goalEvent } from "./goals.ts";
import {
  helperFilters,
  helpersNamed,
  projectAtAddress,
  PUBLIC_READ_LIMIT,
  publicRecordView,
  recordFilters,
  recordNamed,
  teamFilters,
} from "./public-record.ts";
import { taskEvent, taskStepEvent } from "./tasks.ts";
import { updateEvent } from "./weekly-update.ts";

const FOUNDER = "f".repeat(64);
const MATE = "a".repeat(64);
const HELPER = "b".repeat(64);
const STRANGER = "c".repeat(64);
const OTHER_FOUNDER = `f0${"d".repeat(62)}`;
const COORD = `37001:${FOUNDER}:nebula`;
const DAY = 86_400;
const NOW = 1_800_000_000;

let n = 0;
const id = () => {
  n += 1;
  return n.toString(16).padStart(64, "0");
};
/** A record about the project, built the way the app signs it. */
const about = (pubkey, built, at, coordinate = COORD) => ({
  id: id(),
  pubkey,
  kind: 47003,
  created_at: at,
  tags: [["a", coordinate], ...built.tags],
  content: JSON.stringify(built.content),
  sig: "",
});
const project = (author = FOUNDER, over = {}) => ({
  id: id(),
  pubkey: author,
  kind: 37001,
  created_at: NOW - 30 * DAY,
  tags: [
    ["d", "nebula"],
    ["name", "Nebula"],
    ["team", MATE, "builder"],
  ],
  content: JSON.stringify({ pitch: "A weekly map of the night sky.", ...over }),
  sig: "",
});
const update = (over = {}) => ({
  title: "Week",
  body: "",
  done: "",
  next: "",
  help: "",
  helpSize: "small",
  helpTime: "",
  ...over,
});

test("the two shared addresses name a project, and nothing else does", () => {
  assert.deepEqual(projectAtAddress("/p/nebula-ffffffffffffffff", ""), {
    id: "nebula",
    author: null,
    founderStart: "ffffffffffffffff",
  });
  assert.deepEqual(projectAtAddress("/p/my%20map-v2-ffffffffffffffff/", ""), {
    id: "my map-v2",
    author: null,
    founderStart: "ffffffffffffffff",
  });
  assert.deepEqual(
    projectAtAddress("/launchpad/nebula", `?tab=work&author=${FOUNDER}`),
    { id: "nebula", author: FOUNDER, founderStart: null },
  );
  // A malformed author is dropped, never passed on.
  assert.deepEqual(projectAtAddress("/launchpad/nebula", "?author=nope"), {
    id: "nebula",
    author: null,
    founderStart: null,
  });
  for (const path of [
    "/",
    "/p/",
    "/p/nebula",
    "/p/bad%zz-ffffffffffffffff",
    "/launchpad",
    "/launchpad/",
    "/launchpad/a/b",
    "/discover",
    "/work",
  ])
    assert.equal(projectAtAddress(path, ""), null, path);
});

test("each read names one project and stays inside what the server answers", () => {
  const scorecard = projectAtAddress("/p/nebula-ffffffffffffffff", "");
  // A scorecard address carries the start of the founder's account id: the read names it, so other people's projects
  // under the same id cannot crowd the one the address means out of the answer.
  assert.deepEqual(recordFilters(scorecard), [
    { kinds: [37001], "#d": ["nebula"], founder_start: "ffffffffffffffff" },
  ]);
  // A project page address with no founder in it has nothing to name.
  assert.deepEqual(recordFilters(projectAtAddress("/launchpad/nebula", "")), [
    { kinds: [37001], "#d": ["nebula"] },
  ]);
  assert.deepEqual(
    recordFilters(projectAtAddress("/launchpad/nebula", `?author=${FOUNDER}`)),
    [{ kinds: [37001], "#d": ["nebula"], authors: [FOUNDER] }],
  );
  const record = recordNamed(scorecard, [project()]);
  assert.deepEqual(teamFilters(record), [
    {
      kinds: [47003],
      "#a": [COORD],
      authors: [FOUNDER, MATE],
      limit: PUBLIC_READ_LIMIT,
    },
  ]);
  assert.equal(helperFilters(record, []), null);
  assert.deepEqual(helperFilters(record, [HELPER]), [
    {
      kinds: [47003],
      "#a": [COORD],
      authors: [HELPER],
      "#l": ["creaton-task"],
      limit: PUBLIC_READ_LIMIT,
    },
  ]);
  assert.equal(PUBLIC_READ_LIMIT, 200);
});

test("only the project the address names is taken, and none is picked when several fit", () => {
  const scorecard = projectAtAddress("/p/nebula-ffffffffffffffff", "");
  const mine = project();
  assert.equal(recordNamed(scorecard, [mine]).author, FOUNDER);
  // Another founder's project with the same id is not this address's project.
  assert.equal(
    recordNamed(scorecard, [project(STRANGER), mine]).author,
    FOUNDER,
  );
  assert.equal(recordNamed(scorecard, [project(STRANGER)]), null);
  assert.equal(recordNamed(scorecard, []), null);
  // A page link without an author, and two founders: the page does not choose.
  const page = projectAtAddress("/launchpad/nebula", "");
  assert.equal(recordNamed(page, [mine]).author, FOUNDER);
  assert.equal(recordNamed(page, [mine, project(STRANGER)]), null);
  // Something that is not a project record, or names another id, is ignored.
  assert.equal(
    recordNamed(page, [
      { ...mine, kind: 1 },
      { ...mine, tags: [["d", "x"]] },
    ]),
    null,
  );
  // Two founders whose ids start alike: sixteen characters decide, and here they differ.
  assert.equal(
    recordNamed(projectAtAddress("/p/nebula-f0dddddddddddddd", ""), [
      mine,
      project(OTHER_FOUNDER),
    ]).author,
    OTHER_FOUNDER,
  );
});

/** A project with a goal, two weekly updates (a kept and a missed promise) and one piece of accepted work. */
function world() {
  const record = recordNamed(projectAtAddress("/launchpad/nebula", ""), [
    project(),
  ]);
  const goal = about(
    FOUNDER,
    goalEvent({
      id: "g1",
      level: "primary",
      text: "Publish 12 maps",
      how: "We will count them",
      state: "open",
      reason: "",
    }),
    NOW - 20 * DAY,
  );
  const first = about(
    FOUNDER,
    updateEvent(
      update({
        title: "Week 1",
        done: "Drew the north",
        next: "Draw the south\nWrite the guide",
      }),
    ),
    NOW - 8 * DAY,
  );
  const second = about(
    FOUNDER,
    updateEvent(
      update({
        title: "Week 2",
        done: "Drew the south",
        next: "Print it",
        marks: [
          {
            promiseId: `${first.id}:0`,
            text: "Draw the south",
            state: "done",
            note: "",
          },
          {
            promiseId: `${first.id}:1`,
            text: "Write the guide",
            state: "not-done",
            note: "Ran out of time",
          },
        ],
      }),
    ),
    NOW - DAY,
  );
  const task = about(
    MATE,
    taskEvent({
      helper: HELPER,
      what: "Check the star names",
      done: "Every name matches the catalogue",
      size: "small",
    }),
    NOW - 6 * DAY,
  );
  const accept = about(
    HELPER,
    taskStepEvent({ part: "accept", taskId: task.id, tell: [MATE, FOUNDER] }),
    NOW - 5 * DAY,
  );
  const evidence = about(
    HELPER,
    taskStepEvent({
      part: "evidence",
      taskId: task.id,
      tell: [MATE, FOUNDER],
      note: "All 88 checked",
      links: ["https://example.com/names"],
    }),
    NOW - 4 * DAY,
  );
  const confirm = about(
    MATE,
    taskStepEvent({
      part: "confirm",
      taskId: task.id,
      tell: [HELPER],
      evidenceId: evidence.id,
    }),
    NOW - 3 * DAY,
  );
  return {
    record,
    teamEvents: [goal, first, second, task, confirm],
    helperEvents: [accept, evidence],
    first,
    second,
    task,
  };
}

test("the record shows the goal, the run of weeks, the promises kept and missed, the latest update and accepted work", () => {
  const w = world();
  assert.deepEqual(helpersNamed(w.record, w.teamEvents), [HELPER]);
  const view = publicRecordView({ ...w, now: NOW });
  assert.equal(view.name, "Nebula");
  assert.equal(view.goal, "Publish 12 maps");
  assert.equal(view.goalHow, "We will count them");
  assert.equal(view.streak, 2);
  // "Print it" was promised in the newest update: nothing can have answered it yet, so it is not counted as unanswered.
  assert.deepEqual(view.promises, {
    kept: 1,
    missed: 1,
    changed: 0,
    unanswered: 0,
  });
  assert.deepEqual(
    view.answered.map((p) => [p.text, p.state, p.note]),
    [
      ["Draw the south", "kept", ""],
      ["Write the guide", "missed", "Ran out of time"],
    ],
  );
  assert.equal(view.latest.title, "Week 2");
  assert.equal(view.latest.at, NOW - DAY);
  assert.equal(view.accepted, 1);
  assert.equal(view.doneAlone, 0);
  assert.deepEqual(view.work, [
    {
      id: w.task.id,
      what: "Check the star names",
      acceptedAt: NOW - 3 * DAY,
      selfChecked: false,
    },
  ]);
  assert.equal(view.complete, true);
});

test("work the founder did alone and checked themself is counted apart from work someone else accepted", () => {
  const w = world();
  const own = about(
    FOUNDER,
    taskEvent({
      helper: FOUNDER,
      what: "Draw the legend",
      done: "The legend is on every map",
      size: "small",
    }),
    NOW - 2 * DAY,
  );
  const handed = about(
    FOUNDER,
    taskStepEvent({
      part: "evidence",
      taskId: own.id,
      tell: [],
      note: "On all twelve",
    }),
    NOW - 2 * DAY,
  );
  const checked = about(
    FOUNDER,
    taskStepEvent({
      part: "confirm",
      taskId: own.id,
      tell: [],
      evidenceId: handed.id,
    }),
    NOW - 2 * DAY,
  );
  const view = publicRecordView({
    ...w,
    teamEvents: [...w.teamEvents, own, handed, checked],
    now: NOW,
  });
  // The accepted number does not move; the founder's own piece has its own.
  assert.equal(view.accepted, 1);
  assert.equal(view.doneAlone, 1);
  assert.deepEqual(
    view.work.map((piece) => [piece.what, piece.selfChecked]),
    [
      ["Draw the legend", true],
      ["Check the star names", false],
    ],
  );
});

test("a project with no goal shows its one-liner, and one with nothing yet says nothing it does not know", () => {
  const record = recordNamed(projectAtAddress("/launchpad/nebula", ""), [
    project(),
  ]);
  const view = publicRecordView({
    record,
    teamEvents: [],
    helperEvents: null,
    now: NOW,
  });
  assert.equal(view.goal, "A weekly map of the night sky.");
  assert.equal(view.goalHow, "");
  assert.equal(view.streak, 0);
  assert.deepEqual(view.promises, {
    kept: 0,
    missed: 0,
    changed: 0,
    unanswered: 0,
  });
  assert.equal(view.latest, null);
  assert.equal(view.accepted, 0);
  assert.deepEqual(view.work, []);
  assert.equal(view.complete, true);
});

test("records that are not this project's, or not from who the read was for, are not counted", () => {
  const w = world();
  // A stranger's update, a goal the stranger signed, and the team's record about another project.
  const strangers = about(
    STRANGER,
    updateEvent(update({ title: "Not theirs", done: "x", next: "y" })),
    NOW - 60,
  );
  const fakeGoal = about(
    STRANGER,
    goalEvent({
      id: "g9",
      level: "primary",
      text: "Take over",
      how: "x",
      state: "open",
      reason: "",
    }),
    NOW - 30,
  );
  const elsewhere = about(
    FOUNDER,
    updateEvent(update({ title: "Other project", done: "x" })),
    NOW - 10,
    `37001:${FOUNDER}:other`,
  );
  // A step from someone no task names as its helper: confirming their own "work".
  const fakeEvidence = about(
    STRANGER,
    taskStepEvent({
      part: "evidence",
      taskId: w.task.id,
      tell: [MATE],
      note: "mine",
    }),
    NOW - 2 * DAY,
  );
  const view = publicRecordView({
    record: w.record,
    teamEvents: [...w.teamEvents, strangers, fakeGoal, elsewhere],
    helperEvents: [...w.helperEvents, fakeEvidence],
    now: NOW,
  });
  assert.equal(view.goal, "Publish 12 maps");
  assert.equal(view.latest.title, "Week 2");
  assert.equal(view.accepted, 1);
  assert.equal(view.work.length, 1);
});

test("a read that hit the server's limit leaves its numbers unknown, never a smaller number", () => {
  const w = world();
  const filler = Array.from({ length: PUBLIC_READ_LIMIT }, (_, i) =>
    about(FOUNDER, updateEvent(update({ done: `d${i}` })), NOW - 100 * DAY - i),
  );
  const cut = publicRecordView({
    record: w.record,
    teamEvents: [...w.teamEvents, ...filler].slice(0, PUBLIC_READ_LIMIT),
    helperEvents: w.helperEvents,
    now: NOW,
  });
  assert.equal(cut.streak, null);
  assert.equal(cut.promises, null);
  assert.equal(cut.accepted, null);
  assert.equal(cut.complete, false);
  // The helpers' steps cut, or not read at all though a helper is named: accepted work is not stated.
  const noSteps = publicRecordView({
    record: w.record,
    teamEvents: w.teamEvents,
    helperEvents: null,
    now: NOW,
  });
  assert.equal(noSteps.accepted, null);
  assert.equal(noSteps.complete, false);
  assert.equal(noSteps.streak, 2);
});

test("an update dated in the future is not the latest update", () => {
  const w = world();
  const ahead = about(
    FOUNDER,
    updateEvent(update({ title: "From tomorrow", done: "x" })),
    NOW + DAY,
  );
  const view = publicRecordView({
    record: w.record,
    teamEvents: [...w.teamEvents, ahead],
    helperEvents: w.helperEvents,
    now: NOW,
  });
  assert.equal(view.latest.title, "Week 2");
});

test("the record reads the same from what the server gives someone who is not a member: the steps of accepted work alone", () => {
  const w = world();
  // To a member the server also gives the helper's yes, a task nobody has finished, and work still waiting for the
  // team's word. To anyone else it gives only the task, the work handed in and the confirmation of accepted work.
  const open = about(
    MATE,
    taskEvent({
      helper: HELPER,
      what: "Draw the legend",
      done: "The legend is on every map",
      size: "small",
    }),
    NOW - 2 * DAY,
  );
  const waiting = about(
    HELPER,
    taskStepEvent({
      part: "evidence",
      taskId: open.id,
      tell: [MATE],
      note: "A first try",
    }),
    NOW - DAY,
  );
  const forMembers = publicRecordView({
    record: w.record,
    teamEvents: [...w.teamEvents, open],
    helperEvents: [...w.helperEvents, waiting],
    now: NOW,
  });
  const served = w.helperEvents.filter((event) =>
    event.tags.some((tag) => tag[0] === "task-part" && tag[1] === "evidence"),
  );
  assert.equal(
    served.length,
    1,
    "the accepted piece, without the helper's yes",
  );
  const forAnyone = publicRecordView({
    record: w.record,
    teamEvents: w.teamEvents,
    helperEvents: served,
    now: NOW,
  });
  assert.equal(forAnyone.accepted, 1);
  assert.deepEqual(
    forAnyone.work.map((piece) => piece.what),
    ["Check the star names"],
  );
  for (const key of [
    "accepted",
    "work",
    "promises",
    "streak",
    "answered",
    "latest",
    "goal",
    "complete",
  ])
    assert.deepEqual(forAnyone[key], forMembers[key], key);
});
