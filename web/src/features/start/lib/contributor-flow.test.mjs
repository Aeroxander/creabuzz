import assert from "node:assert/strict";
import test from "node:test";

import {
  contributorFlow,
  doneSteps,
  parseJob,
  runContributorStart,
  stateForJob,
} from "./contributor-flow.ts";
import {
  CALL_GET_IMPLEMENTATION,
  CALL_MANDATE_FACTORY,
  CALL_SHARES,
  CALL_SUMMONER,
  CALL_VOTING_WEIGHT,
  CONTRIBUTOR_DEFAULTS,
  contributorRootId,
  encodeBinderOf,
  encodeBindingOf,
  firstBudgetNonce,
  SUMMON_AND_BIND_SIGNATURE,
  TOPIC_DAO_BOUND,
} from "./contributor-project.ts";
import { selectorOf } from "@creaton/core/launchpad/evmAbi.ts";

const a = (byte) => `0x${byte.repeat(20)}`;
const word = (address) => `0x${"0".repeat(24)}${address.slice(2)}`;
const BINDING = a("b1");
const SUMMONER = a("5a");
const IMPL = a("1e");
const DAO = a("da");
const SHARES = a("5e");
const POLICY = a("70");
const FACTORY = a("fa");
const FOUNDER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const AUTHOR = "aa".repeat(64).slice(0, 64);
const ROOT = contributorRootId(AUTHOR, "docs-commons");
const OPEN_PROPOSAL = "0xe1d5ec31";

function job(overrides = {}) {
  return {
    version: 1,
    author: AUTHOR,
    launchId: "docs-commons",
    rootId: ROOT,
    chainId: 31337,
    binding: BINDING,
    expectedSummoner: SUMMONER,
    founder: FOUNDER,
    currency: a("c0"),
    currencyDecimals: 6,
    draft: {
      name: "Docs Commons",
      pitch: "Open docs for everyone, written by the people who use them.",
      symbol: "DOCS",
      ...CONTRIBUTOR_DEFAULTS,
      reviewers: `${a("71")}\n${a("72")}`,
      quorum: "",
    },
    dao: null,
    shares: null,
    createTx: null,
    recorded: false,
    budget: null,
    budgetTx: null,
    budgetOpened: false,
    ...overrides,
  };
}

/** A chain that answers the reads the run makes, records the sends, and can be told to fail. */
function fakeChain({
  bound = null,
  binder = FOUNDER,
  revert = new Set(),
  publishFails = 0,
  summoner = SUMMONER,
} = {}) {
  const state = { bound, sends: [], published: [], saved: [], publishFails };
  const fx = {
    async call(to, data) {
      if (to === BINDING && data === encodeBindingOf(ROOT))
        return `${word(state.bound ?? `0x${"0".repeat(40)}`)}${"0".repeat(64)}`;
      if (to === BINDING && data === encodeBinderOf(ROOT)) return word(binder);
      if (to === BINDING && data === CALL_SUMMONER) return word(summoner);
      if (to === SUMMONER && data === CALL_GET_IMPLEMENTATION)
        return word(IMPL);
      if (to === DAO && data === CALL_SHARES) return word(SHARES);
      if (to === DAO && data === CALL_VOTING_WEIGHT) return word(POLICY);
      if (to === POLICY && data === CALL_MANDATE_FACTORY) return word(FACTORY);
      throw new Error(`unexpected read ${to} ${data.slice(0, 10)}`);
    },
    async send(to, data) {
      const txHash = `0x${String(state.sends.length + 1).padStart(64, "0")}`;
      state.sends.push({ to, data });
      const kind = data.startsWith(selectorOf(SUMMON_AND_BIND_SIGNATURE))
        ? "create"
        : "budget";
      if (revert.has(kind)) return { txHash, status: "reverted", logs: [] };
      if (kind === "create") {
        state.bound = DAO;
        return {
          txHash,
          status: "success",
          logs: [
            { address: BINDING, topics: [TOPIC_DAO_BOUND, ROOT, word(DAO)] },
          ],
        };
      }
      return { txHash, status: "success", logs: [] };
    },
    async now() {
      return 1_000;
    },
    async publish(input) {
      if (state.publishFails > 0) {
        state.publishFails -= 1;
        throw new Error("the server refused the record");
      }
      state.published.push(input);
    },
    save(j) {
      state.saved.push(j);
    },
  };
  return { fx, state };
}

function tracker() {
  let s = contributorFlow.reducer(contributorFlow.initial(), {
    type: "reset",
    order: ["create", "record", "budget"],
  });
  return {
    dispatch: (action) => {
      s = contributorFlow.reducer(s, action);
    },
    get state() {
      return s;
    },
  };
}

test("one run makes the DAO, publishes the project and opens its first work budget", async () => {
  const { fx, state } = fakeChain();
  const t = tracker();
  const out = await runContributorStart(job(), fx, t.dispatch);
  assert.equal(out.ok, true);
  assert.equal(t.state.phase, "done");
  assert.equal(state.sends.length, 2);
  assert.equal(state.sends[0].to, BINDING);
  assert.equal(state.sends[1].to, DAO);
  assert.ok(state.sends[1].data.startsWith(OPEN_PROPOSAL));
  // The decision is opened with the project's fixed nonce, so it can be sent again without opening a second one.
  assert.ok(state.sends[1].data.includes(firstBudgetNonce(ROOT).slice(2)));
  assert.equal(out.job.dao, DAO);
  assert.equal(out.job.shares, SHARES);
  assert.equal(state.published[0].treasury, DAO);
  assert.equal(state.published[0].token, SHARES);
  assert.equal(state.published[0].funding.path, "contributors");
  assert.deepEqual([...doneSteps(out.job)], ["create", "record", "budget"]);
});

test("a DAO this wallet already made for the project is used, never made twice", async () => {
  const { fx, state } = fakeChain({ bound: DAO });
  const out = await runContributorStart(job(), fx, () => {});
  assert.equal(out.ok, true);
  assert.equal(state.sends.filter((s) => s.to === BINDING).length, 0);
  assert.equal(out.job.dao, DAO);
});

test("a DAO another wallet filed under the same key stops the run before anything is sent", async () => {
  const { fx, state } = fakeChain({ bound: DAO, binder: a("ee") });
  const t = tracker();
  const out = await runContributorStart(job(), fx, t.dispatch);
  assert.equal(out.ok, false);
  assert.equal(out.step, "create");
  assert.match(
    t.state.errorMessage,
    /^Make the project's DAO failed: another wallet/,
  );
  assert.equal(state.sends.length, 0);
  assert.equal(state.published.length, 0);
});

test("a DAO maker that makes a different kind of DAO is refused before sending", async () => {
  const { fx, state } = fakeChain({ summoner: a("99") });
  const out = await runContributorStart(job(), fx, () => {});
  assert.equal(out.ok, false);
  assert.equal(out.step, "create");
  assert.equal(state.sends.length, 0);
});

test("a reverted DAO transaction is a failure, and nothing is published", async () => {
  const { fx, state } = fakeChain({ revert: new Set(["create"]) });
  const out = await runContributorStart(job(), fx, () => {});
  assert.equal(out.ok, false);
  assert.equal(out.step, "create");
  assert.match(out.message, /turned the transaction down/);
  assert.equal(state.published.length, 0);
  assert.equal(out.job.dao, null);
});

test("a refused record is retried alone: the DAO is not made again", async () => {
  const { fx, state } = fakeChain({ publishFails: 1 });
  const first = await runContributorStart(job(), fx, () => {});
  assert.equal(first.ok, false);
  assert.equal(first.step, "record");
  assert.equal(first.job.dao, DAO);
  // The page keeps the job; a reload starts from the saved one.
  const saved = parseJob(JSON.stringify(state.saved.at(-1)));
  assert.deepEqual(
    [...stateForJob(saved).order],
    ["create", "record", "budget"],
  );
  assert.equal(stateForJob(saved).steps.create, "done");
  const second = await runContributorStart(saved, fx, () => {});
  assert.equal(second.ok, true);
  assert.equal(state.sends.filter((s) => s.to === BINDING).length, 1);
});

test("a failed opening is retried with the very same decision", async () => {
  const { fx, state } = fakeChain({ revert: new Set(["budget"]) });
  const first = await runContributorStart(job(), fx, () => {});
  assert.equal(first.ok, false);
  assert.equal(first.step, "budget");
  const kept = first.job.budget;
  assert.ok(kept);
  // Time moved on: a recomposed decision would differ. The kept one must be sent unchanged.
  fx.now = async () => 99_999;
  const retried = await runContributorStart(
    { ...first.job },
    {
      ...fx,
      send: async (to, data) => {
        state.sends.push({ to, data });
        return { txHash: `0x${"9".repeat(64)}`, status: "success", logs: [] };
      },
    },
    () => {},
  );
  assert.equal(retried.ok, true);
  const budgetSends = state.sends.filter((s) => s.to === DAO);
  assert.equal(budgetSends.length, 2);
  assert.equal(budgetSends[0].data, budgetSends[1].data);
});

test("a stored job that is not one this version wrote is ignored", () => {
  assert.equal(parseJob(null), null);
  assert.equal(parseJob("{"), null);
  assert.equal(parseJob(JSON.stringify({ version: 2 })), null);
  assert.equal(parseJob(JSON.stringify(job()))?.launchId, "docs-commons");
});
