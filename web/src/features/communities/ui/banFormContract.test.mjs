import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * The ban form must not promise what does not happen, and must not ban for good by default.
 *
 * - The banned person is signed out and told the reason and when the ban ends (the server's ban refusal carries
 *   both, `handlers/auth.rs` `ban_refusal`), so the form says so. It once said only moderators see the reason, while
 *   the server did not yet pass it on.
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

test("the ban form says the banned person is told the reason and when the ban ends", () => {
  assert.match(form, /told the\s+reason you give and when the ban ends/);
  assert.doesNotMatch(form, /only moderators/i);
  // The server does carry it to them.
  const auth = readFileSync(
    fileURLToPath(new URL("../crates/buzz-relay/src/handlers/auth.rs", ROOT)),
    "utf8",
  );
  assert.match(auth, /"; reason: "/);
});

test("no ban length is chosen until the moderator picks one", () => {
  assert.match(form, /useState<number \| null>\(null\)/);
  assert.match(form, /<option disabled value="">/);
  assert.match(form, /disabled=\{busy \|\| length === null\}/);
});
