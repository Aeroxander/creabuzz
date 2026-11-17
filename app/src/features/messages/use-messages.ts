import { KIND_DM_RELAY_LIST } from "@creaton/core/kinds.ts";
import {
  nip44DecryptAsUser,
  nip44EncryptAsUser,
  signAsUser,
} from "@creaton/core/client/identity.ts";
import { isSigningBlockedError } from "@creaton/core/client/nostr-signer.ts";
import { publishEvent } from "@creaton/core/client/publish-event.ts";
import { relayWsUrl } from "@creaton/core/client/relay-url.ts";
import { readInboxWraps } from "@creaton/core/social/inbox-read.ts";
import {
  createDirectMessageWraps,
  type DirectMessage,
  type DmSigner,
  dmRelays,
  groupConversations,
  openGiftWrap,
} from "@creaton/core/social/nip17.ts";
import type { SignedEvent } from "@creaton/core/social/timeline.ts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAccount } from "../../lib/account";
import { read, readLatest } from "../../lib/relay";

export type { DirectMessage };

const DECRYPT_CONCURRENCY = 4;
/** How long a copy to the other person's own message servers may take before it is given up (best effort). */
const EXTRA_DELIVERY_MS = 6_000;

/** The durable identity as a message signer: passkey or stored key. */
function userDmSigner(me: string): DmSigner {
  return {
    pubkey: me,
    sign: (template) => signAsUser(template) as Promise<SignedEvent>,
    encrypt: nip44EncryptAsUser,
    decrypt: nip44DecryptAsUser,
  };
}

/** Wraps already opened, by id (null = not a one-to-one message), so a refresh opens only new ones. Bounded below. */
const opened = new Map<string, DirectMessage | null>();
const MAX_OPENED = 2_000;

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

const messageKeys = { mine: (me: string | null) => ["messages", me] as const };

/**
 * The person's private conversations (NIP-17, as web/ reads them), opened in this browser with their key. Read every
 * five seconds while a conversation is on screen, every twenty elsewhere, never while the app is hidden.
 */
export function useConversations({ open = false }: { open?: boolean } = {}) {
  const { pubkey, locked } = useAccount();
  return useQuery({
    queryKey: messageKeys.mine(pubkey),
    enabled: pubkey !== null && !locked,
    staleTime: 10_000,
    refetchInterval: open ? 5_000 : 20_000,
    refetchIntervalInBackground: false,
    queryFn: async (): Promise<DirectMessage[]> => {
      const self = pubkey as string;
      const base = userDmSigner(self);
      let blocked: unknown = null;
      const signer: DmSigner = {
        ...base,
        decrypt: async (peer, text) => {
          try {
            return await base.decrypt(peer, text);
          } catch (error) {
            if (isSigningBlockedError(error)) blocked = error;
            throw error;
          }
        },
      };
      const wraps = await readInboxWraps(
        `${relayWsUrl()}|${self}`,
        self,
        (filter) => read(filter) as Promise<SignedEvent[]>,
      );
      await mapLimited(
        wraps.filter((w) => !opened.has(w.id)),
        DECRYPT_CONCURRENCY,
        async (wrap) => {
          if (blocked) return;
          const message = await openGiftWrap(signer, wrap);
          if (!blocked) opened.set(wrap.id, message);
        },
      );
      if (blocked) throw blocked;
      while (opened.size > MAX_OPENED) {
        const oldest = opened.keys().next().value;
        if (oldest === undefined) break;
        opened.delete(oldest);
      }
      return wraps.flatMap((w) => opened.get(w.id) ?? []);
    },
    select: groupConversations,
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Send a message: one sealed copy to the other person and one to yourself on this server, plus the other person's own
 * message servers (kind 10050) so other apps they use still receive it. Those extra copies are best effort.
 */
export function useSendMessage() {
  const queryClient = useQueryClient();
  const { pubkey } = useAccount();
  return useMutation({
    mutationFn: async ({
      peer,
      content,
    }: {
      peer: string;
      content: string;
    }) => {
      if (!pubkey) throw new Error("Sign in to send messages.");
      const { toRecipient, toSelf } = await createDirectMessageWraps(
        userDmSigner(pubkey),
        peer,
        content,
      );
      const community = relayWsUrl();
      const ok = (r: { accepted: boolean; message?: string }) => {
        if (!r.accepted)
          throw new Error(
            r.message ?? "The server did not accept this message. Try again.",
          );
      };
      ok(await publishEvent(community, toRecipient, { signAuth: signAsUser }));
      ok(await publishEvent(community, toSelf, { signAuth: signAsUser }));
      const theirs = dmRelays(
        await readLatest(KIND_DM_RELAY_LIST, peer).catch(() => null),
      ).filter((r) => r.replace(/\/+$/, "") !== community.replace(/\/+$/, ""));
      await Promise.all(
        theirs.map((relay) =>
          withTimeout(
            publishEvent(relay, toRecipient, { signAuth: signAsUser }),
            EXTRA_DELIVERY_MS,
          ).catch(() => undefined),
        ),
      );
    },
    onMutate: async ({ peer, content }) => {
      if (!pubkey) return;
      await queryClient.cancelQueries({ queryKey: messageKeys.mine(pubkey) });
      const stamp = `pending-${Date.now()}`;
      queryClient.setQueryData<DirectMessage[]>(
        messageKeys.mine(pubkey),
        (old) => [
          ...(old ?? []),
          {
            id: stamp,
            wrapId: stamp,
            from: pubkey,
            peer,
            content,
            at: Math.floor(Date.now() / 1000),
          },
        ],
      );
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: messageKeys.mine(pubkey) }),
  });
}
