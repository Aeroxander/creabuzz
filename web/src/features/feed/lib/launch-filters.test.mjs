import assert from "node:assert/strict";
import test from "node:test";

import {
  CLOSING_SOON_BLOCKS,
  closingSoonLaunches,
  graduatedLaunches,
  receiptProvenGraduated,
} from "./launch-filters.ts";
import { hotScore, sortByMode } from "./ranking.ts";

function mk(overrides = {}) {
  return {
    record: {
      author: "a".repeat(64),
      createdAt: 1_000,
      endBlock: null,
      stage: "live",
      ...(overrides.record ?? {}),
    },
    receipts: overrides.receipts ?? [],
  };
}

// ---- hot ranking (shared with the feed) ----

test("hot ranking lifts weighted scores and sinks older items", () => {
  const fresh = { score: 10, createdAt: 1_700_100_000 };
  const old = { score: 10, createdAt: 1_600_000_000 };
  assert.ok(
    hotScore(fresh.score, fresh.createdAt) > hotScore(old.score, old.createdAt),
  );
  const sorted = sortByMode(
    [old, fresh],
    "hot",
    (i) => i.score,
    (i) => i.createdAt,
  );
  assert.equal(sorted[0], fresh);
});

// ---- closing soon ----

test("closing soon keeps auctions inside the window and sorts by soonest end", () => {
  const head = 1_000;
  const near = mk({ record: { endBlock: head + 100 } });
  const far = mk({ record: { endBlock: head + CLOSING_SOON_BLOCKS + 1 } });
  const sooner = mk({ record: { endBlock: head + 50 } });
  const sorted = closingSoonLaunches([near, far, sooner], head);
  assert.deepEqual(sorted, [sooner, near]);
});

test("closing soon excludes ended, settled and unknown-head cases", () => {
  const head = 1_000;
  const ended = mk({ record: { endBlock: head } });
  const negative = mk({ record: { endBlock: head - 5 } });
  const settled = mk({
    record: { endBlock: head + 10 },
    receipts: [{ table: "graduate" }],
  });
  const draft = mk({ record: { endBlock: head + 10, stage: "draft" } });
  assert.deepEqual(
    closingSoonLaunches([ended, negative, settled, draft], head),
    [],
  );
  // A chain head that could not be read is null — and nothing is guessed.
  assert.deepEqual(
    closingSoonLaunches([mk({ record: { endBlock: head + 10 } })], null),
    [],
  );
});

// ---- graduated ----

test("graduated defaults to the receipt-proven rule", () => {
  const byReceipt = mk({ receipts: [{ table: "graduate" }] });
  const byStage = mk({ record: { stage: "graduated" } });
  const live = mk({});
  assert.equal(receiptProvenGraduated(byReceipt), true);
  assert.equal(receiptProvenGraduated(byStage), true);
  assert.equal(receiptProvenGraduated(live), false);
  const out = graduatedLaunches([live, byStage, byReceipt]);
  assert.equal(out.length, 2);
});

test("graduated hands the caller's chain read (isGraduated) through the seam", () => {
  const a = mk({ record: { createdAt: 5 } });
  const b = mk({ record: { createdAt: 9 } });
  // The injected read — not the relay record — decides.
  const out = graduatedLaunches([a, b], (launch) => launch === b);
  assert.deepEqual(out, [b]);
  // Newest graduation first.
  const out2 = graduatedLaunches([a, b], () => true);
  assert.deepEqual(out2, [b, a]);
});
