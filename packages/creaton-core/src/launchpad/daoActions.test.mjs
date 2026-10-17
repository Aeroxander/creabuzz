import assert from "node:assert/strict";
import { test } from "node:test";

import {
  awardDecision,
  closeBudgetDecision,
  collectFeesDecision,
  freezeClaimDecision,
  resolveFrozenClaimDecision,
  slashReviewerDecision,
  DecisionInputError,
  decodeBatch,
  encodeBatch,
  describeAction,
  formatUnits,
  mandateDecision,
  parseUnits,
  payDecision,
  projectDecision,
} from "./daoActions.ts";

const WAD = 10n ** 18n;
const DAO = "0x00000000000000000000000000000000000000d0";
const FACTORY = "0x00000000000000000000000000000000000000fa";
const CUR = "0x00000000000000000000000000000000000000cc";
const MANDATE = "0x00000000000000000000000000000000000000ee";
const MANAGER = "0x00000000000000000000000000000000000000aa";
const R1 = "0x0000000000000000000000000000000000000001";
const R2 = "0x0000000000000000000000000000000000000002";
const R3 = "0x0000000000000000000000000000000000000003";
const AMM = "0x00000000000000000000000000000000000000a1";
const SHARES = "0x00000000000000000000000000000000000000b1";
const CLAIM =
  "0x7777777777777777777777777777777777777777777777777777777777777777";
const EXP = 1800000000;
const NOW = 1_700_000_000;

const mandate = (over = {}) => ({
  dao: DAO,
  factory: FACTORY,
  currency: CUR,
  currencyDecimals: 6,
  budget: 0n,
  cap: 0n,
  shareBudget: 100n * WAD,
  shareCap: 40n * WAD,
  expiresAt: EXP,
  reviewers: [R1, R2, R3],
  quorum: 2,
  reviewerBond: 0n,
  now: NOW,
  ...over,
});
const refused = (fn, field) =>
  assert.throws(
    fn,
    (e) => e instanceof DecisionInputError && e.field === field,
    `expected a ${field} refusal`,
  );

// Every golden below is `cast calldata` for the same inputs.
test("a Shares-only work budget is one call to the factory, as cast encodes it", () => {
  const d = mandateDecision(mandate());
  assert.equal(d.to, FACTORY);
  assert.equal(d.lane, "unrestricted");
  assert.equal(
    d.data,
    "0xd7810bbc00000000000000000000000000000000000000000000000000000000000000cc000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000056bc75e2d631000000000000000000000000000000000000000000000000000022b1c8c1227a00000000000000000000000000000000000000000000000000000000000006b49d20000000000000000000000000000000000000000000000000000000000000001400000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000003",
  );
});

test("a work budget with money approves the factory first and clears the approval after", () => {
  const d = mandateDecision(
    mandate({ budget: 5_000_000_000n, cap: 1_000_000_000n }),
  );
  assert.equal(d.to, DAO);
  assert.equal(
    d.data,
    "0x11c76fd9000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000030000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000000014000000000000000000000000000000000000000000000000000000000000003a000000000000000000000000000000000000000000000000000000000000000cc000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000044095ea7b300000000000000000000000000000000000000000000000000000000000000fa000000000000000000000000000000000000000000000000000000012a05f2000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000fa0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000001c4d7810bbc00000000000000000000000000000000000000000000000000000000000000cc000000000000000000000000000000000000000000000000000000012a05f200000000000000000000000000000000000000000000000000000000003b9aca000000000000000000000000000000000000000000000000056bc75e2d631000000000000000000000000000000000000000000000000000022b1c8c1227a00000000000000000000000000000000000000000000000000000000000006b49d200000000000000000000000000000000000000000000000000000000000000014000000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000030000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000030000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000cc000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000044095ea7b300000000000000000000000000000000000000000000000000000000000000fa000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
  );
  const calls = decodeBatch(d.data);
  assert.equal(calls.length, 3);
  assert.deepEqual(
    calls.map((c) => c.to),
    [CUR, FACTORY, CUR],
  );
});

test("a work budget that could not be created is refused with the field to fix", () => {
  refused(
    () => mandateDecision(mandate({ shareBudget: 0n, shareCap: 0n })),
    "budget",
  );
  refused(() => mandateDecision(mandate({ cap: 1n })), "cap");
  refused(() => mandateDecision(mandate({ budget: 5n, cap: 6n })), "cap");
  refused(() => mandateDecision(mandate({ shareCap: 0n })), "shareCap");
  refused(() => mandateDecision(mandate({ shareCap: 101n * WAD })), "shareCap");
  refused(() => mandateDecision(mandate({ expiresAt: NOW })), "expiresAt");
  refused(() => mandateDecision(mandate({ reviewers: [] })), "reviewers");
  refused(() => mandateDecision(mandate({ reviewers: [R1, R1] })), "reviewers");
  refused(() => mandateDecision(mandate({ reviewers: ["nope"] })), "reviewers");
  refused(() => mandateDecision(mandate({ quorum: 0 })), "quorum");
  refused(() => mandateDecision(mandate({ quorum: 4 })), "quorum");
  refused(() => mandateDecision(mandate({ factory: "0x12" })), "factory");
  refused(
    () => mandateDecision(mandate({ shareBudget: 1n << 128n, shareCap: 1n })),
    "shareBudget",
  );
});

test("a project approval is a call to its work budget, with the check hashed from its words", () => {
  const d = projectDecision({
    mandate: MANDATE,
    id: "docs",
    manager: MANAGER,
    amount: 0n,
    shares: 40n * WAD,
    expiresAt: EXP,
    checkText: "  docs merged and reviewed  ",
    now: NOW,
    currencyDecimals: 6,
  });
  assert.equal(d.to, MANDATE);
  assert.equal(d.lane, "bounded");
  assert.equal(
    d.data,
    "0x7eb44f4d646f63730000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000aa00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000022b1c8c1227a00000000000000000000000000000000000000000000000000000000000006b49d200e8164af4b3d1186a31c4eecb6012657bf68042eb1ce8130d9d766a096b0418ff",
  );
  assert.match(d.title, /“docs”/);
  refused(
    () => projectDecision({ ...baseProject(), checkText: " " }),
    "checkText",
  );
  refused(
    () => projectDecision({ ...baseProject(), amount: 0n, shares: 0n }),
    "amount",
  );
  refused(() => projectDecision({ ...baseProject(), id: "" }), "id");
  refused(
    () => projectDecision({ ...baseProject(), expiresAt: NOW - 1 }),
    "expiresAt",
  );
  refused(() => projectDecision({ ...baseProject(), manager: "x" }), "manager");
});

function baseProject() {
  return {
    mandate: MANDATE,
    id: "docs",
    manager: MANAGER,
    amount: 0n,
    shares: 40n * WAD,
    expiresAt: EXP,
    checkText: "docs merged and reviewed",
    now: NOW,
    currencyDecimals: 6,
  };
}

test("an award is a call to the DAO itself, as cast encodes it", () => {
  const d = awardDecision({
    dao: DAO,
    mandate: MANDATE,
    claimId: CLAIM,
    shares: 25n * WAD,
  });
  assert.equal(d.to, DAO);
  assert.equal(d.lane, "bounded");
  assert.equal(
    d.data,
    "0x33184aca00000000000000000000000000000000000000000000000000000000000000ee77777777777777777777777777777777777777777777777777777777777777770000000000000000000000000000000000000000000000015af1d78b58c400000000000000000000000000000000000000000000000000000000000000000000",
  );
  refused(
    () =>
      awardDecision({
        dao: DAO,
        mandate: MANDATE,
        claimId: "0x12",
        shares: 1n,
      }),
    "claimId",
  );
  refused(
    () =>
      awardDecision({ dao: DAO, mandate: MANDATE, claimId: CLAIM, shares: 0n }),
    "shares",
  );
});

test("collecting trading fees is a call to the exchange, as cast encodes it", () => {
  const d = collectFeesDecision({
    amm: AMM,
    sharesToken: SHARES,
    currency: CUR,
    currencyDecimals: 6,
    recipient: DAO,
    amount: 12_345_678n,
  });
  assert.equal(d.to, AMM);
  assert.equal(
    d.data,
    "0x5f06713d00000000000000000000000000000000000000000000000000000000000000b100000000000000000000000000000000000000000000000000000000000000cc00000000000000000000000000000000000000000000000000000000000000d00000000000000000000000000000000000000000000000000000000000bc614e",
  );
  refused(
    () =>
      collectFeesDecision({
        amm: AMM,
        sharesToken: SHARES,
        currency: CUR,
        currencyDecimals: 6,
        recipient: DAO,
        amount: 0n,
      }),
    "amount",
  );
});

test("every action this module writes is read back as what it is", () => {
  const ctx = { currencyDecimals: 6 };
  const budget = describeAction(
    mandateDecision(mandate({ budget: 5_000_000_000n, cap: 1_000_000_000n })),
    ctx,
  );
  assert.equal(budget.kind, "work-budget");
  assert.ok(
    budget.lines.some((l) =>
      l.includes("Money for work: 5,000 in all, at most 1,000 per project"),
    ),
  );
  assert.ok(
    budget.lines.some((l) =>
      l.includes("Shares for work: 100 in all, at most 40 per project"),
    ),
  );
  assert.ok(
    budget.lines.some((l) => l.startsWith("3 reviewers, 2 must agree")),
  );

  assert.equal(
    describeAction(mandateDecision(mandate()), ctx).kind,
    "work-budget",
  );
  const project = describeAction(projectDecision(baseProject()), ctx);
  assert.equal(project.kind, "project");
  assert.equal(project.title, "Approve the project “docs”");
  const award = describeAction(
    awardDecision({
      dao: DAO,
      mandate: MANDATE,
      claimId: CLAIM,
      shares: 25n * WAD,
    }),
    ctx,
  );
  assert.equal(award.kind, "award");
  assert.match(award.title, /^Award 25 Shares for the claim/);
  const fees = describeAction(
    collectFeesDecision({
      amm: AMM,
      sharesToken: SHARES,
      currency: CUR,
      currencyDecimals: 6,
      recipient: DAO,
      amount: 12_345_678n,
    }),
    ctx,
  );
  assert.equal(fees.kind, "fees");
  assert.match(fees.lines[0], /12\.34/);
});

test("anything else is said to be unknown, with where it goes, and never guessed at", () => {
  const unknown = describeAction({ to: AMM, data: "0xdeadbeef00" });
  assert.equal(unknown.kind, "unknown");
  assert.match(unknown.lines[0], new RegExp(AMM));
  const garbled = describeAction({
    to: MANDATE,
    data: "0x7eb44f4d646f6373000000000000000000000000000000000000000000",
  });
  assert.equal(garbled.kind, "unknown");
  // A batch of things it does not know is a batch, described step by step.
  const batch = describeAction({
    to: DAO,
    data: "0x11c76fd900000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000a1000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000004deadbeef00000000000000000000000000000000000000000000000000000000",
  });
  assert.equal(batch.kind, "batch");
  assert.equal(batch.lines.length, 1);
});

test("amounts are read and shown in whole units", () => {
  assert.equal(parseUnits("1.5", 6, "x", "x"), 1_500_000n);
  assert.equal(parseUnits("100", 18, "x", "x"), 100n * WAD);
  assert.throws(() => parseUnits("1.1234567", 6, "x", "x"), DecisionInputError);
  assert.throws(() => parseUnits("-1", 6, "x", "x"), DecisionInputError);
  assert.throws(() => parseUnits("", 6, "x", "x"), DecisionInputError);
  assert.equal(formatUnits(1_234_567_000_000_000_000_000n, 18), "1,234.56");
  assert.equal(formatUnits(5n * WAD, 18), "5");
  assert.equal(formatUnits(12_345_678n, 6, 4), "12.3456");
});

test("a batch that only looks like a work budget with money is described as the steps it is", () => {
  const real = mandateDecision(
    mandate({ budget: 5_000_000_000n, cap: 1_000_000_000n }),
  );
  const calls = decodeBatch(real.data);
  const send = (to, data) => ({ to, value: 0n, data });
  const tamper = (index, change) =>
    describeAction({
      to: DAO,
      data: encodeBatch(calls.map((c, i) => (i === index ? change(c) : c))),
    });
  // The approval goes to someone else.
  const other = (c) =>
    send(c.to, c.data.replace(FACTORY.slice(2), R1.slice(2)));
  assert.equal(tamper(0, other).kind, "batch");
  // The approval is for more than the budget.
  const more = (c) =>
    send(
      c.to,
      `${c.data.slice(0, -64)}${(2n ** 200n).toString(16).padStart(64, "0")}`,
    );
  assert.equal(tamper(0, more).kind, "batch");
  // The approval is left standing.
  const left = (c) =>
    send(c.to, `${c.data.slice(0, -64)}${1n.toString(16).padStart(64, "0")}`);
  assert.equal(tamper(2, left).kind, "batch");
  // The untouched batch is still the budget it says it is.
  assert.equal(
    describeAction(real, { currencyDecimals: 6 }).kind,
    "work-budget",
  );
});

test("an action aimed anywhere but where a real one is aimed is never described as that action", () => {
  const OTHER = "0x00000000000000000000000000000000000000f0";
  const award = awardDecision({
    dao: DAO,
    mandate: MANDATE,
    claimId: CLAIM,
    shares: 25n * WAD,
  });
  assert.equal(describeAction(award, { dao: DAO }).kind, "award");
  assert.equal(
    describeAction({ ...award, to: OTHER }, { dao: DAO }).kind,
    "unknown",
  );

  const budget = mandateDecision(mandate());
  assert.equal(
    describeAction(budget, { factory: FACTORY }).kind,
    "work-budget",
  );
  assert.equal(
    describeAction({ ...budget, to: OTHER }, { factory: FACTORY }).kind,
    "unknown",
  );

  const project = projectDecision(baseProject());
  assert.equal(
    describeAction(project, { mandates: [MANDATE] }).kind,
    "project",
  );
  assert.equal(
    describeAction({ ...project, to: OTHER }, { mandates: [MANDATE] }).kind,
    "unknown",
  );

  const fees = collectFeesDecision({
    amm: AMM,
    sharesToken: SHARES,
    currency: CUR,
    currencyDecimals: 6,
    recipient: DAO,
    amount: 5n,
  });
  assert.equal(describeAction(fees, { amm: AMM }).kind, "fees");
  assert.equal(
    describeAction({ ...fees, to: OTHER }, { amm: AMM }).kind,
    "unknown",
  );
});

test("paying from the treasury is a transfer of the sale currency, as cast encodes, and is described only as such", () => {
  const input = {
    currency: CUR,
    currencyDecimals: 6,
    currencySymbol: "USDC",
    recipient: "0x00000000000000000000000000000000000000ab",
    amount: 1_500_000n,
  };
  const d = payDecision(input);
  assert.equal(d.to, CUR);
  assert.equal(
    d.data,
    "0xa9059cbb00000000000000000000000000000000000000000000000000000000000000ab000000000000000000000000000000000000000000000000000000000016e360",
  );
  assert.equal(d.title, "Pay 1.5 USDC from the treasury");
  const ctx = { currency: CUR, currencyDecimals: 6, currencySymbol: "USDC" };
  const described = describeAction(d, ctx);
  assert.equal(described.kind, "payment");
  assert.equal(described.title, "Pay 1.5 USDC from the treasury");
  assert.deepEqual(described.lines, [
    "To 0x00000000000000000000000000000000000000ab",
  ]);
  // A transfer of some other token, or with no currency known, is not described as a payment.
  assert.equal(describeAction({ ...d, to: AMM }, ctx).kind, "unknown");
  assert.equal(describeAction(d, {}).kind, "unknown");
  refused(() => payDecision({ ...input, amount: 0n }), "amount");
  refused(() => payDecision({ ...input, recipient: "nope" }), "recipient");
  refused(
    () =>
      payDecision({
        ...input,
        recipient: "0x0000000000000000000000000000000000000000",
      }),
    "recipient",
  );
});

test("a reviewer bond rides in the same call, as cast encodes it, and the vote says so", () => {
  const ctx = { currencyDecimals: 6, factory: FACTORY, mandates: [MANDATE] };
  const d = mandateDecision(mandate({ reviewerBond: 50_000_000n }));
  // The summary shown beside the vote says it too, before anyone opens it.
  assert.ok(
    d.lines.some((l) => /bond of 50/.test(l)),
    d.lines.join(" | "),
  );
  assert.ok(
    mandateDecision(mandate()).lines.includes("Reviewers post no bond"),
  );
  assert.equal(
    d.data,
    "0xd7810bbc00000000000000000000000000000000000000000000000000000000000000cc000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000056bc75e2d631000000000000000000000000000000000000000000000000000022b1c8c1227a00000000000000000000000000000000000000000000000000000000000006b49d200000000000000000000000000000000000000000000000000000000000000014000000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000002faf08000000000000000000000000000000000000000000000000000000000000000cc0000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000003",
  );
  const bonded = describeAction(d, ctx);
  assert.ok(
    bonded.lines.some((l) => /bond of 50/.test(l)),
    bonded.lines.join(" | "),
  );
  const none = describeAction(mandateDecision(mandate()), ctx);
  assert.ok(none.lines.includes("Reviewers post no bond"));
});

test("a bond that cannot be stored or is negative is refused", () => {
  refused(
    () => mandateDecision(mandate({ reviewerBond: 1n << 128n })),
    "reviewerBond",
  );
  refused(
    () => mandateDecision(mandate({ reviewerBond: -1n })),
    "reviewerBond",
  );
});

test("a bond can be paid in the project's own token or any other, as cast encodes it, and the vote says which", () => {
  const ctx = {
    currencyDecimals: 6,
    factory: FACTORY,
    mandates: [MANDATE],
    projectToken: SHARES,
  };
  const own = mandateDecision(
    mandate({
      reviewerBond: 50n * WAD,
      reviewerBondToken: SHARES,
      reviewerBondDecimals: 18,
      reviewerBondLabel: "of the project's own token",
    }),
  );
  assert.equal(
    own.data,
    "0xd7810bbc00000000000000000000000000000000000000000000000000000000000000cc000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000056bc75e2d631000000000000000000000000000000000000000000000000000022b1c8c1227a00000000000000000000000000000000000000000000000000000000000006b49d20000000000000000000000000000000000000000000000000000000000000001400000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000002b5e3af16b188000000000000000000000000000000000000000000000000000000000000000000b10000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000003",
  );
  assert.ok(
    own.lines.some((l) => /bond of 50 of the project's own token/.test(l)),
    own.lines.join(" | "),
  );
  // Read back without being told the label: the call itself says whose token it is.
  const described = describeAction(own, ctx);
  assert.equal(described.kind, "work-budget");
  assert.ok(
    described.lines.some((l) =>
      /bond of 50 of the project's own token before judging/.test(l),
    ),
    described.lines.join(" | "),
  );
  // Any other token is named, with its raw amount: a call does not carry the token's decimals.
  const stranger = "0x00000000000000000000000000000000000000d1";
  const other = mandateDecision(
    mandate({
      reviewerBond: 7n,
      reviewerBondToken: stranger,
      reviewerBondDecimals: 0,
    }),
  );
  const said = describeAction(other, ctx);
  assert.ok(
    said.lines.some((l) => l.includes(`7 base units of the token ${stranger}`)),
    said.lines.join(" | "),
  );
  // The default is the claim currency, with no extra words.
  const plain = describeAction(
    mandateDecision(mandate({ reviewerBond: 50_000_000n })),
    ctx,
  );
  assert.ok(
    plain.lines.some((l) => l.endsWith("bond of 50 before judging a claim")),
  );
});

test("a bond token that is not an address, or a bond with decimals nobody knows, is refused", () => {
  refused(
    () =>
      mandateDecision(mandate({ reviewerBond: 1n, reviewerBondToken: "0x12" })),
    "reviewerBondToken",
  );
  refused(
    () =>
      mandateDecision(
        mandate({
          reviewerBond: 1n,
          reviewerBondToken: SHARES,
          reviewerBondDecimals: 99,
        }),
      ),
    "reviewerBondDecimals",
  );
  // No bond, no token: a token named without a bond is ignored rather than encoded.
  const quiet = mandateDecision(mandate({ reviewerBondToken: SHARES }));
  assert.ok(quiet.lines.includes("Reviewers post no bond"));
  assert.equal(quiet.data, mandateDecision(mandate()).data);
});

test("a milestone project holds nothing: only inside the milestone panel may both amounts be zero, and the vote says so", () => {
  const milestone = {
    ...baseProject(),
    id: "milestone-1",
    amount: 0n,
    shares: 0n,
    checkText: "alpha shipped",
    milestone: true,
  };
  const d = projectDecision(milestone);
  assert.equal(d.lane, "bounded");
  assert.equal(
    d.data,
    "0x7eb44f4d6d696c6573746f6e652d3100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000aa00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000006b49d200584c2cefcd48562da6fb9889be81b5ec58deec77062db839bf9de9f7bbb9aab8",
  );
  assert.ok(
    d.lines.some((l) => /Holds no money and awards no Shares/.test(l)),
    d.lines.join(" | "),
  );
  const read = describeAction(d, { mandates: [MANDATE] });
  assert.equal(read.kind, "project");
  assert.ok(read.lines.some((l) => /only lets a milestone be judged/.test(l)));
  // Anywhere else an empty project is still refused.
  refused(() => projectDecision({ ...milestone, milestone: false }), "amount");
  refused(
    () => projectDecision({ ...milestone, milestone: undefined }),
    "amount",
  );
});

test("holding a work budget to account: freeze, unwind, close and slash are exactly the calls cast encodes, and each reads back in words", () => {
  const ctx = {
    dao: DAO,
    mandates: [MANDATE],
    currency: CUR,
    currencyDecimals: 6,
  };
  const freeze = freezeClaimDecision({ mandate: MANDATE, claimId: CLAIM });
  assert.equal(freeze.to, MANDATE);
  assert.equal(freeze.lane, "unrestricted");
  assert.equal(
    freeze.data,
    "0xc82e88967777777777777777777777777777777777777777777777777777777777777777",
  );
  assert.equal(describeAction(freeze, ctx).kind, "freeze");
  assert.match(
    describeAction(freeze, ctx).lines.join(" "),
    /nobody's money is taken/,
  );

  const unwind = resolveFrozenClaimDecision({
    mandate: MANDATE,
    claimId: CLAIM,
  });
  assert.equal(
    unwind.data,
    "0x485400227777777777777777777777777777777777777777777777777777777777777777",
  );
  assert.equal(describeAction(unwind, ctx).kind, "unwind");

  const close = closeBudgetDecision({ mandate: MANDATE });
  assert.equal(close.data, "0x43d726d6");
  assert.equal(describeAction(close, ctx).kind, "close-budget");

  const slash = slashReviewerDecision({
    mandate: MANDATE,
    reviewer: R1,
    amount: 25_000_000n,
    bondDecimals: 6,
    bondSymbol: "USDC",
  });
  assert.equal(
    slash.data,
    "0xd6d541f9000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000017d7840",
  );
  assert.equal(describeAction(slash, ctx).kind, "slash");
  // Without the budgets' bond tokens the amount is not put in words: its decimals would be a guess.
  assert.match(describeAction(slash, ctx).title, /^Take 25000000 base units/);
  assert.equal(
    describeAction(slash, {
      ...ctx,
      bonds: { [MANDATE]: { token: CUR, symbol: "USDC", decimals: 6 } },
    }).title,
    "Take 25 USDC of a reviewer's bond",
  );
});

test("these calls are only described as what they are when aimed at the DAO's own work budgets", () => {
  const elsewhere = "0x00000000000000000000000000000000000000f9";
  const ctx = {
    dao: DAO,
    mandates: [MANDATE],
    currency: CUR,
    currencyDecimals: 6,
  };
  for (const draft of [
    freezeClaimDecision({ mandate: elsewhere, claimId: CLAIM }),
    resolveFrozenClaimDecision({ mandate: elsewhere, claimId: CLAIM }),
    closeBudgetDecision({ mandate: elsewhere }),
    slashReviewerDecision({
      mandate: elsewhere,
      reviewer: R1,
      amount: 1n,
      bondDecimals: 6,
      bondSymbol: "USDC",
    }),
  ]) {
    // The same selector sent anywhere else is a call this app cannot vouch for.
    assert.equal(describeAction(draft, ctx).kind, "unknown");
  }
  // A bare close() with no known budgets to check against is never described as closing one.
  assert.equal(
    describeAction(closeBudgetDecision({ mandate: MANDATE }), { dao: DAO })
      .kind,
    "unknown",
  );
});

test("a slash is described in the bond's own token, and refused when it takes nothing or names no claim", () => {
  const ctx = {
    dao: DAO,
    mandates: [MANDATE],
    currency: CUR,
    currencyDecimals: 6,
    bonds: { [MANDATE]: { token: SHARES, symbol: "NEB", decimals: 18 } },
  };
  const slash = slashReviewerDecision({
    mandate: MANDATE,
    reviewer: R1,
    amount: 5n * WAD,
    bondDecimals: 18,
    bondSymbol: "NEB",
  });
  assert.equal(
    describeAction(slash, ctx).title,
    "Take 5 NEB of a reviewer's bond",
  );
  refused(
    () =>
      slashReviewerDecision({
        mandate: MANDATE,
        reviewer: R1,
        amount: 0n,
        bondDecimals: 6,
        bondSymbol: "USDC",
      }),
    "amount",
  );
  refused(
    () => freezeClaimDecision({ mandate: MANDATE, claimId: "0x12" }),
    "claimId",
  );
});

test("a decision names people when it is given a way to, and writes the full address when it is not", () => {
  const draft = payDecision({
    currency: CUR,
    currencyDecimals: 6,
    currencySymbol: "USDC",
    recipient: R1,
    amount: 5_000_000n,
  });
  const ctx = { dao: DAO, currency: CUR, currencyDecimals: 6 };
  assert.deepEqual(describeAction(draft, ctx).lines, [`To ${R1}`]);
  const label = (address) =>
    address.toLowerCase() === R1 ? `Alex (${R1.slice(0, 6)}…)` : address;
  assert.deepEqual(describeAction(draft, { ...ctx, label }).lines, [
    `To Alex (${R1.slice(0, 6)}…)`,
  ]);
});
