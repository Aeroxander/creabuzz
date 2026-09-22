import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const manifest = JSON.parse(
  readFileSync(
    new URL("../../../../preview-features.json", import.meta.url),
    "utf8",
  ),
);

test("thread-scoped ACP sessions is a default-off desktop experiment", () => {
  const feature = manifest.features.find(
    ({ id }) => id === "threadScopedAcpSessions",
  );

  assert.deepEqual(feature, {
    id: "threadScopedAcpSessions",
    name: "Thread Scoped ACP Sessions",
    description:
      "Give each channel thread isolated agent context. Applies when managed agents next start; DMs stay conversation-scoped.",
    platforms: ["desktop"],
  });
  assert.equal(feature.defaultEnabled, undefined);
});

test("shipped surfaces are default-on; experiments stay default-off", () => {
  const byId = Object.fromEntries(
    manifest.features.map((feature) => [feature.id, feature]),
  );

  // Mature surfaces ship enabled (VISION.md advertises them; the desktop
  // readiness audit flagged that a fresh install hid them behind
  // Settings -> Experiments).
  for (const id of ["workflows", "projects", "forum"]) {
    assert.equal(byId[id].defaultEnabled, true, `${id} must default on`);
  }
  // Experimental surfaces stay opt-in.
  for (const id of [
    "launchpad",
    "pulse",
    "threadScopedAcpSessions",
    "agentManagedProfiles",
  ]) {
    assert.equal(byId[id].defaultEnabled, undefined, `${id} must default off`);
  }
});
