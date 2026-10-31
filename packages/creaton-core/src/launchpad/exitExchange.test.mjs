import assert from "node:assert/strict";
import { test } from "node:test";

import { describeDecision } from "./decisionDescribe.ts";
import { encodeFunctionData, selectorOf } from "./evmAbi.ts";
import {
  allowRoundsDecision,
  EXIT_EXCHANGE_SIGNATURES,
  encodeActivateExitExchange,
  exitExchangeState,
  readExitExchange,
  stopExchangeDecision,
} from "./exitExchange.ts";
import { UNLOCK_NOTICE } from "./tradingActions.ts";

const ROUNDS = "0x00000000000000000000000000000000000e1717";
const SHARES = "0x0000000000000000000000000000000000000005";
const OTHER = "0x0000000000000000000000000000000000000006";
const word = (v) => BigInt(v).toString(16).padStart(64, "0");
const words = (...v) => `0x${v.map(word).join("")}`;

test("the selectors are the Shares' (cast sig goldens)", () => {
  const sig = (s) => selectorOf(s);
  assert.equal(sig(EXIT_EXCHANGE_SIGNATURES.announce), "0x0ac75141");
  assert.equal(sig(EXIT_EXCHANGE_SIGNATURES.activate), "0x137f703a");
  assert.equal(sig(EXIT_EXCHANGE_SIGNATURES.clear), "0x838cf4ee");
  assert.equal(sig(EXIT_EXCHANGE_SIGNATURES.exchange), "0x6e80cd03");
  assert.equal(sig(EXIT_EXCHANGE_SIGNATURES.pending), "0x6cb21d83");
  assert.equal(sig(EXIT_EXCHANGE_SIGNATURES.announcedAt), "0x952e389a");
  assert.equal(encodeActivateExitExchange(), "0x137f703a");
});

test("the votes name rounds on the Shares or turn them off, and read back in the same words", () => {
  const allow = allowRoundsDecision({ sharesToken: SHARES, exchange: ROUNDS });
  assert.equal(allow.to, SHARES);
  assert.equal(
    allow.data,
    "0x0ac7514100000000000000000000000000000000000000000000000000000000000e1717",
  );
  assert.equal(allow.lane, "unrestricted");
  const ctx = { projectToken: SHARES, weeklyRounds: ROUNDS };
  assert.equal(describeDecision(allow, ctx).title, allow.title);
  const stop = stopExchangeDecision({ sharesToken: SHARES });
  assert.equal(stop.data, "0x838cf4ee");
  assert.deepEqual(describeDecision(stop, ctx), {
    kind: "trading",
    title: stop.title,
    lines: stop.lines,
  });
  assert.throws(
    () => allowRoundsDecision({ sharesToken: SHARES, exchange: "" }),
    /not set up/,
  );
});

test("a vote naming any other contract as the exchange says so, and one aimed elsewhere is not described as rounds", () => {
  const other = allowRoundsDecision({ sharesToken: SHARES, exchange: OTHER });
  const described = describeDecision(other, {
    projectToken: SHARES,
    weeklyRounds: ROUNDS,
  });
  assert.equal(described.title, "Let another contract move Shares in 30 days");
  assert.match(described.lines[0], /not the one this app knows/);
  assert.equal(
    describeDecision(other, { projectToken: SHARES }).title,
    "Let another contract move Shares in 30 days",
    "with no exchange known, nothing is called the app's",
  );
  assert.equal(
    describeDecision(
      { ...other, to: OTHER },
      { projectToken: SHARES, weeklyRounds: ROUNDS },
    ).kind,
    "unknown",
  );
  assert.equal(
    describeDecision(
      {
        to: SHARES,
        data: encodeFunctionData(
          EXIT_EXCHANGE_SIGNATURES.announce,
          ["uint256"],
          [1n << 200n],
        ),
      },
      { projectToken: SHARES, weeklyRounds: ROUNDS },
    ).kind,
    "unknown",
    "a word that is not an address is not an exchange",
  );
});

test("the exchange is off, announced, ready, on, or one this app does not know", () => {
  const read = (over = {}) => ({
    transfersLocked: true,
    exchange: null,
    pending: null,
    announcedAt: 0,
    ...over,
  });
  assert.deepEqual(exitExchangeState(read(), ROUNDS, 5), {
    phase: "off",
    opensAt: null,
  });
  const announced = read({ pending: ROUNDS, announcedAt: 100 });
  assert.deepEqual(
    exitExchangeState(announced, ROUNDS, 100 + UNLOCK_NOTICE - 1),
    { phase: "announced", opensAt: 100 + UNLOCK_NOTICE },
  );
  assert.equal(
    exitExchangeState(announced, ROUNDS, 100 + UNLOCK_NOTICE).phase,
    "ready",
  );
  assert.equal(
    exitExchangeState(read({ exchange: ROUNDS }), ROUNDS, 0).phase,
    "on",
  );
  assert.equal(
    exitExchangeState(read({ exchange: OTHER }), ROUNDS, 0).phase,
    "other",
  );
  assert.equal(
    exitExchangeState(read({ pending: OTHER }), ROUNDS, 0).phase,
    "other",
  );
  assert.equal(
    exitExchangeState(read({ exchange: ROUNDS }), null, 0).phase,
    "other",
  );
  assert.equal(
    exitExchangeState(read({ transfersLocked: false }), ROUNDS, 0).phase,
    "unlocked",
  );
});

test("the exchange's state is read from the Shares", async () => {
  const answers = {
    [selectorOf(EXIT_EXCHANGE_SIGNATURES.transfersLocked)]: words(1),
    [selectorOf(EXIT_EXCHANGE_SIGNATURES.exchange)]: words(0),
    [selectorOf(EXIT_EXCHANGE_SIGNATURES.pending)]: words(BigInt(ROUNDS)),
    [selectorOf(EXIT_EXCHANGE_SIGNATURES.announcedAt)]: words(77),
  };
  const chain = {
    call: async (to, data) => {
      assert.equal(to, SHARES);
      return answers[data];
    },
  };
  assert.deepEqual(await readExitExchange(chain, SHARES), {
    transfersLocked: true,
    exchange: null,
    pending: ROUNDS,
    announcedAt: 77,
  });
});
