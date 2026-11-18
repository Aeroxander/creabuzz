import assert from "node:assert/strict";
import test from "node:test";

import { hashText, idWord } from "@creaton/core/launchpad/work.ts";
import {
  milestoneClaimNames,
  milestoneProgress,
} from "./milestone-progress.ts";
import {
  allocateClaimName,
  CLAIM_CHECK_SUPERSEDED,
  CLAIM_NAME_UNCHECKED,
  CLAIM_NAMES_USED_UP,
  claimForDraft,
  claimSlotEmpty,
  clearSubmission,
  loadSubmission,
  nameTakenByOther,
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
    /not what was sent/,
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

test("a submission that could not be kept is reported as not saved, so nothing is sent after it", () => {
  const K = submissionKey("0xDAO", WALLET, 1);
  // Saved and read back: kept.
  const kept = new Map();
  assert.equal(
    saveSubmission(K, draft, {
      setItem: (k, v) => kept.set(k, v),
      getItem: (k) => kept.get(k) ?? null,
    }),
    true,
  );
  // The write throws (quota, private mode).
  assert.equal(
    saveSubmission(K, draft, {
      setItem: () => {
        throw new DOMException("full", "QuotaExceededError");
      },
      getItem: () => null,
    }),
    false,
  );
  // The write is dropped without a word: reading it back finds nothing.
  assert.equal(
    saveSubmission(K, draft, { setItem: () => {}, getItem: () => null }),
    false,
  );
  // No storage at all.
  assert.equal(saveSubmission(K, draft, null), false);
});

/** A chain that knows some claim names: `isFree` as the row asks it, through the record read. */
const chainWith = (filed) => {
  const asked = [];
  const empty = `0x${"0".repeat(64 * 8)}`;
  const full = `0x${"0".repeat(24)}${WALLET.slice(2)}${"0".repeat(64 * 7)}`;
  return {
    asked,
    isFree: async (name) => {
      asked.push(name);
      return claimSlotEmpty(filed.includes(name) ? full : empty);
    },
  };
};

const memoryStorage = () => {
  const store = new Map();
  return {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k),
  };
};

test("after a rejection, corrected work is filed under a new claim name, not the turned-down one", async () => {
  const rejected = claim({}, { status: "Rejected", checkHash: CHECK });
  // The milestone reads as turned down, so a new submission is offered.
  assert.equal(milestoneProgress(rejected, 0, 0, false).stage, "turned-down");
  const chain = chainWith(["milestone-1"]);
  const named = await allocateClaimName(0, ["milestone-1"], chain.isFree);
  assert.deepEqual(named, { name: "milestone-1-2" });
  assert.notEqual(idWord(named.name), rejected.id);
  // The corrected text starts from the top under its own name: nothing reads it as the closed claim.
  const corrected = {
    name: named.name,
    evidence: "https://example.com/alpha-fixed",
  };
  assert.equal(claimForDraft([rejected], corrected, WALLET), null);
  assert.deepEqual(
    remainingSteps({
      draft: corrected,
      claim: null,
      checkHash: CHECK,
      published: false,
    }),
    { steps: ["file", "check", "bind", "publish"] },
  );
});

test("a name the shown claims miss but the chain has (an older claim, or one filed since) is not chosen", async () => {
  const chain = chainWith(["milestone-1", "milestone-1-2"]);
  assert.deepEqual(await allocateClaimName(0, [], chain.isFree), {
    name: "milestone-1-3",
  });
  assert.deepEqual(chain.asked, [
    "milestone-1",
    "milestone-1-2",
    "milestone-1-3",
  ]);
});

test("a partial submission reloads to the same claim name and continues it, never a new one", async () => {
  const storage = memoryStorage();
  const key = submissionKey("0xDAO", WALLET, 0);
  const named = await allocateClaimName(0, [], chainWith([]).isFree);
  const saved = { name: named.name, evidence: draft.evidence };
  assert.equal(saveSubmission(key, saved, storage), true);
  // The claim was filed, then the tab closed before the rest.
  const filed = claim({ id: idWord(saved.name) });
  const reloaded = loadSubmission(key, storage);
  assert.deepEqual(reloaded, saved);
  assert.equal(
    claimForDraft([filed], reloaded, WALLET)?.id,
    idWord(saved.name),
  );
  assert.deepEqual(
    remainingSteps({
      draft: reloaded,
      claim: claimForDraft([filed], reloaded, WALLET),
      checkHash: CHECK,
      published: false,
      nameTaken: nameTakenByOther([filed], reloaded, WALLET),
    }),
    { steps: ["check", "bind", "publish"] },
  );
});

test("when every name is used, or the network cannot say, nothing is chosen and the reason is given", async () => {
  const all = milestoneClaimNames(0);
  const quiet = chainWith([]);
  assert.deepEqual(await allocateClaimName(0, all, quiet.isFree), {
    problem: CLAIM_NAMES_USED_UP,
  });
  assert.deepEqual(quiet.asked, []);
  // Shown names miss them, but the chain has all of them: still bounded, still said.
  const busy = chainWith(all);
  assert.deepEqual(await allocateClaimName(0, [], busy.isFree), {
    problem: CLAIM_NAMES_USED_UP,
  });
  assert.equal(busy.asked.length, all.length);
  assert.deepEqual(
    await allocateClaimName(0, [], async () => {
      throw new Error("node down");
    }),
    { problem: CLAIM_NAME_UNCHECKED },
  );
  // A reply too short to be the record is unreadable, never "free".
  assert.throws(() => claimSlotEmpty("0x"));
  assert.throws(() => claimSlotEmpty(`0x${"0".repeat(64)}`));
});

test("a draft whose name someone else filed first says so instead of offering a Continue that is always refused", () => {
  const theirs = claim({}, { contributor: OTHER });
  assert.equal(nameTakenByOther([theirs], draft, WALLET), true);
  assert.equal(nameTakenByOther([claim()], draft, WALLET), false);
  assert.match(
    String(
      remainingSteps({
        draft,
        claim: claimForDraft([theirs], draft, WALLET),
        checkHash: CHECK,
        published: false,
        nameTaken: nameTakenByOther([theirs], draft, WALLET),
      }).problem,
    ),
    /Someone else already used this submission's name/,
  );
});

test("a name check that finishes after the wallet changed files nothing under the old wallet", async () => {
  let current = true;
  const chain = chainWith([]);
  const named = await allocateClaimName(
    0,
    [],
    async (name) => {
      const free = await chain.isFree(name);
      current = false; // the wallet switched while the network answered
      return free;
    },
    () => current,
  );
  assert.deepEqual(named, { problem: CLAIM_CHECK_SUPERSEDED });
  // Still current: the same check chooses the name as before.
  assert.deepEqual(
    await allocateClaimName(0, [], chainWith([]).isFree, () => true),
    { name: milestoneClaimNames(0)[0] },
  );
});

test("problems that end a submission name the Start over button, and running out gives a real next step", () => {
  for (const problem of [
    remainingSteps({
      draft,
      claim: claim({}, { status: "Rejected" }),
      checkHash: CHECK,
      published: false,
    }).problem,
    remainingSteps({
      draft: { ...draft, evidence: "something else" },
      claim: claim(),
      checkHash: CHECK,
      published: false,
    }).problem,
  ]) {
    assert.match(String(problem), /Press Start over/);
  }
  assert.doesNotMatch(CLAIM_NAMES_USED_UP, /reviewers/);
  assert.match(CLAIM_NAMES_USED_UP, /Decisions tab/);
  assert.match(CLAIM_NAMES_USED_UP, /\b99\b/);
});
