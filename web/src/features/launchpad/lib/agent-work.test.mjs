import assert from "node:assert/strict";
import { test } from "node:test";

import { agentWorkLine, operatorsOf, recentTaskAgents } from "./agent-work.ts";

const DAY = 86_400;
const NOW = 1_800_000_000;
const sam = { owner: "a".repeat(64) };
const ola = { owner: "b".repeat(64) };
const nobody = { owner: null };

const task = (over) => ({
  helperAgent: sam,
  agreed: "accept",
  state: "open",
  accepted: null,
  cancelled: null,
  ...over,
});

test("no agent, no line", () => {
  assert.equal(agentWorkLine([], []), null);
});

test("one proven operator answers for the agents and signs the promises", () => {
  assert.equal(
    agentWorkLine([sam], ["Sam"]),
    "Some of this work is done by agents. Sam answers for them and signs the promises.",
  );
});

test("two or more operators are listed and the verbs agree", () => {
  assert.equal(
    agentWorkLine([sam, ola], ["Sam", "Ola"]),
    "Some of this work is done by agents. Sam and Ola answer for them and sign the promises.",
  );
  assert.equal(
    agentWorkLine([sam, ola, sam], ["Sam", "Ola", "Kim"]),
    "Some of this work is done by agents. Sam, Ola and Kim answer for them and sign the promises.",
  );
});

test("an agent nobody is proven to run never gets a named operator", () => {
  assert.equal(
    agentWorkLine([nobody], []),
    "Some of this work is done by agents. Their records do not say who runs them.",
  );
});

test("each operator is named once, and an unproven agent adds none", () => {
  assert.deepEqual(operatorsOf([sam, nobody, ola, sam]), [
    sam.owner,
    ola.owner,
  ]);
  assert.deepEqual(operatorsOf([nobody]), []);
});

test("recent helpers are agents on open tasks or on work accepted this month; cancelled or unagreed tasks are not", () => {
  const open = task({});
  const acceptedNow = task({
    state: "confirmed",
    accepted: { confirmedAt: NOW - 3 * DAY },
  });
  const acceptedLongAgo = task({
    state: "confirmed",
    accepted: { confirmedAt: NOW - 90 * DAY },
  });
  const cancelled = task({ cancelled: { at: NOW } });
  const notAgreed = task({ agreed: null });
  const person = task({ helperAgent: null });
  assert.equal(
    recentTaskAgents(
      [open, acceptedNow, acceptedLongAgo, cancelled, notAgreed, person],
      NOW,
    ).length,
    2,
  );
  assert.equal(recentTaskAgents([acceptedLongAgo], NOW).length, 0);
});
