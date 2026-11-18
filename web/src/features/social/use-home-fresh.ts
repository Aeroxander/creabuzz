/**
 * Home's check for new posts. While Home is on screen it asks the server every `FRESH_POLL_MS` for short posts,
 * reposts and board posts newer than the newest shown (paused while the tab is hidden, as every poll is). What it finds
 * waits behind "N new posts. Show" instead of moving what the reader is reading.
 *
 * Bounded: one read of each kind per check, at most a page each, every interval, and none after a failed check until
 * the reader asks again. Each check starts past what the last one read and would never offer (`nextFreshStart`), so
 * replies between two posts do not fill the read. When one read is still full, the bar offers to read Home again from
 * the top, and the next check starts there.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";

import { existingUserPubkey } from "@/shared/lib/identity";

import { KIND_FORUM_POST } from "../board/lib/board-events";
import type { BoardEvent } from "../board/lib/board-model";
import {
  FRESH_POLL_MS,
  type FreshFound,
  freshAt,
  freshSince,
  freshToShow,
  nextFreshStart,
} from "./lib/home-fresh";
import type { TimelineItem } from "./lib/mixed-timeline";
import { readEvents } from "./read";
import { useMutedSet } from "./use-social-actions";
import { fetchRowsPage, socialKeys } from "./use-social-data";

/** Board posts read per check; more than this waiting means Home is read again from the top. */
const FRESH_BOARD_LIMIT = 40;

const NOTHING: FreshFound = { rows: [], boardPosts: [], capped: false };

export function useHomeFresh({
  tab,
  authors,
  items,
  boards,
  enabled,
}: {
  tab: "everyone" | "following";
  /** For Following: the people followed, the reader included. Null for Everyone. */
  authors: readonly string[] | null;
  /** What the timeline shows now. */
  items: readonly TimelineItem[];
  /** The boards the reader can see: a post on any other is not shown on Home. */
  boards: ReadonlySet<string>;
  enabled: boolean;
}) {
  const me = existingUserPubkey();
  const muted = useMutedSet();
  const queryClient = useQueryClient();
  const [openedAt] = useState(() => Math.floor(Date.now() / 1000));
  const since = freshSince(items, openedAt);
  const authorKey = authors ? [...authors].sort().join(",") : "all";
  const scope = `${tab}|${authorKey}`;
  const queryKey = [
    ...socialKeys.all,
    "home-fresh",
    tab,
    authorKey,
    since.notes,
    since.boards,
  ];

  // What a check reads against, as of the latest render: it decides where the next check starts.
  const context = useRef({ shown: items, boards, muted, me, scope });
  context.current = { shown: items, boards, muted, me, scope };
  // Where the next check starts, past what earlier checks read and would never offer. It belongs to one tab and set of
  // people, and only moves forward, so a check that finishes after the reader moved on cannot pull it back.
  const start = useRef({ scope, notes: 0, boards: 0 });
  const moveStart = (to: { scope: string; notes: number; boards: number }) => {
    if (to.scope !== context.current.scope) return;
    const at = start.current.scope === to.scope ? start.current : null;
    start.current = {
      scope: to.scope,
      notes: Math.max(at?.notes ?? 0, to.notes),
      boards: Math.max(at?.boards ?? 0, to.boards),
    };
  };

  const query = useQuery({
    queryKey,
    enabled,
    // The timeline was just read: the first check comes one interval later, not on top of the first load.
    initialData: NOTHING,
    initialDataUpdatedAt: () => Date.now(),
    staleTime: FRESH_POLL_MS,
    refetchInterval: (q) =>
      q.state.status === "error" ? false : FRESH_POLL_MS,
    refetchIntervalInBackground: false,
    queryFn: async (): Promise<FreshFound> => {
      const kept = start.current.scope === scope ? start.current : null;
      const from = {
        notes: Math.max(since.notes, kept?.notes ?? 0),
        boards: Math.max(since.boards, kept?.boards ?? 0),
      };
      const [notes, boardPosts] = await Promise.all([
        fetchRowsPage({ authors, reposts: true, since: from.notes }),
        readEvents({
          kinds: [KIND_FORUM_POST],
          since: from.boards,
          limit: FRESH_BOARD_LIMIT,
          ...(authors ? { authors: [...authors] } : {}),
        }) as Promise<BoardEvent[]>,
      ]);
      const boardsCapped = boardPosts.length >= FRESH_BOARD_LIMIT;
      const found = {
        rows: notes.rows,
        boardPosts,
        capped: notes.capped || boardsCapped,
      };
      const offered = freshToShow(found, context.current);
      moveStart({
        scope,
        notes: nextFreshStart(
          from.notes,
          { newest: notes.newest, capped: notes.capped },
          offered.rows.map(freshAt),
        ),
        boards: nextFreshStart(
          from.boards,
          {
            newest: boardPosts.reduce<number | null>(
              (max, post) =>
                max === null || post.created_at > max ? post.created_at : max,
              null,
            ),
            capped: boardsCapped,
          },
          offered.boardPosts.map((post) => post.created_at),
        ),
      });
      return found;
    },
  });

  const fresh = useMemo(
    () =>
      freshToShow(query.data ?? NOTHING, { shown: items, boards, muted, me }),
    [query.data, items, boards, muted, me],
  );

  return {
    fresh,
    /** The last check failed: checking stopped until `retry`. */
    failed: query.isError,
    retry: () => void query.refetch(),
    /**
     * Home was read again from the top (a full check's Show): what came before is reached by scrolling, so the next
     * check starts now, and the full check's bar goes away.
     */
    restart: () => {
      const now = Math.floor(Date.now() / 1000);
      moveStart({ scope, notes: now, boards: now });
      queryClient.setQueryData(queryKey, NOTHING);
    },
  };
}
