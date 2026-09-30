import { useEffect, useState } from "react";

import {
  queryEvents,
  type NostrEvent,
  type NostrFilter,
} from "@/shared/lib/nostr-client";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { subscribeChannel } from "@/features/channels/subscribe-channel";
import { KIND_ORG_NODE } from "@/shared/constants/kinds";

import {
  indexOrgNodes,
  buildOrgTree,
  orgNodeKey,
  type OrgNodeEntry,
  type OrgNodeEvent,
  type OrgTreeNode,
} from "./lib/index-org";

/**
 * Org-chart read hook (NIP-ORG `37010` org nodes, read-only).
 *
 * Mirrors `use-agent-roster`: pulls a wide window of node events (explicit
 * kinds for the relay's p-gate), keeps newest-per-(author, d) client-side via
 * `indexOrgNodes`, and assembles the forest with `buildOrgTree`. A failing
 * load leaves whatever was already there in place — an org chart that
 * disappears on a transient error is worse than a stale one.
 *
 * Each stored index entry remembers its source event, so the live
 * subscription re-indexes real wire events (not lossy projections) and the
 * merge stays exactly newest-per-(author, d).
 *
 * The org is a community-level object (like a project or a launch record),
 * so the read is scoped by `kinds` alone — no channel filter.
 */
export function useOrgChart(): {
  forest: OrgTreeNode[];
  byKey: Record<string, OrgNodeEntry>;
  loading: boolean;
  loadError: unknown;
} {
  const [eventsByKey, setEventsByKey] = useState<Record<string, OrgNodeEvent>>(
    {},
  );
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);

  useEffect(() => {
    setLoading(true);
    const wsUrl = relayWsUrl();
    const filter: NostrFilter = {
      kinds: [KIND_ORG_NODE],
      limit: 1000,
    };
    let disposed = false;

    // The index walks from the stored events, not the hook. Every upsert
    // stores the newest wire event per (author, d) individually, so the
    // merge needs no projection and loses nothing.
    const upsert = (event: NostrEvent) => {
      if (event.kind !== KIND_ORG_NODE) return;
      const wire = event as unknown as OrgNodeEvent;
      const d = wire.tags.find((t) => t[0] === "d")?.[1];
      if (!d) return;
      const key = orgNodeKey(wire.pubkey, d);
      setEventsByKey((prev) => {
        const existing = prev[key];
        if (existing && existing.created_at >= wire.created_at) return prev;
        return { ...prev, [key]: wire };
      });
    };

    void queryEvents(wsUrl, filter)
      .then((events) => {
        if (disposed) return;
        setEventsByKey((prev) => {
          const next = { ...prev };
          for (const event of events) {
            if (event.kind !== KIND_ORG_NODE) continue;
            const wire = event as unknown as OrgNodeEvent;
            const d = wire.tags.find((t) => t[0] === "d")?.[1];
            if (!d) continue;
            const key = orgNodeKey(wire.pubkey, d);
            const existing = next[key];
            if (existing && existing.created_at >= wire.created_at) continue;
            next[key] = wire;
          }
          return next;
        });
        setLoadError(null);
        setLoading(false);
      })
      .catch((error: unknown) => {
        console.warn("[fleet] org chart load failed", error);
        if (!disposed) {
          setLoadError(error);
          setLoading(false);
        }
      });

    const unsubscribe = subscribeChannel(
      wsUrl,
      { kinds: [KIND_ORG_NODE] },
      { onEvent: upsert },
    );

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  // Derive the forest from stored events each render; the index and the tree
  // are pure functions of the events, so no derived state can go stale.
  const byKey = indexOrgNodes(Object.values(eventsByKey));
  return { forest: buildOrgTree(byKey), byKey, loading, loadError };
}

export { orgNodeKey };
export type { OrgNodeEntry, OrgTreeNode };
