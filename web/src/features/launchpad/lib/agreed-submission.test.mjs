import assert from "node:assert/strict";
import test from "node:test";

import {
  agreementIdOf,
  deliverableSlotKey,
  encodeBindSubmission,
  AGREE_SELECTORS,
} from "@creaton/core/launchpad/agreements.ts";
import {
  agreedDraftKey,
  clearAgreedDraft,
  listedDrafts,
  loadAgreedDraft,
  pendingPublishDraft,
  planBeneficiaryCalls,
  planManagerBind,
  saveAgreedDraft,
} from "./agreed-submission.ts";

const CLAIMS = "0x00000000000000000000000000000000000000C1";
const MANDATE = "0x00000000000000000000000000000000000000D1";
const AGREEMENT = agreementIdOf(
  `0x${"ab".repeat(32)}`,
  deliverableSlotKey("the first guide"),
);
const WALLET = "0x00000000000000000000000000000000000000A1";
const OTHER_WALLET = "0x00000000000000000000000000000000000000A2";
const EVIDENCE = `0x${"e1".repeat(32)}`;
const CRITERIA = `0x${"c0".repeat(32)}`;
const CLAIM = `0x${"c1".repeat(32)}`;

function memory() {
  const map = new Map();
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    key: (index) => [...map.keys()][index] ?? null,
    get length() {
      return map.size;
    },
  };
}

const scope = (over = {}) => ({
  server: "wss://one.example",
  account: `${"ab".repeat(32)}`,
  wallet: WALLET,
  chainId: "31337",
  mandate: MANDATE,
  agreementId: AGREEMENT,
  ...over,
});

const draft = {
  attempt: 1,
  nonce: 7,
  claimId: CLAIM,
  artifact: "https://example.com/the-first-guide",
  met: "Compared it against the agreed words",
  notMet: "",
  criteriaWords: "a guide merged and reviewed",
};

function draftOf(attempt = draft.attempt) {
  return {
    ...draft,
    agreementId: AGREEMENT,
    mandate: MANDATE.toLowerCase(),
    chainId: "31337",
    attempt,
    savedAt: 1,
  };
}

test("the attempt is kept before anything is sent, and reads back exactly", () => {
  const storage = memory();
  const key = agreedDraftKey(scope());
  assert.equal(loadAgreedDraft(key, storage), null);
  assert.equal(saveAgreedDraft(key, draftOf(), storage), true);
  const kept = loadAgreedDraft(key, storage);
  assert.deepEqual(
    kept && {
      attempt: kept.attempt,
      nonce: kept.nonce,
      claimId: kept.claimId,
      artifact: kept.artifact,
      met: kept.met,
      notMet: kept.notMet,
      criteriaWords: kept.criteriaWords,
    },
    {
      attempt: 1,
      nonce: 7,
      claimId: CLAIM,
      artifact: draft.artifact,
      met: draft.met,
      notMet: "",
      criteriaWords: draft.criteriaWords,
    },
  );
});

test("a retry of the same attempt stays the same attempt id, never a second claim", () => {
  const storage = memory();
  const key = agreedDraftKey(scope());
  saveAgreedDraft(key, draftOf(), storage);
  const kept = loadAgreedDraft(key, storage);
  // A second save with the same scope overwrites with the same ids — the
  // nonce and claim id do not move when a send is retried.
  saveAgreedDraft(
    key,
    { ...draftOf(), artifact: "https://example.com/r2" },
    storage,
  );
  const retried = loadAgreedDraft(key, storage);
  assert.equal(retried?.nonce, kept?.nonce);
  assert.equal(retried?.claimId, kept?.claimId);
  assert.equal(retried?.attempt, kept?.attempt);
});

test("one scope never reads another's copy: account, wallet, chain and mandate are in the key", () => {
  const storage = memory();
  assert.equal(
    saveAgreedDraft(agreedDraftKey(scope()), draftOf(), storage),
    true,
  );
  for (const [what, changed] of [
    ["account", { account: `${"cd".repeat(32)}` }],
    ["wallet", { wallet: OTHER_WALLET }],
    ["chain", { chainId: "1" }],
    ["mandate", { mandate: "0x00000000000000000000000000000000000000D2" }],
    ["agreement", { agreementId: `0x${"ab".repeat(32)}` }],
  ]) {
    assert.equal(
      loadAgreedDraft(agreedDraftKey(scope(changed)), storage),
      null,
      `${what} has its own scope, nothing to restore there`,
    );
  }
});

test("the practice list reads only the browser's own scope, and drops malformed copies", () => {
  const storage = memory();
  saveAgreedDraft(agreedDraftKey(scope()), draftOf(), storage);
  saveAgreedDraft(
    agreedDraftKey(scope({ wallet: OTHER_WALLET })),
    draftOf(),
    storage,
  );
  // A copy that is not well formed is never listed as an agreement either.
  storage.setItem(
    `${"buzz.launchpad.agreed-submission:x"}|${"ab".repeat(32)}|${WALLET}|31337|`,
    "not json",
  );
  const listed = listedDrafts(storage, {
    server: scope().server,
    account: scope().account,
    wallet: WALLET,
    chainId: "31337",
  });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].mandate, MANDATE.toLowerCase());
  assert.equal(listed[0].agreementId, AGREEMENT);
});

test("the beneficiary's plan sends only what is missing, on the same attempt id", () => {
  const base = {
    claims: CLAIMS,
    mandate: MANDATE,
    agreementId: AGREEMENT,
    claimId: CLAIM,
    evidenceHash: EVIDENCE,
    criteriaHash: CRITERIA,
  };
  const fresh = planBeneficiaryCalls({ ...base, record: null, bound: false });
  assert.equal(fresh.problem, null);
  // Nothing is on the chain yet: submit the claim, state the agreed check,
  // then bind the attempt to the agreement — one ordered batch.
  assert.equal(fresh.calls.length, 3);
  assert.equal(fresh.calls[0].to.toLowerCase(), CLAIMS.toLowerCase());
  assert.ok(
    fresh.calls[0].data.startsWith(AGREE_SELECTORS.submitClaim),
    "submitClaim goes into the escrow first",
  );
  assert.ok(
    fresh.calls[1].data.startsWith(AGREE_SELECTORS.setCheck),
    "then the agreed check",
  );
  assert.ok(
    fresh.calls[2].data.startsWith(AGREE_SELECTORS.bindSubmission),
    "and the agreement's own binding last",
  );
  assert.equal(fresh.calls[2].to.toLowerCase(), MANDATE.toLowerCase());

  // The claim landed but nothing else: only the check and the bind are sent
  // again, under the same claim id — no second submission.
  const partial = planBeneficiaryCalls({
    ...base,
    record: {
      contributor: WALLET,
      evidenceHash: EVIDENCE,
      checkHash: `0x${"0".repeat(64)}`,
    },
    bound: false,
  });
  assert.equal(partial.calls.length, 2);
  assert.equal(partial.calls[0].to.toLowerCase(), CLAIMS.toLowerCase());
  assert.ok(partial.calls[0].data.startsWith(AGREE_SELECTORS.setCheck));
  assert.ok(partial.calls[1].data.startsWith(AGREE_SELECTORS.bindSubmission));

  // The claim and its check landed, but the bind did not: only the bind.
  const unbound = planBeneficiaryCalls({
    ...base,
    record: {
      contributor: WALLET,
      evidenceHash: EVIDENCE,
      checkHash: CRITERIA,
    },
    bound: false,
  });
  assert.equal(unbound.calls.length, 1);
  assert.ok(unbound.calls[0].data.startsWith(AGREE_SELECTORS.bindSubmission));

  // Everything landed: nothing at all, never a second claim or a second bind.
  const done = planBeneficiaryCalls({
    ...base,
    record: {
      contributor: WALLET,
      evidenceHash: EVIDENCE,
      checkHash: CRITERIA,
    },
    bound: true,
  });
  assert.deepEqual(done.calls, []);

  // A different text under the same attempt is a conflict, said before the wallet.
  const clash = planBeneficiaryCalls({
    ...base,
    record: {
      contributor: WALLET,
      evidenceHash: `0x${"ff".repeat(32)}`,
      checkHash: CRITERIA,
    },
    bound: false,
  });
  assert.notEqual(clash.problem, null);
  assert.equal(clash.calls.length, 0);
});

test("the manager's bind is skipped once the record names the attempt", () => {
  const bind = planManagerBind({
    mandate: MANDATE,
    agreementId: AGREEMENT,
    claimId: CLAIM,
    boundTo: null,
  });
  assert.notEqual(bind.call, null);
  assert.equal(bind.call.to.toLowerCase(), MANDATE.toLowerCase());
  assert.equal(
    bind.call.data.toLowerCase(),
    encodeBindSubmission(AGREEMENT, CLAIM).toLowerCase(),
    "the bind step is the mandate's own call bytes",
  );
  const done = planManagerBind({
    mandate: MANDATE,
    agreementId: AGREEMENT,
    claimId: CLAIM,
    boundTo: CLAIM,
  });
  assert.equal(done.call, null);
});

test("forgetting is separate from failing: a pending publish keeps the copy", () => {
  const storage = memory();
  const key = agreedDraftKey(scope());
  saveAgreedDraft(key, { ...draftOf(), pendingPublish: true }, storage);
  assert.notEqual(loadAgreedDraft(key, storage)?.pendingPublish, undefined);
  clearAgreedDraft(key, storage);
  assert.equal(loadAgreedDraft(key, storage), null);
});

test("a copy whose publish failed stays findable by its own agreement scope", () => {
  const storage = memory();
  saveAgreedDraft(
    agreedDraftKey(scope()),
    { ...draftOf(), pendingPublish: true },
    storage,
  );
  const found = pendingPublishDraft(scope(), storage);
  assert.equal(found?.claimId, CLAIM);
  assert.equal(found?.artifact, draft.artifact);
  // Another wallet's scope finds nothing: the retry never fills in another's form.
  assert.equal(
    pendingPublishDraft(scope({ wallet: OTHER_WALLET }), storage),
    null,
  );
  // A copy that is not pending is not a retry.
  saveAgreedDraft(agreedDraftKey(scope()), draftOf(), storage);
  assert.equal(pendingPublishDraft(scope(), storage), null);
});
