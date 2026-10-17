import assert from "node:assert/strict";
import test from "node:test";

import {
  encodeBatch,
  mandateDecision,
  payDecision,
  projectDecision,
} from "./daoActions.ts";
import {
  spendingHeadline,
  spendingIsComplete,
  summariseSpending,
} from "./spending.ts";

const DAO = "0x00000000000000000000000000000000000000d0";
const FACTORY = "0x00000000000000000000000000000000000000fa";
const USDC = "0x00000000000000000000000000000000000000cc";
const OTHER_TOKEN = "0x00000000000000000000000000000000000000dd";
const MANDATE = "0x00000000000000000000000000000000000000ee";
const MANAGER = "0x00000000000000000000000000000000000000aa";
const ALICE = "0x00000000000000000000000000000000000000a1";
const BOB = "0x00000000000000000000000000000000000000b2";
const R1 = "0x0000000000000000000000000000000000000001";
const R2 = "0x0000000000000000000000000000000000000002";
const NONCE = `0x${"11".repeat(32)}`;
const context = { dao: DAO, factory: FACTORY, mandates: [MANDATE] };

const decision = (id, state, action) => ({
  id,
  state,
  proposer: ALICE,
  openedAt: 1,
  queuedAt: 0,
  rules: null,
  support: { forVotes: 0n, againstVotes: 0n, quorum: 0n },
  action,
  openedBy: ALICE,
});
const call = (draft, to = draft.to, value = 0n) => ({
  op: 0,
  to,
  value,
  data: draft.data,
  nonce: NONCE,
});
const pay = (recipient, amount) =>
  payDecision({
    currency: USDC,
    currencyDecimals: 6,
    currencySymbol: "USDC",
    recipient,
    amount,
  });
const budgetDraft = mandateDecision({
  dao: DAO,
  factory: FACTORY,
  currency: USDC,
  currencyDecimals: 6,
  budget: 100_000_000n,
  cap: 50_000_000n,
  shareBudget: 0n,
  shareCap: 0n,
  expiresAt: 1_900_000_000,
  now: 1_700_000_000,
  reviewers: [R1, R2],
  quorum: 2,
  reviewerBond: 0n,
});
const mandateView = (over = {}, claims = []) => ({
  address: MANDATE,
  isMilestonePanel: false,
  created: { currency: USDC, budget: 100_000_000n },
  claims,
  ...over,
});
// A claim is committed to only once a project has taken it on; every claim here is taken on unless it says otherwise.
const BOUND = `0x${"aa".repeat(32)}`;
const paidClaim = (amount, status = "Paid", project = BOUND) => ({
  project,
  record: { status, amount },
});
const input = (decisions, work, over = {}) => ({
  decisions,
  decisionsTotal: decisions.length,
  truncated: false,
  work,
  currency: USDC,
  context,
  ...over,
});

test("money set aside in a work budget is counted from the budget, with what has been paid out of it", () => {
  const work = {
    mandates: [
      mandateView({}, [paidClaim(30_000_000n), paidClaim(10_000_000n, "Open")]),
    ],
  };
  const s = summariseSpending(
    input([decision("a", "Executed", call(budgetDraft, DAO))], work),
  );
  assert.equal(s.reviewedBudget, 100_000_000n);
  assert.equal(s.reviewedPaid, 30_000_000n);
  assert.equal(s.directTotal, 0n);
  assert.equal(s.unread, 0);
  assert.equal(
    spendingHeadline(s),
    "Everything that has left the treasury went through reviewed work budgets.",
  );
});

test("a closed budget counts only what is still committed to a claim or was paid, since the rest went back to the DAO", () => {
  const work = {
    mandates: [
      mandateView({ closed: true }, [
        paidClaim(4_000_000n),
        paidClaim(1_000_000n, "Recovered"),
        paidClaim(2_000_000n, "Approved"),
        paidClaim(500_000n, "Open"),
        paidClaim(300_000n, "Open", null),
      ]),
    ],
  };
  const s = summariseSpending(input([], work));
  // Paid 4, approved 2 and bound-and-open 0.5 are committed; the recovered claim and the unbound one are not.
  assert.equal(s.reviewedBudget, 6_500_000n);
  assert.equal(s.reviewedPaid, 4_000_000n);
  // The same budget still open counts whole.
  const open = summariseSpending(
    input([], { mandates: [mandateView({}, [paidClaim(4_000_000n)])] }),
  );
  assert.equal(open.reviewedBudget, 100_000_000n);
});

test("a payment straight out of the treasury is counted as direct, and only when it ran", () => {
  const ran = decision("p1", "Executed", call(pay(ALICE, 5_000_000n)));
  const lost = decision("p2", "Defeated", call(pay(BOB, 9_000_000n)));
  const open = decision("p3", "Active", call(pay(BOB, 7_000_000n)));
  const s = summariseSpending(input([ran, lost, open], { mandates: [] }));
  assert.equal(s.directTotal, 5_000_000n);
  assert.deepEqual(
    s.direct.map((p) => [
      p.position,
      p.decisionId,
      p.to.toLowerCase(),
      p.amount,
    ]),
    [[0, "p1", ALICE, 5_000_000n]],
  );
  assert.equal(
    spendingHeadline(s),
    "Money has left the treasury by direct payment only. No reviewer checked any of it.",
  );
});

test("payments inside a batch are found, and a batch that is not the DAO's own is not trusted", () => {
  const batch = encodeBatch([
    { to: USDC, data: pay(ALICE, 2_000_000n).data },
    { to: USDC, data: pay(BOB, 3_000_000n).data },
  ]);
  const ours = { op: 0, to: DAO, value: 0n, data: batch, nonce: NONCE };
  const elsewhere = {
    op: 0,
    to: OTHER_TOKEN,
    value: 0n,
    data: batch,
    nonce: NONCE,
  };
  const s = summariseSpending(
    input(
      [decision("b1", "Executed", ours), decision("b2", "Executed", elsewhere)],
      { mandates: [] },
    ),
  );
  assert.equal(s.directTotal, 5_000_000n);
  assert.equal(s.direct.length, 2);
  // The same bytes aimed at some other contract are something this app cannot read: counted as unread, not as money.
  assert.equal(s.unread, 1);
});

test("both paths in one DAO read as both", () => {
  const work = { mandates: [mandateView()] };
  const s = summariseSpending(
    input(
      [
        decision("a", "Executed", call(budgetDraft, DAO)),
        decision("p", "Executed", call(pay(ALICE, 4_000_000n))),
      ],
      work,
    ),
  );
  assert.equal(s.reviewedBudget, 100_000_000n);
  assert.equal(s.directTotal, 4_000_000n);
  assert.match(
    spendingHeadline(s),
    /some was paid out directly with no reviewer/,
  );
});

test("a decision that ran and could move money but is not a call the app recognises is counted as unread, never as nothing", () => {
  const stranger = {
    op: 0,
    to: OTHER_TOKEN,
    value: 0n,
    data: "0xdeadbeef00000000000000000000000000000000000000000000000000000001",
    nonce: NONCE,
  };
  const delegate = { ...stranger, op: 1 };
  const withValue = { ...stranger, value: 5n, data: "0x1234" };
  const s = summariseSpending(
    input(
      [
        decision("u1", "Executed", stranger),
        decision("u2", "Executed", delegate),
        decision("u3", "Executed", withValue),
        decision("u4", "Executed", null),
      ],
      { mandates: [] },
    ),
  );
  assert.equal(s.unread, 4);
  assert.equal(s.directTotal, 0n);
  // Nothing classified went either way, so the headline must not say money went both: it says it could not read.
  const headline = spendingHeadline(s);
  assert.doesNotMatch(
    headline,
    /Some money went through reviewed work budgets/,
  );
  assert.doesNotMatch(headline, /paid out directly/);
  assert.match(headline, /could not read everything/);
});

test("a claim that asked for money but was never taken on has committed nothing, even when it ended up frozen", () => {
  // A budget of 100 closed with one unbound frozen claim asking for 1,000: the old count said 1,000 was committed.
  const s = summariseSpending(
    input([], {
      mandates: [
        mandateView(
          { closed: true, created: { currency: USDC, budget: 100n } },
          [paidClaim(1_000n, "Frozen", null)],
        ),
      ],
    }),
  );
  assert.equal(s.reviewedBudget, 0n);
  assert.equal(s.reviewedPaid, 0n);
  // A frozen claim that WAS taken on still holds its reserved money.
  const bound = summariseSpending(
    input([], {
      mandates: [
        mandateView(
          { closed: true, created: { currency: USDC, budget: 100n } },
          [paidClaim(40n, "Frozen")],
        ),
      ],
    }),
  );
  assert.equal(bound.reviewedBudget, 40n);
});

test("what is committed never exceeds what was set aside", () => {
  const s = summariseSpending(
    input([], {
      mandates: [
        mandateView(
          { closed: true, created: { currency: USDC, budget: 100n } },
          [paidClaim(80n), paidClaim(80n, "Approved")],
        ),
      ],
    }),
  );
  assert.equal(s.reviewedBudget, 100n);
});

test("work budgets that were cut off or never read are said so: the picture is incomplete, never complete-looking", () => {
  const cut = summariseSpending(
    input([], { truncated: true, mandates: [mandateView()] }),
  );
  assert.equal(cut.workTruncated, true);
  assert.equal(spendingIsComplete(cut), false);
  assert.match(spendingHeadline(cut), /could not read everything/);

  const unread = summariseSpending(input([], undefined));
  assert.equal(unread.workRead, false);
  assert.equal(spendingIsComplete(unread), false);
  assert.doesNotMatch(
    spendingHeadline(unread),
    /^No money has left the treasury by a decision yet\.$/,
  );

  const whole = summariseSpending(input([], { mandates: [mandateView()] }));
  assert.equal(spendingIsComplete(whole), true);
});

test("decisions cut off at the bound also make the picture incomplete", () => {
  const s = summariseSpending(
    input(
      [decision("p", "Executed", call(pay(ALICE, 1_000_000n)))],
      { mandates: [] },
      { truncated: true, decisionsTotal: 40 },
    ),
  );
  assert.equal(spendingIsComplete(s), false);
  assert.match(spendingHeadline(s), /could not read everything/);
});

test("things that move no money out of the treasury are not counted: a project, a defeated vote, the milestone panel", () => {
  const project = projectDecision({
    mandate: MANDATE,
    id: "docs",
    manager: MANAGER,
    amount: 0n,
    shares: 40n * 10n ** 18n,
    expiresAt: 1_900_000_000,
    checkText: "docs merged and reviewed",
    now: 1_700_000_000,
    currencyDecimals: 6,
  });

  const s = summariseSpending(
    input([decision("pr", "Executed", call(project, MANDATE))], {
      mandates: [
        mandateView({
          isMilestonePanel: true,
          created: { currency: USDC, budget: 0n },
        }),
      ],
    }),
  );
  assert.equal(s.reviewedBudget, 0n);
  assert.equal(s.directTotal, 0n);
  assert.equal(s.unread, 0);
  assert.equal(
    spendingHeadline(s),
    "No money has left the treasury by a decision yet.",
  );
});

test("a budget in another currency is said so, not added to the DAO's own money", () => {
  const s = summariseSpending(
    input([], {
      mandates: [
        mandateView({ created: { currency: OTHER_TOKEN, budget: 9n } }),
      ],
    }),
  );
  assert.equal(s.reviewedBudget, 0n);
  assert.equal(s.otherCurrencyBudgets, 1);
});

test("when the chain's own coin is the money, plain sends are the direct payments", () => {
  const send = { op: 0, to: ALICE, value: 7n, data: "0x", nonce: NONCE };
  const s = summariseSpending(
    input(
      [decision("n", "Executed", send)],
      { mandates: [] },
      { currency: null },
    ),
  );
  assert.equal(s.directTotal, 7n);
});

test("the answer says when the decisions read were only the newest", () => {
  const s = summariseSpending(
    input([], { mandates: [] }, { decisionsTotal: 80, truncated: true }),
  );
  assert.equal(s.decisionsTotal, 80);
  assert.equal(s.truncated, true);
});
