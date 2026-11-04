import assert from "node:assert/strict";
import { test } from "node:test";

import { describeDecision } from "./decisionDescribe.ts";
import { encodeFunctionData, encodeParameters, selectorOf } from "./evmAbi.ts";
import {
  acceptTokensDecision,
  closeTrancheDecision,
  encodeFlagToken,
  describeFunding,
  FUNDING_NOTICE,
  FUNDING_SIGNATURES,
  fundingContractOrThrow,
  fundingPhase,
  feePercent,
  lowerCapDecision,
  lowerExitFeeDecision,
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
    exitFeeBps: 200,
    unitsNow: null,
    ...over,
  });

test("the funding calls are the contract's (cast goldens)", () => {
  const sig = (s) => selectorOf(s);
  assert.equal(sig(FUNDING_SIGNATURES.publish), "0x5175464b");
  assert.equal(sig(FUNDING_SIGNATURES.lowerExitFee), "0xb7a84504");
  assert.equal(sig(FUNDING_SIGNATURES.exitFeeOf), "0xecdc9f59");
  assert.equal(sig(FUNDING_SIGNATURES.watch), "0x77825a2d");
  assert.equal(sig(FUNDING_SIGNATURES.flag), "0x1d2c6717");
  assert.equal(sig(FUNDING_SIGNATURES.accept), "0xff9ce28a");
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
      ["bool", "uint128", "address", "uint16"],
      [false, 100n * E18, ROUNDS, 200n],
    ),
  );
  assert.equal(draft.title, "Set a funding limit of 100 new non-voting shares");
  assert.match(
    draft.lines[0],
    /\(25% of the 400 Shares and non-voting shares there are now\)/,
  );
  assert.match(draft.lines[0], /current limit: a later vote can raise it/);
  assert.match(draft.lines[1], /no vote/);
  assert.match(draft.lines[2], /Only the weekly rounds at 0xa0a0/);
  assert.match(draft.lines[2], /30 days/);
  assert.match(draft.lines[3], /^Exit fee 2%: .*stays in the treasury/);
  assert.match(draft.lines[3], /not charged during the 30 days' notice/);
  assert.match(publish({ exitFeeBps: 0 }).lines[3], /No exit fee/);
  assert.throws(() => publish({ exitFeeBps: 501 }), /between 0% and 5%/);
  assert.throws(() => publish({ exitFeeBps: 1.5 }), /between 0% and 5%/);
  assert.equal(feePercent(250), "2.5%");
  assert.equal(
    publish({ asShares: true, cap: E18 }).title,
    "Set a funding limit of 1 new Share",
  );
  assert.equal(
    publish({ cap: E18 }).lines[0].startsWith(
      "Up to 1 new non-voting share may",
    ),
    true,
  );
  assert.equal(
    publish({ raising: true, cap: 200n * E18 }).title,
    "Raise the funding limit to 200 new non-voting shares",
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
  assert.throws(
    () => watchAssetsDecision({ terms: TERMS, tokens: [] }),
    /at least one token/,
  );
  assert.match(draft.lines[0], /stays on the list until/);
  const accept = acceptTokensDecision({
    terms: TERMS,
    tokens: [TOKEN],
    yes: true,
  });
  assert.equal(accept.title, "Sell even while the treasury holds this token");
  assert.match(accept.lines[0], /buyers get part of these tokens too/);
  assert.equal(
    acceptTokensDecision({ terms: TERMS, tokens: [TOKEN], yes: false }).title,
    "Stop sales again while the treasury holds this token",
  );
  assert.equal(
    encodeFlagToken(DAO, TOKEN),
    encodeFunctionData(
      FUNDING_SIGNATURES.flag,
      ["address", "address"],
      [DAO, TOKEN],
    ),
  );
  assert.throws(() => encodeFlagToken(DAO, "nope"), /not an address/);
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
  assert.equal(open.title, "Sell up to 40 new shares for the project");
  assert.match(
    open.lines[0],
    /at 1\.1 USDC a share or more, until Dec 31, 2026/,
  );
  assert.equal(
    lowerCapDecision({ terms: TERMS, cap: 50n * E18 }).title,
    "Lower the funding limit to 50 new shares",
  );
  assert.equal(
    lowerExitFeeDecision({ terms: TERMS, exitFeeBps: 100 }).title,
    "Lower the exit fee to 1%",
  );
  assert.equal(
    lowerExitFeeDecision({ terms: TERMS, exitFeeBps: 0 }).title,
    "Remove the exit fee",
  );
  const ctx = { fundingTerms: TERMS.toUpperCase().replace("0X", "0x") };
  for (const draft of [
    open,
    lowerExitFeeDecision({ terms: TERMS, exitFeeBps: 100 }),
    lowerExitFeeDecision({ terms: TERMS, exitFeeBps: 0 }),
    acceptTokensDecision({ terms: TERMS, tokens: [TOKEN], yes: true }),
    acceptTokensDecision({ terms: TERMS, tokens: [TOKEN], yes: false }),
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
    exitFeeBps: 200,
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
      words(1, 0, 1000, 100n * E18, 40n * E18, BigInt(ROUNDS), 200),
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
    exitFeeBps: 200,
    tranche: {
      quantity: 40n * E18,
      taken: 40n * E18,
      leastPrice: 1_100_000n,
      expiry: 9000,
    },
    reserved: 0n,
  });
  // Three answers, never two. `present` names the contract; `absent` is the
  // contract's own zero address; `unreadable` is a read we do not have.
  assert.deepEqual(
    await readFundingContract({ call: async () => words(BigInt(TERMS)) }, DAO),
    { kind: "present", address: TERMS },
  );
  assert.deepEqual(
    await readFundingContract({ call: async () => words(0n) }, DAO),
    { kind: "absent" },
    "the zero address is the factory saying it has no funding terms",
  );
  // A revert is the contract refusing the selector — what a factory from before
  // D133 does. This is the only failure that may read as absence.
  assert.deepEqual(
    await readFundingContract(
      {
        call: async () => {
          throw new Error("execution reverted");
        },
      },
      DAO,
    ),
    { kind: "absent" },
  );

  // The defect this guards: a node that did not answer must NEVER read as
  // "this factory predates funding terms". Each of these is a failure the
  // caller has to show as a failure.
  const unreadable = [
    [
      "a timeout",
      Object.assign(new Error("The chain node did not answer in time."), {
        name: "ChainReadError",
      }),
    ],
    [
      "an unreachable node",
      Object.assign(new Error("Could not reach the chain node."), {
        name: "ChainReadError",
      }),
    ],
    [
      "a busy node",
      Object.assign(new Error("The chain node is busy."), {
        name: "ChainReadError",
      }),
    ],
    ["a plain transport failure", new TypeError("fetch failed")],
    ["an http refusal", new Error("rpc http 503")],
  ];
  for (const [why, error] of unreadable) {
    const read = await readFundingContract(
      {
        call: async () => {
          throw error;
        },
      },
      DAO,
    );
    assert.equal(
      read.kind,
      "unreadable",
      `${why} must be unreadable, not absent`,
    );
    assert.notEqual(read.kind, "absent", `${why} must not read as "predates"`);
    assert.match(
      read.reason,
      new RegExp(
        error.message.slice(0, 18).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      ),
      "the reason is carried through",
    );
  }

  // An answer that is not an address is a read we do not have either.
  for (const bad of ["0x", "0x1234", "not-hex"]) {
    const read = await readFundingContract({ call: async () => bad }, DAO);
    assert.equal(
      read.kind,
      "unreadable",
      `an answer of ${bad} is not an address`,
    );
  }
});

/**
 * The seam every funding card goes through: `FundingContractRead` becomes a
 * maybe-address here and nowhere else, so a failed read throws instead of
 * arriving at the UI as "this factory predates funding terms".
 */
test("a funding read that did not complete throws at the caller seam", () => {
  assert.equal(
    fundingContractOrThrow({ kind: "present", address: TERMS }),
    TERMS,
  );
  assert.equal(fundingContractOrThrow({ kind: "absent" }), null);
  assert.throws(
    () =>
      fundingContractOrThrow({
        kind: "unreadable",
        reason: "The chain node did not answer in time.",
      }),
    /did not answer in time/,
    "a failed read must not become a null the UI renders as absence",
  );
});
