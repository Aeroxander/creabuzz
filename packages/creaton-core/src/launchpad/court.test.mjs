import assert from "node:assert/strict";
import { test } from "node:test";

import {
  caseActions,
  COMMIT,
  COURT_SIGNATURES,
  commitHash,
  decodeAbout,
  decodeDispute,
  decodeRound,
  EVIDENCE,
  encodeCommit,
  FAUCET_SIGNATURES,
  encodeReveal,
  encodeStake,
  periodEnds,
  readCourt,
  saltFromSignature,
  sealedChoice,
  TOPIC_DISPUTE_CREATED,
  voteKeyMessage,
} from "./court.ts";
import { encodeFunctionData, encodeParameters, selectorOf } from "./evmAbi.ts";
import { encodeCall0 } from "./work.ts";

const COURT = `0x${"c0".repeat(20)}`;
const JUROR = "0x00000000000000000000000000000000000000a1";
const word = (v) => BigInt(v).toString(16).padStart(64, "0");
const words = (...v) => `0x${v.map(word).join("")}`;
const SALT = `0x${"11".repeat(32)}`;

test("the selectors and the seal are the court's (cast goldens)", () => {
  const sig = (s) => selectorOf(s);
  assert.equal(sig(COURT_SIGNATURES.stake), "0xa694fc3a");
  assert.equal(sig(COURT_SIGNATURES.unstake), "0x2e17de78");
  assert.equal(sig(COURT_SIGNATURES.withdraw), "0x3ccfd60b");
  assert.equal(sig(COURT_SIGNATURES.draw), "0x3b304147");
  assert.equal(sig(COURT_SIGNATURES.commit), "0xf2f03877");
  assert.equal(sig(COURT_SIGNATURES.reveal), "0x9a42f3aa");
  assert.equal(sig(COURT_SIGNATURES.passPeriod), "0x115d5376");
  assert.equal(sig(COURT_SIGNATURES.appeal), "0x7e69b7b0");
  assert.equal(sig(COURT_SIGNATURES.execute), "0xfe0d94c1");
  assert.equal(sig(COURT_SIGNATURES.timeout), "0x08148f7a");
  assert.equal(sig(COURT_SIGNATURES.submitEvidence), "0xa6a7f0eb");
  assert.equal(sig(COURT_SIGNATURES.jurors), "0xdca5f6b0");
  assert.equal(sig(COURT_SIGNATURES.disputes), "0x564a565d");
  assert.equal(sig(COURT_SIGNATURES.roundOf), "0x88ec0651");
  assert.equal(sig(COURT_SIGNATURES.votes), "0xc8db7e7a");
  assert.equal(sig(FAUCET_SIGNATURES.drip), "0x9f678cca");
  assert.equal(sig(FAUCET_SIGNATURES.lastDrip), "0x0935f004");
  assert.equal(
    TOPIC_DISPUTE_CREATED,
    "0x15e9bf35408a795291d34104ee1156c623475413cc49411af45b69a72b93e9d4",
  );
  assert.equal(
    commitHash(1, SALT, JUROR, 3n, 0),
    "0x2e1a0aba73949ed9b4b38d088aec65ddd0f9a990239fb40fbf2be8df54e49f27",
  );
  assert.notEqual(
    commitHash(2, SALT, JUROR, 3n, 0),
    commitHash(1, SALT, JUROR, 3n, 0),
  );
  assert.throws(() => encodeStake(0n), /above zero/);
  assert.throws(() => encodeCommit(1n, "0x12"), /seal/);
  assert.throws(() => encodeReveal(1n, 1, "0x12"), /secret/);
});

test("which way a sealed vote went is found by trying both choices against the seal", () => {
  const seal = commitHash(2, SALT, JUROR, 3n, 1);
  assert.equal(sealedChoice(seal, SALT, JUROR, 3n, 1), 2);
  assert.equal(
    sealedChoice(commitHash(1, SALT, JUROR, 3n, 1), SALT, JUROR, 3n, 1),
    1,
  );
  assert.equal(
    sealedChoice(seal, `0x${"22".repeat(32)}`, JUROR, 3n, 1),
    null,
    "another secret opens nothing",
  );
  assert.equal(
    sealedChoice(seal, SALT, JUROR, 3n, 0),
    null,
    "another round opens nothing",
  );
});

test("the vote key is the same words every time, so the same wallet opens what it sealed", () => {
  assert.equal(
    voteKeyMessage(COURT, 4n, 0),
    voteKeyMessage(COURT.toUpperCase().replace("0X", "0x"), 4n, 0),
  );
  assert.notEqual(voteKeyMessage(COURT, 4n, 0), voteKeyMessage(COURT, 4n, 1));
  assert.match(voteKeyMessage(COURT, 4n, 1), /case 4 round 2/);
  const a = saltFromSignature(`0x${"ab".repeat(65)}`);
  assert.match(a, /^0x[0-9a-f]{64}$/);
  assert.equal(a, saltFromSignature(`0x${"AB".repeat(65)}`));
});

test("a case, its round and what it is about decode from the court's answers", () => {
  assert.deepEqual(decodeDispute(words(BigInt(COURT), 2, 1, 500, 0)), {
    arbitrable: COURT,
    rounds: 2,
    period: "commit",
    periodStart: 500,
    ruling: 0,
  });
  assert.equal(decodeDispute(words(0, 0, 0, 0, 0)), null);
  const round = encodeParameters(
    [
      "uint256",
      "uint256",
      "uint256",
      "uint256",
      "uint256",
      "uint256",
      { array: "address" },
    ],
    [7n, 7_000_000n, 3n, 2n, 4n, 1n, [JUROR]],
  );
  assert.deepEqual(decodeRound(round), {
    seats: 7,
    fee: 7_000_000n,
    committed: 3,
    revealed: 2,
    forSeats: 4,
    againstSeats: 1,
    drawn: [JUROR],
  });
  assert.deepEqual(
    decodeAbout(encodeParameters(["uint256", "uint32"], [9n, 2n])),
    {
      bounty: 9n,
      claim: 2,
    },
  );
  assert.equal(decodeAbout("0x12"), null);
});

const kase = (over = {}) => ({
  id: 1n,
  arbitrable: COURT,
  about: null,
  period: "evidence",
  periodStart: 1_000,
  rounds: 1,
  ruling: 0,
  round: {
    seats: 3,
    fee: 3n,
    committed: 0,
    revealed: 0,
    forSeats: 0,
    againstSeats: 0,
    drawn: [],
  },
  mine: null,
  appealCost: 7n,
  ...over,
});

test("each step is offered exactly when the court allows it", () => {
  const c = kase();
  assert.equal(periodEnds(c), 1_000 + EVIDENCE);
  assert.equal(caseActions(c, 3, 1_000 + EVIDENCE - 1).draw, false);
  assert.equal(caseActions(c, 3, 1_000 + EVIDENCE).draw, true);
  assert.equal(
    caseActions(c, 2, 1_000 + EVIDENCE).draw,
    false,
    "not enough free seats",
  );
  assert.equal(caseActions(c, 2, 1_000 + EVIDENCE + 14 * 86_400).timeout, true);
  assert.equal(
    caseActions(kase({ rounds: 2 }), 7, 1_000).draw,
    true,
    "an appeal round draws at once",
  );
  const sealing = kase({
    period: "commit",
    round: { ...c.round, drawn: [JUROR] },
    mine: { seats: 3, sealed: false, choice: 0 },
  });
  assert.equal(caseActions(sealing, 0, 1_000).seal, true);
  assert.equal(caseActions(sealing, 0, 1_000 + COMMIT).seal, false);
  assert.equal(caseActions(sealing, 0, 1_000).moveOn, false);
  assert.equal(caseActions(sealing, 0, 1_000 + COMMIT).moveOn, true);
  const sealed = {
    ...sealing,
    round: { ...sealing.round, committed: 1 },
    mine: { seats: 3, sealed: true, choice: 0 },
  };
  assert.equal(
    caseActions(sealed, 0, 1_000).moveOn,
    true,
    "everyone sealed: no need to wait",
  );
  const opening = { ...sealed, period: "reveal" };
  assert.equal(caseActions(opening, 0, 1_000).open, true);
  const appealing = kase({ period: "appeal" });
  assert.equal(caseActions(appealing, 0, 1_000).appeal, true);
  assert.equal(caseActions(appealing, 0, 1_000).settle, false);
  assert.equal(caseActions(appealing, 0, 1_000 + 2 * 86_400).settle, true);
  const last = kase({ period: "appeal", rounds: 3 });
  assert.equal(caseActions(last, 0, 1_000).appeal, false);
  assert.equal(
    caseActions(last, 0, 1_000).settle,
    true,
    "the last round settles at once",
  );
});

test("the court, a juror's stake and the newest cases are read from the chain", async () => {
  const extra = encodeParameters(["uint256", "uint32"], [5n, 1n]);
  const chain = {
    call: async (to, data) => {
      assert.equal(to, COURT);
      const answers = {
        [encodeCall0(COURT_SIGNATURES.stakeToken)]: words(0xc7),
        [encodeCall0(COURT_SIGNATURES.feeToken)]: words(0x05),
        [encodeCall0(COURT_SIGNATURES.seatStake)]: words(100n * 10n ** 18n),
        [encodeCall0(COURT_SIGNATURES.feePerSeat)]: words(1_000_000),
        [encodeCall0(COURT_SIGNATURES.freeSeats)]: words(3),
        [encodeFunctionData(COURT_SIGNATURES.disputes, ["uint256"], [1n])]:
          words(BigInt(COURT), 1, 0, 900, 0),
        [encodeFunctionData(
          COURT_SIGNATURES.roundOf,
          ["uint256", "uint256"],
          [1n, 0n],
        )]: encodeParameters(
          [
            "uint256",
            "uint256",
            "uint256",
            "uint256",
            "uint256",
            "uint256",
            { array: "address" },
          ],
          [3n, 3_000_000n, 0n, 0n, 0n, 0n, []],
        ),
        [encodeFunctionData(
          COURT_SIGNATURES.votes,
          ["uint256", "uint256", "address"],
          [1n, 0n, JUROR],
        )]: words(0, 0, 0),
        [encodeFunctionData(COURT_SIGNATURES.appealCost, ["uint256"], [1n])]:
          words(7_000_000),
        [encodeFunctionData(COURT_SIGNATURES.jurors, ["address"], [JUROR])]:
          words(300n * 10n ** 18n, 0, 1, 3),
        [encodeFunctionData(COURT_SIGNATURES.owedFee, ["address"], [JUROR])]:
          words(0),
        [encodeFunctionData(COURT_SIGNATURES.owedStake, ["address"], [JUROR])]:
          words(0),
      };
      if (!(data in answers)) throw new Error(`unexpected ${data}`);
      return answers[data];
    },
    logs: async ({ topics }) => {
      assert.equal(topics[0], TOPIC_DISPUTE_CREATED);
      return [
        {
          topics: [
            TOPIC_DISPUTE_CREATED,
            `0x${word(1)}`,
            `0x${word(BigInt(COURT))}`,
          ],
          data: encodeParameters(["uint256", "bytes"], [3_000_000n, extra]),
        },
      ];
    },
  };
  const view = await readCourt(chain, COURT, JUROR);
  assert.equal(view.freeSeats, 3);
  assert.equal(view.juror.freeSeats, 3);
  assert.equal(view.cases.length, 1);
  assert.deepEqual(view.cases[0].about, { bounty: 5n, claim: 1 });
  assert.equal(view.cases[0].period, "evidence");
  assert.deepEqual(view.cases[0].mine, {
    seats: 0,
    sealed: false,
    commit: `0x${"0".repeat(64)}`,
    choice: 0,
  });
  assert.equal(view.cases[0].appealCost, 7_000_000n);
});
