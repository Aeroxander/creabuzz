/**
 * The founder's project record with its perks changed (plan section 4.5). A perk is words, never money. No edit flow for a
 * project record existed, so this one copies every tag the record has and its content, and sets or clears only `perks`: a
 * record whose other tags changed would lose its chain key, its team or its listing. The newest record is read first, so a
 * team change made elsewhere is not undone.
 */
import { KIND_LAUNCH_RECORD } from "@creaton/core/kinds.ts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { publishAsUser, read } from "../../lib/relay";
import {
  latestProjects,
  PERKS_MAX,
  type Project,
} from "../project/project-record";

/** The record, ready to sign: every tag but `perks` as it was, then the new `perks` when there is any text. */
export function recordWithPerks(
  project: Project,
  text: string,
  now: number = Math.floor(Date.now() / 1000),
): { kind: number; tags: string[][]; content: string; created_at: number } {
  const words = text.trim();
  if (words.length > PERKS_MAX)
    throw new Error(`Keep it under ${PERKS_MAX} characters.`);
  const kept = project.event.tags.filter((tag) => tag[0] !== "perks");
  return {
    kind: KIND_LAUNCH_RECORD,
    tags: words ? [...kept, ["perks", words]] : kept,
    content: project.event.content,
    created_at: Math.max(now, project.updatedAt + 1),
  };
}

/** Save the perks on the founder's own record. */
export function useSavePerks(project: Project) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (text: string) => {
      // Built on the newest version of the record: a team change made on another device stays.
      const events = await read({
        kinds: [KIND_LAUNCH_RECORD],
        authors: [project.author],
        "#d": [project.id],
        limit: 20,
      });
      const newest = latestProjects(events)[0] ?? project;
      return publishAsUser(
        recordWithPerks(newest, text),
        "The perks were not saved. Try again.",
      );
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["project"] }),
  });
}
