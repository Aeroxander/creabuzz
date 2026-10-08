import assert from "node:assert/strict";
import { test } from "node:test";
import { initialTokenMode } from "./wizard.ts";

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
