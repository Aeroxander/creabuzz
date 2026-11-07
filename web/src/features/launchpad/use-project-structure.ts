/**
 * A project's working structure from the server: who has taken on which work (kind 37019) and the founder's Now and
 * Not doing lists (kind 37020), with a way to publish each (`projectStructure.ts` in core).
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import {
  KIND_PROJECT_FOCUS,
  KIND_WORK_TAKEN_ON,
} from "@/shared/constants/kinds";
import { queryEvents } from "@/shared/lib/nostr-client";
import { publishAsUser } from "@/shared/lib/publish-as-user";
import { relayWsUrl } from "@/shared/lib/relay-url";

import {
  type Focus,
  type FocusDraft,
  focusTemplate,
  parseFocus,
  parseTakenOn,
  type TakenOn,
} from "@creaton/core/launchpad/projectStructure.ts";
import { type Launch, launchCoordinate } from "./models";

/** At most this many records are read: one per person per work area. */
const MAX_TAKEN_ON = 500;

/** Everyone's work taken on in this project, and a way to publish yours. */
export function useTakenOn(launch: Launch) {
  const queryClient = useQueryClient();
  const coordinate = launchCoordinate(launch.record.author, launch.record.id);
  const query = useQuery({
    queryKey: ["launchpad", "taken-on", coordinate],
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    queryFn: async (): Promise<TakenOn[]> => {
      const events = await queryEvents(relayWsUrl(), {
        kinds: [KIND_WORK_TAKEN_ON],
        "#a": [coordinate],
        limit: MAX_TAKEN_ON,
      });
      return events.flatMap((event) => {
        const parsed = parseTakenOn(event, coordinate);
        return parsed ? [parsed] : [];
      });
    },
  });
  const publish = useCallback(
    async (template: { kind: number; tags: string[][]; content: string }) => {
      await publishAsUser(template, "The server did not take it.");
      await queryClient.invalidateQueries({
        queryKey: ["launchpad", "taken-on", coordinate],
      });
    },
    [coordinate, queryClient],
  );
  return { query, coordinate, publish };
}

/** The project's Now and Not doing lists, set by its founder, and a way for the founder to change them. */
export function useProjectFocus(launch: Launch) {
  const queryClient = useQueryClient();
  const { author, id } = launch.record;
  const query = useQuery({
    queryKey: ["launchpad", "focus", author, id],
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    queryFn: async (): Promise<Focus | null> => {
      const events = await queryEvents(relayWsUrl(), {
        kinds: [KIND_PROJECT_FOCUS],
        authors: [author],
        "#a": [launchCoordinate(author, id)],
        limit: 10,
      });
      return parseFocus(events, { author, id });
    },
  });
  const save = useCallback(
    async (focus: FocusDraft) => {
      await publishAsUser(
        focusTemplate({ author, id }, focus),
        "The server did not take the change.",
      );
      await queryClient.invalidateQueries({
        queryKey: ["launchpad", "focus", author, id],
      });
    },
    [author, id, queryClient],
  );
  return { query, save };
}
