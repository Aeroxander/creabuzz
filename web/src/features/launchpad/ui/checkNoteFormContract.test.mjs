import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The check-note form's wiring (outside review 2026-11-01, claims 2, 3 and 7; suite review): the logic lives in core
 * (`checkNote.ts`, `checkNoteAi.ts`, tested there), and these read the production component to hold it to that logic:
 *
 * - publishing names the published note as applied, in the same focus save as its changes;
 * - an AI answer goes through `acceptCheckDraft` against the note as it is now, never a copy from when it was asked;
 * - the red problem waits until the founder has tried to publish;
 * - the AI hint says the words go to the server's AI service, and no line claims a passed date means missing work.
 */

const SOURCE = readFileSync(
  fileURLToPath(new URL("./CheckNoteCard.tsx", import.meta.url)),
  "utf8",
);

test("publishing applies the note to Now under the id the server took it as", () => {
  assert.match(SOURCE, /const id = await notes\.publish\(note\)/);
  assert.match(
    SOURCE,
    /applyCheckToFocus\(focus\.query\.data, \{\s*id,\s*items: note\.items,?\s*\}\)/,
  );
});

test("an AI summary is added only to the note it was asked about", () => {
  assert.match(
    SOURCE,
    /acceptCheckDraft\(asked, current\.current, draft\.summary\)/,
  );
  assert.doesNotMatch(SOURCE, /setEdits\(\{ \.\.\.note, summary/);
});

test("the problem shows only after the founder tried to publish", () => {
  assert.match(SOURCE, /\(tried && problem\) \|\| failure/);
  assert.doesNotMatch(SOURCE, /disabled=\{busy \|\| problem !== null\}/);
});

test("the AI hint says where the words go, and a passed date is only a date", () => {
  assert.match(SOURCE, /sent to this server&apos;s AI service/);
  assert.doesNotMatch(SOURCE, /without the work coming in/);
});
