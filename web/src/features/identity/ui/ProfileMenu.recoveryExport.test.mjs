/**
 * Export-copy contract for the web identity panel's "Use on desktop"
 * affordance (`./ProfileMenu.tsx`).
 *
 * The recovery-nsec copy itself predates this flow (onboarding's
 * `PasskeyCeremonyPage` + `exportPasskeyNsec`); what this pins is how it is
 * surfaced in the identity panel: the label the user acts on, the wiring to
 * the real export function (a label with no copy action protects nothing),
 * and the honesty rules — the key is the FULL account, and the passkey itself
 * is never claimed to leave the device (D108 shortened the note).
 *
 * Source-binding by design: the menu renders behind no tested DOM harness
 * here, so the assertions read the production component (same pattern as
 * `shared/lib/datetime` label tests and desktop's `messageTimestampContract`).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("./ProfileMenu.tsx", import.meta.url),
  "utf8",
);

// The note block, whitespace-normalized for stable matching.
const note = (
  source.match(/data-testid="recovery-export-note"[\s\S]*?<\/p>/)?.[0] ?? ""
).replace(/\s+/g, " ");

test("the identity panel surfaces the recovery-key export affordance", () => {
  assert.match(source, /label="Copy recovery key"/);
  // Wiring: every export comes from the one account-checked source (D111), never a raw stored or passkey key.
  assert.match(source, /copyRecoveryKey\(recovery\.hex, pubkey\)/);
  assert.match(source, /const recovery = currentRecovery\(pubkey\)/);
  assert.doesNotMatch(source, /exportPasskeyNsec|copyNsec\(/);
});

test("the note says what the key is for", () => {
  assert.ok(note, "recovery-export-note must render");
  assert.match(note, /signs you in on another device/);
});

test("the note is honest about the key being the full account", () => {
  assert.match(note, /Anyone who has it can act as you/);
  assert.match(note, /keep it private/);
});

test("the note never claims the passkey itself was exported", () => {
  assert.match(note, /passkey itself stays on this device/);
  assert.doesNotMatch(
    note,
    /passkey (was |is )?(copied|exported|moved)/i,
    "keys never leave the authenticator — say so, never imply otherwise",
  );
});
