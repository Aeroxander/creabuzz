import assert from "node:assert/strict";
import { test } from "node:test";
import { initialAdmission, initialTokenMode } from "./wizard.ts";

test("a new launch is always the project's own Shares, so a network with no launch kit never turns it into a minted token", () => {
  for (const hasKit of [true, false]) {
    assert.equal(initialTokenMode(undefined, hasKit), "dao");
    assert.equal(initialTokenMode(null, hasKit), "dao");
    assert.equal(initialTokenMode({}, hasKit), "dao");
  }
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
  // An edit never rewrites what was published: a minted-token launch stays one where no kit exists.
  assert.equal(
    initialTokenMode({ tokenPlan: { mode: "mint" } }, false),
    "mint",
  );
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
