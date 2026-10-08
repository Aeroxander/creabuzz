import assert from "node:assert/strict";
import { test } from "node:test";

import { encodeFunctionData, selectorOf } from "./evmAbi.ts";
import {
  DECISION_STATES,
  MAX_DECISIONS,
  openedIntentsIn,
  readDecisions,
  SIGNATURES_DECISIONS,
  TOPIC_OPENED,
} from "./decisions.ts";

const DAO = "0x00000000000000000000000000000000000000d0";
const POLICY = "0x00000000000000000000000000000000000000e0";
const WALLET = "0x00000000000000000000000000000000000000aa";
const PROPOSER = "0x00000000000000000000000000000000000000bb";
const WAD = 10n ** 18n;

const word = (v) => BigInt(v).toString(16).padStart(64, "0");
const hex = (...words) => `0x${words.map(word).join("")}`;
const intent = (n, data = "0xdeadbeef") => ({
  op: 0,
  to: "0x00000000000000000000000000000000000000cc",
  value: 0n,
  data,
  nonce: `0x${word(n)}`,
});
const openCall = (i) =>
  encodeFunctionData(
    SIGNATURES_DECISIONS.open,
    ["uint8", "address", "uint256", "bytes", "bytes32"],
    [BigInt(i.op), i.to, i.value, i.data, i.nonce],
  );

test("selectors and the event topic are the contracts', as cast computes them", () => {
  // cast sig / cast keccak
  assert.equal(selectorOf(SIGNATURES_DECISIONS.count), "0xc08cc02d");
  assert.equal(selectorOf(SIGNATURES_DECISIONS.idAt), "0x9b644a23");
  assert.equal(selectorOf(SIGNATURES_DECISIONS.state), "0x3e4f49e6");
  assert.equal(selectorOf(SIGNATURES_DECISIONS.proposer), "0x083ce0cf");
  assert.equal(selectorOf(SIGNATURES_DECISIONS.createdAt), "0x50a1676e");
  assert.equal(selectorOf(SIGNATURES_DECISIONS.queuedAt), "0x9ac498de");
  assert.equal(selectorOf(SIGNATURES_DECISIONS.threshold), "0xb58131b0");
  assert.equal(selectorOf(SIGNATURES_DECISIONS.capacity), "0x5694c2da");
  assert.equal(selectorOf(SIGNATURES_DECISIONS.proposalId), "0x997506ba");
  assert.equal(selectorOf(SIGNATURES_DECISIONS.open), "0xe1d5ec31");
  assert.equal(
    TOPIC_OPENED,
    "0x172c33747eee71b1ba8af6539917ac17e9fa6a14066df5b2552707e6cda4dae8",
  );
});

test("the opening call is found whether the transaction is the call or a wallet's wrapper around it", () => {
  const i = intent(1);
  const direct = openedIntentsIn(openCall(i));
  assert.deepEqual(direct, [i]);
  const wrapped = openedIntentsIn(
    `0x12345678${"00".repeat(40)}${openCall(i).slice(2)}${"ff".repeat(10)}`,
  );
  assert.deepEqual(wrapped, [i]);
  assert.deepEqual(openedIntentsIn("0x"), []);
  assert.deepEqual(openedIntentsIn("0xe1d5ec31"), []);
  // The right selector followed by nonsense is not an action.
  assert.deepEqual(openedIntentsIn(`0xe1d5ec31${"ff".repeat(200)}`), []);
});

/** A fake DAO with `ids.length` decisions; `actions[i]` is what decision i's opening transaction carries. */
function world({
  ids,
  actions = {},
  wrapped = {},
  states = {},
  queued = {},
  supportEmpty = false,
}) {
  const asked = [];
  const proposalIdOf = new Map(); // calldata of the proposalId view -> id
  for (const [index, id] of ids.entries()) {
    const a = actions[index];
    if (a) {
      proposalIdOf.set(
        encodeFunctionData(
          SIGNATURES_DECISIONS.proposalId,
          ["uint8", "address", "uint256", "bytes", "bytes32"],
          [BigInt(a.op), a.to, a.value, a.data, a.nonce],
        ).toLowerCase(),
        id,
      );
    }
  }
  const rules = (reviewEnds) =>
    hex(
      1000n * WAD,
      200n * WAD,
      0,
      6600,
      reviewEnds,
      reviewEnds + 100_000,
      86_400,
      43_200,
      0,
      1,
    );
  return {
    asked,
    async now() {
      return 1_700_000_000;
    },
    async input(tx) {
      const index = Number(tx.slice(-4));
      if (wrapped[index]) return wrapped[index];
      return actions[index] ? openCall(actions[index]) : null;
    },
    async logs(filter) {
      asked.push(filter);
      assert.equal(filter.address, DAO);
      assert.equal(filter.topics[0], TOPIC_OPENED);
      const id = BigInt(filter.topics[1]);
      const index = ids.findIndex((x) => x === id);
      return [
        {
          transactionHash: `0x${"00".repeat(30)}${String(index).padStart(4, "0")}`,
        },
      ];
    },
    async call(to, data) {
      const sel = data.slice(0, 10);
      const arg = (n = 0) =>
        BigInt(`0x${data.slice(10 + n * 64, 10 + (n + 1) * 64)}`);
      if (to === DAO) {
        if (sel === selectorOf(SIGNATURES_DECISIONS.count))
          return hex(ids.length);
        if (sel === selectorOf(SIGNATURES_DECISIONS.idAt))
          return hex(ids[Number(arg())]);
        if (sel === selectorOf("votingWeight()")) return hex(POLICY);
        if (sel === selectorOf(SIGNATURES_DECISIONS.threshold))
          return hex(10n * WAD);
        const index = ids.indexOf(arg());
        if (sel === selectorOf(SIGNATURES_DECISIONS.state))
          return hex(states[index] ?? 1);
        if (sel === selectorOf(SIGNATURES_DECISIONS.proposer))
          return hex(PROPOSER);
        if (sel === selectorOf(SIGNATURES_DECISIONS.createdAt))
          return hex(1_699_000_000 + index);
        if (sel === selectorOf(SIGNATURES_DECISIONS.queuedAt))
          return hex(queued[index] ?? 0);
        if (sel === "0xb1f792c9") return rules(1_699_100_000);
        if (sel === "0x4bcaf6aa")
          return supportEmpty
            ? "0x"
            : hex(300n * WAD, 5n * WAD, 0, 1_699_500_000);
        if (sel === selectorOf(SIGNATURES_DECISIONS.proposalId)) {
          const id = proposalIdOf.get(data.toLowerCase());
          return hex(id ?? 0xdeadn);
        }
      }
      if (to === POLICY && sel === selectorOf(SIGNATURES_DECISIONS.capacity))
        return hex(25n * WAD);
      throw new Error(`unexpected call ${to} ${sel}`);
    },
  };
}

test("decisions are read newest first with their state, support and the action their opening carried", async () => {
  const chain = world({
    ids: [101n, 202n, 303n],
    actions: { 0: intent(1), 2: intent(3) },
    states: { 0: 6, 1: 1, 2: 3 },
    queued: { 2: 1_699_900_000 },
  });
  const snapshot = await readDecisions(chain, DAO, WALLET);
  assert.equal(snapshot.total, 3);
  assert.equal(snapshot.truncated, false);
  assert.equal(snapshot.policy, POLICY);
  assert.equal(snapshot.proposalThreshold, 10n * WAD);
  assert.equal(snapshot.walletCapacity, 25n * WAD);
  assert.deepEqual(
    snapshot.decisions.map((d) => [BigInt(d.id), d.state]),
    [
      [303n, "Succeeded"],
      [202n, "Active"],
      [101n, "Executed"],
    ],
  );
  const [newest, middle, oldest] = snapshot.decisions;
  assert.deepEqual(newest.action, intent(3));
  assert.equal(newest.queuedAt, 1_699_900_000);
  assert.equal(newest.proposer, PROPOSER);
  assert.equal(newest.rules.approvalBps, 6600n);
  assert.equal(newest.support.yes, 300n * WAD);
  assert.equal(newest.support.qualifiedSince, 1_699_500_000n);
  // Opened without an action in its call: nothing to run, and nothing invented.
  assert.equal(middle.action, null);
  assert.deepEqual(oldest.action, intent(1));
  assert.equal(DECISION_STATES[2], "Queued");
});

test("an action that does not hash to the proposal's id is never shown as its action", async () => {
  // Decision 0's transaction carries an action, but the DAO's own id for it is something else.
  const chain = world({ ids: [101n], actions: { 0: intent(1) } });
  const base = chain.call;
  chain.call = async (to, data) =>
    data.startsWith(selectorOf(SIGNATURES_DECISIONS.proposalId))
      ? hex(999n)
      : base(to, data);
  const snapshot = await readDecisions(chain, DAO, null);
  assert.equal(snapshot.decisions[0].action, null);
  assert.equal(snapshot.walletCapacity, null);
});

test("a wallet's wrapper around the opening call still yields the action", async () => {
  const i = intent(7);
  const chain = world({
    ids: [101n],
    actions: { 0: i },
    wrapped: { 0: `0xabcdef01${"00".repeat(64)}${openCall(i).slice(2)}` },
  });
  const snapshot = await readDecisions(chain, DAO, null);
  assert.deepEqual(snapshot.decisions[0].action, i);
});

test("only the newest few are read, and the page says there were more", async () => {
  const ids = Array.from({ length: MAX_DECISIONS + 7 }, (_, n) =>
    BigInt(n + 1),
  );
  const chain = world({ ids });
  const snapshot = await readDecisions(chain, DAO, null);
  assert.equal(snapshot.total, MAX_DECISIONS + 7);
  assert.equal(snapshot.decisions.length, MAX_DECISIONS);
  assert.equal(snapshot.truncated, true);
  assert.equal(BigInt(snapshot.decisions[0].id), BigInt(MAX_DECISIONS + 7));
  assert.equal(chain.asked.length, MAX_DECISIONS);
});

test("a DAO with no decisions reads as none", async () => {
  const snapshot = await readDecisions(world({ ids: [] }), DAO, WALLET);
  assert.deepEqual(snapshot.decisions, []);
  assert.equal(snapshot.total, 0);
});

test("a proposal whose rules read as unopened has none, and empty support reads as no support", async () => {
  const chain = world({ ids: [5n], supportEmpty: true });
  const snapshot = await readDecisions(chain, DAO, null);
  assert.equal(snapshot.decisions[0].support.yes, 0n);
});
