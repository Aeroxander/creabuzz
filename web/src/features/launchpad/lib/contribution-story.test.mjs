import assert from "node:assert/strict";
import test from "node:test";

import { hashText, idWord } from "@creaton/core/launchpad/work.ts";

import {
  firstLink,
  shortEvidence,
  storyFor,
  storyKey,
} from "./contribution-story.ts";

const BUDGET = `0x${"b1".repeat(20)}`;
const CLAIM = idWord("write-docs");
const EVIDENCE = "Merged in https://example.com/pr/1. All twelve pages.";
const CHECK = "the docs are merged and reviewed";

const claim = (over = {}) => ({
  id: CLAIM,
  record: { evidenceHash: hashText(EVIDENCE), checkHash: hashText(CHECK) },
  approvals: 2,
  quorum: 2,
  ...over,
});

const packet = (evidence, check = CHECK, author = "a".repeat(64)) => ({
  eventId: `e-${evidence.length}-${check.length}`,
  author,
  createdAt: 100,
  claimId: CLAIM,
  mandate: BUDGET,
  evidence,
  check,
});

const award = { budget: BUDGET, claimId: CLAIM, blockNumber: 42 };

test("a story says when, how the review went, and what was delivered, each from its source", () => {
  const story = storyFor(award, {
    times: new Map([[42, 1_800_000_000]]),
    claims: new Map([[storyKey(BUDGET, CLAIM), claim()]]),
    packets: [packet(EVIDENCE)],
  });
  assert.deepEqual(story, {
    at: 1_800_000_000,
    review: { approvals: 2, quorum: 2 },
    evidence: EVIDENCE,
    evidenceState: "verified",
  });
});

test("evidence that is not what the claim committed to is never shown as theirs", () => {
  // Someone published other words for the claim (or edited theirs after): it does not hash to the claim's evidence.
  const story = storyFor(award, {
    times: new Map(),
    claims: new Map([[storyKey(BUDGET, CLAIM), claim()]]),
    packets: [packet("Something else entirely")],
  });
  assert.equal(story.evidence, null);
  assert.equal(story.evidenceState, "mismatch");
  // Its block could not be read: no date, rather than a guess.
  assert.equal(story.at, null);
  // No evidence published at all.
  assert.equal(
    storyFor(award, {
      times: new Map(),
      claims: new Map([[storyKey(BUDGET, CLAIM), claim()]]),
      packets: [],
    }).evidenceState,
    "missing",
  );
});

test("a claim the page did not read leaves the review and the evidence unknown, not empty", () => {
  const story = storyFor(award, {
    times: new Map([[42, 1]]),
    claims: new Map(),
    packets: [packet(EVIDENCE)],
  });
  assert.deepEqual(story, {
    at: 1,
    review: null,
    evidence: null,
    evidenceState: "unknown",
  });
});

test("evidence is shortened at a word, and its first link is kept whole", () => {
  assert.equal(shortEvidence("short and sweet"), "short and sweet");
  const long = `${"word ".repeat(60)}end`;
  const short = shortEvidence(long, 40);
  assert.ok(short.length <= 41 && short.endsWith("…"));
  assert.ok(!short.includes("wor…"));
  assert.equal(firstLink(EVIDENCE), "https://example.com/pr/1");
  assert.equal(firstLink("no links here"), null);
  assert.equal(firstLink("javascript:alert(1) and ftp://x"), null);
});

test("absence says nothing was published only when the whole history was read and answered", () => {
  const story = (read) =>
    storyFor(award, {
      times: new Map(),
      claims: new Map([[storyKey(BUDGET, CLAIM), claim()]]),
      packets: [],
      read,
    }).evidenceState;
  assert.equal(
    story({ loading: false, error: false, incomplete: false }),
    "missing",
  );
  // A failed read, a read cut short at its limit, and one still on its way are each said as what they are.
  assert.equal(
    story({ loading: false, error: true, incomplete: false }),
    "unreadable",
  );
  assert.equal(
    story({ loading: false, error: false, incomplete: true }),
    "not-found",
  );
  assert.equal(
    story({ loading: true, error: false, incomplete: false }),
    "reading",
  );
  // Evidence found in what was read is checked whatever else happened to the read.
  assert.equal(
    storyFor(award, {
      times: new Map(),
      claims: new Map([[storyKey(BUDGET, CLAIM), claim()]]),
      packets: [packet(EVIDENCE)],
      read: { loading: false, error: true, incomplete: true },
    }).evidenceState,
    "verified",
  );
});
