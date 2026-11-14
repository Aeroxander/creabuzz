/**
 * What a person holds in the backing pools of the projects they follow or help (and the newest listed ones): their units,
 * what selling them now would pay, the part of their money held for the project, the milestone they may still leave at
 * and the date, and round tokens waiting to become units. Pure: `backing-positions.test.mjs` drives it.
 *
 * No price is a headline here: a position is the person's own, in the words of the Backing block, and the projects they
 * are asked to look at come from what is waiting on them, not from what moved.
 */

import {
  canLeaveNow,
  type PoolView,
  type QuoteFacts,
} from "@creaton/core/launchpad/backing.ts";

import type { Need } from "./project-state.ts";

/** A window "about to end": the next step shows from this long before it closes. */
export const LEAVE_SOON_SECONDS = 3 * 86_400;

export interface Position {
  units: bigint;
  /** What selling all of them now pays. */
  sellValue: bigint;
  /** The part of what the person paid that is held for the project. */
  held: bigint;
  /** Round tokens that can be exchanged for units now. */
  claimTokens: bigint;
  /** When the person may still leave at the open milestone, or null when they may not. */
  leaveBy: number | null;
  quote: QuoteFacts;
  /** The pool's state in a word: still the same five. */
  phase: PoolView["phase"];
}

/** The person's position in a pool, or null when they hold nothing in it. */
export function positionOf(view: PoolView, now: number): Position | null {
  const s = view.snapshot;
  const claimTokens = s.round.state === "live" ? s.round.holderClaimTokens : 0n;
  if (s.holderUnits === 0n && s.holderEscrow === 0n && claimTokens === 0n)
    return null;
  return {
    units: s.holderUnits,
    sellValue: s.holderSellValue,
    held: s.holderEscrow,
    claimTokens,
    leaveBy: canLeaveNow(s, now) ? s.milestone.windowEndsAt : null,
    quote: view.quote,
    phase: view.phase,
  };
}

/** What a position asks of its holder: a window about to end, or round tokens to exchange. */
export function positionNeeds(
  coordinate: string,
  position: Position,
  now: number,
): Need[] {
  const needs: Need[] = [];
  if (position.leaveBy !== null && position.leaveBy - now <= LEAVE_SOON_SECONDS)
    needs.push({ kind: "leave-by", coordinate, leaveBy: position.leaveBy });
  if (position.claimTokens > 0n)
    needs.push({ kind: "round-claim", coordinate });
  return needs;
}
