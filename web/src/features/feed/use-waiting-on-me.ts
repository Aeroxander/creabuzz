/**
 * What is waiting on this person across the DAOs they are part of: decisions they can back, claims to review, payouts to
 * take, steps to move a decision along.
 *
 * "Their DAOs" are the ones whose Shares they hold (from the wallets they might hold in, as on the Portfolio) and the
 * ones they started, and only DAOs a launch names are looked at, so a DAO somebody wrote about on a post is never read
 * as theirs. It reuses each DAO's own page logic (`attentionItems`), so Home and the DAO's page can never disagree about
 * what is waiting. Bounded: a few DAOs, newest first. A DAO that could not be read is left out, not shown as "nothing".
 */

import { useQueries } from "@tanstack/react-query";
import { useMemo } from "react";

import {
  type AttentionItem,
  attentionItems,
} from "@/features/launchpad/lib/dao-overview";
import { daoOfLaunch } from "@/features/launchpad/lib/dao-of-launch";
import { reviewerTargets } from "@/features/launchpad/lib/reviewer-launches";
import { SANDBOX_ID } from "@/features/launchpad/lib/sandbox";
import type { Launch } from "@/features/launchpad/models";
import { useConnectedWallet } from "@/features/launchpad/use-connected-wallet";
import {
  decisionContextQuery,
  decisionsQuery,
} from "@/features/launchpad/use-decisions";
import { useLaunches } from "@/features/launchpad/use-launches";
import { workQuery } from "@/features/launchpad/use-work";
import { decisionTitler } from "@/features/launchpad/ui/decision-title";
import { useHoldings } from "@/features/portfolio/use-portfolio";
import { existingUserPubkey } from "@/shared/lib/identity";

/** The most DAOs read for this: each costs a handful of chain reads. */
export const MAX_DAOS = 6;

export interface WaitingInDao {
  launch: Launch;
  dao: string;
  items: AttentionItem[];
}

interface Target {
  launch: Launch;
  dao: string;
  /** The wallet that holds (or started) it: what the DAO's page would call "you". */
  wallet: string;
}

export function useWaitingOnMe(): {
  waiting: WaitingInDao[];
  loading: boolean;
} {
  const me = existingUserPubkey();
  const launches = useLaunches();
  const holdings = useHoldings();
  const connected = useConnectedWallet().address;

  const targets = useMemo((): Target[] => {
    const byDao = new Map<string, Target>();
    for (const held of holdings.data?.held ?? []) {
      const dao = daoOfLaunch(held.launch);
      if (dao && !byDao.has(dao)) {
        byDao.set(dao, { launch: held.launch, dao, wallet: held.owner });
      }
    }
    if (me && connected) {
      for (const launch of launches.data ?? []) {
        if (launch.record.author !== me || launch.record.id === SANDBOX_ID) {
          continue;
        }
        const dao = daoOfLaunch(launch);
        if (dao && !byDao.has(dao)) {
          byDao.set(dao, { launch, dao, wallet: connected });
        }
      }
    }
    // A reviewer is usually an outsider with no Shares and no project of their own: the launch receipt names the panel,
    // so the projects that named this wallet are found from the launches already read.
    for (const found of reviewerTargets(
      launches.data ?? [],
      connected ?? null,
      (launch) => launch.record.id === SANDBOX_ID,
    )) {
      if (!byDao.has(found.dao) && connected) {
        byDao.set(found.dao, { ...found, wallet: connected });
      }
    }
    return [...byDao.values()]
      .sort((a, b) => b.launch.record.createdAt - a.launch.record.createdAt)
      .slice(0, MAX_DAOS);
  }, [holdings.data, launches.data, me, connected]);

  const decisions = useQueries({
    queries: targets.map((t) => decisionsQuery(t.dao, t.wallet)),
  });
  const work = useQueries({
    queries: targets.map((t) => workQuery(t.dao, t.wallet)),
  });
  const context = useQueries({
    queries: targets.map((t) => decisionContextQuery(t.dao)),
  });

  const waiting = targets.flatMap((target, i): WaitingInDao[] => {
    const decided = decisions[i]?.data;
    const worked = work[i]?.data;
    // Neither could be read: unknown, not "nothing is waiting".
    if (!decided && !worked) return [];
    const items = attentionItems({
      decisions: decided,
      work: worked,
      wallet: target.wallet,
      titleOf: decisionTitler({
        launch: target.launch,
        dao: target.dao,
        factory: context[i]?.data?.factory,
        mandates: worked?.mandates.map((m) => m.address),
      }),
    });
    return items.length > 0
      ? [{ launch: target.launch, dao: target.dao, items }]
      : [];
  });

  const loading =
    holdings.data === undefined && holdings.error === undefined
      ? me !== null
      : decisions.some((q) => q.isLoading) || work.some((q) => q.isLoading);
  return { waiting, loading };
}
