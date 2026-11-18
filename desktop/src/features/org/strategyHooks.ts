/**
 * Team strategy write hooks (kind:44020) — the strategy form's publish
 * path and the "Seed example strategies" affordance on the org Teams tab.
 *
 * Publishing goes through the bundled `buzz` sidecar exactly like
 * `useTeamRunMutation` (./hooks.ts): a dedicated Tauri command owns the
 * child process (relay URL override + keyring signing key + bounded
 * timeout, mirroring desktop/src-tauri/src/commands/team.rs) and runs
 *
 *   buzz team strategy put --id <id> --file <strategy.json> --publish
 *   buzz team strategies seed-examples --publish
 *
 * (`TeamStrategyCmd::Put` reads the document from a **file path** — see
 * crates/buzz-cli/src/lib.rs — so the command writes the JSON payload to a
 * temp file first; there is no stdin/arg form.) Failures surface the CLI's
 * text verbatim and nothing partial is published: `put` validates strictly
 * before signing, and seed-examples publishes one fully-validated seed per
 * line. On success the folded bank query is refreshed under the same key
 * `useTeamStrategiesQuery` reads, so read-side LWW shows the new head.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { invokeTauri } from "@/shared/api/tauri";

import { orgQueryKey } from "./hooks";
import type { StrategyJson } from "./lib/strategyForm";

/** Normalized relay write response (matches `parse_write_response`). */
export type TeamStrategyPutResult = {
  /** The published kind:44020 event id. */
  eventId: string;
  accepted: boolean;
  message: string;
};

/** Result of `buzz team strategies seed-examples --publish`. */
export type TeamStrategiesSeedResult = {
  /** Number of seeds published (the CLI loads three paper strategies). */
  published: number;
  /** Seed strategy ids (`d` tags) in publish order. */
  ids: string[];
};

export type StrategyPutInput = {
  /** Strategy id (`d` tag), 1..=64 chars. */
  id: string;
  /** The kind:44020 content object from `toStrategyJson`. */
  content: StrategyJson;
};

/**
 * Validate + sign + publish one strategy via `buzz team strategy put
 * --id <id> --file <strategy.json> --publish`. Honest lifecycle: the
 * mutation stays pending for the sidecar run and surfaces the CLI's error
 * text on failure — it never reports success without a published event id.
 */
export function useStrategyPutMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      input: StrategyPutInput,
    ): Promise<TeamStrategyPutResult> =>
      invokeTauri<TeamStrategyPutResult>("team_strategy_put", {
        id: input.id.trim(),
        json: JSON.stringify(input.content),
      }),
    onSuccess: () => {
      // Same key as useTeamStrategiesQuery ([...orgQueryKey, "team-strategies"])
      // — refetch so the read-side LWW fold shows the published head.
      void queryClient.invalidateQueries({
        queryKey: [...orgQueryKey, "team-strategies"],
      });
    },
  });
}

/**
 * Publish the paper's example strategies via `buzz team strategies
 * seed-examples --publish` (the UI gates this behind a confirmation — it
 * publishes to the relay under the user's key).
 */
export function useStrategySeedMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<TeamStrategiesSeedResult> =>
      invokeTauri<TeamStrategiesSeedResult>("team_strategies_seed", {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: [...orgQueryKey, "team-strategies"],
      });
    },
  });
}
