/**
 * What is waiting on this person across the DAOs they are part of: decisions they can back, claims to review, payouts to
 * take, steps to move a decision along.
 *
 * "Their DAOs" are the ones whose Shares they hold (from the wallets they might hold in, as on the Portfolio) and the
 * ones they started, and only DAOs a launch names are looked at, so a DAO somebody wrote about on a post is never read
 * as theirs. It reuses each DAO's own page logic (`attentionItems`), so Home and the DAO's page can never disagree about
 * what is waiting. Bounded: a few DAOs, newest first. The list is ranked across projects (what has a deadline first,
 * soonest first), and a DAO that could not be read is reported as such, never shown as "nothing is waiting".
 */

import { useQueries } from "@tanstack/react-query";
import { useMemo } from "react";

import {
  type AttentionItem,
  attentionItems,
  rankEntries,
} from "@/features/launchpad/lib/dao-overview";
import { daoOfLaunch } from "@/features/launchpad/lib/dao-of-launch";
import { reviewerTargets } from "@/features/launchpad/lib/reviewer-launches";
import {
  boundTargets,
  contributorWorkTargets,
} from "@/features/launchpad/lib/work-targets";
import { SANDBOX_ID } from "@/features/launchpad/lib/sandbox";
import type { Launch } from "@/features/launchpad/models";
import { useActingAccount } from "@/features/launchpad/use-acting-account";
import {
  decisionContextQuery,
  decisionsQuery,
} from "@/features/launchpad/use-decisions";
import { useLaunches } from "@/features/launchpad/use-launches";
import { challengeAttention } from "@/features/launchpad/lib/challenge-attention";
import { challengeLockQuery } from "@/features/launchpad/use-challenge-lock";
import { workQuery } from "@/features/launchpad/use-work";
import { useWalletLabels } from "@/features/launchpad/use-wallet-labels";
import { decisionTitler } from "@/features/launchpad/ui/decision-title";
import { useHoldings } from "@/features/portfolio/use-portfolio";
import { existingUserPubkey } from "@/shared/lib/identity";

/** The most DAOs read for this: each costs a handful of chain reads. */
const MAX_DAOS = 6;

/** One line of the queue: a thing waiting on this person in one project, with the clock its deadline is in. */
export interface QueueEntry {
  launch: Launch;
  dao: string;
  item: AttentionItem;
  /** The chain's own time when it was read: `item.due` is in this clock. */
  now: number;
}

interface Target {
  launch: Launch;
  dao: string;
  /** The wallet that holds (or started) it: what the DAO's page would call "you". */
  wallet: string;
}

export function useWaitingOnMe(): {
  /** Everything waiting, most urgent first. */
  queue: QueueEntry[];
  /** Projects that could not be read in full just now: what is listed may be missing something. */
  incomplete: Launch[];
  loading: boolean;
  /** Ask again about the projects that could not be read. */
  retry: () => void;
} {
  const me = existingUserPubkey();
  const launches = useLaunches();
  const holdings = useHoldings();
  const connected = useActingAccount().address;

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
    // A contributor project's contributors and reviewers hold no Shares and are named in no receipt: the projects they
    // submitted work to are theirs, and the newest few are looked at in the slots left (bounded; see `work-targets.ts`).
    const discovery: Target[] = [];
    if (connected) {
      for (const found of contributorWorkTargets(
        launches.data ?? [],
        me,
        (launch) => launch.record.id === SANDBOX_ID,
      )) {
        if (byDao.has(found.dao)) continue;
        const target = {
          launch: found.launch,
          dao: found.dao,
          wallet: connected,
        };
        if (found.discovery) discovery.push(target);
        else byDao.set(found.dao, target);
      }
    }
    return boundTargets([...byDao.values()], discovery, MAX_DAOS);
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
  const challenge = useQueries({
    queries: targets.map((t) => challengeLockQuery(t.dao)),
  });
  // People named by their name, not their wallet: whoever submitted the work waiting on this person.
  const contributors = [
    ...new Set(
      work.flatMap((q) =>
        (q.data?.mandates ?? []).flatMap((m) =>
          m.claims.map((c) => c.record.contributor.toLowerCase()),
        ),
      ),
    ),
  ].sort();
  const contributorsKey = contributors.join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the addresses, not the array
  const named = useMemo(() => contributors, [contributorsKey]);
  const labelOf = useWalletLabels(named);

  const queue = rankEntries(
    targets.flatMap((target, i): QueueEntry[] => {
      const decided = decisions[i]?.data;
      const worked = work[i]?.data;
      const lock = challenge[i]?.data;
      // Nothing could be read: that is reported through `incomplete`, never as "nothing is waiting".
      if (!decided && !worked && !lock) return [];
      const items = [
        ...(decided || worked
          ? attentionItems({
              decisions: decided,
              work: worked,
              wallet: target.wallet,
              labelOf,
              titleOf: decisionTitler({
                launch: target.launch,
                dao: target.dao,
                factory: context[i]?.data?.factory,
                mandates: worked?.mandates.map((m) => m.address),
              }),
            })
          : []),
        // A project whose milestones unlock unless holders object: what that asks of this person.
        ...(lock ? challengeAttention(lock, target.wallet) : []),
        // Home lists what this person can do; their own work waiting on others is on the project's page.
      ].filter((item) => item.actor !== "others");
      const now = lock?.now ?? decided?.chainTime ?? worked?.chainTime ?? 0;
      return items.map((item) => ({
        launch: target.launch,
        dao: target.dao,
        item,
        now,
      }));
    }),
  );

  // A read that failed and has nothing earlier to show leaves a hole in the list, even when the others worked.
  const failed = (i: number) =>
    [decisions[i], work[i], challenge[i]].some(
      (q) => q?.isError && q.data === undefined,
    );
  const incomplete = targets.filter((_, i) => failed(i)).map((t) => t.launch);
  const retry = () => {
    for (const results of [decisions, work, challenge]) {
      for (const q of results) if (q.isError) void q.refetch();
    }
  };

  const loading =
    holdings.data === undefined && holdings.error === undefined
      ? me !== null
      : decisions.some((q) => q.isLoading) || work.some((q) => q.isLoading);
  return { queue, incomplete, loading, retry };
}
