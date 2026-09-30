/**
 * The unreadable-key recovery contract for the always-mounted profile chip
 * (`./ProfileMenu.tsx` + `./IdentityRecoveryBanner.tsx`).
 *
 * A stored-but-unreadable key used to throw during ProfileMenu's render; the
 * chip is mounted in the always-mounted nav, so the throw reached the root
 * error page and hid the Import/Reset recovery actions — the app went down
 * exactly when the reader needed a way back. The render boundary must catch
 * `StoredIdentityUnreadableError` and render an inline recovery banner whose
 * actions never require the broken path.
 *
 * JSX cannot render under `node --test`, so the UI half is source-bound (the
 * established pattern — see `./ProfileMenu.recoveryExport.test.mjs`); the
 * storage half is driven for real through the production `shared/lib/identity`
 * module with the fixtures from `shared/lib/identity-storage.test.mjs`.
 *
 * Mutation check: remove the catch from ProfileMenu and the second test below
 * fails.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  identityStorageState,
  importIdentity,
  resetIdentitySecretCache,
  StoredIdentityUnreadableError,
  storedIdentityHex,
} from "../../../shared/lib/identity.ts";

const profileMenu = readFileSync(
  new URL("./ProfileMenu.tsx", import.meta.url),
  "utf8",
);
const banner = readFileSync(
  new URL("./IdentityRecoveryBanner.tsx", import.meta.url),
  "utf8",
);

function makeStorage() {
  const map = new Map();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

/** A stored blob that cannot be decrypted (fixture from the storage tests). */
function withUnreadableIdentity(fn) {
  const storage = makeStorage();
  globalThis.window = { localStorage: storage };
  resetIdentitySecretCache();
  try {
    importIdentity("ab".repeat(32)); // stores the ncryptsec1 blob + wrap key
    resetIdentitySecretCache();
    storage.setItem("buzz.identity.wrap", "ff".repeat(32)); // wrong wrap
    fn(storage);
  } finally {
    resetIdentitySecretCache();
    delete globalThis.window;
  }
}

test("a stored-but-unreadable blob is a hard error, never 'unstored'", () => {
  withUnreadableIdentity(() => {
    assert.throws(() => storedIdentityHex(), StoredIdentityUnreadableError);
    assert.equal(identityStorageState(), "unreadable");
  });
});

test("ProfileMenu catches the unreadable-key error at its render boundary", () => {
  assert.match(
    profileMenu,
    /try \{[^}]*storedIdentityHex\(\)[^}]*\} catch \(error\) \{/,
    "the render-time identity read must sit behind the boundary catch",
  );
  assert.match(
    profileMenu,
    /catch \(error\) \{\s*\n\s*if \(!\(error instanceof StoredIdentityUnreadableError\)\) throw error;\s*\n\s*identityUnreadable = true;/,
  );
  assert.match(
    profileMenu,
    /if \(identityUnreadable\) \{\s*\n\s*return <IdentityRecoveryBanner \/>;/,
    "the banner replaces the chip so the app stays navigable",
  );
});

test("the recovery banner renders inline with the approved wording", () => {
  assert.match(banner, /role="alert"/);
  assert.match(banner, /data-testid="identity-recovery-banner"/);
  assert.ok(
    banner.includes(
      "Your saved key can't be read: import your backup or start over",
    ),
    "the banner keeps the approved wording",
  );
});

test("the banner wires Import and Reset to the existing identity flows", () => {
  assert.match(banner, /importIdentity\(/);
  assert.match(banner, /rotateIdentity\(/);
  assert.match(banner, /data-testid="identity-recovery-import"/);
  assert.match(banner, /data-testid="identity-recovery-reset"/);
  // Recovery never requires the broken path: no action reads the stored blob.
  assert.doesNotMatch(
    banner,
    /storedIdentityHex|getOrCreateIdentity|userPubkey/,
  );
});
