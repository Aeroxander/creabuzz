import { KIND_LAUNCH_UPDATE } from "../../../shared/constants/kinds.ts";
import {
  displayText,
  launchCoordinate,
  type SignedEventLike,
} from "./feed-events.ts";
import {
  teamsFromLaunches,
  verifiedUpdates,
} from "../../social/lib/launch-update.ts";

interface ProgressLaunch {
  record: {
    id: string;
    author: string;
    name: string;
    team: Array<{ pubkey: string }>;
  };
  updates: Array<{
    id: string;
    author: string;
    createdAt: number;
    title: string;
    body: string;
    claim?: unknown;
  }>;
}
/** A signed report, never an automatic assertion that the reported work was verified. */
export interface ProjectProgress {
  id: string;
  coordinate: string;
  project: ProgressLaunch["record"];
  author: string;
  at: number;
  title: string;
  text: string;
  evidence: boolean;
  event: SignedEventLike;
}

/** Merge both existing update formats; only the named team can speak as the team. */
export function projectProgress(
  launches: readonly ProgressLaunch[],
  notes: readonly SignedEventLike[],
): ProjectProgress[] {
  const teams = teamsFromLaunches(launches.map((l) => l.record));
  const byCoordinate = new Map(
    launches.map((l) => [
      launchCoordinate({ pubkey: l.record.author, id: l.record.id }),
      l,
    ]),
  );
  const items = new Map<string, ProjectProgress>();
  for (const l of launches) {
    const coordinate = launchCoordinate({
      pubkey: l.record.author,
      id: l.record.id,
    });
    for (const u of l.updates) {
      if (!teams.get(coordinate)?.has(u.author)) continue;
      items.set(u.id, {
        id: u.id,
        coordinate,
        project: l.record,
        author: u.author,
        at: u.createdAt,
        title: u.title,
        text: u.body,
        evidence: Boolean(u.claim),
        event: {
          id: u.id,
          pubkey: u.author,
          kind: KIND_LAUNCH_UPDATE,
          created_at: u.createdAt,
          content: u.body,
          tags: [["a", coordinate]],
        },
      });
    }
  }
  for (const u of verifiedUpdates(notes, teams)) {
    const l = byCoordinate.get(u.coord);
    if (!l) continue;
    items.set(u.id, {
      id: u.id,
      coordinate: u.coord,
      project: l.record,
      author: u.author,
      at: u.at,
      title: "Build update",
      text: displayText(u.event.content),
      evidence: false,
      event: u.event,
    });
  }
  return [...items.values()]
    .sort((a, b) => b.at - a.at || a.id.localeCompare(b.id))
    .slice(0, 100);
}

export type SeenProgress = Record<string, { ids: string[]; at: number }>;

/** A few explicit artifact links in a report; never fetch or embed their contents automatically. */
export function progressArtifacts(text: string): string[] {
  const urls = new Set<string>();
  for (const match of text.matchAll(/https?:\/\/[^\s<>"()]+/g)) {
    try {
      const url = new URL(match[0].replace(/[.,;!?]+$/, ""));
      if (!url.username && !url.password) urls.add(url.href);
    } catch {
      /* An invalid link stays plain report text. */
    }
    if (urls.size === 3) break;
  }
  return [...urls];
}

/** Bounded browser-local reading history. Keys include the relay and account at the call site. */
export function parseSeenProgress(raw: string | null): SeenProgress {
  try {
    const value: unknown = JSON.parse(raw ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([, v]) =>
            v &&
            typeof v === "object" &&
            Array.isArray(v.ids) &&
            typeof v.at === "number",
        )
        .sort(([, a], [, b]) => b.at - a.at)
        .slice(0, 50)
        .map(([key, v]) => [
          key,
          {
            at: v.at,
            ids: v.ids
              .filter((id: unknown) => typeof id === "string")
              .slice(0, 200),
          },
        ]),
    );
  } catch {
    return {};
  }
}

/** Preserve previously read ids so a late-arriving older report still counts as new to the viewer. */
export function rememberProgress(
  seen: SeenProgress,
  key: string,
  ids: readonly string[],
  at: number,
): SeenProgress {
  return parseSeenProgress(
    JSON.stringify({
      ...seen,
      [key]: {
        at,
        ids: [...new Set([...ids, ...(seen[key]?.ids ?? [])])].slice(0, 200),
      },
    }),
  );
}
