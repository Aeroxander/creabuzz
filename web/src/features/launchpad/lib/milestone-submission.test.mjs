import assert from "node:assert/strict";
import test from "node:test";

import { hashText, idWord } from "@creaton/core/launchpad/work.ts";
import {
  claimForDraft,
  clearSubmission,
  loadSubmission,
  remainingSteps,
  saveSubmission,
  submissionKey,
} from "./milestone-submission.ts";

const WALLET = "0x00000000000000000000000000000000000000a1";
const OTHER = "0x00000000000000000000000000000000000000b2";
const ZERO = `0x${"0".repeat(64)}`;
const CHECK = hashText("alpha shipped");
const draft = { name: "milestone-1", evidence: "https://example.com/alpha" };

const claim = (over = {}, record = {}) => ({
  id: idWord(draft.name),
  project: null,
  approvals: 0,
  objections: 0,
  quorum: 2,
  sharesAwarded: false,
  record: {
    contributor: WALLET,
    status: "Open",
    evidenceHash: hashText(draft.evidence),
    checkHash: ZERO,
    ...record,
  },
  ...over,
});

test("a submission with nothing on the chain starts from the top", () => {
  assert.deepEqual(
    remainingSteps({ draft, claim: null, checkHash: CHECK, published: false }),
    { steps: ["file", "check", "bind", "publish"] },
  );
});

test("each retry does only what is left: no second claim, no repeated step", () => {
  // Filed, nothing else.
  assert.deepEqual(
    remainingSteps({
      draft,
      claim: claim(),
      checkHash: CHECK,
      published: false,
    }),
    { steps: ["check", "bind", "publish"] },
  );
  // Filed and the criterion set.
  assert.deepEqual(
    remainingSteps({
      draft,
      claim: claim({}, { checkHash: CHECK }),
      checkHash: CHECK,
      published: false,
    }),
    { steps: ["bind", "publish"] },
  );
  // With the reviewers, but the evidence was never published (the case a retry of the last step used to leave).
  assert.deepEqual(
    remainingSteps({
      draft,
      claim: claim({ project: `0x${"11".repeat(32)}` }, { checkHash: CHECK }),
      checkHash: CHECK,
      published: false,
    }),
    { steps: ["publish"] },
  );
  // All of it done.
  assert.deepEqual(
    remainingSteps({
      draft,
      claim: claim({ project: `0x${"11".repeat(32)}` }, { checkHash: CHECK }),
      checkHash: CHECK,
      published: true,
    }),
    { steps: [] },
  );
});

test("a claim that cannot be continued says why instead of being filed over", () => {
  const problem = (c) =>
    remainingSteps({ draft, claim: c, checkHash: CHECK, published: false })
      .problem;
  assert.match(
    String(problem(claim({}, { status: "Paid" }))),
    /no longer open/,
  );
  assert.match(
    String(problem(claim({}, { evidenceHash: hashText("something else") }))),
    /not what was filed/,
  );
  assert.match(
    String(problem(claim({}, { checkHash: hashText("other words") }))),
    /different words/,
  );
});

test("a draft stands for a claim only if the connected wallet filed it", () => {
  assert.equal(claimForDraft([claim()], draft, WALLET)?.id, idWord(draft.name));
  assert.equal(claimForDraft([claim()], draft, OTHER), null);
  assert.equal(claimForDraft([claim()], null, WALLET), null);
  assert.equal(claimForDraft([], draft, WALLET), null);
});

test("a saved submission comes back after a reload, per wallet and per milestone, and bad data is ignored", () => {
  const store = new Map();
  const storage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k),
  };
  const key = submissionKey("0xDAO", WALLET, 1);
  assert.notEqual(key, submissionKey("0xDAO", WALLET, 0));
  assert.notEqual(key, submissionKey("0xDAO", OTHER, 1));
  assert.equal(loadSubmission(key, storage), null);
  saveSubmission(key, draft, storage);
  assert.deepEqual(loadSubmission(key, storage), draft);
  clearSubmission(key, storage);
  assert.equal(loadSubmission(key, storage), null);
  store.set(key, "not json");
  assert.equal(loadSubmission(key, storage), null);
  store.set(key, JSON.stringify({ name: "", evidence: "x" }));
  assert.equal(loadSubmission(key, storage), null);
});
