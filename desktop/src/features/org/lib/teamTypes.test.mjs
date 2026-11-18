// Unit tests for Team (SAT) kinds 44020-44022 read-side logic: LWW folding,
// turn d-tag addressing/grouping, strategy lineage. Pure logic only.
// Run with: node --import ./test-loader.mjs --experimental-strip-types --test src/features/org/lib/teamTypes.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  eventToTeamRun,
  eventToTeamStrategy,
  eventToTeamTurn,
  groupTurnsByPhase,
  groupTurnsByRun,
  lineageLabel,
  newestTeamRuns,
  newestTeamStrategies,
  parseStrategyRev,
  parseTurnD,
  sortTurnsForRun,
  strategyRevisions,
} from "./teamTypes.ts";

const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);

function event(overrides) {
  return {
    id: "evt",
    pubkey: ALICE,
    created_at: 1000,
    kind: 44020,
    tags: [["d", "id"]],
    content: "{}",
    sig: "mock",
    ...overrides,
  };
}

function strategyEvent({
  id,
  created_at = 1000,
  pubkey = ALICE,
  content = {},
  tags = [],
  eventId = `evt-${id}-${created_at}`,
}) {
  return event({
    id: eventId,
    pubkey,
    created_at,
    kind: 44020,
    tags: [["d", id], ...tags],
    content: JSON.stringify(content),
  });
}

const VALID_STRATEGY = {
  v: 1,
  name: "Mechanistic step audit",
  description: "AIME-2024 bank strategy.",
  teamworkPrompt: "Audit every step.",
  roles: {
    "agent-0": "Solver.",
    "agent-1": "Solver.",
    "agent-2": "Challenger.",
  },
  steps: [
    {
      participants: ["agent-0", "agent-1"],
      rounds: 1,
      flow: "local",
      prompt: "Audit the chains.",
    },
  ],
  finalWriter: "agent-1",
};

describe("eventToTeamStrategy", () => {
  it("parses a valid strategy head", () => {
    const s = eventToTeamStrategy(
      strategyEvent({ id: "sat-smoke-2", content: VALID_STRATEGY }),
    );
    assert.ok(s);
    assert.equal(s.id, "sat-smoke-2");
    assert.equal(s.name, "Mechanistic step audit");
    assert.equal(s.phases, 1);
    assert.deepEqual(s.roster, ["agent-0", "agent-1", "agent-2"]);
    assert.equal(s.finalWriter, "agent-1");
    assert.equal(s.parentStrategy, null);
    assert.equal(s.rev, null);
    assert.equal(s.updatedAt, 1000);
  });

  it("rejects non-strategy kinds and malformed content", () => {
    assert.equal(eventToTeamStrategy(event({ kind: 44021 })), null);
    assert.equal(
      eventToTeamStrategy(
        strategyEvent({ id: "x", content: { v: 1, name: "no roster" } }),
      ),
      null,
    );
    assert.equal(
      eventToTeamStrategy(
        strategyEvent({
          id: "x",
          content: { v: 1, roles: { a: "x" }, steps: [] },
        }),
      ),
      null,
    );
  });

  it("parses reflection revisions: rev suffix + parentStrategy", () => {
    const rev = eventToTeamStrategy(
      strategyEvent({
        id: "sat-smoke-2-rev1",
        content: { ...VALID_STRATEGY, parentStrategy: "sat-smoke-2" },
      }),
    );
    assert.ok(rev);
    assert.equal(rev.parentStrategy, "sat-smoke-2");
    assert.equal(rev.rev, 1);
  });

  it("reads provenance tags", () => {
    const s = eventToTeamStrategy(
      strategyEvent({
        id: "sat-smoke-2",
        content: VALID_STRATEGY,
        tags: [["model", "deepseek-v4-flash-0731"]],
      }),
    );
    assert.equal(s.model, "deepseek-v4-flash-0731");
  });
});

describe("parseStrategyRev", () => {
  it("extracts the numeric suffix", () => {
    assert.equal(parseStrategyRev("sat-smoke-2-rev1"), 1);
    assert.equal(parseStrategyRev("sat-smoke-2-rev12"), 12);
  });
  it("returns null for roots and malformed suffixes", () => {
    assert.equal(parseStrategyRev("sat-smoke-2"), null);
    assert.equal(parseStrategyRev("sat-smoke-2-rev"), null);
    assert.equal(parseStrategyRev("rev1"), null);
  });
});

describe("parseTurnD", () => {
  it("splits run/phase/slot", () => {
    assert.deepEqual(parseTurnD("run-1/2/agent-0"), {
      runId: "run-1",
      phase: 2,
      agentSlot: "agent-0",
    });
  });
  it("rejects malformed shapes", () => {
    assert.equal(parseTurnD("run-1"), null);
    assert.equal(parseTurnD("run-1/"), null);
    assert.equal(parseTurnD("run-1/a/agent-0"), null);
    assert.equal(parseTurnD("run-1/0/agent-0"), null);
    assert.equal(parseTurnD("/2/agent-0"), null);
  });
});

describe("eventToTeamTurn", () => {
  it("parses a turn with provenance", () => {
    const t = eventToTeamTurn(
      event({
        kind: 44022,
        tags: [
          ["d", "run-1/1/agent-0"],
          ["cost_tokens", "321"],
          ["p", BOB],
        ],
        content: "## Reasoning\nIndependent audit…",
        id: "turn-1",
      }),
    );
    assert.ok(t);
    assert.equal(t.runId, "run-1");
    assert.equal(t.phase, 1);
    assert.equal(t.agentSlot, "agent-0");
    assert.equal(t.tokens, 321);
    assert.equal(t.pubkey, BOB);
  });

  it("skips empty content and malformed d", () => {
    assert.equal(
      eventToTeamTurn(
        event({ kind: 44022, tags: [["d", "run-1/1/a"]], content: "  " }),
      ),
      null,
    );
    assert.equal(
      eventToTeamTurn(
        event({ kind: 44022, tags: [["d", "nope"]], content: "x" }),
      ),
      null,
    );
  });
});

describe("eventToTeamRun", () => {
  it("parses a complete run head with seats + participant tokens", () => {
    const run = eventToTeamRun(
      event({
        kind: 44021,
        tags: [["d", "run-1"]],
        content: JSON.stringify({
          v: 1,
          strategyId: "sat-smoke-2",
          problem: "Solve the puzzle.",
          transcript: [
            {
              phase: 1,
              agentSlot: "agent-0",
              content: "hi",
              tokens: 100,
              pubkey: BOB,
            },
          ],
          finalAnswer: "## Certificate",
          totalTokens: 1732,
          model: "deepseek-v4-flash-0731",
          status: "complete",
          orgNode: "eng",
          seats: { "agent-0": BOB, "agent-1": ALICE },
          participantTokens: { "agent-0": 800, "agent-1": 932 },
        }),
        created_at: 2000,
      }),
    );
    assert.ok(run);
    assert.equal(run.id, "run-1");
    assert.equal(run.strategyId, "sat-smoke-2");
    assert.equal(run.totalTokens, 1732);
    assert.equal(run.orgNode, "eng");
    assert.equal(run.seats["agent-1"], ALICE);
    assert.equal(run.participantTokens["agent-0"], 800);
    assert.equal(run.transcript.length, 1);
    assert.equal(run.createdAt, 2000);
  });

  it("tolerates a missing org binding", () => {
    const run = eventToTeamRun(
      event({
        kind: 44021,
        tags: [["d", "run-2"]],
        content: JSON.stringify({
          v: 1,
          strategyId: "s",
          problem: "p",
          transcript: [],
          finalAnswer: "f",
          totalTokens: 10,
          model: "m",
          status: "complete",
        }),
      }),
    );
    assert.ok(run);
    assert.equal(run.orgNode, null);
    assert.deepEqual(run.seats, null);
  });

  it("rejects non-run kinds", () => {
    assert.equal(eventToTeamRun(event({ kind: 44020 })), null);
  });
});

describe("newestTeamStrategies (read-side LWW)", () => {
  it("folds per (author, id) then per id, newest first", () => {
    const events = [
      strategyEvent({
        id: "sat-smoke-2-rev1",
        created_at: 3000,
        content: { ...VALID_STRATEGY, parentStrategy: "sat-smoke-2" },
        eventId: "rev1",
      }),
      strategyEvent({
        id: "sat-smoke-2",
        created_at: 1000,
        content: VALID_STRATEGY,
        eventId: "root-1",
      }),
      // stale revision by the same author — must lose to rev1
      strategyEvent({
        id: "sat-smoke-2-rev1",
        created_at: 2000,
        content: { ...VALID_STRATEGY, parentStrategy: "sat-smoke-2" },
        eventId: "rev1-stale",
      }),
      // another author's older root loses across authors
      strategyEvent({
        id: "sat-smoke-2",
        created_at: 500,
        pubkey: BOB,
        content: VALID_STRATEGY,
        eventId: "root-bob",
      }),
      strategyEvent({
        id: "other",
        created_at: 2500,
        content: { ...VALID_STRATEGY, name: "Other" },
        eventId: "other-1",
      }),
    ];
    const folded = newestTeamStrategies(events);
    // Distinct d tags survive side by side: the root and its revision are
    // separate ids (read-side LWW folds per d, not per lineage).
    assert.equal(folded.length, 3);
    assert.equal(folded[0].id, "sat-smoke-2-rev1");
    assert.equal(folded[0].eventId, "rev1"); // newest per (author,id)
    // root folded across authors: newest (alice 1000) beats bob 500
    const root = folded.find((s) => s.id === "sat-smoke-2");
    assert.ok(root);
    assert.equal(root.eventId, "root-1");
    assert.equal(folded.length, 3);
  });

  it("tie-breaks equal timestamps by event id", () => {
    const a = strategyEvent({
      id: "x",
      created_at: 1000,
      content: VALID_STRATEGY,
      eventId: "b",
    });
    const b = strategyEvent({
      id: "x",
      created_at: 1000,
      content: VALID_STRATEGY,
      eventId: "a",
    });
    const folded = newestTeamStrategies([a, b]);
    assert.equal(folded.length, 1);
    assert.equal(folded[0].eventId, "b");
  });
});

describe("newestTeamRuns (read-side LWW)", () => {
  function runEvent({
    d,
    created_at,
    pubkey = ALICE,
    eventId = `evt-${d}-${created_at}`,
  }) {
    return event({
      id: eventId,
      pubkey,
      created_at,
      kind: 44021,
      tags: [["d", d]],
      content: JSON.stringify({
        v: 1,
        strategyId: "s",
        problem: "p",
        transcript: [],
        finalAnswer: "f",
        totalTokens: 10,
        model: "m",
        status: "complete",
      }),
    });
  }

  it("folds per (author, run) then per run, newest first", () => {
    const runs = newestTeamRuns([
      runEvent({ d: "run-1", created_at: 1000, eventId: "r1" }),
      runEvent({ d: "run-1", created_at: 3000, eventId: "r1-new" }),
      runEvent({
        d: "run-1",
        created_at: 2000,
        pubkey: BOB,
        eventId: "r1-bob",
      }),
      runEvent({ d: "run-2", created_at: 2500, eventId: "r2" }),
    ]);
    assert.equal(runs.length, 2);
    assert.equal(runs[0].id, "run-1");
    assert.equal(runs[0].eventId, "r1-new");
    assert.equal(runs[1].id, "run-2");
  });
});

describe("turn grouping", () => {
  function turn({ d, created_at = 1000, content = "x" }) {
    return eventToTeamTurn(
      event({
        kind: 44022,
        tags: [["d", d]],
        content,
        created_at,
        id: `evt-${d}-${created_at}`,
      }),
    );
  }

  it("groupTurnsByRun addresses from the d tag", () => {
    const grouped = groupTurnsByRun([
      turn({ d: "run-a/1/agent-0", content: "first" }),
      turn({ d: "run-b/1/agent-0" }),
      turn({ d: "run-a/2/agent-1", created_at: 1100 }),
    ]);
    assert.deepEqual([...grouped.keys()].sort(), ["run-a", "run-b"]);
    assert.equal(grouped.get("run-a").length, 2);
    assert.equal(grouped.get("run-a")[0].phase, 1);
    assert.equal(grouped.get("run-a")[1].phase, 2);
  });

  it("sortTurnsForRun orders by phase then age then id", () => {
    const turns = [
      turn({ d: "r/2/agent-1", created_at: 2000, content: "later-but-phase2" }),
      turn({ d: "r/1/agent-0", created_at: 3000, content: "phase1" }),
      turn({ d: "r/1/agent-1", created_at: 2000, content: "phase1b" }),
    ];
    const sorted = sortTurnsForRun(turns);
    assert.deepEqual(
      sorted.map((t) => t.content),
      ["phase1b", "phase1", "later-but-phase2"],
    );
  });

  it("groupTurnsByPhase buckets one run's turns", () => {
    const phases = groupTurnsByPhase([
      turn({ d: "r/1/agent-0" }),
      turn({ d: "r/2/agent-0", created_at: 1500 }),
      turn({ d: "r/1/agent-1", created_at: 1200 }),
    ]);
    assert.deepEqual([...phases.keys()].sort(), [1, 2]);
    assert.equal(phases.get(1).length, 2);
    assert.equal(phases.get(2).length, 1);
  });
});

describe("strategy lineage", () => {
  it("builds lineage labels and revision lists", () => {
    const events = [
      strategyEvent({
        id: "sat-smoke-2",
        created_at: 1000,
        content: VALID_STRATEGY,
        eventId: "root",
      }),
      strategyEvent({
        id: "sat-smoke-2-rev1",
        created_at: 2000,
        content: { ...VALID_STRATEGY, parentStrategy: "sat-smoke-2" },
        eventId: "rev1",
      }),
      strategyEvent({
        id: "sat-smoke-2-rev2",
        created_at: 3000,
        content: { ...VALID_STRATEGY, parentStrategy: "sat-smoke-2" },
        eventId: "rev2",
      }),
      strategyEvent({
        id: "other",
        created_at: 500,
        content: { ...VALID_STRATEGY, name: "O" },
        eventId: "other",
      }),
    ];
    const strategies = newestTeamStrategies(events);
    const root = strategies.find((s) => s.id === "sat-smoke-2");
    assert.ok(root);
    const revs = strategyRevisions(strategies, "sat-smoke-2");
    assert.deepEqual(
      revs.map((r) => r.rev),
      [1, 2],
    );
    const rev2 = strategies.find((s) => s.id === "sat-smoke-2-rev2");
    assert.equal(lineageLabel(rev2), "rev2 of sat-smoke-2");
    assert.equal(lineageLabel(root), null);
  });
});
