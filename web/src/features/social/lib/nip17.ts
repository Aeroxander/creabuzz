/**
 * Private direct messages for the social client, on NIP-17 so they are
 * end-to-end encrypted and readable by 0xchat, Amethyst, Primal and every
 * other NIP-17 client (and unrelated to Buzz's channel-based DMs):
 *
 *   kind 14 rumor (unsigned) → kind 13 seal (signed by you, NIP-44 to the
 *   recipient) → kind 1059 gift wrap (throwaway key, NIP-44 to the recipient).
 *
 * The relay only ever sees the wrap: not who sent it, not what it says. A
 * second wrap addressed to yourself keeps your other devices in sync. Pure and
 * alias-free — the signer is injected — so `social.test.mjs` drives it under
 * `node --test` with real keys.
 */

import { createWrap } from "nostr-tools/nip59";
import { getEventHash, verifyEvent } from "nostr-tools/pure";

import { KIND_GIFT_WRAP } from "../../../shared/constants/kinds.ts";
import type { SignedEvent } from "./timeline.ts";

export const KIND_SEAL = 13;
export const KIND_DIRECT_MESSAGE = 14;

/** NIP-59 randomizes seal and wrap timestamps up to two days into the past. */
const MAX_JITTER_SECONDS = 2 * 24 * 60 * 60;

/** Everything a DM needs from whoever holds the key (passkey, extension, nsec). */
export interface DmSigner {
  pubkey: string;
  sign(template: {
    kind: number;
    created_at?: number;
    tags: string[][];
    content: string;
  }): Promise<SignedEvent>;
  encrypt(peer: string, plaintext: string): Promise<string>;
  decrypt(peer: string, ciphertext: string): Promise<string>;
}

export interface DirectMessage {
  /** Id of the inner kind 14 rumor — identical across both wraps. */
  id: string;
  wrapId: string;
  from: string;
  /** The other participant; never the viewer. */
  peer: string;
  content: string;
  at: number;
}

export interface Conversation {
  peer: string;
  /** Oldest first. */
  messages: DirectMessage[];
  last: DirectMessage;
}

const randomPast = (now: number) =>
  now - Math.floor(Math.random() * MAX_JITTER_SECONDS);

/** The gift wraps for one 1:1 message: one for the recipient, one for you. */
export async function createDirectMessageWraps(
  signer: DmSigner,
  recipient: string,
  content: string,
  now = Math.floor(Date.now() / 1000),
): Promise<{ toRecipient: SignedEvent; toSelf: SignedEvent; rumorId: string }> {
  const text = content.trim();
  if (text === "") throw new Error("Write something first.");
  const rumor = {
    kind: KIND_DIRECT_MESSAGE,
    created_at: now,
    tags: [["p", recipient]],
    content: text,
    pubkey: signer.pubkey,
  };
  const rumorId = getEventHash(rumor);
  const rumorJson = JSON.stringify({ ...rumor, id: rumorId });

  const wrapFor = async (target: string): Promise<SignedEvent> => {
    const seal = await signer.sign({
      kind: KIND_SEAL,
      created_at: randomPast(now),
      tags: [],
      content: await signer.encrypt(target, rumorJson),
    });
    return createWrap(seal, target) as SignedEvent;
  };

  const [toRecipient, toSelf] = await Promise.all([
    wrapFor(recipient),
    wrapFor(signer.pubkey),
  ]);
  return { toRecipient, toSelf, rumorId };
}

/**
 * Open a wrap addressed to the signer. Null for anything that is not an
 * authentic 1:1 message: a forged sender (the rumor's author must be the seal's
 * signer), a bad id, another kind, or a group conversation.
 */
export async function openGiftWrap(
  signer: DmSigner,
  wrap: SignedEvent,
): Promise<DirectMessage | null> {
  if (wrap.kind !== KIND_GIFT_WRAP) return null;
  try {
    const seal = JSON.parse(
      await signer.decrypt(wrap.pubkey, wrap.content),
    ) as SignedEvent;
    if (seal.kind !== KIND_SEAL || !verifyEvent(seal)) return null;

    const rumor = JSON.parse(
      await signer.decrypt(seal.pubkey, seal.content),
    ) as SignedEvent;
    if (rumor.kind !== KIND_DIRECT_MESSAGE || rumor.pubkey !== seal.pubkey) {
      return null;
    }
    if (typeof rumor.content !== "string" || getEventHash(rumor) !== rumor.id) {
      return null;
    }

    const others = [
      ...new Set(
        rumor.tags.filter((t) => t[0] === "p" && t[1]).map((t) => t[1]),
      ),
    ].filter((p) => p !== rumor.pubkey);
    const sentByMe = rumor.pubkey === signer.pubkey;
    // 1:1 only: what we sent has exactly one other person; what we received
    // is addressed to exactly us.
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

/** Messages (de-duplicated by rumor id) grouped per person, most recent first. */
export function groupConversations(
  messages: readonly DirectMessage[],
): Conversation[] {
  const byPeer = new Map<string, Map<string, DirectMessage>>();
  for (const m of messages) {
    const thread = byPeer.get(m.peer) ?? new Map<string, DirectMessage>();
    thread.set(m.id, m);
    byPeer.set(m.peer, thread);
  }
  return [...byPeer]
    .map(([peer, thread]) => {
      const sorted = [...thread.values()].sort(
        (a, b) => a.at - b.at || (a.id < b.id ? -1 : 1),
      );
      return { peer, messages: sorted, last: sorted[sorted.length - 1] };
    })
    .sort((a, b) => b.last.at - a.last.at);
}

/** Relays from a NIP-17 DM relay list (kind 10050 `relay` tags), capped. */
export function dmRelays(list: { tags: string[][] } | null, max = 4): string[] {
  const out: string[] = [];
  for (const tag of list?.tags ?? []) {
    if (tag[0] !== "relay" || typeof tag[1] !== "string") continue;
    const url = tag[1].trim().replace(/\/+$/, "");
    if (/^wss?:\/\//.test(url) && !out.includes(url)) out.push(url);
    if (out.length >= max) break;
  }
  return out;
}
