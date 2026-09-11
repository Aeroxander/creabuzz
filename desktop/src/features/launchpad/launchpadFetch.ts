import { relayClient } from "@/shared/api/relayClient";
import type { RelayEvent } from "@/shared/api/types";
import { KIND_DELETION } from "@/shared/constants/kinds";
import { LAUNCHPAD_EVENT_KINDS } from "@/shared/constants/kinds";
import {
  buildLaunchesFromEvents,
  launchCoordinate,
  type Launch,
} from "@/features/launchpad/launchpadModels";

const LAUNCHPAD_PAGE_SIZE = 200;
const TOMBSTONE_CHUNK_SIZE = 100;

type LaunchpadPageFilter = {
  kinds: number[];
  limit: number;
  since?: number;
  until?: number;
  "#a"?: string[];
  "#e"?: string[];
};

async function fetchLaunchpadPage(
  filter: LaunchpadPageFilter,
  signal?: AbortSignal,
): Promise<RelayEvent[]> {
  signal?.throwIfAborted();
  return relayClient.fetchEvents(filter);
}

/**
 * Exhaustively enumerate launchpad events with the boundary-bucket drain:
 * a bare `until` cursor cannot advance until every event in the oldest
 * returned second has been retrieved.
 */
export async function fetchLaunchpadEventsExhaustively(
  kinds: number[],
  signal?: AbortSignal,
): Promise<RelayEvent[]> {
  const eventsById = new Map<string, RelayEvent>();
  let until: number | undefined;
  for (;;) {
    signal?.throwIfAborted();
    const page = await fetchLaunchpadPage(
      {
        kinds,
        limit: LAUNCHPAD_PAGE_SIZE,
        ...(until === undefined ? {} : { until }),
      },
      signal,
    );
    for (const event of page) eventsById.set(event.id, event);
    if (page.length < LAUNCHPAD_PAGE_SIZE) return [...eventsById.values()];
    const oldest = Math.min(...page.map((event) => event.created_at));
    signal?.throwIfAborted();
    const boundary = await fetchLaunchpadPage(
      { kinds, limit: LAUNCHPAD_PAGE_SIZE, since: oldest, until: oldest },
      signal,
    );
    for (const event of boundary) eventsById.set(event.id, event);
    if (boundary.length >= LAUNCHPAD_PAGE_SIZE) {
      throw new Error(
        "The relay cannot exhaustively enumerate launchpad events: too many share one timestamp.",
      );
    }
    if (oldest <= 0) return [...eventsById.values()];
    until = oldest - 1;
  }
}

function chunk<T>(values: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size)
    out.push(values.slice(i, i + size));
  return out;
}

/** Fetch kind:5 tombstones addressing launch records (`a`) or mirrors (`e`). */
export async function fetchLaunchTombstones(
  coordinates: string[],
  mirrorIds: string[],
  signal?: AbortSignal,
): Promise<RelayEvent[]> {
  const out: RelayEvent[] = [];
  for (const group of chunk(coordinates, TOMBSTONE_CHUNK_SIZE)) {
    const page = await fetchLaunchpadPage(
      { kinds: [KIND_DELETION], "#a": group, limit: LAUNCHPAD_PAGE_SIZE },
      signal,
    );
    out.push(...page);
  }
  for (const group of chunk(mirrorIds, TOMBSTONE_CHUNK_SIZE)) {
    const page = await fetchLaunchpadPage(
      { kinds: [KIND_DELETION], "#e": group, limit: LAUNCHPAD_PAGE_SIZE },
      signal,
    );
    out.push(...page);
  }
  return out;
}

export function tombstonedLaunchCoordinates(
  tombstones: RelayEvent[],
): Set<string> {
  const out = new Set<string>();
  for (const event of tombstones) {
    for (const tag of event.tags ?? []) {
      if (tag[0] === "a" && typeof tag[1] === "string") out.add(tag[1]);
    }
  }
  return out;
}

export function tombstonedMirrorIds(tombstones: RelayEvent[]): Set<string> {
  const out = new Set<string>();
  for (const event of tombstones) {
    for (const tag of event.tags ?? []) {
      if (tag[0] === "e" && typeof tag[1] === "string") out.add(tag[1]);
    }
  }
  return out;
}

/** Full read path: enumerate launchpad events, resolve tombstones, reduce. */
export async function fetchLaunches(signal?: AbortSignal): Promise<Launch[]> {
  const events = await fetchLaunchpadEventsExhaustively(
    [...LAUNCHPAD_EVENT_KINDS],
    signal,
  );
  const coordinates = events
    .filter((e) => e.kind === LAUNCHPAD_EVENT_KINDS[0])
    .map((e) => {
      const d = (e.tags ?? []).find((t) => t[0] === "d")?.[1];
      return d ? launchCoordinate(e.pubkey, d) : null;
    })
    .filter((c): c is string => c !== null);
  const mirrorIds = events
    .filter((e) => e.kind !== LAUNCHPAD_EVENT_KINDS[0])
    .map((e) => e.id);
  const tombstones =
    coordinates.length + mirrorIds.length === 0
      ? []
      : await fetchLaunchTombstones(coordinates, mirrorIds, signal);
  const deadIds = tombstonedMirrorIds(tombstones);
  const live = events.filter((e) => !deadIds.has(e.id));
  return buildLaunchesFromEvents(live, tombstonedLaunchCoordinates(tombstones));
}
