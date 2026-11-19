/**
 * This week's records: the founder's weekly update (kind 47003 with the weekly mark, the same record web/ writes and
 * reads, `@creaton/core/project/weekly-update.ts`) and when each project last had one.
 */
import { KIND_LAUNCH_UPDATE } from "@creaton/core/kinds.ts";
import {
  defaultUpdateTitle,
  isWeeklyUpdateTags,
  UPDATE_LIMITS,
  updateEvent,
} from "@creaton/core/project/weekly-update.ts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { publishAsUser, read } from "../../lib/relay";
import type { Project } from "../project/project-record";

/** The longest "What did you do this week?" may be. */
export const WEEKLY_MAX = UPDATE_LIMITS.part;

/** The weekly update's record for one field of text, ready to sign. */
export function weeklyUpdateRecord(
  project: Pick<Project, "coordinate">,
  text: string,
  now: Date = new Date(),
) {
  const { content, tags } = updateEvent(
    {
      title: defaultUpdateTitle(now, "en-GB"),
      done: text,
      next: "",
      body: "",
      help: "",
      helpSize: "small",
      helpTime: "",
    },
    // One field, "What happened this week": no "What's next", so no promises are made.
    { promises: false },
  );
  return {
    kind: KIND_LAUNCH_UPDATE,
    tags: [["a", project.coordinate], ...tags],
    content: JSON.stringify(content),
  };
}

/** The newest weekly update of a project: when it was made, and its record's id (what a check-in names). */
export interface LastWeekly {
  at: number;
  id: string;
}

/** When each of `author`'s projects last had a weekly update by them, and its id, by project address. */
export function useLastWeekly(author: string | null, projects: Project[]) {
  const coordinates = projects.map((p) => p.coordinate);
  return useQuery({
    queryKey: ["week", "last", author, coordinates],
    enabled: author !== null && coordinates.length > 0,
    staleTime: 30_000,
    queryFn: async (): Promise<Map<string, LastWeekly>> => {
      const events = await read({
        kinds: [KIND_LAUNCH_UPDATE],
        authors: [author as string],
        "#a": coordinates,
        limit: 200,
      });
      const last = new Map<string, LastWeekly>();
      for (const event of events) {
        if (!isWeeklyUpdateTags(event.tags)) continue;
        const a = event.tags.find((t) => t[0] === "a")?.[1];
        if (!a) continue;
        if ((last.get(a)?.at ?? 0) < event.created_at)
          last.set(a, { at: event.created_at, id: event.id });
      }
      return last;
    },
  });
}

/** Post the weekly update. Throws the server's reason, in plain words, when it is refused. */
export function usePostWeekly() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { project: Project; text: string }) =>
      publishAsUser(
        weeklyUpdateRecord(input.project, input.text),
        "Your update was not posted. Try again.",
      ),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["week"] });
      void queryClient.invalidateQueries({ queryKey: ["project"] });
    },
  });
}

/** The name a project's check-in step is remembered under while its call has not landed (shared by both buttons). */
export function checkInAction(chainId: number, treasury: string): string {
  return `check-in:${chainId}:${treasury.toLowerCase()}`;
}
