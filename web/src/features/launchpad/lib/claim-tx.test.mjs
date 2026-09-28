/**
 * `claim-tx.ts` under `node --test`. Selectors pinned to `cast sig` and two
 * full `cast calldata` goldens so the join cannot drift off the contract.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  encodeFund,
  encodeSubmitClaim,
  encodeSubmitClaimWithSchedule,
  SELECTOR_FUND,
  SELECTOR_SUBMIT_CLAIM,
  SELECTOR_SUBMIT_CLAIM_WITH_SCHEDULE,
} from "./claim-tx.ts";

const CLAIM_WORD =
  "0x6d31000000000000000000000000000000000000000000000000000000000000";
const EVIDENCE_WORD =
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("selectors pinned to cast sig", () => {
  it("submitClaim / submitClaimWithSchedule / fund", () => {
    assert.equal(SELECTOR_SUBMIT_CLAIM, "0x26d3f6d4");
    assert.equal(SELECTOR_SUBMIT_CLAIM_WITH_SCHEDULE, "0x55e9ad90");
    assert.equal(SELECTOR_FUND, "0x7b1837de");
  });
});

describe("cast calldata goldens", () => {
  it("submitClaim(bytes32,uint256,uint256,bytes32) m1/1000/0/0xaa..", () => {
    assert.equal(
      encodeSubmitClaim(CLAIM_WORD, 1000n, 0n, EVIDENCE_WORD),
      "0x26d3f6d4" +
        "6d31000000000000000000000000000000000000000000000000000000000000" +
        "00000000000000000000000000000000000000000000000000000000000003e8" +
        "0000000000000000000000000000000000000000000000000000000000000000" +
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
  });

  it("submitClaimWithSchedule(...) m1/2000/5/0xaa../1/31536000/1/500", () => {
    assert.equal(
      encodeSubmitClaimWithSchedule(
        CLAIM_WORD,
        2000n,
        5n,
        EVIDENCE_WORD,
        1,
        31536000,
        1,
        500n,
      ),
      "0x55e9ad90" +
        "6d31000000000000000000000000000000000000000000000000000000000000" +
        "00000000000000000000000000000000000000000000000000000000000007d0" +
        "0000000000000000000000000000000000000000000000000000000000000005" +
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" +
        "0000000000000000000000000000000000000000000000000000000000000001" +
        "0000000000000000000000000000000000000000000000000000000001e13380" +
        "0000000000000000000000000000000000000000000000000000000000000001" +
        "00000000000000000000000000000000000000000000000000000000000001f4",
    );
  });
});

describe("fund(address,uint256)", () => {
  it("left-pads the funder address", () => {
    const out = encodeFund("0x000000000000000000000000000000000000dEaD", 1000n);
    assert.equal(
      out,
      "0x7b1837de" +
        "000000000000000000000000000000000000000000000000000000000000dead" +
        "00000000000000000000000000000000000000000000000000000000000003e8",
    );
  });
});

describe("input validation", () => {
  it("refuses malformed words and addresses", () => {
    assert.throws(
      () => encodeSubmitClaim("0x1234", 1n, 0n, EVIDENCE_WORD),
      /claimIdWord must be 0x \+ 64 hex/,
    );
    assert.throws(
      () => encodeSubmitClaim(CLAIM_WORD, -1n, 0n, EVIDENCE_WORD),
      /uint256/,
    );
    assert.throws(
      () => encodeSubmitClaim(CLAIM_WORD, 1n, 0n, "0xzz"),
      /evidenceHashWord must be 0x \+ 64 hex/,
    );
    assert.throws(
      () => encodeFund("0xdead", 1n),
      /funder must be 0x \+ 40 hex/,
    );
  });

  it("accepts decimal strings for amounts", () => {
    assert.equal(
      encodeSubmitClaim(CLAIM_WORD, "1000", "0", EVIDENCE_WORD),
      encodeSubmitClaim(CLAIM_WORD, 1000n, 0n, EVIDENCE_WORD),
    );
  });
});
