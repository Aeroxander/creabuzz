import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeFunctionData } from "./evmAbi.ts";
import {
  SIGNATURES,
  TOPIC_CLAIM_SUBMITTED,
  TOPIC_MANDATE_CREATED,
  TOPIC_PROJECT_APPROVED,
  TOPIC_VERIFIER_ACCEPTED,
  addressTopic,
  encodeCall0,
  encodeCallId,
  encodeIsReviewer,
  encodeUnbonds,
  idWord,
} from "./work.ts";
import { MAX_CLAIMS, readWork } from "./workRead.ts";

const word = (value) => BigInt(value).toString(16).padStart(64, "0");
const words = (...values) => `0x${values.map(word).join("")}`;
const DAO = "0x00000000000000000000000000000000000000d0";
const POLICY = "0x00000000000000000000000000000000000000a1";
const FACTORY = "0x00000000000000000000000000000000000000f1";
const MANDATE = "0x00000000000000000000000000000000000000b1";
const CLAIMS = "0x00000000000000000000000000000000000000c1";
const VERIFIERS = "0x00000000000000000000000000000000000000e1";
const CURRENCY = "0x00000000000000000000000000000000000000cc";
const DAVE = "0x00000000000000000000000000000000000000da";
const BOB = "0x0000000000000000000000000000000000000b0b";
const ALICE = "0x000000000000000000000000000000000000a11c";
const ERIN = "0x00000000000000000000000000000000000000ee";
const PROJECT = idWord("docs");

const key = (to, data) => `${to.toLowerCase()}:${data.toLowerCase()}`;

/** A chain with one mandate, one project and `claims` claims, each described by `{ id, status, project, approvals }`. */
function chain(claims, over = {}, bond = null) {
  const answers = new Map();
  // Calls that fail the way a slow or dropped node does (no answer), as opposed to one a contract refuses (a revert).
  const failing = new Set();
  const set = (to, data, value) => answers.set(key(to, data), value);
  set(DAO, encodeCall0(SIGNATURES.policy), words(POLICY));
  set(POLICY, encodeCall0(SIGNATURES.factory), words(FACTORY));
  set(MANDATE, encodeCall0(SIGNATURES.mandateClaims), words(CLAIMS));
  set(MANDATE, encodeCall0(SIGNATURES.mandateVerifiers), words(VERIFIERS));
  set(MANDATE, encodeCall0(SIGNATURES.mandateClosed), words(0));
  set(MANDATE, encodeCall0(SIGNATURES.mandateExpiresAt), words(1_893_456_000));
  set(MANDATE, encodeCall0(SIGNATURES.mandateSharesAllocated), words(40));
  set(VERIFIERS, encodeCall0(SIGNATURES.quorum), words(2));
  set(CLAIMS, encodeCall0(SIGNATURES.challengeWindow), words(259_200));
  set(
    MANDATE,
    encodeCallId(SIGNATURES.project, PROJECT),
    words(BOB, 0, 0, 1_893_456_000, `0x${"33".repeat(32)}`, 40, 0),
  );
  set(VERIFIERS, encodeIsReviewer(ALICE), words(1, 0, 0, 0));
  set(VERIFIERS, encodeIsReviewer(BOB), words(0, 0, 0, 0));
  set(CURRENCY, encodeCall0("decimals()"), words(6));
  for (const c of claims) {
    set(
      CLAIMS,
      encodeCallId(SIGNATURES.claim, c.id),
      words(
        DAVE,
        0,
        0,
        c.status,
        `0x${"11".repeat(32)}`,
        `0x${"22".repeat(32)}`,
        0,
        1000,
      ),
    );
    set(
      MANDATE,
      encodeCallId(SIGNATURES.claimProject, c.id),
      words(c.project ?? 0),
    );
    set(MANDATE, encodeCallId(SIGNATURES.awarded, c.id), words(0));
    set(
      VERIFIERS,
      encodeCallId(SIGNATURES.approvalCount, c.id),
      words(c.approvals ?? 0),
    );
    set(VERIFIERS, encodeCallId(SIGNATURES.objectionCount, c.id), words(0));
    set(
      VERIFIERS,
      encodeFunctionData(
        "attested(bytes32,address)",
        ["bytes32", "address"],
        [c.id, ALICE],
      ),
      words(c.attestedByAlice ? 1 : 0),
    );
  }
  const logs = new Map([
    [
      key(FACTORY, TOPIC_MANDATE_CREATED),
      [
        {
          topics: [
            TOPIC_MANDATE_CREATED,
            addressTopic(DAO),
            addressTopic(MANDATE),
          ],
          data: words(CURRENCY, 0, 0, 100, 40),
        },
      ],
    ],
    [
      key(MANDATE, TOPIC_PROJECT_APPROVED),
      [
        {
          topics: [TOPIC_PROJECT_APPROVED, PROJECT, addressTopic(BOB)],
          data: words(0, 40, 1_893_456_000, `0x${"33".repeat(32)}`),
        },
      ],
    ],
    [
      key(CLAIMS, TOPIC_CLAIM_SUBMITTED),
      claims.map((c) => ({
        topics: [TOPIC_CLAIM_SUBMITTED, c.id],
        data: words(DAVE, 0, 0, `0x${"11".repeat(32)}`),
      })),
    ],
  ]);
  // A panel that asks for a bond: the currency and least stake, and each reviewer's stake.
  if (bond) {
    // The bond is paid in the claim currency unless the vote that made the budget named another token.
    const bondToken = bond.token ?? CURRENCY;
    if (bond.metadataUnreadable) {
      failing.add(key(VERIFIERS, encodeCall0(SIGNATURES.bondToken)));
    } else {
      set(VERIFIERS, encodeCall0(SIGNATURES.bondToken), words(bondToken));
    }
    if (bond.minBondUnreadable) {
      failing.add(key(VERIFIERS, encodeCall0(SIGNATURES.minBond)));
    } else {
      set(VERIFIERS, encodeCall0(SIGNATURES.minBond), words(bond.min));
    }
    if (bondToken !== CURRENCY) {
      set(bondToken, encodeCall0("decimals()"), words(18));
      set(
        bondToken,
        encodeCall0("symbol()"),
        `0x${word(32)}${word(4)}${"50524f4a".padEnd(64, "0")}`,
      );
    }
    set(
      CURRENCY,
      encodeCall0("symbol()"),
      `0x${word(32)}${word(4)}${"55534443".padEnd(64, "0")}`,
    );
    logs.set(
      key(VERIFIERS, TOPIC_VERIFIER_ACCEPTED),
      bond.reviewers.map((r) => ({
        topics: [TOPIC_VERIFIER_ACCEPTED, addressTopic(r.address)],
        data: words(0),
      })),
    );
    for (const r of bond.reviewers) {
      if (r.unbondUnreadable) {
        failing.add(key(VERIFIERS, encodeUnbonds(r.address)));
      } else {
        set(
          VERIFIERS,
          encodeUnbonds(r.address),
          words(r.unbond?.amount ?? 0, r.unbond?.availableAt ?? 0),
        );
      }
      if (r.unreadable) {
        failing.add(key(VERIFIERS, encodeIsReviewer(r.address)));
        continue;
      }
      set(VERIFIERS, encodeIsReviewer(r.address), words(1, r.stake, 0, 0));
    }
  }
  const calls = [];
  return {
    calls,
    now: async () => 2_000_000_000,
    call: async (to, data) => {
      calls.push(key(to, data));
      if (failing.has(key(to, data)))
        throw new Error("The chain node did not answer in time.");
      const hit = answers.get(key(to, data));
      // A function the contract does not have is refused, as a real node reports it.
      if (hit === undefined)
        throw new Error(
          `execution reverted: the fake chain has no answer for ${key(to, data)}`,
        );
      return hit;
    },
    logs: async ({ address, topics }) => {
      // The mandate filter must name the DAO (topic 1): another DAO's mandates are not this one's.
      if (address === FACTORY && topics[1] !== addressTopic(DAO)) return [];
      return logs.get(key(address, topics[0])) ?? [];
    },
    ...over,
  };
}

test("a DAO's work reads as mandates, projects and claims, each claim with its state and reviewers", async () => {
  const open = idWord("open-claim");
  const paid = idWord("paid-claim");
  const snapshot = await readWork(
    chain([
      { id: open, status: 0, project: PROJECT, approvals: 1 },
      { id: paid, status: 4, project: PROJECT, approvals: 2 },
    ]),
    DAO,
    ALICE,
  );
  assert.equal(snapshot.mandates.length, 1);
  const [mandate] = snapshot.mandates;
  assert.equal(mandate.address, MANDATE);
  assert.equal(mandate.created.shareBudget, 100n);
  assert.equal(mandate.sharesAllocated, 40n);
  assert.equal(mandate.quorum, 2);
  assert.equal(mandate.challengeWindow, 259_200);
  assert.equal(mandate.projects.length, 1);
  assert.equal(mandate.projects[0].record.manager, BOB);
  assert.deepEqual(
    mandate.claims.map((c) => [c.id, c.record.status, c.approvals, c.project]),
    [
      [open, "Open", 1, PROJECT],
      [paid, "Paid", 2, PROJECT],
    ],
  );
  assert.equal(
    mandate.walletIsReviewer,
    true,
    "the connected wallet is on the panel",
  );
  // A mandate that moves no money reads no currency at all.
  assert.equal(mandate.currency, null);
  assert.equal(snapshot.truncated, false);
  assert.equal(
    snapshot.chainTime,
    2_000_000_000,
    "the chain's own clock, not the browser's",
  );
});

test("the connected wallet's own verdicts are marked, and a wallet-less read asks nothing about one", async () => {
  const id = idWord("c1");
  const withWallet = await readWork(
    chain([{ id, status: 0, project: PROJECT, attestedByAlice: true }]),
    DAO,
    ALICE,
  );
  assert.deepEqual(withWallet.mandates[0].walletAttested, [id]);
  const anon = chain([{ id, status: 0, project: PROJECT }]);
  const read = await readWork(anon, DAO, null);
  assert.equal(read.mandates[0].walletIsReviewer, false);
  assert.deepEqual(read.mandates[0].walletAttested, []);
  assert.equal(
    anon.calls.some((c) => c.includes("81a9894e")),
    false,
    "no attested() reads without a wallet",
  );
});

test("a DAO with no mandates, and a claim nobody can read, are quiet rather than errors", async () => {
  const none = chain([]);
  const empty = await readWork({ ...none, logs: async () => [] }, DAO, null);
  assert.deepEqual(empty, {
    dao: DAO,
    milestonePanel: null,
    chainTime: 2_000_000_000,
    mandates: [],
    truncated: false,
  });
  // A claim whose record is all zeros (it does not exist) is left out.
  const ghost = chain([{ id: idWord("ghost"), status: 0, project: null }]);
  const base = ghost.call;
  const patched = {
    ...ghost,
    call: async (to, data) => {
      const hex = await base(to, data);
      return to === CLAIMS && data.startsWith("0xeff0f592")
        ? `0x${"0".repeat(64 * 8)}`
        : hex;
    },
  };
  const read = await readWork(patched, DAO, null);
  assert.equal(read.mandates[0].claims.length, 0);
});

test("only a bounded number of claims are read, newest first kept, and the read says it was cut", async () => {
  const ids = Array.from({ length: MAX_CLAIMS + 3 }, (_, i) =>
    idWord(`claim-${i}`),
  );
  const snapshot = await readWork(
    chain(ids.map((id) => ({ id, status: 0, project: PROJECT }))),
    DAO,
    null,
  );
  assert.equal(snapshot.mandates[0].claims.length, MAX_CLAIMS);
  assert.equal(
    snapshot.mandates[0].claims[MAX_CLAIMS - 1].id,
    ids[ids.length - 1],
    "the newest claim is kept",
  );
  assert.equal(snapshot.truncated, true);
});

test("a read that fails fails loudly: nothing is shown as empty when it could not be read", async () => {
  const broken = chain([]);
  await assert.rejects(
    readWork(
      { ...broken, call: async () => Promise.reject(new Error("rpc down")) },
      DAO,
      null,
    ),
    /rpc down/,
  );
});

test("a panel that asks for a bond reads as the bond, the reviewers and what each holds", async () => {
  const read = await readWork(
    chain(
      [],
      {},
      {
        min: 50_000_000,
        reviewers: [
          { address: ALICE, stake: 50_000_000 },
          { address: DAVE, stake: 20_000_000 },
          { address: ERIN, stake: 0, unreadable: true },
        ],
      },
    ),
    DAO,
    ALICE,
  );
  const [mandate] = read.mandates;
  assert.deepEqual(mandate.bond, {
    token: CURRENCY,
    minBond: 50_000_000n,
    symbol: "USDC",
    decimals: 6,
  });
  assert.deepEqual(
    mandate.reviewers.map((r) => [r.address, r.stake]),
    [
      [ALICE, 50_000_000n],
      [DAVE, 20_000_000n],
      // A bond that could not be read is unknown, never zero.
      [ERIN, null],
    ],
  );
  assert.equal(mandate.walletStake, 50_000_000n);
  // A bonded panel moves currency, so its currency is read for the amounts.
  assert.deepEqual(mandate.currency, { symbol: "USDC", decimals: 6 });
});

test("a bond paid in another token is read with that token's own name and decimals", async () => {
  const PROJECT_TOKEN = "0x00000000000000000000000000000000000000d1";
  const read = await readWork(
    chain(
      [],
      {},
      {
        token: PROJECT_TOKEN,
        min: 50n * 10n ** 18n,
        reviewers: [{ address: ALICE, stake: 0 }],
      },
    ),
    DAO,
    ALICE,
  );
  const [mandate] = read.mandates;
  assert.deepEqual(mandate.bond, {
    token: PROJECT_TOKEN,
    minBond: 50n * 10n ** 18n,
    symbol: "PROJ",
    decimals: 18,
  });
  // The claim currency is still the currency's own.
  assert.deepEqual(mandate.currency, { symbol: "USDC", decimals: 6 });
});

test("a panel with no bond, or made before bonds existed, asks for none and still lists nobody wrongly", async () => {
  const read = await readWork(chain([]), DAO, ALICE);
  const [mandate] = read.mandates;
  assert.equal(mandate.bond, null);
  assert.deepEqual(mandate.reviewers, []);
  assert.equal(mandate.walletStake, 0n);
});

test("a wallet that is not on the panel holds no bond", async () => {
  const read = await readWork(
    chain([], {}, { min: 50, reviewers: [{ address: DAVE, stake: 70 }] }),
    DAO,
    BOB,
  );
  assert.equal(read.mandates[0].walletStake, 0n);
});

test("the mandate a DAO named as its milestone panel is read as that, and a factory that has no such thing names none", async () => {
  const base = chain([]);
  // A factory made before panels existed has no such function: the fake chain answers nothing, and that is no panel.
  const before = await readWork(base, DAO, null);
  assert.equal(before.milestonePanel, null);
  // A factory that remembers the DAO's panel.
  const named = {
    ...base,
    call: async (to, data) =>
      to === FACTORY &&
      data ===
        encodeFunctionData(SIGNATURES.milestoneMandate, ["address"], [DAO])
        ? words(MANDATE)
        : base.call(to, data),
  };
  const read = await readWork(named, DAO, null);
  assert.equal(read.milestonePanel, MANDATE.toLowerCase());
  assert.ok(
    read.mandates.some(
      (m) => m.address.toLowerCase() === MANDATE.toLowerCase(),
    ),
  );
  // A zero answer is no panel.
  const zero = {
    ...base,
    call: async (to, data) =>
      to === FACTORY &&
      data ===
        encodeFunctionData(SIGNATURES.milestoneMandate, ["address"], [DAO])
        ? words(0)
        : base.call(to, data),
  };
  assert.equal((await readWork(zero, DAO, null)).milestonePanel, null);
});

test("a bond a reviewer asked back is read as an amount and a time, and nothing pending is none", async () => {
  const waiting = await readWork(
    chain(
      [],
      {},
      {
        min: 50_000_000,
        reviewers: [
          {
            address: ALICE,
            stake: 0,
            unbond: { amount: 50_000_000, availableAt: 1_900_000_000 },
          },
        ],
      },
    ),
    DAO,
    ALICE,
  );
  const [mandate] = waiting.mandates;
  assert.equal(mandate.walletStake, 0n);
  assert.deepEqual(mandate.walletUnbond, {
    amount: 50_000_000n,
    availableAt: 1_900_000_000,
  });
  assert.equal(mandate.walletBondUnreadable, false);

  const none = await readWork(
    chain([], {}, { min: 50, reviewers: [{ address: ALICE, stake: 50 }] }),
    DAO,
    ALICE,
  );
  assert.equal(none.mandates[0].walletUnbond, null);
  assert.equal(none.mandates[0].walletBondUnreadable, false);
});

test("a pending bond that cannot be read is reported as unreadable, never as nothing pending", async () => {
  // After asking for the whole bond back the stake is zero, so the pending amount is the only sign of the money.
  const snapshot = await readWork(
    chain(
      [],
      {},
      {
        min: 50_000_000,
        reviewers: [{ address: ALICE, stake: 0, unbondUnreadable: true }],
      },
    ),
    DAO,
    ALICE,
  );
  const [mandate] = snapshot.mandates;
  assert.equal(mandate.walletUnbond, null);
  assert.equal(mandate.walletBondUnreadable, true);
});

test("the wallet's own bond does not depend on the panel listing being readable", async () => {
  const base = chain(
    [],
    {},
    {
      min: 50_000_000,
      reviewers: [{ address: ALICE, stake: 70_000_000 }],
    },
  );
  const noListing = {
    ...base,
    logs: async (filter) => {
      if (filter.address === VERIFIERS) throw new Error("log range too large");
      return base.logs(filter);
    },
  };
  const snapshot = await readWork(noListing, DAO, ALICE);
  assert.equal(snapshot.mandates[0].walletStake, 70_000_000n);
});

test("every reviewer's pending bond is read beside their stake, so a bond asked back stays visible and slashable", async () => {
  const snapshot = await readWork(
    chain(
      [],
      {},
      {
        min: 50_000_000,
        reviewers: [
          // Asked for the whole bond back: stake zero, everything pending.
          {
            address: ALICE,
            stake: 0,
            unbond: { amount: 50_000_000, availableAt: 1_900_000_000 },
          },
          // Asked for part: some still counts, some waits.
          {
            address: BOB,
            stake: 30_000_000,
            unbond: { amount: 20_000_000, availableAt: 1_950_000_000 },
          },
          // Nothing pending.
          { address: ERIN, stake: 50_000_000 },
        ],
      },
    ),
    DAO,
    null,
  );
  const [mandate] = snapshot.mandates;
  const by = Object.fromEntries(mandate.reviewers.map((r) => [r.address, r]));
  assert.equal(by[ALICE].stake, 0n);
  assert.deepEqual(by[ALICE].pending, {
    amount: 50_000_000n,
    availableAt: 1_900_000_000,
  });
  assert.equal(by[BOB].stake, 30_000_000n);
  assert.deepEqual(by[BOB].pending, {
    amount: 20_000_000n,
    availableAt: 1_950_000_000,
  });
  assert.equal(by[ERIN].pending, null);
  assert.equal(by[ERIN].pendingUnreadable, false);
});

test("a reviewer's pending bond that cannot be read is flagged for that reviewer, not read as nothing", async () => {
  const snapshot = await readWork(
    chain(
      [],
      {},
      {
        min: 50_000_000,
        reviewers: [
          { address: ALICE, stake: 0, unbondUnreadable: true },
          { address: BOB, stake: 10_000_000 },
        ],
      },
    ),
    DAO,
    null,
  );
  const by = Object.fromEntries(
    snapshot.mandates[0].reviewers.map((r) => [r.address, r]),
  );
  assert.equal(by[ALICE].pending, null);
  assert.equal(by[ALICE].pendingUnreadable, true);
  assert.equal(by[BOB].pendingUnreadable, false);
});

test("a panel made before bonds existed is bond-free, and that is not the same as a bond that could not be read", async () => {
  // No bond functions at all: the contract refuses the call.
  const legacy = await readWork(chain([]), DAO, ALICE);
  assert.equal(legacy.mandates[0].bond, null);
  assert.equal(legacy.mandates[0].bondUnreadable, false);
  assert.equal(legacy.mandates[0].walletBondUnreadable, false);
});

test("bond terms that cannot be read are reported as unreadable, and a bond waiting to come back is still found", async () => {
  for (const failure of [{ metadataUnreadable: true }, { minBondUnreadable: true }]) {
    const snapshot = await readWork(
      chain(
        [],
        {},
        {
          min: 50_000_000,
          ...failure,
          reviewers: [
            {
              address: ALICE,
              stake: 0,
              unbond: { amount: 50_000_000, availableAt: 1_900_000_000 },
            },
          ],
        },
      ),
      DAO,
      ALICE,
    );
    const [mandate] = snapshot.mandates;
    assert.equal(mandate.bond, null, JSON.stringify(failure));
    assert.equal(mandate.bondUnreadable, true, JSON.stringify(failure));
    // The return surface does not depend on the terms: the pending bond is read regardless.
    assert.deepEqual(mandate.walletUnbond, {
      amount: 50_000_000n,
      availableAt: 1_900_000_000,
    });
    assert.equal(mandate.walletBondUnreadable, false);
  }
});
