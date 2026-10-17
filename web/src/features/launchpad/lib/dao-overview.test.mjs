import assert from "node:assert/strict";
import { test } from "node:test";

import {
  attentionItems,
  isOpenDecision,
  overviewCounts,
  summaryLine,
} from "./dao-overview.ts";

const ME = "0x" + "11".repeat(20);
const OTHER = "0x" + "22".repeat(20);

const decision = (id, state, extra = {}) => ({
  id,
  state,
  proposer: OTHER,
  openedAt: 1000,
  queuedAt: 0,
  rules: { delay: 3600n },
  support: { yes: 0n, no: 0n, abstain: 0n, qualifiedSince: 0n },
  action: null,
  openedBy: null,
  ...extra,
});

const claim = (id, status, extra = {}) => ({
  id,
  record: {
    contributor: OTHER,
    amount: 0n,
    stake: 0n,
    status,
    evidenceHash: "0x",
    checkHash: "0x",
    expiresAt: 0,
    releasedAt: 0,
  },
  project: "docs",
  approvals: 0,
  objections: 0,
  quorum: 2,
  sharesAwarded: false,
  ...extra,
});

const mandate = (claims, extra = {}) => ({
  closed: false,
  challengeWindow: 100,
  walletIsReviewer: false,
  walletAttested: [],
  claims,
  ...extra,
});

const snap = (decisions, extra = {}) => ({
  chainTime: 10_000,
  walletCapacity: 5n,
  decisions,
  ...extra,
});
const titleOf = (d) => `decision ${d.id}`;

test("with no wallet nothing is waiting for you", () => {
  assert.deepEqual(
    attentionItems({
      decisions: snap([decision("a", "Active")]),
      work: undefined,
      wallet: null,
      titleOf,
    }),
    [],
  );
});

test("an open decision is yours to vote on only while you hold voting Shares", () => {
  const input = (walletCapacity) => ({
    decisions: snap([decision("a", "Active")], { walletCapacity }),
    work: undefined,
    wallet: ME,
    titleOf,
  });
  const items = attentionItems(input(5n));
  assert.deepEqual(
    items.map((i) => [i.kind, i.tab, i.action]),
    [["vote", "decisions", "Vote"]],
  );
  assert.match(items[0].text, /Open for your vote: decision a\./);
  assert.deepEqual(attentionItems(input(0n)), []);
});

test("an approved decision, and a queued one whose wait is over, can be moved along by anyone", () => {
  const items = attentionItems({
    decisions: snap([
      decision("ready", "Queued", { queuedAt: 5_000 }), // 5_000 + 3_600 <= 10_000
      decision("waiting", "Queued", { queuedAt: 9_000 }), // still waiting
      decision("approved", "Succeeded"),
      decision("done", "Executed"),
    ]),
    work: undefined,
    wallet: ME,
    titleOf,
  });
  assert.deepEqual(
    items.map((i) => i.key),
    ["move-ready", "move-approved"],
  );
  assert.match(items[0].text, /^Ready to run/);
  assert.match(items[1].text, /ready to start its wait/);
});

test("a claim is yours to review only if you are on the panel and have not already answered", () => {
  const open = claim("c1", "Open");
  const work = (extra) => ({
    chainTime: 10_000,
    mandates: [mandate([open], extra)],
  });
  const review = (extra) =>
    attentionItems({
      decisions: undefined,
      work: work(extra),
      wallet: ME,
      titleOf,
    });
  assert.deepEqual(
    review({ walletIsReviewer: true }).map((i) => i.kind),
    ["review"],
  );
  assert.deepEqual(review({ walletIsReviewer: false }), []);
  assert.deepEqual(
    review({ walletIsReviewer: true, walletAttested: ["c1"] }),
    [],
  );
});

test("a payout is waiting for the contributor, once the challenge window is over", () => {
  const approved = claim("c1", "Approved", {
    record: {
      ...claim("x", "Approved").record,
      contributor: ME,
      releasedAt: 9_000,
    },
  });
  const at = (chainTime) =>
    attentionItems({
      decisions: undefined,
      work: { chainTime, mandates: [mandate([approved])] },
      wallet: ME,
      titleOf,
    }).map((i) => i.kind);
  assert.deepEqual(at(9_050), []); // 9_000 + 100 > 9_050
  assert.deepEqual(at(9_100), ["payout"]);
});

test("a finished claim with no award yet asks holders to put the award to a vote", () => {
  const paid = claim("c1", "Paid");
  const items = (walletCapacity) =>
    attentionItems({
      decisions: snap([], { walletCapacity }),
      work: { chainTime: 10_000, mandates: [mandate([paid])] },
      wallet: ME,
      titleOf,
    });
  assert.deepEqual(
    items(5n).map((i) => i.kind),
    ["award"],
  );
  assert.deepEqual(items(0n), []);
});

test("the most personal thing comes first", () => {
  const approved = claim("p", "Approved", {
    record: {
      ...claim("x", "Approved").record,
      contributor: ME,
      releasedAt: 1,
    },
  });
  const open = claim("r", "Open");
  const items = attentionItems({
    decisions: snap([decision("v", "Active"), decision("m", "Succeeded")]),
    work: {
      chainTime: 10_000,
      mandates: [mandate([open, approved], { walletIsReviewer: true })],
    },
    wallet: ME,
    titleOf,
  });
  assert.deepEqual(
    items.map((i) => i.kind),
    ["payout", "review", "vote", "move"],
  );
});

test("the counts and the sentence say what is going on, or that nothing is", () => {
  const decisions = snap([
    decision("a", "Active"),
    decision("b", "Queued"),
    decision("c", "Executed"),
    decision("d", "Defeated"),
  ]);
  assert.deepEqual(decisions.decisions.map(isOpenDecision), [
    true,
    true,
    false,
    false,
  ]);
  const work = {
    chainTime: 1,
    mandates: [
      mandate([claim("1", "Open"), claim("2", "Paid"), claim("3", "Approved")]),
      mandate([], { closed: true }),
    ],
  };
  const counts = overviewCounts(decisions, work);
  assert.deepEqual(counts, {
    openDecisions: 2,
    openClaims: 2,
    workBudgets: 1,
    carriedOut: 1,
  });
  assert.equal(
    summaryLine(counts),
    "2 decisions are open and 2 pieces of work are in progress.",
  );
  assert.equal(
    summaryLine({ openDecisions: 1, openClaims: 0, workBudgets: 0 }),
    "1 decision is open.",
  );
  assert.match(
    summaryLine({ openDecisions: 0, openClaims: 0, workBudgets: 2 }),
    /Work budgets are open/,
  );
  assert.match(
    summaryLine({ openDecisions: 0, openClaims: 0, workBudgets: 0 }),
    /Nothing is going on yet/,
  );
  // A DAO that has already carried things out is not new: it says no budget is open instead of "first decision".
  const done = summaryLine({
    openDecisions: 0,
    openClaims: 0,
    workBudgets: 0,
    carriedOut: 6,
  });
  assert.match(done, /no work budget is open/);
  assert.doesNotMatch(done, /first decision/);
});

test("the milestone panel is not a work budget: a DAO with only that is still offered its first one", () => {
  const work = {
    chainTime: 1,
    mandates: [mandate([claim("1", "Open")], { isMilestonePanel: true })],
  };
  const counts = overviewCounts(snap([]), work);
  assert.equal(counts.workBudgets, 0);
  // Its claims are still work in progress: a founder's milestone claim is real work to judge.
  assert.equal(counts.openClaims, 1);
});

test("a reviewer who has not posted the bond is told to, first, and not asked to review what they cannot yet judge", () => {
  const bonded = (extra) =>
    attentionItems({
      decisions: undefined,
      work: {
        chainTime: 10_000,
        mandates: [
          mandate([], {
            walletIsReviewer: true,
            bond: { minBond: 50n, decimalsKnown: true },
            walletStake: 0n,
            isMilestonePanel: true,
            ...extra,
          }),
        ],
      },
      wallet: ME,
      titleOf,
    });
  const [item] = bonded({});
  assert.equal(item.kind, "bond");
  assert.equal(item.tab, "work");
  assert.match(item.text, /reviewers for the team's milestones/);
  // Part of the bond is not enough, and enough is nothing to do.
  assert.equal(bonded({ walletStake: 49n })[0].kind, "bond");
  assert.deepEqual(bonded({ walletStake: 50n }), []);
  // A budget that asks no bond, a closed one, and a wallet that is not on the panel say nothing.
  assert.deepEqual(bonded({ bond: null }), []);
  assert.deepEqual(bonded({ closed: true }), []);
  assert.deepEqual(bonded({ walletIsReviewer: false }), []);
});

test("the bond reminder comes before everything else", () => {
  const open = claim("c1", "Open", { project: "0x" + "aa".repeat(32) });
  const items = attentionItems({
    decisions: snap([decision("a", "Active")]),
    work: {
      chainTime: 10_000,
      mandates: [
        mandate([open], {
          walletIsReviewer: true,
          bond: { minBond: 50n, decimalsKnown: true },
          walletStake: 0n,
        }),
      ],
    },
    wallet: ME,
    titleOf,
  });
  assert.equal(items[0].kind, "bond");
});
