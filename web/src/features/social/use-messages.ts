import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { KIND_DM_RELAY_LIST, KIND_GIFT_WRAP } from "@/shared/constants/kinds";
import {
  existingUserPubkey,
  nip44DecryptAsUser,
  nip44EncryptAsUser,
  signAsUser,
} from "@/shared/lib/identity";
import { publishEvent } from "@/shared/lib/publish-event";
import { relayWsUrl } from "@/shared/lib/relay-url";

import { publishFeedEvent } from "../feed/use-feed";
import { MIRROR_TIMEOUT_MS, withTimeout } from "../feed/lib/mirror";
import {
  createDirectMessageWraps,
  type DirectMessage,
  type DmSigner,
  dmRelays,
  groupConversations,
  openGiftWrap,
} from "./lib/nip17";
import type { SignedEvent } from "./lib/timeline";
import { readEvents, readLatest } from "./read";
import { socialKeys } from "./use-social-data";

const WRAP_FETCH_LIMIT = 500;
const DECRYPT_CONCURRENCY = 4;

/** The durable identity as a DM signer — passkey, extension or stored key. */
function userDmSigner(me: string): DmSigner {
  return {
    pubkey: me,
    sign: (template) => signAsUser(template) as Promise<SignedEvent>,
    encrypt: nip44EncryptAsUser,
    decrypt: nip44DecryptAsUser,
  };
}

/** Wraps already opened, by id (null = not a 1:1 message), so a refresh opens only new ones. */
const opened = new Map<string, DirectMessage | null>();

async function mapLimited<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}

const messagesKey = (me: string | null) => [...socialKeys.all, "dms", me];

/** Your NIP-17 conversations, opened in this browser with your key. */
export function useConversations() {
  const me = existingUserPubkey();
  return useQuery({
    queryKey: messagesKey(me),
    enabled: Boolean(me),
    staleTime: 10_000,
    refetchInterval: 20_000,
    queryFn: async (): Promise<DirectMessage[]> => {
      const self = me as string;
      const signer = userDmSigner(self);
      const wraps = (await readEvents({
        kinds: [KIND_GIFT_WRAP],
        "#p": [self],
        limit: WRAP_FETCH_LIMIT,
      })) as SignedEvent[];
      await mapLimited(
        wraps.filter((w) => !opened.has(w.id)),
        DECRYPT_CONCURRENCY,
        async (wrap) => {
          opened.set(wrap.id, await openGiftWrap(signer, wrap));
        },
      );
      return wraps.flatMap((w) => opened.get(w.id) ?? []);
    },
    select: groupConversations,
  });
}

/**
 * Send a message: one wrap to the recipient and one to yourself on this relay,
 * plus the recipient's own DM relays (kind 10050) so apps like 0xchat that
 * listen elsewhere still receive it. Those extra copies are best-effort.
 */
export function useSendMessage() {
  const queryClient = useQueryClient();
  const me = existingUserPubkey();
  return useMutation({
    mutationFn: async ({
      peer,
      content,
    }: {
      peer: string;
      content: string;
    }) => {
      if (!me) throw new Error("Sign in to send messages.");
      const { toRecipient, toSelf } = await createDirectMessageWraps(
        userDmSigner(me),
        peer,
        content,
      );
      const community = relayWsUrl();
      const ok = (r: { accepted: boolean; message?: string }) => {
        if (!r.accepted)
          throw new Error(r.message ?? "The server refused this message.");
      };
      ok(await publishEvent(community, toRecipient, { signAuth: signAsUser }));
      ok(await publishEvent(community, toSelf, { signAuth: signAsUser }));

      const theirRelays = dmRelays(
        await readLatest(KIND_DM_RELAY_LIST, peer).catch(() => null),
      ).filter((r) => r.replace(/\/+$/, "") !== community.replace(/\/+$/, ""));
      await Promise.all(
        theirRelays.map((relay) =>
          withTimeout(
            publishEvent(relay, toRecipient, { signAuth: signAsUser }),
            MIRROR_TIMEOUT_MS,
            `deliver to ${relay}`,
          ).catch((error) => {
            console.info("[social] dm delivery skipped", relay, String(error));
          }),
        ),
      );
    },
    onMutate: async ({ peer, content }) => {
      if (!me) return;
      await queryClient.cancelQueries({ queryKey: messagesKey(me) });
      const stamp = `pending-${Date.now()}`;
      queryClient.setQueryData<DirectMessage[]>(messagesKey(me), (old) => [
        ...(old ?? []),
        {
          id: stamp,
          wrapId: stamp,
          from: me,
          peer,
          content,
          at: Math.floor(Date.now() / 1000),
        },
      ]);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: messagesKey(me) });
    },
  });
}

/** Whether you have published a DM relay list saying you receive DMs here. */
export function useHasDmRelayList() {
  const me = existingUserPubkey();
  return useQuery({
    queryKey: [...socialKeys.lists, "dm-relays", me],
    enabled: Boolean(me),
    staleTime: 5 * 60_000,
    queryFn: async () =>
      (await readLatest(KIND_DM_RELAY_LIST, me as string)) !== null,
  });
}

/** Publish a kind 10050 naming this relay so other NIP-17 apps deliver here. */
export function usePublishDmRelayList() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      publishFeedEvent({
        kind: KIND_DM_RELAY_LIST,
        tags: [["relay", relayWsUrl()]],
        content: "",
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: [...socialKeys.lists, "dm-relays"],
      });
    },
  });
}
