/** Shared with the desktop app: the implementation lives in `@creaton/core`. */
export * from "@creaton/core/launchpad/matchedExit.ts";

import {
  type ExitExchangeRead,
  readExitExchange,
} from "@creaton/core/launchpad/matchedExit.ts";
import type { WorkChain } from "@creaton/core/launchpad/workRead.ts";
import { isRefusal } from "./ragequit-position.ts";

/** Where sales stand for these Shares, or null when the Shares were made before sales between members existed. */
export async function readExitSales(
  chain: Pick<WorkChain, "call">,
  shares: string,
): Promise<ExitExchangeRead | null> {
  try {
    return await readExitExchange(chain, shares);
  } catch (error) {
    if (isRefusal(error)) return null;
    throw error;
  }
}
