/**
 * The one next action on a project's front page.
 *
 * The "Needs you" list already ranks what is waiting, most urgent first
 * (`dao-overview.ts` `attentionItems`, `challenge-attention.ts`). This module
 * answers the question that list answers and one more: of those, which single
 * thing comes first, whose turn it is on it, and the moment its window closes.
 * It adds no reads and no records: everything comes off the items the page
 * already computed.
 *
 * Pure and alias-free: `next-action.test.mjs` drives it under `node --test`.
 */

import type { AttentionItem } from "./dao-overview.ts";

/** The one next action to show, or null when nothing needs this person. */
export interface NextAction {
  /** What it is, in one sentence (the item's own text). */
  text: string;
  /** What kind of thing it is, so a page can name its window accurately. */
  kind: AttentionItem["kind"];
  /** Who has this turn: "contributor", "reviewer", "manager", "holders"… */
  role: string;
  /** The one verb label for the affordance. */
  action: string;
  /**
   * Unix seconds when the window this sits in closes (a review deadline, a
   * vote ending), when there is one. A clock closes the window; it never
   * does the work that follows.
   */
  due: number | undefined;
  /** Why it is shown to this person, in a few words (the item's own reason). */
  why?: string;
  /** What happens if nobody acts, in one sentence (the item's own warning). */
  ifIgnored?: string;
  /** Where the answer lives — the tab the item already points at. */
  tab: AttentionItem["tab"];
  claim?: AttentionItem["claim"];
}

/**
 * What the one date on an item marks, in words a page can show as it is: the
 * window that closes, named per kind. Never "it changes by itself" — a clock
 * closes a window; it does not run contracts, post a payout or unlock
 * Shares, so the words never claim it does.
 */
export function duePhrase(
  item: Pick<AttentionItem, "kind" | "due">,
  format: (seconds: number) => string,
): string | null {
  if (item.due === undefined) return null;
  const at = format(item.due);
  switch (item.kind) {
    case "vote":
      return `The vote ends ${at}.`;
    case "review":
      return `The review window ends ${at}.`;
    // A piece of the reader's own work that is waiting on someone: before
    // that moment nothing can be done about it, after it some action opens.
    case "waiting":
      return `You can act on it after ${at}.`;
    default:
      return `The window ends ${at}.`;
  }
}

/**
 * This person's part in the item, in the words the project uses
 * (contributor / reviewer / manager / holders). Every one of these items is
 * addressed to the person reading the page, so the role is theirs.
 */
export function nextActionRole(item: AttentionItem): string {
  const why = item.why ?? "";
  if (why.startsWith("You hold Shares")) return "holder (you)";
  if (why.startsWith("You are a reviewer")) return "reviewer (you)";
  if (why.startsWith("You manage")) return "manager (you)";
  if (
    why.startsWith("It is your") ||
    why.startsWith("You filed it") ||
    why.startsWith("It is your submission")
  ) {
    return "contributor (you)";
  }
  if (why.startsWith("You founded")) return "founder (you)";
  if (why.startsWith("You are on the team")) return "team member (you)";
  if (why.startsWith("Anyone can")) return "anyone";
  // A read that could not say why still names the turn: the kinds say it.
  if (item.kind === "vote" || item.kind === "move" || item.kind === "award") {
    return "holder (you)";
  }
  if (item.kind === "bond" || item.kind === "review") return "reviewer (you)";
  if (item.kind === "payout") return "contributor (you)";
  return "you";
}

/**
 * The front-most thing this person can act on, or null. Deliberately the top
 * of the ranked list — "one next action", not a digest: the rest of the queue
 * stays right below it.
 */
export function nextActionOf(
  items: readonly AttentionItem[],
  now: number,
): NextAction | null {
  // Something with a window that closes outranks the rest in `rankAttention`
  // already; take the newest ranked answer.
  const item = items.find((i) => i.actor !== "others") ?? null;
  if (!item) return null;
  return {
    text: item.text,
    kind: item.kind,
    role: nextActionRole(item),
    action: item.action,
    due: item.due !== undefined && item.due > now ? item.due : undefined,
    why: item.why,
    ifIgnored: item.ifIgnored,
    tab: item.tab,
    claim: item.claim,
  };
}
