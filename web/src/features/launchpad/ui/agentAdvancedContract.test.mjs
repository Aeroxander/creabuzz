import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * "Create this launch as an agent" / "Record this bid as an agent (NIP-OA
 * attested)" were unintelligible as shipped. The contract now is:
 *
 * - both options live behind an "Advanced" disclosure (they are not the
 *   default path and must not read like one),
 * - the checkbox says what it does in plain words ("Sign as agent instead of
 *   me"), and
 * - one human sentence explains the semantics: the record is signed by this
 *   browser's agent key instead of the personal key, with a NIP-OA
 *   attestation linking it back — useful when an agent manages the record's
 *   updates.
 */

const ROOT = new URL("../../../../", import.meta.url);

function read(relativePath) {
  return readFileSync(fileURLToPath(new URL(relativePath, ROOT)), "utf8");
}

const CHECKBOX_LABEL = "Sign as agent instead of me";

/**
 * The disclosure lives in the dialog; the body it opens — checkbox, explainer
 * and all — moved to `create-wizard/LegacyFields.tsx` when the wizard took
 * over the happy path. Both halves are read from production, so a field that
 * escapes the drawer still fails here.
 */
const LAUNCH_DIALOG = "src/features/launchpad/ui/CreateLaunchDialog.tsx";
const LAUNCH_BODY = "src/features/launchpad/ui/create-wizard/LegacyFields.tsx";

test("the launch agent option sits in an Advanced disclosure", () => {
  const source = read(LAUNCH_DIALOG);
  assert.match(source, /data-testid="launch-advanced"/);
  assert.match(source, /<summary[^>]*>\s*\n?\s*Advanced/);
  const body = read(LAUNCH_BODY);
  assert.match(body, new RegExp(CHECKBOX_LABEL));
  assert.match(body, /data-testid="launch-as-agent-explainer"/);
  // The sentence must match the real path: agent-key signature + NIP-OA
  // attestation + agent-managed updates (see lib/agent-launchpad.ts).
  assert.match(
    body,
    /signed by this browser&apos;s agent key \(an\s*\n?\s*attested AI-agent identity\) instead of your personal key — useful when\s*\n?\s*an agent manages the launch&apos;s updates/,
  );
  // The unintelligible wording must not survive anywhere.
  assert.doesNotMatch(source, /Create this launch as an agent/);
  assert.doesNotMatch(body, /Create this launch as an agent/);
});

test("the bid agent option sits in an Advanced disclosure", () => {
  const source = read("src/features/launchpad/ui/RecordBidDialog.tsx");
  assert.match(source, /data-testid="bid-advanced"/);
  assert.match(source, new RegExp(CHECKBOX_LABEL));
  assert.match(source, /data-testid="bid-as-agent-explainer"/);
  assert.match(
    source,
    /signed by this browser&apos;s agent key \(an\s*\n?\s*attested AI-agent identity\) instead of your personal key — useful when\s*\n?\s*an agent manages the bid&apos;s follow-up/,
  );
  assert.doesNotMatch(source, /Record this bid as an agent/);
});

test("the checkbox testids the e2e suite drives are unchanged", () => {
  assert.match(read(LAUNCH_BODY), /data-testid="launch-as-agent"/);
  assert.match(
    read("src/features/launchpad/ui/RecordBidDialog.tsx"),
    /data-testid="bid-as-agent"/,
  );
});
