/**
 * Which rooms and boards have something the reader has not read (D101), from the server's private read-state API, and
 * telling it when the reader has read one.
 *
 * Only when the server offers the API (its information document names it) and someone is signed in; otherwise there
 * are no markers at all, never a false "all read". Counts are read with signed requests, a page of twenty rooms at a
 * time, again every half minute while the page is in use (the poll pauses after a while, as every poll here does).
 * Reading is sent as "read this room through this message", with the anchor the server gave for the room, once per
 * anchor; each mark is kept in this browser until the server has settled it, and a mark whose outcome is unknown is sent
 * again unchanged. The server counts nothing as unread for an account until its first mark, so a room is marked when it
 * is read even if nothing in it was counted.
 */

import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useBoundedPoll } from "@/shared/hooks/use-bounded-poll";
import { existingUserPubkey } from "@/shared/lib/identity";
import { makeNip98AuthHeader } from "@/shared/lib/nip98";
import { communityHostName, relayHttpBaseUrl } from "@/shared/lib/relay-url";

import {
  afterOutcomes,
  type ChannelUnread,
  type MarkRead,
  parsePendingMarks,
  parseSidebarPage,
  readStateBase,
  withMark,
} from "./lib/read-state";

const POLL_MS = 30_000;
/** Pages of twenty rooms read per refresh: a hundred rooms and boards. */
const MAX_PAGES = 5;
const NONE: ReadonlyMap<string, ChannelUnread> = new Map();

async function fetchBase(): Promise<string | null> {
  const response = await fetch(`${relayHttpBaseUrl()}/info`, {
    headers: { Accept: "application/nostr+json" },
  });
  if (!response.ok) return null;
  return readStateBase(await response.json().catch(() => null));
}

async function signedFetch(
  url: string,
  init: { method: "GET" } | { method: "POST"; body: string },
): Promise<Response> {
  const auth = await makeNip98AuthHeader(
    url,
    init.method,
    init.method === "POST" ? { body: init.body } : undefined,
  );
  return fetch(url, {
    method: init.method,
    headers: {
      Authorization: auth,
      ...(init.method === "POST" ? { "Content-Type": "application/json" } : {}),
    },
    ...(init.method === "POST" ? { body: init.body } : {}),
  });
}

function storageKey(me: string): string {
  return `buzz.read-marks.${communityHostName()}.${me}`;
}

function loadMarks(me: string): MarkRead[] {
  try {
    return parsePendingMarks(localStorage.getItem(storageKey(me)));
  } catch {
    return [];
  }
}

function saveMarks(me: string, marks: readonly MarkRead[]): void {
  try {
    if (marks.length === 0) localStorage.removeItem(storageKey(me));
    else localStorage.setItem(storageKey(me), JSON.stringify(marks));
  } catch {
    // Storage refused: the marks still go out from memory this session.
  }
}

export function useUnreadRooms(): {
  /** The server offers read state and the reader is signed in. */
  available: boolean;
  rows: ReadonlyMap<string, ChannelUnread>;
  /** The reader has read this room or board through what the server last counted in it. */
  markRead: (channelId: string) => void;
} {
  const me = existingUserPubkey();
  const baseQuery = useQuery({
    queryKey: ["read-state-base", relayHttpBaseUrl()],
    queryFn: fetchBase,
    enabled: me !== null,
    staleTime: 5 * 60_000,
    retry: 1,
    refetchOnWindowFocus: false,
  });
  const base = baseQuery.data ?? null;
  const on = me !== null && base !== null;
  const root = on ? `${relayHttpBaseUrl()}${base}/me` : null;

  const [rows, setRows] = useState<ReadonlyMap<string, ChannelUnread>>(NONE);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  // Only the newest read writes its result.
  const generation = useRef(0);
  const marks = useRef<MarkRead[]>([]);
  const sending = useRef(false);
  // Anchors already marked this session ("room:message"), so reopening a room does not send the same mark again.
  const marked = useRef<Set<string>>(new Set());

  // Marks left from an earlier visit are sent with the next ones.
  useEffect(() => {
    marks.current = me ? loadMarks(me) : [];
  }, [me]);

  const flush = useCallback(async () => {
    if (!root || !me || sending.current || marks.current.length === 0) return;
    sending.current = true;
    const sent = marks.current.slice(0, 100);
    try {
      const body = JSON.stringify({ intents: sent });
      const response = await signedFetch(`${root}/read-state`, {
        method: "POST",
        body,
      });
      if (!response.ok) return; // Kept, to be sent again on the next refresh.
      const left = afterOutcomes(sent, await response.json());
      const later = marks.current.slice(sent.length);
      marks.current = [...left, ...later];
      saveMarks(me, marks.current);
    } catch {
      // Kept, to be sent again on the next refresh.
    } finally {
      sending.current = false;
    }
  }, [root, me]);

  const load = useCallback(async () => {
    if (!root) return;
    const mine = ++generation.current;
    await flush();
    const next = new Map<string, ChannelUnread>();
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const url = `${root}/sidebar?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      let parsed: ReturnType<typeof parseSidebarPage>;
      try {
        const response = await signedFetch(url, { method: "GET" });
        if (!response.ok) return;
        parsed = parseSidebarPage(await response.json());
      } catch {
        return; // Keep what is shown; the next refresh tries again.
      }
      for (const row of parsed.rows) next.set(row.channelId, row);
      cursor = parsed.nextCursor;
      if (!cursor) break;
    }
    if (mine === generation.current) setRows(next);
  }, [root, flush]);

  useBoundedPoll(load, on, POLL_MS);

  const markRead = useCallback(
    (channelId: string) => {
      if (!me) return;
      const row = rowsRef.current.get(channelId);
      if (!row?.latest) return;
      // Marked even when nothing is counted as unread: the server starts counting for an account at its first mark.
      const key = `${channelId}:${row.latest}`;
      if (marked.current.has(key)) return;
      marked.current.add(key);
      marks.current = withMark(marks.current, {
        type: "mark_channel_read",
        channel_id: channelId,
        message_id: row.latest,
      });
      saveMarks(me, marks.current);
      // Shown as read at once; the next refresh says what the server holds.
      setRows((current) => {
        const copy = new Map(current);
        copy.set(channelId, {
          ...row,
          unread: { status: "exact", value: 0 },
          attention: { status: "exact", value: 0 },
        });
        return copy;
      });
      void flush();
    },
    [me, flush],
  );

  return useMemo(
    () => ({ available: on, rows: on ? rows : NONE, markRead }),
    [on, rows, markRead],
  );
}
