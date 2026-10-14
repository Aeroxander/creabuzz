import assert from "node:assert/strict";
import { test } from "node:test";
import { initialAdmission, initialTokenMode } from "./wizard.ts";

test("a new launch starts on the project's own Shares where a kit exists, and on a minted token where none does", () => {
  assert.equal(initialTokenMode(undefined, true), "dao");
  assert.equal(initialTokenMode(null, false), "mint");
  assert.equal(initialTokenMode({}, true), "dao");
});

test("a launch that already has a token keeps what it is when edited", () => {
  // An imported token stays an import, even where a kit exists.
  assert.equal(initialTokenMode({ token: "0xabc" }, true), "import");
  // A launch made as a DAO has the DAO's Shares as its token and must not turn into an import.
  assert.equal(
    initialTokenMode({ token: "0xabc", tokenPlan: { mode: "dao" } }, false),
    "dao",
  );
  assert.equal(initialTokenMode({ tokenPlan: { mode: "mint" } }, true), "dao");
});

test("a new launch that will be a DAO starts on the open sale, because a DAO launch cannot be curated", () => {
  assert.equal(initialAdmission(undefined, true), "community");
  assert.equal(initialAdmission(null, true), "community");
  // A project that mints its own token may still be curated, and that stays the default there.
  assert.equal(initialAdmission(undefined, false), "curated");
});

test("an existing launch keeps the track it was published with", () => {
  assert.equal(initialAdmission({ admission: "curated" }, true), "curated");
  assert.equal(
    initialAdmission({ admission: "community" }, false),
    "community",
  );
});
