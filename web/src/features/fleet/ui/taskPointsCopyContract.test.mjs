import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * Points on a community task are a thank-you on a profile, nothing more: accepting one mints no Shares and sends no
 * money. The note under the reward box used to say points "add to the contributor's share of the project", which
 * Portfolio contradicts (Shares come only from the project's own work). This reads production source (the
 * `editSurfaceContract.test.mjs` pattern).
 */

const ROOT = new URL("../../../../", import.meta.url);
const source = readFileSync(
  fileURLToPath(new URL("src/features/fleet/ui/TaskPlanningPanel.tsx", ROOT)),
  "utf8",
).replace(/\s+/g, " ");

test("the points note does not say points add to anyone's Shares", () => {
  assert.doesNotMatch(source, /add to the contributor's share/);
  assert.match(source, /They are not Shares and are not money\./);
  assert.match(
    source,
    /To earn Shares, take the work on the project's Work tab\./,
  );
});
