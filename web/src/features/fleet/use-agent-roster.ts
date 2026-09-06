/**
 * Live fleet roster.
 *
 * The roster is a subscription over kind:44010 capabilities events plus a
 * one-shot history query. Liveness is heartbeat recency: an agent whose
 * heartbeat is older than the window is rendered offline.
 */

import { useEffect, useMemo, useState } from "react";

import {
  queryEvents,
  type NostrFilter,
  type NostrEvent,
} from "@/shared/lib/nostr-client";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { subscribeChannel } from "@/features/channels/subscribe-channel";
import { KIND_AGENT_CAPABILITIES } from "@/shared/constants/kinds";
import { truncatePubkey } from "@/shared/lib/pubkey";

export type AgentRuntype = "browser" | "desktop" | "sandbox";
export type AgentStatus = "available" | "busy" | "offline";

export interface AgentCapabilities {
  id: string;
  pubkey: string;
  name: string;
  runtype: AgentRuntype;
  status: AgentStatus;
  tools: string[];
  heartbeat: number;
  updatedAt: number;
  alive: boolean;
}

const LIVENESS_WINDOW_MS = 180_000;

function parseCapabilities(event: NostrEvent): AgentCapabilities | null {
  const id = event.tags.find((t) => t[0] === "d")?.[1] ?? event.pubkey;
  let body: {
    name?: string;
    runtype?: string;
    status?: string;
    tools?: string[];
    heartbeat?: number;
  } = {};
  try {
    body = JSON.parse(event.content) as typeof body;
  } catch {
    // malformed — still surface the agent with defaults
  }
  const runtype = (["browser", "desktop", "sandbox"] as const).includes(
    body.runtype as AgentRuntype,
  )
    ? (body.runtype as AgentRuntype)
    : "sandbox";
  const status = (["available", "busy", "offline"] as const).includes(
    body.status as AgentStatus,
  )
    ? (body.status as AgentStatus)
    : "available";
  return {
    id,
    pubkey: event.pubkey,
    name: body.name ?? truncatePubkey(event.pubkey),
    runtype,
    status,
    tools: body.tools ?? [],
    heartbeat: body.heartbeat ?? event.created_at * 1000,
    updatedAt: event.created_at * 1000,
    alive:
      Date.now() - (body.heartbeat ?? event.created_at * 1000) <
      LIVENESS_WINDOW_MS,
  };
}

export function useAgentRoster(): {
  agents: AgentCapabilities[];
  loading: boolean;
} {
  const [agents, setAgents] = useState<Record<string, AgentCapabilities>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const wsUrl = relayWsUrl();
    const filter: NostrFilter = {
      kinds: [KIND_AGENT_CAPABILITIES],
      limit: 200,
    };
    let disposed = false;

    const upsert = (event: NostrEvent) => {
      const parsed = parseCapabilities(event);
      if (!parsed) return;
      setAgents((prev) => ({ ...prev, [parsed.id]: parsed }));
    };

    void queryEvents(wsUrl, filter)
      .then((events) => {
        if (disposed) return;
        setAgents((prev) => {
          const next = { ...prev };
          for (const event of events) {
            const parsed = parseCapabilities(event);
            if (parsed) next[parsed.id] = parsed;
          }
          return next;
        });
        setLoading(false);
      })
      .catch(() => {
        if (!disposed) setLoading(false);
      });

    const unsubscribe = subscribeChannel(
      wsUrl,
      { kinds: [KIND_AGENT_CAPABILITIES] },
      { onEvent: (event) => upsert(event) },
    );

    const livenessTimer = setInterval(() => {
      setAgents((prev) => {
        const now = Date.now();
        let changed = false;
        const next: Record<string, AgentCapabilities> = {};
        for (const [id, agent] of Object.entries(prev)) {
          const alive = now - agent.heartbeat < LIVENESS_WINDOW_MS;
          if (alive !== agent.alive) changed = true;
          next[id] = { ...agent, alive };
        }
        return changed ? next : prev;
      });
    }, 30_000);

    return () => {
      disposed = true;
      clearInterval(livenessTimer);
      unsubscribe();
    };
  }, []);

  const sorted = useMemo(
    () =>
      Object.values(agents).sort(
        (a, b) =>
          Number(b.alive) - Number(a.alive) || b.updatedAt - a.updatedAt,
      ),
    [agents],
  );

  return { agents: sorted, loading };
}
