/**
 * Read what a DAO's Shares say about new Shares and trading (D76, D77), and how many Shares count when someone leaves
 * (the base a new year's allowance of new Shares is measured against).
 *
 * Shares made before those rules refuse the first read: that is said (`predates`), not shown as an error, because it is
 * an answer, and nothing measured against the rules is worked out for them (their lock may predate `totalLocked()` too).
 * A network that does not answer is an error, never a DAO without rules.
 *
 * Pure apart from the injected `call`: `share-rules.test.mjs` drives it with a fake chain.
 */

import { formatUnits } from "@creaton/core/launchpad/daoActions.ts";
import {
  type issuanceAllowance,
  SHARE_RULE_SIGNATURES,
  type ShareRules,
} from "@creaton/core/launchpad/tradingActions.ts";
import { selectorOf } from "@creaton/core/launchpad/evmAbi.ts";

const TOTAL_SUPPLY = "0x18160ddd";
const BALANCE_OF = "0x70a08231";
const LOCK_GUARD = "0x36bc529d";
const TOTAL_LOCKED = "0x56891412";

/** One `eth_call`: the raw return data, or a thrown error. */
export type Call = (to: string, data: string) => Promise<string>;

export type ShareRulesRead =
  | {
      rules: ShareRules;
      predates: false;
      /** Shares outside the DAO, less what a lock still holds back: a new year's allowance is measured against it. */
      exitBase: bigint;
    }
  | {
      /** These Shares were made before the rules: they refused the first read. */
      rules: null;
      predates: true;
      exitBase: null;
    };

const isRefusal = (error: unknown) =>
  error instanceof Error && /revert/i.test(error.message);

function u256(hex: string): bigint {
  const body = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (body.length !== 64 || !/^[0-9a-fA-F]+$/.test(body)) {
    throw new Error("expected a 32-byte answer");
  }
  return BigInt(`0x${body}`);
}

const addressOf = (hex: string) =>
  `0x${u256(hex).toString(16).padStart(40, "0")}`;

export async function readShareRules(
  call: Call,
  shares: string,
  dao: string,
): Promise<ShareRulesRead> {
  const read = (signature: string) => call(shares, selectorOf(signature));
  let awardsOnly: bigint;
  try {
    awardsOnly = u256(await read(SHARE_RULE_SIGNATURES.awardsOnly));
  } catch (error) {
    if (!isRefusal(error)) throw error;
    return { rules: null, predates: true, exitBase: null };
  }
  const [cap, yearStart, yearBase, issued, locked, notice, announced, exempt] =
    await Promise.all([
      read(SHARE_RULE_SIGNATURES.issuanceCapBps),
      read(SHARE_RULE_SIGNATURES.yearStart),
      read(SHARE_RULE_SIGNATURES.yearBase),
      read(SHARE_RULE_SIGNATURES.issuedThisYear),
      read(SHARE_RULE_SIGNATURES.transfersLocked),
      read(SHARE_RULE_SIGNATURES.unlockNoticeRequired),
      read(SHARE_RULE_SIGNATURES.unlockAnnouncedAt),
      read(SHARE_RULE_SIGNATURES.transferExempt),
    ]);
  return {
    rules: {
      awardsOnly: awardsOnly !== 0n,
      issuanceCapBps: Number(u256(cap)),
      yearStart: Number(u256(yearStart)),
      yearBase: u256(yearBase),
      issuedThisYear: u256(issued),
      transfersLocked: u256(locked) !== 0n,
      unlockNoticeRequired: u256(notice) !== 0n,
      unlockAnnouncedAt: Number(u256(announced)),
      transferExempt: addressOf(exempt),
    },
    predates: false,
    exitBase: await exitBase(call, shares, dao),
  };
}

/** What counts when someone leaves: every Share outside the DAO, less what the lock still holds back (D72). */
async function exitBase(
  call: Call,
  shares: string,
  dao: string,
): Promise<bigint> {
  const [supply, daoHeld, guardWord] = await Promise.all([
    call(shares, TOTAL_SUPPLY),
    call(
      shares,
      `${BALANCE_OF}${dao.slice(2).toLowerCase().padStart(64, "0")}`,
    ),
    call(shares, LOCK_GUARD),
  ]);
  const outside = u256(supply) - u256(daoHeld);
  const guard = addressOf(guardWord);
  if (/^0x0{40}$/.test(guard)) return outside;
  const locked = u256(await call(guard, TOTAL_LOCKED));
  return locked >= outside ? 0n : outside - locked;
}

type Allowance = ReturnType<typeof issuanceAllowance>;

const whole = (wei: bigint) => formatUnits(wei, 18);

/** The year's allowance of new Shares in one sentence, or null when these Shares have no such rule. */
export function allowanceText(
  allowance: Allowance,
  date: (seconds: number) => string,
): string | null {
  if (!allowance || allowance.kind === "none") return null;
  const why = "New Shares are only ever given for accepted work";
  if (allowance.kind === "awards-only") return `${why}, with no yearly limit.`;
  if (allowance.resetsAt === null) {
    return `Up to ${whole(allowance.of)} new Shares can be awarded in the year that starts with the next award. ${why}.`;
  }
  return `${whole(allowance.left)} of this year's ${whole(allowance.of)} new Shares are left to award, until ${date(allowance.resetsAt)}. ${why}.`;
}
