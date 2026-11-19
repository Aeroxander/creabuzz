/**
 * Reading a project's tasks and writing their steps, as the person using the app. Every write is one signed record; the
 * server decides who may sign it (the team posts and accepts, someone outside it takes, the helper hands in).
 */
import { KIND_LAUNCH_UPDATE, KIND_PROFILE } from "@creaton/core/kinds.ts";
import {
  type QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { publishAsUser, read } from "../../lib/relay";
import type { Project } from "../project/project-record";
import type { OwedTask } from "../pot/pair-terms";
import { rawDollars } from "./task-calls";
import {
  payOwed,
  type ProjectTask,
  projectTasks,
  type RecordTemplate,
  TASK_LABEL,
} from "./task-record";

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

/** Each agent account and the person who runs it: the first `auth` tag of its profile names its operator. */
function operatorsOf(
  profiles: readonly { pubkey: string; tags: string[][] }[],
): Map<string, string> {
  const out = new Map<string, string>();
  for (const profile of profiles) {
    const owner = profile.tags.find((t) => t[0] === "auth")?.[1];
    if (owner && /^[0-9a-f]{64}$/.test(owner) && !out.has(profile.pubkey))
      out.set(profile.pubkey, owner);
  }
  return out;
}

/** Read the project's tasks and who runs which agent, fresh from the server. */
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
    operators: operatorsOf(agentProfiles),
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

/** How much of a task's words a sentence about its pay shows. */
const NAME_MAX = 60;

/**
 * The accepted tasks that are owed exactly `raw` dollars (raw units) at `payee`, with who accepted each and who took it: what a
 * draw that pays one of them is for, as the page's record says. Names are cut short and never contain a quote, so they sit
 * safely inside a sentence. `personName` turns a person's key into the name shown.
 */
export function owedTaskNames(
  tasks: readonly ProjectTask[],
  payee: string,
  raw: bigint,
  personName: (pubkey: string) => string = (pubkey) => pubkey.slice(0, 8),
): OwedTask[] {
  return tasks
    .filter(
      (t) =>
        payOwed(t) !== null &&
        t.payTo?.toLowerCase() === payee.toLowerCase() &&
        rawDollars(t.usd ?? 0) === raw,
    )
    .map((t) => {
      const words = t.what.replace(/["\u201c\u201d]/g, "'").trim();
      return {
        name: words.length > NAME_MAX ? `${words.slice(0, NAME_MAX)}…` : words,
        acceptedBy: t.acceptedBy ? personName(t.acceptedBy) : "someone",
        takenBy: t.worker ? personName(t.worker) : "someone",
      };
    });
}

/**
 * One task as the server holds it right now, read past the page's 15-second snapshot (and put back as the page's
 * snapshot): the last look before money moves. Null when the task is gone or the read failed.
 */
export async function freshTask(
  queryClient: QueryClient,
  project: Project,
  id: string,
): Promise<ProjectTask | null> {
  try {
    const now = await queryClient.fetchQuery({
      queryKey: taskKeys.project(project.coordinate),
      staleTime: 0,
      queryFn: () => fetchProjectTasks(project),
    });
    return now.tasks.find((task) => task.id === id) ?? null;
  } catch {
    return null;
  }
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
