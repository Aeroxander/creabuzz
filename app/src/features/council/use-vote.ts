/**
 * The vote as a screen reads it: the parsed record's `vote` block (`numbers-step9.ts`), the phase at the moment the
 * screen shows it, the times the card names, whether the person may vote or stand, and the inputs of the two alerts
 * (COUNCIL-PLAN.md 6.2, 6.7). Pure where it can be: `phaseAt` and `alertsOf` are functions of the record, so a test
 * walks them without React; the hook only adds the record and the clock.
 *
 * **What the record cannot say: whose Shares were parked before a ballot opened.** It carries only totals, never a voter.
 * The chain's own `weightOf(account)` answers it exactly (`@creaton/core/pot/pot-reads.ts`); a screen that has not read
 * that may pass the person's parked Shares as a hint, and the hint can be wrong: Shares parked *after* the ballot opened
 * do not count. So `canVote` is `true`/`false` only from the chain's weight, and `null` when the app cannot know.
 */
import { useMemo } from "react";
import { freshnessOf, type ProjectNumbers } from "../money/numbers";
import type {
  VoteNumbers,
  VoteOpenNumbers,
  VotePhase,
} from "../money/numbers-types";
import { withStepKeys } from "../money/numbers-step9";

/** Where the ballot stands at `now`: the record's times, and its result once the vote has ended. */
export function phaseAt(vote: VoteNumbers, now: number): VotePhase | null {
  const open = vote.open;
  if (!open) return null;
  if (open.carriedOutAt !== null) return "carried-out";
  if (now < open.standEnd) return "standing";
  if (now < open.voteEnd) return "voting";
  const won =
    open.result?.outcome === "moved" || open.result?.outcome === "seated";
  // The tallies froze at `voteEnd`; the record may not have read the result yet (the next record will).
  if (open.result === null) return "counting";
  if (!won) return "ended";
  if (now < open.effectiveAt) return "waiting";
  // Due and being carried out. The lapse is a clock the rule does not carry to the app, so the record's own phase decides
  // between the two: it said "lapsed" once the result's time had run out.
  return vote.open?.phase === "lapsed" ? "lapsed" : "counting";
}

/** Whether the ballot is still asking for votes (the standing window or the vote itself). */
export function isLive(vote: VoteNumbers, now: number): boolean {
  const phase = phaseAt(vote, now);
  return phase === "standing" || phase === "voting";
}

/** The times the card and the sheets name, from the record and the rule. */
export interface VoteTimes {
  /** When the names are final and the vote starts. */
  voteStartsAt: number;
  /** When voting ends. */
  voteEndsAt: number;
  /** When a won result takes effect. */
  takesEffectAt: number;
  /** When two seats may next be opened (null when there is no Council). */
  seatsAt: number | null;
  /** When a replace vote may next open. */
  replaceFrom: number | null;
  /** The parked Shares that let a replace vote open now. */
  openFloor: bigint;
}

export function timesOf(vote: VoteNumbers): VoteTimes {
  const open = vote.open;
  return {
    voteStartsAt: open?.standEnd ?? 0,
    voteEndsAt: open?.voteEnd ?? 0,
    takesEffectAt: open?.effectiveAt ?? 0,
    seatsAt: vote.next.seatsAt,
    replaceFrom: vote.next.replaceFrom,
    openFloor: vote.next.openFloor,
  };
}

/**
 * Whether this person may vote or stand.
 * - `weight` is the chain's own answer (`weightOf`): true or false, exactly.
 * - `parked` is a hint (what the person has parked now): a positive hint says "probably", because Shares parked after the
 *   ballot opened do not count; a zero hint says no. The row is always a hint, never a promise.
 * - neither: null, "the app cannot know".
 */
export function canVote(input: {
  vote: VoteNumbers;
  now: number;
  weight?: bigint | null;
  parked?: bigint | null;
}): boolean | null {
  if (!isLive(input.vote, input.now)) return false;
  if (input.weight !== undefined && input.weight !== null)
    return input.weight > 0n;
  if (input.parked !== undefined && input.parked !== null)
    return input.parked > 0n;
  return null;
}

/** Whether this person may stand: the stand window, and a weight of at least the rule's thousandth (the chain decides). */
export function canStand(input: {
  vote: VoteNumbers;
  now: number;
  weight?: bigint | null;
  supply?: bigint | null;
}): boolean | null {
  if (input.vote.open === null) return false;
  if (input.now >= input.vote.open.standEnd) return false;
  if (input.weight === undefined || input.weight === null) return null;
  const supply = input.supply ?? input.vote.open.supply;
  // The needed weight is one `standDivisor`th of the Shares at the snapshot, rounded up: the contract's own test.
  const divisor = BigInt(input.vote.rule.standDivisor);
  const needs = (supply + divisor - 1n) / divisor;
  return input.weight >= needs;
}

/** What the two alerts of section 6.7 are made from: the record's open ballot and its result. */
export interface VoteAlertInputs {
  /** A ballot is open now: the `vote` alert, urgent until it ends. */
  open: { kind: VoteOpenNumbers["kind"]; endsAt: number } | null;
  /** A result that moves the runner or a seat: the `moved` alert, urgent until it takes effect. */
  moved: {
    outcome: "moved" | "seated";
    effectiveAt: number;
    id: number;
  } | null;
}

/**
 * The alerts' inputs from the record, with the same conditions as section 6.7: a vote alert while a ballot is live, and a
 * moved alert from `voteEnd` on (the result is derived from the frozen tallies, so it shows even if nobody recorded it),
 * until it takes effect.
 */
export function alertsOf(
  vote: VoteNumbers | null,
  now: number,
): VoteAlertInputs {
  const open = vote?.open ?? null;
  if (!vote || !open) return { open: null, moved: null };
  const phase = phaseAt(vote, now);
  const live = phase === "standing" || phase === "voting";
  const won =
    open.result?.outcome === "moved" || open.result?.outcome === "seated";
  return {
    open: live ? { kind: open.kind, endsAt: open.voteEnd } : null,
    moved:
      won && now < open.effectiveAt
        ? {
            outcome: open.result?.outcome as "moved" | "seated",
            effectiveAt: open.effectiveAt,
            id: open.id,
          }
        : null,
  };
}

/** Everything a vote screen reads, from one record. */
export interface VoteView {
  /** The record with its milestone 9 keys read (`withStepKeys`), so the pause keys are read too. */
  numbers: ProjectNumbers;
  vote: VoteNumbers | null;
  open: VoteOpenNumbers | null;
  /** Where it stands at `now`, from the record's times (null when no ballot is shown). */
  phase: VotePhase | null;
  times: VoteTimes | null;
  /** `true`/`false` from the chain's weight; null when the app cannot know (see the file's note). */
  canVote: boolean | null;
  canStand: boolean | null;
  alerts: VoteAlertInputs;
  /** Older than the server promises: the card says the stale sentence and no state line. */
  old: boolean;
}

/**
 * The vote of one record at `now`. `weight` is the chain's answer for this person (`weightOf`), `parked` only a hint; both
 * absent when the screen has not read the chain, and then `canVote` is null rather than a guess.
 */
export function useVote(input: {
  numbers: ProjectNumbers | null | undefined;
  now: number;
  weight?: bigint | null;
  parked?: bigint | null;
}): VoteView | null {
  const numbers = input.numbers;
  return useMemo(() => {
    if (!numbers || numbers.removed) return null;
    const withKeys = withStepKeys(numbers);
    const vote = withKeys.vote ?? null;
    return {
      numbers: withKeys,
      vote,
      open: vote?.open ?? null,
      phase: vote ? phaseAt(vote, input.now) : null,
      times: vote ? timesOf(vote) : null,
      canVote: vote
        ? canVote({
            vote,
            now: input.now,
            weight: input.weight,
            parked: input.parked,
          })
        : false,
      canStand: vote
        ? canStand({ vote, now: input.now, weight: input.weight })
        : false,
      alerts: alertsOf(vote, input.now),
      old: freshnessOf(withKeys, input.now).level !== "fresh",
    };
  }, [numbers, input.now, input.weight, input.parked]);
}
