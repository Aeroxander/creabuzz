/** Reading a project's tasks, as the person using the app: the records the team and its workers signed, with who is an agent. */
import { KIND_LAUNCH_UPDATE, KIND_PROFILE } from "@creaton/core/kinds.ts";
import { useQuery } from "@tanstack/react-query";
import { read } from "../../lib/relay";
import type { Project } from "../project/project-record";
import { projectTasks, TASK_LABEL } from "./task-record";

/** How many task records one read takes: a project's tasks and all their steps. */
const TASK_READ = 500;

const taskKeys = {
  project: (coordinate: string) => ["tasks", "project", coordinate] as const,
};

/** The project's team: its founder and every member on its record. */
function teamOf(project: Project): Set<string> {
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

/** Read the project's tasks and which accounts are agents, fresh from the server. */
async function fetchProjectTasks(project: Project) {
  const team = teamOf(project);
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
  const agentProfiles = labelled.filter(isAgentProfile);
  const agents = new Set(agentProfiles.map((e) => e.pubkey));
  return {
    tasks: projectTasks(events, project.coordinate, team, agents),
    agents,
    complete: events.length < TASK_READ,
  };
}

/** The project's tasks, newest first. `enabled` false (or no project) reads nothing. */
export function useProjectTasks(project: Project | null, enabled = true) {
  return useQuery({
    queryKey: taskKeys.project(project?.coordinate ?? ""),
    enabled: enabled && project !== null,
    staleTime: 15_000,
    queryFn: () => {
      if (!project) throw new Error("No project.");
      return fetchProjectTasks(project);
    },
  });
}
