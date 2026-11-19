/**
 * What the Back sheet reads from the chain at the moment it opens, all at once: the quote and the calls made from it, the
 * fee, the door, the daily rate, what the account holds. The numbers the sheet shows and the calls it sends are the same
 * object, so what a person reads is what is put into the call.
 */
import { type BackPlan, planBack } from "@creaton/core/pot/pot-plans.ts";
import {
  balanceOf,
  doorOpenNow,
  dollarHasPayAndCall,
  feeFor,
  type ReadCall,
} from "@creaton/core/pot/pot-reads.ts";
import { ratePpmNow } from "@creaton/core/pot/pot-state.ts";
import type { ProjectNumbers } from "../money/numbers";

export type BackRead =
  | { ok: false; why: "door-shut" | "no-shares" }
  | {
      ok: true;
      plan: BackPlan;
      /** The platform's part of the amount. */
      fee: bigint;
      /** The daily rate now, in parts per million. */
      ratePpm: number;
      /** What the account holds of the dollar and of the project's Shares before this press. */
      dollars: bigint;
      sharesBefore: bigint;
      /** Unix seconds when it was read. */
      readAt: number;
    };

export async function readBack(
  read: ReadCall,
  numbers: ProjectNumbers,
  amount: bigint,
  account: string,
): Promise<BackRead> {
  const { treasury, dollar, shares } = numbers.contracts;
  const payAndCall = await dollarHasPayAndCall(read, dollar);
  const [open, plan, fee, ratePpm, dollars, sharesBefore] = await Promise.all([
    doorOpenNow(read, treasury),
    // In one call the Shares go to whoever pays (the zero address says so). In two, `join` has no such shortcut, so it
    // names the account that sends: the press refuses to send if the wallet shows another by then.
    planBack(read, {
      dollar,
      treasury,
      amount,
      payAndCall,
      ...(payAndCall ? {} : { to: account }),
    }),
    feeFor(read, treasury, amount),
    ratePpmNow(read, treasury),
    balanceOf(read, dollar, account),
    balanceOf(read, shares, account),
  ]);
  if (!open) return { ok: false, why: "door-shut" };
  if (!plan) return { ok: false, why: "no-shares" };
  return {
    ok: true,
    plan,
    fee,
    ratePpm,
    dollars,
    sharesBefore,
    readAt: Math.floor(Date.now() / 1000),
  };
}
