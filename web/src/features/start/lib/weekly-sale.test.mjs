import assert from "node:assert/strict";
import test from "node:test";

import { selectorOf } from "@creaton/core/launchpad/evmAbi.ts";

import { ActingStepError } from "../../launchpad/lib/acting-account.ts";
import {
  contributorTerms,
  CONTRIBUTOR_DEFAULTS,
} from "./contributor-project.ts";
import {
  assertLaunchFits,
  CALL_MARKET_FACTORY,
  CALL_POOL_FACTORY,
  encodeKitLaunchV2,
  encodeKitLaunchV3,
  encodePredictLaunch,
  KIT_LAUNCH_V2_SIGNATURE,
  KIT_LAUNCH_V3_SIGNATURE,
  LAUNCH_GAS_CAP,
  poolKitIssue,
  readKitSale,
  SALE_DEFAULTS,
  weeklySaleIssue,
  weeklySaleTerms,
} from "./weekly-sale.ts";

const R1 = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const R2 = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc";
const R3 = "0x90f79bf6eb2c4f870365e785982e1f101e93b906";
const FOUNDER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const SALT = `0x${"ab".repeat(32)}`;
const QUOTE = `0x${"77".repeat(20)}`;
const KIT = `0x${"11".repeat(20)}`;
const FACTORY = `0x${"3a".repeat(20)}`;
const WORD = (address) => `0x${"0".repeat(24)}${address.slice(2)}`;

function draft(overrides = {}) {
  return {
    name: "Docs Commons",
    pitch: "Open docs for everyone, written by the people who use them.",
    symbol: "DOCS",
    ...CONTRIBUTOR_DEFAULTS,
    reviewers: `${R1}\n${R2}\n${R3}`,
    quorum: "",
    reviewerTies: "Ann and Bo worked with me at Acme; I have not met Cy.",
    projects: [
      { name: "docs", check: "docs merged and reviewed", shares: "25000" },
    ],
    ...overrides,
  };
}

test("the weekly-sale launch call is byte-for-byte what cast encodes", () => {
  // Pinned with `cast sig` and `cast calldata` on the same values (two reviewers, one first project, no wait, 180 days).
  assert.equal(selectorOf(KIT_LAUNCH_V2_SIGNATURE), "0x01ea6897");
  const sale = weeklySaleTerms(
    draft({ saleLot: "100", saleCliffDays: "0", saleDays: "180" }),
    100_000n,
  );
  const data = encodeKitLaunchV2({
    terms: contributorTerms(draft({ reviewers: `${R1}\n${R2}` }), null, {
      resumed: true,
    }),
    salt: SALT,
    founder: FOUNDER,
    currency: `0x${"44".repeat(20)}`,
    predictedBudget: `0x${"55".repeat(20)}`,
    now: 1_000,
    quote: QUOTE,
    sale,
  });
  assert.equal(
    data,
    "0x01ea6897000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000c0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000ed4e0000000000000000000000000077777777777777777777777777777777777777770000000000000000000000000000000000000000000000056bc75e2d63100000000000000000000000000000000000000000000000000000000000000000018000000000000000000000000000000000000000000000000000000000000001c000000000000000000000000000000000000000000000152d02c7e14af6800000abababababababababababababababababababababababababababababababab0000000000000000000000004444444444444444444444444444444444444444000000000000000000000000000000000000000000003f870857a3e0e380000000000000000000000000000000000000000000000000054b40b1f852bda00000000000000000000000000000000000000000000000000000000000000076aae80000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000000200000000000000000000000055555555555555555555555555555555555555550000000000000000000000000000000000000000000000000000000000000260000000000000000000000000000000000000000000000000000000000000000c446f637320436f6d6d6f6e7300000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000004444f435300000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000200000000000000000000000070997970c51812dc3a010c7d01b50e0d17dc79c80000000000000000000000003c44cdddb6a900fa2b585dd299e03d12fa4293bc0000000000000000000000000000000000000000000000000000000000000001646f637300000000000000000000000000000000000000000000000000000000000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb9226600000000000000000000000000000000000000000000054b40b1f852bda00000000000000000000000000000000000000000000000000000000000000076aae8e8164af4b3d1186a31c4eecb6012657bf68042eb1ce8130d9d766a096b0418ff",
  );
  assert.equal(
    selectorOf("predictLaunch(address,uint256,bytes32,address,uint256)"),
    "0xb906778a",
  );
  assert.equal(
    encodePredictLaunch(FOUNDER, 100_000n, SALT, QUOTE, sale.lotSize),
    "0xb906778a000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb9226600000000000000000000000000000000000000000000152d02c7e14af6800000abababababababababababababababababababababababababababababababab00000000000000000000000077777777777777777777777777777777777777770000000000000000000000000000000000000000000000056bc75e2d63100000",
  );
  assert.equal(selectorOf("marketFactory()"), "0x06ae7095");
  assert.equal(CALL_MARKET_FACTORY, "0x06ae7095");
});

test("the sale fields default to a 180-day unlock from the start, and are valid as they are", () => {
  assert.deepEqual(SALE_DEFAULTS, { lot: "100", cliffDays: "0", days: "180" });
  assert.equal(weeklySaleIssue(draft(), 100_000n), null);
  const terms = weeklySaleTerms(draft(), 100_000n);
  assert.equal(terms.lotSize, 100n * 10n ** 18n);
  assert.equal(terms.cliffSeconds, 0n);
  assert.equal(terms.durationSeconds, 180n * 86_400n);
});

test("a lot may be a fraction of a Share, to 18 places, and must be more than nothing", () => {
  assert.equal(
    weeklySaleTerms(draft({ saleLot: "0.01" }), 100_000n).lotSize,
    10n ** 16n,
  );
  assert.equal(
    weeklySaleTerms(draft({ saleLot: " 1,000 " }), 100_000n).lotSize,
    1_000n * 10n ** 18n,
  );
  for (const bad of [
    "0",
    "0.0",
    "-1",
    "abc",
    "1e3",
    "1.0000000000000000001",
    ".",
  ]) {
    const issue = weeklySaleIssue(draft({ saleLot: bad }), 100_000n);
    assert.equal(issue?.field, "saleLot", bad);
  }
  // Empty falls back to the default, so a form left alone starts.
  assert.equal(weeklySaleIssue(draft({ saleLot: "  " }), 100_000n), null);
});

test("a lot cannot hold more Shares than the founder starts with, since none could ever be offered", () => {
  assert.equal(weeklySaleIssue(draft({ saleLot: "100000" }), 100_000n), null);
  const issue = weeklySaleIssue(draft({ saleLot: "100001" }), 100_000n);
  assert.equal(issue?.field, "saleLot");
  assert.match(issue.message, /starting Shares/);
});

test("the unlock days are whole days: at least one to unlock, no wait longer than the unlock, none beyond ten years", () => {
  assert.equal(
    weeklySaleIssue(draft({ saleDays: "0" }), 100_000n)?.field,
    "saleDays",
  );
  assert.equal(
    weeklySaleIssue(draft({ saleDays: "1.5" }), 100_000n)?.field,
    "saleDays",
  );
  assert.equal(
    weeklySaleIssue(draft({ saleDays: "3651" }), 100_000n)?.field,
    "saleDays",
  );
  assert.equal(weeklySaleIssue(draft({ saleDays: "3650" }), 100_000n), null);
  assert.equal(
    weeklySaleIssue(draft({ saleCliffDays: "x" }), 100_000n)?.field,
    "saleCliffDays",
  );
  assert.equal(
    weeklySaleIssue(draft({ saleCliffDays: "181", saleDays: "180" }), 100_000n)
      ?.field,
    "saleCliffDays",
  );
  assert.equal(
    weeklySaleIssue(draft({ saleCliffDays: "180", saleDays: "180" }), 100_000n),
    null,
  );
  assert.throws(
    () => weeklySaleTerms(draft({ saleDays: "0" }), 100_000n),
    /day/,
  );
});

const MONEY = `0x${"c0".repeat(20)}`;
const POOL_FACTORY = `0x${"b1".repeat(20)}`;
const BACKING = `0x${"b3".repeat(20)}`;
/** A weekly-sale kit: it names a market factory and has no pool factory (that call reverts). */
const weeklyKit = () => async (to, data) => {
  if (data === CALL_POOL_FACTORY) throw new Error("execution reverted");
  return WORD(FACTORY);
};
/** The pool kit: both calls answer. */
const poolKit =
  (pool = POOL_FACTORY) =>
  async (to, data) =>
    data === CALL_POOL_FACTORY ? WORD(pool) : WORD(FACTORY);
const INVESTING = {
  VITE_INVESTING: "1",
  VITE_BACKING_POOL_FACTORY: JSON.stringify({ 11155111: POOL_FACTORY }),
  VITE_BACKING_QUOTE_TOKEN: JSON.stringify({ 11155111: BACKING }),
};

test("the kit's version is read from the kit itself: a market factory answer means the weekly-sale kit, a refused call means the plain kit", async () => {
  const env = {
    VITE_SECONDARY_MARKET_FACTORY: JSON.stringify({ 11155111: FACTORY }),
    VITE_TRADING_TRIAL: "1",
    VITE_TEST_QUOTE_TOKENS: JSON.stringify({ 11155111: QUOTE }),
  };
  const ok = await readKitSale(weeklyKit(), KIT, 11155111, env);
  assert.deepEqual(ok, {
    weekly: { marketFactory: FACTORY, quote: QUOTE, pool: false },
    problem: null,
  });
  // The plain kit has no such function: the call reverts, or answers nothing.
  for (const legacy of [
    async () => {
      throw new Error("execution reverted");
    },
    async () => "0x",
  ]) {
    assert.deepEqual(await readKitSale(legacy, KIT, 11155111, {}), {
      weekly: null,
      problem: null,
    });
  }
  // A node that is down is not "a plain kit": the error stands, so a founder is never sent to the wrong launch.
  await assert.rejects(
    readKitSale(
      async () => {
        throw new Error("The network did not answer just now.");
      },
      KIT,
      11155111,
      env,
    ),
    /did not answer/,
  );
  // A kit that answers with the empty address is not one we can use either.
  await assert.rejects(
    readKitSale(async () => WORD(`0x${"0".repeat(40)}`), KIT, 11155111, env),
    /market/i,
  );
});

test("a weekly-sale kit is refused, with a plain reason, where the build does not fit it", async () => {
  const full = {
    VITE_SECONDARY_MARKET_FACTORY: JSON.stringify({ 11155111: FACTORY }),
    VITE_TRADING_TRIAL: "1",
    VITE_TEST_QUOTE_TOKENS: JSON.stringify({ 11155111: QUOTE }),
  };
  const call = weeklyKit();
  const problem = async (env, answer = call) =>
    (await readKitSale(answer, KIT, 11155111, env)).problem;
  // Trading off is no reason to refuse Shares setup: the market stays shut (no round opens until a vote lists it) and
  // the launch goes ahead with the token the build names.
  const off = await readKitSale(call, KIT, 11155111, {
    ...full,
    VITE_TRADING_TRIAL: "",
  });
  assert.deepEqual(off, {
    weekly: { marketFactory: FACTORY, quote: QUOTE, pool: false },
    problem: null,
  });
  // With no trading setting at all, and no test token, the network's own money opens the market instead.
  const bare = await readKitSale(call, KIT, 11155111, {}, MONEY);
  assert.deepEqual(bare, {
    weekly: { marketFactory: FACTORY, quote: MONEY, pool: false },
    problem: null,
  });
  // The kit's market factory is not the one the app reads.
  assert.match(
    await problem(full, async () => WORD(`0x${"9c".repeat(20)}`)),
    /do not agree/,
  );
  // No token at all for this network: nothing to open the market with.
  assert.match(
    await problem({ ...full, VITE_TEST_QUOTE_TOKENS: "" }),
    /token/i,
  );
  // None of the messages shows a protocol word.
  for (const message of [
    await problem({ ...full, VITE_TEST_QUOTE_TOKENS: "" }),
    await problem(full, async () => WORD(`0x${"9c".repeat(20)}`)),
  ]) {
    assert.doesNotMatch(message, /VITE_|kit\b|ERC|nsec|relay/i);
  }
});

test("a launch that fits is let through; one over the per-step limit, refused by the node, or unanswered gets a plain reason and nothing is sent", async () => {
  assert.equal(await assertLaunchFits(async () => 10_800_000n), 10_800_000n);
  assert.equal(
    await assertLaunchFits(async () => LAUNCH_GAS_CAP),
    LAUNCH_GAS_CAP,
  );
  const failure = async (run) => {
    try {
      await assertLaunchFits(run);
    } catch (error) {
      return error;
    }
    assert.fail("expected a refusal");
  };
  const tooBig = await failure(async () => LAUNCH_GAS_CAP + 1n);
  assert.ok(tooBig instanceof ActingStepError);
  assert.match(tooBig.message, /more than the network allows in one step/);
  assert.match(tooBig.message, /nothing was sent/);
  const refused = await failure(async () => {
    throw new Error("execution reverted: custom error 0x1b3c5a4e");
  });
  assert.ok(refused instanceof ActingStepError);
  assert.match(refused.message, /would refuse/);
  assert.equal(
    refused.technical,
    "execution reverted: custom error 0x1b3c5a4e",
  );
  const silent = await failure(async () => {
    throw new Error("The network did not answer just now.");
  });
  assert.match(silent.message, /did not say what this step would cost/);
  // Never a raw node or machine word in the person's text.
  for (const error of [tooBig, refused, silent]) {
    assert.doesNotMatch(error.message, /gas|revert|eth_|0x/i);
  }
});

test("a node that refuses the launch for its size gets the too-big words, not 'try again'", async () => {
  for (const text of [
    "gas required exceeds allowance (16777216)",
    "intrinsic gas too high: gas limit too high",
    "transaction gas cap exceeded",
  ]) {
    let error;
    try {
      await assertLaunchFits(async () => {
        throw new Error(text);
      });
    } catch (caught) {
      error = caught;
    }
    assert.ok(error instanceof ActingStepError, text);
    assert.match(error.message, /more than the network allows in one step/);
    assert.doesNotMatch(error.message, /Try again/);
    assert.equal(error.technical, text);
  }
});

test("estimating is bounded: a node that never answers ends in the plain message, not a hang", async () => {
  const never = () => new Promise(() => {});
  let error;
  try {
    await assertLaunchFits(never, 20);
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof ActingStepError);
  assert.match(error.message, /did not say what this step would cost/);
});

test("the pool kit is used only with investing on, with the build's own pool factory and backing token", async () => {
  const ok = await readKitSale(poolKit(), KIT, 11155111, INVESTING);
  assert.deepEqual(ok, {
    weekly: { marketFactory: FACTORY, quote: BACKING, pool: true },
    problem: null,
  });
  // Investing off: the pool kit is not offered, and the reason is plain.
  const off = await readKitSale(poolKit(), KIT, 11155111, {});
  assert.equal(off.weekly, null);
  assert.match(off.problem, /backing/);
  // The kit's pool factory is not the one the build names.
  const other = await readKitSale(
    poolKit(`0x${"9d".repeat(20)}`),
    KIT,
    11155111,
    INVESTING,
  );
  assert.equal(other.weekly, null);
  assert.match(other.problem, /do not agree on where backing lives/);
  // No backing token named.
  const noToken = await readKitSale(poolKit(), KIT, 11155111, {
    ...INVESTING,
    VITE_BACKING_QUOTE_TOKEN: "",
  });
  assert.match(noToken.problem, /token backers pay in/);
  for (const message of [off.problem, other.problem, noToken.problem])
    assert.doesNotMatch(message, /VITE_|kit\b|ERC|nsec|relay|factory/i);
});

test("a node that does not answer about the pool factory is an error, not a plain weekly kit", async () => {
  await assert.rejects(
    readKitSale(
      async (to, data) => {
        if (data === CALL_POOL_FACTORY)
          throw new Error("The network did not answer just now.");
        return WORD(FACTORY);
      },
      KIT,
      11155111,
      INVESTING,
    ),
    /did not answer/,
  );
});

test("the pool launch is the weekly launch under its own name, with the same terms", () => {
  assert.equal(
    KIT_LAUNCH_V3_SIGNATURE,
    KIT_LAUNCH_V2_SIGNATURE.replace("launch(", "launchWithPool("),
  );
  const launch = {
    terms: contributorTerms(draft(), FOUNDER),
    salt: SALT,
    founder: FOUNDER,
    currency: MONEY,
    predictedBudget: `0x${"bb".repeat(20)}`,
    now: 1_000,
    quote: BACKING,
    sale: weeklySaleTerms({}, 100_000n),
  };
  const v2 = encodeKitLaunchV2(launch);
  const v3 = encodeKitLaunchV3(launch);
  assert.notEqual(v2.slice(0, 10), v3.slice(0, 10));
  assert.equal(v2.slice(10), v3.slice(10));
  assert.equal(v3.slice(0, 10), selectorOf(KIT_LAUNCH_V3_SIGNATURE));
});

test("the pool kit's limits are said in the form before anything is sent", () => {
  const ok = {
    name: "Docs Commons",
    symbol: "DOCS",
    reviewers: Array.from(
      { length: 8 },
      (_, i) => `0x${String(i + 1).repeat(40)}`,
    ).join("\n"),
  };
  assert.equal(poolKitIssue(ok), null);
  const nine = poolKitIssue({
    ...ok,
    reviewers: `${ok.reviewers}\n0x${"9".repeat(40)}`,
  });
  assert.equal(nine.field, "reviewers");
  assert.match(nine.message, /at most 8 reviewers/);
  assert.match(nine.message, /You named 9/);
  const long = poolKitIssue({ ...ok, name: "x".repeat(65) });
  assert.equal(long.field, "name");
  assert.equal(poolKitIssue({ ...ok, name: "x".repeat(64) }), null);
  // Bytes, not characters: 33 two-byte letters are 66 bytes.
  assert.equal(poolKitIssue({ ...ok, name: "é".repeat(33) }).field, "name");
  const symbol = poolKitIssue({ ...ok, symbol: "ABCDEFGHIJKLM" });
  assert.equal(symbol.field, "symbol");
  assert.equal(poolKitIssue({ ...ok, symbol: "ABCDEFGHIJKL" }), null);
  for (const issue of [nine, long, symbol])
    assert.doesNotMatch(issue.message, /byte|VITE_|kit\b|transaction|gas/i);
});
