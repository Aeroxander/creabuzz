import assert from "node:assert/strict";
import test from "node:test";

import { saleAction } from "./sale-action.ts";

const BID = { kind: "bid", label: "Place bid" };
const CLOSED = { kind: "closed", label: "Bidding closed" };
const NOT_YET = { kind: "closed", label: "Bidding not open yet" };
const CLAIM = { kind: "claim", label: "Claim tokens" };
const REFUND = { kind: "refund", label: "Claim refund" };

const win = (head, claimBlock = 260) => ({
  startBlock: 100,
  endBlock: 200,
  claimBlock,
  head,
});
const read = (graduated) => ({ source: "rpc", graduated });
const sale = (over) => ({
  raise: "none",
  stage: "draft",
  hasAuction: true,
  ...over,
});

test("a running auction is open to bids from its start block up to, not including, its end block, whatever the saved stage says", () => {
  for (const stage of ["draft", "review", "live", "funding"]) {
    assert.deepEqual(saleAction(sale({ stage, window: win(100) })), BID);
    assert.deepEqual(saleAction(sale({ stage, window: win(150) })), BID);
    assert.deepEqual(saleAction(sale({ stage, window: win(199) })), BID);
  }
});

test("the end block itself is closed: the auction refuses a bid there", () => {
  assert.deepEqual(
    saleAction(sale({ window: win(200), progress: read(true) })),
    CLOSED,
  );
  assert.deepEqual(
    saleAction(sale({ stage: "live", raise: "open", window: win(200) })),
    CLOSED,
  );
});

test("before the start block it says so", () => {
  assert.deepEqual(saleAction(sale({ window: win(50) })), NOT_YET);
  assert.deepEqual(
    saleAction(sale({ stage: "live", raise: "open", window: win(50) })),
    NOT_YET,
  );
});

test("a finished auction offers a refund or tokens whether or not the record was ever set to Live", () => {
  // The saved label is a stale draft; the chain says the sale missed its minimum, then met it.
  assert.deepEqual(
    saleAction(sale({ window: win(300), progress: read(false) })),
    REFUND,
  );
  assert.deepEqual(
    saleAction(sale({ window: win(300), progress: read(true) })),
    CLAIM,
  );
  // A refund opens as soon as the auction is over; tokens wait for the claim block.
  assert.deepEqual(
    saleAction(sale({ window: win(200), progress: read(false) })),
    REFUND,
  );
  assert.deepEqual(
    saleAction(sale({ window: win(230), progress: read(true) })),
    CLOSED,
  );
  assert.deepEqual(
    saleAction(sale({ window: win(260), progress: read(true) })),
    CLAIM,
  );
});

test("meeting the minimum while bidding is still open does not end the bidding", () => {
  assert.deepEqual(
    saleAction(sale({ window: win(150), progress: read(true) })),
    BID,
  );
});

test("a failed read of the chain is never taken to mean the buyers may act", () => {
  for (const progress of [
    undefined,
    { source: "unavailable", graduated: true },
  ]) {
    assert.deepEqual(saleAction(sale({ window: win(300), progress })), CLOSED);
  }
  // No claim block on the record: tokens are not offered on a guess.
  assert.deepEqual(
    saleAction(sale({ window: win(300, null), progress: read(true) })),
    CLOSED,
  );
});

test("with no reading of the clock the saved label and receipts decide, as they always did", () => {
  assert.deepEqual(saleAction(sale({ stage: "live", raise: "open" })), BID);
  assert.deepEqual(
    saleAction(sale({ stage: "live", raise: "settling" })),
    CLOSED,
  );
  assert.deepEqual(
    saleAction(sale({ stage: "graduated", raise: "done" })),
    CLAIM,
  );
  assert.deepEqual(
    saleAction(sale({ stage: "failed", raise: "done" })),
    REFUND,
  );
  assert.equal(saleAction(sale()), null);
});

test("with no auction there is nothing to claim or refund, and a draft offers nothing", () => {
  assert.equal(saleAction(sale({ hasAuction: false, window: win(150) })), null);
  assert.equal(
    saleAction(sale({ hasAuction: false, stage: "graduated", raise: "done" })),
    null,
  );
  assert.equal(
    saleAction(sale({ hasAuction: false, stage: "failed", raise: "done" })),
    null,
  );
  assert.equal(
    saleAction(sale({ hasAuction: false, stage: "live", raise: "settling" })),
    null,
  );
  // A record-only sale that is open can still record a bid.
  assert.deepEqual(
    saleAction(sale({ hasAuction: false, stage: "live", raise: "open" })),
    BID,
  );
});
