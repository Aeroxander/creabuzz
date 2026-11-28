/**
 * What the Take out sheet reads from the chain at the moment it opens: what the account holds, what taking out would give
 * now (the chain's own quote), what stays behind, and the call made from that quote with its guard. The sheet shows these
 * numbers and sends this call.
 */
import type { PotCall } from "@creaton/core/pot/pot-calls.ts";
import { planTakeOut, planTeamTakeOut } from "@creaton/core/pot/pot-plans.ts";
import { balanceOf, type ReadCall } from "@creaton/core/pot/pot-reads.ts";
import type { MoneyTarget } from "./target";

export type TakeOutRead =
  | { ok: false; why: "none" | "nothing" }
  | {
      ok: true;
      kind: "backer" | "team";
      /** What the account holds now, all of which this press takes out. */
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
  account: string,
): Promise<TakeOutRead> {
  const held = await balanceOf(
    read,
    kind === "team" ? target.team : target.shares,
    account,
  );
  if (held === 0n) return { ok: false, why: "none" };
  // One press takes all of it.
  const shares = held;
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
    shares,
    cash: plan.quote.cashNow,
    minCash: plan.minCash,
    arrivingLeftBehind: plan.quote.arrivingLeftBehind,
    note: plan.quote.note,
    call: plan.call,
    readAt,
  };
}
