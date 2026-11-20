/**
 * How a task's pay goes out (plan section 5.1): the allowance box, only the box, a plan with notice, or not at all. The
 * door rule is the design's: the allowance is the small, any-day door; what is larger than it can hold is planned, so
 * holders get notice and can take their money out first. Pure; the screen reads the box and its cap from the chain when
 * its sheet opens and passes them here.
 */
import { noticeWords } from "./duration";
import type { ChainTasks, NoticeFor } from "./types";
import { dollarsPhrase } from "./words";

/**
 * The way a task is paid (5.1): from the allowance box, only from it, as a plan with notice, or not at all (too big).
 *
 * @public The type of what `doorFor` returns, for the screens that hold one. Drop this tag when a screen imports it.
 */
export type Door = {
  door: "box" | "box-only" | "plan" | "too-big";
  /** The one sentence shown beside the press, always. */
  sentence: string;
  /** True when the proposed door is the box and a plan would also fit: "Plan it instead, so holders get notice first." */
  planAlso: boolean;
};

/**
 * The share of the pot a plan asks for, in ten-thousandths: `ceil(maxDollars x 11,000 / pot)` in whole numbers (a tenth
 * more than the pay's own share of the pot, so a small fall in the pot does not short-change the worker), at least 1.
 * Null when it passes `maxShareBps` (the pay is more than about 4.5% of the project's money), when there is no money in
 * the pot, or when the pay is nothing (a plan of nothing is refused by the contract).
 */
export function shareFor(
  maxDollars: bigint,
  pot: bigint,
  maxShareBps: number,
): number | null {
  if (maxDollars <= 0n || pot <= 0n) return null;
  const bps = (maxDollars * 11_000n + pot - 1n) / pot;
  const share = bps < 1n ? 1n : bps;
  return share > BigInt(maxShareBps) ? null : Number(share);
}

const same = (a: string | null, b: string) =>
  a !== null && a.toLowerCase() === b.toLowerCase();

/**
 * The door for paying a task (5.1): `usd` the pay in dollars, `box` what the allowance box holds now, `boxCap` the most it
 * can hold, `pot` the project's money, `payee` the wallet the worker named, `runner` who runs the project, `limits` the
 * record's limits and `notice` what a plan of this size gets (null when it could not be read: the sentence then says
 * "notice" and no length). A payee who runs the project can only be paid from the box (C32): the contract refuses to plan
 * or take a task for them.
 */
export function doorFor(input: {
  usd: number;
  box: bigint;
  boxCap: bigint;
  pot: bigint;
  payee: string | null;
  runner: { address: string; signers: string[] | null };
  limits: ChainTasks["limits"];
  notice: NoticeFor | null;
}): Door {
  const { box, boxCap, pot, payee, runner, limits, notice } = input;
  const pay = BigInt(Math.round(input.usd * 1_000_000));
  const fits = shareFor(pay, pot, limits.maxShareBps) !== null;
  const time = notice ? `${noticeWords(notice.noticeSecs)} notice` : "notice";
  const cap = dollarsPhrase(boxCap);
  const holds = dollarsPhrase(box);
  const runs =
    payee !== null &&
    (same(payee, runner.address) ||
      (runner.signers ?? []).some((s) => same(payee, s)));
  if (runs)
    return {
      door: "box-only",
      sentence:
        "A task paid to someone who runs the project cannot be planned. It can be paid from the allowance.",
      planAlso: false,
    };
  if (boxCap === 0n) {
    return fits
      ? {
          door: "plan",
          sentence: `The allowance is not paying into the box, so this is planned: holders get ${time} before any money moves, and anyone can take their money out first.`,
          planAlso: false,
        }
      : {
          door: "too-big",
          sentence:
            "This is more of the project's money than one task may ask for. Plan it in smaller parts.",
          planAlso: false,
        };
  }
  if (pay <= box && box > 0n)
    return {
      door: "box",
      sentence: `The allowance box holds ${holds} now, enough to pay this on any day, with no notice.`,
      planAlso: fits,
    };
  if (pay <= boxCap)
    return {
      door: "box",
      sentence: `The allowance box holds ${holds} now and fills up to ${cap}. The team can pay this from the box once it holds ${dollarsPhrase(pay)}, or plan it so holders get ${time} first.`,
      planAlso: fits,
    };
  return fits
    ? {
        door: "plan",
        sentence: `This is more than the allowance box can hold (${cap}), so it is planned: holders get ${time} before any money moves, and anyone can take their money out first.`,
        planAlso: false,
      }
    : {
        door: "too-big",
        sentence:
          "This is more of the project's money than one task may ask for. Plan it in smaller parts, or pay part of it from the allowance.",
        planAlso: false,
      };
}
