import assert from "node:assert/strict";
import test from "node:test";

import { saleAction } from "./sale-action.ts";

const base = { raise: "open", stage: "live", hasAuction: true };

test("bidding is offered only while bidding is open", () => {
  assert.deepEqual(saleAction(base), { kind: "bid", label: "Place bid" });
  assert.deepEqual(saleAction({ ...base, stage: "funding" }), {
    kind: "bid",
    label: "Place bid",
  });
});

test("before a sale exists the main button offers nothing", () => {
  for (const stage of ["draft", "review"]) {
    assert.equal(saleAction({ ...base, raise: "none", stage }), null);
  }
});

test("after bidding closes it says so until the buyers can act", () => {
  assert.deepEqual(saleAction({ ...base, raise: "settling" }), {
    kind: "closed",
    label: "Bidding closed",
  });
  // A failed read of the chain is never taken to mean the buyers can claim.
  assert.deepEqual(
    saleAction({
      ...base,
      raise: "settling",
      progress: { source: "unavailable", ended: true, graduated: true },
    }),
    { kind: "closed", label: "Bidding closed" },
  );
  assert.deepEqual(
    saleAction({
      ...base,
      raise: "settling",
      progress: { source: "rpc", ended: false, graduated: false },
    }),
    { kind: "closed", label: "Bidding closed" },
  );
});

test("once the buyers can act, a funded sale offers tokens and a missed one a refund", () => {
  assert.deepEqual(
    saleAction({
      ...base,
      raise: "settling",
      progress: { source: "rpc", ended: true, graduated: true },
    }),
    { kind: "claim", label: "Claim tokens" },
  );
  assert.deepEqual(
    saleAction({
      ...base,
      raise: "settling",
      progress: { source: "rpc", ended: true, graduated: false },
    }),
    { kind: "refund", label: "Claim refund" },
  );
});

test("a settled sale offers what its outcome allows, and nothing with no auction to claim from", () => {
  assert.deepEqual(saleAction({ ...base, raise: "done", stage: "graduated" }), {
    kind: "claim",
    label: "Claim tokens",
  });
  assert.deepEqual(saleAction({ ...base, raise: "done", stage: "failed" }), {
    kind: "refund",
    label: "Claim refund",
  });
  assert.equal(
    saleAction({
      ...base,
      raise: "done",
      stage: "graduated",
      hasAuction: false,
    }),
    null,
  );
  assert.equal(
    saleAction({ ...base, raise: "settling", hasAuction: false }),
    null,
  );
});
