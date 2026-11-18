/**
 * Where the decision behind each proposal post on a board stands, read from
 * the chain, for the board's list to show and to order by.
 *
 * Only DAOs that a launch the app knows has settled into are read (see
 * `lib/proposal-statuses.ts`); a post naming any other gets no status. Loaded
 * only for a board that has proposal posts, so ordinary boards do not carry
 * the chain code.
 */

import { useQueries } from "@tanstack/react-query";
import { type ReactNode, useMemo } from "react";

import type { ProposalStatesProps } from "@/features/board/ui/BoardView";

import { knownDaosOf, proposalStatuses } from "../lib/proposal-statuses";
import { decisionsQuery } from "../use-decisions";
import { useLaunches } from "../use-launches";

export function ProposalStates({
  posts,
  children,
}: ProposalStatesProps): ReactNode {
  const launches = useLaunches();
  const known = useMemo(
    () => knownDaosOf(posts, launches.data ?? []),
    [posts, launches.data],
  );
  const reads = useQueries({
    queries: known.map((dao) => decisionsQuery(dao, null)),
  });
  const snapshots = useMemo(() => {
    const map = new Map<string, NonNullable<(typeof reads)[number]["data"]>>();
    known.forEach((dao, index) => {
      const data = reads[index]?.data;
      if (data) map.set(dao, data);
    });
    return map;
  }, [known, reads]);
  const statuses = useMemo(
    () => proposalStatuses(posts, launches.data ?? [], snapshots),
    [posts, launches.data, snapshots],
  );
  // A DAO that could not be read does not hold the list up: its posts simply have no status.
  const ready = !launches.isLoading && reads.every((read) => !read.isLoading);
  return children(statuses, ready);
}
