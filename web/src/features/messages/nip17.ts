import { createWrap } from "nostr-tools/nip59";
import { getEventHash, verifyEvent } from "nostr-tools/pure";

import type { NostrEvent } from "@/shared/lib/nostr-client";
import type { DirectMessageSigner } from "@/shared/lib/nostr-signer";

export const KIND_SEAL = 13;
export const KIND_DIRECT_MESSAGE = 14;
export const KIND_GIFT_WRAP = 1059;
export const KIND_DM_RELAY_LIST = 10050;

/** NIP-59 randomizes seal/wrap timestamps up to two days in the past. */
const MAX_TIMESTAMP_JITTER_SECONDS = 2 * 24 * 60 * 60;

export interface DirectMessage {
  /** Id of the inner kind 14 rumor. */
  id: string;
  wrapId: string;
  from: string;
  /** The other participant (never the viewer). */
  peer: string;
  content: string;
  at: number;
}

export interface Conversation {
  peer: string;
  messages: DirectMessage[];
  last: DirectMessage;
}

const randomPast = (now: number) =>
  now - Math.floor(Math.random() * MAX_TIMESTAMP_JITTER_SECONDS);

/**
 * NIP-17: build the gift wraps for one 1:1 message — one addressed to the
 * recipient and one to the sender, so the sender's other devices see it too.
 */
export async function createDirectMessageWraps(
  signer: DirectMessageSigner,
  recipient: string,
  content: string,
  now = Math.floor(Date.now() / 1000),
): Promise<{ toRecipient: NostrEvent; toSelf: NostrEvent; rumorId: string }> {
  const rumor = {
    kind: KIND_DIRECT_MESSAGE,
    created_at: now,
    tags: [["p", recipient]],
    content,
    pubkey: signer.pubkey,
  };
  const rumorId = getEventHash(rumor);
  const rumorJson = JSON.stringify({ ...rumor, id: rumorId });

  const wrapFor = async (target: string) => {
    const seal = await signer.signEvent({
      kind: KIND_SEAL,
      created_at: randomPast(now),
      tags: [],
      content: await signer.nip44Encrypt(target, rumorJson),
    });
    return createWrap(seal, target);
  };

  const [toRecipient, toSelf] = await Promise.all([
    wrapFor(recipient),
    wrapFor(signer.pubkey),
  ]);
  return { toRecipient, toSelf, rumorId };
}

/**
 * Open a gift wrap addressed to the signer. Returns null for anything that is
 * not an authentic 1:1 direct message (group DMs, forged senders, other kinds).
 */
export async function openGiftWrap(
  signer: DirectMessageSigner,
  wrap: NostrEvent,
): Promise<DirectMessage | null> {
  if (wrap.kind !== KIND_GIFT_WRAP) return null;
  try {
    const seal = JSON.parse(
      await signer.nip44Decrypt(wrap.pubkey, wrap.content),
    ) as NostrEvent;
    if (seal.kind !== KIND_SEAL || !verifyEvent(seal)) return null;

    const rumor = JSON.parse(
      await signer.nip44Decrypt(seal.pubkey, seal.content),
    ) as NostrEvent;
    // The sender claimed in the rumor must be the one who signed the seal.
    if (rumor.kind !== KIND_DIRECT_MESSAGE || rumor.pubkey !== seal.pubkey) {
      return null;
    }
    if (typeof rumor.content !== "string" || getEventHash(rumor) !== rumor.id) {
      return null;
    }

    const recipients = rumor.tags
      .filter((t) => t[0] === "p" && t[1])
      .map((t) => t[1]);
    const others = [...new Set(recipients)].filter((p) => p !== rumor.pubkey);
    const sentByMe = rumor.pubkey === signer.pubkey;

    // Only 1:1 conversations: a sent message has exactly one other participant;
    // a received one is addressed to exactly us.
    if (
      sentByMe
        ? others.length !== 1
        : others.length !== 1 || others[0] !== signer.pubkey
    ) {
      return null;
    }
    return {
      id: rumor.id,
      wrapId: wrap.id,
      from: rumor.pubkey,
      peer: sentByMe ? others[0] : rumor.pubkey,
      content: rumor.content,
      at: rumor.created_at,
    };
  } catch {
    return null;
  }
}

/** Group messages (de-duplicated by rumor id) into conversations, most recent first. */
export function groupConversations(messages: DirectMessage[]): Conversation[] {
  const byPeer = new Map<string, Map<string, DirectMessage>>();
  for (const m of messages) {
    const thread = byPeer.get(m.peer) ?? new Map<string, DirectMessage>();
    thread.set(m.id, m);
    byPeer.set(m.peer, thread);
  }
  return [...byPeer]
    .map(([peer, thread]) => {
      const sorted = [...thread.values()].sort((a, b) => a.at - b.at);
      return { peer, messages: sorted, last: sorted[sorted.length - 1] };
    })
    .sort((a, b) => b.last.at - a.last.at);
}
