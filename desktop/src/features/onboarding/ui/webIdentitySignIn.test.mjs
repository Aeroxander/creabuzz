import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (relativePath) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8");

test("onboarding signs in through the shared handoff, never a duplicate flow", () => {
  const button = read("../../identity/WebIdentitySignInButton.tsx");
  assert.match(button, /useWebIdentityHandoff/);
  assert.match(button, /DEFAULT_WEB_ORIGIN/);
  assert.ok(
    !button.includes("start_identity_link"),
    "the button must reuse the shared seam, not re-invoke the command",
  );
  // Both identity steps offer it: the profile step (main onboarding) and the
  // machine onboarding key introduction.
  assert.match(read("./ProfileStep.tsx"), /WebIdentitySignInButton/);
  assert.match(
    read("./IdentityKeyIntroduction.tsx"),
    /WebIdentitySignInButton/,
  );
});

test("the no-community fallback origin is the documented brand constant", () => {
  const brand = read("../../../shared/constants/brand.ts");
  assert.match(brand, /DEFAULT_WEB_ORIGIN/);
  assert.match(brand, /hosted/);
});

test("copy uses the approved wording", () => {
  const copy = read("../../identity/webIdentityHandoff.ts");
  assert.match(copy, /Sign in with browser/);
  assert.match(copy, /Use your Creaton account from the web/);
});
