/**
 * Who sends what for a project, from its numbers: the runner's own account sends to the Treasury; one of a Pair's two
 * signers checks in through the Pair (alone) and proposes every other runner call through it (the other signer confirms);
 * one of a Council's seats proposes every runner call through the Council (the needed seats agree, then it runs).
 * Pure: it reads the record's `runner` block, no chain read.
 */
import {
  checkInCall,
  councilProposeCall,
  type PotCall,
  pairCheckInCall,
  pairProposeCall,
} from "@creaton/core/pot/pot-calls.ts";
import type { MoneyCall } from "./calls";
import { isRunner, type ProjectNumbers, signsForRunner } from "./numbers";

/** How this account takes part in running the project. */
export type RunnerRole =
  /** This account is the runner: it sends to the Treasury itself. */
  | { kind: "alone" }
  /** This account is one of the Pair's two signers. */
  | { kind: "signer"; pair: string }
  /** This account holds a seat of the Council that is the runner: it proposes, and never signs alone. */
  | { kind: "seat"; council: string }
  | { kind: "none" };

export function runnerRole(
  numbers: ProjectNumbers,
  me: string | null,
): RunnerRole {
  if (numbers.windDown) return { kind: "none" };
  if (isRunner(numbers, me)) return { kind: "alone" };
  if (numbers.runner.isPair && signsForRunner(numbers, me))
    return { kind: "signer", pair: numbers.runner.address };
  const council = numbers.council;
  if (numbers.runner.kind === "council" && council && me) {
    const who = me.toLowerCase();
    if (council.seats.some((seat) => seat.account === who))
      return { kind: "seat", council: council.contract };
  }
  return { kind: "none" };
}

/**
 * The check-in call for this account, or null when it may not check in (not the runner, not a signer, not a seat, or
 * wound down). `recordHash` is the hash of the weekly record signed first (its event id): the check-in carries it, so
 * the chain points at exactly what was said. A Council seat proposes it like any other runner call.
 */
export function checkInFor(
  numbers: ProjectNumbers,
  me: string | null,
  recordHash: string,
): MoneyCall | null {
  const role = runnerRole(numbers, me);
  if (role.kind === "alone")
    return checkInCall(numbers.contracts.treasury, recordHash);
  if (role.kind === "signer") return pairCheckInCall(role.pair, recordHash);
  if (role.kind === "seat")
    return councilProposeCall(
      role.council,
      numbers.contracts.treasury,
      checkInCall(numbers.contracts.treasury, recordHash).data,
    );
  return null;
}

/** Whether this account may check in at all (to offer the press before there is a hash to send). */
export function mayCheckIn(
  numbers: ProjectNumbers,
  me: string | null,
): boolean {
  return runnerRole(numbers, me).kind !== "none";
}

/**
 * What a check-in carries when there is no week's words to point at: 32 zero bytes. The chain takes any hash and this
 * one says plainly that nothing was said; a press that has a weekly update points at its id instead.
 */
export const CHECK_IN_NO_RECORD = `0x${"0".repeat(64)}`;

/**
 * How this account's check-in goes out. A check-in is not like the other runner presses: either signer of a Pair may
 * check in alone, so only a Council's seat asks the other seats first. Null when the account does not run the project.
 */
export function checkInRoute(
  numbers: ProjectNumbers,
  me: string | null,
): "now" | "ask" | null {
  const role = runnerRole(numbers, me);
  if (role.kind === "none") return null;
  return role.kind === "seat" ? "ask" : "now";
}

/**
 * A runner-only call (draw, set the rate, the door, grant Team Shares, ...) as this account must send it: straight to the
 * Treasury when it is the runner (`through: "alone"`), as a proposal through the Pair when it is one of the two
 * signers (`through: "pair"`: the other signer confirms the same call), as a proposal through the Council when it holds
 * one of its seats (`through: "council"`: the needed seats agree, then it runs), or null when it may not ask at all.
 */
export function asRunner(
  numbers: ProjectNumbers,
  me: string | null,
  inner: PotCall,
): { call: PotCall; through: "alone" | "pair" | "council" } | null {
  const role = runnerRole(numbers, me);
  if (role.kind === "alone") return { call: inner, through: "alone" };
  if (role.kind === "signer")
    return {
      call: pairProposeCall(role.pair, inner.to, inner.data),
      through: "pair",
    };
  return asSeat(numbers, me, inner);
}

/**
 * A Council seat's version of a runner-only call: a proposal to the other seats, which runs when enough of them agree
 * (COUNCIL-PLAN.md 6.4). Null for anyone who does not hold a seat of a Council runner, so nothing is offered that the
 * contract would refuse. A Council is the runner itself, so a seat is never the runner and never signs alone. The call
 * must be one the Council's own list accepts (`Council.listed`): what the app offers is held to that list by tests.
 */
export function asSeat(
  numbers: ProjectNumbers,
  me: string | null,
  inner: PotCall,
): { call: PotCall; through: "council" } | null {
  const role = runnerRole(numbers, me);
  if (role.kind !== "seat") return null;
  return {
    call: councilProposeCall(role.council, inner.to, inner.data),
    through: "council",
  };
}
