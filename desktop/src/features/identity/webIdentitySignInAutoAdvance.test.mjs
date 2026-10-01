import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * A completed browser sign-in must ADVANCE onboarding, not park the user on a
 * confirmation. The button took no props, so linking left onboarding stuck on
 * the profile step with nothing but a Close button.
 *
 * JSX cannot render here, so the wiring is the seam.
 */
const ROOT = new URL("../../../", import.meta.url);
const read = (p) => readFileSync(fileURLToPath(new URL(p, ROOT)), "utf8");

const button = read("src/features/identity/WebIdentitySignInButton.tsx");
const profileStep = read("src/features/onboarding/ui/ProfileStep.tsx");

test("the button accepts an onLinked callback", () => {
  assert.match(button, /onLinked\?: \(\) => void/);
});

test("it fires onLinked once when the phase reaches linked", () => {
  assert.match(button, /state\.phase !== "linked"/);
  assert.match(button, /advancedRef\.current = true/);
  assert.match(
    button,
    /advancedRef/,
    "the one-shot guard must be a ref (StrictMode-safe)",
  );
});

test("the identity step advances when the link completes", () => {
  assert.match(
    profileStep,
    /<WebIdentitySignInButton onLinked=\{advanceWithoutSaving\} \/>/,
    "ProfileStep must advance past identity once the key lands",
  );
});

test("surfaces with no next step confirm in place", () => {
  // Settings keeps the card; only onboarding passes a callback.
  const card = read("src/features/identity/WebIdentityHandoffCard.tsx");
  assert.doesNotMatch(card, /onLinked=\{/);
});
