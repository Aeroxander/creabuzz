import assert from "node:assert/strict";
import test from "node:test";

import { hashText, idWord } from "@creaton/core/launchpad/work.ts";

import { buildTimeline } from "./milestone-timeline.ts";

const PANEL = "0x00000000000000000000000000000000000000b1";
const ALICE = "0x000000000000000000000000000000000000a11c";
const BOB = "0x0000000000000000000000000000000000000b0b";
const NOW = 2_000_000_000;
const WINDOW = 259_200;
const PROJECT = `0x${"11".repeat(32)}`;

const MILESTONES = [
  { label: "Beta shipped", percent: 50 },
  { label: "First paying users", percent: 50 },
];

const claim = (name, label, status, over = {}) => ({
  id: idWord(name),
  record: {
    contributor: ALICE,
    amount: 0n,
    stake: 0n,
    status,
    evidenceHash: hashText(`evidence for ${name}`),
    checkHash: hashText(label),
    releasedAt: 0,
    ...(over.record ?? {}),
  },
  project: over.project === undefined ? PROJECT : over.project,
  approvals: over.approvals ?? 0,
  objections: over.objections ?? 0,
  quorum: 2,
  sharesAwarded: false,
});
const panel = (claims) => ({
  address: PANEL,
  reviewers: [{ address: ALICE }, { address: BOB }],
  quorum: 2,
  challengeWindow: WINDOW,
  claims,
});
const tranche = (index, label, over = {}) => ({
  index,
  amount: 500n,
  checkHash: hashText(label),
  unlocked: false,
  forfeited: false,
  reachedAt: null,
  ...over,
});
const packet = (name, label) => ({
  eventId: `e-${name}`,
  author: ALICE,
  createdAt: 1,
  claimId: idWord(name).toLowerCase(),
  mandate: PANEL,
  evidence: `evidence for ${name}`,
  check: label,
});
const build = (over = {}) =>
  buildTimeline({
    milestones: MILESTONES,
    panel: panel([]),
    tranches: [[tranche(0, "Beta shipped"), tranche(1, "First paying users")]],
    verdicts: new Map(),
    packets: [],
    now: NOW,
    ...over,
  });

test("before the project launches every milestone is agreed, with its words and share, and nothing is claimed about the chain", () => {
  const { entries, summary } = build({ panel: null, tranches: [] });
  assert.deepEqual(
    entries.map((e) => [e.label, e.percent, e.stage, e.tokens]),
    [
      ["Beta shipped", 50, "agreed", null],
      ["First paying users", 50, "agreed", null],
    ],
  );
  assert.equal(summary.reached, 0);
  assert.match(entries[0].headline, /Agreed/);
});

test("a milestone nobody has submitted says so, and shows every reviewer as not having decided", () => {
  const [first] = build().entries;
  assert.equal(first.stage, "not-submitted");
  assert.equal(first.tokens, 500n);
  assert.deepEqual(
    first.verdicts.map((v) => v.verdict),
    ["none", "none"],
  );
  assert.equal(first.evidence, null);
  assert.equal(first.evidenceMissing, false);
});

test("a claim with the reviewers shows the count, who approved, who objected and who has not decided", () => {
  const c = claim("m1", "Beta shipped", "Open", {
    approvals: 1,
    objections: 1,
  });
  const { entries } = build({
    panel: panel([c]),
    verdicts: new Map([
      [
        `${PANEL}:${c.id}`.toLowerCase(),
        [
          { reviewer: ALICE, approve: true },
          { reviewer: BOB, approve: false },
        ],
      ],
    ]),
    packets: [packet("m1", "Beta shipped")],
  });
  const first = entries[0];
  assert.equal(first.stage, "reviewing");
  assert.match(first.headline, /1 of 2 approved, 1 objected/);
  assert.deepEqual(
    first.verdicts.map((v) => v.verdict),
    ["approved", "objected"],
  );
  // The evidence the team published is shown because it matches what the claim committed to.
  assert.equal(first.evidence.text, "evidence for m1");
});

test("an approved claim shows when the challenge window ends", () => {
  const c = claim("m1", "Beta shipped", "Approved", {
    record: { releasedAt: NOW - 3_600 },
  });
  const [first] = build({ panel: panel([c]) }).entries;
  assert.equal(first.stage, "waiting");
  assert.equal(first.challengeEndsAt, NOW - 3_600 + WINDOW);
  assert.match(first.headline, /Anyone can still object until/);
});

test("once the window is over the release is ready to be finished, and a paid claim to be claimed", () => {
  const approved = claim("m1", "Beta shipped", "Approved", {
    record: { releasedAt: NOW - WINDOW - 10 },
  });
  assert.equal(build({ panel: panel([approved]) }).entries[0].stage, "finish");
  const paid = claim("m1", "Beta shipped", "Paid");
  assert.equal(build({ panel: panel([paid]) }).entries[0].stage, "ready");
});

test("an unlocked milestone says when, and counts toward what has been reached", () => {
  const c = claim("m1", "Beta shipped", "Paid");
  const { entries, summary } = build({
    panel: panel([c]),
    tranches: [
      [
        tranche(0, "Beta shipped", { unlocked: true, reachedAt: NOW - 100 }),
        tranche(1, "First paying users"),
      ],
    ],
  });
  assert.equal(entries[0].stage, "unlocked");
  assert.equal(entries[0].releasedAt, NOW - 100);
  assert.match(entries[0].headline, /Unlocked on/);
  assert.equal(summary.reached, 1);
  assert.equal(summary.released, 500n);
  assert.equal(summary.heldBack, 500n);
});

test("a turned-down claim is shown as such, with an earlier attempt counted, and a new live claim takes over", () => {
  const first = claim("m1", "Beta shipped", "Rejected");
  const second = claim("m1-2", "Beta shipped", "Open", { approvals: 0 });
  const { entries } = build({ panel: panel([first, second]) });
  assert.equal(entries[0].stage, "reviewing");
  assert.equal(entries[0].earlierAttempts, 1);
  const only = build({ panel: panel([first]) }).entries[0];
  assert.equal(only.stage, "turned-down");
  assert.match(only.headline, /turned this claim down/);
});

test("a frozen claim says nothing unlocks while it is frozen", () => {
  const c = claim("m1", "Beta shipped", "Frozen");
  const [first] = build({ panel: panel([c]) }).entries;
  assert.equal(first.stage, "frozen");
  assert.match(first.headline, /Nothing unlocks while it is frozen/);
});

test("evidence that does not match what the claim committed to is never shown, and the claim says it is missing", () => {
  const c = claim("m1", "Beta shipped", "Open", { approvals: 0 });
  const wrong = { ...packet("m1", "Beta shipped"), evidence: "something else" };
  const [first] = build({ panel: panel([c]), packets: [wrong] }).entries;
  assert.equal(first.evidence, null);
  assert.equal(first.evidenceMissing, true);
});

test("verdicts that could not be read are unknown, never 'nobody decided'", () => {
  const c = claim("m1", "Beta shipped", "Open", { approvals: 1 });
  const [first] = build({ panel: panel([c]), verdicts: undefined }).entries;
  assert.deepEqual(
    first.verdicts.map((v) => v.verdict),
    ["unknown", "unknown"],
  );
});

test("tokens the DAO gave up are reported as given up, not as held back", () => {
  const { entries, summary } = build({
    tranches: [
      [
        tranche(0, "Beta shipped", { forfeited: true }),
        tranche(1, "First paying users"),
      ],
    ],
  });
  assert.equal(entries[0].stage, "given-up");
  assert.equal(summary.givenUp, 500n);
  assert.equal(summary.heldBack, 500n);
});

test("with several team members, a milestone unlocked for only some says how many", () => {
  const { entries } = build({
    panel: panel([claim("m1", "Beta shipped", "Paid")]),
    tranches: [
      [tranche(0, "Beta shipped", { unlocked: true })],
      [tranche(0, "Beta shipped")],
    ],
  });
  assert.equal(entries[0].tokens, 1000n);
  assert.deepEqual(entries[0].unlockedFor, { unlocked: 1, of: 2 });
  assert.notEqual(entries[0].stage, "unlocked");
});
