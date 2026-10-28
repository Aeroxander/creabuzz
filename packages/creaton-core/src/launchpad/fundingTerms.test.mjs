import assert from "node:assert/strict";
import { test } from "node:test";

import { describeDecision } from "./decisionDescribe.ts";
import { encodeFunctionData, selectorOf } from "./evmAbi.ts";
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
} from "./fundingTerms.ts";
import { ROUND_SIGNATURES } from "./weeklyRounds.ts";

const TERMS = `0x${"f7".repeat(20)}`;
const DAO = `0x${"da".repeat(20)}`;
const E18 = 10n ** 18n;
const word = (v) => BigInt(v).toString(16).padStart(64, "0");
const words = (...v) => `0x${v.map(word).join("")}`;

test("the funding calls are the contract's (cast goldens)", () => {
  const sig = (s) => selectorOf(s);
  assert.equal(sig(FUNDING_SIGNATURES.publish), "0x7c65b57d");
  assert.equal(sig(FUNDING_SIGNATURES.lowerCap), "0xd36b870c");
  assert.equal(sig(FUNDING_SIGNATURES.openTranche), "0x7fec729a");
  assert.equal(sig(FUNDING_SIGNATURES.closeTranche), "0x57018bae");
  assert.equal(sig(FUNDING_SIGNATURES.terms), "0xc8c819ac");
  assert.equal(sig(FUNDING_SIGNATURES.tranches), "0x3bb0170d");
  assert.equal(sig(FUNDING_SIGNATURES.fundingTerms), "0xb881228a");
  assert.equal(sig(ROUND_SIGNATURES.openFunding), "0xa5b729cd");
  assert.equal(sig(ROUND_SIGNATURES.lastFunding), "0x04b7a992");
});

test("publishing terms says the instrument, the cap as a share of what exists, and the notice", () => {
  const draft = publishFundingDecision({
    terms: TERMS,
    asShares: false,
    cap: 100n * E18,
    unitsNow: 400n * E18,
  });
  assert.equal(draft.to, TERMS);
  assert.equal(
    draft.data,
    encodeFunctionData(
      FUNDING_SIGNATURES.publish,
      ["bool", "uint128"],
      [false, 100n * E18],
    ),
  );
  assert.equal(draft.title, "Let the project sell up to 100 new Loot");
  assert.match(draft.lines[0], /\(25% of the 400 units there are now\)/);
  assert.match(draft.lines[1], /no vote/);
  assert.match(draft.lines[2], /30 days/);
  assert.equal(
    publishFundingDecision({
      terms: TERMS,
      asShares: true,
      cap: E18,
      unitsNow: null,
    }).title,
    "Let the project sell up to 1 new Shares",
  );
  assert.throws(
    () =>
      publishFundingDecision({
        terms: TERMS,
        asShares: false,
        cap: 0n,
        unitsNow: null,
      }),
    /above zero/,
  );
  assert.throws(
    () =>
      publishFundingDecision({
        terms: "",
        asShares: false,
        cap: 1n,
        unitsNow: null,
      }),
    /not set up on this network/,
  );
});

test("a tranche, closing it and lowering the cap read as plain decisions, and the cards say them back", () => {
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
  const ctx = { fundingTerms: TERMS.toUpperCase().replace("0X", "0x") };
  for (const draft of [
    open,
    closeTrancheDecision({ terms: TERMS }),
    lowerCapDecision({ terms: TERMS, cap: 50n * E18 }),
    publishFundingDecision({
      terms: TERMS,
      asShares: false,
      cap: 100n * E18,
      unitsNow: null,
    }),
  ]) {
    const said = describeFunding({ to: draft.to, data: draft.data }, ctx);
    assert.equal(said.title, draft.title);
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

test("a DAO's terms and tranche are read from its summoner's funding-terms contract", async () => {
  const of = (sig) => encodeFunctionData(sig, ["address"], [DAO]);
  const answers = new Map([
    [of(FUNDING_SIGNATURES.terms), words(1, 0, 1000, 100n * E18, 40n * E18)],
    [
      of(FUNDING_SIGNATURES.tranches),
      words(40n * E18, 40n * E18, 1_100_000, 9000),
    ],
    [of(FUNDING_SIGNATURES.reserved), words(0)],
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
