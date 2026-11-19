/**
 * Asking for a draft as the founder: the project's own recent records are read once (their ids only are sent), then
 * the server's manager is asked. One request at a time; a second press while one runs asks nothing more.
 */
import { KIND_LAUNCH_UPDATE } from "@creaton/core/kinds.ts";
import { useMutation } from "@tanstack/react-query";
import { read } from "../../lib/relay";
import type { Project } from "../project/project-record";
import { askManager, ITEMS_MAX, type ManagerDraft } from "./manager-calls";

/** The ids of the project's newest records (its updates, tasks and answers), newest first, at most `ITEMS_MAX`. */
async function recentRecordIds(project: Project): Promise<string[]> {
  const events = await read({
    kinds: [KIND_LAUNCH_UPDATE],
    "#a": [project.coordinate],
    limit: ITEMS_MAX,
  });
  return [...events]
    .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : -1))
    .slice(0, ITEMS_MAX)
    .map((event) => event.id);
}

export function useManagerDraft() {
  return useMutation({
    mutationFn: async (input: {
      project: Project;
      answers: string[];
    }): Promise<ManagerDraft> =>
      askManager({
        project: input.project.coordinate,
        items: await recentRecordIds(input.project),
        answers: input.answers,
      }),
  });
}
