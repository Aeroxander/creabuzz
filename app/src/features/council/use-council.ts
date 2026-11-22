/**
 * The Council as a screen reads it: the parsed record's `runner.kind`/`runner.seats` and `council` block
 * (`numbers-step9.ts`), the seats in order, the threshold, the next election, what waits for a seat holder's agreement,
 * and who may propose. Pure functions where they can be, so a test walks them without React.
 *
 * The waiting actions themselves are not in the record (it carries counts, never bytes): a seat holder's list is read from
 * the Council's own `Proposed` logs (`proposals.ts`). This module says what the record promises about them and how many the
 * record counted, which is what the screens cap their list at.
 */
import { useMemo } from "react";
import type { ProjectNumbers } from "../money/numbers";
import type {
  CouncilNumbers,
  CouncilSeatNumbers,
  CouncilWaitingNumbers,
  RunnerKind,
} from "../money/numbers-types";
import { withStepKeys } from "../money/numbers-step9";

/** Where the section stands: a Council, none, or one the record could not read while saying the runner is one. */
export type CouncilState =
  | { kind: "none" }
  | { kind: "unreadable" }
  | { kind: "council"; council: CouncilNumbers };

/** What the Team section does with the record: nothing, the unreadable line, or the section (COUNCIL-PLAN.md 6.4, 6.6). */
export function councilStateOf(numbers: ProjectNumbers): CouncilState {
  if (numbers.runner.kind !== "council") return { kind: "none" };
  if (!numbers.council) return { kind: "unreadable" };
  return { kind: "council", council: numbers.council };
}

/** The account's seat, if it holds one: its number and when it took it. */
export function seatOf(
  council: CouncilNumbers,
  address: string | null,
): { index: number; seat: CouncilSeatNumbers } | null {
  if (!address) return null;
  const who = address.toLowerCase();
  for (let index = 0; index < council.seats.length; index += 1) {
    const seat = council.seats[index] as CouncilSeatNumbers;
    if (seat.account === who) return { index, seat };
  }
  return null;
}

/** Whether an account holds a seat: what opens the waiting list and the proposals. */
export function isSeatHolder(
  council: CouncilNumbers | null,
  address: string | null,
): boolean {
  return council !== null && seatOf(council, address) !== null;
}

/** What the record counted about the waiting actions, or null when it could not count them (the section says nothing). */
export function waitingOf(
  council: CouncilNumbers | null,
): CouncilWaitingNumbers | null {
  return council?.waiting ?? null;
}

/** How many days until two seats come up, from the record's next election; null once it has passed (a vote may open). */
export function seatsDue(council: CouncilNumbers, now: number): boolean {
  return now >= council.nextElection;
}

/** The runner's kind as the record says it, reading `isPair` for a record signed before the key existed. */
export function runnerKindOf(numbers: ProjectNumbers): RunnerKind {
  return numbers.runner.kind ?? (numbers.runner.isPair ? "pair" : "single");
}

/** Everything a Council screen reads, from one record. */
export interface CouncilView {
  /** The record with its milestone 9 keys read (`withStepKeys`), so the pause keys are read too. */
  numbers: ProjectNumbers;
  state: CouncilState;
  council: CouncilNumbers | null;
  runnerKind: RunnerKind;
  /** The five seats in order (empty when there is no Council). */
  seats: readonly CouncilSeatNumbers[];
  needed: number | null;
  /** The account's own seat, when it holds one. */
  mySeat: { index: number; seat: CouncilSeatNumbers } | null;
  /** A seat holder: the person who sees the waiting list and whose presses become proposals. */
  isSeat: boolean;
  /** What the record counted about the waiting actions; null when it could not count them. */
  waiting: CouncilWaitingNumbers | null;
  /** Whether two seats are due to come up now (what lets anyone open a seat election). */
  electionDue: boolean;
}

/** The Council of one record, for `address` (the signed-in account, or null). Null only when there is no record. */
export function useCouncil(input: {
  numbers: ProjectNumbers | null | undefined;
  address: string | null;
  now: number;
}): CouncilView | null {
  const numbers = input.numbers;
  return useMemo(() => {
    if (!numbers || numbers.removed) return null;
    const withKeys = withStepKeys(numbers);
    const state = councilStateOf(withKeys);
    const council = state.kind === "council" ? state.council : null;
    return {
      numbers: withKeys,
      state,
      council,
      runnerKind: runnerKindOf(withKeys),
      seats: council?.seats ?? [],
      needed: council?.needed ?? null,
      mySeat: council ? seatOf(council, input.address) : null,
      isSeat: isSeatHolder(council, input.address),
      waiting: waitingOf(council),
      electionDue: council ? seatsDue(council, input.now) : false,
    };
  }, [numbers, input.address, input.now]);
}
