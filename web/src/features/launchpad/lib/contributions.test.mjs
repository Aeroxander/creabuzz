import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeContributionConsumed,
  MAX_BUDGETS,
  readContributions,
  TOPIC_CONTRIBUTION_CONSUMED,
} from "./contributions.ts";
import { TOPIC_MANDATE_CREATED, idWord } from "./work.ts";

const a = (byte) => `0x${byte.repeat(20)}`;
const word = (hex) => `0x${hex.replace(/^0x/, "").padStart(64, "0")}`;
const DAO = a("da");
const POLICY = a("70");
const FACTORY = a("fa");
const SHARES = a("5e");
const BUDGET1 = a("b1");
const BUDGET2 = a("b2");
const ALICE = a("a1");
const BOB = a("b0");
const E18 = 10n ** 18n;

function created(budget, dao = DAO) {
  return {
    address: FACTORY,
    topics: [TOPIC_MANDATE_CREATED, word(dao), word(budget)],
    data: `0x${[BigInt(a("c0")), 0n, 0n, 100n * E18, 40n * E18]
      .map((n) => n.toString(16).padStart(64, "0"))
      .join("")}`,
  };
}

function award(budget, claim, who, shares, block = 10) {
  return {
    address: budget,
    topics: [TOPIC_CONTRIBUTION_CONSUMED, idWord(claim), word(who)],
    data: word(shares.toString(16)),
    blockNumber: `0x${block.toString(16)}`,
    transactionHash: `0x${"ab".repeat(32)}`,
  };
}

function fakeChain({
  budgets = [BUDGET1, BUDGET2],
  awards = {},
  projects = {},
  supply = 300n * E18,
  foreign = [],
} = {}) {
  return {
    async call(to, data) {
      if (to === DAO && data === "0x6f533638") return word(POLICY);
      if (to === POLICY && data === "0xb04b7bdb") return word(FACTORY);
      if (to === DAO && data === "0x03314efa") return word(SHARES);
      if (to === SHARES && data === "0x18160ddd") {
        if (supply === null) throw new Error("unreadable");
        return word(supply.toString(16));
      }
      if (data.startsWith("0x84a95c5f")) {
        const claim = `0x${data.slice(10)}`;
        const project = projects[`${to}:${claim}`];
        return project ? idWord(project) : word("0");
      }
      throw new Error(`unexpected call ${to} ${data.slice(0, 10)}`);
    },
    async now() {
      return 1_000;
    },
    async logs({ address, topics }) {
      if (address === FACTORY && topics[0] === TOPIC_MANDATE_CREATED)
        return [...budgets.map((b) => created(b)), ...foreign];
      if (topics[0] === TOPIC_CONTRIBUTION_CONSUMED)
        return awards[address] ?? [];
      return [];
    },
  };
}

test("the event topic is the one the work budget emits", () => {
  // cast keccak 'ContributionConsumed(bytes32,address,uint128)'
  assert.equal(
    TOPIC_CONTRIBUTION_CONSUMED,
    "0x9bb4ec6ba5d3a80ea80a6926798482c0e41c1e10214a686fc8e8695253439e95",
  );
});

test("each person's awards, for which claim in which project, and their part of all Shares", async () => {
  const snap = await readContributions(
    fakeChain({
      awards: {
        [BUDGET1]: [
          award(BUDGET1, "write-docs", ALICE, 25n * E18, 11),
          award(BUDGET1, "fix-search", BOB, 10n * E18, 12),
        ],
        [BUDGET2]: [award(BUDGET2, "translate", ALICE, 15n * E18, 13)],
      },
      projects: {
        [`${BUDGET1}:${idWord("write-docs")}`]: "docs",
        [`${BUDGET1}:${idWord("fix-search")}`]: "search",
      },
    }),
    DAO,
  );
  assert.equal(snap.budgets, 2);
  assert.equal(snap.earned, 50n * E18);
  assert.equal(snap.totalShares, 300n * E18);
  assert.equal(snap.notFromWork, 250n * E18);
  assert.deepEqual(
    snap.people.map((p) => [p.address, p.earned, p.bpsOfAll]),
    [
      [ALICE, 40n * E18, 1333],
      [BOB, 10n * E18, 333],
    ],
  );
  const alice = snap.people[0].awards;
  // Newest first, each with its claim, its project, and the budget it came from.
  assert.deepEqual(
    alice.map((x) => [x.claim, x.project, x.budget, x.shares]),
    [
      ["translate", null, BUDGET2, 15n * E18],
      ["write-docs", "docs", BUDGET1, 25n * E18],
    ],
  );
  assert.equal(snap.truncated, false);
});

test("a DAO with no awards has nobody on the page, and all its Shares are not from work", async () => {
  const snap = await readContributions(fakeChain(), DAO);
  assert.deepEqual(snap.people, []);
  assert.equal(snap.earned, 0n);
  assert.equal(snap.notFromWork, 300n * E18);
});

test("a budget another DAO made, or an event from another contract, never counts", async () => {
  const snap = await readContributions(
    fakeChain({
      budgets: [BUDGET1],
      foreign: [created(BUDGET2, a("ee"))],
      awards: {
        [BUDGET1]: [
          award(BUDGET1, "write-docs", ALICE, 25n * E18),
          // A node that ignores the address filter hands back someone else's event: it is dropped.
          award(a("66"), "stolen", BOB, 999n * E18),
        ],
        [BUDGET2]: [award(BUDGET2, "elsewhere", BOB, 5n * E18)],
      },
    }),
    DAO,
  );
  assert.equal(snap.budgets, 1);
  assert.deepEqual(
    snap.people.map((p) => p.address),
    [ALICE],
  );
});

test("an unreadable total is said, not guessed", async () => {
  const snap = await readContributions(
    fakeChain({
      supply: null,
      awards: { [BUDGET1]: [award(BUDGET1, "write-docs", ALICE, 25n * E18)] },
    }),
    DAO,
  );
  assert.equal(snap.totalShares, null);
  assert.equal(snap.notFromWork, null);
  assert.equal(snap.people[0].bpsOfAll, null);
});

test("more work budgets than the page reads is said, not hidden", async () => {
  const many = Array.from(
    { length: MAX_BUDGETS + 1 },
    (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}`,
  );
  const snap = await readContributions(fakeChain({ budgets: many }), DAO);
  assert.equal(snap.budgets, MAX_BUDGETS);
  assert.equal(snap.truncated, true);
});

test("a log that is not a whole award is not one", () => {
  const good = award(BUDGET1, "write-docs", ALICE, 1n);
  assert.ok(decodeContributionConsumed(good, BUDGET1));
  assert.equal(
    decodeContributionConsumed(
      { ...good, topics: good.topics.slice(0, 2) },
      BUDGET1,
    ),
    null,
  );
  assert.equal(
    decodeContributionConsumed({ ...good, data: "0x" }, BUDGET1),
    null,
  );
  assert.equal(
    decodeContributionConsumed({ ...good, data: word("0") }, BUDGET1),
    null,
  );
});
