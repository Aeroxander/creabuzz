import assert from "node:assert/strict";
import test from "node:test";

import {
  KIND_AGENT_WIKI_PAGE,
  KIND_WIKI_PAGE,
  appliedCorrectionsFor,
  buildSuggestion,
  canEditKnowledge,
  classifyEvent,
  classifyEvents,
  extractProvenance,
  isSuggestionEvent,
  pageScope,
  provenanceLine,
  suggestionsFor,
} from "./knowledge.ts";

const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);
const SRC1 = "c".repeat(64);
const SRC2 = "d".repeat(64);

function ev(fields) {
  return {
    id: fields.id ?? `id-${Math.random()}`,
    pubkey: fields.pubkey ?? ALICE,
    created_at: fields.created_at ?? 100,
    kind: fields.kind,
    tags: fields.tags ?? [],
    content: fields.content ?? "",
  };
}

// ── classification ────────────────────────────────────────────────────────

test("a 44001 event classifies as a team page with no provenance", () => {
  const page = classifyEvent(
    ev({ kind: KIND_WIKI_PAGE, tags: [["d", "home"]], content: "body" }),
  );
  assert.equal(page.kind, "team");
  assert.equal(page.slug, "home");
  assert.equal(page.provenance, null);
});

test("a 44002 event classifies as an agent page with provenance", () => {
  const page = classifyEvent(
    ev({
      kind: KIND_AGENT_WIKI_PAGE,
      tags: [
        ["d", "default/standup"],
        ["model", "glm-5.3-flash"],
        ["sources", `${SRC1},${SRC2}`],
      ],
    }),
  );
  assert.equal(page.kind, "agent");
  assert.equal(page.slug, "default/standup");
  assert.deepEqual(page.provenance, { agent: "glm-5.3-flash", sourceCount: 2 });
});

test("a non-wiki event is not a Knowledge page", () => {
  assert.equal(classifyEvent(ev({ kind: 1, content: "hi" })), null);
});

test("classifyEvents splits team and agent, sorted by slug", () => {
  const { team, agent } = classifyEvents([
    ev({ kind: KIND_WIKI_PAGE, tags: [["d", "zebra"]] }),
    ev({ kind: KIND_WIKI_PAGE, tags: [["d", "alpha"]] }),
    ev({ kind: KIND_AGENT_WIKI_PAGE, tags: [["d", "a/standup"]] }),
    ev({ kind: KIND_AGENT_WIKI_PAGE, tags: [["d", "b/standup"]] }),
  ]);
  assert.deepEqual(
    team.map((p) => p.slug),
    ["alpha", "zebra"],
  );
  assert.deepEqual(
    agent.map((p) => p.slug),
    ["a/standup", "b/standup"],
  );
});

// ── provenance ────────────────────────────────────────────────────────────

test("provenance reads the model and sources tags", () => {
  const p = extractProvenance(
    ev({
      kind: KIND_AGENT_WIKI_PAGE,
      tags: [
        ["model", "glm-5.3-flash"],
        ["cost_tokens", "950"],
        ["sources", `${SRC1},${SRC2},${SRC1}`],
      ],
    }),
  );
  assert.equal(p.agent, "glm-5.3-flash");
  // A duplicate source id counts once.
  assert.equal(p.sourceCount, 2);
});

test("provenance falls back to front-matter model and drops malformed ids", () => {
  const p = extractProvenance(
    ev({
      kind: KIND_AGENT_WIKI_PAGE,
      content: "---\nslug: a/standup\nmodel: gpt-x\n---\nbody",
      tags: [["sources", `${SRC1},not-an-id,ZZ`]],
    }),
  );
  assert.equal(p.agent, "gpt-x");
  assert.equal(p.sourceCount, 1);
});

test("provenance degrades to unknown rather than guessing", () => {
  const p = extractProvenance(ev({ kind: KIND_AGENT_WIKI_PAGE, tags: [] }));
  assert.equal(p.agent, null);
  assert.equal(p.sourceCount, 0);
});

test("provenanceLine renders the canonical phrase and degrades gracefully", () => {
  assert.equal(
    provenanceLine({ agent: "glm-5.3-flash", sourceCount: 5 }),
    "Updated by agent glm-5.3-flash from 5 sources",
  );
  assert.equal(
    provenanceLine({ agent: "glm-5.3-flash", sourceCount: 1 }),
    "Updated by agent glm-5.3-flash from 1 source",
  );
  assert.equal(
    provenanceLine({ agent: "glm-5.3-flash", sourceCount: 0 }),
    "Updated by agent glm-5.3-flash",
  );
  assert.equal(
    provenanceLine({ agent: null, sourceCount: 2 }),
    "Updated by agent an agent from 2 sources",
  );
});

// ── suggestions ───────────────────────────────────────────────────────────

test("a suggestion payload records the correction and never clobbers the page", () => {
  const payload = buildSuggestion({
    slug: "home",
    note: "The date is wrong.",
    authorPubkey: BOB,
    now: 500,
  });
  assert.equal(
    payload.kind,
    44003,
    "corrections publish as KIND_WIKI_CORRECTION (see knowledge-corrections.test.mjs)",
  );
  assert.equal(payload.content, "The date is wrong.");
  assert.equal(payload.created_at, 500);
  // The proposal has its own `d`, distinct from the corrected page's slug.
  const d = payload.tags.find((t) => t[0] === "d")[1];
  assert.equal(d, "correction-for-home");
  assert.notEqual(d, "home");
  // And a `t` marker renders it back against the right page.
  assert.ok(
    payload.tags.some((t) => t[0] === "t" && t[1] === "correction-for:home"),
  );
});

test("a suggestion event is not itself a Knowledge page", () => {
  const payload = buildSuggestion({
    slug: "home",
    note: "n",
    authorPubkey: BOB,
    now: 500,
  });
  const event = ev({ ...payload, pubkey: BOB, created_at: 500 });
  assert.equal(isSuggestionEvent(event), true);
  assert.equal(classifyEvent(event), null);
});

test("suggestionsFor folds per author and matches the exact target", () => {
  const events = [
    ev({
      kind: KIND_WIKI_PAGE,
      pubkey: BOB,
      created_at: 400,
      tags: [
        ["d", "correction-for-home"],
        ["t", "correction-for:home"],
      ],
      content: "first",
    }),
    // BOB resubmits: the newer replaces the older (same author).
    ev({
      kind: KIND_WIKI_PAGE,
      pubkey: BOB,
      created_at: 500,
      tags: [
        ["d", "correction-for-home"],
        ["t", "correction-for:home"],
      ],
      content: "second",
    }),
    ev({
      kind: KIND_WIKI_PAGE,
      pubkey: ALICE,
      created_at: 450,
      tags: [
        ["d", "correction-for-home"],
        ["t", "correction-for:home"],
      ],
      content: "alice",
    }),
    // A suggestion for a DIFFERENT page must not leak in.
    ev({
      kind: KIND_WIKI_PAGE,
      pubkey: ALICE,
      created_at: 600,
      tags: [
        ["d", "correction-for-other"],
        ["t", "correction-for:other"],
      ],
      content: "other",
    }),
  ];
  const list = suggestionsFor(events, "home");
  assert.equal(list.length, 2);
  // Newest first; BOB's live note is "second".
  assert.equal(list[0].authorPubkey, BOB);
  assert.equal(list[0].note, "second");
  assert.equal(list[1].authorPubkey, ALICE);
  assert.equal(list[1].note, "alice");
});

test("suggestionsFor is empty when none were filed", () => {
  assert.deepEqual(
    suggestionsFor(
      [ev({ kind: KIND_WIKI_PAGE, tags: [["d", "home"]] })],
      "home",
    ),
    [],
  );
});

// ── team-scope edit gate ──────────────────────────────────────────────────

test("pageScope reads the team tag and ignores other t tags", () => {
  assert.equal(
    pageScope(ev({ kind: KIND_WIKI_PAGE, tags: [["t", "team:design"]] })),
    "design",
  );
  assert.equal(
    pageScope(
      ev({ kind: KIND_WIKI_PAGE, tags: [["t", "correction-for:home"]] }),
    ),
    null,
  );
  assert.equal(pageScope(ev({ kind: KIND_WIKI_PAGE, tags: [] })), null);
});

test("an unscoped page falls back to open (member-list) editing", () => {
  assert.equal(
    canEditKnowledge({ scope: null }, ALICE, () => [BOB]),
    "edit",
  );
});

test("an unresolvable scope falls back to editing — never locks anyone out", () => {
  // No node / unknown team: the resolver returns null.
  assert.equal(
    canEditKnowledge({ scope: "ghost" }, BOB, () => null),
    "edit",
  );
});

test("a team with no seat holders falls back to editing rather than locking out", () => {
  assert.equal(
    canEditKnowledge({ scope: "empty" }, BOB, () => []),
    "edit",
  );
});

test("a seat holder may edit; everyone else may only propose", () => {
  const resolver = (id) => (id === "design" ? [ALICE] : null);
  assert.equal(canEditKnowledge({ scope: "design" }, ALICE, resolver), "edit");
  assert.equal(canEditKnowledge({ scope: "design" }, BOB, resolver), "propose");
  // A signed-out viewer is not a seat holder → propose.
  assert.equal(
    canEditKnowledge({ scope: "design" }, null, resolver),
    "propose",
  );
});

// ── corrections applied (the consumption record) ───────────────────────────

function suggestionEvent(fields) {
  return ev({
    kind: KIND_WIKI_PAGE,
    pubkey: fields.pubkey ?? BOB,
    created_at: fields.created_at ?? 400,
    tags: [
      ["d", `correction-for-${fields.slug}`],
      ["t", `correction-for:${fields.slug}`],
    ],
    content: fields.note ?? "fix it",
    id: fields.id,
  });
}

function agentRevision(fields) {
  return ev({
    kind: KIND_AGENT_WIKI_PAGE,
    created_at: fields.created_at,
    tags: [["d", fields.slug], ...(fields.aTags ?? [])],
  });
}

test("a correction the latest agent page referenced is applied, not open", () => {
  const events = [
    suggestionEvent({ slug: "home" }),
    agentRevision({
      slug: "home",
      created_at: 500,
      aTags: [["a", `44001:${BOB}:correction-for-home`]],
    }),
  ];
  assert.deepEqual(suggestionsFor(events, "home"), []);
  const applied = appliedCorrectionsFor(events, "home");
  assert.equal(applied.length, 1);
  assert.equal(applied[0].authorPubkey, BOB);
  assert.equal(applied[0].note, "fix it");
});

test("only the LATEST agent-page revision consumes a correction", () => {
  const events = [
    suggestionEvent({ slug: "home" }),
    // An older revision referenced the correction…
    agentRevision({
      slug: "home",
      created_at: 450,
      aTags: [["a", `44001:${BOB}:correction-for-home`]],
    }),
    // …but the latest does not: the reference is history, not consumption.
    agentRevision({ slug: "home", created_at: 500 }),
  ];
  const open = suggestionsFor(events, "home");
  assert.equal(open.length, 1, "older revision's reference never consumes");
  assert.equal(open[0].authorPubkey, BOB);
  assert.deepEqual(appliedCorrectionsFor(events, "home"), []);
});

test("a correction stays open when no agent page references it", () => {
  const events = [
    suggestionEvent({ slug: "home" }),
    agentRevision({ slug: "home", created_at: 500 }),
  ];
  const open = suggestionsFor(events, "home");
  assert.equal(open.length, 1);
  assert.deepEqual(appliedCorrectionsFor(events, "home"), []);
});

test("provenanceLine adds the corrections-applied phrase only above zero", () => {
  assert.equal(
    provenanceLine({ agent: "glm-5.3-flash", sourceCount: 5 }, 2),
    "Updated by agent glm-5.3-flash from 5 sources · 2 corrections applied",
  );
  assert.equal(
    provenanceLine({ agent: "glm-5.3-flash", sourceCount: 0 }, 1),
    "Updated by agent glm-5.3-flash · 1 correction applied",
  );
  assert.equal(
    provenanceLine({ agent: "glm-5.3-flash", sourceCount: 5 }, 0),
    "Updated by agent glm-5.3-flash from 5 sources",
  );
});
