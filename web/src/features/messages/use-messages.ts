import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getDirectMessageSigner } from "@/shared/lib/nostr-signer";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { fetchEvents, fetchLatest, isFeedPreview } from "../feed/use-feed";
import { publishEvent, submitSignedEvent } from "../feed/publish-event";
import {
  type DirectMessage,
  KIND_DM_RELAY_LIST,
  KIND_GIFT_WRAP,
  createDirectMessageWraps,
  groupConversations,
  openGiftWrap,
} from "./nip17";
import { mockMessages } from "./mock-messages";

const WRAP_FETCH_LIMIT = 500;
const DECRYPT_CONCURRENCY = 4;

/** Decrypted wraps by id (null = not a 1:1 DM) so refreshes only open new ones. */
const opened = new Map<string, DirectMessage | null>();

async function mapLimited<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index]);
      }
    }),
  );
  return results;
}

const messagesKey = (viewer: string | null) => ["feed", "dms", viewer];

/** NIP-17 messages for the viewer, decrypted in the browser with their signer. */
export function useDirectMessages(viewer: string | null) {
  return useQuery({
    queryKey: messagesKey(viewer),
    enabled: viewer !== null,
    staleTime: 10_000,
    refetchInterval: 20_000,
    queryFn: async (): Promise<DirectMessage[]> => {
      if (!viewer) return [];
      if (isFeedPreview()) return mockMessages(viewer);
      const signer = await getDirectMessageSigner();
      const wraps = await fetchEvents({
        kinds: [KIND_GIFT_WRAP],
        "#p": [viewer],
        limit: WRAP_FETCH_LIMIT,
      });
      const fresh = wraps.filter((w) => !opened.has(w.id));
      await mapLimited(fresh, DECRYPT_CONCURRENCY, async (wrap) => {
        opened.set(wrap.id, await openGiftWrap(signer, wrap));
      });
      return wraps.flatMap((w) => opened.get(w.id) ?? []);
    },
    select: groupConversations,
  });
}

/** Send a 1:1 message: one wrap to the recipient and one to ourselves. */
export function useSendDirectMessage(viewer: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      peer,
      content,
    }: {
      peer: string;
      content: string;
    }) => {
      if (isFeedPreview()) throw new Error("Messaging is disabled in preview.");
      const signer = await getDirectMessageSigner();
      const { toRecipient, toSelf, rumorId } = await createDirectMessageWraps(
        signer,
        peer,
        content,
      );
      await Promise.all([
        submitSignedEvent(toRecipient),
        submitSignedEvent(toSelf),
      ]);
      return { rumorId, wrapId: toSelf.id };
    },
    onMutate: async ({ peer, content }) => {
      if (!viewer) return;
      await queryClient.cancelQueries({ queryKey: messagesKey(viewer) });
      const stamp = `pending-${Date.now()}`;
      const optimistic: DirectMessage = {
        id: stamp,
        wrapId: stamp,
        from: viewer,
        peer,
        content,
        at: Math.floor(Date.now() / 1000),
      };
      queryClient.setQueryData<DirectMessage[]>(messagesKey(viewer), (old) => [
        ...(old ?? []),
        optimistic,
      ]);
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: messagesKey(viewer) }),
  });
}

/** Whether the viewer has published a NIP-17 DM relay list (kind 10050). */
export function useDmRelayList(viewer: string | null) {
  return useQuery({
    queryKey: ["feed", "dm-relay-list", viewer],
    enabled: viewer !== null,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      if (!viewer || isFeedPreview()) return true;
      return (await fetchLatest(KIND_DM_RELAY_LIST, viewer)) !== null;
    },
  });
}

/** Tell other Nostr apps (NIP-17 clients) to deliver DMs to this relay. */
export function usePublishDmRelayList() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      publishEvent({
        kind: KIND_DM_RELAY_LIST,
        content: "",
        tags: [["relay", relayWsUrl()]],
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["feed", "dm-relay-list"] }),
  });
}
