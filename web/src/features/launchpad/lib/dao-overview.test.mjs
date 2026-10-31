import assert from "node:assert/strict";
import { test } from "node:test";

import {
  attentionItems,
  isOpenDecision,
  managersFor,
  overviewCounts,
  rankAttention,
  rankEntries,
  summaryLine,
} from "./dao-overview.ts";
import { idWord } from "./work.ts";

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
  project: idWord("docs"),
  approvals: 0,
  objections: 0,
  quorum: 2,
  sharesAwarded: false,
  ...extra,
});

const BUDGET = `0x${"b1".repeat(20)}`;
const mandate = (claims, extra = {}) => ({
  address: BUDGET,
  isMilestonePanel: false,
  projects: [],
  closed: false,
  expiresAt: 50_000,
  challengeWindow: 100,
  walletIsReviewer: false,
  walletAttested: [],
  claims,
  ...extra,
});

const DAO = `0x${"da".repeat(20)}`;
const snap = (decisions, extra = {}) => ({
  dao: DAO,
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
  assert.match(items[0].text, /^Ready to take effect/);
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
  // 9_000 + 100 > 9_050: theirs to take only once the window is over; until then it waits, and says until when.
  assert.deepEqual(at(9_050), ["waiting"]);
  assert.deepEqual(at(9_100), ["payout"]);
});

const DOCS_CHECK = `0x${"d0".repeat(32)}`;
const ART_CHECK = `0x${"a7".repeat(32)}`;
const managed = (manager, record = {}) => ({
  id: idWord("docs"),
  record: {
    manager,
    budget: 0n,
    reserved: 0n,
    expiresAt: 40_000,
    checkHash: DOCS_CHECK,
    shareBudget: 40n,
    sharesAwarded: 0n,
    ...record,
  },
});

test("a manager is asked to accept submitted work in one of their work areas, and the button opens that claim", () => {
  const submitted = claim("c1", "Open", {
    project: null,
    record: { ...claim("x", "Open").record, checkHash: DOCS_CHECK },
  });
  const items = (manager) =>
    attentionItems({
      decisions: undefined,
      work: {
        chainTime: 10_000,
        mandates: [mandate([submitted], { projects: [managed(manager)] })],
      },
      wallet: ME,
      titleOf,
    });
  const [item] = items(ME);
  assert.equal(item.kind, "bind");
  assert.equal(item.action, "Accept for review");
  assert.match(
    item.text,
    / submitted “[^”]+” for Docs\. Accept it so the reviewers can judge it\.$/,
  );
  assert.deepEqual(item.claim, { id: "c1", mandate: BUDGET });
  // Someone who manages no work area there is not asked.
  assert.deepEqual(items(OTHER), []);
});

test("accept for review is offered only where the budget would take it: same words, open, not ended, money left", () => {
  const submitted = (record = {}) =>
    claim("c1", "Open", {
      project: null,
      record: {
        ...claim("x", "Open").record,
        checkHash: DOCS_CHECK,
        ...record,
      },
    });
  const kinds = (claimView, mandateExtra = {}, area = {}) =>
    attentionItems({
      decisions: undefined,
      work: {
        chainTime: 10_000,
        mandates: [
          mandate([claimView], {
            projects: [managed(ME, area)],
            ...mandateExtra,
          }),
        ],
      },
      wallet: ME,
      titleOf,
    }).map((i) => i.kind);
  assert.deepEqual(kinds(submitted()), ["bind"]);
  // An art submission, when they manage only docs: the words differ, so docs cannot take it.
  assert.deepEqual(kinds(submitted({ checkHash: ART_CHECK })), []);
  // A closed budget, an ended budget, or an ended work area.
  assert.deepEqual(kinds(submitted(), { closed: true }), []);
  assert.deepEqual(kinds(submitted(), { expiresAt: 10_000 }), []);
  assert.deepEqual(kinds(submitted(), {}, { expiresAt: 9_000 }), []);
  // A payment larger than what the work area has left to reserve.
  assert.deepEqual(
    kinds(submitted({ amount: 60n }), {}, { budget: 100n, reserved: 50n }),
    [],
  );
  assert.deepEqual(
    kinds(submitted({ amount: 50n }), {}, { budget: 100n, reserved: 50n }),
    ["bind"],
  );
});

test("a milestone claim not yet submitted is its filer's step, on the Milestones tab, not someone else's", () => {
  const filed = claim("m1", "Open", {
    project: null,
    record: { ...claim("x", "Open").record, contributor: ME },
  });
  const items = attentionItems({
    decisions: undefined,
    work: {
      chainTime: 10_000,
      mandates: [mandate([filed], { isMilestonePanel: true })],
    },
    wallet: ME,
    titleOf,
  });
  assert.deepEqual(
    items.map((i) => [i.kind, i.actor ?? "you", i.tab, i.action]),
    [["bind", "you", "milestones", "Finish submitting"]],
  );
});

test("enough approvals: the contributor and the work area's manager are told anyone can finish the review", () => {
  const approvedEnough = (contributor) =>
    claim("c1", "Open", {
      approvals: 2,
      record: { ...claim("x", "Open").record, contributor },
    });
  const items = (contributor, manager) =>
    attentionItems({
      decisions: undefined,
      work: {
        chainTime: 10_000,
        mandates: [
          mandate([approvedEnough(contributor)], {
            projects: [managed(manager)],
          }),
        ],
      },
      wallet: ME,
      titleOf,
    });
  const mine = items(ME, OTHER);
  assert.deepEqual(
    mine.map((i) => i.kind),
    ["settle"],
  );
  assert.match(mine[0].text, /^Enough reviewers approved your “/);
  assert.match(mine[0].text, /Anyone can now finish its review, you included/);
  assert.deepEqual(
    items(OTHER, ME).map((i) => [i.kind, i.why]),
    [["settle", "You manage its work area."]],
  );
  // Neither theirs nor their work area's: not asked, even though the contract would let them.
  assert.deepEqual(items(OTHER, OTHER), []);
});

test("your own work waiting on someone else is said apart, with who acts next", () => {
  const mine = (id, status, extra = {}) =>
    claim(id, status, {
      ...extra,
      record: {
        ...claim("x", status).record,
        contributor: ME,
        ...(extra.record ?? {}),
      },
    });
  const items = attentionItems({
    decisions: snap([], { walletCapacity: 0n }),
    work: {
      chainTime: 10_000,
      mandates: [
        mandate([
          mine("a", "Open", { project: null }),
          mine("b", "Open", { approvals: 1 }),
          mine("c", "Approved", { record: { releasedAt: 9_950 } }),
          mine("d", "Paid"),
        ]),
      ],
    },
    wallet: ME,
    titleOf,
  });
  assert.ok(items.every((i) => i.actor === "others" && i.kind === "waiting"));
  const text = Object.fromEntries(items.map((i) => [i.claim.id, i.text]));
  assert.match(text.a, /waiting for a work area's manager to accept it/);
  assert.match(text.b, /waiting for reviewers: 1 of 2 approvals/);
  assert.match(
    text.c,
    /You can mark it finished once the challenge window ends/,
  );
  assert.match(text.d, /Shareholders decide by a vote whether to award Shares/);
  // The window's end is when it changes by itself.
  assert.equal(items.find((i) => i.claim.id === "c").due, 10_050);
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
    // Claim "1" is open in a work area, so its reviewers are judging it.
    inReview: 1,
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

const line = (key, kind, extra = {}) => ({
  key,
  kind,
  text: key,
  action: "Open",
  tab: "decisions",
  ...extra,
});

test("what has a deadline comes first, soonest first, then the rest by what it asks of the person", () => {
  const items = [
    line("award", "award"),
    line("vote-later", "vote", { due: 500 }),
    line("payout", "payout"),
    line("vote-soon", "vote", { due: 200 }),
    line("lapsed", "vote", { due: 50 }), // its moment has passed: no longer timed
    line("bond", "bond"),
  ];
  assert.deepEqual(
    rankAttention(items, 100).map((i) => i.key),
    ["vote-soon", "vote-later", "bond", "payout", "lapsed", "award"],
  );
  // Equal items keep the order they came in, and nothing is dropped or invented.
  const same = [line("b", "move"), line("a", "move"), line("c", "move")];
  assert.deepEqual(
    rankAttention(same, 100).map((i) => i.key),
    ["b", "a", "c"],
  );
  assert.deepEqual(rankAttention([], 100), []);
});

test("entries from different chains are each judged against their own clock", () => {
  // A local chain that is months ahead of another: the same due moment is past on one and ahead on the other.
  const ahead = { item: line("ahead", "vote", { due: 1_000 }), now: 2_000 };
  const behind = { item: line("behind", "vote", { due: 1_000 }), now: 500 };
  const plain = { item: line("plain", "payout"), now: 500 };
  assert.deepEqual(
    rankEntries([plain, ahead, behind]).map((e) => e.item.key),
    ["behind", "plain", "ahead"],
  );
});

test("an open decision says when it ends, why it is yours and what happens if you let it pass", () => {
  const [item] = attentionItems({
    decisions: snap([
      decision("a", "Active", { rules: { delay: 3600n, expiresAt: 20_000n } }),
    ]),
    work: undefined,
    wallet: ME,
    titleOf,
  });
  assert.equal(item.due, 20_000);
  assert.match(item.why, /hold Shares/);
  assert.match(item.ifIgnored, /expires and nothing changes/);
  // A decision whose rules were not read has no moment to name, and says nothing it does not know.
  const [bare] = attentionItems({
    decisions: snap([decision("b", "Active")]),
    work: undefined,
    wallet: ME,
    titleOf,
  });
  assert.equal(bare.due, undefined);
});

test("the decisions most urgent to this person are listed before the ones that can wait", () => {
  const items = attentionItems({
    decisions: snap([
      decision("late", "Active", { rules: { delay: 0n, expiresAt: 90_000n } }),
      decision("soon", "Active", { rules: { delay: 0n, expiresAt: 20_000n } }),
      decision("approved", "Succeeded"),
    ]),
    work: undefined,
    wallet: ME,
    titleOf,
  });
  assert.deepEqual(
    items.map((i) => i.key),
    ["vote-soon", "vote-late", "move-approved"],
  );
});

test("a review claim's expiry outranks a later vote and says what inaction risks", () => {
  const c = claim("urgent", "Open");
  c.record.expiresAt = 10001;
  const items = attentionItems({
    wallet: ME,
    decisions: snap([
      decision("later", "Active", { rules: { delay: 0n, expiresAt: 96400n } }),
    ]),
    work: {
      chainTime: 10000,
      mandates: [mandate([c], { walletIsReviewer: true })],
    },
    titleOf,
  });
  assert.equal(items[0].key, "review-urgent");
  assert.equal(items[0].due, 10001);
  assert.match(items[0].ifIgnored, /anyone can close/);
  assert.match(items[0].ifIgnored, /stake and reserved payment/);
  const expired = attentionItems({
    wallet: ME,
    decisions: undefined,
    work: {
      chainTime: 10002,
      mandates: [mandate([c], { walletIsReviewer: true })],
    },
    titleOf,
  });
  assert.match(expired[0].ifIgnored, /can now close/);
  const boundary = attentionItems({
    wallet: ME,
    decisions: undefined,
    work: {
      chainTime: 10001,
      mandates: [mandate([c], { walletIsReviewer: true })],
    },
    titleOf,
  });
  assert.doesNotMatch(boundary[0].ifIgnored, /can now close/);
});

test("work the reviewers turned down is closed from Needs you by its manager or a reviewer, and its contributor is told why to look", () => {
  const DOWN = idWord("down");
  const down = claim(DOWN, "Open", { objections: 2 });
  const forWho = (wallet, extra = {}) =>
    attentionItems({
      wallet,
      decisions: undefined,
      work: {
        chainTime: 10_000,
        mandates: [mandate([down], { projects: [managed(ME)], ...extra })],
      },
      titleOf,
    });
  const manager = forWho(ME).find((i) => i.key === `settle-${DOWN}`);
  assert.equal(manager?.action, "Close it as turned down");
  assert.equal(manager?.kind, "settle");
  assert.equal(manager?.claim?.id, DOWN);
  assert.match(manager?.text ?? "", /turned down/);
  // A reviewer on the panel who manages nothing is offered it too.
  const reviewer = forWho("0x" + "33".repeat(20), { walletIsReviewer: true });
  assert.equal(
    reviewer.find((i) => i.key === `settle-${DOWN}`)?.action,
    "Close it as turned down",
  );
  // The contributor is not asked to close their own turned-down work: they are told it was, and where to read why.
  const mine = forWho(OTHER);
  assert.equal(
    mine.find((i) => i.key === `settle-${DOWN}`),
    undefined,
  );
  const told = mine.find((i) => i.key === `waiting-${DOWN}`);
  assert.equal(told?.actor, "others");
  // Who turned it down is always shown; a reason only when one was given, so "why" is not promised.
  assert.match(
    told?.text ?? "",
    /turned down your “Down”\. The Work tab shows who, and their reasons if they gave any\./,
  );
  // Someone with no part in it is asked nothing.
  assert.equal(
    forWho("0x" + "44".repeat(20)).find((i) => i.key === `settle-${DOWN}`),
    undefined,
  );
});

test("a claim past its deadline is offered to its contributor and manager as close it as lapsed; a split nobody can break says so", () => {
  const late = claim("late", "Open", {
    record: { ...claim("x", "Open").record, expiresAt: 9_000, stake: 5n },
    approvals: 1,
    panel: 3,
  });
  const items = (wallet) =>
    attentionItems({
      wallet,
      decisions: undefined,
      work: {
        chainTime: 10_000,
        mandates: [mandate([late], { projects: [managed(ME)] })],
      },
      titleOf,
    });
  const managerItem = items(ME).find((i) => i.key === "expire-late");
  assert.equal(managerItem?.action, "Close it as lapsed");
  assert.equal(managerItem?.kind, "expire");
  const contributorItem = items(OTHER).find((i) => i.key === "expire-late");
  assert.match(contributorItem?.text ?? "", /your deposit comes back/);
  // Before the deadline nobody is offered it.
  const early = attentionItems({
    wallet: ME,
    decisions: undefined,
    work: {
      chainTime: 8_000,
      mandates: [mandate([late], { projects: [managed(ME)] })],
    },
    titleOf,
  });
  assert.equal(
    early.find((i) => i.key === "expire-late"),
    undefined,
  );
  // Split with nobody left: the contributor reads that it is stuck and when it can be closed.
  const split = claim("split", "Open", {
    record: { ...claim("x", "Open").record, expiresAt: 20_000 },
    approvals: 1,
    objections: 1,
    panel: 2,
  });
  const stuck = attentionItems({
    wallet: OTHER,
    decisions: undefined,
    work: { chainTime: 10_000, mandates: [mandate([split])] },
    titleOf,
  }).find((i) => i.key === "waiting-split");
  assert.match(stuck?.text ?? "", /is stuck/);
  assert.equal(stuck?.due, 20_000);
});

test("the founder is not asked to put an award to a vote while one for the same claim is open", async () => {
  const { encodeFunctionData } = await import(
    "@creaton/core/launchpad/evmAbi.ts"
  );
  const done = claim("0x" + "ab".repeat(32), "Paid");
  const awardData = encodeFunctionData(
    "awardContribution(address,bytes32,uint96,bool)",
    ["address", "bytes32", "uint96", "bool"],
    [BUDGET, done.id, 10n, false],
  );
  const items = (state, action, to = DAO) =>
    attentionItems({
      wallet: ME,
      decisions: snap([
        decision("award-vote", state, {
          action: action
            ? { op: 0, to, value: 0n, data: action, nonce: "1" }
            : null,
        }),
      ]),
      work: { chainTime: 10_000, mandates: [mandate([done])] },
      titleOf,
    }).filter((i) => i.kind === "award");
  assert.equal(items("Active", awardData).length, 0);
  assert.equal(items("Queued", awardData).length, 0);
  // A vote that failed, or one whose action could not be read, does not count.
  assert.equal(items("Defeated", awardData).length, 1);
  assert.equal(items("Active", null).length, 1);
  // The same bytes sent to anything but the DAO award nothing, so they do not hide the step.
  assert.equal(items("Active", awardData, OTHER).length, 1);
});

test("a claim past its deadline that reviewers can still decide says so: settle has no deadline", () => {
  const late = claim("late", "Open", {
    record: { ...claim("x", "Open").record, expiresAt: 9_000 },
    approvals: 1,
    panel: 3,
  });
  const item = attentionItems({
    wallet: ME,
    decisions: undefined,
    work: {
      chainTime: 10_000,
      mandates: [mandate([late], { projects: [managed(ME)] })],
    },
    titleOf,
  }).find((i) => i.key === "expire-late");
  assert.equal(
    item?.ifIgnored,
    "It stays open, and the reviewers can still decide it until someone closes it.",
  );
  assert.doesNotMatch(item?.ifIgnored ?? "", /no longer be approved/);
  // Split with nobody left to decide: it only stays open.
  const split = claim("split", "Open", {
    record: { ...claim("x", "Open").record, expiresAt: 9_000 },
    approvals: 1,
    objections: 1,
    panel: 2,
  });
  const stuck = attentionItems({
    wallet: ME,
    decisions: undefined,
    work: {
      chainTime: 10_000,
      mandates: [mandate([split], { projects: [managed(ME)] })],
    },
    titleOf,
  }).find((i) => i.key === "expire-split");
  assert.equal(stuck?.ifIgnored, "It stays open until someone closes it.");
});

test("work whose words no open work area uses is not left waiting on a manager who cannot accept it", () => {
  const OTHER_WORDS = `0x${"ee".repeat(32)}`;
  const stray = claim("stray", "Open", {
    project: null,
    record: {
      ...claim("x", "Open").record,
      checkHash: OTHER_WORDS,
      expiresAt: 20_000,
    },
  });
  const forWho = (wallet, projects) =>
    attentionItems({
      wallet,
      decisions: undefined,
      work: { chainTime: 10_000, mandates: [mandate([stray], { projects })] },
      titleOf,
    });
  const mine = forWho(OTHER, [managed(ME)]).find(
    (i) => i.key === "waiting-stray",
  );
  assert.match(mine?.text ?? "", /words no open work area uses/);
  assert.doesNotMatch(mine?.text ?? "", /manager to accept/);
  // The manager is not asked: none of their areas can take it.
  assert.equal(
    forWho(ME, [managed(ME)]).find((i) => i.key === "bind-stray"),
    undefined,
  );
  // Its words are an open area's: it waits for that area's manager, as before.
  const matching = forWho(OTHER, [
    managed(ME, { checkHash: OTHER_WORDS }),
  ]).find((i) => i.key === "waiting-stray");
  assert.match(matching?.text ?? "", /manager to accept it for review/);
  // A budget with no open work area yet still waits for one.
  const none = forWho(OTHER, []).find((i) => i.key === "waiting-stray");
  assert.match(none?.text ?? "", /manager to accept it for review/);
});

test("In review counts only work a manager accepted; work still waiting for a manager is not in review", () => {
  const waiting = claim("w", "Open", { project: null });
  const judged = claim("j", "Open");
  const counts = overviewCounts(snap([]), {
    chainTime: 1,
    mandates: [mandate([waiting, judged])],
  });
  assert.equal(counts.openClaims, 2);
  assert.equal(counts.inReview, 1);
});

test("the managers who could accept a submission are those of open work areas with its words", () => {
  const submitted = claim("c1", "Open", {
    project: null,
    record: { ...claim("x", "Open").record, checkHash: DOCS_CHECK },
  });
  const projects = [
    managed(ME),
    managed(OTHER, { checkHash: ART_CHECK }),
    managed(ME.toUpperCase().replace("0X", "0x")),
  ];
  assert.deepEqual(
    managersFor(submitted, mandate([submitted], { projects }), 10_000),
    [ME.toLowerCase()],
  );
  // Past its end, nobody can accept it.
  assert.deepEqual(
    managersFor(submitted, mandate([submitted], { projects }), 50_000),
    [],
  );
});
