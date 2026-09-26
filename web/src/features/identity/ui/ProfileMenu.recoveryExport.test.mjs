/**
 * Export-copy contract for the web identity panel's "Use on desktop"
 * affordance (`./ProfileMenu.tsx`).
 *
 * The recovery-nsec copy itself predates this flow (onboarding's
 * `PasskeyCeremonyPage` + `exportPasskeyNsec`); what this pins is how it is
 * surfaced in the identity panel: the label the user acts on, the wiring to
 * the real export function (a label with no copy action protects nothing),
 * and the honesty rules — the nsec is the FULL account, the handoff is
 * interim until passkey-native sharing ships with app signing activation, and
 * the passkey itself is never claimed to leave the device.
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
  // Wiring: the item must copy the exported session key, not a placeholder.
  assert.match(source, /copyNsec\(passkeyNsec, "Recovery key copied"\)/);
  assert.match(source, /passkeyNsec = exportPasskeyNsec\(\)/);
});

test("the note names the desktop handoff it exists for", () => {
  assert.ok(note, "recovery-export-note must render");
  assert.match(note, /Copy recovery key to set up another device/);
  assert.match(note, /desktop/);
});

test("the note is honest about the key being the full account", () => {
  assert.match(note, /nsec is the full account/);
  assert.match(note, /anyone holding it can sign as you/);
  assert.match(note, /store it somewhere safe/);
});

test("the note frames the handoff as interim until passkey-native sharing", () => {
  assert.match(note, /Passkey-native sharing/);
  assert.match(
    note,
    /app signing activation/,
    "the note must say what makes this key handoff unnecessary",
  );
  assert.match(note, /interim path/);
});

test("the note never claims the passkey itself was exported", () => {
  assert.match(note, /passkey itself never leaves your device/);
  assert.doesNotMatch(
    note,
    /passkey (was |is )?(copied|exported|moved)/i,
    "keys never leave the authenticator — say so, never imply otherwise",
  );
});
