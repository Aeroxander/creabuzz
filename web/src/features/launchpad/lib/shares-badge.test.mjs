import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { sharesBadge } from "./shares-badge.ts";

const E18 = 10n ** 18n;

describe("sharesBadge", () => {
  it("is the share of the supply, to two decimals without trailing zeros", () => {
    assert.equal(sharesBadge(50n * E18, 100n * E18), "50% of Shares");
    assert.equal(sharesBadge(21n * E18, 1000n * E18), "2.1% of Shares");
    assert.equal(sharesBadge(123n * E18, 10_000n * E18), "1.23% of Shares");
    assert.equal(sharesBadge(100n * E18, 100n * E18), "100% of Shares");
  });

  it("says so when it is less than 0.01%", () => {
    assert.equal(sharesBadge(1n, 100n * E18), "<0.01% of Shares");
  });

  it("shows nothing for no Shares, an unreadable number, or numbers that cannot be right", () => {
    assert.equal(sharesBadge(0n, 100n), null);
    assert.equal(sharesBadge(null, 100n), null);
    assert.equal(sharesBadge(5n, null), null);
    assert.equal(sharesBadge(5n, 0n), null);
    assert.equal(sharesBadge(11n, 10n), null);
  });
});
