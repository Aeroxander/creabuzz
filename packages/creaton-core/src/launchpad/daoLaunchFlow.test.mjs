import assert from "node:assert/strict";
import { test } from "node:test";
import { TOPIC_KIT_LAUNCHED, launchSalt, planDaoLaunch } from "./daoLaunch.ts";
import { EMPTY_DAO_LAUNCH_PROGRESS, runDaoLaunch } from "./daoLaunchFlow.ts";

const WAD = 10n ** 18n;
const KIT = "0x5555555555555555555555555555555555555555";
const EXECUTOR = "0x6666666666666666666666666666666666666666";
const DAO = "0x7777777777777777777777777777777777777777";
const SHARES = "0x8888888888888888888888888888888888888888";
const AUCTION = "0x9999999999999999999999999999999999999999";
const LOCK = "0x3333333333333333333333333333333333333333";
const LAUNCHER = "0x1111111111111111111111111111111111111111";
const TX = `0x${"ab".repeat(32)}`;

const plan = planDaoLaunch({
  name: "Nebula",
  symbol: "NEB",
  totalSupply: "1000",
  allocation: { sale: 40, team: 30, dao: 30 },
  team: [{ address: LAUNCHER, percent: 100 }],
  milestones: [{ check: "alpha shipped", percent: 100 }],
  proposalThreshold: "10",
  currency: null,
  floorPrice: "79228162514264337593543950336",
  tickSpacing: "79228162514264337593543950336",
  requiredRaised: "500000000000000000000",
  startBlock: 100,
  endBlock: 102,
  claimBlock: 105,
  salt: launchSalt("nebula"),
});

const word = (value) => BigInt(value).toString(16).padStart(64, "0");
const topic = (address) => `0x${address.slice(2).padStart(64, "0")}`;
const launchedLog = (saleSupply = plan.saleSupply, emitter = KIT) => ({
  address: emitter,
  topics: [TOPIC_KIT_LAUNCHED, topic(DAO), topic(LAUNCHER)],
  data: `0x${[
    word(SHARES),
    word(EXECUTOR),
    word(AUCTION),
    word(LOCK),
    word(saleSupply),
  ].join("")}`,
});

/** A fake chain + record + storage, counting what each does. */
function world(over = {}) {
  const w = {
    sends: 0,
    links: 0,
    publishes: 0,
    stored: null,
    sent: [],
    receipt: {
      txHash: TX,
      status: "success",
      blockNumber: 1,
      gasUsed: "1",
      contractAddress: null,
      logs: [launchedLog()],
    },
    code: false,
    linkError: null,
    publishError: null,
    readReceipt: async () => null,
    findLaunch: async () => null,
    ...over,
  };
  w.deps = {
    effects: {
      call: async () => `0x${word(EXECUTOR)}`,
      codeAt: async () => w.code,
      send: async (call) => {
        w.sends += 1;
        w.sent.push(call);
        if (w.sendError) throw w.sendError;
        return w.receipt;
      },
    },
    kit: KIT,
    plan,
    launcher: LAUNCHER,
    txStore: {
      load: () => w.stored,
      save: (h) => {
        w.stored = h;
      },
      clear: () => {
        w.stored = null;
      },
    },
    readReceipt: (h) => w.readReceipt(h),
    findLaunch: (executor) => w.findLaunch(executor),
    link: async () => {
      w.links += 1;
      if (w.linkError) throw w.linkError;
    },
    publish: async () => {
      w.publishes += 1;
      if (w.publishError) throw w.publishError;
    },
  };
  return w;
}

test("a launch sends once, reads what it made, saves it, publishes it, and forgets the hash", async () => {
  const w = world();
  const outcome = await runDaoLaunch(w.deps);
  assert.equal(outcome.ok, true);
  assert.equal(w.sends, 1);
  assert.equal(w.sent[0].to, KIT);
  assert.equal(w.links, 1);
  assert.equal(w.publishes, 1);
  assert.equal(outcome.progress.launched.dao, DAO);
  assert.equal(outcome.progress.launched.auction, AUCTION);
  assert.equal(w.stored, null, "a finished launch leaves no resume entry");
});

test("a declined or unconfirmed send is reported as unknown and may be tried again", async () => {
  const w = world({ sendError: new Error("User rejected the request.") });
  const outcome = await runDaoLaunch(w.deps);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.step, "send");
  assert.equal(outcome.retry, "launch");
  assert.match(outcome.message, /rejected/);
  assert.equal(w.stored, null);
});

test("a mined revert creates nothing and stores nothing", async () => {
  const w = world({
    receipt: {
      txHash: TX,
      status: "reverted",
      blockNumber: 1,
      gasUsed: "1",
      contractAddress: null,
    },
  });
  const outcome = await runDaoLaunch(w.deps);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.retry, "launch");
  assert.equal(w.stored, null);
  assert.equal(w.links, 0);
});

test("a launch whose salt already made its DAO is found again from the chain, not made twice", async () => {
  const w = world({
    code: true,
    findLaunch: async (executor) => {
      assert.equal(
        executor,
        EXECUTOR,
        "it asks for the executor the kit predicted",
      );
      return { txHash: TX, logs: [launchedLog()] };
    },
  });
  const outcome = await runDaoLaunch(w.deps);
  assert.equal(outcome.ok, true);
  assert.equal(w.sends, 0, "the wallet was never asked");
  assert.equal(w.links, 1);
  assert.equal(w.publishes, 1);
  assert.equal(outcome.progress.txHash, TX);
  assert.equal(outcome.progress.launched.dao, DAO);
});

test("a DAO that exists but cannot be found again stops for a person, and sends nothing", async () => {
  const w = world({ code: true });
  const outcome = await runDaoLaunch(w.deps);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.retry, "none");
  assert.match(outcome.message, /already created its DAO/);
  assert.equal(w.sends, 0);
  assert.equal(w.links, 0);
});

test("a failed lookup of an existing DAO may be tried again, and still sends nothing", async () => {
  const w = world({
    code: true,
    findLaunch: async () => {
      throw new Error("rpc timeout");
    },
  });
  const outcome = await runDaoLaunch(w.deps);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.retry, "launch");
  assert.equal(w.sends, 0);
});

test("the hash is stored the moment it mines, so a failed save is retried without sending again", async () => {
  const w = world({ linkError: new Error("server said no.") });
  const first = await runDaoLaunch(w.deps);
  assert.equal(first.ok, false);
  assert.equal(first.step, "link");
  assert.equal(
    first.retry,
    "finish",
    "the money step is done: never offer to send again",
  );
  assert.equal(w.stored, TX, "the hash survives for a reload");
  assert.match(first.message, /never sends the money twice/);

  w.linkError = null;
  const second = await runDaoLaunch(w.deps, first.progress);
  assert.equal(second.ok, true);
  assert.equal(w.sends, 1, "the retry did not send");
  assert.equal(w.links, 2);
  assert.equal(w.publishes, 1);
  assert.equal(w.stored, null);
});

test("a failed receipt is retried alone: the record is not saved a second time", async () => {
  const w = world({ publishError: new Error("offline") });
  const first = await runDaoLaunch(w.deps);
  assert.equal(first.step, "publish");
  w.publishError = null;
  const second = await runDaoLaunch(w.deps, first.progress);
  assert.equal(second.ok, true);
  assert.equal(w.links, 1);
  assert.equal(w.publishes, 2);
});

test("after a reload the stored hash resumes from the network's receipt, never from a new send", async () => {
  const w = world({ stored: TX });
  w.readReceipt = async (hash) => {
    assert.equal(hash, TX);
    return { status: "success", logs: [launchedLog()] };
  };
  const outcome = await runDaoLaunch(w.deps, EMPTY_DAO_LAUNCH_PROGRESS);
  assert.equal(outcome.ok, true);
  assert.equal(w.sends, 0);
  assert.equal(w.links, 1);
});

test("a stored hash the network has not confirmed yet waits, and keeps the hash", async () => {
  const w = world({ stored: TX });
  const outcome = await runDaoLaunch(w.deps);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.step, "confirm");
  assert.equal(outcome.retry, "finish");
  assert.equal(w.stored, TX);
  assert.equal(w.sends, 0);
});

test("a stored hash that turns out to have reverted is forgotten so the founder can start over", async () => {
  const w = world({ stored: TX });
  w.readReceipt = async () => ({ status: "reverted", logs: [] });
  const outcome = await runDaoLaunch(w.deps);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.retry, "launch");
  assert.equal(w.stored, null);
  assert.equal(outcome.progress.txHash, null);
});

test("an event from another contract is never recorded as this launch", async () => {
  const w = world({
    receipt: {
      txHash: TX,
      status: "success",
      blockNumber: 1,
      gasUsed: "1",
      contractAddress: null,
      logs: [
        launchedLog(
          plan.saleSupply,
          "0x00000000000000000000000000000000000000aa",
        ),
      ],
    },
  });
  const outcome = await runDaoLaunch(w.deps);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.step, "confirm");
  assert.equal(w.links, 0);
  assert.equal(w.stored, TX, "the launch did mine: keep the hash to look at");
});

test("a launch that does not match the terms on the page is not saved", async () => {
  const w = world({
    receipt: {
      txHash: TX,
      status: "success",
      blockNumber: 1,
      gasUsed: "1",
      contractAddress: null,
      logs: [launchedLog(plan.saleSupply + WAD)],
    },
  });
  const outcome = await runDaoLaunch(w.deps);
  assert.equal(outcome.ok, false);
  assert.match(outcome.message, /does not match/);
  assert.equal(outcome.retry, "none");
  assert.equal(w.links, 0);
});

test("storage that refuses writes does not stop a launch", async () => {
  const w = world();
  // `graduationTxStore` already reads a blocked store as empty; writes are the flow's to survive.
  w.deps.txStore = {
    load: () => null,
    save: () => {
      throw new Error("blocked");
    },
    clear: () => {
      throw new Error("blocked");
    },
  };
  const outcome = await runDaoLaunch(w.deps);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.progress.txHash, TX);
});

test("a launch made by another wallet is never saved as this founder's, even with the same terms", async () => {
  const stranger = "0x00000000000000000000000000000000000000ee";
  // Found from the chain (this salt's executor already has code), but the kit says someone else launched it.
  const adopted = world({
    code: true,
    findLaunch: async () => ({
      txHash: TX,
      logs: [
        {
          ...launchedLog(),
          topics: [TOPIC_KIT_LAUNCHED, topic(DAO), topic(stranger)],
        },
      ],
    }),
  });
  const outcome = await runDaoLaunch(adopted.deps);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.retry, "none");
  assert.match(outcome.message, /different wallet/);
  assert.equal(adopted.links, 0);
  assert.equal(adopted.publishes, 0);
});

test("the wallet is asked for the executor's address, and no launch starts without one", async () => {
  const asked = [];
  const w = world();
  const call = w.deps.effects.call;
  w.deps.effects.call = async (c) => {
    asked.push(c.data);
    return call(c);
  };
  await runDaoLaunch(w.deps);
  assert.match(
    asked[0],
    new RegExp(`^0x4e9a46c7${"0".repeat(24)}${LAUNCHER.slice(2)}`),
  );

  const none = world();
  none.deps.launcher = null;
  const outcome = await runDaoLaunch(none.deps);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.retry, "launch");
  assert.equal(none.sends, 0);

  // Finishing the bookkeeping of a launch this browser already sent needs no wallet.
  const resumed = world({ stored: TX });
  resumed.deps.launcher = null;
  resumed.readReceipt = async () => ({
    status: "success",
    logs: [launchedLog()],
  });
  assert.equal((await runDaoLaunch(resumed.deps)).ok, true);
});
