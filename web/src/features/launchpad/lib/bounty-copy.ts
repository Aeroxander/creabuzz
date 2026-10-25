/**
 * What a bounty on a work area says about itself, in plain words (N1). One sentence per stage, so the page and its
 * tests agree on what each stage means; the amounts, dates and names come formatted from the caller.
 */

import type { BountyRecord, BountyStage } from "./work-bounty.ts";

export interface BountyWords {
  money: (units: bigint) => string;
  date: (seconds: number) => string;
  who: (address: string) => string;
}

/** The wait after approval, in whole days ("7-day"), as the budget's own challenge window. */
export function waitDays(window: number): string {
  const days = Math.max(1, Math.round(window / 86_400));
  return `${days}-day`;
}

export function bountyStatusLine(
  stage: BountyStage,
  bounty: BountyRecord,
  words: BountyWords,
): string {
  switch (stage.kind) {
    case "paid":
      return `Paid ${words.money(bounty.total)} to ${words.who(stage.contributor)}.`;
    case "refunds":
      return "No work was approved in time. Everyone can take their money back.";
    case "payable":
      return `${words.who(stage.contributor)}'s work was approved and the wait is over. Anyone can pay it now.`;
    case "in-window":
      return `${words.who(stage.contributor)}'s work was approved. It can be paid from ${words.date(stage.payableAt)}, unless the DAO stops it before then.`;
    case "open":
      return `Takes money until ${words.date(bounty.deadline)}. It pays whoever's work for this area the reviewers approve by then, after the ${waitDays(bounty.window)} wait.`;
    case "waiting":
      return `No work was approved by ${words.date(bounty.deadline)}. Everyone can take their money back from ${words.date(stage.refundsFrom)}.`;
  }
}

/**
 * The deadline a new bounty gets from a date someone picked (`YYYY-MM-DD`, the end of that day where they are), never
 * past the work area's own expiry. Null when the date is not one, or not after `now`.
 */
export function deadlineFromDate(
  value: string,
  now: number,
  expiresAt: number,
): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const end = new Date(`${value}T23:59:00`);
  if (Number.isNaN(end.getTime())) return null;
  const seconds = Math.min(Math.floor(end.getTime() / 1000), expiresAt);
  return seconds > now ? seconds : null;
}

/** The date a new bounty's form starts on: thirty days ahead, or the work area's expiry if that is sooner. */
export function defaultDeadlineDate(now: number, expiresAt: number): string {
  const seconds = Math.min(now + 30 * 86_400, expiresAt);
  const d = new Date(seconds * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
