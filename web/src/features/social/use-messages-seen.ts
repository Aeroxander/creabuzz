/**
 * The "new messages" dot on the Messages nav entry, and recording what the reader has seen (`lib/messages-seen.ts`).
 *
 * The record is kept in this browser per server and account. Every change is one write of the whole record, and every
 * mounted reader (the nav, the inbox, a conversation) re-reads it at once, in this tab and in others. Storage that
 * refuses keeps the record in memory for this tab, so the dot still clears while the page is open.
 */

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import { existingUserPubkey } from "@/shared/lib/identity";
import { communityHostName } from "@/shared/lib/relay-url";

import {
  freshSeen,
  hasUnreadMessages,
  type MessagesSeen,
  parseSeen,
  withListSeen,
  withPeerSeen,
} from "./lib/messages-seen";
import { useConversations } from "./use-messages";
import { useMutedPeople } from "./use-social-actions";

const listeners = new Set<() => void>();
/** This tab's latest write per key: what is read when storage refused it. */
const written = new Map<string, string>();

function keyFor(me: string): string {
  return `buzz.messages-seen.${communityHostName()}.${me}`;
}

function readRaw(key: string): string | null {
  const mine = written.get(key);
  if (mine !== undefined) return mine;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function save(key: string, seen: MessagesSeen): void {
  const raw = JSON.stringify(seen);
  written.set(key, raw);
  try {
    localStorage.setItem(key, raw);
  } catch {
    // Storage refused: the record stays in memory for this tab.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Another tab wrote the record: theirs is newer than what this tab holds in memory.
  const onStorage = (event: StorageEvent) => {
    if (event.key?.startsWith("buzz.messages-seen.")) {
      written.delete(event.key);
      listener();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** What the reader has seen, and the two ways to record more. Null `seen` until the record exists. */
export function useMessagesSeen(): {
  seen: MessagesSeen | null;
  markListSeen: (at: number) => void;
  markConversationSeen: (peer: string, at: number) => void;
} {
  const me = existingUserPubkey();
  const key = me ? keyFor(me) : null;
  const raw = useSyncExternalStore(
    subscribe,
    () => (key ? readRaw(key) : null),
    () => null,
  );
  const seen = useMemo(() => parseSeen(raw), [raw]);

  // The first visit starts the record now: older messages are not called new.
  useEffect(() => {
    if (key && parseSeen(readRaw(key)) === null)
      save(key, freshSeen(Math.floor(Date.now() / 1000)));
  }, [key]);

  const update = useCallback(
    (change: (current: MessagesSeen) => MessagesSeen) => {
      if (!key) return;
      const current =
        parseSeen(readRaw(key)) ?? freshSeen(Math.floor(Date.now() / 1000));
      const next = change(current);
      if (next !== current) save(key, next);
    },
    [key],
  );
  const markListSeen = useCallback(
    (at: number) => update((current) => withListSeen(current, at)),
    [update],
  );
  const markConversationSeen = useCallback(
    (peer: string, at: number) =>
      update((current) => withPeerSeen(current, peer, at)),
    [update],
  );
  return { seen, markListSeen, markConversationSeen };
}

/**
 * A conversation has a message newer than the reader last saw. False while the inbox or the mute list is still being
 * read, or could not be: the dot appears only for something known to be new.
 */
export function useHasNewMessages(): boolean {
  const me = existingUserPubkey();
  const conversations = useConversations();
  const muted = useMutedPeople();
  const { seen } = useMessagesSeen();
  return useMemo(() => {
    if (!me || !conversations.data || muted.isLoading || muted.isError)
      return false;
    const mutedSet = muted.data;
    return hasUnreadMessages(
      conversations.data.filter((c) => !mutedSet?.has(c.peer)),
      seen,
    );
  }, [
    me,
    conversations.data,
    muted.isLoading,
    muted.isError,
    muted.data,
    seen,
  ]);
}
