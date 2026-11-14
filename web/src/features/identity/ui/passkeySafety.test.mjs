/**
 * Account safety around passkey sign-in (suite review 2026-11-01, quick wins 2 and 3).
 *
 * 2. "Remove passkey sign-in" used to delete a passkey-only account in one click: for a PRF account the passkey is the
 *    only source of the key, so without a saved recovery key the account was gone for good. It must confirm first, and
 *    when the account would be lost, make saving the recovery key the main button.
 * 3. The unlock overlay's auto-prompt effect depended on `unlock`, a new closure every render, so it started ceremony
 *    after ceremony and had no way out. It must prompt once, and offer Sign out and the recovery key instead.
 *
 * The decision (would removing lose the account?) is driven through the production `passkey-identity` module; the
 * wiring is source-bound because JSX cannot render under `node --test` (the pattern of
 * `./ProfileMenu.recoveryExport.test.mjs`).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { removingPasskeyLosesAccount } from "../lib/passkey-identity.ts";

const menu = readFileSync(
  new URL("./ProfileMenu.tsx", import.meta.url),
  "utf8",
);
const gate = readFileSync(
  new URL("./PasskeyUnlockGate.tsx", import.meta.url),
  "utf8",
);
const flat = (s) => s.replace(/\s+/g, " ");

test("removing a PRF passkey without a saved key loses the account; nothing else does", () => {
  assert.equal(removingPasskeyLosesAccount("prf", false), true);
  assert.equal(removingPasskeyLosesAccount("prf", true), false);
  // Unlock mode keeps the key on this browser: removing only stops the passkey prompt.
  assert.equal(removingPasskeyLosesAccount("unlock", false), false);
  assert.equal(removingPasskeyLosesAccount(null, false), false);
});

test("the Remove passkey sign-in item only opens a confirm", () => {
  const item = flat(
    menu.match(/label="Remove passkey sign-in"[\s\S]*?\/>/)?.[0] ?? "",
  );
  assert.ok(item, "the menu item must exist");
  assert.match(item, /setConfirmRemovePasskey\(true\)/);
  assert.doesNotMatch(item, /removePasskeyIdentity\(/);
});

test("the remove confirm warns, and makes saving the key the main button when the account would be lost", () => {
  const dialog = flat(
    menu.match(/data-testid="remove-passkey-dialog"[\s\S]*?<\/Overlay>/)?.[0] ??
      "",
  );
  assert.ok(dialog, "the remove confirm must render");
  assert.match(
    dialog,
    /You haven't saved your recovery key\. Without it this account is gone for good\./,
  );
  assert.match(dialog, /removingPasskeyLosesAccount\(/);
  assert.match(dialog, /data-testid="remove-passkey-save-key"/);
  assert.match(dialog, /Save recovery key/);
  assert.match(dialog, /Remove anyway/);
  // Only the confirm button removes the passkey.
  assert.match(
    dialog,
    /data-testid="remove-passkey-confirm"[\s\S]*removePasskeyIdentity\(\)/,
  );
});

test("the unlock overlay auto-prompts once, not on every render", () => {
  assert.match(gate, /useRef/);
  const effect = flat(
    gate.match(/useEffect\(\(\) => \{[\s\S]*?\}, \[[^\]]*\]\);/)?.[0] ?? "",
  );
  assert.ok(effect, "the auto-prompt effect must exist");
  assert.match(effect, /autoPrompted\.current/);
  // A dependency on the per-render `unlock` closure is what re-fired it.
  assert.doesNotMatch(effect, /\[[^\]]*\bunlock\b[^\]]*\]\);$/);
});

test("the unlock overlay has a way out: Sign out and the recovery key", () => {
  assert.match(gate, /data-testid="passkey-unlock-signout"/);
  assert.match(gate, /Sign in with my recovery key instead/);
  assert.match(gate, /unlockWithRecoveryKey\(/);
  assert.match(gate, /parseRecoveryKey\(/);
});
