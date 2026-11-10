/**
 * A project's goals and its promise record, worked out from that project's own update records.
 *
 * It is the same bounded, paged read the update card and the help cards use (`useProjectUpdates`), so the page reads
 * the project once. When that read was cut at its bound the result says so (`facts`): the page then shows what was
 * read and does not state totals, or that no goal was set. A failed read is `failed`, never an empty record.
 *
 * No state is kept outside React and the query cache: nothing here outlives a change of community.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { KIND_LAUNCH_UPDATE } from "@/shared/constants/kinds";

import {
  type GoalInput,
  goalEvent,
  type ProjectGoals,
  projectGoals,
} from "./lib/goals";
import { type PromiseEntry, promiseRecord, recordFacts } from "./lib/promises";
import { launchCoordinate, type Launch } from "./models";
import { helpQueryKey, useProjectUpdates } from "./use-help-requests";
import { publishMirror } from "./use-launches";

type Project = Pick<Launch["record"], "author" | "id">;

export interface ProjectRecord {
  goals: ProjectGoals;
  /** Every promise read, newest first. */
  promises: PromiseEntry[];
  /** What may be stated as fact, given how much was read. */
  facts: ReturnType<typeof recordFacts>;
}

export function useProjectRecord(project: Project): {
  record: ProjectRecord | null;
  /** The read failed and nothing is known. */
  failed: boolean;
  /** A newer read failed; what is shown is from before. */
  stale: boolean;
  retry: () => void;
} {
  const read = useProjectUpdates(project);
  const { data, refetch } = read;
  const founder = project.author;
  const record = useMemo((): ProjectRecord | null => {
    if (!data) return null;
    return {
      goals: projectGoals(data.goals, founder),
      // The founder's own news: not submitted work, a work area's words or a check note, which are other records.
      promises: promiseRecord(
        data.updates.filter(
          (update) => !update.claim && !update.workArea && !update.checkNote,
        ),
        founder,
      ),
      facts: recordFacts({ complete: data.complete }),
    };
  }, [data, founder]);
  return {
    record,
    failed: read.isError && !data,
    stale: read.isError && Boolean(data),
    retry: () => void refetch(),
  };
}

/** Publishes a goal as it now stands: one signed record, which the page then reads back. */
export function publishGoal(project: Project, goal: GoalInput) {
  const { content, tags } = goalEvent(goal);
  return publishMirror({
    kind: KIND_LAUNCH_UPDATE,
    tags: [["a", launchCoordinate(project.author, project.id)], ...tags],
    content,
  });
}

export function useSaveGoal(project: Project) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (goal: GoalInput) => publishGoal(project, goal),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: helpQueryKey }),
  });
}
