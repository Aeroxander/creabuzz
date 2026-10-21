import assert from "node:assert/strict";
import test from "node:test";

import { readShareRules } from "./share-rules.ts";

const SHARES = `0x${"b5".repeat(20)}`;
const DAO = `0x${"d0".repeat(20)}`;
const LOCK = `0x${"1c".repeat(20)}`;
const word = (n) => `0x${BigInt(n).toString(16).padStart(64, "0")}`;
const addressWord = (a) => `0x${a.slice(2).padStart(64, "0")}`;
const WAD = 10n ** 18n;

/** A fake chain answering the Shares' reads by selector (and `lockedOf`-free lock reads). */
function chain(answers) {
  return async (to, data) => {
    const key = `${to.toLowerCase()} ${data.slice(0, 10)}`;
    const answer = answers[key];
    if (answer === undefined) throw new Error("execution reverted");
    if (answer instanceof Error) throw answer;
    return answer;
  };
}

const kitShares = (over = {}) => ({
  [`${SHARES} 0x0704ab61`]: word(1), // awardsOnly
  [`${SHARES} 0x6243f127`]: word(1000), // issuanceCapBps
  [`${SHARES} 0x9e587fb6`]: word(0), // yearStart
  [`${SHARES} 0xfc49192b`]: word(0), // yearBase
  [`${SHARES} 0x8e752da3`]: word(0), // issuedThisYear
  [`${SHARES} 0x83f1211b`]: word(1), // transfersLocked
  [`${SHARES} 0x70740ee9`]: word(1), // unlockNoticeRequired
  [`${SHARES} 0xc7eb62bc`]: word(0), // unlockAnnouncedAt
  [`${SHARES} 0xd0d0a2ae`]: addressWord(`0x${"ac".repeat(20)}`), // transferExempt
  [`${SHARES} 0x18160ddd`]: word(1000n * WAD), // totalSupply
  [`${SHARES} 0x70a08231`]: word(100n * WAD), // balanceOf(DAO)
  [`${SHARES} 0x36bc529d`]: addressWord(LOCK), // lockGuard
  [`${LOCK} 0x56891412`]: word(250n * WAD), // totalLocked
  ...over,
});

test("a kit's Shares say their rules, and the Shares that count on exit", async () => {
  const read = await readShareRules(chain(kitShares()), SHARES, DAO);
  assert.equal(read.rules.awardsOnly, true);
  assert.equal(read.rules.issuanceCapBps, 1000);
  assert.equal(read.rules.transfersLocked, true);
  assert.equal(read.rules.unlockNoticeRequired, true);
  assert.equal(read.rules.transferExempt, `0x${"ac".repeat(20)}`);
  // 1000 in all, 100 the DAO's own, 250 still locked: 650 count when someone leaves.
  assert.equal(read.exitBase, 650n * WAD);
});

test("Shares made before the rules (the read is refused) say so, instead of an error", async () => {
  const answers = kitShares();
  delete answers[`${SHARES} 0x0704ab61`];
  const read = await readShareRules(chain(answers), SHARES, DAO);
  assert.equal(read.rules, null);
  assert.equal(read.predates, true);
});

test("a network that does not answer is an error, never a DAO without rules", async () => {
  await assert.rejects(
    readShareRules(
      chain(kitShares({ [`${SHARES} 0x0704ab61`]: new Error("rpc http 503") })),
      SHARES,
      DAO,
    ),
  );
});

test("with no lock the exit base is everything outside the DAO", async () => {
  const read = await readShareRules(
    chain(
      kitShares({
        [`${SHARES} 0x36bc529d`]: addressWord(`0x${"0".repeat(40)}`),
      }),
    ),
    SHARES,
    DAO,
  );
  assert.equal(read.exitBase, 900n * WAD);
});

test("the allowance is said in plain words", async () => {
  const { allowanceText } = await import("./share-rules.ts");
  const day = (s) => `day ${s}`;
  assert.equal(
    allowanceText(
      { kind: "capped", left: 25n * WAD, of: 65n * WAD, resetsAt: 1000 },
      day,
    ),
    "25 of this year's 65 new Shares are left to award, until day 1000. New Shares are only ever pay for accepted work.",
  );
  assert.equal(
    allowanceText(
      { kind: "capped", left: 65n * WAD, of: 65n * WAD, resetsAt: null },
      day,
    ),
    "Up to 65 new Shares can be awarded in the year that starts with the next award. New Shares are only ever pay for accepted work.",
  );
  assert.equal(
    allowanceText({ kind: "awards-only" }, day),
    "New Shares are only ever pay for accepted work, with no yearly limit.",
  );
  assert.equal(allowanceText({ kind: "none" }, day), null);
  assert.equal(allowanceText(null, day), null);
});
