import assert from "node:assert/strict";
import { test } from "node:test";

import { modeCopy, readingCopy, statusWord } from "./org-diag-copy.ts";

test("every health check mode has a plain name and meaning", () => {
  for (const mode of [
    "orchestration-drift",
    "semantic-misalignment",
    "security-trust-gaps",
    "cascading-effects",
    "systemic-complexity",
  ]) {
    const copy = modeCopy(mode);
    assert.notEqual(copy.label, mode);
    assert.ok(copy.meaning.length > 0);
  }
});

test("status words are plain and unknown ones pass through", () => {
  assert.equal(statusWord("calm"), "no concern");
  assert.equal(statusWord("saturated"), "overloaded");
  assert.equal(statusWord("new-status"), "new-status");
});

test("reading sentences are mapped, unknown ones kept", () => {
  assert.match(
    readingCopy("coordination-consistent timing: bursty stream"),
    /not proof/,
  );
  assert.match(readingCopy("settled: most items"), /left alone/);
  assert.equal(readingCopy("something new"), "something new");
});
