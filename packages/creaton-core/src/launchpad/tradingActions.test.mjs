import assert from "node:assert/strict";
import { test } from "node:test";

import { describeDecision } from "./decisionDescribe.ts";
import {
  announceTradingDecision,
  cancelTradingDecision,
  issuanceAllowance,
  lockTradingDecision,
  NO_CAP,
  openTradingDecision,
  SHARE_RULE_SIGNATURES,
  TRADING_SIGNATURES,
  tradingState,
  UNLOCK_NOTICE,
} from "./tradingActions.ts";
import { selectorOf } from "./evmAbi.ts";

const SHARES = "0x00000000000000000000000000000000000000b5";
const DAO = "0x00000000000000000000000000000000000000d0";
const DAY = 86_400;
const WAD = 10n ** 18n;

test("the selectors are the contract's (cast sig goldens)", () => {
  assert.equal(selectorOf(TRADING_SIGNATURES.announce), "0x7fcf3a66");
  assert.equal(selectorOf(TRADING_SIGNATURES.cancel), "0xcc9b97f9");
  assert.equal(selectorOf(TRADING_SIGNATURES.setLocked), "0x0eda3c55");
  assert.equal(selectorOf(TRADING_SIGNATURES.daoSetLocked), "0x80fe038f");
  assert.equal(selectorOf(SHARE_RULE_SIGNATURES.awardsOnly), "0x0704ab61");
  assert.equal(selectorOf(SHARE_RULE_SIGNATURES.issuanceCapBps), "0x6243f127");
  assert.equal(selectorOf(SHARE_RULE_SIGNATURES.yearStart), "0x9e587fb6");
  assert.equal(selectorOf(SHARE_RULE_SIGNATURES.yearBase), "0xfc49192b");
  assert.equal(selectorOf(SHARE_RULE_SIGNATURES.issuedThisYear), "0x8e752da3");
  assert.equal(selectorOf(SHARE_RULE_SIGNATURES.transfersLocked), "0x83f1211b");
  assert.equal(
    selectorOf(SHARE_RULE_SIGNATURES.unlockNoticeRequired),
    "0x70740ee9",
  );
  assert.equal(
    selectorOf(SHARE_RULE_SIGNATURES.unlockAnnouncedAt),
    "0xc7eb62bc",
  );
  assert.equal(selectorOf(SHARE_RULE_SIGNATURES.transferExempt), "0xd0d0a2ae");
  assert.equal(UNLOCK_NOTICE, 30 * DAY);
});

test("the trading decisions are calls to the Shares, as cast encodes them", () => {
  const announce = announceTradingDecision({ sharesToken: SHARES });
  assert.equal(announce.to, SHARES);
  assert.equal(announce.data, "0x7fcf3a66");
  assert.equal(announce.lane, "unrestricted");
  assert.match(announce.title, /Announce that trading opens/);
  assert.ok(announce.lines.some((l) => l.includes("30 days")));
  // cast calldata "setTransfersLocked(bool)" false / true
  assert.equal(
    openTradingDecision({ sharesToken: SHARES }).data,
    `0x0eda3c55${"0".repeat(64)}`,
  );
  assert.equal(
    lockTradingDecision({ sharesToken: SHARES }).data,
    `0x0eda3c55${"0".repeat(63)}1`,
  );
  assert.equal(
    cancelTradingDecision({ sharesToken: SHARES }).data,
    "0xcc9b97f9",
  );
  assert.throws(() => announceTradingDecision({ sharesToken: "nope" }));
});

test("a trading decision is described as one only when it is aimed at the project's own Shares", () => {
  const ctx = { dao: DAO, projectToken: SHARES };
  for (const [draft, words] of [
    [
      announceTradingDecision({ sharesToken: SHARES }),
      "Announce that trading opens",
    ],
    [
      cancelTradingDecision({ sharesToken: SHARES }),
      "Withdraw the announcement",
    ],
    [openTradingDecision({ sharesToken: SHARES }), "Open trading"],
    [lockTradingDecision({ sharesToken: SHARES }), "Lock trading again"],
  ]) {
    const described = describeDecision(draft, ctx);
    assert.equal(described.kind, "trading");
    assert.match(described.title, new RegExp(words));
  }
  // The DAO's own two-bool setter, opening both: the same decision, said the same way.
  const viaDao = describeDecision(
    { to: DAO, data: `0x80fe038f${"0".repeat(64)}${"0".repeat(64)}` },
    ctx,
  );
  assert.equal(viaDao.kind, "trading");
  assert.match(viaDao.title, /Open trading/);
  // Aimed anywhere else, it is not described as trading.
  const elsewhere = describeDecision(
    { to: "0x00000000000000000000000000000000000000ee", data: "0x7fcf3a66" },
    ctx,
  );
  assert.equal(elsewhere.kind, "unknown");
});

const rules = (over = {}) => ({
  awardsOnly: true,
  issuanceCapBps: 1000,
  yearStart: 0,
  yearBase: 0n,
  issuedThisYear: 0n,
  transfersLocked: true,
  unlockNoticeRequired: true,
  unlockAnnouncedAt: 0,
  transferExempt: SHARES,
  ...over,
});

test("trading moves from locked, to announced, to ready 30 days later, to open", () => {
  const now = 1_000 * DAY;
  assert.deepEqual(tradingState(rules(), now), {
    phase: "locked",
    opensAt: null,
  });
  assert.deepEqual(tradingState(rules({ unlockAnnouncedAt: now - DAY }), now), {
    phase: "announced",
    opensAt: now - DAY + 30 * DAY,
  });
  assert.equal(
    tradingState(rules({ unlockAnnouncedAt: now - 30 * DAY }), now).phase,
    "ready",
  );
  assert.equal(
    tradingState(rules({ transfersLocked: false }), now).phase,
    "open",
  );
  // A lock without the notice (a DAO made before D77) can be lifted by a vote at once.
  assert.equal(
    tradingState(rules({ unlockNoticeRequired: false }), now).phase,
    "ready",
  );
  assert.equal(tradingState(null, now).phase, "unknown");
});

test("the year's allowance of new Shares, from what the Shares say", () => {
  const now = 1_000 * DAY;
  // No year yet: the next award starts one, measured against the Shares that count on exit now.
  assert.deepEqual(issuanceAllowance(rules(), now, 650n * WAD), {
    kind: "capped",
    left: 65n * WAD,
    of: 65n * WAD,
    resetsAt: null,
  });
  // Inside a year: what is left of that year's allowance, and when it resets.
  assert.deepEqual(
    issuanceAllowance(
      rules({
        yearStart: now - 10 * DAY,
        yearBase: 650n * WAD,
        issuedThisYear: 40n * WAD,
      }),
      now,
      900n * WAD,
    ),
    {
      kind: "capped",
      left: 25n * WAD,
      of: 65n * WAD,
      resetsAt: now - 10 * DAY + 365 * DAY,
    },
  );
  // A year that has passed starts again on the current base.
  assert.equal(
    issuanceAllowance(
      rules({ yearStart: now - 366 * DAY, yearBase: 1n, issuedThisYear: 1n }),
      now,
      900n * WAD,
    ).left,
    90n * WAD,
  );
  // Awards only, with no yearly limit (contributor projects); no rule at all (a DAO made before D76); unreadable.
  assert.deepEqual(
    issuanceAllowance(rules({ issuanceCapBps: NO_CAP }), now, 1n),
    {
      kind: "awards-only",
    },
  );
  assert.deepEqual(issuanceAllowance(rules({ awardsOnly: false }), now, 1n), {
    kind: "none",
  });
  assert.equal(issuanceAllowance(null, now, 1n), null);
  // Never below zero, whatever was issued.
  assert.equal(
    issuanceAllowance(
      rules({ yearStart: now - DAY, yearBase: 100n, issuedThisYear: 50n }),
      now,
      100n,
    ).left,
    0n,
  );
});
