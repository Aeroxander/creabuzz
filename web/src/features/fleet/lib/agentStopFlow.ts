// Web wiring for the shared emergency-stop sequence: relay fetch/publish and
// signing behind the pure executor in `@creaton/core/org/agentStop.ts`. The
// org view's seat chips re-read through its live subscription (each stop step
// is a strictly-newer republish, which the subscription re-indexes), so a
// successful stop leaves no stale "agent still seated" UI.

import {
  AGENT_STOP_KIND_BAN,
  AGENT_STOP_KIND_BUDGET,
  AGENT_STOP_KIND_GRANT,
  AGENT_STOP_KIND_NODE,
  executeAgentStop,
  type AgentStopEvent,
  type AgentStopRecord,
  type AgentStopReport,
} from "./agentStopSequence.ts";
import { queryEvents } from "@/shared/lib/nostr-client";
import { publishEvent } from "@/shared/lib/publish-event";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { signAsUser, userPubkey } from "@/shared/lib/identity";
import { fetchOwnRecords } from "@creaton/core/org/agentStopFetch.ts";

/** The caller's own stored records for `kind`, optionally one address. */
async function fetchOwn(
  kind: number,
  dTag?: string,
): Promise<AgentStopRecord[]> {
  return fetchOwnRecords(
    (filter) => queryEvents(relayWsUrl(), filter),
    userPubkey(),
    kind,
    dTag,
  );
}

async function publish(event: AgentStopEvent): Promise<void> {
  const signed = await signAsUser({
    kind: event.kind,
    content: event.content,
    tags: event.tags,
    created_at: event.createdAt,
  });
  const result = await publishEvent(relayWsUrl(), signed);
  if (!result.accepted) {
    throw new Error(result.message ?? "The relay did not accept the change.");
  }
}

/**
 * Stop several agents in sequence. Each agent gets the full ordered chain
 * (stop budget, optional ban, unseating, grant revocation); one agent's
 * failure never blocks the next, and a re-run resumes where a partial failure
 * left off.
 */
export async function runAgentStopAll(
  agents: readonly string[],
  opts: { ban: boolean; reason?: string },
): Promise<AgentStopReport[]> {
  const reports: AgentStopReport[] = [];
  for (const agent of agents) {
    reports.push(
      await executeAgentStop({
        me: userPubkey(),
        agent,
        ban: opts.ban,
        reason: opts.reason,
        nowSeconds: () => Math.floor(Date.now() / 1000),
        fetchOwn,
        publish,
      }),
    );
  }
  return reports;
}

export {
  AGENT_STOP_KIND_BAN,
  AGENT_STOP_KIND_BUDGET,
  AGENT_STOP_KIND_GRANT,
  AGENT_STOP_KIND_NODE,
};
