import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { getRpcEndpoint } from "./chain";
import { keepIfSame } from "./keep-previous";
import {
  deadlineDelayMs,
  POLL_FOR_MS,
  pollInterval,
  pollPaused,
} from "./lib/bounded-poll";
import {
  type ChallengeLockView,
  findChallengeLock,
  readChallengeVoter,
} from "@creaton/core/launchpad/milestoneChallenge.ts";
import { endpointChain } from "./use-work";

/** Every read about a milestone lock lives under this key, so one call re-reads them all. */
const challengeQueryKey = ["launchpad", "challenge"] as const;

/**
 * The read of a DAO's milestone lock. It answers a lock that lets holders object, or `null` when the DAO's lock is confirmed
 * not to be one (a panel's, or none). A read that gets no answer is an error, never `null`: an unreadable lock is unknown, not a
 * panel. Home reads it when it is opened or come back to; the Milestones tab keeps it fresh (see `useChallengeLockState`).
 */
export function challengeLockQuery(dao: string | null) {
  return {
    queryKey: [...challengeQueryKey, dao],
    enabled: dao !== null,
    queryFn: (): Promise<ChallengeLockView | null> =>
      findChallengeLock(endpointChain(getRpcEndpoint()), dao as string),
    placeholderData: keepIfSame(2, dao),
    staleTime: 10_000,
    refetchOnWindowFocus: true,
    retry: 1,
  };
}

export function useChallengeLock(dao: string | null) {
  return useQuery(challengeLockQuery(dao));
}

/**
 * What a read of the lock says about how milestones are judged. `data === null` is a confirmed "not a challenge lock"; a read
 * that failed with nothing read before is "unreadable", never a panel.
 */
export function lockKindOf(
  dao: string | null,
  query: { data: ChallengeLockView | null | undefined; isError: boolean },
): LockKind {
  if (dao === null) return "none";
  if (query.data === undefined) return query.isError ? "unreadable" : "loading";
  return query.data === null ? "panel" : "challenge";
}

/** What is known about how a project's milestones are judged. */
export type LockKind =
  /** No DAO yet: the rule is set when the project launches. */
  | "none"
  | "loading"
  /** The lock could not be read and nothing was read before: the rule is not known. */
  | "unreadable"
  /** A lock where holders can object. */
  | "challenge"
  /** Confirmed not a challenge lock: a panel of named reviewers (or no lock). */
  | "panel";

export interface LockState {
  kind: LockKind;
  view: ChallengeLockView | null;
  /** The newest read failed: what is shown is the last one that worked. */
  stale: boolean;
  /** When the lock was last read successfully (ms), or null. */
  readAt: number | null;
  /** A read is in flight. */
  fetching: boolean;
  /** The screen has stopped asking on its own (nobody has asked for a while). */
  paused: boolean;
  /** Read again now, and start asking on its own again. */
  refresh: () => void;
}

/**
 * The lock for a screen that is being watched: it asks again every few seconds while visible (but only for fifteen minutes
 * after someone last asked, then says it has paused), when the person comes back to the tab, and just after the next deadline
 * passes, so a vote that opened or a window that closed shows up without reloading. It keeps the last good read when a later
 * one fails and says so, and never turns a failed read into "a panel".
 */
export function useChallengeLockState(dao: string | null): LockState {
  const askedAt = useRef(Date.now());
  const [paused, setPaused] = useState(false);
  const [, setTick] = useState(0);
  const query = useQuery({
    ...challengeLockQuery(dao),
    refetchInterval: () => pollInterval(Date.now(), askedAt.current),
    refetchIntervalInBackground: false,
  });
  const { refetch } = query;

  const refresh = useCallback(() => {
    askedAt.current = Date.now();
    setPaused(false);
    void refetch();
  }, [refetch]);

  // Say so when it stops asking on its own.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `dataUpdatedAt` is the trigger: each answer from the chain restarts the clock.
  useEffect(() => {
    if (paused) return;
    const left = POLL_FOR_MS - (Date.now() - askedAt.current);
    const timer = setTimeout(
      () => setPaused(pollPaused(Date.now(), askedAt.current)),
      Math.max(left, 0) + 100,
    );
    return () => clearTimeout(timer);
  }, [paused, query.dataUpdatedAt]);

  // Coming back to the tab is asking.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        askedAt.current = Date.now();
        setPaused(false);
        setTick((n) => n + 1);
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  const view = query.data ?? null;
  const readAt = query.dataUpdatedAt > 0 ? query.dataUpdatedAt : null;

  // One more read just after the next deadline, so a window that closes or a vote that ends shows up on its own.
  const deadline = useMemo(() => nextDeadline(view), [view]);
  useEffect(() => {
    if (!view || readAt === null) return;
    const delay = deadlineDelayMs(deadline, view.now, Date.now() - readAt);
    if (delay === null) return;
    const timer = setTimeout(() => void refetch(), delay);
    return () => clearTimeout(timer);
  }, [deadline, view, readAt, refetch]);

  return {
    kind: lockKindOf(dao, query),
    view,
    stale: query.isError && query.data !== undefined,
    readAt,
    fetching: query.isFetching,
    paused,
    refresh,
  };
}

/** The earliest moment (unix seconds) after which something about the lock changes by itself, or null. */
function nextDeadline(view: ChallengeLockView | null): number | null {
  if (!view) return null;
  let next: number | null = null;
  const consider = (t: number) => {
    if (t > view.now && (next === null || t < next)) next = t;
  };
  for (const m of view.milestones) {
    if (m.phase === "pending") consider(m.windowEnds);
    if (m.objection?.open) consider(m.objection.voteEnds);
    if (m.phase === "stood") consider(m.unlockedAt + view.terms.clawback);
  }
  return next;
}

/**
 * What the connected wallet's vote would count for on each milestone, and whether it has already voted. Kept fresh with the
 * lock, and never showing another wallet's answer (or another lock's) in place of this one's while it loads.
 */
export function useChallengeViewers(
  lock: string | null,
  wallet: string | null,
  count: number,
) {
  const askedAt = useRef(Date.now());
  return useQuery({
    queryKey: [...challengeQueryKey, lock, "viewers", wallet, count],
    enabled: lock !== null && wallet !== null && count > 0,
    queryFn: async () => {
      const chain = endpointChain(getRpcEndpoint());
      return Promise.all(
        Array.from({ length: count }, (_, index) =>
          readChallengeVoter(chain, lock as string, index, wallet as string),
        ),
      );
    },
    // Only an answer about the same lock and the same wallet may stand in while the next one loads.
    placeholderData: (previous, previousQuery) =>
      previousQuery &&
      previousQuery.queryKey[2] === lock &&
      previousQuery.queryKey[4] === wallet
        ? previous
        : undefined,
    refetchInterval: () => pollInterval(Date.now(), askedAt.current),
    refetchIntervalInBackground: false,
    staleTime: 10_000,
    refetchOnWindowFocus: true,
  });
}
