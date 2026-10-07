import assert from "node:assert/strict";
import test from "node:test";

import { olderRelayGuidance, SKILL_RECORD_KIND } from "./relayNotice.ts";

/**
 * The skills read/publish paths must not collapse an answered refusal into a
 * generic failure: the relay's own words stay on screen, and the guidance
 * names the relay-side fix.
 */

test("an unknown-kind refusal gets the older-build guidance", () => {
  assert.equal(
    olderRelayGuidance(
      "relay returned 400 Bad Request: restricted: unknown event kind",
    ),
    "This server is running an older version that doesn't know about these skills yet. Update the server, or point the app at a newer one.",
  );
  assert.equal(SKILL_RECORD_KIND, 30180);
});

test("a kind named by the relay still gets the same guidance", () => {
  assert.equal(
    olderRelayGuidance("restricted: unknown event kind 37015"),
    "This server is running an older version that doesn't know about these skills yet. Update the server, or point the app at a newer one.",
  );
});

test("anything else gets no upgrade advice", () => {
  assert.equal(olderRelayGuidance("restricted: insufficient scope"), null);
  assert.equal(olderRelayGuidance(null), null);
  assert.equal(olderRelayGuidance(undefined), null);
  assert.equal(olderRelayGuidance(""), null);
  assert.equal(olderRelayGuidance("WebSocket connection failed"), null);
});
