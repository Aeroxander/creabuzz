import { useMemo, useState } from "react";

import { useLaunches } from "@/features/launchpad/use-launches";
import { useUserNames } from "@/features/profiles/use-profiles";

import { type FeedNote, launchCoordinate } from "../lib/feed-events";
import { EMPTY_TALLY, type SortMode, sortByMode } from "../lib/ranking";
import { useVoteTallies } from "../use-feed";
import { NoteCard } from "./NoteCard";

/** Launch coordinate -> launch name, from the launches already loaded. */
function useLaunchNames(): (coord: string) => string | null {
  const launches = useLaunches();
  const names = useMemo(() => {
    const map = new Map<string, string>();
    for (const launch of launches.data ?? []) {
      map.set(
        launchCoordinate({
          pubkey: launch.record.author,
          id: launch.record.id,
        }),
        launch.record.name,
      );
    }
    return map;
  }, [launches.data]);
  return (coord: string) => names.get(coord) ?? null;
}

/**
 * Top-level posts in the chosen order; each with replies opens into them (oldest first). Read-only: these are notes
 * from before a project's board (D156), and new talk goes on the board. Replies live in the same note set, so a thread
 * never needs a second query.
 */
export function ThreadList({
  notes,
  mode,
  empty,
  testId = "thread-list",
}: {
  notes: readonly FeedNote[];
  mode: SortMode;
  empty: React.ReactNode;
  testId?: string;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const { tallies } = useVoteTallies();
  const launchName = useLaunchNames();
  const nameOf = useUserNames([...new Set(notes.map((n) => n.author))]);

  const { roots, repliesByRoot } = useMemo(() => {
    const byRoot = new Map<string, FeedNote[]>();
    const top: FeedNote[] = [];
    for (const note of notes) {
      if (note.rootId) {
        const list = byRoot.get(note.rootId) ?? [];
        list.push(note);
        byRoot.set(note.rootId, list);
      } else {
        top.push(note);
      }
    }
    for (const list of byRoot.values()) {
      list.sort((a, b) => a.createdAt - b.createdAt);
    }
    return { roots: top, repliesByRoot: byRoot };
  }, [notes]);

  const ordered = useMemo(
    () =>
      sortByMode(
        roots,
        mode,
        (n) => tallies.get(n.id)?.score ?? 0,
        (n) => n.createdAt,
      ),
    [roots, mode, tallies],
  );

  if (ordered.length === 0) return <>{empty}</>;

  return (
    <ul className="flex flex-col gap-3" data-testid={testId}>
      {ordered.map((note) => {
        const replies = repliesByRoot.get(note.id) ?? [];
        const expanded = open === note.id;
        return (
          <li key={note.id}>
            <NoteCard
              launchName={launchName}
              nameOf={nameOf}
              note={note}
              expanded={replies.length > 0 ? expanded : undefined}
              onReply={
                replies.length > 0
                  ? () => setOpen(expanded ? null : note.id)
                  : undefined
              }
              repliesId={`thread-replies-${note.id}`}
              replies={replies.length}
              tally={tallies.get(note.id) ?? EMPTY_TALLY}
            />
            {expanded ? (
              <div
                className="ml-6 mt-2 border-l border-black/10 pl-3 dark:border-white/10"
                data-testid="thread-replies"
                id={`thread-replies-${note.id}`}
              >
                {replies.map((reply) => (
                  <NoteCard
                    compact
                    key={reply.id}
                    launchName={launchName}
                    nameOf={nameOf}
                    note={reply}
                    tally={tallies.get(reply.id) ?? EMPTY_TALLY}
                  />
                ))}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
