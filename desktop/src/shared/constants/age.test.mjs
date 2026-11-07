import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  AGE_CONFIRMATION,
  AGE_CONFIRMATION_NEEDED,
  MINIMUM_AGE,
} from "./age.ts";

describe("the age box", () => {
  it("says 18 in the words the end-to-end tests look for", () => {
    assert.equal(MINIMUM_AGE, 18);
    assert.equal(AGE_CONFIRMATION, "I am 18 years of age or older.");
  });

  it("tells a person who skipped it what to do", () => {
    assert.equal(
      AGE_CONFIRMATION_NEEDED,
      "Confirm that you are at least 18 years old.",
    );
  });

  it("is worded from one place: no screen writes the number itself", () => {
    for (const file of [
      "../../features/onboarding/ui/JoinPolicyNotice.tsx",
      "../../features/onboarding/ui/InviteRedeemForm.tsx",
      "../../features/communities/ui/CommunityEditForm.tsx",
    ]) {
      const source = readFileSync(
        fileURLToPath(new URL(file, import.meta.url)),
        "utf8",
      );
      assert.match(source, /AGE_CONFIRMATION/, `${file} should use age.ts`);
      assert.doesNotMatch(source, /\b18\b/, `${file} should not write the age`);
    }
  });
});
