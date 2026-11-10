/**
 * A project's goals and its promise record, worked out from that project's own update records.
 *
 * It comes with the read the update card and the help cards use (`useProjectUpdates`), which reads the founder's own
 * records by author, apart from everyone else's. When that read was cut at its bound the result says so (`facts`): the page then shows what was
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
import {
  type OrphanAnswer,
  orphanAnswers,
  type PromiseEntry,
  promiseRecord,
  recordFacts,
} from "./lib/promises";
import type { RemovedRecords } from "./lib/removed-records";
import { launchCoordinate, type Launch } from "./models";
import { helpQueryKey, useProjectUpdates } from "./use-help-requests";
import { publishMirror } from "./use-launches";

type Project = Pick<Launch["record"], "author" | "id">;

export interface ProjectRecord {
  goals: ProjectGoals;
  /** Every promise read, newest first. */
  promises: PromiseEntry[];
  /** The founder's answers to promises that are no longer there (the update that made them was removed). */
  orphans: OrphanAnswer[];
  /** The update records the founder has deleted. */
  removed: RemovedRecords;
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
    const { updates, goals, complete, removed } = data.founder;
    return {
      goals: projectGoals(goals, founder),
      promises: promiseRecord(updates, founder),
      // On a cut read a promise may only be older than what was read, so nothing is called removed.
      orphans: complete ? orphanAnswers(updates, founder) : [],
      removed,
      facts: recordFacts({ complete }),
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
