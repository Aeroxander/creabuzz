import assert from "node:assert/strict";
import test from "node:test";

import { parseLaunchReceipt } from "../models.ts";
import {
  claimReceiptParts,
  delegateReceiptParts,
  executeReceiptParts,
  proposalReceiptParts,
  verdictReceiptParts,
  voteReceiptParts,
} from "./milestone-receipt.ts";

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

test("governance mirrors carry exactly one tx tag (relay envelope)", () => {
  for (const parts of [
    proposalReceiptParts({ proposal: "p1", onchain: "123", tx: TX }),
    voteReceiptParts({ proposal: "p1", vote: "for", tx: TX }),
    executeReceiptParts({ proposal: "p1", tx: TX }),
  ]) {
    assert.equal(parts.extraTags.filter(([n]) => n === "tx").length, 1);
  }
});

test("a vote mirror uses the closed word vocabulary and the grant tag", () => {
  const parts = voteReceiptParts({
    proposal: "p1",
    vote: "against",
    tx: TX,
    grant: "g1",
  });
  assert.equal(parts.content.table, "vote");
  assert.equal(parts.content.vote, "against");
  assert.ok(parts.extraTags.some(([n, v]) => n === "grant" && v === "g1"));
  const bare = voteReceiptParts({ proposal: "p1", vote: "abstain", tx: TX });
  assert.ok(!bare.extraTags.some(([n]) => n === "grant"));
});

test("a proposal mirror says record-only by omitting onchain (D8)", () => {
  const bound = proposalReceiptParts({ proposal: "p1", onchain: "99", tx: TX });
  assert.ok(bound.extraTags.some(([n, v]) => n === "onchain" && v === "99"));
  const bare = proposalReceiptParts({ proposal: "p1", onchain: null, tx: TX });
  assert.ok(!bare.extraTags.some(([n]) => n === "onchain"));
  assert.equal(bare.content.onchain, undefined);
});

test("an execute mirror names its proposal and tx", () => {
  const parts = executeReceiptParts({ proposal: "p1", tx: TX });
  assert.equal(parts.content.table, "execute");
  assert.equal(parts.content.proposal, "p1");
  assert.ok(parts.extraTags.some(([n, v]) => n === "tx" && v === TX));
});

test("a delegate mirror records the authority assignment (and its tx)", () => {
  const parts = delegateReceiptParts({ delegate: "0xabc", tx: TX });
  assert.equal(parts.content.table, "delegate");
  assert.equal(parts.content.delegate, "0xabc");
  assert.equal(parts.extraTags.filter(([n]) => n === "tx").length, 1);
  // D4 closed vocabulary: delegate sits alongside proposal/vote/execute —
  // and is NOT a budget-gated class (see the parts doc).
  assert.ok(parts.extraTags.some(([n, v]) => n === "kind" && v === "delegate"));
});

test("golden: a claim mirror is the CLI's record-claim shape exactly", () => {
  // `claim_receipt_parts` in `crates/buzz-cli/src/commands/launchpad.rs` —
  // the tag order and content members the CLI signs, element for element.
  const evidence = "c".repeat(64);
  const parts = claimReceiptParts({
    claimId: "milestone-1",
    evidenceHash: evidence,
    tx: TX,
  });
  assert.deepEqual(parts.extraTags, [
    ["kind", "claim"],
    ["claim", "milestone-1"],
    ["evidence", evidence],
    ["tx", TX],
  ]);
  assert.deepEqual(parts.content, {
    table: "claim",
    claim: "milestone-1",
    evidenceHash: evidence,
  });
});

test("golden: a verdict mirror is the CLI's record-verdict shape exactly", () => {
  // `verdict_receipt_parts` in `crates/buzz-cli/src/commands/launchpad.rs` —
  // including the closed approve|reject word (a word, never a boolean).
  const parts = verdictReceiptParts({
    claimId: "milestone-1",
    verdict: "reject",
    tx: TX,
  });
  assert.deepEqual(parts.extraTags, [
    ["kind", "verdict"],
    ["claim", "milestone-1"],
    ["tx", TX],
  ]);
  assert.deepEqual(parts.content, {
    table: "verdict",
    claim: "milestone-1",
    verdict: "reject",
  });
});
