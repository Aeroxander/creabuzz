import assert from "node:assert/strict";
import test from "node:test";

import { stageFromChain } from "./sale-stage.ts";

const win = (head, claimBlock = 260) => ({
  startBlock: 100,
  endBlock: 200,
  claimBlock,
  head,
});
const read = (graduated) => ({ source: "rpc", graduated });
const at = (stage, head, progress, over = {}) =>
  stageFromChain({
    stage,
    hasAuction: true,
    progress,
    window: win(head),
    ...over,
  });

test("a sale that has run and been funded reads complete once the buyers can claim, whatever the record says", () => {
  for (const stage of ["draft", "review", "live", "funding"]) {
    assert.equal(at(stage, 300, read(true)), "graduated");
  }
});

test("a sale that missed its minimum reads failed as soon as the auction is over", () => {
  assert.equal(at("draft", 200, read(false)), "failed");
  assert.equal(at("live", 300, read(false)), "failed");
});

test("between the end and the claim block a funded sale is still live, and a draft record is called live", () => {
  assert.equal(at("draft", 230, read(true)), "live");
  assert.equal(at("funding", 230, read(true)), "funding");
});

test("while the auction runs the sale is live even if the record was never set to live", () => {
  assert.equal(at("draft", 150), "live");
  assert.equal(at("review", 100), "live");
  assert.equal(at("live", 199), "live");
  assert.equal(at("funding", 150), "funding");
});

test("before the start block, nothing changes", () => {
  assert.equal(at("draft", 50), "draft");
  assert.equal(at("live", 50), "live");
});

test("a chain that cannot be read leaves the saved label alone, never a guess about how the sale went", () => {
  assert.equal(at("live", 300, undefined), "live");
  assert.equal(
    at("draft", 300, { source: "unavailable", graduated: true }),
    "draft",
  );
  // No block height, no auction, or no block numbers on the record: the same.
  assert.equal(
    stageFromChain({
      stage: "draft",
      hasAuction: true,
      progress: read(true),
      window: win(null),
    }),
    "draft",
  );
  assert.equal(at("draft", 300, read(true), { hasAuction: false }), "draft");
  assert.equal(
    stageFromChain({
      stage: "draft",
      hasAuction: true,
      progress: read(true),
      window: { startBlock: null, endBlock: null, claimBlock: null, head: 300 },
    }),
    "draft",
  );
});

test("a final stage is kept, and no claim block means it is not called complete on a guess", () => {
  assert.equal(at("graduated", 50), "graduated");
  assert.equal(at("failed", 150, read(true)), "failed");
  assert.equal(
    stageFromChain({
      stage: "live",
      hasAuction: true,
      progress: read(true),
      window: win(300, null),
    }),
    "live",
  );
});
