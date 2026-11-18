import assert from "node:assert/strict";
import test from "node:test";

import { agentMark } from "./agent-label.ts";
import {
  acceptedByOthers,
  checkedBy,
  confirmRule,
  doneAlone,
  founderWorksAlone,
  whoWords,
} from "./task-checks.ts";
import {
  founderIsAlone,
  isFoundersOwnWork,
  judgeConfirmation,
  whoToAsk,
} from "./task-own-check.ts";
import {
  HOW_WORK_COUNTS,
  parseTaskRecord,
  projectTasks,
  SELF_CHECKED_LABEL,
  taskEvent,
  taskStateLabel,
  taskStepEvent,
} from "./tasks.ts";

/**
 * Whether a founder checking work is "alone" is read the way the server holds it (`founder_alone` in
 * `launch_update_authority.rs`): the founder checks a task whose helper is the founder, or an agent, while the project
 * record lists no other person besides the founder and that helper. Agents are known from their profile labels.
 */

const FOUNDER = "f".repeat(64);
const PIA = "d".repeat(64); // a person on the team
const BOT = "a".repeat(64); // the agent that does the work
const BOT2 = "9".repeat(64); // another agent on the team
const OTHER = "e".repeat(64); // a person who is not the founder
const COORD = `37001:${FOUNDER}:demo`;
const NOW = 1_794_312_000;
const DAY = 86_400;

let n = 0;
function signed(pubkey, built, extra = []) {
  n += 1;
  return {
    id: n.toString(16).padStart(64, "0"),
    pubkey,
    created_at: NOW - DAY,
    kind: 47003,
    tags: [["a", COORD], ...built.tags, ...extra],
    content: JSON.stringify(built.content),
    sig: "sig",
  };
}

/** A task for `helper`, the helper's hand-in, and `by`'s confirmation of it. */
function loop(helper, by, { agentTag = false, agentConfirmer = false } = {}) {
  const task = signed(
    FOUNDER,
    taskEvent({ helper, what: "Wrote it", done: "Wrote it", size: "small" }),
  );
  const work = signed(
    helper,
    taskStepEvent({
      part: "evidence",
      taskId: task.id,
      tell: [],
      note: "Done",
    }),
    agentTag ? [["agent", helper]] : [],
  );
  const check = signed(
    by,
    taskStepEvent({
      part: "confirm",
      taskId: task.id,
      tell: [],
      evidenceId: work.id,
    }),
    agentConfirmer ? [["agent", by]] : [],
  );
  return [task, work, check];
}

const read = (events, team, agents) => {
  const tasks = projectTasks({
    records: events.flatMap((e) => parseTaskRecord(e) ?? []),
    coordinate: COORD,
    team,
    now: NOW,
    agents,
  });
  assert.equal(tasks.length, 1);
  return tasks[0];
};

const alone = new Set([FOUNDER]);

test("alone, with their own task: the founder's check is theirs, never someone else's", () => {
  const task = read(loop(FOUNDER, FOUNDER), alone);
  assert.equal(task.state, "confirmed");
  assert.equal(task.selfChecked, true);
  assert.equal(task.ignoredConfirmation, false);
  assert.equal(taskStateLabel(task), SELF_CHECKED_LABEL);
  assert.deepEqual(acceptedByOthers([task]), []);
  assert.deepEqual(doneAlone([task]), [task]);
});

test("alone, with an agent's work and no proof of who runs it: the founder's check is theirs", () => {
  // The agent's records say it is an agent and name no owner: nothing proves the founder runs it.
  const events = loop(BOT, FOUNDER, { agentTag: true });
  const task = read(events, alone);
  assert.deepEqual(task.helperAgent, { owner: null });
  assert.equal(task.state, "confirmed");
  assert.equal(task.selfChecked, true);
  assert.deepEqual(acceptedByOthers([task]), []);
  // The agent's profile says it is an agent, though its records do not: the same.
  const byProfile = read(loop(BOT, FOUNDER), alone, new Set([BOT]));
  assert.equal(byProfile.selfChecked, true);
  assert.deepEqual(acceptedByOthers([byProfile]), []);
  // The page is told the founder checks it themself.
  assert.deepEqual(confirmRule(task, alone, FOUNDER), {
    may: true,
    alone: true,
  });
  // A person who does the work, with nothing saying it is an agent, is an ordinary check.
  const person = read(loop(OTHER, FOUNDER), new Set([FOUNDER, OTHER]));
  assert.equal(person.selfChecked, false);
  assert.deepEqual(acceptedByOthers([person]), [person]);
});

test("alone with a team of agents only: they are not people, so the founder is still alone", () => {
  const team = new Set([FOUNDER, BOT, BOT2]);
  const agents = new Set([BOT2]);
  const task = read(loop(BOT, FOUNDER, { agentTag: true }), team, agents);
  assert.equal(task.selfChecked, true);
  assert.equal(founderWorksAlone(task, team, agents), true);
  // Without knowing BOT2 is an agent, it counts as a person and the founder is not alone.
  const unknown = read(loop(BOT, FOUNDER, { agentTag: true }), team);
  assert.equal(unknown.selfChecked, false);
  assert.equal(founderWorksAlone(unknown, team), false);
  // With the founder's own task and a team of agents.
  const own = read(loop(FOUNDER, FOUNDER), team, new Set([BOT, BOT2]));
  assert.equal(own.selfChecked, true);
});

test("with another person on the team, an agent's work checked by the founder is an ordinary check", () => {
  const team = new Set([FOUNDER, PIA, BOT]);
  // PIA is not known to be an agent: she is a person.
  const agents = new Set([BOT]);
  const task = read(loop(BOT, FOUNDER, { agentTag: true }), team, agents);
  assert.equal(task.state, "confirmed");
  assert.equal(task.selfChecked, false);
  assert.deepEqual(acceptedByOthers([task]), [task]);
  assert.equal(taskStateLabel(task), "Work accepted");
  assert.equal(founderWorksAlone(task, team, agents), false);
  // The existing rules stay: with a person on the team the founder's check of their own task is still kept and
  // marked as theirs, never counted as accepted by someone else.
  const own = read(loop(FOUNDER, FOUNDER), team, agents);
  assert.equal(own.selfChecked, true);
  assert.deepEqual(acceptedByOthers([own]), []);
});

test("a helper who is not the founder: the founder's check is ordinary, their own check does not count", () => {
  const team = new Set([FOUNDER, PIA]);
  const byFounder = read(loop(PIA, FOUNDER), team);
  assert.equal(byFounder.selfChecked, false);
  assert.deepEqual(acceptedByOthers([byFounder]), [byFounder]);
  // PIA checking her own work is ignored, alone or not.
  const own = read(loop(PIA, PIA), team);
  assert.equal(own.state, "submitted");
  assert.equal(own.selfChecked, false);
  assert.equal(own.ignoredConfirmation, true);
  // Alone on the project, a team member who is not the founder still never checks their own work.
  const lone = read(loop(PIA, PIA), new Set([FOUNDER, PIA]), new Set());
  assert.equal(lone.ignoredConfirmation, true);
});

test("an agent's confirmation never counts, whoever it is and whatever the team holds", () => {
  // The founder's check says an agent signed it.
  const byRecord = read(
    loop(FOUNDER, FOUNDER, { agentConfirmer: true }),
    alone,
  );
  assert.equal(byRecord.state, "submitted");
  assert.equal(byRecord.ignoredConfirmation, true);
  assert.deepEqual(acceptedByOthers([byRecord]), []);
  assert.deepEqual(doneAlone([byRecord]), []);
  // The founder's profile says it is an agent account.
  const byProfile = read(loop(FOUNDER, FOUNDER), alone, new Set([FOUNDER]));
  assert.equal(byProfile.state, "submitted");
  assert.equal(byProfile.ignoredConfirmation, true);
  // A team member who is an agent confirming someone else's work: not a yes either.
  const team = new Set([FOUNDER, PIA, BOT2]);
  const byAgent = read(loop(PIA, BOT2), team, new Set([BOT2]));
  assert.equal(byAgent.state, "submitted");
  assert.equal(byAgent.ignoredConfirmation, true);
  // The same check from a person counts.
  assert.equal(
    read(loop(PIA, FOUNDER), team, new Set([BOT2])).state,
    "confirmed",
  );
});

test("someone else's check of the same piece is what accepts it, whoever's arrives first", () => {
  const team = new Set([FOUNDER, PIA]);
  const [task, work, own] = loop(FOUNDER, FOUNDER);
  const byPia = signed(
    PIA,
    taskStepEvent({
      part: "confirm",
      taskId: task.id,
      tell: [],
      evidenceId: work.id,
    }),
  );
  for (const order of [
    [task, work, own, byPia],
    [byPia, own, work, task],
  ]) {
    const both = read(order, team);
    assert.equal(both.selfChecked, false);
    assert.equal(both.accepted.by, PIA);
    assert.equal(taskStateLabel(both), "Work accepted");
  }
});

test("the pure rules: alone, the founder's own work, and what one confirmation counts as", () => {
  const team = new Set([FOUNDER, BOT, BOT2]);
  assert.equal(
    founderIsAlone({
      founder: FOUNDER,
      helper: BOT,
      team,
      agents: new Set([BOT2]),
    }),
    true,
  );
  assert.equal(founderIsAlone({ founder: FOUNDER, helper: BOT, team }), false);
  assert.equal(
    isFoundersOwnWork({
      founder: FOUNDER,
      helper: BOT,
      helperIsAgent: false,
      owners: new Set(),
    }),
    false,
  );
  // A helper proven to be run by someone else is not the founder's own work.
  assert.equal(
    isFoundersOwnWork({
      founder: FOUNDER,
      helper: BOT,
      helperIsAgent: true,
      owners: new Set([OTHER]),
    }),
    false,
  );
  const base = {
    author: FOUNDER,
    founder: FOUNDER,
    helper: BOT,
    onTeam: true,
    team: new Set([FOUNDER]),
    owners: new Set(),
    helperIsAgent: true,
    signedAsAgent: false,
  };
  assert.equal(judgeConfirmation(base), "own");
  assert.equal(
    judgeConfirmation({ ...base, helperIsAgent: false }),
    "accepted",
  );
  assert.equal(
    judgeConfirmation({ ...base, owners: new Set([OTHER]) }),
    "accepted",
  );
  assert.equal(judgeConfirmation({ ...base, signedAsAgent: true }), "ignored");
  assert.equal(
    judgeConfirmation({ ...base, team: new Set([FOUNDER, PIA]) }),
    "accepted",
  );
  assert.equal(judgeConfirmation({ ...base, onTeam: false }), "accepted");
});

test("an agent mark on a profile is what tells a reader an account is an agent", () => {
  const profile = { pubkey: BOT, created_at: NOW, tags: [["agent", BOT]] };
  assert.notEqual(agentMark(profile, 0), null);
  assert.equal(HOW_WORK_COUNTS.includes("checked by the founder"), true);
});

test("profiles are asked about only when something on the project was confirmed, founder and helpers first", () => {
  const records = (...events) =>
    events.flatMap((e) => parseTaskRecord(e) ?? []);
  const none = loop(BOT, FOUNDER).slice(0, 2);
  assert.deepEqual(
    whoToAsk(records(...none), COORD, FOUNDER, [FOUNDER, PIA]),
    [],
  );
  const checked = records(...loop(BOT, FOUNDER));
  assert.deepEqual(
    whoToAsk(checked, COORD, FOUNDER, [FOUNDER, PIA]),
    [FOUNDER, PIA, BOT].sort(),
  );
  // Another project's records say nothing about this one.
  assert.deepEqual(
    whoToAsk(checked, `37001:${FOUNDER}:other`, FOUNDER, [FOUNDER]),
    [],
  );
  // A long team is cut, the founder and the helper kept.
  const many = Array.from({ length: 40 }, (_, i) =>
    i.toString(16).padStart(64, "0"),
  );
  const asked = whoToAsk(checked, COORD, FOUNDER, [FOUNDER, ...many]);
  assert.equal(asked.length, 12);
  assert.equal(asked.includes(FOUNDER) && asked.includes(BOT), true);
});

test("one line says who did the work and who checked it; an agent is never shown as the checker", () => {
  const nameOf = (key) =>
    ({ [PIA]: "Pia", [FOUNDER]: "Robin", [BOT]: "Pia's agent" })[key];
  // Pia's agent did it, Robin the founder checked it with Pia on the team.
  const team = new Set([FOUNDER, PIA]);
  const accepted = read(loop(BOT, PIA, { agentTag: true }), team);
  const line = checkedBy(accepted, FOUNDER);
  assert.deepEqual(line, {
    done: { pubkey: BOT, you: false },
    checked: { pubkey: PIA, you: false },
  });
  assert.equal(whoWords(line.done, nameOf), "Pia's agent");
  assert.equal(whoWords(line.checked, nameOf), "Pia");
  // The founder alone: "Done by you · Checked by you".
  const own = read(loop(FOUNDER, FOUNDER), new Set([FOUNDER]));
  const mine = checkedBy(own, FOUNDER);
  assert.equal(whoWords(mine.done, nameOf), "you");
  assert.equal(whoWords(mine.checked, nameOf), "you");
  // To a visitor it is the founder's name.
  assert.equal(whoWords(checkedBy(own, PIA).checked, nameOf), "Robin");
  // A confirmation signed as an agent is not read at all, so nobody is shown as the checker.
  const agentChecked = read(
    loop(PIA, FOUNDER, { agentConfirmer: true }),
    new Set([FOUNDER, PIA]),
  );
  assert.equal(agentChecked.state, "submitted");
  assert.equal(checkedBy(agentChecked, FOUNDER).checked, null);
  // Even if a profile-known agent's name reached the reader as the checker, it is not shown as one.
  assert.equal(checkedBy(accepted, FOUNDER, new Set([PIA])).checked, null);
  // Not checked yet.
  assert.equal(checkedBy({ helper: BOT, accepted: null }, null).checked, null);
});
