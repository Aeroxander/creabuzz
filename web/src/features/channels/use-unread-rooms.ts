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
  type ChannelUnread,
  type MarkRead,
  markKey,
  parsePendingMarks,
  parseSidebarPage,
  readStateBase,
  settledMarks,
  withMark,
  withoutSettled,
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
  /** The counts stopped refreshing (the poll pauses after a while): they may be out of date until `refresh`. */
  paused: boolean;
  refresh: () => void;
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
  // Marks a full queue refused, the newest per room, waiting in memory for room in the queue (never in place of a
  // mark the queue already holds).
  const waiting = useRef<Map<string, MarkRead>>(new Map());

  // Marks left from an earlier visit are sent with the next ones.
  useEffect(() => {
    marks.current = me ? loadMarks(me) : [];
  }, [me]);

  const flush = useCallback(async () => {
    if (!root || !me || sending.current) return;
    sending.current = true;
    try {
      // Batch after batch until the queue is empty, so a mark that joined while one was in flight goes at once. A batch
      // the server settled nothing of stops it (an unknown outcome is sent again on the next refresh, not in a loop).
      while (marks.current.length > 0) {
        const sent = marks.current.slice(0, 100);
        const response = await signedFetch(`${root}/read-state`, {
          method: "POST",
          body: JSON.stringify({ intents: sent }),
        });
        if (!response.ok) return; // Kept, to be sent again on the next refresh.
        // Only what the server settled goes, matched by identity: a mark added while this batch was in flight stays.
        const settled = settledMarks(sent, await response.json());
        marks.current = withoutSettled(marks.current, settled);
        // Room freed: the marks a full queue refused join it now, oldest refusal first.
        for (const [room, mark] of waiting.current) {
          const queued = withMark(marks.current, mark);
          if (!queued.accepted) break;
          marks.current = queued.marks;
          marked.current.add(markKey(mark));
          waiting.current.delete(room);
        }
        saveMarks(me, marks.current);
        if (settled.size === 0) return;
      }
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

  const poll = useBoundedPoll(load, on, POLL_MS);
  // The poll pauses after a while without anyone asking, as every poll here does. Opening a room or coming back to the
  // page asks again, so a count is never left stale while someone is using the app.
  const pollRef = useRef(poll);
  pollRef.current = poll;
  const resume = useCallback(() => {
    if (pollRef.current.paused) void pollRef.current.refresh();
  }, []);
  useEffect(() => {
    if (!on) return;
    const onVisible = () => {
      if (document.visibilityState === "visible") resume();
    };
    window.addEventListener("focus", resume);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", resume);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [on, resume]);

  const markRead = useCallback(
    (channelId: string) => {
      if (!me) return;
      resume();
      const row = rowsRef.current.get(channelId);
      if (!row?.latest) return;
      // Marked even when nothing is counted as unread: the server starts counting for an account at its first mark.
      const key = `${channelId}:${row.latest}`;
      if (marked.current.has(key)) return;
      const queued = withMark(marks.current, {
        type: "mark_channel_read",
        channel_id: channelId,
        message_id: row.latest,
      });
      // A full queue (the server has not answered for a long time) refuses the mark: it waits in memory and joins the
      // queue once the server settles earlier marks; until then the count is left as the server gave it.
      if (!queued.accepted) {
        waiting.current.delete(channelId);
        waiting.current.set(channelId, {
          type: "mark_channel_read",
          channel_id: channelId,
          message_id: row.latest,
        });
        void flush();
        return;
      }
      marked.current.add(key);
      marks.current = queued.marks;
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
    [me, flush, resume],
  );

  const { paused, refresh } = poll;
  return useMemo(
    () => ({
      available: on,
      rows: on ? rows : NONE,
      markRead,
      paused: on && paused,
      refresh: () => void refresh(),
    }),
    [on, rows, markRead, paused, refresh],
  );
}
