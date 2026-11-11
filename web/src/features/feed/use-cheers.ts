import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { KIND_REACTION } from "@/shared/constants/kinds";
import { existingUserPubkey } from "@/shared/lib/identity";
import { queryEvents } from "@/shared/lib/nostr-client";
import { relayWsUrl } from "@/shared/lib/relay-url";

import { CHEER_READ, CHEER_TARGETS, cheerers } from "./lib/cheers";
import { buildVote } from "./lib/feed-events";
import { publishFeedEvent } from "./use-feed";

/**
 * The cheers on the records a feed shows: who cheered each, read in one bounded read, and a way to add one's own.
 * `cut` says the read was full, so a count may be short (it is then shown as "at least"). A cheer shows at once and
 * stays if the send goes through; if it does not, it is taken back and the failure is the caller's to say.
 */
export function useCheers(ids: readonly string[]) {
  const me = existingUserPubkey();
  const relay = relayWsUrl();
  const queryClient = useQueryClient();
  const asked = useMemo(
    () => [...new Set(ids)].sort().slice(0, CHEER_TARGETS),
    [ids],
  );
  const key = ["feed", "reactions", "cheers", relay, asked];
  const read = useQuery({
    queryKey: key,
    enabled: asked.length > 0,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const events = await queryEvents(relay, {
        kinds: [KIND_REACTION],
        "#e": asked,
        limit: CHEER_READ,
      });
      return { events, cut: events.length >= CHEER_READ };
    },
  });
  const by = useMemo(
    () => cheerers(read.data?.events ?? [], asked),
    [read.data, asked],
  );
  const cheer = useMutation({
    mutationFn: (target: { id: string; pubkey: string; kind: number }) =>
      publishFeedEvent(
        buildVote({
          target: { ...target, created_at: 0, tags: [], content: "" },
          direction: "+",
        }),
      ),
    onSuccess: (event) => {
      // Shown at once from what was just sent: the server can take a moment to show it back.
      queryClient.setQueryData<typeof read.data>(key, (was) =>
        was
          ? { ...was, events: [...was.events, event] }
          : { events: [event], cut: false },
      );
    },
  });
  return {
    count: (id: string) => by.get(id)?.size ?? 0,
    mine: (id: string) => Boolean(me && by.get(id)?.has(me)),
    /** The counts could not be read at all. */
    failed: read.isError && !read.data,
    cut: read.data?.cut ?? false,
    cheer,
  };
}
