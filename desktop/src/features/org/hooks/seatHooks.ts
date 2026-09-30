import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { relayClient } from "@/shared/api/relayClient";
import { signRelayEvent } from "@/shared/api/tauri";
import { getIdentity } from "@/shared/api/tauriIdentity";
import {
  KIND_ORG_NODE,
  KIND_AGENT_TASK,
  KIND_AGENT_CAPABILITIES,
  KIND_AGENT_TURN_METRIC,
} from "@/shared/constants/kinds";

import {
  nextCreatedAt,
  orgNodeTags,
  SeatNotFoundError,
  withAgentSeat,
} from "../lib/orgPublish";
import {
  LIVENESS_FETCH_LIMIT,
  type LivenessEventLike,
} from "../lib/nodeLiveness";
import {
  ORG_STALE_TIME_MS,
  ORG_GC_TIME_MS,
  orgQueryKey,
  fetchOrgEvents,
  fetchOwnRecord,
} from "./shared";

// ── Agent tasks (kind:44011) — evidence picker source ──────────────────────

export type AgentTaskRef = {
  eventId: string;
  dtag: string;
  title: string;
  status?: string;
  createdAt: number;
};

async function fetchAgentTasks(signal?: AbortSignal): Promise<AgentTaskRef[]> {
  const events = await fetchOrgEvents([KIND_AGENT_TASK], signal);
  return events.map((event) => {
    let parsed: Record<string, unknown> = {};
    try {
      const value: unknown = JSON.parse(event.content);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        parsed = value as Record<string, unknown>;
      }
    } catch {
      // Malformed content — fall back to the event id as the title.
    }
    return {
      eventId: event.id,
      dtag: event.tags.find((t) => t[0] === "d")?.[1] ?? "",
      title: (typeof parsed.title === "string" && parsed.title) || event.id,
      status:
        typeof parsed.status === "string" && parsed.status
          ? parsed.status
          : undefined,
      createdAt: event.created_at,
    };
  });
}

export function useAgentTasksQuery(enabled = true) {
  return useQuery({
    queryKey: [...orgQueryKey, "agent-tasks"],
    queryFn: ({ signal }) => fetchAgentTasks(signal),
    staleTime: ORG_STALE_TIME_MS,
    gcTime: ORG_GC_TIME_MS,
    enabled,
  });
}

// ── Agent liveness (kinds:44010 capabilities + 44200 turn metrics) ────────

/**
 * Newest liveness signal per agent identity, bounded. Heartbeat-style rows
 * flood history, so the read pulls a capped page per kind — the newest
 * signals are what liveness needs, and a truncated page still has them.
 * Derivation (thresholds + per-seat newest) lives in lib/nodeLiveness.ts;
 * this hook only fetches.
 */
async function fetchLivenessEvents(
  _signal?: AbortSignal,
): Promise<LivenessEventLike[]> {
  const [capabilities, metrics] = await Promise.all([
    relayClient.fetchEvents({
      kinds: [KIND_AGENT_CAPABILITIES],
      limit: LIVENESS_FETCH_LIMIT,
    }),
    relayClient.fetchEvents({
      kinds: [KIND_AGENT_TURN_METRIC],
      limit: LIVENESS_FETCH_LIMIT,
    }),
  ]);
  return [...capabilities, ...metrics];
}

export function useAgentLivenessQuery(enabled = true) {
  return useQuery({
    queryKey: [...orgQueryKey, "liveness"],
    queryFn: ({ signal }) => fetchLivenessEvents(signal),
    staleTime: ORG_STALE_TIME_MS,
    gcTime: ORG_GC_TIME_MS,
    enabled,
  });
}

// ── Agent seat publish ─────────────────────────────────────────────────────

type AttachAgentSeatInput = {
  /** Node id (for a template seat: `seat-<persona-id>`). */
  dtag: string;
  agentPubkey: string;
  detach?: boolean;
};

/**
 * Seat an agent in a node you authored (or remove it). Republishes the node
 * with only `agentSeats` changed — holders, parent, scope and any onchain
 * binding are kept, since a wholesale rewrite would strip a node's standing.
 * Resolves `false` when the seat already reads that way and nothing was sent.
 */
export async function publishAgentSeat(
  input: AttachAgentSeatInput,
): Promise<boolean> {
  const { pubkey } = await getIdentity();
  const existing = await fetchOwnRecord(KIND_ORG_NODE, input.dtag, pubkey);
  if (!existing) {
    throw new SeatNotFoundError(
      "Only a node's author can change its seats, and this one was not found among yours.",
    );
  }
  const content = withAgentSeat(
    existing.content,
    input.agentPubkey,
    input.detach ?? false,
  );
  if (content === null) return false;
  const event = await signRelayEvent({
    kind: KIND_ORG_NODE,
    content,
    tags: orgNodeTags(input.dtag, content),
    createdAt: nextCreatedAt(
      existing.created_at,
      Math.floor(Date.now() / 1000),
    ),
  });
  await relayClient.publishEvent(
    event,
    "Timed out updating the seat.",
    "Failed to update the seat.",
  );
  return true;
}

export function useAttachAgentSeatMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: publishAgentSeat,
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: [...orgQueryKey, "nodes"],
      });
      await queryClient.invalidateQueries({
        queryKey: [...orgQueryKey, "chart"],
      });
    },
  });
}
