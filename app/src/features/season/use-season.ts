/**
 * Reading seasons and entering a project in one (plan sections 5.2 and 5.3). Every read is off unless the server turns
 * investing on. Bounded: one read for the season records, and for a season's entries at most `MAX_PAGES` reads of `PAGE_SIZE`;
 * a season with more is said to be partly read, never shown as complete.
 */
import {
  KIND_LAUNCH_RECORD,
  KIND_LAUNCH_UPDATE,
  KIND_SEASON,
} from "@creaton/core/kinds.ts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { publishAsUser, read, readMulti } from "../../lib/relay";
import type { NostrEvent } from "../../lib/relay";
import { investingOn } from "../../lib/server";
import { chainKeyOfProject } from "../money/use-money";
import { latestProjects, type Project } from "../project/project-record";
import {
  entriesOf,
  liveCoordinates,
  type Season,
  type SeasonEntry,
  seasonsOf,
} from "./season-records";

/** How many season records are read: a season is six weeks, so a few dozen is years. */
const SEASONS_READ = 50;
/** One page of a season's entries, and how many pages are followed: the server's own cap is 500 entries. */
export const PAGE_SIZE = 200;
export const MAX_PAGES = 3;

const seasonKeys = {
  all: ["season"] as const,
  list: ["season", "list"] as const,
  entries: (number: number) => ["season", "entries", number] as const,
  mine: (me: string) => ["season", "mine", me] as const,
};

/** The season records, the newest record of each number, highest number first. */
export function useSeasons() {
  return useQuery({
    queryKey: seasonKeys.list,
    enabled: investingOn(),
    staleTime: 60_000,
    queryFn: async (): Promise<Season[]> =>
      seasonsOf(await read({ kinds: [KIND_SEASON], limit: SEASONS_READ })),
  });
}

/** What was read of one season's entries. */
export interface EntriesRead {
  entries: SeasonEntry[];
  /** True when the last page was full: older records were left unread. */
  trimmed: boolean;
}

/**
 * A season's entry, leave and removal records, newest first, a page at a time. The next page starts at the oldest second seen
 * (`until` is inclusive, so records sharing it are read again and skipped); a page that adds nothing new stops the read and
 * counts as trimmed.
 */
async function readEntries(number: number): Promise<EntriesRead> {
  const seen = new Map<string, NostrEvent>();
  let until: number | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const events = await read({
      kinds: [KIND_LAUNCH_UPDATE],
      "#t": [`season-${number}`],
      limit: PAGE_SIZE,
      ...(until === undefined ? {} : { until }),
    });
    let added = 0;
    for (const event of events)
      if (!seen.has(event.id)) {
        seen.set(event.id, event);
        added += 1;
      }
    if (events.length < PAGE_SIZE)
      return { entries: entriesOf([...seen.values()], number), trimmed: false };
    if (added === 0) break;
    until = Math.min(...events.map((e) => e.created_at));
  }
  return { entries: entriesOf([...seen.values()], number), trimmed: true };
}

/** One season's entries, as the server stored them. */
export function useSeasonEntries(number: number | null, enabled = true) {
  return useQuery({
    queryKey: seasonKeys.entries(number ?? 0),
    enabled: enabled && number !== null && investingOn(),
    staleTime: 30_000,
    queryFn: () => readEntries(number as number),
  });
}

/** How many projects are in, by what the server stored (the demo-day page checks each against its project before it lists it). */
export function projectsIn(read: EntriesRead | undefined): number | null {
  return read ? liveCoordinates(read.entries).length : null;
}

/**
 * The projects this person can enter: the ones they started and the ones that list them on the team, launched on the network
 * (the record names its launch) and listed. The server decides who may; this only decides whom to offer.
 */
export function useMyProjects(me: string | null, enabled: boolean) {
  return useQuery({
    queryKey: seasonKeys.mine(me ?? ""),
    enabled: enabled && me !== null && investingOn(),
    staleTime: 30_000,
    queryFn: async (): Promise<Project[]> => {
      if (!me) return [];
      const [founded, listed] = await readMulti([
        { kinds: [KIND_LAUNCH_RECORD], authors: [me], limit: 100 },
        { kinds: [KIND_LAUNCH_RECORD], "#p": [me], limit: 50 },
      ]);
      return latestProjects([...founded, ...listed]).filter(
        (project) =>
          !project.unlisted &&
          chainKeyOfProject(project) !== null &&
          (project.author === me ||
            project.team.some((member) => member.pubkey === me)),
      );
    },
  });
}

/** What the person does to a project in a season. */
export type SeasonStep = "entry" | "leave";

/** The one record that enters a project in a season or takes it out. The server decides whether it stands. */
function seasonStepTemplate(
  coordinate: string,
  number: number,
  step: SeasonStep,
) {
  return {
    kind: KIND_LAUNCH_UPDATE,
    tags: [
      ["a", coordinate],
      ["t", `season-${number}`],
      [`season-${step}`, String(number)],
    ],
    content: "{}",
  };
}

/** Enter a project in a season, or take it out, and read the season's entries again. */
export function useSeasonStep(number: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      coordinate,
      step,
    }: {
      coordinate: string;
      step: SeasonStep;
    }) =>
      publishAsUser(
        seasonStepTemplate(coordinate, number, step),
        step === "entry"
          ? "The project was not entered. Try again."
          : "The project was not taken out of the season. Try again.",
      ),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: seasonKeys.entries(number) }),
  });
}
