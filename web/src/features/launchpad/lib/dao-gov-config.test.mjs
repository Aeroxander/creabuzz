/**
 * `dao-gov-config.ts` under `node --test` — the D6 getter pins (drift guard)
 * and the duration formatting behind the quorum line.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  decode,
  SELECTOR_MIN_YES,
  SELECTOR_PROPOSAL_TTL,
  SELECTOR_QUORUM_ABSOLUTE,
  SELECTOR_QUORUM_BPS,
  SELECTOR_TIMELOCK,
} from "./dao-gov-config.ts";

describe("majeur getter selectors pinned to cast sig", () => {
  it("quorumBps / quorumAbsolute / minYes / TTL / timelock", () => {
    assert.equal(SELECTOR_QUORUM_BPS, "0xcd2ddd0c");
    assert.equal(SELECTOR_QUORUM_ABSOLUTE, "0x6a34d91a");
    assert.equal(SELECTOR_MIN_YES, "0x8ab8c683");
    assert.equal(SELECTOR_PROPOSAL_TTL, "0x59a342d6");
    assert.equal(SELECTOR_TIMELOCK, "0xeef09bad");
  });
});

describe("duration formatting", () => {
  it("renders days when whole-enough, seconds otherwise, null when off", () => {
    assert.equal(decode.seconds(30n * 86_400n), "30d");
    assert.equal(decode.seconds(86_400n), "1d");
    assert.equal(decode.seconds(3_600n), "3600s");
    assert.equal(decode.seconds(0n), null);
    assert.equal(decode.seconds(null), null);
  });
});
