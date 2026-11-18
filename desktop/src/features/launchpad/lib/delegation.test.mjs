/**
 * Desktop delegation composers (`voteTx.ts` additions) under `node --test` —
 * selectors pinned to `cast sig`, padding by construction (never
 * paste-fragile zero counts).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  encodeDelegate,
  encodeDelegatesView,
  SELECTOR_DELEGATE,
  SELECTOR_DELEGATES,
} from "./voteTx.ts";

describe("delegation selectors pinned to cast sig", () => {
  it("delegate(address) / delegates(address)", () => {
    assert.equal(SELECTOR_DELEGATE, "0x5c19a95c");
    assert.equal(SELECTOR_DELEGATES, "0x587cde1e");
  });
});

describe("delegation calldata", () => {
  it("encodes the delegatee address word by construction", () => {
    const word = `${"0".repeat(60)}dead`;
    assert.equal(
      encodeDelegate("0x000000000000000000000000000000000000dEaD"),
      `0x5c19a95c${word}`,
    );
    assert.equal(
      encodeDelegatesView("0x000000000000000000000000000000000000dEaD"),
      `0x587cde1e${word}`,
    );
  });

  it("refuses malformed delegatees (validation at the wire)", () => {
    assert.throws(() => encodeDelegate("0xdead"), /delegatee/);
    assert.throws(() => encodeDelegatesView("npub-ish"), /account/);
  });
});
