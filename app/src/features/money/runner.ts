/**
 * Who sends what for a project, from its numbers: the runner's own account sends to the Treasury; one of a Pair's two
 * signers checks in through the Pair (alone) and proposes every other runner call through it (the other signer confirms).
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
type RunnerRole =
  /** This account is the runner: it sends to the Treasury itself. */
  | { kind: "alone" }
  /** This account is one of the Pair's two signers. */
  | { kind: "signer"; pair: string }
  | { kind: "none" };

export function runnerRole(
  numbers: ProjectNumbers,
  me: string | null,
): RunnerRole {
  if (numbers.windDown) return { kind: "none" };
  if (isRunner(numbers, me)) return { kind: "alone" };
  if (numbers.runner.isPair && signsForRunner(numbers, me))
    return { kind: "signer", pair: numbers.runner.address };
  return { kind: "none" };
}

/**
 * The check-in call for this account, or null when it may not check in (not the runner, not a signer, or wound down).
 * `recordHash` is the hash of the weekly record signed first (its event id): the check-in carries it, so the chain
 * points at exactly what was said.
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
 * A runner-only call (draw, set the rate, the door, grant Team Shares, ...) as this account must send it: straight to the
 * Treasury when it is the runner (`through: "alone"`), as a proposal through the Pair when it is one of the two signers
 * (`through: "pair"`: the other signer confirms the same call), or null when it may not ask at all.
 */
export function asRunner(
  numbers: ProjectNumbers,
  me: string | null,
  inner: PotCall,
): { call: PotCall; through: "alone" | "pair" } | null {
  const role = runnerRole(numbers, me);
  if (role.kind === "alone") return { call: inner, through: "alone" };
  if (role.kind === "signer")
    return {
      call: pairProposeCall(role.pair, inner.to, inner.data),
      through: "pair",
    };
  return null;
}

/**
 * A Council seat's version of a runner-only call: a proposal to the other seats, which runs when enough of them agree
 * (COUNCIL-PLAN.md 6.4). Null for anyone who does not hold a seat of a Council runner, so nothing is offered that the
 * contract would refuse. A Council is the runner itself, so a seat is never the runner and never signs alone.
 */
export function asSeat(
  numbers: ProjectNumbers,
  me: string | null,
  inner: PotCall,
): { call: PotCall; through: "council" } | null {
  if (numbers.windDown) return null;
  const council = numbers.council;
  if (numbers.runner.kind !== "council" || !council || !me) return null;
  const who = me.toLowerCase();
  if (!council.seats.some((seat) => seat.account === who)) return null;
  return {
    call: councilProposeCall(council.contract, inner.to, inner.data),
    through: "council",
  };
}
