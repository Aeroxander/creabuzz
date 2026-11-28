/**
 * What the Take out sheet reads from the chain at the moment it opens: what the account holds, what taking out would give
 * now (the chain's own quote), what stays behind, and the call made from that quote with its guard. The sheet shows these
 * numbers and sends this call.
 */
import type { PotCall } from "@creaton/core/pot/pot-calls.ts";
import { planTakeOut, planTeamTakeOut } from "@creaton/core/pot/pot-plans.ts";
import { balanceOf, type ReadCall } from "@creaton/core/pot/pot-reads.ts";
import type { MoneyTarget } from "./target";

/** How much of what is held to take out. */
export type Portion = "all" | "half" | "quarter";

export const PORTION_WORDS: Record<Portion, string> = {
  all: "All of it",
  half: "Half",
  quarter: "A quarter",
};

const portionOf = (held: bigint, portion: Portion): bigint =>
  portion === "all" ? held : portion === "half" ? held / 2n : held / 4n;

export type TakeOutRead =
  | { ok: false; why: "none" | "tiny" | "nothing" }
  | {
      ok: true;
      kind: "backer" | "team";
      /** What the account holds now, and how many of it this press takes out. */
      held: bigint;
      shares: bigint;
      /** Cash now: exact for Shares, an estimate for Team Shares. */
      cash: bigint;
      minCash: bigint;
      /** Outside money still arriving, which this take-out leaves for those who stay. */
      arrivingLeftBehind: bigint;
      /** Money owed to this account later for a task's money set aside (none until tasks have a wait). */
      note: bigint;
      /** The take-out itself (`leave` or `leaveTeam`). */
      call: PotCall;
      readAt: number;
    };

export async function readTakeOut(
  read: ReadCall,
  target: MoneyTarget,
  kind: "backer" | "team",
  portion: Portion,
  account: string,
): Promise<TakeOutRead> {
  const held = await balanceOf(
    read,
    kind === "team" ? target.team : target.shares,
    account,
  );
  const shares = portionOf(held, portion);
  if (held === 0n) return { ok: false, why: "none" };
  // Something is held but this portion of it rounds to no Shares: the person can still choose a bigger portion.
  if (shares === 0n) return { ok: false, why: "tiny" };
  const readAt = Math.floor(Date.now() / 1000);
  if (kind === "team") {
    const plan = await planTeamTakeOut(read, {
      treasury: target.treasury,
      shares,
      to: account,
    });
    if (!plan) return { ok: false, why: "nothing" };
    return {
      ok: true,
      kind,
      held,
      shares,
      cash: plan.estimate,
      minCash: plan.minCash,
      arrivingLeftBehind: 0n,
      note: 0n,
      call: plan.call,
      readAt,
    };
  }
  const plan = await planTakeOut(read, {
    treasury: target.treasury,
    holder: account,
    shares,
    to: account,
  });
  if (!plan) return { ok: false, why: "nothing" };
  return {
    ok: true,
    kind,
    held,
    shares,
    cash: plan.quote.cashNow,
    minCash: plan.minCash,
    arrivingLeftBehind: plan.quote.arrivingLeftBehind,
    note: plan.quote.note,
    call: plan.call,
    readAt,
  };
}
