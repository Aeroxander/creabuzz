// Leaving and delegating from the Funds tab (D144): an exit that pays nothing is recognised, a send counts only once its
// receipt says it succeeded on the project's network, a refused exit is never "confirmed", the page re-reads once the
// exit lands, and the delegation list offers only named people.
import assert from "node:assert/strict";
import test from "node:test";

import { StepRevertedError } from "./acting-account.ts";
import { delegateChoices } from "./delegate-choices.ts";
import { sendPicked } from "./picked-send.ts";
import {
  buildRagequitPlan,
  confirmedRagequitDeps,
  initialRagequitFlowState,
  onExitLanded,
  ragequitFlowReducer,
  runRagequitFlow,
} from "./ragequit-flow.ts";
import {
  deriveClaimablePosition,
  exitPaysNothing,
} from "./ragequit-position.ts";
import { buildRagequitTx, ETH_TOKEN } from "./ragequit-tx.ts";

const DAO = `0x${"da".repeat(20)}`;
const USDC = `0x${"1c".repeat(20)}`;
const HOLDER = `0x${"a1".repeat(20)}`;
const HASH = `0x${"ab".repeat(32)}`;
const CHAIN = 11155111;
const label = (id) => `network ${id}`;

const tx = () =>
  buildRagequitTx(DAO, {
    tokens: [ETH_TOKEN, USDC],
    sharesToBurn: 300n,
    lootToBurn: 0n,
    forbidden: [],
  });

/** A fake browser wallet: on `chainHex`, answering receipts with `receiptStatus` (null: none ever arrives). */
function fakeWallet({ chainHex = "0xaa36a7", receiptStatus = "0x1" } = {}) {
  const methods = [];
  const sent = [];
  return {
    methods,
    sent,
    async request({ method, params }) {
      methods.push(method);
      if (method === "eth_requestAccounts") return [HOLDER];
      if (method === "eth_chainId") return chainHex;
      if (method === "eth_sendTransaction") {
        sent.push(params[0]);
        return HASH;
      }
      if (method === "eth_getTransactionReceipt") {
        return receiptStatus === null
          ? null
          : { status: receiptStatus, blockNumber: "0x10", gasUsed: "0x5208" };
      }
      throw new Error(`unexpected ${method}`);
    },
  };
}

const fastTiming = () => {
  let t = 0;
  return {
    pollMs: 1,
    timeoutMs: 3,
    sleep: async () => {},
    now: () => t++,
  };
};

/** Run one exit through the production deps over a wallet, and return the flow's final state. */
async function runExitWith(wallet, chainId = CHAIN) {
  let state = initialRagequitFlowState();
  const dispatch = (action) => {
    state = ragequitFlowReducer(state, action);
  };
  const published = [];
  const plan = buildRagequitPlan({ buildTx: tx });
  dispatch({ type: "reset", order: plan.order });
  const deps = confirmedRagequitDeps(
    (calls) =>
      sendPicked({
        kind: "wallet",
        calls,
        chainId,
        passkey: null,
        wallet,
        label,
        walletTiming: fastTiming(),
      }),
    async (receipt) => {
      published.push(receipt);
    },
  );
  await runRagequitFlow(plan, deps, dispatch);
  return { state, published };
}

// ------------------------------------------------------- empty treasury ----

test("an exit from an empty treasury pays nothing, so the screen must ask before the Shares are destroyed", () => {
  const rows = deriveClaimablePosition({
    sharesToBurn: 300n,
    lootToBurn: 0n,
    sharesBalance: 300n,
    lootBalance: 0n,
    sharesTotal: 1000n,
    lootTotal: 0n,
    daoHeld: 0n,
    lockedTotal: 0n,
    pools: [
      { token: ETH_TOKEN, pool: 0n },
      { token: USDC, pool: 0n },
    ],
  });
  assert.equal(exitPaysNothing(rows), true);
  // A share too small to reach one unit pays nothing either.
  const dust = deriveClaimablePosition({
    sharesToBurn: 1n,
    lootToBurn: 0n,
    sharesBalance: 1n,
    lootBalance: 0n,
    sharesTotal: 1000n,
    lootTotal: 0n,
    daoHeld: 0n,
    lockedTotal: 0n,
    pools: [{ token: USDC, pool: 999n }],
  });
  assert.equal(exitPaysNothing(dust), true);
});

test("an exit that pays something in any one currency is not 'pays nothing'", () => {
  const rows = deriveClaimablePosition({
    sharesToBurn: 300n,
    lootToBurn: 0n,
    sharesBalance: 300n,
    lootBalance: 0n,
    sharesTotal: 1000n,
    lootTotal: 0n,
    daoHeld: 0n,
    lockedTotal: 0n,
    pools: [
      { token: ETH_TOKEN, pool: 0n },
      { token: USDC, pool: 10_000_000n },
    ],
  });
  assert.equal(exitPaysNothing(rows), false);
  assert.equal(rows[1].due, 3_000_000n);
});

// ------------------------------------------- confirmed only by a receipt ----

test("a wallet exit is confirmed only once its receipt says it succeeded on the project's network", async () => {
  const wallet = fakeWallet();
  const { state, published } = await runExitWith(wallet);
  assert.equal(state.phase, "done");
  assert.equal(state.receipts.exit.status, "success");
  assert.equal(state.receipts.exit.txHash, HASH);
  assert.equal(published.length, 1);
  // The network is checked before the send, and the receipt read after it.
  assert.ok(
    wallet.methods.indexOf("eth_chainId") <
      wallet.methods.indexOf("eth_sendTransaction"),
  );
  assert.ok(wallet.methods.includes("eth_getTransactionReceipt"));
  // The composed bytes are what the wallet was asked to send.
  assert.equal(wallet.sent[0].data, tx().data);
  assert.equal(wallet.sent[0].to, tx().to);
});

test("a wallet on another network is refused before anything is sent, and nothing is recorded", async () => {
  const wallet = fakeWallet({ chainHex: "0x1" });
  const { state, published } = await runExitWith(wallet);
  assert.equal(wallet.sent.length, 0);
  assert.equal(state.phase, "failed");
  assert.equal(state.steps.exit, "failed");
  assert.match(state.errorMessage ?? "", /chain 1/);
  assert.equal(published.length, 0);
});

test("an exit the chain refused is a failed step, never 'Exit confirmed', and records nothing", async () => {
  const { state, published } = await runExitWith(
    fakeWallet({ receiptStatus: "0x0" }),
  );
  assert.equal(state.phase, "failed");
  assert.equal(state.steps.exit, "failed");
  assert.equal(state.receipts.exit, undefined);
  assert.match(state.errorMessage ?? "", /failed onchain/);
  assert.equal(published.length, 0);
});

test("an exit whose receipt never arrives is not counted as done", async () => {
  const { state, published } = await runExitWith(
    fakeWallet({ receiptStatus: null }),
  );
  assert.equal(state.phase, "failed");
  assert.notEqual(state.steps.exit, "done");
  assert.equal(published.length, 0);
});

test("confirmedRagequitDeps maps a refused step to a reverted receipt and passes other failures on", async () => {
  const reverted = confirmedRagequitDeps(
    async () => {
      throw new StepRevertedError(HASH);
    },
    async () => {},
  );
  assert.deepEqual(await reverted.send(tx()), {
    txHash: HASH,
    status: "reverted",
  });
  const rejected = confirmedRagequitDeps(
    async () => {
      throw new Error("You closed the passkey prompt");
    },
    async () => {},
  );
  await assert.rejects(rejected.send(tx()), /passkey prompt/);
});

test("a passkey account that works on another network is refused before it is asked", async () => {
  let asked = 0;
  await assert.rejects(
    sendPicked({
      kind: "passkey",
      calls: [{ to: DAO, data: "0x", value: "0x0" }],
      chainId: CHAIN,
      passkey: {
        chainId: 84532,
        sendCalls: async () => {
          asked += 1;
          return { txHash: HASH, status: "confirmed", userOps: [] };
        },
      },
      wallet: undefined,
      label,
    }),
    /works on network 84532, but this is on network 11155111/,
  );
  assert.equal(asked, 0);
});

test("a project that names no network sends nothing", async () => {
  const wallet = fakeWallet();
  await assert.rejects(
    sendPicked({
      kind: "wallet",
      calls: [{ to: DAO, data: "0x", value: "0x0" }],
      chainId: 0,
      passkey: null,
      wallet,
      label,
    }),
    /which network/,
  );
  assert.equal(wallet.methods.length, 0);
});

// ----------------------------------------------------- re-read on landing ----

test("the page is re-read once, when the exit lands, even if saving the record then fails", async () => {
  let state = initialRagequitFlowState();
  let rereads = 0;
  const dispatch = onExitLanded(
    (action) => {
      state = ragequitFlowReducer(state, action);
    },
    () => {
      rereads += 1;
    },
  );
  const plan = buildRagequitPlan({ buildTx: tx });
  dispatch({ type: "reset", order: plan.order });
  const deps = confirmedRagequitDeps(
    async () => HASH,
    async () => {
      throw new Error("the server refused the record");
    },
  );
  await runRagequitFlow(plan, deps, dispatch);
  assert.equal(state.steps.exit, "done");
  assert.equal(state.steps.mirror, "failed");
  assert.equal(rereads, 1);
});

test("a failed exit does not re-read as if it landed", async () => {
  let rereads = 0;
  const dispatch = onExitLanded(
    () => {},
    () => {
      rereads += 1;
    },
  );
  const plan = buildRagequitPlan({ buildTx: tx });
  await runRagequitFlow(
    plan,
    confirmedRagequitDeps(
      async () => {
        throw new StepRevertedError(HASH);
      },
      async () => {},
    ),
    dispatch,
  );
  assert.equal(rereads, 0);
});

// ------------------------------------------------------ delegation list ----

test("delegation offers named people who hold Shares, never the DAO, a contract or an address two people claim", () => {
  const alice = `0x${"a1".repeat(20)}`;
  const bob = `0x${"b0".repeat(20)}`;
  const budget = `0x${"b1".repeat(20)}`;
  const shared = `0x${"5a".repeat(20)}`;
  const choices = delegateChoices({
    holders: [DAO, alice, budget, shared, bob],
    people: [
      { pubkey: "pa", address: alice.toUpperCase().replace("0X", "0x") },
      { pubkey: "pb", address: bob },
      { pubkey: "p1", address: shared },
      { pubkey: "p2", address: shared },
      { pubkey: "pd", address: DAO },
    ],
    nameOf: (pubkey) =>
      ({ pa: "Alice", pb: " ", p1: "X", p2: "Y", pd: "Dao" })[pubkey] ?? null,
    exclude: [DAO],
  });
  assert.deepEqual(choices, [
    { value: alice, label: `Alice (${alice.slice(0, 6)}…${alice.slice(-4)})` },
  ]);
});
