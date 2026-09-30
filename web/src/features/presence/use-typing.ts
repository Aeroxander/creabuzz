/**
 * Typing indicators for the shared channel composer.
 *
 * Outgoing: throttled kind:20002 broadcasts while the draft changes — never
 * per keystroke. Incoming: one live subscription per mounted composer, TTL
 * pruned, generation-fenced so a stale batch can never resurrect old state
 * after a channel switch. Everything is ephemeral: nothing here triggers a
 * reconnect on its own and every failure is swallowed (typing is a hint).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { publishEvent } from "@/shared/lib/publish-event";
import { signAsUser, userPubkey } from "@/shared/lib/identity";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { subscribeChannel } from "@/features/channels/subscribe-channel";
import {
  createTypingThrottle,
  KIND_TYPING_INDICATOR,
  parseTypingEvent,
  pruneTypingState,
  TYPING_INDICATOR_TTL_MS,
  TYPING_PRUNE_INTERVAL_MS,
  TYPING_SEND_INTERVAL_MS,
  typingStateKey,
  type TypingEntry,
  type TypingState,
} from "./lib/typing";

function selfPubkey(): string | null {
  try {
    return userPubkey().toLowerCase();
  } catch {
    return null;
  }
}

function buildTypingTags(channelId: string, replyTo: string | null) {
  const tags: string[][] = [["h", channelId]];
  if (replyTo) tags.push(["e", replyTo]);
  return tags;
}

/**
 * Returns `notifyTyping()`, to be called whenever the draft changes. Sends at
 * most one typing event per 3 seconds per channel; silent when untyped
 * identities cannot sign.
 */
export function useTypingBroadcast(
  channelId: string | null,
  replyTo?: string | null,
): () => void {
  const throttleRef = useRef(createTypingThrottle(TYPING_SEND_INTERVAL_MS));
  const channelIdRef = useRef(channelId);
  const replyToRef = useRef(replyTo ?? null);
  const lastChannelRef = useRef(channelId);
  channelIdRef.current = channelId;
  replyToRef.current = replyTo ?? null;

  const notifyTyping = useCallback(() => {
    const id = channelIdRef.current;
    if (!id) return;
    if (lastChannelRef.current !== id) {
      lastChannelRef.current = id;
      throttleRef.current.reset();
    }
    if (!throttleRef.current.shouldSend()) return;

    const tags = buildTypingTags(id, replyToRef.current);
    Promise.resolve()
      .then(() =>
        signAsUser({ kind: KIND_TYPING_INDICATOR, tags, content: "" }),
      )
      .then((signed) =>
        publishEvent(relayWsUrl(), signed, { signAuth: signAsUser }),
      )
      .catch(() => {
        // Typing is best-effort: no identity, no connection, or a relay that
        // rejects the event all degrade to "no typing indicator".
      });
  }, []);

  return notifyTyping;
}

/**
 * Live typers in one channel (excluding the viewer), newest-typer first by
 * first-seen order. Entries expire on their own TTL; the returned array is
 * reference-stable while nothing changes.
 */
export function useChannelTyping(channelId: string | null): TypingEntry[] {
  const [typing, setTyping] = useState<TypingState>({});
  const generationRef = useRef(0);

  useEffect(() => {
    if (!channelId) return;
    generationRef.current += 1;
    const generation = generationRef.current;
    setTyping({});

    const me = selfPubkey();
    const unsubscribe = subscribeChannel(
      relayWsUrl(),
      {
        kinds: [KIND_TYPING_INDICATOR],
        "#h": [channelId],
        limit: 20,
        since: Math.floor(Date.now() / 1_000) - 10,
      },
      {
        onEvent: (event) => {
          // Fence by generation: an event from a previous channel's
          // subscription must never write into the new channel's state.
          if (generationRef.current !== generation) return;
          const parsed = parseTypingEvent(event, {
            channelId,
            selfPubkey: me,
            now: Date.now(),
          });
          if (!parsed) return;
          setTyping((current) => {
            const now = Date.now();
            const pruned = pruneTypingState(current, now);
            const key = typingStateKey(parsed.pubkey, parsed.threadHeadId);
            const existing = pruned[key];
            return {
              ...pruned,
              [key]: {
                pubkey: parsed.pubkey,
                threadHeadId: parsed.threadHeadId,
                firstSeenAt: existing?.firstSeenAt ?? now,
                expiresAt: Math.min(
                  now + TYPING_INDICATOR_TTL_MS,
                  event.created_at * 1_000 + TYPING_INDICATOR_TTL_MS,
                ),
              },
            };
          });
        },
      },
    );
    return () => {
      // Invalidate the generation first so in-flight events are dropped.
      generationRef.current += 1;
      unsubscribe();
    };
  }, [channelId]);

  const hasTypers = Object.keys(typing).length > 0;
  useEffect(() => {
    if (!hasTypers) return;
    const interval = window.setInterval(() => {
      setTyping((current) => pruneTypingState(current, Date.now()));
    }, TYPING_PRUNE_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [hasTypers]);

  return useMemo(
    () => Object.values(typing).sort((a, b) => a.firstSeenAt - b.firstSeenAt),
    [typing],
  );
}
