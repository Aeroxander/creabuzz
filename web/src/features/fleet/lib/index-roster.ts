/**
 * Index agent capability announcements.
 *
 * Kind 44010 is an addressable event, so NIP-33 identifies it by
 * (kind, pubkey, `d`) — not by the `d` tag alone. Keying the roster on `d` let
 * any member publish a newer announcement with another agent's `d` and take
 * over its roster entry (name, pubkey, tools) in the directory.
 *
 * Alias-free so `index-roster.test.mjs` can drive it under `node --test`.
 */

/** The subset of an announcement this index needs. */
export interface RosterEvent {
  pubkey: string;
  created_at: number;
  tags: string[][];
  content: string;
}

/** Parsed announcement, before liveness is applied. */
export interface RosterEntry {
  /** The `d` tag (an agent's stable id) or the author pubkey when absent. */
  id: string;
  /** Author of the announcement. */
  pubkey: string;
  name: string;
  runtype: string;
  status: string;
  tools: string[];
  team: string | null;
  /** Heartbeat in ms; falls back to the event time. */
  heartbeat: number;
  updatedAt: number;
}

/** Roster storage key: author-qualified, so entries cannot shadow each other. */
export function rosterKey(pubkey: string, id: string): string {
  return `${pubkey}:${id}`;
}

function tagValue(event: RosterEvent, name: string): string | null {
  const tag = event.tags.find((t) => t[0] === name);
  return tag && tag.length >= 2 ? tag[1] : null;
}

export function parseAnnouncement(event: RosterEvent): RosterEntry | null {
  const id = tagValue(event, "d") ?? event.pubkey;
  if (!id) return null;
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(event.content);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    // Malformed content: the agent still surfaces with defaults.
  }
  const heartbeat =
    typeof body.heartbeat === "number" && Number.isFinite(body.heartbeat)
      ? body.heartbeat * 1000
      : event.created_at * 1000;
  return {
    id,
    pubkey: event.pubkey,
    name: typeof body.name === "string" && body.name ? body.name : id,
    runtype: typeof body.runtype === "string" ? body.runtype : "sandbox",
    status: typeof body.status === "string" ? body.status : "available",
    tools: Array.isArray(body.tools)
      ? body.tools.filter((t): t is string => typeof t === "string")
      : [],
    team: typeof body.team === "string" && body.team ? body.team : null,
    heartbeat,
    updatedAt: event.created_at * 1000,
  };
}

/** Newest announcement per author-qualified identity. */
export function indexRoster(
  events: RosterEvent[],
): Record<string, RosterEntry> {
  const entries: Record<string, RosterEntry> = {};
  for (const event of events) {
    const parsed = parseAnnouncement(event);
    if (!parsed) continue;
    const key = rosterKey(parsed.pubkey, parsed.id);
    const existing = entries[key];
    if (!existing || existing.updatedAt < parsed.updatedAt) {
      entries[key] = parsed;
    }
  }
  return entries;
}
