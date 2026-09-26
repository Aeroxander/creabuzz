import assert from "node:assert/strict";
import test from "node:test";

import { PASSKEY_MODE_COPY, passkeyModeCopy } from "./mode-copy.ts";

/**
 * Mode honesty: the panel and the unlock gate must say which of the two
 * credential modes is active and what it means for the key. The strings are
 * pinned because they are user-facing promises, not implementation notes.
 */

test("PRF mode says the key is re-derived at each signature", () => {
  assert.equal(
    passkeyModeCopy("prf"),
    "Your Nostr key is re-derived from Touch ID at each signature (PRF)",
  );
});

test("unlock mode says the key lives in this tab only", () => {
  assert.equal(
    passkeyModeCopy("unlock"),
    "Session unlock — your key stays in this tab's memory until you close it",
  );
});

test("no passkey means no mode line", () => {
  assert.equal(passkeyModeCopy(null), null);
});

test("both modes have copy — adding a mode without words fails here", () => {
  assert.deepEqual(Object.keys(PASSKEY_MODE_COPY).sort(), ["prf", "unlock"]);
  for (const copy of Object.values(PASSKEY_MODE_COPY)) {
    assert.ok(copy.length > 10);
  }
});
