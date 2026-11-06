import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  AGE_CONFIRMATION,
  MINIMUM_AGE,
  TERMS_NOT_LOADED,
} from "./account-copy.ts";

describe("the sign-up note for terms that could not be loaded", () => {
  it("says that no terms were agreed to", () => {
    assert.match(TERMS_NOT_LOADED, /could not be loaded/);
    assert.match(TERMS_NOT_LOADED, /not agreeing to any terms/);
  });

  it("says what happens next: asked when the server answers, no posting until then", () => {
    assert.match(TERMS_NOT_LOADED, /asked to agree/);
    assert.match(TERMS_NOT_LOADED, /cannot post or act/);
  });
});

describe("the age box", () => {
  it("says 18 in the words the tests and the terms use", () => {
    assert.equal(MINIMUM_AGE, 18);
    assert.equal(AGE_CONFIRMATION, "I am 18 years of age or older.");
  });

  it("is worded from one place: no screen writes the number itself", () => {
    for (const file of [
      "../ui/PolicyBoxes.tsx",
      "../../invite/ui/InviteJoinPolicyNotice.tsx",
    ]) {
      const source = readFileSync(
        fileURLToPath(new URL(file, import.meta.url)),
        "utf8",
      );
      assert.match(
        source,
        /AGE_CONFIRMATION/,
        `${file} should use AGE_CONFIRMATION`,
      );
      assert.doesNotMatch(
        source,
        /\b18\b/,
        `${file} should not write the age itself`,
      );
    }
  });
});
