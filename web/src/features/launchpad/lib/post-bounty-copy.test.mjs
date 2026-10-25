import assert from "node:assert/strict";
import { test } from "node:test";

import {
  claimShareLine,
  claimsInOrder,
  evidenceLink,
  postBountyLine,
} from "./post-bounty-copy.ts";

const DEV = "0x0000000000000000000000000000000000000de7";
const words = {
  money: (units) => `${units} USDC`,
  date: (seconds) => `day ${seconds}`,
  who: (address) => (address === DEV ? "Dev" : address),
};
const bounty = {
  creator: DEV,
  openedAt: 0,
  deadline: 1_000,
  refundsFrom: 3_000,
  post: `0x${"00".repeat(32)}`,
  wordsHash: `0x${"00".repeat(32)}`,
  total: 100n,
  refunded: 0n,
  counting: 100n,
  claimCount: 1,
  runClaim: 0,
  runSince: 0,
  paidClaim: 0,
};
const claim = (over = {}) => ({
  claim: 1,
  claimant: DEV,
  evidence: "https://example.com/v",
  open: true,
  backing: 0n,
  ...over,
});

test("every stage has its own sentence, naming who and when", () => {
  const claims = [claim()];
  const cases = [
    [{ kind: "paid", claim: 1 }, "Paid 100 USDC to Dev."],
    [
      { kind: "refunds" },
      "No work kept a majority in time. Everyone can take their money back.",
    ],
    [
      { kind: "payable", claim: 1 },
      "Dev's work kept its backing. Anyone can pay it now.",
    ],
    [
      { kind: "agreeing", claim: 1, payableAt: 900 },
      "Most of the money backs Dev's work. If it stays that way, it is paid on day 900. No new money until then.",
    ],
    [
      { kind: "holding", claim: 1, payableAt: 900 },
      "Agreed. Dev is paid on day 900 unless the backing drops.",
    ],
    [
      { kind: "open" },
      "Takes money and work until day 1000. The work most of the money backs for nine days is paid.",
    ],
  ];
  for (const [stage, line] of cases) {
    assert.equal(
      postBountyLine(stage, bounty, claims, words),
      line,
      stage.kind,
    );
  }
  assert.equal(
    postBountyLine({ kind: "payable", claim: 9 }, bounty, claims, words),
    "Someone's work kept its backing. Anyone can pay it now.",
  );
});

test("a claim's share is whole percent of the counting money, and a withdrawn one says so", () => {
  assert.equal(
    claimShareLine(claim({ backing: 51n }), 100n),
    "51% of the money that counts backs this",
  );
  assert.equal(
    claimShareLine(claim({ backing: 1n }), 0n),
    "0% of the money that counts backs this",
  );
  assert.equal(claimShareLine(claim({ open: false }), 100n), "Withdrawn");
});

test("only a plain web address becomes a link", () => {
  assert.equal(evidenceLink("https://example.com/v"), "https://example.com/v");
  assert.equal(evidenceLink(" http://a.b/c "), "http://a.b/c");
  assert.equal(evidenceLink("javascript:alert(1)"), null);
  assert.equal(evidenceLink("see https://example.com"), null);
  assert.equal(evidenceLink("a video of the lane"), null);
});

test("claims come most backed first, then newest, withdrawn last", () => {
  const ordered = claimsInOrder([
    claim({ claim: 1, backing: 10n }),
    claim({ claim: 2, open: false, backing: 90n }),
    claim({ claim: 3, backing: 10n }),
    claim({ claim: 4, backing: 50n }),
  ]);
  assert.deepEqual(
    ordered.map((c) => c.claim),
    [4, 3, 1, 2],
  );
});
