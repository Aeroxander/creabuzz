import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * The ban form must not promise what does not happen, and must not ban for good by default.
 *
 * - The banned person is signed out and never shown the reason (the server keeps it for moderators, in the banned
 *   list). The form used to say "They are told the reason you give" and label the box "they will see it".
 * - The length used to start on "For good", so a moderator who only typed a reason banned someone forever. Now no
 *   length is chosen until the moderator picks one, and the ban button waits for it.
 *
 * These read production source (the `editSurfaceContract.test.mjs` pattern); the mocked browser specs in
 * `tests/e2e/community-access.spec.ts` drive the form itself.
 */

const ROOT = new URL("../../../../", import.meta.url);
const source = readFileSync(
  fileURLToPath(new URL("src/features/communities/ui/BanPanel.tsx", ROOT)),
  "utf8",
);
const form = source.slice(
  source.indexOf("export function BanForm"),
  source.indexOf("function BannedRow"),
);

test("the ban form does not say the banned person sees the reason", () => {
  assert.doesNotMatch(form, /told the reason/);
  assert.doesNotMatch(form, /they will see/i);
  assert.match(form, /Only moderators see\s+the reason/);
});

test("no ban length is chosen until the moderator picks one", () => {
  assert.match(form, /useState<number \| null>\(null\)/);
  assert.match(form, /<option disabled value="">/);
  assert.match(form, /disabled=\{busy \|\| length === null\}/);
});
