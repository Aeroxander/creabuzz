/**
 * Presence: who is here.
 *
 * Outgoing: a kind:20001 heartbeat ("online" / "away") every 60 seconds while
 * the page is visible — the relay-side TTL (three heartbeat windows) is what
 * clears a crashed client, so there is no "offline" publish to miss.
 * Incoming: one author-scoped live subscription for the visible member set.
 *
 * Presence is an ephemeral relay feature. When the relay lacks it the
 * subscriptions simply deliver nothing: no errors, no visible UI.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import { publishEvent } from "@/shared/lib/publish-event";
import { existingUserPubkey, signAsUser } from "@/shared/lib/identity";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { subscribeChannel } from "@/features/channels/subscribe-channel";
import {
  parseLivePresenceEvent,
  PRESENCE_HEARTBEAT_INTERVAL_MS,
  PRESENCE_IDLE_TIMEOUT_MS,
  PRESENCE_MAX_TRACKED,
  PRESENCE_PRUNE_INTERVAL_MS,
  PRESENCE_TTL_MS,
  prunePresenceState,
  type PresenceState,
  type PresenceStatus,
  resolveAutomaticPresenceStatus,
} from "./lib/presence";

export const KIND_PRESENCE_UPDATE = 20001;

const PRESENCE_ACTIVITY_THROTTLE_MS = 1_000;

function publishPresence(status: PresenceStatus) {
  // Only announce a viewer who already has an identity. `existingUserPubkey`
  // never creates one — a read-only visitor must not be handed a permanent
  // key (and broadcast online) just for opening a page. Anonymous visitors
  // stay invisible; there is no minting on the presence path.
  if (existingUserPubkey() === null) return;
  Promise.resolve()
    .then(() =>
      signAsUser({ kind: KIND_PRESENCE_UPDATE, tags: [], content: status }),
    )
    .then((signed) =>
      publishEvent(relayWsUrl(), signed, { signAuth: signAsUser }),
    )
    .catch(() => {
      // Presence is best-effort: a locked identity or an unsupported relay
      // degrade to "no presence", which is what the indicators already show.
    });
}

function normalizePubkeys(pubkeys: readonly string[]): string[] {
  return [...new Set(pubkeys.map((pubkey) => pubkey.trim().toLowerCase()))]
    .filter(Boolean)
    .sort()
    .slice(0, PRESENCE_MAX_TRACKED);
}

/**
 * Heartbeat for the viewer: publishes status on mount and every
 * PRESENCE_HEARTBEAT_INTERVAL_MS while the page is visible, going "away"
 * after PRESENCE_IDLE_TIMEOUT_MS without input. Pause-on-hidden keeps an
 * idle background tab from broadcasting presence forever.
 */
export function usePresenceHeartbeat(): void {
  const lastActivityRef = useRef(Date.now());

  useEffect(() => {
    const noteActivity = () => {
      const now = Date.now();
      if (now - lastActivityRef.current >= PRESENCE_ACTIVITY_THROTTLE_MS) {
        lastActivityRef.current = now;
      }
    };
    const tick = () => {
      if (document.visibilityState === "hidden") return;
      publishPresence(
        resolveAutomaticPresenceStatus(
          null,
          lastActivityRef.current,
          Date.now(),
        ),
      );
    };

    window.addEventListener("pointerdown", noteActivity);
    window.addEventListener("keydown", noteActivity);
    tick();
    const interval = window.setInterval(tick, PRESENCE_HEARTBEAT_INTERVAL_MS);
    return () => {
      window.removeEventListener("pointerdown", noteActivity);
      window.removeEventListener("keydown", noteActivity);
      window.clearInterval(interval);
    };
  }, []);
}

/**
 * Live presence for a bounded author set. Returns statuses keyed by lowercase
 * pubkey (reference-stable while nothing changes); expired observations drop
 * out on the prune tick. Never throws and never polls when idle.
 */
export function usePresence(
  memberPubkeys: readonly string[],
): Record<string, PresenceStatus> {
  const [presence, setPresence] = useState<PresenceState>({});
  const generationRef = useRef(0);
  // The key is a string so fresh array identities from callers cannot resubscribe.
  const authorsKey = normalizePubkeys(memberPubkeys).join(",");

  useEffect(() => {
    if (!authorsKey) return;
    generationRef.current += 1;
    const generation = generationRef.current;
    setPresence({});
    const authors = authorsKey.split(",");
    const requested = new Set(authors);

    const unsubscribe = subscribeChannel(
      relayWsUrl(),
      { kinds: [KIND_PRESENCE_UPDATE], authors, limit: 0 },
      {
        onEvent: (event) => {
          // Fence by generation: a stale subscription's batch must never
          // resurrect the previous member set's state.
          if (generationRef.current !== generation) return;
          const parsed = parseLivePresenceEvent(event);
          if (!parsed || !requested.has(parsed.pubkey)) return;
          setPresence((current) => {
            const now = Date.now();
            const pruned = prunePresenceState(current, now);
            return {
              ...pruned,
              [parsed.pubkey]: {
                status: parsed.status,
                expiresAt: event.created_at * 1_000 + PRESENCE_TTL_MS,
              },
            };
          });
        },
      },
    );
    return () => {
      generationRef.current += 1;
      unsubscribe();
    };
  }, [authorsKey]);

  const hasEntries = Object.keys(presence).length > 0;
  useEffect(() => {
    if (!hasEntries) return;
    const interval = window.setInterval(() => {
      setPresence((current) => prunePresenceState(current, Date.now()));
    }, PRESENCE_PRUNE_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [hasEntries]);

  return useMemo(() => {
    const statuses: Record<string, PresenceStatus> = {};
    for (const [pubkey, entry] of Object.entries(presence)) {
      statuses[pubkey] = entry.status;
    }
    return statuses;
  }, [presence]);
}

export { PRESENCE_IDLE_TIMEOUT_MS };
