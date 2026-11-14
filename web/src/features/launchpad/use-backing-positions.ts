/**
 * The pools a person holds something in: for "Projects you back" and Home's next step. There is no list of a wallet's
 * pools on the chain to read (and the factory's list of pools holds strangers' DAOs), so the pools asked are those of the
 * projects the person follows, helps or started, and the newest listed ones, at most `POSITION_PROJECTS` of them, each
 * confirmed by a kit's launch event. A bound that cut the list is said, never read as "you back nothing else".
 *
 * Off with the switch: nothing is read and nothing is returned.
 */

import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { effectiveStage, launchCoordinate, type LaunchRecord } from "./models";
import { backingTarget } from "./lib/backing-target";
import { investingOffered } from "./lib/investing-offered";
import { listedProject } from "./lib/listing";
import { raisesOffered } from "./lib/raises-offered";
import {
  type Position,
  positionNeeds,
  positionOf,
} from "./lib/backing-positions";
import type { Need } from "./lib/project-state";
import { BACKING_QUERY, provenanceQuery, readProjectPool } from "./use-backing";
import { useActingAccount } from "./use-acting-account";
import { useLaunches } from "./use-launches";
import { useMyProjects } from "./use-my-projects";

/** The most projects whose pools are asked about the wallet at once. */
export const POSITION_PROJECTS = 20;

export interface HeldPosition {
  record: LaunchRecord;
  coordinate: string;
  position: Position;
}

export function useBackingPositions(): {
  held: HeldPosition[];
  needs: Need[];
  loading: boolean;
  failed: number;
  /** More projects could have a pool than were asked about. */
  cut: boolean;
  /** No account to hold anything with. */
  noAccount: boolean;
  retry: () => void;
} {
  const on = investingOffered();
  const wallet = useActingAccount().address;
  const client = useQueryClient();
  const mine = useMyProjects();
  const launches = useLaunches();
  const candidates = useMemo(() => {
    if (!on) return [];
    const seen = new Set<string>();
    const out: LaunchRecord[] = [];
    const add = (record: LaunchRecord) => {
      const coordinate = launchCoordinate(record.author, record.id);
      if (seen.has(coordinate)) return;
      seen.add(coordinate);
      out.push(record);
    };
    for (const record of [
      ...(mine.data?.started ?? []),
      ...(mine.data?.helping.map((h) => h.record) ?? []),
      ...(mine.data?.following ?? []),
    ])
      add(record);
    const raises = raisesOffered();
    for (const launch of launches.data ?? [])
      if (listedProject(launch.record, effectiveStage(launch), raises))
        add(launch.record);
    return out.flatMap((record) =>
      backingTarget(record).kind === "target" ? [record] : [],
    );
  }, [on, mine.data, launches.data]);
  const asked = candidates.slice(0, POSITION_PROJECTS);
  const results = useQueries({
    queries: asked.map((record) => {
      const target = backingTarget(record);
      const dao = target.kind === "target" ? target.dao : null;
      return {
        queryKey: [...BACKING_QUERY, "position", dao, wallet],
        enabled: on && wallet !== null && target.kind === "target",
        staleTime: 60_000,
        refetchInterval: 120_000,
        refetchOnWindowFocus: false,
        queryFn: async (): Promise<HeldPosition | null> => {
          if (target.kind !== "target") return null;
          const confirmed = await client.fetchQuery(
            provenanceQuery(String(target.chainId), target.dao),
          );
          if (!confirmed) return null;
          const view = await readProjectPool(target, wallet);
          if (view.kind !== "pool") return null;
          const position = positionOf(view, Math.floor(Date.now() / 1000));
          return position
            ? {
                record,
                coordinate: launchCoordinate(record.author, record.id),
                position,
              }
            : null;
        },
      };
    }),
  });
  const held = results.flatMap((r) => (r.data ? [r.data] : []));
  const now = Math.floor(Date.now() / 1000);
  const needs = held.flatMap((h) =>
    positionNeeds(h.coordinate, h.position, now),
  );
  return {
    held,
    needs,
    loading: on && wallet !== null && results.some((r) => r.isLoading),
    failed: results.filter((r) => r.isError).length,
    cut: candidates.length > POSITION_PROJECTS,
    noAccount: on && wallet === null,
    retry: () => {
      for (const r of results) if (r.isError) void r.refetch();
    },
  };
}
