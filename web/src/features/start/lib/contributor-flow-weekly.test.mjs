// The weekly-sale kit's launch through the same steps as the plain one (`contributor-flow.ts`): its own prediction and
// call, and the node's say on whether the launch fits before anything is sent.
import assert from "node:assert/strict";
import test from "node:test";

import { selectorOf } from "@creaton/core/launchpad/evmAbi.ts";

import { runContributorStart, parseJob } from "./contributor-flow.ts";
import {
  CALL_BUDGET_FACTORY,
  CALL_SHARES,
  CALL_SUMMONER,
  CONTRIBUTOR_DEFAULTS,
  contributorSalt,
  encodePredictDao,
  KIT_LAUNCH_SIGNATURE,
} from "./contributor-project.ts";
import {
  encodePredictLaunch,
  KIT_LAUNCH_V2_SIGNATURE,
  KIT_LAUNCH_V3_SIGNATURE,
  LAUNCH_GAS_CAP,
  weeklySaleTerms,
} from "./weekly-sale.ts";

const a = (byte) => `0x${byte.repeat(20)}`;
const word = (address) => `0x${"0".repeat(24)}${address.slice(2)}`;
const KIT = a("c1");
const SUMMONER = a("5a");
const FACTORY = a("fa");
const DAO = a("da");
const SHARES = a("5e");
const QUOTE = a("77");
const FOUNDER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const AUTHOR = "aa".repeat(32);
const SALT = contributorSalt(AUTHOR, "docs-commons");
const LAUNCH_V2 = selectorOf(KIT_LAUNCH_V2_SIGNATURE);
const LAUNCH_V1 = selectorOf(KIT_LAUNCH_SIGNATURE);
const LAUNCH_V3 = selectorOf(KIT_LAUNCH_V3_SIGNATURE);

function job(overrides = {}) {
  return {
    version: 3,
    author: AUTHOR,
    launchId: "docs-commons",
    salt: SALT,
    // This try's own part of the salt, as every new try has.
    attempt: "ab".repeat(16),
    chainId: 11155111,
    kit: KIT,
    expectedSummoner: SUMMONER,
    founder: FOUNDER,
    currency: a("c0"),
    weekly: { quote: QUOTE },
    draft: {
      name: "Docs Commons",
      pitch: "Open docs for everyone, written by the people who use them.",
      symbol: "DOCS",
      ...CONTRIBUTOR_DEFAULTS,
      reviewers: `${a("71")}\n${a("72")}`,
      quorum: "",
      projects: [
        { name: "docs", check: "docs merged and reviewed", shares: "25000" },
      ],
    },
    dao: null,
    shares: null,
    createTx: null,
    recorded: false,
    ...overrides,
  };
}

// The build the weekly jobs run in: trading switched on, naming this kit, market factory and test token.
const TRIAL_ENV = {
  VITE_TRADING_TRIAL: "1",
  VITE_SECONDARY_MARKET_FACTORY: JSON.stringify({ 11155111: a("ab") }),
  VITE_CONTRIBUTOR_KITS: JSON.stringify({ 11155111: KIT }),
  VITE_TEST_QUOTE_TOKENS: JSON.stringify({ 11155111: QUOTE }),
};

const LOT = weeklySaleTerms({}, 100_000n).lotSize;

function fakeChain({
  estimate = async () => 10_800_000n,
  made = false,
  env = TRIAL_ENV,
} = {}) {
  const state = { sends: [], estimates: [], events: [], published: [], made };
  const fx = {
    env,
    async call(to, data) {
      if (
        to === KIT &&
        data === encodePredictLaunch(FOUNDER, 100_000n, SALT, QUOTE, LOT)
      )
        return word(DAO);
      if (to === KIT && data === encodePredictDao(FOUNDER, 100_000n, SALT))
        throw new Error(
          "the plain prediction is not what a weekly launch asks",
        );
      if (to === KIT && data === CALL_SUMMONER) return word(SUMMONER);
      if (to === KIT && data === CALL_BUDGET_FACTORY) return word(FACTORY);
      if (to === DAO && data === CALL_SHARES) return word(SHARES);
      throw new Error(`unexpected read ${to} ${data.slice(0, 10)}`);
    },
    async codeAt(address) {
      return address === DAO && state.made;
    },
    async madeByKit() {
      return true;
    },
    async nonceOf() {
      return 7n;
    },
    async estimateGas(from, to, data) {
      state.events.push("estimate");
      state.estimates.push({ from, to, data });
      return estimate(from, to, data);
    },
    async send(to, data) {
      state.events.push("send");
      state.sends.push({ to, data });
      state.made = true;
      return { txHash: `0x${"1".padStart(64, "0")}`, status: "success" };
    },
    async now() {
      return 1_000;
    },
    async wait() {},
    async publish(input) {
      state.published.push(input);
    },
    save() {},
  };
  return { fx, state };
}

test("a weekly-sale project predicts with the market, asks the node what the launch needs, then sends the weekly call", async () => {
  const { fx, state } = fakeChain();
  const out = await runContributorStart(job(), fx, () => {});
  assert.equal(out.ok, true, out.message);
  assert.deepEqual(state.events, ["estimate", "send"]);
  assert.equal(state.estimates[0].from, FOUNDER);
  assert.equal(state.estimates[0].to, KIT);
  assert.equal(state.estimates[0].data, state.sends[0].data);
  assert.equal(state.sends[0].to, KIT);
  assert.ok(state.sends[0].data.startsWith(LAUNCH_V2));
  // The price token and the lot are in the call.
  assert.ok(state.sends[0].data.includes(QUOTE.slice(2)));
  assert.ok(state.sends[0].data.includes(LOT.toString(16).padStart(64, "0")));
  assert.equal(out.job.dao, DAO);
  assert.equal(state.published[0].treasury, DAO);
  assert.equal(state.published[0].funding.path, "contributors");
});

test("a launch the node says is too large sends nothing and says so in plain words", async () => {
  const { fx, state } = fakeChain({
    estimate: async () => LAUNCH_GAS_CAP + 1n,
  });
  const out = await runContributorStart(job(), fx, () => {});
  assert.equal(out.ok, false);
  assert.equal(out.step, "create");
  assert.match(out.message, /more than the network allows in one step/);
  assert.equal(state.sends.length, 0);
  assert.equal(state.published.length, 0);
  assert.ok(out.technical);
});

test("a launch the node refuses, or does not answer about, sends nothing", async () => {
  for (const [error, words] of [
    ["execution reverted: InvalidTerms", /would refuse/],
    [
      "The network did not answer just now.",
      /did not say what this step would cost/,
    ],
  ]) {
    const { fx, state } = fakeChain({
      estimate: async () => {
        throw new Error(error);
      },
    });
    const out = await runContributorStart(job(), fx, () => {});
    assert.equal(out.ok, false, error);
    assert.match(out.message, words);
    assert.equal(out.technical, error);
    assert.equal(state.sends.length, 0);
  }
});

test("a weekly project already made is used: nothing is estimated or sent", async () => {
  const { fx, state } = fakeChain({ made: true });
  const out = await runContributorStart(job(), fx, () => {});
  assert.equal(out.ok, true, out.message);
  assert.deepEqual(state.events, []);
  assert.equal(out.job.dao, DAO);
});

test("weekly-sale fields that no longer fit stop the step before anything is asked or sent", async () => {
  const { fx, state } = fakeChain();
  const bad = job();
  bad.draft = { ...bad.draft, saleDays: "0" };
  const out = await runContributorStart(bad, fx, () => {});
  assert.equal(out.ok, false);
  assert.match(out.message, /days/);
  assert.deepEqual(state.events, []);
});

test("a plain-kit job is launched as before: no weekly call, no estimate", async () => {
  const { fx, state } = fakeChain();
  const plain = job();
  delete plain.weekly;
  const base = fx.call;
  fx.call = async (to, data) =>
    to === KIT && data === encodePredictDao(FOUNDER, 100_000n, SALT)
      ? word(DAO)
      : base(to, data);
  const out = await runContributorStart(plain, fx, () => {});
  assert.equal(out.ok, true, out.message);
  assert.deepEqual(state.events, ["send"]);
  assert.ok(state.sends[0].data.startsWith(LAUNCH_V1));
});

test("a stored weekly job keeps its price token across a reload", () => {
  const stored = parseJob(JSON.stringify(job()));
  assert.deepEqual(stored?.weekly, { quote: QUOTE });
  // Malformed weekly data is not trusted: the job is dropped rather than sent down the wrong launch.
  assert.equal(
    parseJob(JSON.stringify(job({ weekly: { quote: "nope" } }))),
    null,
  );
  assert.equal(parseJob(JSON.stringify(job({ weekly: "yes" }))), null);
});

test("a stored weekly job is not sent when this build no longer names that kit or that token", async () => {
  const builds = {
    "no kit named (the pilot rebuild)": {},
    "another kit": {
      ...TRIAL_ENV,
      VITE_CONTRIBUTOR_KITS: JSON.stringify({ 11155111: a("c2") }),
    },
    "another test token": {
      ...TRIAL_ENV,
      VITE_TEST_QUOTE_TOKENS: JSON.stringify({ 11155111: a("78") }),
    },
    "no test token": { ...TRIAL_ENV, VITE_TEST_QUOTE_TOKENS: "" },
  };
  for (const [name, env] of Object.entries(builds)) {
    const { fx, state } = fakeChain({ env });
    const out = await runContributorStart(job(), fx, () => {});
    assert.equal(out.ok, false, name);
    assert.equal(out.step, "create", name);
    assert.match(out.message, /no longer offers/, name);
    assert.match(out.message, /Discard it/, name);
    assert.deepEqual(state.events, [], name);
    assert.equal(state.sends.length, 0, name);
  }
});

test("setting up Shares never waits on trading: with the trading switch off the weekly kit launches as before", async () => {
  const { fx, state } = fakeChain({
    env: {
      VITE_CONTRIBUTOR_KITS: TRIAL_ENV.VITE_CONTRIBUTOR_KITS,
      VITE_TEST_QUOTE_TOKENS: TRIAL_ENV.VITE_TEST_QUOTE_TOKENS,
    },
  });
  const out = await runContributorStart(job(), fx, () => {});
  assert.equal(out.ok, true, out.message);
  assert.deepEqual(state.events, ["estimate", "send"]);
  assert.ok(state.sends[0].data.startsWith(LAUNCH_V2));
});

test("a pool-kit job sends launchWithPool, and only while investing is on and the build names that kit and token", async () => {
  const BACKING = a("b3");
  const POOL_KIT = a("c3");
  const investing = {
    VITE_INVESTING: "1",
    VITE_BACKING_POOL_FACTORY: JSON.stringify({ 11155111: a("b1") }),
    VITE_CONTRIBUTOR_KIT_V3: JSON.stringify({ 11155111: POOL_KIT }),
    VITE_BACKING_QUOTE_TOKEN: JSON.stringify({ 11155111: BACKING }),
  };
  const pooled = (extra = {}) =>
    job({ kit: POOL_KIT, weekly: { quote: BACKING, pool: true }, ...extra });
  const chain = (env) => {
    const made = fakeChain({ env });
    const base = made.fx.call;
    made.fx.call = async (to, data) =>
      to === POOL_KIT
        ? base(
            KIT,
            data === encodePredictLaunch(FOUNDER, 100_000n, SALT, BACKING, LOT)
              ? encodePredictLaunch(FOUNDER, 100_000n, SALT, QUOTE, LOT)
              : data,
          ).then((x) => x)
        : base(to, data);
    return made;
  };
  const { fx, state } = chain(investing);
  const out = await runContributorStart(pooled(), fx, () => {});
  assert.equal(out.ok, true, out.message);
  assert.equal(state.sends[0].to, POOL_KIT);
  assert.ok(state.sends[0].data.startsWith(LAUNCH_V3));
  assert.ok(state.sends[0].data.includes(BACKING.slice(2)));
  for (const [name, env] of Object.entries({
    "investing off": { ...investing, VITE_INVESTING: "" },
    "another kit": {
      ...investing,
      VITE_CONTRIBUTOR_KIT_V3: JSON.stringify({ 11155111: a("c4") }),
    },
    "another token": {
      ...investing,
      VITE_BACKING_QUOTE_TOKEN: JSON.stringify({ 11155111: a("b4") }),
    },
  })) {
    const refused = chain(env);
    const result = await runContributorStart(pooled(), refused.fx, () => {});
    assert.equal(result.ok, false, name);
    assert.match(result.message, /no longer offers/, name);
    assert.equal(refused.state.sends.length, 0, name);
  }
  // A stored pool job keeps its flag across a reload, and a malformed one is dropped.
  assert.equal(parseJob(JSON.stringify(pooled()))?.weekly?.pool, true);
  assert.equal(
    parseJob(
      JSON.stringify(pooled({ weekly: { quote: BACKING, pool: "yes" } })),
    ),
    null,
  );
});

test("a weekly project already made still reaches its record on a build that stopped offering trading", async () => {
  const { fx, state } = fakeChain({ made: true, env: {} });
  const out = await runContributorStart(job(), fx, () => {});
  assert.equal(out.ok, true, out.message);
  assert.deepEqual(state.events, []);
  assert.equal(state.published.length, 1);
});
