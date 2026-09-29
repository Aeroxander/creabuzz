// Budget subject + limit contract, pinned against the relay's ingest rule
// (crates/buzz-relay/src/handlers/budget_enforcement.rs `budget_content_error`):
// `subject` is a 64-hex agent pubkey or "*"; `window` is one of four values.
// Run with: node --import ./test-loader.mjs --experimental-strip-types --test src/features/org/lib/budgetForm.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  BUDGET_LIMIT_FIELDS,
  COMMUNITY_DEFAULT_LABEL,
  buildBudgetSubjectOptions,
  buildOrgBudgetContent,
  budgetLimitSummary,
  budgetSubjectError,
  budgetSubjectLabel,
  canOfferCommunityDefault,
  describeBudgetLimits,
  isBudgetSubject,
  isLimitFieldValid,
  normalizeBudgetSubject,
  parseLimitField,
} from "./budgetForm.ts";
import { eventToOrgBudget } from "../orgModels.ts";

const AGENT_A = "a".repeat(64);
const AGENT_B = "b".repeat(64);

/** Port of the relay's `budget_content_error` (the acceptance oracle). */
function relayRejects(content) {
  const subject = content.subject;
  if (typeof subject !== "string") return "no subject";
  const isHex = /^[0-9a-fA-F]{64}$/.test(subject);
  if (!isHex && subject !== "*") return "subject must be 64-hex or *";
  if (!["epoch", "day", "week", "month"].includes(content.window)) {
    return "bad window";
  }
  return null;
}

describe("budget subject validation", () => {
  it("accepts exactly a 64-hex pubkey or the community default", () => {
    assert.equal(isBudgetSubject(AGENT_A), true);
    assert.equal(isBudgetSubject(AGENT_A.toUpperCase()), true);
    assert.equal(isBudgetSubject("*"), true);
    for (const bad of [
      "",
      "ops-agent", // an org node d-tag
      "eng",
      "a".repeat(63),
      "a".repeat(65),
      "z".repeat(64),
      "**",
      " * ",
    ]) {
      assert.equal(isBudgetSubject(bad), false, JSON.stringify(bad));
    }
  });

  it("explains a rejected subject and names the node-id mistake", () => {
    assert.match(budgetSubjectError(null), /Pick the agent/);
    assert.match(budgetSubjectError("ops-agent"), /org node id/);
    assert.equal(budgetSubjectError(AGENT_A), null);
    assert.equal(budgetSubjectError("*"), null);
    assert.equal(budgetSubjectError(`  ${AGENT_A} `), null);
  });

  it("normalizes case for pubkeys and leaves the default alone", () => {
    assert.equal(normalizeBudgetSubject(` ${AGENT_A.toUpperCase()} `), AGENT_A);
    assert.equal(normalizeBudgetSubject("*"), "*");
  });
});

describe("buildOrgBudgetContent (the publish path)", () => {
  it("publishes content the relay accepts for an agent and for the default", () => {
    for (const subject of [AGENT_A.toUpperCase(), "*"]) {
      const content = JSON.parse(
        buildOrgBudgetContent({
          subject,
          window: "month",
          limits: { runs: 5 },
        }),
      );
      assert.equal(relayRejects(content), null);
      assert.equal(content.onExceed, "require-approval");
      assert.equal(content.v, 1);
    }
  });

  it("throws before signing when the subject is an org node d-tag", () => {
    for (const subject of ["ops-agent", "", "founder"]) {
      assert.throws(
        () =>
          buildOrgBudgetContent({
            subject,
            window: "day",
            limits: { runs: 1 },
          }),
        /Pick the agent|org node id/,
      );
    }
  });

  it("maps every limit to its wire key", () => {
    const content = JSON.parse(
      buildOrgBudgetContent({
        subject: AGENT_A,
        window: "week",
        limits: {
          runs: 1,
          messages: 2,
          llmCalls: 3,
          taskCreate: 4,
          taskApprove: 5,
          proposals: 6,
          spend: 700,
        },
      }),
    );
    assert.deepEqual(content.limits, {
      spend: { amount: 700, unit: "usd-cents" },
      runs: 1,
      tasks: { create: 4, approve: 5 },
      governance: { proposal: 6 },
      messages: 2,
      llmCalls: 3,
    });
  });

  it("keeps a zero limit (0 is a real ceiling) and omits unset ones", () => {
    const content = JSON.parse(
      buildOrgBudgetContent({
        subject: AGENT_A,
        window: "day",
        limits: { runs: 0, messages: undefined },
      }),
    );
    assert.deepEqual(content.limits, { runs: 0 });
  });

  it("is what hooks.ts publishes (the production seam)", () => {
    const hooks = readFileSync(new URL("../hooks.ts", import.meta.url), "utf8");
    const publish = hooks.slice(
      hooks.indexOf("async function publishOrgBudgetEvent"),
      hooks.indexOf("async function publishOrgBudgetDeletion"),
    );
    assert.match(publish, /buildOrgBudgetContent\(input\)/);
    assert.doesNotMatch(publish, /JSON\.stringify/);
  });

  it("the form and wizard offer agents, never org node d-tags", () => {
    for (const file of ["../ui/OrgBudgetForm.tsx", "../ui/OrgWizard.tsx"]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      assert.match(source, /useBudgetSubjectOptions\(/, file);
      assert.doesNotMatch(source, /id: node\.dtag/, file);
      assert.doesNotMatch(source, /subject: subjectDtag/, file);
    }
  });
});

describe("buildBudgetSubjectOptions", () => {
  const nodes = [
    { name: "Ops Agent", agentSeats: [AGENT_B], revoked: false },
    {
      name: "Research",
      agentSeats: [AGENT_A.toUpperCase(), "not-a-key", AGENT_B],
      revoked: false,
    },
    { name: "Retired", agentSeats: ["c".repeat(64)], revoked: true },
    { name: "Human role", agentSeats: [], revoked: false },
  ];
  const resolveName = (pubkey, seats) =>
    pubkey === AGENT_A ? "Ada" : (seats[0] ?? pubkey);

  it("lists each seated agent once by pubkey, labelled with its seats", () => {
    const options = buildBudgetSubjectOptions(nodes, {
      includeCommunityDefault: false,
      resolveName,
    });
    assert.deepEqual(
      options.map((o) => [o.id, o.label, o.sub]),
      [
        [AGENT_A, "Ada", "Seat: Research"],
        [AGENT_B, "Ops Agent", "Seat: Ops Agent, Research"],
      ],
    );
    for (const option of options)
      assert.equal(isBudgetSubject(option.id), true);
  });

  it("adds the community default first, only when asked", () => {
    const withDefault = buildBudgetSubjectOptions(nodes, {
      includeCommunityDefault: true,
      resolveName,
    });
    assert.equal(withDefault[0].id, "*");
    assert.equal(withDefault[0].label, COMMUNITY_DEFAULT_LABEL);
    assert.equal(withDefault.length, 3);
    assert.equal(
      buildBudgetSubjectOptions([], {
        includeCommunityDefault: false,
        resolveName,
      }).length,
      0,
    );
  });
});

describe("canOfferCommunityDefault", () => {
  const lookup = (snapshotFound, role) => ({
    snapshotFound,
    membership: role ? { role } : null,
  });
  it("gates on the role when the membership snapshot is knowable", () => {
    assert.equal(canOfferCommunityDefault(lookup(true, "owner")), true);
    assert.equal(canOfferCommunityDefault(lookup(true, "admin")), true);
    assert.equal(canOfferCommunityDefault(lookup(true, "member")), false);
    assert.equal(canOfferCommunityDefault(lookup(true, null)), false);
  });
  it("still offers it when the role cannot be known (relay decides)", () => {
    assert.equal(canOfferCommunityDefault(undefined), true);
    assert.equal(canOfferCommunityDefault(lookup(false, null)), true);
  });
});

describe("honest enforcement labels (NIP-ORG advisory rule)", () => {
  const budget = (limits, onchain) => ({ limits, window: "month", onchain });

  it("labels relay-counted limits enforced and unobservable ones advisory", () => {
    const rows = describeBudgetLimits(
      budget({
        runs: 50,
        messages: 9,
        llmCalls: 8,
        tasks: { create: 7, approve: 1 },
        governance: { proposal: 2 },
        spend: { amount: 100, unit: "usd-cents" },
      }),
    );
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    for (const key of [
      "runs",
      "messages",
      "llmCalls",
      "tasks.create",
      "governance.proposal",
    ]) {
      assert.equal(byKey[key].enforcement, "relay", key);
      assert.equal(byKey[key].badge, "Enforced by the relay", key);
    }
    for (const key of ["tasks.approve", "spend"]) {
      assert.equal(byKey[key].enforcement, "advisory", key);
      assert.equal(byKey[key].badge, "Advisory", key);
    }
  });

  it("calls spend enforced only when an onchain allowance is bound", () => {
    const rows = describeBudgetLimits(
      budget(
        { spend: { amount: 100, unit: "usd-cents" } },
        { chain: "eip155:8453", contract: "0x1", subject: AGENT_A },
      ),
    );
    assert.equal(rows[0].enforcement, "onchain");
    assert.equal(rows[0].badge, "Enforced onchain");
  });

  it("every form field declares its enforcement, advisory ones say why", () => {
    const advisory = BUDGET_LIMIT_FIELDS.filter(
      (f) => f.enforcement === "advisory",
    );
    assert.deepEqual(advisory.map((f) => f.key).sort(), [
      "spend",
      "taskApprove",
    ]);
    for (const field of advisory) assert.ok(field.note, field.key);
    assert.deepEqual(
      BUDGET_LIMIT_FIELDS.filter((f) => f.enforcement === "relay")
        .map((f) => f.key)
        .sort(),
      ["llmCalls", "messages", "proposals", "runs", "taskCreate"],
    );
  });

  it("summarises for the feed, keeping zero limits", () => {
    assert.equal(budgetLimitSummary(budget({})), "no limits");
    assert.equal(
      budgetLimitSummary(budget({ runs: 0, tasks: { create: 3 } })),
      "0 runs/month, 3 tasks created/month",
    );
  });

  it("round-trips published limits through the read model", () => {
    const content = buildOrgBudgetContent({
      subject: "*",
      window: "day",
      limits: { messages: 4, llmCalls: 5, proposals: 1 },
    });
    const parsed = eventToOrgBudget({
      id: "e1",
      pubkey: AGENT_A,
      created_at: 1,
      kind: 37012,
      tags: [["d", "default"]],
      content,
      sig: "s",
    });
    assert.equal(parsed.subject, "*");
    assert.deepEqual(
      describeBudgetLimits(parsed).map((r) => r.key),
      ["messages", "llmCalls", "governance.proposal"],
    );
  });
});

describe("subject display and field parsing", () => {
  it("names the community default without touching the resolver", () => {
    assert.equal(
      budgetSubjectLabel("*", () => {
        throw new Error("must not resolve");
      }),
      COMMUNITY_DEFAULT_LABEL,
    );
    assert.equal(
      budgetSubjectLabel(AGENT_A, () => "Ada"),
      "Ada",
    );
  });

  it("parses whole non-negative numbers and flags the rest", () => {
    assert.equal(parseLimitField(""), undefined);
    assert.equal(parseLimitField(" 12 "), 12);
    assert.equal(parseLimitField("0"), 0);
    for (const bad of ["-1", "1.5", "abc", "1e400"]) {
      assert.equal(parseLimitField(bad), undefined, bad);
      assert.equal(isLimitFieldValid(bad), false, bad);
    }
    assert.equal(isLimitFieldValid(""), true);
  });
});
