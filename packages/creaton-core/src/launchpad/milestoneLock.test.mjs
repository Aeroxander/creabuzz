import assert from "node:assert/strict";
import { test } from "node:test";
import {
  encodeUnlock,
  findUnlockOffers,
  LOCK_SIGNATURES,
  MAX_LOCK_TRANCHES,
  readMilestoneLock,
  SELECTOR_LOCK_UNLOCK,
} from "./milestoneLock.ts";
import { selectorOf } from "./evmAbi.ts";

const DAO = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHARES = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const LOCK = "0xcccccccccccccccccccccccccccccccccccccccc";
const HOLDER = "0x1111111111111111111111111111111111111111";
const MANDATE = "0x2222222222222222222222222222222222222222";
const CLAIMS = "0x4444444444444444444444444444444444444444";
const CHECK_A = `0x${"a1".repeat(32)}`;
const CHECK_B = `0x${"b2".repeat(32)}`;
const CLAIM = `0x${"33".repeat(32)}`;
const WAD = 10n ** 18n;

const word = (v) => BigInt(v).toString(16).padStart(64, "0");
const hex = (...words) => `0x${words.map(word).join("")}`;

test("the selectors are the contract's, as cast computes them", () => {
  // cast sig "<signature>"
  assert.equal(selectorOf(LOCK_SIGNATURES.lockedOf), "0xa5f1e282");
  assert.equal(selectorOf(LOCK_SIGNATURES.trancheCount), "0x29dc62b4");
  assert.equal(selectorOf(LOCK_SIGNATURES.trancheOf), "0x1141e136");
  assert.equal(selectorOf(LOCK_SIGNATURES.claimUsed), "0x99f94531");
  assert.equal(selectorOf(LOCK_SIGNATURES.sharesLockGuard), "0x36bc529d");
  assert.equal(selectorOf(LOCK_SIGNATURES.daoShares), "0x03314efa");
  assert.equal(SELECTOR_LOCK_UNLOCK, "0x33484b20");
});

test("the unlock calldata is exactly what cast encodes", () => {
  // cast calldata "unlock(address,uint256,address,bytes32)" 0x1111… 1 0x2222… 0x3333…
  assert.equal(
    encodeUnlock(HOLDER, 1, MANDATE, `0x${"33".repeat(32)}`),
    "0x33484b200000000000000000000000001111111111111111111111111111111111111111000000000000000000000000000000000000000000000000000000000000000100000000000000000000000022222222222222222222222222222222222222223333333333333333333333333333333333333333333333333333333333333333",
  );
});

test("an unlock that could never work is refused before a wallet is asked", () => {
  assert.throws(() => encodeUnlock("0x12", 0, MANDATE, CLAIM), /beneficiary/);
  assert.throws(() => encodeUnlock(HOLDER, 0, "nope", CLAIM), /mandate/);
  assert.throws(() => encodeUnlock(HOLDER, 0, MANDATE, "0x12"), /claim id/);
  assert.throws(
    () => encodeUnlock(HOLDER, -1, MANDATE, CLAIM),
    /does not exist/,
  );
  assert.throws(
    () => encodeUnlock(HOLDER, MAX_LOCK_TRANCHES, MANDATE, CLAIM),
    /does not exist/,
  );
});

/** A fake chain that answers by selector, recording what was asked. */
function fakeChain({ lockGuard = LOCK, tranches = [], used = [] } = {}) {
  const asked = [];
  return {
    asked,
    async call(to, data) {
      asked.push({ to, data });
      const sel = data.slice(0, 10);
      if (to === DAO && sel === selectorOf("shares()")) return hex(SHARES);
      if (to === SHARES && sel === selectorOf("lockGuard()")) {
        return hex(lockGuard);
      }
      if (to === LOCK && sel === selectorOf(LOCK_SIGNATURES.lockedOf)) {
        return hex(
          tranches
            .filter((t) => !t.unlocked && !t.forfeited)
            .reduce((a, t) => a + t.amount, 0n),
        );
      }
      if (to === LOCK && sel === selectorOf(LOCK_SIGNATURES.trancheCount)) {
        return hex(tranches.length);
      }
      if (to === LOCK && sel === selectorOf(LOCK_SIGNATURES.trancheOf)) {
        const i = Number(BigInt(`0x${data.slice(-64)}`));
        const t = tranches[i];
        return hex(t.check, t.amount, t.unlocked ? 1 : 0, t.forfeited ? 1 : 0);
      }
      if (to === LOCK && sel === selectorOf(LOCK_SIGNATURES.claimUsed)) {
        return hex(used.includes(`0x${data.slice(-64)}`) ? 1 : 0);
      }
      throw new Error(`unexpected call ${to} ${sel}`);
    },
  };
}

const T = (check, amount, over = {}) => ({ check, amount, ...over });

test("the lock is read from the Shares contract: its tranches and what is still held back", async () => {
  const chain = fakeChain({
    tranches: [
      T(CHECK_A, 40n * WAD),
      T(CHECK_B, 60n * WAD, { unlocked: true }),
    ],
  });
  const view = await readMilestoneLock(chain, DAO, HOLDER);
  assert.equal(view.lock, LOCK);
  assert.equal(view.locked, 40n * WAD);
  assert.deepEqual(
    view.tranches.map((t) => [t.index, t.checkHash, t.amount, t.unlocked]),
    [
      [0, CHECK_A, 40n * WAD, false],
      [1, CHECK_B, 60n * WAD, true],
    ],
  );
});

test("a DAO whose Shares name no lock has nothing locked", async () => {
  const none = fakeChain({ lockGuard: `0x${"0".repeat(40)}` });
  assert.equal(await readMilestoneLock(none, DAO, HOLDER), null);
});

test("a holder with no tranches reads as nothing locked", async () => {
  const view = await readMilestoneLock(fakeChain(), DAO, HOLDER);
  assert.equal(view.locked, 0n);
  assert.deepEqual(view.tranches, []);
});

test("a lock claiming more tranches than a lock can have is read only as far as one can", async () => {
  const chain = fakeChain({
    tranches: Array.from({ length: 12 }, () => T(CHECK_A, WAD)),
  });
  const view = await readMilestoneLock(chain, DAO, HOLDER);
  assert.equal(view.tranches.length, MAX_LOCK_TRANCHES);
});

const claim = (over = {}, record = {}) => ({
  id: CLAIM,
  record: {
    contributor: HOLDER,
    amount: 0n,
    stake: 0n,
    status: "Paid",
    evidenceHash: `0x${"ee".repeat(32)}`,
    checkHash: CHECK_A,
    expiresAt: 0,
    releasedAt: 0,
    ...record,
  },
  project: `0x${"77".repeat(32)}`,
  approvals: 2,
  objections: 0,
  quorum: 2,
  sharesAwarded: false,
  ...over,
});
const work = (...claims) => ({
  dao: DAO,
  milestonePanel: null,
  chainTime: 1,
  truncated: false,
  mandates: [{ address: MANDATE, claimsAddress: CLAIMS, claims }],
});
const lockView = (overrides = {}) => ({
  lock: LOCK,
  holder: HOLDER,
  locked: 40n * WAD,
  tranches: [
    {
      index: 0,
      checkHash: CHECK_A,
      amount: 40n * WAD,
      unlocked: false,
      forfeited: false,
    },
  ],
  ...overrides,
});

test("a paid claim of the holder's, against the milestone's exact words, unlocks it", async () => {
  const offers = await findUnlockOffers(fakeChain(), lockView(), work(claim()));
  assert.deepEqual(
    offers.map((o) => [o.tranche.index, o.mandate, o.claimId]),
    [[0, MANDATE, CLAIM]],
  );
});

test("a claim that would not be accepted is never offered", async () => {
  const cases = {
    "someone else's": claim({}, { contributor: MANDATE }),
    "not yet paid": claim({}, { status: "Approved" }),
    "against other words": claim({}, { checkHash: CHECK_B }),
    "not bound to a project": claim({ project: null }),
  };
  for (const [name, c] of Object.entries(cases)) {
    assert.deepEqual(
      await findUnlockOffers(fakeChain(), lockView(), work(c)),
      [],
      name,
    );
  }
  // Spent on another tranche already: the lock is asked.
  assert.deepEqual(
    await findUnlockOffers(
      fakeChain({ used: [CLAIM] }),
      lockView(),
      work(claim()),
    ),
    [],
  );
});

test("a milestone already reached or given up is not offered again", async () => {
  for (const state of [{ unlocked: true }, { forfeited: true }]) {
    const view = lockView({
      tranches: [
        {
          index: 0,
          checkHash: CHECK_A,
          amount: WAD,
          unlocked: false,
          forfeited: false,
          ...state,
        },
      ],
    });
    assert.deepEqual(
      await findUnlockOffers(fakeChain(), view, work(claim())),
      [],
    );
  }
});

test("one claim is offered for one milestone only, even when two are worded alike", async () => {
  const view = lockView({
    tranches: [
      {
        index: 0,
        checkHash: CHECK_A,
        amount: WAD,
        unlocked: false,
        forfeited: false,
      },
      {
        index: 1,
        checkHash: CHECK_A,
        amount: WAD,
        unlocked: false,
        forfeited: false,
      },
    ],
  });
  const offers = await findUnlockOffers(fakeChain(), view, work(claim()));
  assert.equal(offers.length, 1);
  assert.equal(offers[0].tranche.index, 0);
});

test("when the DAO named its milestone panel, only that mandate's claims are offered", async () => {
  const OTHER = "0x00000000000000000000000000000000000000f1";
  const both = (panel) => ({
    dao: DAO,
    milestonePanel: panel,
    chainTime: 1,
    truncated: false,
    mandates: [
      { address: OTHER, claimsAddress: CLAIMS, claims: [claim()] },
      {
        address: MANDATE,
        claimsAddress: CLAIMS,
        claims: [claim({ id: `0x${"c2".repeat(32)}` })],
      },
    ],
  });
  // No panel named: the first mandate with a paid claim will do, as before.
  const any = await findUnlockOffers(fakeChain(), lockView(), both(null));
  assert.deepEqual(
    any.map((o) => o.mandate),
    [OTHER],
  );
  // A panel named: the other mandate's claim is not offered, because the lock would refuse it.
  const named = await findUnlockOffers(
    fakeChain(),
    lockView(),
    both(MANDATE.toLowerCase()),
  );
  assert.deepEqual(
    named.map((o) => o.mandate),
    [MANDATE],
  );
  // A panel with no paid claim offers nothing, however many claims the others hold.
  const none = {
    ...both(MANDATE.toLowerCase()),
    mandates: [both(null).mandates[0]],
  };
  assert.deepEqual(await findUnlockOffers(fakeChain(), lockView(), none), []);
});
