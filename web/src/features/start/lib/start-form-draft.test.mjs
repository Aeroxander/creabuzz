import assert from "node:assert/strict";
import test from "node:test";

import {
  clearFormDraft,
  formDraftKey,
  keptFormFor,
  loadFormDraft,
  saveFormDraft,
} from "./start-form-draft.ts";

const BLANK = {
  name: "",
  pitch: "",
  symbol: "",
  founderShares: "100000",
  budgetShares: "300000",
  projectCap: "25000",
  reviewers: "",
  quorum: "",
  reviewerTies: "",
  projects: [{ name: "", check: "", shares: "25000" }],
};
const typed = {
  ...BLANK,
  name: "Docs Commons",
  reviewers: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
  reviewerTies: "Ann worked with me at Acme.",
  projects: [{ name: "docs", check: "docs merged", shares: "25000" }],
  remixInvited: true,
};

function memory() {
  const map = new Map();
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

test("the form is kept per server, account and board project", () => {
  const key = formDraftKey({ server: "wss://one.example", account: "AB" });
  assert.equal(
    key,
    formDraftKey({ server: "wss://one.example", account: "ab", fromBoard: "" }),
  );
  for (const other of [
    { server: "wss://two.example", account: "ab" },
    { server: "wss://one.example", account: "cd" },
    { server: "wss://one.example", account: "ab", fromBoard: "garden" },
  ])
    assert.notEqual(formDraftKey(other), key, JSON.stringify(other));
});

test("what was typed comes back after a reload; an untouched form is not kept", () => {
  const storage = memory();
  const key = formDraftKey({ server: "wss://one.example", account: "ab" });
  assert.equal(saveFormDraft(key, typed, BLANK, storage), true);
  assert.deepEqual(loadFormDraft(key, storage), typed);
  // Back to how it started: nothing to bring back.
  assert.equal(saveFormDraft(key, BLANK, BLANK, storage), true);
  assert.equal(loadFormDraft(key, storage), null);
  saveFormDraft(key, typed, BLANK, storage);
  clearFormDraft(key, storage);
  assert.equal(loadFormDraft(key, storage), null);
});

test("storage that refuses says so; a malformed copy is not filled in", () => {
  const throwing = {
    setItem: () => {
      throw new Error("blocked");
    },
    removeItem: () => {},
  };
  assert.equal(saveFormDraft("k", typed, BLANK, throwing), false);
  assert.equal(saveFormDraft("k", typed, BLANK, null), false);
  const storage = memory();
  for (const bad of [
    "{nope",
    JSON.stringify({ ...typed, reviewers: 3 }),
    JSON.stringify({ ...typed, projects: [] }),
    JSON.stringify({ ...typed, projects: [{ name: "docs" }] }),
    JSON.stringify({ ...typed, remixInvited: "yes" }),
  ]) {
    storage.setItem("k", bad);
    assert.equal(loadFormDraft("k", storage), null, bad);
  }
});

test("signing in on the page brings that account's form back, never over typing", () => {
  const storage = memory();
  const key = formDraftKey({ server: "wss://one.example", account: "ab" });
  saveFormDraft(key, typed, BLANK, storage);
  assert.deepEqual(keptFormFor(key, BLANK, BLANK, storage), typed);
  // Something typed before signing in is not replaced by the older copy.
  assert.equal(
    keptFormFor(key, { ...BLANK, name: "Fresh" }, BLANK, storage),
    null,
  );
  assert.equal(
    keptFormFor(
      formDraftKey({ server: "wss://one.example", account: "cd" }),
      BLANK,
      BLANK,
      storage,
    ),
    null,
  );
});
