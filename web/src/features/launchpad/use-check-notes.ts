/**
 * A project's check notes (`checkNote.ts` in core): the founder's launch updates that carry a `check`, newest first,
 * and a way for the founder to publish one. Read on their own, by the founder's key, so the Overview can say when the
 * last one was without reading every update.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import {
  type CheckNote,
  type CheckNoteRecord,
  checkNoteContent,
  KIND_CHECK_NOTE,
  parseCheckNotes,
} from "@creaton/core/launchpad/checkNote.ts";
import { queryEvents } from "@/shared/lib/nostr-client";
import { publishAsUser } from "@/shared/lib/publish-as-user";
import { relayWsUrl } from "@/shared/lib/relay-url";

import { type Launch, launchCoordinate } from "./models";
import { launchesQueryKey } from "./use-launches";

/** The founder's updates read to find the notes: enough for well over a year of checks. */
const MAX_UPDATES = 200;

export function useCheckNotes(launch: Launch) {
  const queryClient = useQueryClient();
  const { author, id } = launch.record;
  const query = useQuery({
    queryKey: ["launchpad", "check-notes", author, id],
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    queryFn: async (): Promise<CheckNoteRecord[]> =>
      parseCheckNotes(
        await queryEvents(relayWsUrl(), {
          kinds: [KIND_CHECK_NOTE],
          authors: [author],
          "#a": [launchCoordinate(author, id)],
          limit: MAX_UPDATES,
        }),
        author,
      ),
  });
  const publish = useCallback(
    async (note: CheckNote) => {
      const content = checkNoteContent(note, Math.floor(Date.now() / 1000));
      await publishAsUser(
        {
          kind: KIND_CHECK_NOTE,
          tags: [["a", launchCoordinate(author, id)]],
          content: JSON.stringify(content),
        },
        "The server did not take the check note.",
      );
      await queryClient.invalidateQueries({
        queryKey: ["launchpad", "check-notes", author, id],
      });
      // It is an update too: the Updates tab reads it with the rest.
      await queryClient.invalidateQueries({ queryKey: launchesQueryKey });
    },
    [author, id, queryClient],
  );
  return { query, publish };
}
