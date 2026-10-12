import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildLedger,
  decisionFigures,
  moneyFigures,
  promiseFigures,
  watchNotes,
  workFigures,
} from "./record.ts";
import { claimKey } from "./record-read.ts";

const MANDATE = "0x2222222222222222222222222222222222222222";
const USDC = "0x9999999999999999999999999999999999999999";
const ALICE = "0x1111111111111111111111111111111111111111";
const BOB = "0x3333333333333333333333333333333333333333";
const R1 = "0x7777777777777777777777777777777777777777";
const R2 = "0x8888888888888888888888888888888888888888";
const WAD = 10n ** 18n;
const U = 10n ** 6n;

const claim = (n, status, extra = {}, record = {}) => ({
  id: `0x${String(n).padStart(64, "0")}`,
  record: {
    contributor: ALICE,
    amount: 100n * U,
    stake: 0n,
    status,
    evidenceHash: "0x",
    checkHash: "0x",
    expiresAt: 0,
    releasedAt: 0,
    ...record,
  },
  project: "p",
  approvals: 0,
  objections: 0,
  quorum: 2,
  sharesAwarded: false,
  ...extra,
});

const mandate = (claims, extra = {}) => ({
  address: MANDATE,
  created: { currency: USDC, budget: 1000n * U },
  closed: false,
  expiresAt: 0,
  sharesAllocated: 5n * WAD,
  claimsAddress: "0x44",
  verifiersAddress: "0x66",
  quorum: 2,
  challengeWindow: 0,
  projects: [],
  claims,
  currency: { symbol: "USDC", decimals: 6 },
  truncated: false,
  ...extra,
});

const work = (mandates, extra = {}) => ({
  dao: "0xdao",
  chainTime: 5_000,
  mandates,
  truncated: false,
  ...extra,
});

const events = (extra = {}) => ({
  filedAt: new Map(),
  paidAt: new Map(),
  verdicts: new Map(),
  promises: [],
  lock: "0xlock",
  truncated: false,
  ...extra,
});

const labels = {
  person: (a) =>
    a === ALICE ? "Alice" : a === BOB ? "Bob" : a === R1 ? "Rae" : "Sam",
  money: (_m, v) => `${Number(v) / 1e6} USDC`,
  shares: (v) => String(Number(v) / 1e18),
  title: (d) => `decision ${d.id}`,
  milestone: (_h, i) => `milestone ${i + 1}`,
};

test("money is counted per currency: what was approved, paid and is waiting", () => {
  const w = work([
    mandate([
      claim(1, "Paid"),
      claim(2, "Paid", {}, { amount: 50n * U }),
      claim(3, "Approved"),
      claim(4, "Open"),
      claim(5, "Rejected"),
    ]),
  ]);
  assert.deepEqual(moneyFigures(w), [
    {
      currency: USDC,
      symbol: "USDC",
      decimals: 6,
      approved: 1000n * U,
      paid: 150n * U,
      waiting: 200n * U,
    },
  ]);
});

test("a budget that moves no currency is not counted as money", () => {
  assert.deepEqual(moneyFigures(work([mandate([], { currency: null })])), []);
});

test("work is counted by what became of it; Shares set aside and Shares actually awarded are told apart", () => {
  const project = (awarded) => ({ record: { sharesAwarded: awarded } });
  const w = work([
    mandate([claim(1, "Paid"), claim(2, "Open"), claim(3, "Approved")], {
      projects: [project(2n * WAD), project(0n)],
    }),
    mandate([claim(4, "Rejected"), claim(5, "Expired"), claim(6, "Frozen")]),
  ]);
  assert.deepEqual(workFigures(w), {
    filed: 6,
    paid: 1,
    inReview: 2,
    notPaid: 3,
    sharesAwarded: 2n * WAD,
    sharesSetAside: 10n * WAD,
  });
});

test("the team's promises are summed: held back, freed, given up", () => {
  const f = promiseFigures([
    {
      holder: ALICE,
      locked: 60n * WAD,
      tranches: [
        { unlocked: true, forfeited: false, amount: 100n * WAD },
        { unlocked: false, forfeited: false, amount: 60n * WAD },
      ],
    },
    {
      holder: BOB,
      locked: 0n,
      tranches: [{ unlocked: false, forfeited: true, amount: 40n * WAD }],
    },
  ]);
  assert.deepEqual(f, {
    people: 2,
    milestones: 3,
    reached: 1,
    held: 60n * WAD,
    freed: 100n * WAD,
    givenUp: 40n * WAD,
  });
});

test("decisions are grouped as open, carried out, and not passed", () => {
  const d = (state) => ({ id: state, state, openedAt: 1 });
  assert.deepEqual(
    decisionFigures(
      ["Active", "Queued", "Succeeded", "Executed", "Defeated", "Expired"].map(
        d,
      ),
    ),
    { open: 3, ran: 1, didNotPass: 2 },
  );
});

test("the ledger is newest first, undated entries last, and a paid claim says who, how much and who approved", () => {
  const paid = claim(1, "Paid", { approvals: 2 }, { releasedAt: 2_000 });
  const open = claim(2, "Open", { approvals: 1 });
  const key1 = claimKey(MANDATE, paid.id);
  const ledger = buildLedger({
    work: work([mandate([paid, open])]),
    decisions: [{ id: "0xd1", state: "Executed", openedAt: 500 }],
    events: events({
      filedAt: new Map([[key1, 1_000]]),
      paidAt: new Map([[key1, 3_000]]),
      verdicts: new Map([
        [
          key1,
          [
            { reviewer: R1, approve: true },
            { reviewer: R2, approve: true },
          ],
        ],
      ]),
    }),
    labels,
  });
  assert.deepEqual(
    ledger.map((e) => e.key.split("-")[0]),
    ["paid", "approved", "filed", "decision", "filed"],
  );
  assert.equal(ledger[0].text, "Alice was paid 100 USDC.");
  assert.equal(ledger[1].detail, "Approved by Rae, Sam.");
  // The second claim has no date and comes last.
  assert.equal(ledger.at(-1).when, 0);
  assert.match(ledger.at(-1).detail, /1 of 2 approvals/);
});

test("a claim that was turned down shows up as work that was not paid, with who objected", () => {
  const rejected = claim(1, "Rejected");
  const ledger = buildLedger({
    work: work([mandate([rejected])]),
    decisions: [],
    events: events({
      filedAt: new Map([[claimKey(MANDATE, rejected.id), 100]]),
      verdicts: new Map([
        [
          claimKey(MANDATE, rejected.id),
          [
            { reviewer: R1, approve: false },
            { reviewer: R2, approve: false },
          ],
        ],
      ]),
    }),
    labels,
  });
  assert.equal(ledger.length, 1);
  assert.match(ledger[0].detail, /Turned down.*Nothing was paid/);
  assert.match(ledger[0].detail, /Objected to by Rae, Sam\./);
});

test("a reached milestone and a given-up one are both written down", () => {
  const ledger = buildLedger({
    work: work([]),
    decisions: [],
    events: events({
      promises: [
        {
          holder: ALICE,
          locked: 0n,
          tranches: [
            {
              index: 0,
              unlocked: true,
              forfeited: false,
              amount: 100n * WAD,
              reachedAt: 9_000,
            },
            {
              index: 1,
              unlocked: false,
              forfeited: true,
              amount: 60n * WAD,
              reachedAt: null,
            },
          ],
        },
      ],
    }),
    labels,
  });
  assert.equal(
    ledger[0].text,
    "Alice reached milestone 1. 100 Shares were freed.",
  );
  assert.match(ledger[1].text, /gave up 60 Shares that Alice had not earned/);
});

test("notes: a single reviewer approving everything, a cut-short history and a DAO with no lock are each said", () => {
  const key = (n) => claimKey(MANDATE, `0x${n}`);
  const notes = watchNotes({
    work: work([mandate([])], { truncated: true }),
    events: events({
      truncated: true,
      lock: null,
      verdicts: new Map([
        [key(1), [{ reviewer: R1, approve: true }]],
        [key(2), [{ reviewer: R1, approve: true }]],
        [key(3), [{ reviewer: R1, approve: true }]],
      ]),
    }),
    labels,
  });
  assert.equal(notes.length, 4);
  assert.ok(
    notes.some((n) =>
      /Every approval so far \(3\) came from the same reviewer, Rae/.test(n),
    ),
  );
  assert.ok(notes.some((n) => /older than what was read/.test(n)));
  assert.ok(notes.some((n) => /more work than is shown/.test(n)));
  assert.ok(notes.some((n) => /held back behind milestones/.test(n)));
});

test("notes: a healthy DAO has nothing to add", () => {
  const key = (n) => claimKey(MANDATE, `0x${n}`);
  const notes = watchNotes({
    work: work([mandate([])]),
    events: events({
      verdicts: new Map([
        [
          key(1),
          [
            { reviewer: R1, approve: true },
            { reviewer: R2, approve: true },
          ],
        ],
        [key(2), [{ reviewer: R1, approve: true }]],
      ]),
    }),
    labels,
  });
  assert.deepEqual(notes, []);
});
