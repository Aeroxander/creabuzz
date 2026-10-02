/**
 * Launch updates: a post in "launch mode".
 *
 * It is an ordinary kind 1 note — other Nostr clients just show a post — that
 * carries the launch's `a` coordinate (so it also reads as being about that
 * launch) and a label tag marking it an official update. The mark means nothing
 * on its own: anyone can add a tag. An update counts only when its author is on
 * the launch's team, so the same rule a launch's feed uses decides it.
 *
 * Priority is rationed. If every update were urgent, people would mute the
 * launch, so a launch's first few updates in any week are priority and the rest
 * are ordinary posts. Pure and alias-free: covered by `launch-update.test.mjs`.
 */

import { KIND_TEXT_NOTE } from "../../../shared/constants/kinds.ts";
import {
  buildPost,
  type EventTemplate,
  type LaunchRef,
} from "../../feed/lib/feed-events.ts";
import { launchCoordinate } from "../../feed/lib/feed-events.ts";
import { withMentions } from "./post-events.ts";

export const LAUNCH_UPDATE_LABEL = "launch-update";
export const LAUNCH_UPDATE_NAMESPACE = "creaton.launch";
/** How many updates per launch per week raise a priority notification. */
export const PRIORITY_PER_WEEK = 3;
const WEEK_SECONDS = 7 * 24 * 60 * 60;

export interface UpdateEventLike {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
}

/** The launch coordinate → the keys allowed to post updates for it. */
export type LaunchTeams = ReadonlyMap<string, ReadonlySet<string>>;

export interface LaunchUpdate {
  id: string;
  /** `37001:<author>:<id>` of the launch the update is about. */
  coord: string;
  author: string;
  at: number;
  event: UpdateEventLike;
}

/** A launch-mode post about `launch`. */
export function buildLaunchUpdate(input: {
  text: string;
  launch: LaunchRef;
}): EventTemplate {
  const post = withMentions(
    buildPost({ text: input.text, launch: input.launch }),
  );
  return {
    ...post,
    tags: [...post.tags, ["l", LAUNCH_UPDATE_LABEL, LAUNCH_UPDATE_NAMESPACE]],
  };
}

/** The launch an event claims to be an update for, or null if it is not marked. */
export function claimedLaunch(event: UpdateEventLike): string | null {
  if (event.kind !== KIND_TEXT_NOTE) return null;
  const marked = event.tags.some(
    (t) =>
      t[0] === "l" &&
      t[1] === LAUNCH_UPDATE_LABEL &&
      t[2] === LAUNCH_UPDATE_NAMESPACE,
  );
  if (!marked) return null;
  const coords = event.tags
    .filter((t) => t[0] === "a" && typeof t[1] === "string")
    .map((t) => t[1])
    .filter((c) => c.startsWith("37001:"));
  // Exactly one launch: a post naming several is not a clear update for any.
  return coords.length === 1 ? coords[0] : null;
}

/** Marked events whose author is on the launch's team, newest first. */
export function verifiedUpdates(
  events: readonly UpdateEventLike[],
  teams: LaunchTeams,
): LaunchUpdate[] {
  const seen = new Set<string>();
  const out: LaunchUpdate[] = [];
  for (const event of events) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    const coord = claimedLaunch(event);
    if (!coord) continue;
    if (!teams.get(coord)?.has(event.pubkey)) continue;
    out.push({
      id: event.id,
      coord,
      author: event.pubkey,
      at: event.created_at,
      event,
    });
  }
  return out.sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1));
}

/**
 * Which updates are priority. Per launch, an update is priority while fewer
 * than {@link PRIORITY_PER_WEEK} priority updates came in the seven days
 * before it; later ones are plain posts. Decided oldest-first so the answer is
 * the same for everyone and never changes as newer updates arrive.
 */
export function priorityIds(updates: readonly LaunchUpdate[]): Set<string> {
  const byLaunch = new Map<string, LaunchUpdate[]>();
  for (const update of updates) {
    const list = byLaunch.get(update.coord) ?? [];
    list.push(update);
    byLaunch.set(update.coord, list);
  }
  const priority = new Set<string>();
  for (const list of byLaunch.values()) {
    const ascending = [...list].sort(
      (a, b) => a.at - b.at || (a.id < b.id ? -1 : 1),
    );
    const granted: number[] = [];
    for (const update of ascending) {
      const recent = granted.filter((at) => update.at - at < WEEK_SECONDS);
      if (recent.length < PRIORITY_PER_WEEK) {
        priority.add(update.id);
        granted.push(update.at);
      }
    }
  }
  return priority;
}

/** Teams from launch records: the founder plus anyone on the record. */
export function teamsFromLaunches(
  launches: ReadonlyArray<{
    author: string;
    id: string;
    team: ReadonlyArray<{ pubkey: string }>;
  }>,
): Map<string, Set<string>> {
  const teams = new Map<string, Set<string>>();
  for (const launch of launches) {
    teams.set(
      launchCoordinate({ pubkey: launch.author, id: launch.id }),
      new Set([launch.author, ...launch.team.map((m) => m.pubkey)]),
    );
  }
  return teams;
}
