import assert from "node:assert/strict";
import test from "node:test";

import { olderRelayGuidance, SKILL_RECORD_KIND } from "./relayNotice.ts";

/**
 * The skills read/publish paths must not collapse an answered refusal into a
 * generic failure: the relay's own words stay on screen, and the guidance
 * names the kind and the relay-side fix.
 */

test("an unknown-kind refusal gets the older-build guidance with the kind", () => {
  assert.equal(
    olderRelayGuidance(
      "relay returned 400 Bad Request: restricted: unknown event kind",
    ),
    `This relay is running an older build that doesn't know these records (kind ${SKILL_RECORD_KIND}) — restart it from the current build, or point the app at a newer relay.`,
  );
  assert.equal(SKILL_RECORD_KIND, 30180);
});

test("a kind named by the relay wins over the default", () => {
  assert.match(
    olderRelayGuidance("restricted: unknown event kind 37015") ?? "",
    /\(kind 37015\)/,
  );
});

test("anything else gets no upgrade advice", () => {
  assert.equal(olderRelayGuidance("restricted: insufficient scope"), null);
  assert.equal(olderRelayGuidance(null), null);
  assert.equal(olderRelayGuidance(undefined), null);
  assert.equal(olderRelayGuidance(""), null);
  assert.equal(olderRelayGuidance("WebSocket connection failed"), null);
});
