import assert from "node:assert/strict";
import test from "node:test";

import { parseLaunchReceipt } from "../models.ts";
import { claimReceiptParts, verdictReceiptParts } from "./milestone-receipt.ts";

const ALICE = "a".repeat(64);
const TX = `0x${"b".repeat(64)}`;

/** A published receipt as the relay would store it: `a` tag + built tags. */
function receiptEvent(parts, slug = "nebula") {
  return {
    id: `receipt-${slug}`,
    pubkey: ALICE,
    created_at: 130,
    kind: 47005,
    tags: [["a", `37001:${ALICE}:${slug}`], ...parts.extraTags],
    content: JSON.stringify(parts.content),
    sig: "sig",
  };
}

test("a claim mirror carries the tx tag the relay requires", () => {
  const parts = claimReceiptParts({
    claimId: "milestone-1",
    evidenceHash: "c".repeat(64),
    tx: TX,
  });
  const txTags = parts.extraTags.filter(([name]) => name === "tx");
  assert.equal(txTags.length, 1);
  assert.deepEqual(txTags[0], ["tx", TX]);
});

test("a claim mirror survives the production parser", () => {
  const receipt = parseLaunchReceipt(
    receiptEvent(
      claimReceiptParts({
        claimId: "milestone-1",
        evidenceHash: "c".repeat(64),
        tx: TX,
      }),
    ),
  );
  assert.ok(receipt, "a claim mirror must not be dropped by the feed parser");
  assert.equal(receipt.table, "claim");
  assert.equal(receipt.tx, TX);
});

test("a verdict mirror survives the production parser and states the word", () => {
  const parts = verdictReceiptParts({
    claimId: "milestone-1",
    verdict: "reject",
    tx: TX,
  });
  const receipt = parseLaunchReceipt(receiptEvent(parts));
  assert.ok(receipt, "a verdict mirror must not be dropped by the feed parser");
  assert.equal(receipt.table, "verdict");
  assert.equal(parts.content.verdict, "reject");
  assert.equal(receipt.payload.verdict, "reject");
});

test("dropping the tx tag is what made these receipts invisible", () => {
  // The regression this module exists for: without `tx` the parser drops the
  // receipt, so the test above is the falsifiable guard against a repeat.
  const parts = claimReceiptParts({
    claimId: "milestone-1",
    evidenceHash: "c".repeat(64),
    tx: TX,
  });
  const withoutTx = {
    ...parts,
    extraTags: parts.extraTags.filter(([n]) => n !== "tx"),
  };
  assert.equal(parseLaunchReceipt(receiptEvent(withoutTx)), null);
});
