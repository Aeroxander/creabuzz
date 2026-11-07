// Desktop wiring for the shared emergency-stop sequence: relay fetch/publish
// and signing behind the pure executor in `@creaton/core/org/agentStop.ts`.
// One button press runs the whole ordered chain (stop budget, optional ban,
// unseating, grant revocation) and refreshes every surface that shows the
// agent afterwards.

import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { relayClient } from "@/shared/api/relayClient";
import { signRelayEvent } from "@/shared/api/tauri";
import { getIdentity } from "@/shared/api/tauriIdentity";
import { orgQueryKey } from "@/features/org/hooks";
import { managedAgentsQueryKey, relayAgentsQueryKey } from "./hooks.ts";
import { fetchOwnRecords } from "@creaton/core/org/agentStopFetch.ts";
import {
  AGENT_STOP_KIND_BAN,
  AGENT_STOP_KIND_BUDGET,
  AGENT_STOP_KIND_GRANT,
  AGENT_STOP_KIND_NODE,
  executeAgentStop,
  type AgentStopEvent,
  type AgentStopRecord,
  type AgentStopReport,
} from "./lib/agentStopSequence.ts";

const STOP_KINDS = [
  AGENT_STOP_KIND_BUDGET,
  AGENT_STOP_KIND_BAN,
  AGENT_STOP_KIND_NODE,
  AGENT_STOP_KIND_GRANT,
];

/** The caller's own stored records for `kind`, optionally one address. */
async function fetchOwn(
  kind: number,
  dTag?: string,
): Promise<AgentStopRecord[]> {
  const { pubkey } = await getIdentity();
  return fetchOwnRecords(
    (filter) => relayClient.fetchEvents(filter),
    pubkey,
    kind,
    dTag,
  );
}

async function publish(event: AgentStopEvent): Promise<void> {
  const signed = await signRelayEvent({
    kind: event.kind,
    content: event.content,
    tags: event.tags,
    createdAt: event.createdAt,
  });
  await relayClient.publishEvent(
    signed,
    "Timed out stopping the agent.",
    "Failed to stop the agent.",
  );
}

async function runAgentStop(
  agent: string,
  opts: { ban: boolean; reason?: string },
): Promise<AgentStopReport> {
  const { pubkey } = await getIdentity();
  return executeAgentStop({
    me: pubkey,
    agent,
    ban: opts.ban,
    reason: opts.reason,
    nowSeconds: () => Math.floor(Date.now() / 1000),
    fetchOwn,
    publish,
  });
}

/**
 * Stop several agents in sequence. Each agent gets the full ordered chain;
 * one agent's failure never blocks the next (each run is independently
 * retryable, and a re-run resumes where a partial failure left off).
 */
export async function runAgentStopAll(
  agents: readonly string[],
  opts: { ban: boolean; reason?: string },
): Promise<AgentStopReport[]> {
  const reports: AgentStopReport[] = [];
  for (const agent of agents) {
    reports.push(await runAgentStop(agent, opts));
  }
  return reports;
}

/** Run stops and refresh every surface that shows agents or seats. */
export function useAgentStop(): {
  run: (
    agents: readonly string[],
    opts: { ban: boolean; reason?: string },
  ) => Promise<AgentStopReport[]>;
  refresh: () => Promise<void>;
} {
  const queryClient = useQueryClient();
  const refresh = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: managedAgentsQueryKey }),
      queryClient.invalidateQueries({ queryKey: relayAgentsQueryKey }),
      queryClient.invalidateQueries({ queryKey: [...orgQueryKey, "nodes"] }),
      queryClient.invalidateQueries({ queryKey: [...orgQueryKey, "chart"] }),
    ]);
  }, [queryClient]);
  return { run: runAgentStopAll, refresh };
}

export { STOP_KINDS };
