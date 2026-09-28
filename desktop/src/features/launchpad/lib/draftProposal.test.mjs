/**
 * Golden-vector tests for the persona drafting loop (B1) — the SAME fixture
 * and the SAME canonical content strings as `buzz-agwiki::draft`'s Rust tests
 * and desktop's `draftProposal.test.mjs`, so the CLI loop and the UI journey
 * can never diverge silently (docs/persona-drafting-loop.md §Test discipline).
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  bodyWithoutDecisionBlocks,
  composeAcceptedRecord,
  composeDraftContent,
  composeDraftEvent,
  composeRejectTombstone,
  decisionDrafts,
  parseDecisionBlocks,
  parseStrictCalls,
  parseStrictIntent,
  parseWikiTag,
} from "./draftProposal.ts";

function corpus() {
  const s = [];
  s.push("## Standup\n");
  s.push("");
  s.push(
    "Quorum is 500 bps today. The round-2 postmortem asks for a 600 bps quorum.\n",
  );
  s.push("");
  s.push("```decision\n");
  s.push("title: Raise proposal quorum to 600 bps\n");
  s.push("kind: plain\n");
  s.push("evidence: The round-2 postmortem asks for a 600 bps quorum.\n");
  s.push(
    'intent: {"op":0,"to":"0x1111111111111111111111111111111111111111","value":"0","data":"0x1234","nonce":"0x0000000000000000000000000000000000000000000000000000000000000001"}\n',
  );
  s.push("```\n");
  s.push("");
  s.push("Sell pressure is capped at 15% per epoch today.\n");
  s.push("");
  s.push("```decision\n");
  s.push("title: Document the sell-rate gate\n");
  s.push("kind: plain\n");
  s.push("evidence: Sell pressure is capped at 15% per epoch today.\n");
  s.push(
    'calls: [{"operation":"call","from":"0x0000000000000000000000000000000000000000","to":"0x2222222222222222222222222222222222222222","value":"0","data":"0x"}]\n',
  );
  s.push("```\n");
  s.push("");
  s.push("People keep asking for a weekly standup digest.\n");
  s.push("");
  s.push("```decision\n");
  s.push("title: Weekly digest signal\n");
  s.push("kind: signal\n");
  s.push("evidence: People keep asking for a weekly standup digest.\n");
  s.push("```\n");
  s.push("");
  s.push("```decision\n");
  s.push("title: Invent a number\n");
  s.push("kind: plain\n");
  s.push("evidence: The quorum is 999 bps and everyone agrees.\n");
  s.push("```\n");
  s.push("");
  s.push("```decision\n");
  s.push("title: Signal with intent\n");
  s.push("kind: signal\n");
  s.push("evidence: People keep asking for a weekly standup digest.\n");
  s.push(
    'intent: {"op":0,"to":"0x1111111111111111111111111111111111111111","value":"0","data":"0x","nonce":"0x0000000000000000000000000000000000000000000000000000000000000001"}\n',
  );
  s.push("```\n");
  s.push("");
  s.push("```decision\n");
  s.push("title: Record-only proposal\n");
  s.push("kind: plain\n");
  s.push("evidence: Sell pressure is capped at 15% per epoch today.\n");
  s.push(
    'intent: {"op":2,"to":"0x1111111111111111111111111111111111111111","value":"0","data":"0x","nonce":"0x0000000000000000000000000000000000000000000000000000000000000001"}\n',
  );
  s.push("```\n");
  return s.join("");
}

// Pinned identically in buzz-agwiki's draft.rs and desktop's draftProposal.test.mjs.
const GOLDEN_1 =
  '{"proposalId":null,"kind":"plain","issue":null,"state":"agent-draft","title":"Raise proposal quorum to 600 bps","evidence":"The round-2 postmortem asks for a 600 bps quorum.","intent":{"op":0,"to":"0x1111111111111111111111111111111111111111","value":"0","data":"0x1234","nonce":"0x0000000000000000000000000000000000000000000000000000000000000001"}}';
const GOLDEN_2 =
  '{"proposalId":null,"kind":"plain","issue":null,"state":"agent-draft","title":"Document the sell-rate gate","evidence":"Sell pressure is capped at 15% per epoch today.","calls":[{"operation":"call","from":"0x0000000000000000000000000000000000000000","to":"0x2222222222222222222222222222222222222222","value":"0","data":"0x"}]}';
const GOLDEN_3 =
  '{"proposalId":null,"kind":"signal","issue":null,"state":"agent-draft","title":"Weekly digest signal","evidence":"People keep asking for a weekly standup digest."}';
const GOLDEN_6 =
  '{"proposalId":null,"kind":"plain","issue":null,"state":"agent-draft","title":"Record-only proposal","evidence":"Sell pressure is capped at 15% per epoch today."}';

test("golden corpus composes exact content (cross-language vectors)", () => {
  const out = decisionDrafts(corpus());
  assert.deepEqual(
    out.drafts.map((d) => d.content),
    [GOLDEN_1, GOLDEN_2, GOLDEN_3, GOLDEN_6],
  );
  assert.deepEqual(
    out.drafts.map((d) => d.anchor),
    [1, 2, 3, 6],
  );
});

test("skips are reported with anchors, never repaired", () => {
  const out = decisionDrafts(corpus());
  assert.equal(out.skipped.length, 2);
  assert.equal(out.skipped[0].anchor, 4);
  assert.match(out.skipped[0].reason, /non-verbatim/);
  assert.equal(out.skipped[1].anchor, 5);
  assert.match(out.skipped[1].reason, /contradictory/);
});

test("malformed intent drops to record-only, not the block", () => {
  const out = decisionDrafts(corpus());
  const row = out.drafts.find((d) => d.title === "Record-only proposal");
  assert.ok(row);
  assert.ok(!row.content.includes("intent"));
  assert.ok(!row.content.includes('"calls"'));
});

test("evidence must come from prose, not another block", () => {
  const body = [
    "Intro line with nothing quoted.",
    "",
    "```decision",
    "title: One",
    "kind: plain",
    "evidence: Only inside block two.",
    "```",
    "",
    "```decision",
    "title: Two",
    "kind: plain",
    "evidence: Only inside block two.",
    "```",
    "",
  ].join("\n");
  const out = decisionDrafts(body);
  assert.equal(out.drafts.length, 0);
  assert.equal(out.skipped.length, 2);
});

test("anchors count skipped blocks stably", () => {
  const out = decisionDrafts(corpus());
  assert.equal(out.drafts[3].anchor, 6);
});

test("deterministic across runs", () => {
  assert.deepEqual(decisionDrafts(corpus()), decisionDrafts(corpus()));
});

test("unterminated block is skipped, not half-parsed", () => {
  const body = [
    "The gate is real prose.",
    "",
    "```decision",
    "title: Never closed",
    "kind: plain",
    "evidence: The gate is real prose.",
    "",
  ].join("\n");
  const out = decisionDrafts(body);
  assert.equal(out.drafts.length, 0);
  assert.equal(out.skipped.length, 1);
  assert.match(out.skipped[0].reason, /unterminated/);
});

test("structural drops: missing title, unknown kind, empty title", () => {
  const cases = [
    "```decision\nkind: plain\nevidence: The gate is real prose.\n```\n",
    "```decision\nkind: vibes\nevidence: The gate is real prose.\ntitle: T\n```\n",
    "```decision\ntitle: \nkind: plain\nevidence: The gate is real prose.\n```\n",
  ];
  for (const block of cases) {
    const body = `The gate is real prose.\n\n${block}`;
    const out = decisionDrafts(body);
    assert.equal(out.drafts.length, 0, `composed: ${block}`);
    assert.equal(out.skipped.length, 1, `case: ${block}`);
  }
});

test("hash in a quote survives verbatim (no comment stripping)", () => {
  const body =
    "Members asked for the #quorum thread to stay open.\n\n```decision\nkind: plain\ntitle: Keep the thread open\nevidence: Members asked for the #quorum thread to stay open.\n```\n";
  const out = decisionDrafts(body);
  assert.equal(out.drafts.length, 1);
});

test("value shapes match the strict parsers", () => {
  const good = {
    op: 1,
    to: "0x1111111111111111111111111111111111111111",
    value: "5",
    data: "0x",
    nonce: "0x0000000000000000000000000000000000000000000000000000000000000001",
    extra: true,
  };
  const intent = parseStrictIntent(good);
  assert.ok(intent);
  assert.equal(intent.op, 1);
  assert.equal(intent.value, "5");
  const bad = [
    { ...good, op: "0" },
    { ...good, op: 2 },
    { ...good, to: "0x11" },
    { ...good, value: 0 },
    { ...good, value: "-1" },
    { ...good, data: "0x1" },
    { ...good, nonce: "0x01" },
    [good],
  ];
  for (const value of bad) {
    assert.equal(parseStrictIntent(value), null, JSON.stringify(value));
  }
  assert.ok(
    parseStrictCalls([
      { operation: "delegatecall", from: "a", to: "b", value: "0", data: "c" },
    ]),
  );
  const badCalls = [
    [{ operation: "staticcall", from: "a", to: "b", value: "0", data: "c" }],
    [{ operation: "call", from: "a", to: "b", value: "0" }],
    [],
    { operation: "call" },
  ];
  for (const value of badCalls) {
    assert.equal(parseStrictCalls(value), null, JSON.stringify(value));
  }
});

test("event envelopes: draft, accepted record, reject tombstone", () => {
  const out = decisionDrafts(corpus());
  const launch =
    "37001:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:nebula-dao";
  const page =
    "44002:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:default/standup";
  const draft = composeDraftEvent(launch, page, out.drafts[0]);
  assert.equal(draft.kind, 47004);
  assert.equal(draft.content, GOLDEN_1);
  assert.deepEqual(draft.tags, [
    ["a", launch],
    ["wiki", page, "1"],
  ]);

  const accepted = composeAcceptedRecord(launch, page, out.drafts[0], "42");
  const parsed = JSON.parse(accepted.content);
  assert.equal(parsed.state, "open");
  assert.equal(parsed.proposalId, "42");
  assert.equal(parsed.evidence, out.drafts[0].evidence);
  assert.equal(parsed.title, out.drafts[0].title);
  assert.deepEqual(accepted.tags[1], ["wiki", page, "1"]);

  const tombstone = composeRejectTombstone("f".repeat(64));
  assert.equal(tombstone.kind, 5);
  assert.deepEqual(tombstone.tags, [["e", "f".repeat(64)]]);
});

test("parseWikiTag is strict (D7/D8 pointer)", () => {
  assert.deepEqual(parseWikiTag([["wiki", "44002:aa:default/standup", "3"]]), {
    page: "44002:aa:default/standup",
    anchor: 3,
  });
  assert.equal(parseWikiTag([["wiki", "x", "not-a-number"]]), null);
  assert.equal(parseWikiTag([["wiki", "x"]]), null);
  assert.equal(parseWikiTag([["other", "x", "3"]]), null);
  assert.equal(parseWikiTag(undefined), null);
});

test("bodyWithoutDecisionBlocks strips only blocks", () => {
  const prose = bodyWithoutDecisionBlocks(corpus());
  assert.ok(prose.includes("Quorum is 500 bps today."));
  assert.ok(!prose.includes("```decision"));
  assert.ok(!prose.includes("title: Raise proposal quorum to 600 bps"));
});

test("parseDecisionBlocks: first occurrence wins, junk lines ignored", () => {
  const body = [
    "```decision",
    "title: One",
    "title: Two",
    "junk without colon",
    "kind: plain",
    "evidence: prose.",
    "```",
  ].join("\n");
  const { blocks } = parseDecisionBlocks(body);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].fields.find(([k]) => k === "title")[1], "One");
});

test("composeDraftContent keeps the canonical field order", () => {
  const content = composeDraftContent({
    anchor: 1,
    title: "T",
    kind: "plain",
    evidence: "E",
  });
  assert.equal(
    content,
    '{"proposalId":null,"kind":"plain","issue":null,"state":"agent-draft","title":"T","evidence":"E"}',
  );
});
