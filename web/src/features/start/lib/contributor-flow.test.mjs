import assert from "node:assert/strict";
import test from "node:test";

import { ActingStepError } from "../../launchpad/lib/acting-account.ts";
import {
  CONTRIBUTOR_STEP_LABELS,
  contributorFlow,
  DAO_CODE_TRIES,
  DAO_CODE_WAIT_MS,
  doneSteps,
  parseJob,
  runContributorStart,
  stateForJob,
} from "./contributor-flow.ts";
import {
  CALL_BUDGET_FACTORY,
  CALL_SHARES,
  CALL_SUMMONER,
  CONTRIBUTOR_DEFAULTS,
  contributorSalt,
  createAddress,
  encodePredictDao,
  KIT_LAUNCH_SIGNATURE,
} from "./contributor-project.ts";
import { selectorOf } from "@creaton/core/launchpad/evmAbi.ts";

const a = (byte) => `0x${byte.repeat(20)}`;
const word = (address) => `0x${"0".repeat(24)}${address.slice(2)}`;
const KIT = a("c1");
const SUMMONER = a("5a");
const FACTORY = a("fa");
const DAO = a("da");
const SHARES = a("5e");
const FOUNDER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const AUTHOR = "aa".repeat(32);
const SALT = contributorSalt(AUTHOR, "docs-commons");
const LAUNCH = selectorOf(KIT_LAUNCH_SIGNATURE);

function job(overrides = {}) {
  return {
    version: 3,
    author: AUTHOR,
    launchId: "docs-commons",
    salt: SALT,
    chainId: 31337,
    kit: KIT,
    expectedSummoner: SUMMONER,
    founder: FOUNDER,
    currency: a("c0"),
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

/** A chain that answers the run's reads, records its sends, and can be told to refuse. */
function fakeChain({
  made = false,
  revert = 0,
  publishFails = 0,
  summoner = SUMMONER,
  nonce = 7n,
  lag = 0,
  sendFails = null,
  squatted = false,
} = {}) {
  const state = {
    made,
    // How many more times the page's node says "no code" after the DAO was made (a node a block or two behind).
    lag,
    codeReads: 0,
    waits: [],
    sends: [],
    published: [],
    saved: [],
    publishFails,
    revert,
    nonce,
    // The made DAO was summoned by someone other than the kit (a pre-summon at the predicted address).
    squatted,
    kitChecks: [],
  };
  const fx = {
    async call(to, data) {
      if (to === KIT && data === encodePredictDao(FOUNDER, 100_000n, SALT))
        return word(DAO);
      if (to === KIT && data === CALL_SUMMONER) return word(summoner);
      if (to === KIT && data === CALL_BUDGET_FACTORY) return word(FACTORY);
      if (to === DAO && data === CALL_SHARES) return word(SHARES);
      throw new Error(`unexpected read ${to} ${data.slice(0, 10)}`);
    },
    async codeAt(address) {
      state.codeReads += 1;
      if (address !== DAO || !state.made) return false;
      if (state.lag > 0) {
        state.lag -= 1;
        return false;
      }
      return true;
    },
    async madeByKit(kit, dao) {
      state.kitChecks.push({ kit, dao });
      return !state.squatted;
    },
    async wait(ms) {
      state.waits.push(ms);
    },
    async nonceOf(address) {
      assert.equal(address, FACTORY);
      return state.nonce;
    },
    async send(to, data) {
      const txHash = `0x${String(state.sends.length + 1).padStart(64, "0")}`;
      state.sends.push({ to, data });
      if (sendFails) throw sendFails;
      if (state.revert > 0) {
        state.revert -= 1;
        return { txHash, status: "reverted" };
      }
      state.made = true;
      return { txHash, status: "success" };
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
    order: ["create", "record"],
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

test("one transaction makes the project, then it is published", async () => {
  const { fx, state } = fakeChain();
  const t = tracker();
  const out = await runContributorStart(job(), fx, t.dispatch);
  assert.equal(out.ok, true);
  assert.equal(t.state.phase, "done");
  assert.equal(state.sends.length, 1);
  assert.equal(state.sends[0].to, KIT);
  assert.ok(state.sends[0].data.startsWith(LAUNCH));
  // The kit is told where the budget factory's next budget will be.
  assert.ok(state.sends[0].data.includes(createAddress(FACTORY, 7n).slice(2)));
  assert.equal(out.job.dao, DAO);
  assert.equal(out.job.shares, SHARES);
  assert.equal(state.published[0].treasury, DAO);
  assert.equal(state.published[0].token, SHARES);
  assert.equal(state.published[0].funding.path, "contributors");
  assert.deepEqual([...doneSteps(out.job)], ["create", "record"]);
});

test("a project this wallet already made is used, never made twice", async () => {
  const { fx, state } = fakeChain({ made: true });
  const out = await runContributorStart(job(), fx, () => {});
  assert.equal(out.ok, true);
  assert.equal(state.sends.length, 0);
  assert.equal(out.job.dao, DAO);
});

test("a DAO already at the predicted address that the kit did not make is refused, never adopted or published", async () => {
  // Anyone can summon a DAO at an address worked out from public calldata. Code at the address is not proof it is ours.
  const { fx, state } = fakeChain({ made: true, squatted: true });
  const t = tracker();
  const out = await runContributorStart(job(), fx, t.dispatch);
  assert.equal(out.ok, false);
  assert.equal(out.step, "create");
  assert.match(out.message, /not made by this project's kit/);
  assert.match(out.message, /Nothing was sent/);
  assert.equal(state.sends.length, 0);
  assert.equal(state.published.length, 0);
  assert.equal(out.job.dao, null);
  assert.deepEqual(state.kitChecks, [{ kit: KIT, dao: DAO }]);
});

test("a DAO the kit made is still used, after asking the chain who made it", async () => {
  const { fx, state } = fakeChain({ made: true });
  const out = await runContributorStart(job(), fx, () => {});
  assert.equal(out.ok, true);
  assert.deepEqual(state.kitChecks, [{ kit: KIT, dao: DAO }]);
  assert.equal(state.sends.length, 0);
});

test("a kit that makes a different kind of DAO is refused before sending", async () => {
  const { fx, state } = fakeChain({ summoner: a("99") });
  const t = tracker();
  const out = await runContributorStart(job(), fx, t.dispatch);
  assert.equal(out.ok, false);
  assert.equal(out.step, "create");
  assert.match(
    t.state.errorMessage,
    /^Make the project: .* failed: this network's contributor kit/,
  );
  assert.equal(state.sends.length, 0);
});

test("a refused launch makes nothing, and pressing again predicts the budget afresh", async () => {
  const { fx, state } = fakeChain({ revert: 1 });
  const first = await runContributorStart(job(), fx, () => {});
  assert.equal(first.ok, false);
  assert.equal(first.step, "create");
  assert.match(first.message, /nothing was made/);
  assert.equal(state.published.length, 0);
  assert.equal(first.job.dao, null);
  // Another budget was made meanwhile: the retry names the next address, not the old one.
  state.nonce = 8n;
  const second = await runContributorStart(first.job, fx, () => {});
  assert.equal(second.ok, true);
  assert.equal(state.sends.length, 2);
  assert.ok(state.sends[1].data.includes(createAddress(FACTORY, 8n).slice(2)));
  assert.ok(!state.sends[1].data.includes(createAddress(FACTORY, 7n).slice(2)));
});

test("a refused record is retried alone: the project is not made again", async () => {
  const { fx, state } = fakeChain({ publishFails: 1 });
  const first = await runContributorStart(job(), fx, () => {});
  assert.equal(first.ok, false);
  assert.equal(first.step, "record");
  assert.equal(first.job.dao, DAO);
  // The page keeps the job; a reload starts from the saved one.
  const saved = parseJob(JSON.stringify(state.saved.at(-1)));
  assert.equal(stateForJob(saved).steps.create, "done");
  assert.equal(stateForJob(saved).steps.record, "pending");
  const second = await runContributorStart(saved, fx, () => {});
  assert.equal(second.ok, true);
  assert.equal(state.sends.length, 1);
});

test("a stored job that is not one this version wrote is ignored", () => {
  assert.equal(parseJob(null), null);
  assert.equal(parseJob("{"), null);
  assert.equal(parseJob(JSON.stringify({ ...job(), version: 1 })), null);
  assert.equal(parseJob(JSON.stringify(job()))?.launchId, "docs-commons");
});

test("a job saved before several first projects (D84) is converted, not dropped", async () => {
  const { parseJob } = await import("./contributor-flow.ts");
  const old = job();
  old.version = 2;
  old.draft = {
    ...old.draft,
    projectName: "docs",
    projectCheck: "docs merged and reviewed",
  };
  delete old.draft.projects;
  const parsed = parseJob(JSON.stringify(old));
  assert.equal(parsed.version, 3);
  assert.deepEqual(parsed.draft.projects, [
    {
      name: "docs",
      check: "docs merged and reviewed",
      shares: old.draft.projectCap,
    },
  ]);
  assert.equal("projectName" in parsed.draft, false);
  assert.equal(
    parseJob(JSON.stringify({ ...old, draft: { name: "x" } })),
    null,
  );
});

test("a node a block behind the confirmation is asked again, a bounded number of times, before anything is said", async () => {
  const { fx, state } = fakeChain({ lag: 2 });
  const t = tracker();
  const out = await runContributorStart(job(), fx, t.dispatch);
  assert.equal(out.ok, true, out.message);
  assert.equal(t.state.phase, "done");
  assert.equal(state.sends.length, 1);
  // The check before sending, then three after it: two that lagged and the one that saw the DAO.
  assert.equal(state.codeReads, 4);
  assert.deepEqual(state.waits, [DAO_CODE_WAIT_MS, DAO_CODE_WAIT_MS]);
});

test("a DAO that still does not show stops after the last try, says to press again in a minute, and is never made twice", async () => {
  const { fx, state } = fakeChain({ lag: 1_000 });
  const first = await runContributorStart(job(), fx, () => {});
  assert.equal(first.ok, false);
  assert.equal(first.step, "create");
  // Bounded: one read before sending and DAO_CODE_TRIES after, with a wait between each of those.
  assert.equal(state.codeReads, 1 + DAO_CODE_TRIES);
  assert.equal(state.waits.length, DAO_CODE_TRIES - 1);
  assert.match(first.message, /Press Try again in a minute/);
  assert.match(first.message, /never makes a second one/);
  assert.doesNotMatch(first.message, /no DAO where it should be/);
  // The node catches up: pressing again finds the DAO and sends nothing.
  state.lag = 0;
  const second = await runContributorStart(first.job, fx, () => {});
  assert.equal(second.ok, true);
  assert.equal(state.sends.length, 1);
});

test("a send that fails keeps the original words for Technical details", async () => {
  const raw =
    "bundler: zd_sponsorUserOperation RPC error UserOperation reverted during simulation with reason: 0x";
  const { fx } = fakeChain({
    sendFails: new ActingStepError(
      "The network would refuse this step, so nothing was sent.",
      raw,
    ),
  });
  const t = tracker();
  const out = await runContributorStart(job(), fx, t.dispatch);
  assert.equal(out.ok, false);
  assert.equal(out.technical, raw);
  assert.match(t.state.errorMessage, /would refuse this step/);
  assert.doesNotMatch(t.state.errorMessage, /bundler/);
});

test("the first step is named for what the form calls them: work areas", () => {
  assert.match(CONTRIBUTOR_STEP_LABELS.create, /work areas/);
  assert.doesNotMatch(CONTRIBUTOR_STEP_LABELS.create, /first project/);
});
