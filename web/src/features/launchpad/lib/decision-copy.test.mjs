import assert from "node:assert/strict";
import { test } from "node:test";

import {
  closeBudgetDecision,
  DecisionInputError,
  freezeClaimDecision,
  projectDecision,
  resolveFrozenClaimDecision,
} from "@creaton/core/launchpad/daoActions.ts";

const MANDATE = `0x${"22".repeat(20)}`;
const CLAIM = `0x${"77".repeat(32)}`;

test("closing a Shares-only budget says nothing about money, and a budget with money keeps its money lines", () => {
  const sharesOnly = closeBudgetDecision({
    mandate: MANDATE,
    sharesOnly: true,
  });
  const text = sharesOnly.lines.join(" ");
  assert.doesNotMatch(text, /money|paid/i);
  assert.match(text, /No more Shares can be awarded/);
  // The same call either way: only the words differ.
  assert.equal(sharesOnly.data, closeBudgetDecision({ mandate: MANDATE }).data);
  assert.match(
    closeBudgetDecision({ mandate: MANDATE }).lines.join(" "),
    /Money not set aside/,
  );
});

test("a freeze promises no release it cannot give: a later vote can only reject it", () => {
  const lines = freezeClaimDecision({
    mandate: MANDATE,
    claimId: CLAIM,
  }).lines.join(" ");
  assert.match(lines, /reject it for good/);
  assert.doesNotMatch(lines, /unwind|let it go/i);
  assert.match(
    resolveFrozenClaimDecision({ mandate: MANDATE, claimId: CLAIM }).title,
    /^Reject the frozen submission/,
  );
});

test("a work area with no usable name is refused naming the work area, in characters", () => {
  assert.throws(
    () =>
      projectDecision({
        mandate: MANDATE,
        manager: `0x${"33".repeat(20)}`,
        id: "",
        checkText: "done",
        currencyDecimals: 6,
        amount: 0n,
        shares: 1n,
        expiresAt: 2_000_000_000,
        now: 1_000_000_000,
      }),
    (error) =>
      error instanceof DecisionInputError &&
      /work area/.test(error.message) &&
      /32 characters/.test(error.message),
  );
});
