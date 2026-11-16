import assert from "node:assert/strict";
import test from "node:test";

import {
  applyServerSettings,
  loadServerSettings,
  parseServerSettings,
  serverInvesting,
} from "./server-settings.ts";

test("the server's yes and no are read, and nothing else counts", () => {
  assert.deepEqual(parseServerSettings({ investing: true }), {
    investing: true,
  });
  assert.deepEqual(parseServerSettings({ investing: false }), {
    investing: false,
  });
  for (const says of [
    {},
    { investing: null },
    { investing: "true" },
    { investing: 1 },
    { investing: [] },
    { name: "Mock server" },
    null,
    undefined,
    "investing",
    [],
    7,
  ]) {
    assert.deepEqual(
      parseServerSettings(says),
      { investing: null },
      JSON.stringify(says),
    );
  }
});

test("what the server said is kept, and a later document replaces it", () => {
  applyServerSettings({ investing: true });
  assert.equal(serverInvesting(), true);
  applyServerSettings({ investing: false });
  assert.equal(serverInvesting(), false);
  applyServerSettings({});
  assert.equal(serverInvesting(), null);
});

test("a server that cannot be read leaves nothing said, and never throws", async () => {
  applyServerSettings({ investing: true });
  await loadServerSettings(async () => {
    throw new Error("the server did not answer");
  });
  assert.equal(serverInvesting(), null);
  await loadServerSettings(async () => ({ investing: false }));
  assert.equal(serverInvesting(), false);
  await loadServerSettings(async () => null);
  assert.equal(serverInvesting(), null);
});
