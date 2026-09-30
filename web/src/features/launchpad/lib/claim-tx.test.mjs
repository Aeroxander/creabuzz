/**
 * `claim-tx.ts` under `node --test`. Selectors pinned to `cast sig` and two
 * full `cast calldata` goldens so the join cannot drift off the contract.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  encodeFund,
  encodePayout,
  encodeSettle,
  SELECTOR_ATTEST,
  SELECTOR_PAYOUT,
  SELECTOR_SETTLE,
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
    assert.equal(SELECTOR_FUND, "0xe46bbc9e");
    assert.equal(SELECTOR_SETTLE, "0x987757dd");
    assert.equal(SELECTOR_PAYOUT, "0xcfefb3d5");
  });
});

/**
 * The goldens above only prove the hex matches a signature string. This binds
 * each selector to the COMPILED contract, so a signature change in
 * ClaimStake.sol / VerifierSet.sol fails here (the stale `fund(address,…)`
 * selector shipped because nothing did this).
 */
function methodIdentifiers(file, contract, t) {
  const rel = `contracts/out/${file}/${contract}.json`;
  const path = fileURLToPath(new URL(`../../../../../${rel}`, import.meta.url));
  if (!existsSync(path)) {
    if (process.env.REQUIRE_CONTRACT_ARTIFACTS === "1") {
      assert.fail(`${rel} is missing but REQUIRE_CONTRACT_ARTIFACTS=1`);
    }
    t.skip(`artifact not built: ${rel}`);
    return null;
  }
  return JSON.parse(readFileSync(path, "utf8")).methodIdentifiers;
}

describe("selectors exist on the compiled contracts", () => {
  it("ClaimStake", (t) => {
    const ids = methodIdentifiers("ClaimStake.sol", "ClaimStake", t);
    if (!ids) return;
    const have = new Set(Object.values(ids).map((id) => `0x${id}`));
    for (const selector of [
      SELECTOR_SUBMIT_CLAIM,
      SELECTOR_SUBMIT_CLAIM_WITH_SCHEDULE,
      SELECTOR_FUND,
      SELECTOR_SETTLE,
      SELECTOR_PAYOUT,
    ]) {
      assert.ok(have.has(selector), `${selector} is not a ClaimStake method`);
    }
  });

  it("VerifierSet", (t) => {
    const ids = methodIdentifiers("VerifierSet.sol", "VerifierSet", t);
    if (!ids) return;
    assert.equal(`0x${ids["attest(bytes32,bool)"]}`, SELECTOR_ATTEST);
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

describe("fund / settle / payout", () => {
  it("fund(bytes32,uint256) takes the claim word, not an address", () => {
    assert.equal(
      encodeFund(CLAIM_WORD, 1000n),
      "0xe46bbc9e" +
        "6d31000000000000000000000000000000000000000000000000000000000000" +
        "00000000000000000000000000000000000000000000000000000000000003e8",
    );
  });

  it("settle(bytes32) / payout(bytes32)", () => {
    assert.equal(
      encodeSettle(CLAIM_WORD),
      "0x987757dd" +
        "6d31000000000000000000000000000000000000000000000000000000000000",
    );
    assert.equal(
      encodePayout(CLAIM_WORD),
      "0xcfefb3d5" +
        "6d31000000000000000000000000000000000000000000000000000000000000",
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
      /claimIdWord must be 0x \+ 64 hex/,
    );
  });

  it("accepts decimal strings for amounts", () => {
    assert.equal(
      encodeSubmitClaim(CLAIM_WORD, "1000", "0", EVIDENCE_WORD),
      encodeSubmitClaim(CLAIM_WORD, 1000n, 0n, EVIDENCE_WORD),
    );
  });
});
