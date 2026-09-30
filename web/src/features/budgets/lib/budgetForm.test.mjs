// Web budget authoring contract: the same kind:37012 content shape the server
// accepts, and the honest enforced-vs-advisory labels (a spend limit without
// an onchain binding must read advisory, never enforced).
// Run with: node --experimental-strip-types --test src/features/budgets/lib/budgetForm.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  BUDGET_LIMIT_FIELDS,
  ENFORCEMENT_LABEL,
  buildOrgBudgetContent,
  budgetSubjectError,
  describeBudgetLimits,
  isBudgetSubject,
  isLimitFieldValid,
  normalizeBudgetSubject,
  parseLimitField,
} from "./budgetForm.ts";

const AGENT_A = "a".repeat(64);

describe("budget subjects", () => {
  it("accepts a 64-hex agent pubkey or the community default", () => {
    assert.ok(isBudgetSubject(AGENT_A));
    assert.ok(isBudgetSubject("*"));
    assert.ok(!isBudgetSubject("team-engineering"));
    assert.equal(normalizeBudgetSubject(` ${AGENT_A.toUpperCase()} `), AGENT_A);
  });

  it("rejects an org node id with a readable reason", () => {
    assert.match(budgetSubjectError("team-x") ?? "", /64-hex public key/);
    assert.equal(budgetSubjectError(AGENT_A), null);
  });
});

describe("kind:37012 content", () => {
  it("carries the dollar-denominated LLM budget as llmCostCents", () => {
    const content = JSON.parse(
      buildOrgBudgetContent({
        subject: AGENT_A,
        window: "week",
        limits: { llmCostCents: 500, llmCalls: 20 },
      }),
    );
    assert.deepEqual(content.limits, { llmCalls: 20, llmCostCents: 500 });
    assert.equal(content.onExceed, "require-approval");
    assert.equal(content.window, "week");
    assert.equal(content.subject, AGENT_A);
  });
});

describe("honest enforcement labels (advisory rule)", () => {
  it("labels server-counted limits enforced and unobservable ones advisory", () => {
    const rows = describeBudgetLimits({
      limits: {
        runs: 10,
        messages: 20,
        llmCalls: 5,
        llmCostCents: 500,
        tasks: { create: 3, approve: 2 },
        spend: { amount: 100, unit: "usd-cents" },
      },
      window: "week",
    });
    const byKey = new Map(rows.map((row) => [row.key, row]));
    for (const key of [
      "runs",
      "messages",
      "llmCalls",
      "llmCostCents",
      "tasks.create",
    ]) {
      assert.equal(byKey.get(key)?.enforcement, "relay", key);
      assert.equal(byKey.get(key)?.badge, "Enforced by the relay", key);
    }
    for (const key of ["tasks.approve", "spend"]) {
      assert.equal(byKey.get(key)?.enforcement, "advisory", key);
      assert.equal(byKey.get(key)?.badge, "Advisory", key);
    }
  });

  it("calls spend enforced only when an onchain allowance is bound", () => {
    const rows = describeBudgetLimits({
      limits: { spend: { amount: 100, unit: "usd-cents" } },
      window: "week",
      onchain: { contract: "0xabc", chain: "eip155:1" },
    });
    assert.equal(rows[0].enforcement, "onchain");
    assert.equal(rows[0].badge, "Enforced onchain");
  });

  it("every form field declares its enforcement; advisory ones say why", () => {
    const advisory = BUDGET_LIMIT_FIELDS.filter(
      (f) => f.enforcement === "advisory",
    );
    assert.deepEqual(advisory.map((f) => f.key).sort(), [
      "spend",
      "taskApprove",
    ]);
    for (const field of advisory) assert.ok(field.note, field.key);
    for (const field of BUDGET_LIMIT_FIELDS) {
      assert.equal(
        field.enforcement === "advisory"
          ? ENFORCEMENT_LABEL.advisory
          : ENFORCEMENT_LABEL.relay,
        field.enforcement === "advisory" ? "Advisory" : "Enforced by the relay",
        field.key,
      );
    }
  });
});

describe("limit fields", () => {
  it("parses non-negative whole numbers and rejects junk", () => {
    assert.equal(parseLimitField(" 12 "), 12);
    assert.equal(parseLimitField(""), undefined);
    assert.equal(parseLimitField("-1"), undefined);
    assert.equal(parseLimitField("1.5"), undefined);
    assert.ok(isLimitFieldValid(""));
    assert.ok(isLimitFieldValid("3"));
    assert.ok(!isLimitFieldValid("x"));
  });
});
