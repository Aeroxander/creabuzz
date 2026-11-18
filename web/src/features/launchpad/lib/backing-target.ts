/**
 * Which projects show a Backing block, and how often a pool is read again.
 *
 * A project shows backing only when investing is on in this build and it names, for the project's own network, the pool
 * factory and the token backers pay in; the project is a DAO-run one whose DAO is in its own record (never found by
 * walking the factory's list: that holds strangers' DAOs next to real ones). Even then, money actions need the project's
 * start checked against a kit's own launch event (`use-contributor-provenance.ts`): a record alone can name any DAO.
 *
 * Alias-free on purpose: `backing-target.test.mjs` drives it under `node --test`.
 */

import {
  backingPoolFactory,
  backingQuoteToken,
  type ChainEnv,
  viteEnv,
} from "../chain-config.ts";
import { investingOffered } from "./investing-offered.ts";

/** The slice of a project record these rules read. */
export interface BackingRecord {
  chainId: string | null;
  treasury: string | null;
  tokenPlan?: { mode: string } | null;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Everything a read of a project's pool needs, or why there is nothing to read. */
export type BackingTarget =
  | {
      kind: "target";
      chainId: number;
      factory: string;
      quoteToken: string;
      dao: string;
    }
  | { kind: "off" }
  /** Investing is on here, but this project has no DAO or no network the build can read. */
  | { kind: "not-here"; why: "no-dao" | "no-network" | "no-factory" };

export function backingTarget(
  record: BackingRecord,
  env: ChainEnv | undefined = viteEnv(),
): BackingTarget {
  if (!investingOffered(env)) return { kind: "off" };
  const dao = record.treasury?.trim() ?? "";
  if (record.tokenPlan?.mode !== "dao" || !ADDRESS_RE.test(dao)) {
    return { kind: "not-here", why: "no-dao" };
  }
  const chain = Number(record.chainId ?? "");
  if (!Number.isInteger(chain) || chain <= 0) {
    return { kind: "not-here", why: "no-network" };
  }
  const factory = backingPoolFactory(chain, env);
  const quoteToken = backingQuoteToken(chain, env);
  if (factory === null || quoteToken === null) {
    return { kind: "not-here", why: "no-factory" };
  }
  return {
    kind: "target",
    chainId: chain,
    factory,
    quoteToken,
    dao: dao.toLowerCase(),
  };
}

/** How long the pool read waits before the next one: slower for each failure in a row, capped at five minutes. */
export function backingRefreshMs(failures: number, busy: boolean): number {
  if (failures > 0) return Math.min(15_000 * 2 ** (failures - 1), 300_000);
  // A round that is open, or a window that is running, changes by the clock: look more often.
  return busy ? 15_000 : 45_000;
}
