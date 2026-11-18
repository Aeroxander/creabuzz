/**
 * Which DAO a launch belongs to, and which launch a DAO belongs to.
 *
 * A thread on a board can say it is about a decision of some DAO. Anyone can
 * write that on a post, so before the app shows anything read from the chain
 * for it, the DAO has to be one the app already knows from a launch: one the
 * launch settled into, or the one its sale summoned. A DAO no launch names is
 * never treated as a DAO of this community.
 *
 * Alias-free; `dao-of-launch.test.mjs` drives it under `node --test`.
 */

import type { Launch } from "../models.ts";
import { resolveDaoBinding } from "./org-money.ts";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** The launch's DAO address (lower case), or null when it has none the app can vouch for. */
export function daoOfLaunch(launch: Launch): string | null {
  const treasury = launch.record.treasury ?? "";
  if (ADDRESS.test(treasury) && launch.record.tokenPlan?.mode === "dao") {
    return treasury.toLowerCase();
  }
  return (
    resolveDaoBinding({ receipts: launch.receipts, orgBindings: [] })?.dao ??
    null
  );
}

/** The launch that owns this DAO on this chain, or null when none does. */
export function launchOfDao(
  launches: readonly Launch[],
  chainId: number,
  dao: string,
): Launch | null {
  const wanted = dao.toLowerCase();
  return (
    launches.find(
      (launch) =>
        Number(launch.record.chainId) === chainId &&
        daoOfLaunch(launch) === wanted,
    ) ?? null
  );
}
