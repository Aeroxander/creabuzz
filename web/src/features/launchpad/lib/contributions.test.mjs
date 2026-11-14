import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeContributionConsumed,
  MAX_BUDGETS,
  readContributions,
  TOPIC_CONTRIBUTION_CONSUMED,
  TOPIC_TRANSFER,
} from "./contributions.ts";
import { TOPIC_MANDATE_CREATED, idWord } from "@creaton/core/launchpad/work.ts";

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
const FOUNDER = a("f0");
const ZERO = a("00");
const TX = (n) => `0x${n.toString(16).padStart(64, "0")}`;
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

function award(budget, claim, who, shares, block = 10, tx = TX(block)) {
  return {
    address: budget,
    topics: [TOPIC_CONTRIBUTION_CONSUMED, idWord(claim), word(who)],
    data: word(shares.toString(16)),
    blockNumber: `0x${block.toString(16)}`,
    transactionHash: tx,
  };
}

/** A Shares `Transfer` log: a mint from the zero address, or a move out of the DAO's reserve. */
function move(from, to, shares, tx) {
  return {
    address: SHARES,
    topics: [TOPIC_TRANSFER, word(from), word(to)],
    data: word(shares.toString(16)),
    transactionHash: tx,
  };
}

/** The mints that make each award's Shares arrive, in the award's own transaction. */
const mintsFor = (logs) =>
  logs.map((log) =>
    move(
      ZERO,
      `0x${log.topics[2].slice(-40)}`,
      BigInt(log.data),
      log.transactionHash,
    ),
  );

function fakeChain({
  budgets = [BUDGET1, BUDGET2],
  awards = {},
  projects = {},
  supply = 300n * E18,
  foreign = [],
  // Shares moves, by default the founder's 250 at the start and a mint for every award.
  moves = [
    move(ZERO, FOUNDER, 250n * E18, TX(1)),
    ...mintsFor(Object.values(awards).flat()),
  ],
  movesFail = false,
  holdings = {},
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
      if (to === SHARES && data.startsWith("0x70a08231")) {
        const who = `0x${data.slice(-40)}`;
        if (holdings[who] === null) throw new Error("unreadable");
        return word((holdings[who] ?? 0n).toString(16));
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
      if (address === SHARES && topics[0] === TOPIC_TRANSFER) {
        if (movesFail) throw new Error("the node refused the range");
        return moves.filter((m) => m.topics[1] === topics[1]);
      }
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

test("each person's awards, for which claim in which work area, and what they hold now", async () => {
  const snap = await readContributions(
    fakeChain({
      holdings: { [ALICE]: 40n * E18, [BOB]: 10n * E18 },
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
  assert.equal(snap.unconfirmed, 0n);
  assert.equal(snap.totalShares, 300n * E18);
  assert.equal(snap.startingShares, 250n * E18);
  assert.deepEqual(
    snap.people.map((p) => [p.address, p.earned, p.heldNow, p.bpsNow]),
    [
      [ALICE, 40n * E18, 40n * E18, 1333],
      [BOB, 10n * E18, 10n * E18, 333],
    ],
  );
  const alice = snap.people[0].awards;
  // Newest first, each with its claim, its project, and the budget it came from.
  assert.deepEqual(
    alice.map((x) => [x.claim, x.project, x.budget, x.shares, x.receipt]),
    [
      ["translate", null, BUDGET2, 15n * E18, "received"],
      ["write-docs", "docs", BUDGET1, 25n * E18, "received"],
    ],
  );
  assert.equal(snap.truncated, false);
});

test("a DAO with no awards has nobody on the page, and its starting Shares are its mints", async () => {
  const snap = await readContributions(fakeChain(), DAO);
  assert.deepEqual(snap.people, []);
  assert.equal(snap.earned, 0n);
  assert.equal(snap.startingShares, 250n * E18);
});

test("an award whose Shares never arrived is recorded, not received, and not counted as earned", async () => {
  // A vote can mark a claim used by calling the budget directly: the budget's event, but no Shares.
  const awards = {
    [BUDGET1]: [award(BUDGET1, "write-docs", ALICE, 25n * E18)],
  };
  const snap = await readContributions(
    fakeChain({ awards, moves: [move(ZERO, FOUNDER, 250n * E18, TX(1))] }),
    DAO,
  );
  assert.equal(snap.earned, 0n);
  assert.equal(snap.unconfirmed, 25n * E18);
  assert.equal(snap.receiptsUnread, false);
  assert.deepEqual(
    snap.people.map((p) => [p.address, p.earned, p.unconfirmed]),
    [[ALICE, 0n, 25n * E18]],
  );
  assert.equal(snap.people[0].awards[0].receipt, "missing");
});

test("Shares moved out of the DAO's reserve count with a mint as one award; a mint to someone else or a move by anyone else does not", async () => {
  const awards = {
    [BUDGET1]: [
      award(BUDGET1, "write-docs", ALICE, 25n * E18, 11),
      award(BUDGET1, "fix-search", BOB, 10n * E18, 12),
      award(BUDGET1, "translate", ALICE, 5n * E18, 13),
    ],
  };
  const snap = await readContributions(
    fakeChain({
      awards,
      moves: [
        move(ZERO, FOUNDER, 250n * E18, TX(1)),
        // write-docs: 20 out of the reserve and 5 minted, in its transaction.
        move(DAO, ALICE, 20n * E18, TX(11)),
        move(ZERO, ALICE, 5n * E18, TX(11)),
        // fix-search: minted to the wrong person.
        move(ZERO, ALICE, 10n * E18, TX(12)),
        // translate: someone other than the DAO sent it.
        move(FOUNDER, ALICE, 5n * E18, TX(13)),
      ],
    }),
    DAO,
  );
  const receipts = Object.fromEntries(
    snap.people.flatMap((p) => p.awards.map((x) => [x.claim, x.receipt])),
  );
  assert.deepEqual(receipts, {
    "write-docs": "received",
    "fix-search": "missing",
    translate: "missing",
  });
  assert.equal(snap.earned, 25n * E18);
  assert.equal(snap.unconfirmed, 15n * E18);
  // The mint in fix-search's transaction went to an award's transaction, so it is not starting Shares either.
  assert.equal(snap.startingShares, 250n * E18);
});

test("when the token's history cannot be read, no award is confirmed and the starting Shares are unknown", async () => {
  const awards = {
    [BUDGET1]: [award(BUDGET1, "write-docs", ALICE, 25n * E18)],
  };
  const snap = await readContributions(
    fakeChain({ awards, movesFail: true }),
    DAO,
  );
  assert.equal(snap.receiptsUnread, true);
  assert.equal(snap.startingShares, null);
  assert.equal(snap.earned, 0n);
  assert.equal(snap.unconfirmed, 25n * E18);
  assert.equal(snap.people[0].awards[0].receipt, "unknown");
});

test("leaving later changes what people hold now, never the awards or the starting Shares", async () => {
  // The founder left with 100 of their 250, and Alice with all 25 of hers: 150 Shares remain.
  const awards = {
    [BUDGET1]: [award(BUDGET1, "write-docs", ALICE, 25n * E18)],
  };
  const snap = await readContributions(
    fakeChain({
      awards,
      supply: 150n * E18,
      holdings: { [ALICE]: 0n },
    }),
    DAO,
  );
  assert.equal(snap.startingShares, 250n * E18);
  assert.equal(snap.earned, 25n * E18);
  assert.deepEqual(
    snap.people.map((p) => [p.earned, p.heldNow, p.bpsNow]),
    [[25n * E18, 0n, 0]],
  );
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
  assert.equal(snap.people[0].bpsNow, null);
  // What was issued does not depend on the total now.
  assert.equal(snap.startingShares, 250n * E18);
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
