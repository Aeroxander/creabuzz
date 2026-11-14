import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * Rendering contract for the query failure state (cannot be rendered under
 * `node --test` — no JSX transform — so the component's source is the seam).
 *
 * Each assertion maps to a user-visible promise:
 * - the server address it asked and the server's wording are kept under a
 *   collapsed "Technical details" (diagnosability without jargon in main copy),
 * - a retry button exists (recovery),
 * - the four outcomes render different copy (auth-required / answered /
 *   unanswered), so "did not answer" can never swallow an auth refusal again.
 *
 * The classification *logic* is pinned separately in
 * `../lib/relay-failure.test.mjs`; this file pins that this component uses it.
 */

const source = readFileSync(
  fileURLToPath(new URL("./query-error.tsx", import.meta.url)),
  "utf8",
);

test("the error state keeps the server address and wording under Technical details", () => {
  assert.match(source, /relayUrl/, "a relayUrl prop must exist");
  // Collapsed by default: a <details> without `open`, so the plain words come first.
  assert.match(source, /<details\n\s*className=/);
  assert.doesNotMatch(source, /<details[^>]*\bopen\b/);
  assert.match(source, /Technical details/);
  const details = source.slice(
    source.indexOf("<details"),
    source.indexOf("</details>"),
  );
  assert.match(details, /Server: \{relayUrl\}/, "the endpoint is evidence");
  assert.match(details, /\{detailMessage\}/, "so is the server's wording");
  assert.match(details, /data-testid=\{`\$\{testId\}-relay`\}/);
  assert.match(details, /data-testid=\{`\$\{testId\}-message`\}/);
  // Nothing outside the disclosure prints them.
  const outside = source.replace(details, "");
  assert.doesNotMatch(outside, /\{relayUrl\}|\{detailMessage\}|Relay:/);
});

test("the error state offers a retry", () => {
  assert.match(source, /onRetry/, "a retry prop must exist");
  assert.match(
    source,
    /data-testid=\{`\$\{testId\}-retry`\}/,
    "the retry button must keep its testid hook",
  );
  assert.match(source, /Try again/, "the retry affordance must be labelled");
});

test("an unanswered failure says the relay may be unreachable", () => {
  assert.match(
    source,
    /The server may be offline, or this browser can't reach it\./,
  );
  assert.match(
    source,
    /data-testid=\{`\$\{testId\}-hint`\}/,
    "the guidance line must be individually assertable",
  );
});

test("auth-required has its own copy and is derived from the raw error", () => {
  assert.match(
    source,
    /AUTH_REQUIRED_DESCRIPTION\s*=\s*\n?\s*"Sign in to see this\. Use your passkey below and the page loads by itself\."/,
  );
  assert.match(source, /relayFailureOutcome\(error\)/);
  assert.match(source, /data-outcome=\{outcome \?\? "unanswered"\}/);
  // The recovery is a render prop so the caller can wire auto-retry-on-sign-in.
  assert.match(source, /recovery\?: QueryRecovery/);
  assert.match(source, /\{recovery\(retryNow\)\}/);
  assert.match(source, /const retryNow = \(\) => \{\s*\n\s*onRetry\?\.\(\);/);
});

test("answered failures say the refusal in plain words or give guidance, not 'did not answer'", () => {
  assert.match(
    source,
    /plainRefusalText\(relayMessage \?\? ""\) \?\?\s*relayFailureGuidance\(relayMessage \?\? ""\)/,
    "an answered refusal must replace the caller's unanswered copy",
  );
  assert.match(source, /const detailMessage = relayMessage \?\? message;/);
  // Record numbers are for whoever helps, so they sit under Technical details, not in the main sentence.
  assert.match(source, /unknownKindsDetail\(relayMessage \?\? "", kinds\)/);
});
