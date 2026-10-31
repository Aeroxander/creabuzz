/** Shared with the desktop app: the implementation lives in `@creaton/core`. */
export * from "@creaton/core/launchpad/exitExchange.ts";

import {
  type ExitExchangeRead,
  readExitExchange,
} from "@creaton/core/launchpad/exitExchange.ts";
import type { WorkChain } from "@creaton/core/launchpad/workRead.ts";
import { isRefusal } from "./ragequit-position.ts";

/** Where the exchange stands for these Shares, or null when the Shares were made before exchanges existed. */
export async function readExchangeIfAny(
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
