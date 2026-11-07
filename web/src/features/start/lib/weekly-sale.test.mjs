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
  encodeKitLaunchV2,
  encodePredictLaunch,
  KIT_LAUNCH_V2_SIGNATURE,
  LAUNCH_GAS_CAP,
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

test("the kit's version is read from the kit itself: a market factory answer means the weekly-sale kit, a refused call means the plain kit", async () => {
  const env = {
    VITE_SECONDARY_MARKET_FACTORY: JSON.stringify({ 11155111: FACTORY }),
    VITE_TRADING_TRIAL: "1",
    VITE_TEST_QUOTE_TOKENS: JSON.stringify({ 11155111: QUOTE }),
  };
  const ok = await readKitSale(async () => WORD(FACTORY), KIT, 11155111, env);
  assert.deepEqual(ok, {
    weekly: { marketFactory: FACTORY, quote: QUOTE },
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
  const call = async () => WORD(FACTORY);
  const problem = async (env, answer = call) =>
    (await readKitSale(answer, KIT, 11155111, env)).problem;
  // Trading off: a launch on this kit would make a project that can never be traded, so it is not offered.
  const off = await problem({ ...full, VITE_TRADING_TRIAL: "" });
  assert.match(off, /trading/i);
  assert.equal(
    (
      await readKitSale(call, KIT, 11155111, {
        ...full,
        VITE_TRADING_TRIAL: "",
      })
    ).weekly,
    null,
  );
  // The kit's market factory is not the one the app reads.
  assert.match(
    await problem(full, async () => WORD(`0x${"9c".repeat(20)}`)),
    /do not agree/,
  );
  // No test token named for this network.
  assert.match(
    await problem({ ...full, VITE_TEST_QUOTE_TOKENS: "" }),
    /trade token|token/i,
  );
  // None of the messages shows a protocol word.
  for (const message of [
    off,
    await problem({ ...full, VITE_TEST_QUOTE_TOKENS: "" }),
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
