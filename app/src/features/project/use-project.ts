import {
  KIND_LAUNCH_RECORD,
  KIND_LAUNCH_UPDATE,
  KIND_TEXT_NOTE,
} from "@creaton/core/kinds.ts";
import { isGoalRecordTags } from "@creaton/core/project/goals.ts";
import { inAnyRoom } from "@creaton/core/social/feed/feed-events.ts";
import {
  isJoinAskTags,
  joinAskEvent,
  type JoinAsk,
  type JoinDecline,
  parseJoinAsk,
  parseJoinDecline,
  pendingAsks,
} from "@creaton/core/project/join.ts";
import {
  isTeamAnswerTags,
  parseTeamAnswer,
  projectVoices,
  type TeamAnswer,
  teamView,
  withMember,
} from "@creaton/core/project/team.ts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { publishAsUser, read, readMulti } from "../../lib/relay";
import {
  latestProjects,
  parseProjectRef,
  type Project,
  recordWithTeam,
} from "./project-record";

const projectKeys = {
  all: ["project"] as const,
  one: (ref: string) => ["project", "record", ref] as const,
  activity: (coordinate: string) =>
    ["project", "activity", coordinate] as const,
};

/** The project a link names: its newest record by the founder whose key starts as the link says. */
export function useProject(ref: string) {
  const parsed = parseProjectRef(ref);
  return useQuery({
    queryKey: projectKeys.one(ref),
    enabled: parsed !== null,
    staleTime: 15_000,
    queryFn: async (): Promise<Project | null> => {
      if (!parsed) return null;
      const events = await read({
        kinds: [KIND_LAUNCH_RECORD],
        "#d": [parsed.id],
        limit: 50,
      });
      return (
        latestProjects(
          events.filter((e) => e.pubkey.startsWith(parsed.founderPrefix)),
        )[0] ?? null
      );
    },
  });
}

export interface ProjectUpdate {
  id: string;
  author: string;
  at: number;
  title: string;
  body: string;
  kind: "update" | "goal" | "post";
}

export interface ProjectActivity {
  updates: ProjectUpdate[];
  answers: TeamAnswer[];
  asks: JoinAsk[];
  declines: JoinDecline[];
}

function updateText(content: string): { title: string; body: string } {
  try {
    const parsed: unknown = JSON.parse(content);
    if (parsed && typeof parsed === "object") {
      const { title, body } = parsed as Record<string, unknown>;
      return {
        title: typeof title === "string" ? title : "",
        body: typeof body === "string" ? body : "",
      };
    }
  } catch {
    // A plain-text update: the whole content is its body.
  }
  return { title: "", body: content };
}

/**
 * Everything said on a project, in one read: its update records (updates, goals, join asks and team answers, told
 * apart by their tags) and the posts that name it.
 */
export function useProjectActivity(project: Project | null | undefined) {
  const coordinate = project?.coordinate ?? "";
  return useQuery({
    queryKey: projectKeys.activity(coordinate),
    enabled: Boolean(project),
    staleTime: 15_000,
    queryFn: async (): Promise<ProjectActivity> => {
      const [records, posts] = await readMulti([
        { kinds: [KIND_LAUNCH_UPDATE], "#a": [coordinate], limit: 200 },
        { kinds: [KIND_TEXT_NOTE], "#a": [coordinate], limit: 50 },
      ]);
      const answers = records
        .map(parseTeamAnswer)
        .filter((a): a is TeamAnswer => a !== null);
      const asks = records
        .map(parseJoinAsk)
        .filter((a): a is JoinAsk => a !== null);
      const declines = records
        .map(parseJoinDecline)
        .filter((d): d is JoinDecline => d !== null);
      const updates: ProjectUpdate[] = [];
      for (const event of records) {
        if (isJoinAskTags(event.tags) || isTeamAnswerTags(event.tags)) continue;
        const { title, body } = updateText(event.content);
        updates.push({
          id: event.id,
          author: event.pubkey,
          at: event.created_at,
          title,
          body,
          kind: isGoalRecordTags(event.tags) ? "goal" : "update",
        });
      }
      for (const event of posts) {
        // Only top-level posts about the project; replies stay in their thread, and the holder room is read in its own tab.
        if (event.tags.some((t) => t[0] === "e") || inAnyRoom(event)) continue;
        updates.push({
          id: event.id,
          author: event.pubkey,
          at: event.created_at,
          title: "",
          body: event.content,
          kind: "post",
        });
      }
      updates.sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1));
      return {
        updates,
        answers,
        asks,
        declines,
      };
    },
  });
}

/**
 * Updates that speak for the project: the founder's and those of members who said yes (while they were on the team),
 * and posts by anyone that name it. Anyone may post about a project; only its team writes its updates.
 */
export function projectUpdates(
  project: Project,
  activity: ProjectActivity,
): ProjectUpdate[] {
  const voices = projectVoices(project, activity.answers);
  return activity.updates.filter((update) => {
    if (update.kind === "post") return true;
    if (!voices.has(update.author)) return false;
    const until = voices.get(update.author);
    return until === null || until === undefined || update.at <= until;
  });
}

/** The team as the People tab shows it, and the asks the founder can still accept. */
export function projectPeople(project: Project, activity: ProjectActivity) {
  return {
    team: teamView(project, activity.answers),
    waiting: pendingAsks(activity.asks, project, activity.declines),
  };
}

/** Whether `me` has asked to join and is still waiting. */
export function hasAsked(
  project: Project,
  activity: ProjectActivity | undefined,
  me: string | null,
): boolean {
  if (!me || !activity) return false;
  return pendingAsks(
    activity.asks.filter((a) => a.author === me),
    project,
    activity.declines,
  ).some((a) => a.author === me);
}

/** Ask to join: one record that the founder sees in their notifications and on the People tab. */
export function useAskToJoin(project: Project) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => {
      const { content, tags } = joinAskEvent({ founder: project.author });
      return publishAsUser(
        {
          kind: KIND_LAUNCH_UPDATE,
          tags: [["a", project.coordinate], ...tags],
          content: JSON.stringify(content),
        },
        "Your ask was not sent. Try again.",
      );
    },
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: projectKeys.activity(project.coordinate),
      }),
  });
}

/**
 * The founder's one press: the person who asked goes on the team. Their ask already carries their yes to this
 * invitation, so they are on the team at once, with nothing more to press.
 */
export function useAcceptAsk(project: Project) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (ask: JoinAsk) => {
      const change = withMember(project, ask.author, ask.invite);
      if (!change) return null;
      return publishAsUser(
        recordWithTeam(project, change.team, change.formerTeam),
        "The team could not be saved. Try again.",
      );
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: projectKeys.all }),
  });
}
