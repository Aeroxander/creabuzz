import { mergeTaskRows, type TaskRowEvent } from "./task-planning.ts";
import { readDelivery } from "./task-delivery.ts";
import type { NostrFilter } from "../../../shared/lib/nostr-client.ts";

/** The project and current team, within the authenticated relay's channel boundary. */
export interface ProjectWorkScope {
  coordinate: string;
  authors: string[];
  channels: string[];
}

/** Project attribution comes from the signer, never the assignee or channel alone. */
export function teamTaskRows(
  rows: readonly TaskRowEvent[],
  scope: ProjectWorkScope,
) {
  const groups = new Map<string, TaskRowEvent[]>();
  for (const row of rows) {
    if (row.kind !== 44011 || !scope.authors.includes(row.pubkey)) continue;
    const d = row.tags.find((t) => t[0] === "d")?.[1];
    if (!d) continue;
    try {
      const body = JSON.parse(row.content);
      if (!body || typeof body !== "object" || Array.isArray(body)) continue;
      if (body.title !== undefined && typeof body.title !== "string") continue;
    } catch {
      continue;
    }
    groups.set(d, [...(groups.get(d) ?? []), row]);
  }
  return [...groups.values()].flatMap((group) => {
    const merged = mergeTaskRows(group);
    if (!merged) return [];
    const body = JSON.parse(merged.event.content);
    const delivery = readDelivery(body.delivery);
    const channel = merged.event.tags.find((t) => t[0] === "h")?.[1];
    const belongs = delivery
      ? delivery.project === scope.coordinate
      : Boolean(channel && scope.channels.includes(channel));
    if (!belongs) return [];
    // Attribute the reference to the signer who actually wrote it, not the
    // newest status writer who may have omitted the delivery field.
    const linker = [...group]
      .sort((a, b) => b.created_at - a.created_at || b.id.localeCompare(a.id))
      .find((r) => "delivery" in JSON.parse(r.content));
    return [{ ...merged, linkedBy: linker?.pubkey ?? null }];
  });
}

/** Scoped discovery plus a bounded, team-only fallback for pre-tag task links. */
export function projectWorkFilters(scope: ProjectWorkScope) {
  const base = { kinds: [44011], authors: scope.authors, limit: 200 };
  return [
    { ...base, "#a": [scope.coordinate] },
    ...scope.channels.map((id) => ({ ...base, "#h": [id] })),
    { ...base },
  ];
}

/** Read known task history even when an older writer omitted its project tag. */
export function projectTaskHistoryFilters(
  scope: ProjectWorkScope,
  ids: string[],
) {
  if (!ids.length) return [];
  const base = {
    kinds: [44011],
    authors: scope.authors,
    "#d": ids.slice(0, 100),
    // The relay advertises a maximum page of 1,000. Asking above that
    // would hide truncation when the server clamps the result.
    limit: 1000,
  };
  return [base, ...scope.channels.map((id) => ({ ...base, "#h": [id] }))];
}

/** Partial reads stay visible; neither a refused scope nor a full window means no work. */
export async function readProjectWork(
  scope: ProjectWorkScope,
  query: (filter: NostrFilter) => Promise<TaskRowEvent[]>,
) {
  let incomplete = 0;
  let truncated = false;
  const read = async (filters: NostrFilter[]) => {
    const results = await Promise.allSettled(filters.map(query));
    incomplete += results.filter((r) => r.status === "rejected").length;
    const events = results.flatMap((r, i) => {
      if (r.status !== "fulfilled") return [];
      truncated ||= r.value.length >= (filters[i].limit ?? Infinity);
      return r.value;
    });
    return { events, succeeded: results.some((r) => r.status === "fulfilled") };
  };
  const discovery = await read(projectWorkFilters(scope));
  if (!discovery.succeeded)
    throw new Error("Could not read this project's work. Try again.");
  const candidates = teamTaskRows(discovery.events, scope).sort(
    (a, b) =>
      b.event.created_at - a.event.created_at ||
      b.event.id.localeCompare(a.event.id),
  );
  truncated ||= candidates.length > 100;
  const ids = candidates
    .slice(0, 100)
    .map((m) => m.event.tags.find((t) => t[0] === "d")?.[1] ?? "");
  const history = await read(projectTaskHistoryFilters(scope, ids));
  return {
    records: teamTaskRows(
      [...discovery.events, ...history.events],
      scope,
    ).filter((m) =>
      ids.includes(m.event.tags.find((t) => t[0] === "d")?.[1] ?? ""),
    ),
    ids,
    incomplete,
    truncated,
  };
}
