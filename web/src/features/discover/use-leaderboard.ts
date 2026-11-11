/**
 * Reading the Projects scoreboard (`lib/leaderboard.ts`): one bounded read of what the listed projects' own people
 * signed about them, and one of how many people follow each. Only the teams' accounts are asked for, so nobody
 * else's records can fill the read. When the read was full, or there are more projects or accounts than it names,
 * `cut` says so and the page says the scores are from the newest records only.
 */

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { isGoalRecordTags } from "@/features/launchpad/lib/goals";
import {
  isHelpSignalTags,
  parseHelpSignal,
  teamOf,
} from "@/features/launchpad/lib/help-request";
import { isTaskRecordTags } from "@/features/launchpad/lib/tasks";
import { isTeamAnswerTags } from "@/features/launchpad/lib/team";
import {
  type Launch,
  launchCoordinate,
  parseLaunchUpdate,
} from "@/features/launchpad/models";
import { useSupporters } from "@/features/launchpad/use-supporters";
import { KIND_LAUNCH_UPDATE } from "@/shared/constants/kinds";
import { queryEvents } from "@/shared/lib/nostr-client";
import { relayWsUrl } from "@/shared/lib/relay-url";

import {
  type BoardProject,
  type BoardUpdate,
  projectScore,
} from "./lib/leaderboard";

/** How many projects, team accounts and records one scoreboard read covers. */
const BOARD_PROJECTS = 60;
const BOARD_AUTHORS = 200;
const BOARD_READ = 500;

export function useLeaderboard(launches: readonly Launch[]) {
  const relay = relayWsUrl();
  const projects = useMemo(
    () =>
      launches.slice(0, BOARD_PROJECTS).map(
        (launch): BoardProject => ({
          coordinate: launchCoordinate(launch.record.author, launch.record.id),
          founder: launch.record.author,
          team: teamOf(launch.record),
          startedAt: launch.record.startedAt,
        }),
      ),
    [launches],
  );
  const coordinates = useMemo(
    () => projects.map((p) => p.coordinate).sort(),
    [projects],
  );
  const everyone = useMemo(
    () => [...new Set(projects.flatMap((p) => [...p.team]))].sort(),
    [projects],
  );
  const read = useQuery({
    queryKey: ["launchpad", "help", "board", relay, coordinates, everyone],
    enabled: coordinates.length > 0,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const authors = everyone.slice(0, BOARD_AUTHORS);
      const events = await queryEvents(relay, {
        kinds: [KIND_LAUNCH_UPDATE],
        authors,
        "#a": coordinates,
        limit: BOARD_READ,
      });
      return {
        // Checked again: only what one of those accounts signed.
        events: events.filter((event) => authors.includes(event.pubkey)),
        cut: events.length >= BOARD_READ,
      };
    },
  });
  const followers = useSupporters(coordinates);
  const scores = useMemo(() => {
    if (!read.data) return null;
    const now = Math.floor(Date.now() / 1000);
    const updates = new Map<string, BoardUpdate[]>();
    const found = new Set<string>();
    const teams = new Map(projects.map((p) => [p.coordinate, p.team]));
    for (const event of read.data.events) {
      const coordinate = event.tags.find(
        (tag) => tag[0] === "a" && teams.has(tag[1]),
      )?.[1];
      if (!coordinate) continue;
      if (isHelpSignalTags(event.tags)) {
        const signal = parseHelpSignal(event);
        // "Help found" counts from the project's own team.
        if (
          signal?.kind === "found" &&
          teams.get(coordinate)?.has(event.pubkey)
        )
          found.add(signal.target);
        continue;
      }
      if (
        isGoalRecordTags(event.tags) ||
        isTaskRecordTags(event.tags) ||
        isTeamAnswerTags(event.tags)
      )
        continue;
      const update = parseLaunchUpdate(event);
      if (!update || update.claim || update.checkNote) continue;
      const list = updates.get(coordinate) ?? [];
      list.push({
        id: update.id,
        author: update.author,
        createdAt: update.createdAt,
        weekly: update.weekly,
        promises: update.promises,
        marks: update.marks,
        asks: Boolean(update.help),
      });
      updates.set(coordinate, list);
    }
    return projects.map((project) =>
      projectScore(project, updates.get(project.coordinate) ?? [], found, now),
    );
  }, [read.data, projects]);
  return {
    scores,
    followers: followers.data ?? null,
    failed: read.isError && !read.data,
    retry: () => void read.refetch(),
    /** The scores rest on the newest records only: an older week or promise may be missing from them. */
    cut:
      Boolean(read.data?.cut) ||
      launches.length > BOARD_PROJECTS ||
      everyone.length > BOARD_AUTHORS,
  };
}
