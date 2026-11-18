/**
 * What a task can be "Part of": this community's contributor projects and their work areas open now.
 *
 * Projects come from the community's own launch list; each one's work areas from the same chain read the project's
 * Work tab uses (`workQuery`), for a bounded number of projects, and each area's name from the titles the Work tab
 * shows (`knownTitles` over the project's work suggestions). The pure rules are in `lib/task-part-of.ts`.
 */
import { useQueries } from "@tanstack/react-query";
import { useMemo } from "react";

import { KIND_FORUM_POST } from "@/features/board/lib/board-events";
import { daoOfLaunch } from "@/features/launchpad/lib/dao-of-launch";
import { isContributorProject } from "@/features/launchpad/lib/funding";
import { SANDBOX_ID } from "@/features/launchpad/lib/sandbox";
import {
  parseWorkProposal,
  workProposalTopic,
} from "@/features/launchpad/lib/work-proposal";
import { knownTitles, workTitle } from "@/features/launchpad/lib/work-titles";
import { launchCoordinate, type Launch } from "@/features/launchpad/models";
import { useLaunches } from "@/features/launchpad/use-launches";
import { workQuery } from "@/features/launchpad/use-work";
import { queryEvents } from "@/shared/lib/nostr-client";
import { relayWsUrl } from "@/shared/lib/relay-url";

import {
  type PartOfChoice,
  partOfChoices,
  type TaskPartOf,
} from "./lib/task-part-of";

/** Projects whose work is read for the picker: a small community's whole list, and cheap for a large one. */
const MAX_PROJECTS = 6;
/** Work suggestions read per project for titles, as the Work tab reads them. */
const PROPOSAL_LIMIT = 200;

export interface PartOfOptions {
  /** Projects with work areas open now, each with those areas. */
  choices: PartOfChoice[];
  /** The contributor project at a coordinate in this community, or null when it is not one. */
  launchAt: (coordinate: string) => Launch | null;
  /** A linked work area's name, as the project's Work tab shows it. */
  areaTitle: (link: TaskPartOf) => string;
  loading: boolean;
}

/** A project's work suggestions, read for their titles only (its own cache key: the Work tab's query keeps its own). */
function titlesQuery(chainId: string | null, dao: string | null) {
  return {
    queryKey: ["fleet", "part-of-titles", chainId, dao?.toLowerCase()],
    enabled: chainId !== null && dao !== null,
    staleTime: 30_000,
    queryFn: async () => {
      const topic = workProposalTopic(chainId as string, dao as string);
      const events = await queryEvents(relayWsUrl(), {
        kinds: [KIND_FORUM_POST],
        "#t": [topic],
        limit: PROPOSAL_LIMIT,
      });
      return events.flatMap((event) => {
        const parsed = parseWorkProposal(
          event,
          chainId as string,
          dao as string,
        );
        return parsed ? [parsed] : [];
      });
    },
  };
}

export function usePartOfOptions(): PartOfOptions {
  const launches = useLaunches();
  const projects = useMemo(
    () =>
      (launches.data ?? []).filter(
        (launch) =>
          launch.record.id !== SANDBOX_ID &&
          isContributorProject(launch.record) &&
          daoOfLaunch(launch) !== null,
      ),
    [launches.data],
  );
  const read = projects.slice(0, MAX_PROJECTS);
  const work = useQueries({
    queries: read.map((launch) => workQuery(daoOfLaunch(launch), null)),
  });
  const suggestions = useQueries({
    queries: read.map((launch) =>
      titlesQuery(launch.record.chainId ?? null, daoOfLaunch(launch)),
    ),
  });
  const titlesAt = new Map(
    read.map((launch, i) => {
      const approved = (work[i]?.data?.mandates ?? []).flatMap((m) =>
        m.projects.map((p) => ({
          projectId: p.approved.projectId,
          checkHash: p.approved.checkHash,
        })),
      );
      return [
        launchCoordinate(launch.record.author, launch.record.id),
        knownTitles(suggestions[i]?.data ?? [], approved),
      ] as const;
    }),
  );
  const choices = partOfChoices(
    read.map((launch, i) => {
      const coordinate = launchCoordinate(
        launch.record.author,
        launch.record.id,
      );
      return {
        coordinate,
        name: launch.record.name,
        work: work[i]?.data,
        titles: titlesAt.get(coordinate),
      };
    }),
  );
  const launchAt = (coordinate: string) =>
    projects.find(
      (launch) =>
        launchCoordinate(launch.record.author, launch.record.id) === coordinate,
    ) ?? null;
  return {
    choices,
    launchAt,
    areaTitle: (link) => workTitle(link.area, titlesAt.get(link.project)),
    loading: launches.isLoading || work.some((q) => q.isLoading),
  };
}
