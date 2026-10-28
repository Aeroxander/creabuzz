import assert from "node:assert/strict";
import { test } from "node:test";

import { describeDecision } from "./decisionDescribe.ts";
import { encodeFunctionData, encodeParameters, selectorOf } from "./evmAbi.ts";
import {
  closeTrancheDecision,
  describeFunding,
  FUNDING_NOTICE,
  FUNDING_SIGNATURES,
  fundingPhase,
  lowerCapDecision,
  openTrancheDecision,
  publishFundingDecision,
  readFundingContract,
  readFundingTerms,
  watchAssetsDecision,
} from "./fundingTerms.ts";
import { ROUND_SIGNATURES } from "./weeklyRounds.ts";

const TERMS = `0x${"f7".repeat(20)}`;
const DAO = `0x${"da".repeat(20)}`;
const ROUNDS = `0x${"a0".repeat(20)}`;
const TOKEN = `0x${"11".repeat(20)}`;
const E18 = 10n ** 18n;
const word = (v) => BigInt(v).toString(16).padStart(64, "0");
const words = (...v) => `0x${v.map(word).join("")}`;
const publish = (over = {}) =>
  publishFundingDecision({
    terms: TERMS,
    asShares: false,
    cap: 100n * E18,
    rounds: ROUNDS,
    unitsNow: null,
    ...over,
  });

test("the funding calls are the contract's (cast goldens)", () => {
  const sig = (s) => selectorOf(s);
  assert.equal(sig(FUNDING_SIGNATURES.publish), "0xf4ea866a");
  assert.equal(sig(FUNDING_SIGNATURES.watch), "0x77825a2d");
  assert.equal(sig(FUNDING_SIGNATURES.watchedOf), "0x11612005");
  assert.equal(sig(FUNDING_SIGNATURES.lowerCap), "0xd36b870c");
  assert.equal(sig(FUNDING_SIGNATURES.openTranche), "0x7fec729a");
  assert.equal(sig(FUNDING_SIGNATURES.closeTranche), "0x57018bae");
  assert.equal(sig(FUNDING_SIGNATURES.terms), "0xc8c819ac");
  assert.equal(sig(FUNDING_SIGNATURES.tranches), "0x3bb0170d");
  assert.equal(sig(FUNDING_SIGNATURES.fundingTerms), "0xb881228a");
  assert.equal(sig(ROUND_SIGNATURES.openFunding), "0xa5b729cd");
  assert.equal(sig(ROUND_SIGNATURES.lastFunding), "0x04b7a992");
  assert.equal(sig(ROUND_SIGNATURES.finishFunding), "0x9ccaed27");
});

test("publishing terms names the seller, calls the limit current, and says the notice", () => {
  const draft = publish({ unitsNow: 400n * E18 });
  assert.equal(draft.to, TERMS);
  assert.equal(
    draft.data,
    encodeFunctionData(
      FUNDING_SIGNATURES.publish,
      ["bool", "uint128", "address"],
      [false, 100n * E18, ROUNDS],
    ),
  );
  assert.equal(draft.title, "Set a funding limit of 100 new Loot");
  assert.match(draft.lines[0], /\(25% of the 400 units there are now\)/);
  assert.match(draft.lines[0], /current limit: a later vote can raise it/);
  assert.match(draft.lines[1], /no vote/);
  assert.match(draft.lines[2], /Only the weekly rounds at 0xa0a0/);
  assert.match(draft.lines[2], /30 days/);
  assert.equal(
    publish({ asShares: true, cap: E18 }).title,
    "Set a funding limit of 1 new Shares",
  );
  assert.equal(
    publish({ raising: true, cap: 200n * E18 }).title,
    "Raise the funding limit to 200 new units",
  );
  assert.throws(() => publish({ cap: 0n }), /above zero/);
  assert.throws(() => publish({ terms: "" }), /not set up on this network/);
  assert.throws(() => publish({ rounds: "" }), /Weekly rounds are not set up/);
});

test("watching tokens stops sales while the treasury holds them", () => {
  const draft = watchAssetsDecision({ terms: TERMS, tokens: [TOKEN] });
  assert.equal(
    draft.data,
    encodeFunctionData(
      FUNDING_SIGNATURES.watch,
      [{ array: "address" }],
      [[TOKEN]],
    ),
  );
  assert.equal(draft.title, "Stop sales while the treasury holds this token");
  assert.equal(
    watchAssetsDecision({ terms: TERMS, tokens: [] }).title,
    "Check only for ETH before selling",
  );
  assert.throws(
    () => watchAssetsDecision({ terms: TERMS, tokens: ["nope"] }),
    /not an address/,
  );
});

test("each funding vote reads back as the decision that made it, and only on this DAO's contract", () => {
  const open = openTrancheDecision({
    terms: TERMS,
    quantity: 40n * E18,
    leastPrice: 1_100_000n,
    expiry: Date.UTC(2026, 11, 31) / 1000,
  });
  assert.equal(open.title, "Sell up to 40 new units for the project");
  assert.match(
    open.lines[0],
    /at 1\.1 USDC a unit or more, until Dec 31, 2026/,
  );
  assert.equal(
    lowerCapDecision({ terms: TERMS, cap: 50n * E18 }).title,
    "Lower the funding limit to 50 new units",
  );
  const ctx = { fundingTerms: TERMS.toUpperCase().replace("0X", "0x") };
  for (const draft of [
    open,
    closeTrancheDecision({ terms: TERMS }),
    lowerCapDecision({ terms: TERMS, cap: 50n * E18 }),
    publish(),
    watchAssetsDecision({ terms: TERMS, tokens: [TOKEN] }),
  ]) {
    assert.equal(
      describeFunding({ to: draft.to, data: draft.data }, ctx).title,
      draft.title,
    );
    assert.equal(
      describeDecision({ to: draft.to, data: draft.data }, ctx).title,
      draft.title,
    );
  }
  assert.equal(
    describeFunding({ to: `0x${"77".repeat(20)}`, data: open.data }, ctx),
    null,
    "the same call to another contract is not this DAO's funding",
  );
});

test("where terms stand: none, the notice, ready, selling", () => {
  const view = {
    contract: TERMS,
    published: true,
    rounds: ROUNDS,
    watched: [],
    asShares: false,
    activeFrom: 1000,
    cap: 100n * E18,
    sold: 0n,
    tranche: null,
    reserved: 0n,
  };
  assert.equal(fundingPhase({ ...view, published: false }, 0), "none");
  assert.equal(fundingPhase(view, 999), "notice");
  assert.equal(fundingPhase(view, 1000), "ready");
  const tranche = {
    quantity: 40n * E18,
    taken: 0n,
    leastPrice: 1n,
    expiry: 5000,
  };
  assert.equal(fundingPhase({ ...view, tranche }, 1000), "selling");
  assert.equal(fundingPhase({ ...view, tranche }, 5000), "ready", "expired");
  assert.equal(
    fundingPhase({ ...view, tranche: { ...tranche, taken: 40n * E18 } }, 1000),
    "ready",
    "all sold",
  );
  assert.equal(
    fundingPhase(
      {
        ...view,
        tranche: { ...tranche, taken: 40n * E18 },
        reserved: 40n * E18,
      },
      1000,
    ),
    "selling",
    "an open funding round holds it: still on sale",
  );
  assert.equal(FUNDING_NOTICE, 30 * 86_400);
});

test("a DAO's terms, tranche and watched tokens are read from its summoner's funding-terms contract", async () => {
  const of = (sig) => encodeFunctionData(sig, ["address"], [DAO]);
  const answers = new Map([
    [
      of(FUNDING_SIGNATURES.terms),
      words(1, 0, 1000, 100n * E18, 40n * E18, BigInt(ROUNDS)),
    ],
    [
      of(FUNDING_SIGNATURES.tranches),
      words(40n * E18, 40n * E18, 1_100_000, 9000),
    ],
    [of(FUNDING_SIGNATURES.reserved), words(0)],
    [
      of(FUNDING_SIGNATURES.watchedOf),
      encodeParameters([{ array: "address" }], [[TOKEN]]),
    ],
  ]);
  const chain = {
    call: async (to, data) => {
      assert.equal(to, TERMS);
      return answers.get(data);
    },
  };
  assert.deepEqual(await readFundingTerms(chain, TERMS, DAO), {
    contract: TERMS,
    published: true,
    rounds: ROUNDS,
    watched: [TOKEN],
    asShares: false,
    activeFrom: 1000,
    cap: 100n * E18,
    sold: 40n * E18,
    tranche: {
      quantity: 40n * E18,
      taken: 40n * E18,
      leastPrice: 1_100_000n,
      expiry: 9000,
    },
    reserved: 0n,
  });
  assert.equal(
    await readFundingContract({ call: async () => words(BigInt(TERMS)) }, DAO),
    TERMS,
  );
  assert.equal(
    await readFundingContract(
      {
        call: async () => {
          throw new Error("execution reverted");
        },
      },
      DAO,
    ),
    null,
    "a factory from before funding terms has none",
  );
});
