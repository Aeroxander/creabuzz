import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * Rendering contract for the query failure state (cannot be rendered under
 * `node --test` — no JSX transform — so the component's source is the seam).
 *
 * Each assertion maps to a user-visible promise:
 * - the relay URL it asked is shown (diagnosability),
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

test("the error state shows the relay URL it asked", () => {
  assert.match(source, /relayUrl/, "a relayUrl prop must exist");
  assert.match(
    source,
    /Relay: \{relayUrl\}/,
    "the endpoint must be rendered as evidence",
  );
  assert.match(source, /data-testid=\{`\$\{testId\}-relay`\}/);
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
    /The relay may be offline or unreachable from this browser\./,
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
    /AUTH_REQUIRED_DESCRIPTION\s*=\s*\n?\s*"This relay requires sign-in to load — sign in with your passkey below and this page will retry automatically\."/,
  );
  assert.match(source, /relayFailureOutcome\(error\)/);
  assert.match(source, /data-outcome=\{outcome \?\? "unanswered"\}/);
  // The recovery is a render prop so the caller can wire auto-retry-on-sign-in.
  assert.match(source, /recovery\?: QueryRecovery/);
  assert.match(source, /\{recovery\(retryNow\)\}/);
  assert.match(source, /const retryNow = \(\) => \{\s*\n\s*onRetry\?\.\(\);/);
});

test("answered failures show the relay's wording plus guidance, not 'did not answer'", () => {
  assert.match(
    source,
    /relayFailureGuidance\(relayMessageOf\(error\) \?\? "", kinds\)/,
  );
  assert.match(
    source,
    /answered \|\| authRequired \? \(relayMessageOf\(error\) \?\? message\) : message/,
    "an answered refusal must replace the caller's unanswered copy",
  );
});
