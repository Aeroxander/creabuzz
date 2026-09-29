import assert from "node:assert/strict";
import test from "node:test";

import {
  checkGraduationReadiness,
  decodeBoolStrict,
  GRADUATION_STEPS,
  graduationFlowReducer,
  graduationRetryPlan,
  initialGraduationState,
  runGraduationFlow,
} from "./graduationFlow.ts";
import {
  GRADUATION_TX_HASH_RE,
  graduationTxStore,
} from "./graduation-progress.ts";
import { USER_REJECTED_MESSAGE } from "./wallet-errors.ts";

const TX1 = `0x${"11".repeat(32)}`;
const AUCTION = `0x${"aa".repeat(20)}`;
const EXECUTOR = `0x${"bb".repeat(20)}`;

const RECORD = {
  initialPriceX96: 7n,
  tokensSold: 8n,
  currencyRaised: 9n,
  reserveEscrow: 4n,
  treasuryShare: 5n,
  unsoldTokens: 6n,
  tokenMasterPool: `0x${"00".repeat(20)}`,
  executed: true,
};

const EXECUTION = {
  auction: AUCTION,
  executor: EXECUTOR,
  call: { to: EXECUTOR, data: "0x69d4d0f1", value: "0x0" },
};

const ORDER = GRADUATION_STEPS.map((s) => s.id);

function collector() {
  const actions = [];
  return { actions, dispatch: (action) => actions.push(action) };
}

function resetState() {
  return graduationFlowReducer(initialGraduationState(), {
    type: "reset",
    order: ORDER,
  });
}

function foldActions(actions) {
  return actions.reduce(graduationFlowReducer, resetState());
}

/** Map-backed Web Storage fake — the seam `graduationTxStore` takes. */
function fakeStorage() {
  const backing = new Map();
  return {
    backing,
    getItem: (key) => backing.get(key) ?? null,
    setItem: (key, value) => backing.set(key, value),
    removeItem: (key) => backing.delete(key),
  };
}

/** Scripted graduation deps with a Map-backed `progress` store. */
function scripted({ before, after = RECORD, storage = fakeStorage() } = {}) {
  const calls = { sends: 0, reads: 0, publishes: [] };
  const progress = graduationTxStore(AUCTION, storage);
  return {
    calls,
    storage,
    progress,
    deps: {
      send: async () => {
        calls.sends += 1;
        return {
          txHash: TX1,
          status: "success",
          blockNumber: 1,
          gasUsed: "1",
          contractAddress: null,
        };
      },
      readGraduation: async () => {
        calls.reads += 1;
        return calls.reads === 1 ? before : after;
      },
      publishReceipt: async (kind, parts) => {
        calls.publishes.push({ kind, parts });
      },
      progress,
    },
  };
}

// ---------------------------------------------------------------------------
// Defect 1: a declined wallet prompt is a known outcome
// ---------------------------------------------------------------------------

test("a declined execute reads as declined — never as an unknown broadcast", async () => {
  const { actions, dispatch } = collector();
  const deps = {
    send: async () => {
      throw new Error(USER_REJECTED_MESSAGE);
    },
    readGraduation: async () => ({ ...RECORD, executed: false }),
    publishReceipt: async () => {},
  };
  await runGraduationFlow(EXECUTION, deps, dispatch);
  const failure = actions.find((a) => a.type === "step-failed");
  assert.ok(failure, "the failure is named");
  assert.equal(failure.step, "execute");
  assert.match(failure.message, /declined the step/i);
  assert.match(failure.message, /nothing was sent/i);
  assert.match(failure.message, /Nothing else has run yet/);
  assert.match(failure.message, /Retry remaining steps/, "how to continue");
  assert.doesNotMatch(failure.message, /may or may not/);
});

// ---------------------------------------------------------------------------
// Defect 2: cross-reload tx-hash loss is terminal, with real recovery
// ---------------------------------------------------------------------------

test("the confirmed execute hash is persisted the moment send returns", async () => {
  const s = scripted({ before: { ...RECORD, executed: false } });
  await runGraduationFlow(EXECUTION, s.deps, collector().dispatch);
  assert.equal(s.progress.load(), TX1);
});

test("after a reload the persisted hash resumes and publishes the mirrors", async () => {
  const s = scripted({ before: RECORD });
  // What the pre-reload session persisted at send time.
  s.progress.save(TX1);
  const { actions, dispatch } = collector();
  // A fresh session: empty resume set, only the persisted hash.
  await runGraduationFlow(EXECUTION, s.deps, dispatch);
  assert.equal(s.calls.sends, 0, "the landed money action is never re-sent");
  assert.deepEqual(
    s.calls.publishes.map((p) => p.parts.extraTags[1]),
    [
      ["tx", TX1],
      ["tx", TX1],
    ],
  );
  const state = foldActions(actions);
  assert.equal(state.phase, "done");
  assert.equal(state.graduationTxHash, TX1);
});

test("with no hash anywhere the plan is terminal (supply-hash), never a mirror loop", async () => {
  const s = scripted({ before: RECORD });
  const { actions, dispatch } = collector();
  await runGraduationFlow(EXECUTION, s.deps, dispatch);
  assert.equal(s.calls.sends, 0);
  assert.equal(s.calls.publishes.length, 0, "no receipt can be bound");
  const state = foldActions(actions);
  assert.equal(state.phase, "failed");
  assert.equal(state.txHashMissing, true);
  const plan = graduationRetryPlan(state);
  assert.deepEqual(plan, { kind: "supply-hash" });
  assert.notDeepEqual(plan, { kind: "mirror" });
});

test("a manually supplied hash is persisted through graduation-progress and resumes", async () => {
  const s = scripted({ before: RECORD });
  await runGraduationFlow(EXECUTION, s.deps, collector().dispatch);
  // The panel's recovery affordance: persist the hash the founder supplied…
  s.progress.save(TX1);
  // …and the retry it triggers resumes the mirrors from it.
  const second = collector();
  await runGraduationFlow(EXECUTION, s.deps, second.dispatch, {
    completed: new Set(["execute"]),
    graduationTxHash: null,
  });
  assert.equal(s.calls.sends, 0, "the money action is never re-sent");
  assert.deepEqual(
    s.calls.publishes.map((p) => p.kind),
    ["sweep", "lock"],
  );
  for (const { parts } of s.calls.publishes) {
    assert.deepEqual(parts.extraTags[1], ["tx", TX1]);
  }
});

test("graduationTxStore: per-launch key, one atomic write, corrupt entries dropped", () => {
  const storage = fakeStorage();
  const store = graduationTxStore("launch-1", storage);
  assert.equal(store.load(), null);
  assert.throws(() => store.save("not-a-hash"), /malformed tx hash/);
  assert.equal(store.load(), null, "garbage is never stored");
  assert.ok(GRADUATION_TX_HASH_RE.test(TX1));
  store.save(TX1);
  assert.equal(store.load(), TX1);
  assert.equal(
    graduationTxStore("launch-2", storage).load(),
    null,
    "one key per launch",
  );
  storage.setItem("buzz:launchpad:graduation-tx:launch-1", "junk");
  assert.equal(store.load(), null, "a corrupt entry is dropped, not trusted");
  assert.equal(
    storage.backing.has("buzz:launchpad:graduation-tx:launch-1"),
    false,
    "and removed",
  );
  store.save(TX1);
  store.clear();
  assert.equal(store.load(), null);
});

// ---------------------------------------------------------------------------
// Defect 4: strict isGraduated() decode — garbage never reads as graduated
// ---------------------------------------------------------------------------

test("decodeBoolStrict accepts only the canonical 32-byte 0/1 word", () => {
  assert.equal(decodeBoolStrict(`0x${"00".repeat(32)}`), false);
  assert.equal(decodeBoolStrict(`0x${"00".repeat(31)}01`), true);
  for (const garbage of [
    `0x${"00".repeat(31)}02`,
    `0x${"ff".repeat(32)}`,
    "0xdeadbeef",
    "0x",
  ]) {
    assert.throws(() => decodeBoolStrict(garbage), /bool word/);
  }
});

test("checkGraduationReadiness refuses a garbage isGraduated() read by name", async () => {
  let calls = 0;
  const addressWord = `0x${"00".repeat(12)}${"bb".repeat(20)}`;
  await assert.rejects(
    checkGraduationReadiness({
      effects: {
        call: async () => {
          calls += 1;
          if (calls <= 2) return addressWord; // funds/tokens recipients
          if (calls === 3) return `0x${"00".repeat(31)}02`; // garbage bool
          throw new Error("execution reverted");
        },
        blockNumber: async () => 0n,
      },
      auction: AUCTION,
      endBlock: null,
    }),
    (error) => {
      assert.equal(error.name, "GraduationCheckError");
      assert.equal(error.stage, "graduated");
      assert.match(error.message, /bool word/);
      return true;
    },
  );
});
