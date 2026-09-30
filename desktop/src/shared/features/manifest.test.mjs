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
    "pulse",
    "threadScopedAcpSessions",
    "agentManagedProfiles",
  ]) {
    assert.equal(byId[id].defaultEnabled, undefined, `${id} must default off`);
  }
});

test("Launchpad and the retired Paperclip surface are not gated features", () => {
  // Launchpad ships enabled by default with no experiment toggle, and the
  // Paperclip surface is gone entirely; neither may linger in the manifest.
  const ids = new Set(manifest.features.map(({ id }) => id));
  assert.equal(ids.has("launchpad"), false);
  assert.equal(ids.has("paperclip"), false);
});

test("the Org and Wiki entries are not behind a preview flag", () => {
  // Shipped surfaces must not be gated just because they replaced an older
  // surface.
  const ids = new Set(manifest.features.map(({ id }) => id));
  assert.equal(ids.has("org"), false);
  assert.equal(ids.has("wiki"), false);
});

test("the sidebar renders Launchpad ungated and no longer renders Paperclip", () => {
  const source = readFileSync(
    new URL(
      "../../features/sidebar/ui/AppSidebarPinnedHeader.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(source, /open-launchpad-view/);
  assert.equal(
    source.includes('FeatureGate feature="launchpad"'),
    false,
    "launchpad must render unconditionally",
  );
  assert.equal(source.includes("open-paperclip-view"), false);
  assert.equal(source.includes('feature="paperclip"'), false);
  for (const testId of ["open-org-view", "open-wiki-view"]) {
    assert.ok(source.includes(testId), `${testId} must still be rendered`);
  }
});
