import assert from "node:assert/strict";
import test from "node:test";

import {
  KIND_AGENT_WIKI_PAGE,
  KIND_WIKI_PAGE,
  appliedCorrectionsFor,
  buildSuggestion,
  canEditKnowledge,
  scopeState,
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
  assert.deepEqual(page.provenance, { model: "glm-5.3-flash", sourceCount: 2 });
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
  assert.equal(p.model, "glm-5.3-flash");
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
  assert.equal(p.model, "gpt-x");
  assert.equal(p.sourceCount, 1);
});

test("provenance degrades to unknown rather than guessing", () => {
  const p = extractProvenance(ev({ kind: KIND_AGENT_WIKI_PAGE, tags: [] }));
  assert.equal(p.model, null);
  assert.equal(p.sourceCount, 0);
});

test("provenanceLine leads with the signer's name and the model second", () => {
  assert.equal(
    provenanceLine({ model: "glm-5.3", sourceCount: 5 }, "Alice"),
    "Published by Alice · glm-5.3 · 5 sources",
  );
  assert.equal(
    provenanceLine({ model: "glm-5.3", sourceCount: 1 }, "Alice"),
    "Published by Alice · glm-5.3 · 1 source",
  );
  // The mandated two-segment form when there is nothing else to say.
  assert.equal(
    provenanceLine({ model: "glm-5.3", sourceCount: 0 }, "Alice"),
    "Published by Alice · glm-5.3",
  );
  assert.equal(
    provenanceLine({ model: null, sourceCount: 2 }, "44b8e82b…0435"),
    "Published by 44b8e82b…0435 · 2 sources",
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

test("a scoped page with an unresolvable team is read-only for ordinary members", () => {
  // No node / unknown team: the resolver returns null. The relay would reject
  // an ordinary member's edit, so the app shows propose — not a dead Edit.
  assert.equal(
    canEditKnowledge({ scope: "ghost" }, BOB, () => null),
    "propose",
  );
  // …but a community admin can still act (re-scope/unscope is the way back).
  assert.equal(
    canEditKnowledge({ scope: "ghost" }, BOB, () => null, true),
    "edit",
  );
});

test("a scoped page with no seat holders is read-only for ordinary members", () => {
  assert.equal(
    canEditKnowledge({ scope: "empty" }, BOB, () => []),
    "propose",
  );
  assert.equal(
    canEditKnowledge({ scope: "empty" }, BOB, () => [], true),
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
    provenanceLine({ model: "glm-5.3", sourceCount: 5 }, "Alice", 2),
    "Published by Alice · glm-5.3 · 5 sources · 2 corrections applied",
  );
  assert.equal(
    provenanceLine({ model: "glm-5.3", sourceCount: 0 }, "Alice", 1),
    "Published by Alice · glm-5.3 · 1 correction applied",
  );
  assert.equal(
    provenanceLine({ model: "glm-5.3", sourceCount: 5 }, "Alice", 0),
    "Published by Alice · glm-5.3 · 5 sources",
  );
});

// ── scope state (admin re-scope / settle) ─────────────────────────────────

test("gate matrix: unscoped is editable, scoped-unresolvable is read-only, admin may re-scope", () => {
  const resolver = (id) => (id === "design" ? [ALICE] : null);
  // Unscoped page: any member edits.
  assert.equal(canEditKnowledge({ scope: null }, BOB, resolver), "edit");
  // Scoped + resolvable: seat holders edit, others propose, admins edit.
  assert.equal(canEditKnowledge({ scope: "design" }, ALICE, resolver), "edit");
  assert.equal(canEditKnowledge({ scope: "design" }, BOB, resolver), "propose");
  assert.equal(
    canEditKnowledge({ scope: "design" }, BOB, resolver, true),
    "edit",
  );
  // Scoped + unresolvable/seatless: ordinary members propose (read-only +
  // "Propose a change"), admins edit so they can re-scope or unscope.
  assert.equal(canEditKnowledge({ scope: "ghost" }, BOB, resolver), "propose");
  assert.equal(
    canEditKnowledge({ scope: "ghost" }, BOB, resolver, true),
    "edit",
  );
});

test("scopeState reads the head scope and flags conflicting heads", () => {
  const page = (tags, at, id) =>
    ev({
      kind: KIND_WIKI_PAGE,
      tags: [["d", "home"], ...tags],
      created_at: at,
      id,
    });
  // Unscoped head.
  assert.deepEqual(scopeState([page([], 10, "a")], "home"), {
    status: "unscoped",
    scope: null,
  });
  // Scoped head; older revisions with a different scope do NOT conflict —
  // an admin re-scope is a legitimate history.
  assert.deepEqual(
    scopeState(
      [page([["t", "team:old"]], 10, "a"), page([["t", "team:new"]], 20, "b")],
      "home",
    ),
    { status: "scoped", scope: "new" },
  );
  // Two head revisions at the newest timestamp disagreeing about scope is a
  // genuine conflict an admin must settle.
  assert.deepEqual(
    scopeState(
      [page([["t", "team:a"]], 20, "a"), page([["t", "team:b"]], 20, "b")],
      "home",
    ),
    { status: "conflicting", scope: null },
  );
  // One head event carrying two scope tags is itself a conflict.
  assert.deepEqual(
    scopeState(
      [
        page(
          [
            ["t", "team:a"],
            ["t", "team:b"],
          ],
          20,
          "a",
        ),
      ],
      "home",
    ),
    { status: "conflicting", scope: null },
  );
});
