import assert from "node:assert/strict";
import test from "node:test";

import { hashText, idWord } from "@creaton/core/launchpad/work.ts";
import {
  claimDraftKey,
  clearClaimDraft,
  draftForClaim,
  fileWithDraft,
  loadClaimDraft,
  MAX_CLAIM_DRAFTS,
  saveClaimDraft,
} from "./claim-draft.ts";

const ZERO = `0x${"0".repeat(64)}`;
const WALLET = "0x00000000000000000000000000000000000000A1";
const draft = {
  name: "First guide",
  evidence: "https://example.com/guide\n\nHow I checked it: read it aloud",
  check: "a two-page guide",
};
const scope = (over = {}) => ({
  server: "wss://one.example",
  account: "ab".repeat(32),
  wallet: WALLET,
  claimId: idWord(draft.name),
  evidenceHash: hashText(draft.evidence),
  ...over,
});

/** A browser storage in memory, with the parts `Storage` has. */
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

test("a kept copy belongs to one server, account, wallet and claim", () => {
  const base = claimDraftKey(scope());
  // The form keys it by the connected wallet and the text's fingerprint; the claim row by the chain's record of both.
  assert.equal(
    base,
    claimDraftKey(
      scope({
        wallet: WALLET.toLowerCase(),
        evidenceHash: hashText(draft.evidence)
          .toUpperCase()
          .replace("0X", "0x"),
      }),
    ),
  );
  for (const over of [
    { server: "wss://two.example" },
    { account: "cd".repeat(32) },
    { wallet: "0x00000000000000000000000000000000000000b2" },
    { claimId: idWord("Second guide") },
    { evidenceHash: hashText("other text") },
  ])
    assert.notEqual(claimDraftKey(scope(over)), base, JSON.stringify(over));
});

test("a copy counts as kept only when it reads back the same", () => {
  const storage = memory();
  const key = claimDraftKey(scope());
  assert.equal(saveClaimDraft(key, draft, storage), true);
  assert.deepEqual(loadClaimDraft(key, storage), draft);
  // A browser that drops the write without saying so.
  assert.equal(
    saveClaimDraft(key, draft, {
      setItem: () => {},
      getItem: () => null,
      removeItem: () => {},
    }),
    false,
  );
  // One that throws (full, or site data blocked), and none at all.
  assert.equal(
    saveClaimDraft(key, draft, {
      setItem: () => {
        throw new Error("full");
      },
      getItem: () => null,
      removeItem: () => {},
    }),
    false,
  );
  assert.equal(saveClaimDraft(key, draft, null), false);
  clearClaimDraft(key, storage);
  assert.equal(loadClaimDraft(key, storage), null);
});

test("a malformed copy is not offered", () => {
  const storage = memory();
  storage.setItem("k", "{not json");
  assert.equal(loadClaimDraft("k", storage), null);
  storage.setItem("k", JSON.stringify({ name: "x", evidence: " ", check: "" }));
  assert.equal(loadClaimDraft("k", storage), null);
  storage.setItem("k", JSON.stringify({ name: "x", evidence: "e" }));
  assert.equal(loadClaimDraft("k", storage), null);
});

test("a copy fills in only the claim whose fingerprints it matches", () => {
  const claim = (evidenceHash, checkHash) => ({
    record: { evidenceHash, checkHash },
  });
  const E = hashText(draft.evidence).toUpperCase().replace("0X", "0x");
  assert.equal(draftForClaim(draft, claim(E, ZERO)), draft);
  assert.equal(draftForClaim(draft, claim(E, hashText(draft.check))), draft);
  assert.equal(draftForClaim(draft, claim(E, hashText("other words"))), null);
  assert.equal(draftForClaim(draft, claim(hashText("other"), ZERO)), null);
  assert.equal(draftForClaim(null, claim(E, ZERO)), null);
});

test("copies whose claims were never sent are bounded, oldest dropped first, the newest always kept", () => {
  const storage = memory();
  storage.setItem("someone.else", "untouched");
  for (let index = 0; index < MAX_CLAIM_DRAFTS + 5; index += 1) {
    const key = claimDraftKey(scope({ claimId: idWord(`claim ${index}`) }));
    assert.equal(saveClaimDraft(key, draft, storage, 1_000 + index), true);
  }
  const kept = [...storage.map.keys()].filter((key) =>
    key.startsWith("buzz.launchpad.claim-draft:"),
  );
  assert.equal(kept.length, MAX_CLAIM_DRAFTS);
  assert.ok(
    kept.includes(
      claimDraftKey(
        scope({ claimId: idWord(`claim ${MAX_CLAIM_DRAFTS + 4}`) }),
      ),
    ),
  );
  assert.ok(
    !kept.includes(claimDraftKey(scope({ claimId: idWord("claim 0") }))),
  );
  assert.equal(storage.getItem("someone.else"), "untouched");
});

/** Records the order the steps ran in. */
function steps(over = {}) {
  const ran = [];
  return {
    ran,
    input: {
      commits: true,
      keep: () => {
        ran.push("keep");
        return over.kept ?? true;
      },
      send: async () => {
        ran.push("send");
        return over.landed ?? true;
      },
      publish: async () => {
        ran.push("publish");
        if (over.publishFails) throw new Error("server said no");
      },
      forget: () => ran.push("forget"),
    },
  };
}

test("the copy is kept before the wallet is asked, and forgotten only after the evidence is published", async () => {
  const ok = steps();
  assert.equal(await fileWithDraft(ok.input), "done");
  assert.deepEqual(ok.ran, ["keep", "send", "publish", "forget"]);

  // Not kept: nothing goes to the chain, so no fingerprint without its text.
  const unkept = steps({ kept: false });
  assert.equal(await fileWithDraft(unkept.input), "not-kept");
  assert.deepEqual(unkept.ran, ["keep"]);

  // Publishing failed: the copy stays for the next press, or for after a reload.
  const unpublished = steps({ publishFails: true });
  assert.equal(await fileWithDraft(unpublished.input), "not-published");
  assert.deepEqual(unpublished.ran, ["keep", "send", "publish"]);

  // The wallet step did not land: nothing published, the copy stays.
  const unsent = steps({ landed: false });
  assert.equal(await fileWithDraft(unsent.input), "not-sent");
  assert.deepEqual(unsent.ran, ["keep", "send"]);
});

test("finishing a claim already on the chain still publishes when no copy can be kept", async () => {
  const finishing = steps({ kept: false });
  assert.equal(
    await fileWithDraft({ ...finishing.input, commits: false }),
    "done",
  );
  assert.deepEqual(finishing.ran, ["keep", "send", "publish", "forget"]);
});
