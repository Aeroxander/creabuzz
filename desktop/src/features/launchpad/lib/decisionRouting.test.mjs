/**
 * `decisionRouting.ts` under `node --test`: the D1 decision-routing map
 * (kind -> rendered actions), D6 quorum-summary assembly, D8 fallback copy,
 * D5 authority lines, D4 receipt matching/mirroring, and the §0 litmus
 * assembly (the three facts every card must show).
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  authorityLine,
  governanceReceiptMirror,
  PROPOSAL_ACTION_LABELS,
  proposalReceipts,
  quorumSummary,
  RECEIPTS_VOCABULARY,
  RECORD_ONLY_COPY,
  renderedActions,
  resolveDaoBinding,
  routeDecision,
} from "./decisionRouting.ts";

const FOUNDER = "a".repeat(64);
const DAO = "0x00000000000000000000000000000000000000Aa";

// ---------------------------------------------------------------------------
// D1 — the routing map: kind -> mechanism + rendered actions
// ---------------------------------------------------------------------------

test("routeDecision maps every 47004 kind to its native mechanism", () => {
  const signal = routeDecision("signal");
  assert.equal(signal.mechanism, "Deliberation");
  assert.equal(signal.ballot, false);
  assert.match(signal.note, /Discuss in channel \/ linked issue/);
  assert.match(signal.note, /No ballot/);

  const futarchy = routeDecision("futarchy-budget");
  assert.equal(futarchy.mechanism, "Futarchy market");
  assert.equal(futarchy.ballot, false);
  assert.match(futarchy.note, /markets land/i);

  const plain = routeDecision("plain");
  assert.equal(plain.mechanism, "Majeur ballot");
  assert.equal(plain.ballot, true);
});

test("renderedActions routes by kind — signal never gets a ballot (D1 anti-theater)", () => {
  for (const state of [
    "Unopened",
    "Active",
    "Queued",
    "Succeeded",
    "Defeated",
    "Expired",
    "Executed",
  ]) {
    assert.deepEqual(
      renderedActions({
        kind: "signal",
        state,
        bound: true,
        hasOperation: true,
      }),
      [],
      `signal must render no actions at state ${state}`,
    );
    assert.deepEqual(
      renderedActions({
        kind: "futarchy-budget",
        state,
        bound: true,
        hasOperation: true,
      }),
      [],
      `futarchy-budget stays read-only at state ${state}`,
    );
  }
});

test("renderedActions: plain routes the ballot and the lifecycle", () => {
  const base = { kind: "plain", bound: true, hasOperation: false };
  assert.deepEqual(renderedActions({ ...base, state: "Unopened" }), [
    "open",
    "vote-for",
    "vote-against",
    "vote-abstain",
  ]);
  assert.deepEqual(renderedActions({ ...base, state: "Active" }), [
    "vote-for",
    "vote-against",
    "vote-abstain",
  ]);
  assert.deepEqual(renderedActions({ ...base, state: "Succeeded" }), ["queue"]);
  assert.deepEqual(renderedActions({ ...base, state: "Queued" }), []);
  assert.deepEqual(
    renderedActions({ ...base, state: "Queued", hasOperation: true }),
    ["execute"],
  );
  for (const state of ["Defeated", "Expired", "Executed"]) {
    assert.deepEqual(renderedActions({ ...base, state }), [], state);
  }
});

test("renderedActions needs both the binding and the state read", () => {
  assert.deepEqual(
    renderedActions({
      kind: "plain",
      state: "Active",
      bound: false,
      hasOperation: true,
    }),
    [],
  );
  assert.deepEqual(
    renderedActions({
      kind: "plain",
      state: null,
      bound: true,
      hasOperation: true,
    }),
    [],
  );
});

test("every routed action has a button label", () => {
  for (const action of [
    "open",
    "vote-for",
    "vote-against",
    "vote-abstain",
    "queue",
    "execute",
  ]) {
    assert.ok(PROPOSAL_ACTION_LABELS[action], action);
  }
});

// ---------------------------------------------------------------------------
// D8 — the mirror-only fallback copy
// ---------------------------------------------------------------------------

test("RECORD_ONLY_COPY is the verbatim D8 fallback", () => {
  assert.equal(
    RECORD_ONLY_COPY,
    "Record-only: actions run as a treasury action against the recorded decision.",
  );
});

// ---------------------------------------------------------------------------
// D6 — quorum-summary assembly
// ---------------------------------------------------------------------------

test("quorumSummary spells the majeur rules; unknowns say per DAO config", () => {
  assert.deepEqual(quorumSummary(null), [
    "N-1 snapshot",
    "quorum per DAO config",
    "FOR>AGAINST",
    "minYes per DAO config",
    "TTL per DAO config",
    "timelock per DAO config",
  ]);
});

test("quorumSummary renders known values and the documented off switches", () => {
  assert.deepEqual(
    quorumSummary({
      quorumBps: 600,
      quorumAbsolute: 0n,
      minYesAbsolute: 100n,
      ttlSeconds: 172_800,
      timelockSeconds: 86_400,
    }),
    [
      "N-1 snapshot",
      "quorum 600 bps",
      "FOR>AGAINST",
      "minYes 100",
      "TTL 2d",
      "timelock 1d",
    ],
  );
  assert.deepEqual(
    quorumSummary({
      quorumBps: 0,
      quorumAbsolute: 0n,
      minYesAbsolute: 0n,
      ttlSeconds: 0,
      timelockSeconds: 0,
    }),
    [
      "N-1 snapshot",
      "quorum off",
      "FOR>AGAINST",
      "minYes off",
      "TTL off",
      "timelock off",
    ],
  );
});

test("quorumSummary combines both quorum flavors and keeps partial reads honest", () => {
  const combined = quorumSummary({
    quorumBps: 600,
    quorumAbsolute: 1000n,
    minYesAbsolute: null,
    ttlSeconds: 900,
    timelockSeconds: null,
  });
  assert.equal(combined[1], "quorum 1000 absolute + 600 bps");
  assert.equal(combined[3], "minYes per DAO config");
  assert.equal(combined[4], "TTL 15m");
  assert.equal(combined[5], "timelock per DAO config");
});

// ---------------------------------------------------------------------------
// D5 — authority lines
// ---------------------------------------------------------------------------

test("authorityLine falls back honestly without a grant, renders provenance with one", () => {
  const fallback = authorityLine({ proposer: FOUNDER, grant: null });
  assert.match(fallback, /Proposed by a{8}…a{4}/);
  assert.match(fallback, /under their own key/);
  assert.match(fallback, /no delegation grant recorded/);

  const granted = authorityLine({
    proposer: FOUNDER,
    grant: `g${"1".repeat(63)}`,
  });
  assert.match(granted, /delegation g1{7}…1{4}/);
  assert.match(granted, /revocable/);
});

// ---------------------------------------------------------------------------
// D4 — receipt matching and mirror composition
// ---------------------------------------------------------------------------

function receipt(overrides = {}) {
  return {
    id: "r-1",
    launchId: "nebula",
    author: FOUNDER,
    createdAt: 100,
    table: "vote",
    tx: "0xabc",
    proposal: null,
    onchain: null,
    vote: null,
    grant: null,
    payload: {},
    ...overrides,
  };
}

test("proposalReceipts links mirrors by §5 tags or payload, drops the rest", () => {
  const proposal = { id: "p-1", proposalId: "42" };
  const byRecordTag = receipt({ id: "a", proposal: "p-1" });
  const byOnchainTag = receipt({ id: "b", onchain: "42", vote: "for" });
  const byPayload = receipt({ id: "c", payload: { proposal: "p-1" } });
  const unlinked = receipt({ id: "d" });
  const otherProposal = receipt({ id: "e", proposal: "p-2", onchain: "7" });
  const ragequit = receipt({ id: "f", table: "ragequit", proposal: "p-1" });
  const matched = proposalReceipts(
    [byRecordTag, byOnchainTag, byPayload, unlinked, otherProposal, ragequit],
    proposal,
  );
  assert.deepEqual(
    matched.map((r) => r.id),
    ["a", "b", "c"],
  );
});

test("governanceReceiptMirror composes the §5 vocabulary per action", () => {
  const vote = governanceReceiptMirror({
    action: "vote-for",
    recordId: "p-1",
    proposalId: "42",
    txHash: "0xdead",
  });
  assert.deepEqual(vote.extraTags, [
    ["kind", "vote"],
    ["tx", "0xdead"],
    ["proposal", "p-1"],
    ["onchain", "42"],
    ["vote", "for"],
  ]);
  assert.deepEqual(vote.content, {
    table: "vote",
    proposal: "p-1",
    onchain: "42",
    tx: "0xdead",
    vote: "for",
  });

  const open = governanceReceiptMirror({
    action: "open",
    recordId: "p-1",
    proposalId: null,
    txHash: "0xbeef",
  });
  assert.equal(open.content.table, "proposal");
  assert.deepEqual(open.extraTags, [
    ["kind", "proposal"],
    ["tx", "0xbeef"],
    ["proposal", "p-1"],
  ]);

  const queue = governanceReceiptMirror({
    action: "queue",
    recordId: "p-1",
    proposalId: "42",
    txHash: "0xcafe",
  });
  assert.equal(queue.content.table, "execute");
  assert.equal(queue.content.action, "queue");
});

// ---------------------------------------------------------------------------
// Onchain binding resolution
// ---------------------------------------------------------------------------

test("resolveDaoBinding: the record's onchain binding wins, summon receipt falls back", () => {
  const proposal = {
    id: "p-1",
    onchain: { chain: "1", dao: DAO },
  };
  const summon = receipt({
    table: "summon",
    tx: "0xsummon",
    payload: { dao: "0x00000000000000000000000000000000000000Bb" },
    createdAt: 200,
  });
  assert.deepEqual(resolveDaoBinding(proposal, [summon]), {
    dao: DAO.toLowerCase(),
    source: "proposal-record",
    ref: "p-1",
  });
  assert.deepEqual(resolveDaoBinding({ id: "p-1", onchain: null }, [summon]), {
    dao: "0x00000000000000000000000000000000000000bb",
    source: "summon-receipt",
    ref: "0xsummon",
  });
  assert.equal(resolveDaoBinding({ id: "p-1", onchain: null }, []), null);
});

// ---------------------------------------------------------------------------
// §0 litmus assembly — the three facts, for every kind
// ---------------------------------------------------------------------------

test("litmus: every kind carries all three visible facts", () => {
  for (const kind of ["signal", "plain", "futarchy-budget"]) {
    const route = routeDecision(kind);
    assert.ok(route.mechanism.length > 0, `${kind}: mechanism`);
    assert.ok(route.why.length > 0, `${kind}: why`);
    assert.ok(
      authorityLine({ proposer: FOUNDER, grant: null }).length > 0,
      `${kind}: authority`,
    );
    assert.ok(RECEIPTS_VOCABULARY.length > 0, `${kind}: receipts`);
    assert.match(RECEIPTS_VOCABULARY, /recorded with its transaction/);
  }
});
