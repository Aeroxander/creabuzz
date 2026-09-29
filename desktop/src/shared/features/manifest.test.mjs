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

test("the deprecated Paperclip on-ramp is a default-off desktop preview feature", () => {
  const feature = manifest.features.find(({ id }) => id === "paperclip");

  assert.ok(feature, "paperclip must be in the manifest");
  assert.deepEqual(feature.platforms, ["desktop"]);
  assert.equal(feature.defaultEnabled, undefined, "paperclip must default off");
  assert.match(feature.name, /deprecated/i);
});

test("the Org and Wiki entries are not behind a preview flag", () => {
  // Hiding Paperclip must not hide the surfaces that replaced it.
  const ids = new Set(manifest.features.map(({ id }) => id));
  assert.equal(ids.has("org"), false);
  assert.equal(ids.has("wiki"), false);
});

test("the sidebar gates Paperclip behind its flag and keeps Org and Wiki visible", () => {
  const source = readFileSync(
    new URL(
      "../../features/sidebar/ui/AppSidebarPinnedHeader.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  const gated = source.match(
    /<FeatureGate feature="paperclip">([\s\S]*?)<\/FeatureGate>/,
  );
  assert.ok(gated, "the Paperclip entry must sit inside its FeatureGate");
  assert.match(gated[1], /open-paperclip-view/);
  for (const testId of ["open-org-view", "open-wiki-view"]) {
    const at = source.indexOf(testId);
    assert.ok(at > 0, `${testId} must still be rendered`);
    // Not inside the paperclip gate.
    assert.equal(gated[1].includes(testId), false, testId);
  }
});
