import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * The edit surface must ride the wizard, not a parallel raw form.
 *
 * `LegacyFields.tsx` used to render a field-for-field copy of the old form for
 * edit mode — raw name/symbol/supply inputs and its own `legacyValid` gate —
 * so the edit dialog could (and did) drift from the wizard's validation. The
 * contract now is:
 *
 * - edit renders the SAME step components the create wizard uses
 *   (`WizardSteps` with `variant="all"`), plus the shared advanced fields;
 * - name, symbol and total supply have exactly one owner: the wizard's token
 *   step. No raw copy of them exists anywhere;
 * - both gates come from `lib/wizard.ts` (`canPublish` / `canSaveEdit`) — the
 *   dialog defines no validation of its own.
 *
 * These read production source (the `agentAdvancedContract.test.mjs`
 * pattern): reintroducing a LegacyFields-style raw field bypass in the edit
 * surface fails this file.
 */

const ROOT = new URL("../../../../", import.meta.url);

function read(relativePath) {
  return readFileSync(fileURLToPath(new URL(relativePath, ROOT)), "utf8");
}

const DIALOG = "src/features/launchpad/ui/CreateLaunchDialog.tsx";
const ADVANCED = "src/features/launchpad/ui/create-wizard/AdvancedFields.tsx";
const STEPS = "src/features/launchpad/ui/create-wizard/WizardSteps.tsx";
const WIZARD = "src/features/launchpad/lib/wizard.ts";

test("the edit surface renders the wizard's step components, not a raw form", () => {
  const dialog = read(DIALOG);
  assert.match(
    dialog,
    /<WizardSteps\s+controller=\{controller\}\s+variant="all"\s*\/>/,
  );
  // The shared advanced fields render on both surfaces; the legacy form is gone.
  assert.match(dialog, /<AdvancedFields\s+\{\.\.\.legacy\}\s*\/>/);
  assert.doesNotMatch(dialog, /legacyFields|LegacyFields/);
  assert.doesNotMatch(read(STEPS), /legacyFields|LegacyFields/);
});

test("name, symbol and total supply have exactly one owner: the wizard steps", () => {
  const dialog = read(DIALOG);
  const advanced = read(ADVANCED);
  const steps = read(STEPS);
  for (const id of ["launch-name", "launch-symbol", "launch-supply"]) {
    // No raw copy of a wizard-owned field outside the step components.
    assert.doesNotMatch(dialog, new RegExp(`id="${id}"`));
    assert.doesNotMatch(advanced, new RegExp(`id="${id}"`));
    assert.match(steps, new RegExp(`id="${id}"`));
  }
});

test("both surfaces validate through lib/wizard.ts only", () => {
  const dialog = read(DIALOG);
  // The two gates the dialog uses.
  assert.match(dialog, /canPublish\(/);
  assert.match(dialog, /canSaveEdit\(/);
  // No validation of its own: no local gate, no inline slug/token checks.
  // (The Verify button may still *format*-check its input to enable itself —
  // that is affordance, not validation.)
  assert.doesNotMatch(dialog, /legacyValid|tokenValid/);
  assert.doesNotMatch(dialog, /isLaunchSlug\(/);
  // The validator really lives in wizard.ts and covers the edit surface.
  const wizard = read(WIZARD);
  assert.match(wizard, /export function editIssues\(/);
  assert.match(wizard, /export function canSaveEdit\(/);
  assert.match(wizard, /export function publishIssues\(/);
});
