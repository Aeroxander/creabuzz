import assert from "node:assert/strict";
import test from "node:test";

import { deriveSignRecovery } from "./sign-recovery.ts";

/**
 * The recovery table a signing-gated surface renders from.
 *
 * Every row that ends in `null` without an action is a Rule-6 dead end if the
 * surface can still demand a signature — the table is the guard.
 */

test("an unlocked identity needs no recovery", () => {
  assert.equal(
    deriveSignRecovery({
      registered: true,
      active: true,
      blockedReason: null,
    }),
    null,
  );
});

test("a registered-but-locked passkey offers Sign in with passkey beside the refusal", () => {
  const recovery = deriveSignRecovery({
    registered: true,
    active: false,
    blockedReason: "Unlock your passkey before this browser can sign.",
  });
  assert.ok(recovery, "a locked passkey must never be a dead end");
  assert.equal(recovery.action, "signin");
  assert.equal(recovery.cta, "Sign in with passkey");
  assert.equal(
    recovery.headline,
    "Unlock your passkey before this browser can sign.",
  );
});

test("blocked with no registered passkey offers Create a passkey", () => {
  const recovery = deriveSignRecovery({
    registered: false,
    active: false,
    blockedReason: "Unlock your passkey before this browser can sign.",
  });
  assert.ok(
    recovery,
    "a block with nothing to unlock must still be actionable",
  );
  assert.equal(recovery.action, "create");
  assert.equal(recovery.cta, "Create a passkey");
});

test("an ordinary browser key signs without ceremony — no prompt noise", () => {
  assert.equal(
    deriveSignRecovery({
      registered: false,
      active: false,
      blockedReason: null,
    }),
    null,
  );
});

test("the sign-in headline falls back when the reason was cleared", () => {
  const recovery = deriveSignRecovery({
    registered: true,
    active: false,
    blockedReason: null,
  });
  assert.equal(recovery.action, "signin");
  assert.match(recovery.headline, /passkey/i);
  assert.ok(recovery.helper.length > 0, "each action explains what it will do");
});
