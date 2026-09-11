/**
 * Agent roster: capability announcements (kind 44010) from agents in this
 * community, with liveness derived from their heartbeat.
 */

import { useEffect, useMemo, useState } from "react";

import {
  queryEvents,
  type NostrEvent,
  type NostrFilter,
} from "@/shared/lib/nostr-client";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { subscribeChannel } from "@/features/channels/subscribe-channel";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { KIND_AGENT_CAPABILITIES } from "@/shared/constants/kinds";

import {
  indexRoster,
  parseAnnouncement,
  rosterKey,
  type RosterEntry,
} from "./lib/index-roster";

export type AgentRuntype = "browser" | "desktop" | "sandbox";
export type AgentStatus = "available" | "busy" | "offline";

export interface AgentCapabilities {
  /** The `d` tag (an agent's stable id), or the author pubkey when absent. */
  id: string;
  /** Author of the announcement — the identity that owns this entry. */
  pubkey: string;
  name: string;
  runtype: AgentRuntype;
  status: AgentStatus;
  tools: string[];
  team: string | null;
  heartbeat: number;
  updatedAt: number;
  alive: boolean;
}

const LIVENESS_WINDOW_MS = 180_000;

const RUNTYPES: readonly string[] = ["browser", "desktop", "sandbox"];
const STATUSES: readonly string[] = ["available", "busy", "offline"];

/** Narrow parsed fields and derive liveness at read time. */
function toCapabilities(entry: RosterEntry): AgentCapabilities {
  return {
    id: entry.id,
    pubkey: entry.pubkey,
    name: entry.name || truncatePubkey(entry.pubkey),
    runtype: RUNTYPES.includes(entry.runtype)
      ? (entry.runtype as AgentRuntype)
      : "sandbox",
    status: STATUSES.includes(entry.status)
      ? (entry.status as AgentStatus)
      : "available",
    tools: entry.tools,
    team: entry.team,
    heartbeat: entry.heartbeat,
    updatedAt: entry.updatedAt,
    alive: Date.now() - entry.heartbeat < LIVENESS_WINDOW_MS,
  };
}

export function useAgentRoster(): {
  agents: AgentCapabilities[];
  loading: boolean;
  /** Set when the relay read failed; the view shows a retry, not "no agents". */
  loadError: unknown;
} {
  const [agents, setAgents] = useState<Record<string, AgentCapabilities>>({});
  const [loading, setLoading] = useState(true);
  /** Kept so the fleet view can report a failed read instead of "no agents". */
  const [loadError, setLoadError] = useState<unknown>(null);

  useEffect(() => {
    const wsUrl = relayWsUrl();
    // Heartbeat rows flood history (one per agent per minute), so pull a wide
    // window and keep newest-per-identity client-side. Identities are
    // author-qualified: keying on the `d` tag alone let one member's
    // announcement take over another agent's directory entry.
    const filter: NostrFilter = {
      kinds: [KIND_AGENT_CAPABILITIES],
      limit: 1000,
    };
    let disposed = false;

    const upsert = (event: NostrEvent) => {
      const parsed = parseAnnouncement(event);
      if (!parsed) return;
      const key = rosterKey(parsed.pubkey, parsed.id);
      setAgents((prev) => {
        const existing = prev[key];
        if (existing && existing.updatedAt >= parsed.updatedAt) return prev;
        return { ...prev, [key]: toCapabilities(parsed) };
      });
    };

    void queryEvents(wsUrl, filter)
      .then((events) => {
        if (disposed) return;
        setAgents((prev) => {
          const next = { ...prev };
          for (const [key, entry] of Object.entries(indexRoster(events))) {
            const existing = next[key];
            if (existing && existing.updatedAt >= entry.updatedAt) continue;
            next[key] = toCapabilities(entry);
          }
          return next;
        });
        setLoadError(null);
        setLoading(false);
      })
      .catch((error: unknown) => {
        console.warn("[fleet] roster load failed", error);
        if (!disposed) {
          setLoadError(error);
          setLoading(false);
        }
      });

    const unsubscribe = subscribeChannel(
      wsUrl,
      { kinds: [KIND_AGENT_CAPABILITIES] },
      { onEvent: (event) => upsert(event) },
    );

    // Liveness decays with the heartbeat, so re-derive it on a timer.
    const livenessTimer = setInterval(() => {
      setAgents((prev) => {
        const now = Date.now();
        let changed = false;
        const next: Record<string, AgentCapabilities> = {};
        for (const [key, agent] of Object.entries(prev)) {
          const alive = now - agent.heartbeat < LIVENESS_WINDOW_MS;
          if (alive !== agent.alive) changed = true;
          next[key] = { ...agent, alive };
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

  return { agents: sorted, loading, loadError };
}
