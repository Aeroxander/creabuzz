import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { relayClient } from "@/shared/api/relayClient";
import { invokeTauri } from "@/shared/api/tauri";
import {
  KIND_TEAM_STRATEGY,
  KIND_TEAM_RUN,
  KIND_TEAM_TURN,
} from "@/shared/constants/kinds";

import {
  TEAM_STRATEGY_FETCH_LIMIT,
  TEAM_RUN_FETCH_LIMIT,
  TEAM_TURN_FETCH_LIMIT,
  eventToTeamTurn,
  newestTeamStrategies,
  newestTeamRuns,
  sortTurnsForRun,
  type TeamStrategy,
  type TeamRun,
  type TeamTurn,
} from "../lib/teamTypes";
import { ORG_STALE_TIME_MS, ORG_GC_TIME_MS, orgQueryKey } from "./shared";

// ── Teams (SAT kinds 44020-44022) ─────────────────────────────────────────

/**
 * Self-organizing agent teams: strategy bank (44020), runs (44021), turns
 * (44022). All community-level, read-side LWW per (pubkey, kind, d) — see
 * lib/teamTypes.ts. Fetches are bounded per kind and always carry explicit
 * `kinds` (the relay's p-gate rejects filter-less queries).
 */

type TeamEventLike = {
  id: string;
  kind: number;
  pubkey: string;
  created_at: number;
  tags: ReadonlyArray<readonly string[]>;
  content: string;
};

async function fetchTeamEvents(
  kinds: number[],
  limit: number,
  _signal?: AbortSignal,
): Promise<TeamEventLike[]> {
  const events = await relayClient.fetchEvents({ kinds, limit });
  return events as TeamEventLike[];
}

async function fetchTeamStrategies(
  signal?: AbortSignal,
): Promise<TeamStrategy[]> {
  const events = await fetchTeamEvents(
    [KIND_TEAM_STRATEGY],
    TEAM_STRATEGY_FETCH_LIMIT,
    signal,
  );
  return newestTeamStrategies(events);
}

async function fetchTeamRuns(signal?: AbortSignal): Promise<TeamRun[]> {
  const events = await fetchTeamEvents(
    [KIND_TEAM_RUN],
    TEAM_RUN_FETCH_LIMIT,
    signal,
  );
  return newestTeamRuns(events);
}

async function fetchTeamTurns(signal?: AbortSignal): Promise<TeamTurn[]> {
  const events = await fetchTeamEvents(
    [KIND_TEAM_TURN],
    TEAM_TURN_FETCH_LIMIT,
    signal,
  );
  const turns: TeamTurn[] = [];
  for (const event of events) {
    const turn = eventToTeamTurn(event);
    if (turn) turns.push(turn);
  }
  return sortTurnsForRun(turns);
}

export function useTeamStrategiesQuery(enabled = true) {
  return useQuery({
    queryKey: [...orgQueryKey, "team-strategies"],
    queryFn: ({ signal }) => fetchTeamStrategies(signal),
    staleTime: ORG_STALE_TIME_MS,
    gcTime: ORG_GC_TIME_MS,
    enabled,
  });
}

export function useTeamRunsQuery(enabled = true) {
  return useQuery({
    queryKey: [...orgQueryKey, "team-runs"],
    queryFn: ({ signal }) => fetchTeamRuns(signal),
    staleTime: ORG_STALE_TIME_MS,
    gcTime: ORG_GC_TIME_MS,
    enabled,
  });
}

export function useTeamTurnsQuery(enabled = true) {
  return useQuery({
    queryKey: [...orgQueryKey, "team-turns"],
    queryFn: ({ signal }) => fetchTeamTurns(signal),
    staleTime: ORG_STALE_TIME_MS,
    gcTime: ORG_GC_TIME_MS,
    enabled,
  });
}

/** Result of a published `buzz team run --publish` invocation. */
export type TeamRunResult = {
  mode: "published";
  runId: string;
  eventId: string;
  turns: number;
};

/** Result of a published `buzz team reflect --publish` invocation. */
export type TeamReflectResult = {
  /** New revision `d` (`<original-id>-rev<N>`). */
  revisionD: string;
  /** Published revision event id. */
  eventId: string;
  /** The revised strategy content, as parsed by the CLI. */
  revised: Record<string, unknown>;
};

function invalidateTeamQueries(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({
    queryKey: [...orgQueryKey, "team-strategies"],
  });
  void queryClient.invalidateQueries({
    queryKey: [...orgQueryKey, "team-runs"],
  });
  void queryClient.invalidateQueries({
    queryKey: [...orgQueryKey, "team-turns"],
  });
}

/** Publish a strategy run through the buzz sidecar (10-min hard timeout). */
export function useTeamRunMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      strategyId: string;
      problem: string;
      orgNode: string | null;
    }): Promise<TeamRunResult> =>
      invokeTauri<TeamRunResult>("team_run", {
        strategyId: input.strategyId,
        problem: input.problem,
        orgNode: input.orgNode ?? null,
      }),
    onSuccess: () => invalidateTeamQueries(queryClient),
  });
}

/** Publish a reflection revision for a run through the sidecar (120s cap). */
export function useTeamReflectMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (runId: string): Promise<TeamReflectResult> =>
      invokeTauri<TeamReflectResult>("team_reflect", { runId }),
    onSuccess: () => invalidateTeamQueries(queryClient),
  });
}
