/**
 * Reading a project's tasks and writing their steps, as the person using the app. Every write is one signed record; the
 * server decides who may sign it (the team posts and accepts, someone outside it takes, the helper hands in).
 */
import { KIND_LAUNCH_UPDATE, KIND_PROFILE } from "@creaton/core/kinds.ts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { publishAsUser, read } from "../../lib/relay";
import type { Project } from "../project/project-record";
import { projectTasks, type RecordTemplate, TASK_LABEL } from "./task-record";

/** How many task records one read takes: a project's tasks and all their steps. */
const TASK_READ = 500;

const taskKeys = {
  all: ["tasks"] as const,
  project: (coordinate: string) => ["tasks", "project", coordinate] as const,
};

/** The project's team: its founder and every member on its record. */
export function teamOf(project: Project): Set<string> {
  return new Set([project.author, ...project.team.map((m) => m.pubkey)]);
}

/**
 * Whether a profile says its account is an agent: an `agent` tag naming the account itself, or the signature of the
 * person who runs it (`auth`). The server checked both keys when the profile was written.
 */
function isAgentProfile(event: { pubkey: string; tags: string[][] }): boolean {
  return event.tags.some(
    (t) => (t[0] === "agent" && t[1] === event.pubkey) || t[0] === "auth",
  );
}

/** The project's tasks, newest first. */
export function useProjectTasks(project: Project) {
  const team = teamOf(project);
  return useQuery({
    queryKey: taskKeys.project(project.coordinate),
    staleTime: 15_000,
    queryFn: async () => {
      const events = await read({
        kinds: [KIND_LAUNCH_UPDATE],
        "#a": [project.coordinate],
        "#l": [TASK_LABEL],
        limit: TASK_READ,
      });
      // Every signer and everyone on the team: an agent on the team is never offered Accept, whoever signed what.
      const signers = [...new Set([...events.map((e) => e.pubkey), ...team])];
      const labelled = signers.length
        ? await read({
            kinds: [KIND_PROFILE],
            authors: signers,
            limit: signers.length * 2,
          })
        : [];
      const agents = new Set(
        labelled.filter(isAgentProfile).map((e) => e.pubkey),
      );
      return {
        tasks: projectTasks(events, project.coordinate, team, agents),
        agents,
        complete: events.length < TASK_READ,
      };
    },
  });
}

/** Sign and send one task record, then read the tasks again. */
export function useTaskWrite(project: Project) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      record,
      failure,
    }: {
      record: RecordTemplate;
      failure: string;
    }) => publishAsUser(record, failure),
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: taskKeys.project(project.coordinate),
      }),
  });
}
