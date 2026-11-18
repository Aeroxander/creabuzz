/**
 * `models.ts`'s proposal-calls parse under `node --test` (node >= 22
 * strip-types): the ERC-4824 `CallDataEVM` field's strict-parse discipline.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseProposalCalls, parseProposalIntent } from "../models.ts";

const CALL = {
  operation: "call",
  from: "0xaaa",
  to: "0xbbb",
  value: "0",
  data: "0x2fb15081",
};

const INTENT = {
  op: 0,
  to: "0x000000000000000000000000000000000000dEaD",
  value: "0",
  data: "0x2fb15081",
  nonce: `0x${"11".repeat(32)}`,
};

describe("parseProposalCalls", () => {
  it("parses well-formed CallDataEVM entries (call and delegatecall)", () => {
    const out = parseProposalCalls([
      CALL,
      { ...CALL, operation: "delegatecall" },
    ]);
    assert.equal(out?.length, 2);
    assert.equal(out?.[0].operation, "call");
    assert.equal(out?.[1].operation, "delegatecall");
    assert.equal(out?.[0].data, "0x2fb15081");
  });

  it("drops the WHOLE field when any entry is malformed (no guessing)", () => {
    assert.equal(
      parseProposalCalls([CALL, { ...CALL, operation: "staticcall" }]),
      undefined,
    );
    assert.equal(parseProposalCalls([CALL, { ...CALL, data: 42 }]), undefined);
    assert.equal(parseProposalCalls([CALL, "not-an-object"]), undefined);
    assert.equal(parseProposalCalls([{ operation: "call" }]), undefined);
  });

  it("treats absent/empty as no field at all", () => {
    assert.equal(parseProposalCalls(undefined), undefined);
    assert.equal(parseProposalCalls([]), undefined);
    assert.equal(parseProposalCalls({}), undefined);
  });
});

describe("parseProposalIntent (desktop parity, D8)", () => {
  it("parses a well-formed executeByVotes intent", () => {
    const out = parseProposalIntent(INTENT);
    assert.deepEqual(out, INTENT);
  });

  it("is shape-level like desktop's — format checks live in the encoder", () => {
    // A short nonce parses here (strings pass through); the composer
    // (`encodeExecuteByVotes`) rejects it at wire time. Test truth:
    assert.deepEqual(parseProposalIntent({ ...INTENT, nonce: "0x1234" }), {
      ...INTENT,
      nonce: "0x1234",
    });
  });

  it("returns null — never a guess — for type-level malformations", () => {
    assert.equal(parseProposalIntent({ ...INTENT, op: 2 }), null);
    assert.equal(parseProposalIntent({ ...INTENT, value: 42 }), null);
    assert.equal(parseProposalIntent({ ...INTENT, data: 7 }), null);
    assert.equal(parseProposalIntent({ ...INTENT, nonce: 5 }), null);
    assert.equal(parseProposalIntent(null), null);
    assert.equal(parseProposalIntent([INTENT]), null);
  });
});
