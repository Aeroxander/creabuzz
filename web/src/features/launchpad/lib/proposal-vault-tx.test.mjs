/**
 * `proposal-vault-tx.ts` under `node --test`. Selectors pinned to `cast sig`,
 * full `cast calldata` goldens, and — the binding that actually matters —
 * each selector checked against the COMPILED `ProposalVault` artifact, so a
 * signature change in the contract fails here rather than shipping as a call
 * that silently does nothing.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  encodeBack,
  encodeBackingWeightAt,
  encodeClaimTokens,
  encodeFail,
  encodeOpenProposal,
  encodePledge,
  encodeProposalOf,
  encodeRefundPosition,
  encodeRefundVouchers,
  encodeTokensAtRisk,
  encodeVerify,
  encodeVouchersOf,
  SELECTOR_BACK,
  SELECTOR_BACKING_WEIGHT_AT,
  SELECTOR_CLAIM_TOKENS,
  SELECTOR_FAIL,
  SELECTOR_OPEN_PROPOSAL,
  SELECTOR_PLEDGE,
  SELECTOR_PROPOSALS,
  SELECTOR_REFUND_POSITION,
  SELECTOR_REFUND_VOUCHERS,
  SELECTOR_TOKENS_AT_RISK,
  SELECTOR_VERIFY,
  SELECTOR_VOUCHERS,
} from "./proposal-vault-tx.ts";

const PROPOSAL_WORD =
  "0x6d31000000000000000000000000000000000000000000000000000000000000";
const CHECK_WORD =
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ACCOUNT = "0x1111111111111111111111111111111111111111";

describe("selectors pinned to cast sig", () => {
  it("the eight writes", () => {
    assert.equal(SELECTOR_PLEDGE, "0x7326c9c0");
    assert.equal(SELECTOR_REFUND_VOUCHERS, "0x4283fa3e");
    assert.equal(SELECTOR_OPEN_PROPOSAL, "0x08842bf9");
    assert.equal(SELECTOR_BACK, "0x71459550");
    assert.equal(SELECTOR_VERIFY, "0x75e36616");
    assert.equal(SELECTOR_FAIL, "0x21d2a07c");
    assert.equal(SELECTOR_REFUND_POSITION, "0x9de21cb8");
    assert.equal(SELECTOR_CLAIM_TOKENS, "0x6facd1c0");
  });

  it("the four reads", () => {
    assert.equal(SELECTOR_VOUCHERS, "0x450b9743");
    assert.equal(SELECTOR_PROPOSALS, "0x32ed5b12");
    assert.equal(SELECTOR_TOKENS_AT_RISK, "0x346b109b");
    assert.equal(SELECTOR_BACKING_WEIGHT_AT, "0xa77e5baa");
  });
});

/** The selectors must exist on the compiled contract, not just in this file. */
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

describe("selectors exist on the compiled ProposalVault", () => {
  it("every write and read is a real method", (t) => {
    const ids = methodIdentifiers("ProposalVault.sol", "ProposalVault", t);
    if (!ids) return;
    const have = new Set(Object.values(ids).map((id) => `0x${id}`));
    for (const [name, selector] of Object.entries({
      pledge: SELECTOR_PLEDGE,
      refundVouchers: SELECTOR_REFUND_VOUCHERS,
      openProposal: SELECTOR_OPEN_PROPOSAL,
      back: SELECTOR_BACK,
      verify: SELECTOR_VERIFY,
      fail: SELECTOR_FAIL,
      refundPosition: SELECTOR_REFUND_POSITION,
      claimTokens: SELECTOR_CLAIM_TOKENS,
      vouchers: SELECTOR_VOUCHERS,
      proposals: SELECTOR_PROPOSALS,
      tokensAtRisk: SELECTOR_TOKENS_AT_RISK,
      backingWeightAt: SELECTOR_BACKING_WEIGHT_AT,
    })) {
      assert.ok(
        have.has(selector),
        `${selector} is not a ProposalVault method (${name})`,
      );
    }
  });
});

describe("cast calldata goldens", () => {
  it("pledge(uint256) 1000", () => {
    assert.equal(
      encodePledge(1000n),
      "0x7326c9c0" +
        "00000000000000000000000000000000000000000000000000000000000003e8",
    );
    // The refund is the same shape: one amount word, and the caller's own
    // vouchers are what come back.
    assert.equal(
      encodeRefundVouchers(1000n),
      "0x4283fa3e" +
        "00000000000000000000000000000000000000000000000000000000000003e8",
    );
  });

  it("back(bytes32,uint256) p/500", () => {
    assert.equal(
      encodeBack(PROPOSAL_WORD, 500n),
      "0x71459550" +
        "6d31000000000000000000000000000000000000000000000000000000000000" +
        "00000000000000000000000000000000000000000000000000000000000001f4",
    );
  });

  it("openProposal(bytes32,uint256,uint256,uint64,bytes32) p/100/10000/100/c", () => {
    assert.equal(
      encodeOpenProposal(PROPOSAL_WORD, 100n, 10_000n, 100n, CHECK_WORD),
      "0x08842bf9" +
        "6d31000000000000000000000000000000000000000000000000000000000000" +
        "0000000000000000000000000000000000000000000000000000000000000064" +
        "0000000000000000000000000000000000000000000000000000000000002710" +
        "0000000000000000000000000000000000000000000000000000000000000064" +
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
  });

  it("refundPosition(bytes32) p", () => {
    assert.equal(
      encodeRefundPosition(PROPOSAL_WORD),
      "0x9de21cb8" +
        "6d31000000000000000000000000000000000000000000000000000000000000",
    );
  });

  it("vouchers(address) / tokensAtRisk(address) pad left", () => {
    const padded =
      "0000000000000000000000001111111111111111111111111111111111111111";
    assert.equal(encodeVouchersOf(ACCOUNT), `0x450b9743${padded}`);
    assert.equal(encodeTokensAtRisk(ACCOUNT), `0x346b109b${padded}`);
  });

  it("the single-argument writes all carry exactly one word", () => {
    for (const encoded of [
      encodeVerify(PROPOSAL_WORD),
      encodeFail(PROPOSAL_WORD),
      encodeClaimTokens(PROPOSAL_WORD),
      encodeProposalOf(PROPOSAL_WORD),
    ]) {
      assert.equal(encoded.length, 2 + 8 + 64, encoded);
    }
    assert.equal(
      encodeBackingWeightAt(PROPOSAL_WORD, ACCOUNT, 42).length,
      2 + 8 + 64 * 3,
    );
  });
});

describe("malformed arguments are refused, not silently truncated", () => {
  it("a proposal id must be 0x + 64 hex", () => {
    assert.throws(() => encodeVerify("0x1234"), /proposalIdWord must be/);
    assert.throws(
      () => encodeBack(PROPOSAL_WORD.slice(0, 10), 1n),
      /proposalIdWord/,
    );
  });

  it("an account must be 0x + 40 hex", () => {
    assert.throws(() => encodeVouchersOf("0x0123"), /account must be/);
  });

  it("an amount must fit a uint256", () => {
    assert.throws(() => encodePledge(-1n), /amount must be a uint256/);
  });
});
