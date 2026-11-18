import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_STOP_KIND_BAN,
  AGENT_STOP_KIND_BUDGET,
  AGENT_STOP_KIND_GRANT,
  AGENT_STOP_KIND_NODE,
  executeAgentStop,
  grantRevocation,
  stopBudgetContent,
  stopBudgetId,
} from "./agentStop.ts";

const ME = "b".repeat(64);
const AGENT = "a".repeat(64);

function nodeRecord(agentSeats) {
  return {
    d: "seat-1",
    createdAt: 100,
    content: JSON.stringify({
      v: 1,
      name: "Ops",
      holders: [ME],
      agentSeats,
      canGrant: [],
    }),
  };
}

function grantRecord(overrides) {
  return {
    d: "grant-1",
    createdAt: 100,
    content: JSON.stringify({
      v: 1,
      issuer: ME,
      grantee: AGENT,
      via: "ops",
      verbs: ["task.create"],
      revoked: false,
      ...overrides,
    }),
  };
}

/** Deps whose fetches return `records` per kind and who record publishes. */
function deps(recordsByKind, options = {}) {
  const published = [];
  return {
    published,
    deps: {
      me: ME,
      agent: AGENT,
      ban: options.ban ?? true,
      reason: options.reason,
      nowSeconds: () => 1_000,
      fetchOwn: async (kind, dTag) =>
        (recordsByKind.get(kind) ?? []).filter(
          (r) => dTag === undefined || r.d === dTag,
        ),
      publish: async (event) => {
        if (options.failKind === event.kind) {
          throw new Error(`publish refused kind ${event.kind}`);
        }
        published.push(event);
      },
    },
  };
}

test("the stop budget is the all-time hard-reject budget the CLI publishes", () => {
  assert.equal(stopBudgetId(AGENT), `stop-${AGENT.slice(0, 16)}`);
  assert.deepEqual(JSON.parse(stopBudgetContent(AGENT)), {
    v: 1,
    subject: AGENT,
    window: "epoch",
    limits: {
      spend: { amount: 0, unit: "usd-cents" },
      runs: 0,
      tasks: { create: 0, approve: 0 },
      governance: { proposal: 0, vote: 0, execute: 0 },
      messages: 0,
      llmCalls: 0,
      llmCostCents: 0,
    },
    onExceed: "reject",
  });
});

test("the sequence publishes budget, ban, seats, then grants — in that order", async () => {
  const records = new Map([
    [AGENT_STOP_KIND_NODE, [nodeRecord([AGENT])]],
    [AGENT_STOP_KIND_GRANT, [grantRecord({})]],
    [
      AGENT_STOP_KIND_BUDGET,
      [{ d: stopBudgetId(AGENT), createdAt: 5, content: "{not a budget" }],
    ],
  ]);
  const { published, deps: d } = deps(records);
  const report = await executeAgentStop(d);

  // Mutation check: any reordering of the publish sequence fails this — the
  // budget is containment and must land before every cleanup step.
  assert.deepEqual(
    published.map((e) => e.kind),
    [
      AGENT_STOP_KIND_BUDGET,
      AGENT_STOP_KIND_BAN,
      AGENT_STOP_KIND_NODE,
      AGENT_STOP_KIND_GRANT,
    ],
  );
  assert.deepEqual(
    report.steps.map((s) => [s.step, s.ok, s.changed]),
    [
      ["budget", true, 1],
      ["ban", true, 1],
      ["seats", true, 1],
      ["grants", true, 1],
    ],
  );
  assert.equal(report.stopped, true);
});

test("each republish keeps its record's address and goes strictly newer", async () => {
  const records = new Map([
    [AGENT_STOP_KIND_NODE, [nodeRecord([AGENT])]],
    [AGENT_STOP_KIND_GRANT, [grantRecord({})]],
  ]);
  const { published, deps: d } = deps(records);
  await executeAgentStop(d);
  const [budget, , node, grant] = published;

  assert.deepEqual(budget.tags, [["d", stopBudgetId(AGENT)]]);
  assert.equal(budget.createdAt, 1_000);
  assert.deepEqual(node.tags, [
    ["d", "seat-1"],
    ["name", "Ops"],
    ["seat", ME],
  ]);
  assert.equal(node.createdAt, 1_000);
  assert.deepEqual(grant.tags, [
    ["d", "grant-1"],
    ["grantee", AGENT],
  ]);
  assert.equal(grant.createdAt, 1_000);
  assert.equal(JSON.parse(grant.content).revoked, true);

  // A record from the future still gets a strictly-newer republish.
  const { deps: future } = deps(
    new Map([
      [AGENT_STOP_KIND_NODE, [{ ...nodeRecord([AGENT]), createdAt: 2_000 }]],
    ]),
    { ban: false },
  );
  const futurePublished = [];
  future.publish = async (event) => {
    futurePublished.push(event);
  };
  await executeAgentStop(future);
  const futureNode = futurePublished.find(
    (e) => e.kind === AGENT_STOP_KIND_NODE,
  );
  assert.equal(futureNode.createdAt, 2_001);
});

test("a re-run publishes only what is not already in force", async () => {
  const records = new Map([
    [
      AGENT_STOP_KIND_BUDGET,
      [
        {
          d: stopBudgetId(AGENT),
          createdAt: 5,
          content: stopBudgetContent(AGENT),
        },
      ],
    ],
    [AGENT_STOP_KIND_NODE, [nodeRecord([])]],
    [AGENT_STOP_KIND_GRANT, [grantRecord({ revoked: true })]],
  ]);
  const { published, deps: d } = deps(records, { ban: false });
  const report = await executeAgentStop(d);

  assert.equal(published.length, 0);
  assert.equal(report.stopped, true);
  assert.deepEqual(
    report.steps.map((s) => s.changed ?? null),
    [0, 0, 0],
  );
});

test("equity grants are records, not delegations — never revoked here", () => {
  assert.equal(
    grantRevocation(grantRecord({ type: "equity" }).content, AGENT),
    null,
  );
});

test("a failed step is named and never blocks the cleanup steps after it", async () => {
  const records = new Map([
    [AGENT_STOP_KIND_NODE, [nodeRecord([AGENT])]],
    [AGENT_STOP_KIND_GRANT, [grantRecord({})]],
  ]);
  const { published, deps: d } = deps(records, {
    failKind: AGENT_STOP_KIND_BUDGET,
    ban: false,
  });
  const report = await executeAgentStop(d);

  assert.equal(report.stopped, false);
  assert.deepEqual(
    report.steps.map((s) => [s.step, s.ok]),
    [
      ["budget", false],
      ["seats", true],
      ["grants", true],
    ],
  );
  const failed = report.steps.find((s) => !s.ok);
  assert.match(failed.error, /kind 37012/);
  // Recovery affordance: the later steps still ran, so one re-run finishes.
  assert.deepEqual(
    published.map((e) => e.kind),
    [AGENT_STOP_KIND_NODE, AGENT_STOP_KIND_GRANT],
  );
});

test("refuses to stop your own key", async () => {
  const { deps: d } = deps(new Map());
  await assert.rejects(
    executeAgentStop({ ...d, agent: ME.toUpperCase() }),
    /your own key/,
  );
});
