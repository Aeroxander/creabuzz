import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { feedItems } from "../../feed/lib/record-feed.ts";
import { myWork } from "../../work/lib/my-work.ts";
import { projectState } from "./project-state.ts";
import { whoToAskAcross } from "./task-own-check.ts";
import {
  parseTaskRecord,
  projectTasks,
  taskEvent,
  taskStepEvent,
} from "./tasks.ts";
import { helperRecord } from "./track-record.ts";

/**
 * The founder checks the work of an agent nobody can prove is theirs, with a second agent on the team. Whether that
 * check is "done, checked by the founder" or "accepted" depends on which team members are agents, so every surface has
 * to be given the same answer to that. This drives each surface the app reads with the same records and the same
 * agents, and asserts they word the check the same way; with nobody known to be an agent, each says "accepted".
 */

const FOUNDER = "f".repeat(64);
const BOT = "a".repeat(64); // the agent that did the work: its records say agent, nothing proves who runs it
const BOT2 = "9".repeat(64); // a second agent on the team
const COORD = `37001:${FOUNDER}:demo`;
const NOW = 1_794_312_000;
const DAY = 86_400;
const TEAM = new Set([FOUNDER, BOT2]);

let n = 0;
function signed(pubkey, built, extra = [], at = NOW - DAY) {
  n += 1;
  return {
    id: n.toString(16).padStart(64, "0"),
    pubkey,
    created_at: at,
    kind: 47003,
    tags: [["a", COORD], ...built.tags, ...extra],
    content: JSON.stringify(built.content),
    sig: "sig",
  };
}

const task = signed(
  FOUNDER,
  taskEvent({ helper: BOT, what: "Wrote it", done: "Wrote it", size: "small" }),
  [],
  NOW - 5 * DAY,
);
const agentTag = [["agent", BOT]];
const accept = signed(
  BOT,
  taskStepEvent({ part: "accept", taskId: task.id, tell: [] }),
  agentTag,
  NOW - 4 * DAY,
);
const work = signed(
  BOT,
  taskStepEvent({ part: "evidence", taskId: task.id, tell: [], note: "Done" }),
  agentTag,
  NOW - 3 * DAY,
);
const check = signed(
  FOUNDER,
  taskStepEvent({
    part: "confirm",
    taskId: task.id,
    tell: [],
    evidenceId: work.id,
  }),
  [],
  NOW - 2 * DAY,
);
const events = [task, accept, work, check];
const records = events.flatMap((e) => parseTaskRecord(e) ?? []);

/** What each surface says about the one task: whether it is the founder's own check. */
function surfaces(agents) {
  const one = (tasks) => {
    assert.equal(tasks.length, 1);
    return tasks[0].selfChecked;
  };
  const feed = feedItems({
    events: [],
    projects: new Map([
      [
        COORD,
        {
          coordinate: COORD,
          founder: FOUNDER,
          team: TEAM,
          voices: new Map([[FOUNDER, null]]),
        },
      ],
    ]),
    taskRecords: records,
    agents,
    now: NOW,
  }).filter((item) => item.kind === "work");
  const helper = helperRecord({
    person: BOT,
    records,
    teams: new Map([[COORD, TEAM]]),
    now: NOW,
    agents,
  });
  return {
    page: one(
      projectTasks({
        records,
        coordinate: COORD,
        team: TEAM,
        now: NOW,
        agents,
      }),
    ),
    state: one(
      projectState({
        coordinate: COORD,
        founder: FOUNDER,
        team: TEAM,
        updates: [],
        latestAt: null,
        signals: [],
        tasks: records,
        agents,
        complete: { team: true, offers: true, helpers: true, posts: true },
        viewer: null,
        now: NOW,
      }).tasks,
    ),
    feed: one(feed),
    // The helper's own record counts it on one side or the other.
    record: helper.doneAlone.length === 1 && helper.accepted.length === 0,
    work: one(
      myWork({
        person: BOT,
        records,
        teams: new Map([[COORD, TEAM]]),
        agents,
        now: NOW,
      }).map((item) => item.task),
    ),
  };
}

test("with the second agent known, every surface words the founder's check as their own", () => {
  assert.deepEqual(surfaces(new Set([BOT2])), {
    page: true,
    state: true,
    feed: true,
    record: true,
    work: true,
  });
});

test("with nobody known to be an agent, every surface counts a person on the team and says accepted", () => {
  assert.deepEqual(surfaces(new Set()), {
    page: false,
    state: false,
    feed: false,
    record: false,
    work: false,
  });
});

test("the profiles to read are the ones where work was checked, across projects, founders first and cut", () => {
  const projects = [{ coordinate: COORD, founder: FOUNDER, team: TEAM }];
  assert.deepEqual(
    whoToAskAcross(records, projects),
    [FOUNDER, BOT, BOT2].sort(),
  );
  assert.deepEqual(whoToAskAcross(records.slice(0, 2), projects), []);
  const many = Array.from({ length: 80 }, (_, i) => ({
    coordinate: COORD,
    founder: FOUNDER,
    team: [i.toString(16).padStart(64, "0")],
  }));
  assert.equal(whoToAskAcross(records, many).length <= 36, true);
});

// The pure rules above are only as good as what is handed to them: each screen's own read has to look up the agents.
test("every surface that works out accepted work reads who the agents are", () => {
  const feature = (path) =>
    readFileSync(
      fileURLToPath(new URL(`../../${path}`, import.meta.url)),
      "utf8",
    );
  for (const path of [
    "launchpad/use-tasks.ts",
    "launchpad/use-my-projects.ts",
    "feed/use-record-feed.ts",
  ])
    assert.match(feature(path), /readRunAgents\(/, path);
  assert.match(feature("launchpad/use-tasks.ts"), /agents: new Set\(agents\)/);
  assert.match(
    feature("work/ui/YourWork.tsx"),
    /agents: new Set\(read\.data\.agents\)/,
  );
  assert.match(feature("feed/use-record-feed.ts"), /agents: new Set\(/);
  assert.match(feature("launchpad/lib/public-record.ts"), /runAgentsSigning\(/);
});
