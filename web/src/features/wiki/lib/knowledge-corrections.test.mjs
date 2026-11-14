/**
 * Corrections on kind 44003 (`KIND_WIKI_CORRECTION`) with back-compat reads
 * of legacy kind 44001 corrections — the pinned consumption-side shape:
 * same `d`/`t` tags as before, per-author correction coordinates for
 * deletion, and applied-exclusion working across both generations.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  KIND_WIKI_CORRECTION,
  KIND_WIKI_PAGE,
  appliedCorrectionsFor,
  buildSuggestion,
  suggestionsFor,
} from "./knowledge.ts";

const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);

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

function correctionEvent(fields) {
  return ev({
    kind: fields.kind,
    pubkey: fields.pubkey,
    created_at: fields.created_at,
    tags: [
      ["d", `correction-for-${fields.slug}`],
      ["t", `correction-for:${fields.slug}`],
    ],
    content: fields.note ?? "fix it",
  });
}

function agentRevision(fields) {
  return ev({
    kind: 44002,
    created_at: fields.created_at,
    tags: [["d", fields.slug], ...(fields.aTags ?? [])],
  });
}

test("corrections publish as kind 44003 with the same tags as before", () => {
  const payload = buildSuggestion({
    slug: "home",
    note: "The date is wrong.",
    authorPubkey: BOB,
    now: 500,
  });
  assert.equal(KIND_WIKI_CORRECTION, 44003, "the pinned correction kind");
  assert.equal(payload.kind, KIND_WIKI_CORRECTION);
  assert.deepEqual(payload.tags, [
    ["d", "correction-for-home"],
    ["t", "correction-for:home"],
  ]);
  assert.equal(payload.content, "The date is wrong.");
  assert.equal(payload.created_at, 500);
});

test("legacy 44001 corrections are still listed alongside 44003", () => {
  const events = [
    correctionEvent({
      kind: KIND_WIKI_PAGE,
      pubkey: ALICE,
      created_at: 100,
      slug: "home",
      note: "legacy",
    }),
    correctionEvent({
      kind: KIND_WIKI_CORRECTION,
      pubkey: BOB,
      created_at: 200,
      slug: "home",
      note: "current",
    }),
  ];
  const list = suggestionsFor(events, "home");
  assert.equal(list.length, 2, "both generations are read back");
  assert.equal(list[0].note, "current");
  assert.equal(list[1].note, "legacy");
});

test("a 44003 correction supersedes the same author's legacy 44001 one", () => {
  const events = [
    correctionEvent({
      kind: KIND_WIKI_PAGE,
      pubkey: BOB,
      created_at: 100,
      slug: "home",
      note: "old",
    }),
    correctionEvent({
      kind: KIND_WIKI_CORRECTION,
      pubkey: BOB,
      created_at: 200,
      slug: "home",
      note: "new",
    }),
  ];
  const list = suggestionsFor(events, "home");
  assert.equal(list.length, 1, "one live suggestion per author per page");
  assert.equal(list[0].note, "new");
});

test("applied-exclusion works for both correction generations", () => {
  const events = [
    correctionEvent({
      kind: KIND_WIKI_CORRECTION,
      pubkey: BOB,
      created_at: 100,
      slug: "home",
    }),
    correctionEvent({
      kind: KIND_WIKI_PAGE,
      pubkey: ALICE,
      created_at: 100,
      slug: "home",
    }),
    agentRevision({
      slug: "home",
      created_at: 500,
      aTags: [
        ["a", `44003:${BOB}:correction-for-home`],
        ["a", `44001:${ALICE}:correction-for-home`],
      ],
    }),
  ];
  assert.deepEqual(suggestionsFor(events, "home"), []);
  const applied = appliedCorrectionsFor(events, "home");
  assert.equal(applied.length, 2);
});

test("a 44003 correction referenced under the legacy coordinate is still consumed", () => {
  const events = [
    correctionEvent({
      kind: KIND_WIKI_CORRECTION,
      pubkey: BOB,
      created_at: 100,
      slug: "home",
    }),
    agentRevision({
      slug: "home",
      created_at: 500,
      aTags: [["a", `44001:${BOB}:correction-for-home`]],
    }),
  ];
  assert.deepEqual(suggestionsFor(events, "home"), []);
  assert.equal(appliedCorrectionsFor(events, "home").length, 1);
});

test("an unreferenced correction stays open", () => {
  const events = [
    correctionEvent({
      kind: KIND_WIKI_CORRECTION,
      pubkey: BOB,
      created_at: 100,
      slug: "home",
    }),
  ];
  assert.equal(suggestionsFor(events, "home").length, 1);
  assert.deepEqual(appliedCorrectionsFor(events, "home"), []);
});
