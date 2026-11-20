// The reads and the plans built on them, against a stand-in node. Run with:
// node --experimental-strip-types --test src/pot/pot-reads.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { decodeCall } from "./abi-codec.ts";
import {
  PLAY_DOLLAR_ABI,
  TASK_BOOK_ABI,
  TREASURY_ABI,
} from "./abis.generated.ts";
import { fakeChain } from "./fake-chain.mjs";
import {
  QUOTE_TOLERANCE_BPS,
  planBack,
  planTakeOut,
  planTeamTakeOut,
  teamCashEstimate,
  withTolerance,
} from "./pot-plans.ts";
import * as reads from "./pot-reads.ts";

const DOLLAR = "0x5fbdb2315678afecb367f032d93f642f64180aa3";
const TREASURY = "0xcf7ed3acca5a467e9e704c703e8d87f634fb0fc9";
const VESTER = "0xdc64a140aa3e981100a9beca4e685f962f0cf6c9";
const ME = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const YOU = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";

test("quoteBack reads its four numbers", async () => {
  const { read, seen } = fakeChain({ quoteBack: [11_501n, 98n, 0n, 5n] });
  const quote = await reads.quoteBack(read, TREASURY, 100n);
  assert.deepEqual(quote, {
    shares: 11_501n,
    takeOutNow: 98n,
    locked: 0n,
    arriving: 5n,
  });
  assert.deepEqual(seen[0], { to: TREASURY, name: "quoteBack", args: [100n] });
});

test("feeFor, doorOpenNow, quoteTakeOut, teamValue, balances and claims", async () => {
  const { read } = fakeChain({
    feeFor: [2n],
    doorOpenNow: [false],
    quoteTakeOut: [9_000n, 0n, 7n],
    teamValue: [1234n],
    balanceOf: [55n],
    allowance: [66n],
    idsOf: [[1n, 3n]],
    claimable: [77n],
    vestedOf: [88n],
  });
  assert.equal(await reads.feeFor(read, TREASURY, 100n), 2n);
  assert.equal(await reads.doorOpenNow(read, TREASURY), false);
  assert.deepEqual(await reads.quoteTakeOut(read, TREASURY, ME, 5n), {
    cashNow: 9_000n,
    note: 0n,
    arrivingLeftBehind: 7n,
  });
  assert.equal(await reads.teamValue(read, TREASURY), 1234n);
  assert.equal(await reads.balanceOf(read, DOLLAR, ME), 55n);
  assert.equal(await reads.allowanceOf(read, DOLLAR, ME, TREASURY), 66n);
  assert.deepEqual(await reads.grantIdsOf(read, VESTER, ME), [1n, 3n]);
  assert.equal(await reads.claimableOf(read, VESTER, 1n), 77n);
  assert.equal(await reads.vestedOf(read, VESTER, 1n), 88n);
});

test("a read that fails or answers short throws; it never gives zero", async () => {
  await assert.rejects(() =>
    reads.quoteBack(
      async () => {
        throw new Error("node down");
      },
      TREASURY,
      1n,
    ),
  );
  await assert.rejects(() => reads.quoteBack(async () => "0x", TREASURY, 1n));
  await assert.rejects(
    () => reads.quoteBack(async () => "0xzz", TREASURY, 1n),
    /not readable/,
  );
  await assert.rejects(() =>
    reads.doorOpenNow(async () => `0x${"00".repeat(31)}02`, TREASURY),
  );
});

test("the dollar's pay-and-call is told by the interface id, and a dollar that does not answer has none", async () => {
  let asked;
  const yes = async (_to, data) => {
    asked = data;
    return `0x${"00".repeat(31)}01`;
  };
  assert.equal(await reads.dollarHasPayAndCall(yes, DOLLAR), true);
  // supportsInterface(bytes4 0xb0202a11)
  assert.equal(asked, `0x01ffc9a7b0202a11${"00".repeat(28)}`);
  assert.equal(
    await reads.dollarHasPayAndCall(async () => `0x${"00".repeat(32)}`, DOLLAR),
    false,
  );
  assert.equal(
    await reads.dollarHasPayAndCall(async () => {
      throw new Error("revert");
    }, DOLLAR),
    false,
  );
});

test("a Back is planned from the quote: minShares is a little under it, and on the play dollar it is one call", async () => {
  const { read } = fakeChain({
    quoteBack: [10_000n, 98n, 0n, 0n],
    supportsInterface: [true],
  });
  const plan = await planBack(read, {
    dollar: DOLLAR,
    treasury: TREASURY,
    amount: 100n,
    to: ME,
  });
  assert.equal(plan.minShares, 9_950n);
  assert.equal(plan.oneSignature, true);
  assert.equal(plan.calls.length, 1);
  assert.equal(
    decodeCall(PLAY_DOLLAR_ABI, plan.calls[0].data).name,
    "transferAndCall",
  );
});

test("a Back on a dollar with no pay-and-call is approve, then join, with the same guard", async () => {
  const { read } = fakeChain({
    quoteBack: [10_000n, 98n, 0n, 0n],
    supportsInterface: [false],
  });
  const plan = await planBack(read, {
    dollar: DOLLAR,
    treasury: TREASURY,
    amount: 100n,
    to: ME,
  });
  assert.equal(plan.oneSignature, false);
  assert.equal(plan.calls.length, 2);
  const join = decodeCall(TREASURY_ABI, plan.calls[1].data);
  assert.deepEqual([join.name, join.args[1]], ["join", 9_950n]);
});

test("a Back that would buy no Shares is refused before a signature", async () => {
  const { read } = fakeChain({ quoteBack: [0n, 0n, 0n, 0n] });
  assert.equal(
    await planBack(read, {
      dollar: DOLLAR,
      treasury: TREASURY,
      amount: 100n,
      payAndCall: true,
    }),
    null,
  );
});

test("a take-out is planned from the quote with a minimum-cash guard", async () => {
  const { read, seen } = fakeChain({ quoteTakeOut: [1_000_000n, 0n, 0n] });
  const plan = await planTakeOut(read, {
    treasury: TREASURY,
    holder: ME,
    shares: 5n,
    to: ME,
  });
  assert.equal(plan.minCash, 995_000n);
  const leave = decodeCall(TREASURY_ABI, plan.call.data);
  assert.deepEqual([leave.name, ...leave.args], ["leave", 5n, 995_000n, ME]);
  assert.equal(seen[0].name, "quoteTakeOut");
});

test("a take-out of nothing is refused, and a guard never falls to zero", async () => {
  const none = fakeChain({ quoteTakeOut: [0n, 0n, 0n] });
  assert.equal(
    await planTakeOut(none.read, {
      treasury: TREASURY,
      holder: ME,
      shares: 5n,
      to: ME,
    }),
    null,
  );
  const tiny = fakeChain({ quoteTakeOut: [1n, 0n, 0n] });
  const plan = await planTakeOut(tiny.read, {
    treasury: TREASURY,
    holder: ME,
    shares: 5n,
    to: ME,
  });
  assert.equal(plan.minCash, 1n);
});

test("a Team take-out goes by an estimate and a wider guard, and is refused when the estimate is zero", async () => {
  assert.equal(teamCashEstimate(10_058n, 3n * 10n ** 18n), 30_174n);
  const { read } = fakeChain({ teamValue: [10_000n] });
  const plan = await planTeamTakeOut(read, {
    treasury: TREASURY,
    shares: 2n * 10n ** 18n,
    to: ME,
  });
  assert.equal(plan.estimate, 20_000n);
  assert.equal(plan.minCash, 19_600n);
  const zero = fakeChain({ teamValue: [0n] });
  assert.equal(
    await planTeamTakeOut(zero.read, {
      treasury: TREASURY,
      shares: 10n ** 18n,
      to: ME,
    }),
    null,
  );
});

test("the tolerance rounds down and is half a percent", () => {
  assert.equal(QUOTE_TOLERANCE_BPS, 50n);
  assert.equal(withTolerance(1_000n, 50n), 995n);
  assert.equal(withTolerance(1n, 50n), 0n);
});

// --- Tasks ---------------------------------------------------------------------------------------------------------
// `testdata/task-answers.json` holds raw answers of a real anvil chain running the contracts, captured while the app's own
// builders drove a project (see its `_about`). Each entry carries the calldata the reader sent, so a reader that asks the
// wrong question fails here too. The tuple answers were also read with `cast abi-decode` and agree field by field.
const REAL = JSON.parse(
  readFileSync(
    new URL("./testdata/task-answers.json", import.meta.url),
    "utf8",
  ),
);
const BOOK = REAL.chain.book;
const WORKER = REAL.chain.worker;
const BACKER1 = REAL.chain.backer1;
const DOLLARS = 1_000_000n;

/** A node that gives `entry`'s answer to exactly the calldata the capture recorded, and fails on any other question. */
const realRead = (entry) => async (to, data) => {
  assert.equal(
    data,
    entry.call,
    "the reader asked another question than the real run did",
  );
  assert.equal(to, entry.to);
  return entry.answer;
};

test("a real taskOf answer is read, in every state a task reaches", async () => {
  const what = (n) => `0x${String(n).repeat(64)}`;
  const task = (key, serial) =>
    reads.readTask(realRead(REAL[key]), BOOK, serial);
  assert.deepEqual(await task("taskOf1_announced", 1n), {
    serial: 1n,
    what: what(1),
    payee: WORKER,
    state: "announced",
    shareBps: 250,
    takenBy: null,
    announcedAt: 1795136059,
    noticeEnd: 1795139719,
    expiresAt: 1795141399,
    takenAt: null,
    deadline: null,
    maxDollars: 3n * DOLLARS,
    setAside: 0n,
    stayerClaim: 0n,
    noteFace: 0n,
    returned: 0n,
    notesLeft: 0n,
  });
  // The same task, taken: the take window's end is replaced by the deadline, and the whole sum is the stayers'.
  assert.deepEqual(await task("taskOf1_taken", 1n), {
    serial: 1n,
    what: what(1),
    payee: WORKER,
    state: "taken",
    shareBps: 250,
    takenBy: WORKER,
    announcedAt: 1795136059,
    noticeEnd: 1795139719,
    expiresAt: 1795143084,
    takenAt: 1795139724,
    deadline: 1795143084,
    maxDollars: 3n * DOLLARS,
    setAside: 3n * DOLLARS,
    stayerClaim: 3n * DOLLARS,
    noteFace: 0n,
    returned: 0n,
    notesLeft: 0n,
  });
  // After a take out wrote a note: what is set aside is the stayers' claim plus the notes' face.
  const withNote = await task("taskOf1_takenWithNote", 1n);
  assert.equal(withNote.stayerClaim, 2_250_000n);
  assert.equal(withNote.noteFace, 750_000n);
  assert.equal(withNote.stayerClaim + withNote.noteFace, withNote.setAside);
  // Paid in part: half went to the worker, half came back, and the notes keep their claim on what came back.
  const paid = await task("taskOf1_paid", 1n);
  assert.equal(paid.state, "paid");
  assert.equal(paid.returned, 1_500_000n);
  assert.equal(paid.notesLeft, 375_000n);
  assert.equal(paid.stayerClaim, 0n);
  // Withdrawn: nothing moved; an open task (no payee) has none.
  const cancelled = await task("taskOf2_cancelled", 2n);
  assert.equal(cancelled.state, "cancelled");
  assert.equal(cancelled.payee, null);
  assert.equal(cancelled.setAside, 0n);
  assert.equal((await task("taskOf2_announced", 2n)).state, "announced");
  // Sent back, and ran out (still "taken" in the book until someone settles, then "returned").
  const rejected = await task("taskOf3_rejected", 3n);
  assert.deepEqual(
    [rejected.state, rejected.returned],
    ["rejected", 1_451_892n],
  );
  assert.equal((await task("taskOf4_overdue", 4n)).state, "taken");
  const returned = await task("taskOf4_returned", 4n);
  assert.deepEqual(
    [returned.state, returned.returned],
    ["returned", 1_451_892n],
  );
});

test("a task that does not exist reads as null, not as an empty task", async () => {
  assert.equal(await reads.readTask(realRead(REAL.taskOf99), BOOK, 99n), null);
});

test("readTask reads the tuple by the ABI's field names, and refuses what it cannot read", async () => {
  const names = TASK_BOOK_ABI.find(
    (i) => i.name === "taskOf",
  ).outputs[0].components.map((c) => c.name);
  const ZERO = "0x0000000000000000000000000000000000000000";
  const base = {
    what: `0x${"ab".repeat(32)}`,
    payee: ZERO,
    state: 1n,
    shareBps: 100n,
    ringIdx: 0n,
    takenBy: ZERO,
    announcedAt: 10n,
    noticeEnd: 20n,
    expiresAt: 30n,
    takenAt: 0n,
    deadline: 0n,
    maxDollars: 5n,
    locked: 0n,
    stayer: 0n,
    noteFace: 0n,
    returned: 0n,
    notesLeft: 0n,
  };
  const answer = (over) =>
    fakeChain({ taskOf: [names.map((n) => ({ ...base, ...over })[n])] }).read;
  assert.equal((await reads.readTask(answer({}), BOOK, 1n)).state, "announced");
  assert.equal(await reads.readTask(answer({ state: 0n }), BOOK, 1n), null);
  // a state the book does not have, a time too large for a safe number: errors, never a guess
  await assert.rejects(
    () => reads.readTask(answer({ state: 8n }), BOOK, 1n),
    /does not know/,
  );
  await assert.rejects(
    () => reads.readTask(answer({ deadline: 2n ** 60n }), BOOK, 1n),
    /unreadable time/,
  );
  // short, empty and failing answers
  await assert.rejects(() => reads.readTask(async () => "0x", BOOK, 1n));
  await assert.rejects(() =>
    reads.readTask(async () => `0x${"00".repeat(32 * 16)}`, BOOK, 1n),
  );
  await assert.rejects(() =>
    reads.readTask(
      async () => {
        throw new Error("node down");
      },
      BOOK,
      1n,
    ),
  );
  // the ABI still names all 17 fields the reader looks up
  assert.equal(names.length, 17);
});

test("the open serials, the notice, the room, notes, the book, the check-in end and the unit are read from real answers", async () => {
  assert.deepEqual(
    await reads.readOpenSerials(realRead(REAL.openSerials0), BOOK),
    [],
  );
  assert.deepEqual(
    await reads.readOpenSerials(realRead(REAL.openSerials2), BOOK),
    [1n, 2n],
  );
  assert.deepEqual(
    await reads.readNoticeFor(
      realRead(REAL.noticeFor250),
      REAL.chain.treasury,
      250,
    ),
    {
      noticeSecs: 3660,
      takeWindowSecs: 1680,
      dueSecs: 3360,
    },
  );
  assert.equal(await reads.readTakeRoom(realRead(REAL.takeRoom0), BOOK), 1000);
  assert.equal(
    await reads.readTakeRoom(realRead(REAL.takeRoomAfter), BOOK),
    845,
  );
  assert.equal(
    await reads.readNoteOf(realRead(REAL.noteOf_backer1), BOOK, 1n, BACKER1),
    750_000n,
  );
  assert.equal(
    await reads.readNoteOf(
      realRead(REAL.noteOf_backer2),
      BOOK,
      1n,
      REAL.chain.backer2,
    ),
    0n,
  );
  // zero while the task is open, a share of what came back once it ended
  assert.equal(
    await reads.readClaimable(realRead(REAL.claimable_open), BOOK, 1n, BACKER1),
    0n,
  );
  assert.equal(
    await reads.readClaimable(realRead(REAL.claimable_paid), BOOK, 1n, BACKER1),
    375_000n,
  );
  assert.equal(
    await reads.readBookOf(realRead(REAL.tasks), REAL.chain.treasury),
    BOOK,
  );
  assert.equal(
    await reads.readActiveEnd(realRead(REAL.activeEnd), REAL.chain.treasury),
    1795139419,
  );
  assert.equal(
    await reads.readUnit(realRead(REAL.unit), REAL.chain.treasury),
    1680,
  );
});

test("the task reads go through the stand-in node too, with the right arguments", async () => {
  const { read, seen } = fakeChain({
    openSerials: [[3n, 4n]],
    noticeFor: [100n, 200n, 300n],
    takeRoomBps: [7n],
    noteOf: [9n],
    claimableNote: [4n],
    tasks: ["0x0000000000000000000000000000000000000000"],
    activeEnd: [1234n],
    unit: [600n],
  });
  assert.deepEqual(await reads.readOpenSerials(read, BOOK), [3n, 4n]);
  assert.deepEqual(await reads.readNoticeFor(read, TREASURY, 100), {
    noticeSecs: 100,
    takeWindowSecs: 200,
    dueSecs: 300,
  });
  assert.equal(await reads.readTakeRoom(read, BOOK), 7);
  assert.equal(await reads.readNoteOf(read, BOOK, 2n, ME), 9n);
  assert.equal(await reads.readClaimable(read, BOOK, 2n, ME), 4n);
  assert.equal(await reads.readBookOf(read, TREASURY), null);
  assert.equal(await reads.readActiveEnd(read, TREASURY), 1234);
  assert.equal(await reads.readUnit(read, TREASURY), 600);
  assert.deepEqual(
    seen.map((s) => [s.name, s.args]),
    [
      ["openSerials", []],
      ["noticeFor", [100n]],
      ["takeRoomBps", []],
      ["noteOf", [2n, ME]],
      ["claimableNote", [2n, ME]],
      ["tasks", []],
      ["activeEnd", []],
      ["unit", []],
    ],
  );
});

// --- The look for notes ---------------------------------------------------------------------------------------------

const NOTE_TOPIC = REAL.noteLogs[0].topics[0];
const holderTopic = (a) => `0x${a.slice(2).padStart(64, "0")}`;
const SERIAL_TOPIC = (n) => `0x${n.toString(16).padStart(64, "0")}`;

/** A node holding `logs`: it filters by address, topics and range like `eth_getLogs`, and refuses a range over `limit`. */
function logNode(logs, { latest, limit = Number.POSITIVE_INFINITY }) {
  const asked = [];
  return {
    asked,
    blockNumber: async () => latest,
    getLogs: async (f) => {
      asked.push({ from: f.from, to: f.to });
      if (f.to - f.from + 1 > limit)
        throw new Error(
          "query returned more than 10000 results or range too large",
        );
      return logs.filter(
        (l) =>
          l.address === f.address &&
          Number(BigInt(l.blockNumber)) >= f.from &&
          Number(BigInt(l.blockNumber)) <= f.to &&
          f.topics.every((t, i) => t === null || l.topics[i] === t),
      );
    },
  };
}
const noteLog = (serial, holder, block, book = BOOK) => ({
  address: book,
  topics: [NOTE_TOPIC, SERIAL_TOPIC(serial), holderTopic(holder)],
  data: "0x",
  blockNumber: `0x${block.toString(16)}`,
});

test("the look finds a real note from the real log, and none for a person with no note", async () => {
  const node = logNode(REAL.bookLogs, { latest: 40 });
  assert.deepEqual(await reads.scanNotes(node, BOOK, 0, BACKER1), {
    serials: [1n],
    reachedBlock: 0,
    done: true,
  });
  // The other holder's search asks for a topic the log does not have: empty, and done, so "nothing found" is allowed.
  assert.deepEqual(await reads.scanNotes(node, BOOK, 0, REAL.chain.stranger), {
    serials: [],
    reachedBlock: 0,
    done: true,
  });
  // It asks for NoteMinted of the book with the holder in the third topic, and nothing else.
  assert.equal(NOTE_TOPIC, REAL.noteLogs[0].topics[0]);
  assert.equal(node.asked.length, 2);
});

test("the look goes newest first, a page at a time, and names each task once", async () => {
  const logs = [
    noteLog(5n, ME, 100),
    noteLog(2n, ME, 2_500),
    noteLog(3n, ME, 8_000),
    noteLog(5n, ME, 11_000),
    noteLog(9n, YOU, 11_500), // another holder's: never listed
  ];
  const node = logNode(logs, { latest: 12_000 });
  const found = await reads.scanNotes(node, BOOK, 100, ME);
  assert.deepEqual(found, {
    serials: [5n, 3n, 2n],
    reachedBlock: 100,
    done: true,
  });
  assert.deepEqual(node.asked, [
    { from: 7_001, to: 12_000 },
    { from: 2_001, to: 7_000 },
    { from: 100, to: 2_000 },
  ]);
});

test("a node that refuses a big range gets smaller pages, and the answer is the same", async () => {
  const logs = [noteLog(2n, ME, 2_500), noteLog(3n, ME, 8_000)];
  const node = logNode(logs, { latest: 12_000, limit: 1_000 });
  const found = await reads.scanNotes(node, BOOK, 0, ME);
  assert.deepEqual(found, { serials: [3n, 2n], reachedBlock: 0, done: true });
  // 5,000 refused, 2,500 refused, 1,250 refused, 625 accepted from then on
  assert.deepEqual(node.asked.slice(0, 4), [
    { from: 7_001, to: 12_000 },
    { from: 9_501, to: 12_000 },
    { from: 10_751, to: 12_000 },
    { from: 11_376, to: 12_000 },
  ]);
});

test("a node that refuses even a small range is 'could not look', with what was found, never 'none'", async () => {
  const logs = [noteLog(3n, ME, 2_900)];
  const node = logNode(logs, { latest: 3_000, limit: 150 });
  // pages of 5,000 down to 100 are tried: 100 fits under 150, so the look works...
  assert.equal((await reads.scanNotes(node, BOOK, 0, ME)).done, true);
  // ...and a node limited to 50 blocks cannot be asked for less than 100.
  const strict = logNode(logs, { latest: 12_000, limit: 50 });
  await assert.rejects(
    () => reads.scanNotes(strict, BOOK, 0, ME),
    (error) => {
      assert.ok(error instanceof reads.NoteScanRefused);
      assert.equal(error.found.done, false);
      assert.deepEqual(error.found.serials, []);
      return true;
    },
  );
  // a node that fails halfway still hands back what the first pages found
  let calls = 0;
  const flaky = {
    blockNumber: async () => 12_000,
    getLogs: async (f) => {
      calls += 1;
      if (calls > 1) throw new Error("gone");
      return [noteLog(3n, ME, f.to - 5)];
    },
  };
  await assert.rejects(
    () => reads.scanNotes(flaky, BOOK, 0, ME),
    (error) => {
      assert.ok(error instanceof reads.NoteScanRefused);
      assert.deepEqual(error.found, {
        serials: [3n],
        reachedBlock: 7_001,
        done: false,
      });
      return true;
    },
  );
});

test("a press reads at most 40 pages, then says where it got to, and the next press continues from there", async () => {
  const logs = [noteLog(7n, ME, 850_000), noteLog(8n, ME, 500)];
  const node = logNode(logs, { latest: 1_000_000 });
  const first = await reads.scanNotes(node, BOOK, 0, ME);
  assert.equal(node.asked.length, reads.NOTE_SCAN_MAX_PAGES);
  assert.deepEqual(first, {
    serials: [7n],
    reachedBlock: 800_001,
    done: false,
  });
  const second = await reads.scanNotes(
    node,
    BOOK,
    0,
    ME,
    first.reachedBlock - 1,
  );
  assert.equal(second.reachedBlock, 600_001);
  assert.equal(node.asked[40].to, 800_000);
  assert.equal(second.done, false);
  // from the end of the chain's history the whole way: only then is it done
  const rest = await reads.scanNotes(node, BOOK, 0, ME, 100_000);
  assert.deepEqual(rest, { serials: [8n], reachedBlock: 0, done: true });
});

test("the look keeps only NoteMinted logs of this book that name this holder, whatever the node returns", async () => {
  const wrong = [
    noteLog(1n, YOU, 50), // another holder
    noteLog(2n, ME, 50, "0x1111111111111111111111111111111111111111"), // another contract
    {
      ...noteLog(3n, ME, 50),
      topics: [`0x${"ee".repeat(32)}`, SERIAL_TOPIC(3n), holderTopic(ME)],
    }, // another event
    { ...noteLog(4n, ME, 50), topics: [NOTE_TOPIC, SERIAL_TOPIC(4n)] }, // too few topics
    noteLog(6n, ME, 50),
  ];
  const rude = { blockNumber: async () => 100, getLogs: async () => wrong };
  assert.deepEqual(await reads.scanNotes(rude, BOOK, 0, ME), {
    serials: [6n],
    reachedBlock: 0,
    done: true,
  });
});

test("a look that starts below the first block of the book has nothing to read and is done", async () => {
  const node = logNode([], { latest: 10 });
  assert.deepEqual(await reads.scanNotes(node, BOOK, 50, ME, 49), {
    serials: [],
    reachedBlock: 50,
    done: true,
  });
  assert.deepEqual(node.asked, []);
  // a chain shorter than the book's first block: the same
  assert.equal(
    (await reads.scanNotes(logNode([], { latest: 10 }), BOOK, 50, ME)).done,
    true,
  );
});
